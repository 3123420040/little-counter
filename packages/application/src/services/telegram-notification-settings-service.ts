import type { MerchantTargetScope } from "@medusa-snus/contracts";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { recordAuditEntry, type AuditActor } from "../repositories/audit-repository";
import { enqueueTelegramNotificationForClient } from "./telegram-notification-service";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";

export type TelegramRecipientKind = "owner" | "manager" | "sales_staff" | "ops" | "custom";
export type TelegramRecipientStatus = "active" | "disabled";

export interface TelegramNotificationRecipientDto {
  id: string;
  merchantId: string;
  storeId: string | null;
  storeName: string | null;
  telegramUserId: string;
  telegramChatId: string | null;
  telegramUsername: string | null;
  linkedOperatorId: string | null;
  displayName: string;
  recipientKind: TelegramRecipientKind;
  status: TelegramRecipientStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramNotificationRuleDto {
  id: string;
  merchantId: string;
  storeId: string | null;
  storeName: string | null;
  recipientId: string;
  recipientDisplayName: string;
  name: string;
  enabled: boolean;
  eventScope: string;
  channelFilter: string;
  eventTypes: string[];
  templateProfile: string;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramNotificationSettingsDto {
  recipients: TelegramNotificationRecipientDto[];
  rules: TelegramNotificationRuleDto[];
}

export interface CreateTelegramNotificationRecipientInput {
  storeId?: string | null;
  telegramUserId: string;
  telegramChatId?: string | null;
  telegramUsername?: string | null;
  linkedOperatorId?: string | null;
  displayName: string;
  recipientKind: TelegramRecipientKind;
  status?: TelegramRecipientStatus;
}

export type UpdateTelegramNotificationRecipientInput = Partial<CreateTelegramNotificationRecipientInput>;

export interface CreateTelegramNotificationRuleInput {
  storeId?: string | null;
  recipientId: string;
  name: string;
  enabled?: boolean;
  eventScope: string;
  channelFilter?: string;
  eventTypes?: string[];
  templateProfile?: string;
}

export type UpdateTelegramNotificationRuleInput = Partial<CreateTelegramNotificationRuleInput>;

type RecipientRow = {
  id: string;
  merchant_id: string;
  store_id: string | null;
  store_name: string | null;
  telegram_user_id: string;
  telegram_chat_id: string | null;
  telegram_username: string | null;
  linked_operator_id: string | null;
  display_name: string;
  recipient_kind: TelegramRecipientKind;
  status: TelegramRecipientStatus;
  created_at: Date | string;
  updated_at: Date | string;
};

type RuleRow = {
  id: string;
  merchant_id: string;
  store_id: string | null;
  store_name: string | null;
  recipient_id: string;
  recipient_display_name: string;
  recipient_store_id?: string | null;
  name: string;
  enabled: boolean;
  event_scope: string;
  channel_filter: string;
  event_types: string[];
  template_profile: string;
  created_at: Date | string;
  updated_at: Date | string;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function ensureScope(scope: MerchantTargetScope, merchantId: string): void {
  if (scope.merchantId !== merchantId) {
    throw new PlatformError("forbidden", "Merchant target is not accessible", 403, { merchantId });
  }
}

function text(value: unknown, field: string, maxLength: number, options: { required?: boolean } = {}): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    if (options.required) throw new PlatformError("validation_error", `${field} is required`, 400);
    return null;
  }
  if (normalized.length > maxLength) {
    throw new PlatformError("validation_error", `${field} must be at most ${maxLength} characters`, 400);
  }
  return normalized;
}

function normalizeStatus(value: unknown): TelegramRecipientStatus {
  return value === "disabled" ? "disabled" : "active";
}

function normalizeRecipientKind(value: unknown): TelegramRecipientKind {
  const normalized = String(value || "").trim();
  if (["owner", "manager", "sales_staff", "ops", "custom"].includes(normalized)) return normalized as TelegramRecipientKind;
  throw new PlatformError("validation_error", "recipientKind is invalid", 400);
}

function normalizeChannelFilter(value: unknown): string {
  const normalized = String(value || "all").trim().toLowerCase();
  if (!["all", "telegram", "pos", "remote", "web_pos"].includes(normalized)) {
    throw new PlatformError("validation_error", "channelFilter is invalid", 400);
  }
  return normalized;
}

function normalizeEventTypes(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PlatformError("validation_error", "eventTypes must be an array", 400);
  const normalized = Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)));
  if (normalized.some((item) => item.length > 120)) {
    throw new PlatformError("validation_error", "eventTypes contains an invalid value", 400);
  }
  return normalized;
}

function recipientDto(row: RecipientRow): TelegramNotificationRecipientDto {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    storeId: row.store_id,
    storeName: row.store_name,
    telegramUserId: row.telegram_user_id,
    telegramChatId: row.telegram_chat_id,
    telegramUsername: row.telegram_username,
    linkedOperatorId: row.linked_operator_id,
    displayName: row.display_name,
    recipientKind: row.recipient_kind,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function ruleDto(row: RuleRow): TelegramNotificationRuleDto {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    storeId: row.store_id,
    storeName: row.store_name,
    recipientId: row.recipient_id,
    recipientDisplayName: row.recipient_display_name,
    name: row.name,
    enabled: row.enabled,
    eventScope: row.event_scope,
    channelFilter: row.channel_filter,
    eventTypes: row.event_types || [],
    templateProfile: row.template_profile,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function assertStoreBelongsToMerchant(client: PoolClient, merchantId: string, storeId: string | null): Promise<void> {
  if (!storeId) return;
  const store = await queryOne<{ id: string }>(client, `
    SELECT id FROM app.stores
    WHERE id = $1 AND merchant_id = $2
    LIMIT 1
  `, [storeId, merchantId]);
  if (!store) throw new PlatformError("validation_error", "storeId does not belong to merchant", 400, { storeId });
  await lockNotificationStores(client, merchantId, storeId);
}

async function lockNotificationStores(client: PoolClient, merchantId: string, ...storeIds: (string | null | undefined)[]): Promise<void> {
  for (const storeId of [...new Set(storeIds.filter((id): id is string => Boolean(id)))].sort()) {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId, storeId });
  }
}

async function lockNotificationMerchant(client: PoolClient, merchantId: string): Promise<void> {
  // Serialize settings writers so recipient/rule ownership stays stable while checking every store.
  await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId }, "update");
}

async function recipientRow(client: PoolClient, merchantId: string, recipientId: string, lock = false): Promise<RecipientRow> {
  const row = await queryOne<RecipientRow>(client, `
    SELECT r.id::text, r.merchant_id, r.store_id, s.display_name AS store_name,
           r.telegram_user_id, r.telegram_chat_id, r.telegram_username, r.linked_operator_id,
           r.display_name, r.recipient_kind, r.status, r.created_at, r.updated_at
    FROM notification.telegram_recipients r
    LEFT JOIN app.stores s ON s.id = r.store_id
    WHERE r.id = $1::uuid AND r.merchant_id = $2
    LIMIT 1
    ${lock ? "FOR UPDATE OF r" : ""}
  `, [recipientId, merchantId]);
  if (!row) throw new PlatformError("resource_not_found", "Telegram recipient not found", 404, { recipientId });
  return row;
}

async function ruleRow(client: PoolClient, merchantId: string, ruleId: string, lock = false): Promise<RuleRow> {
  const row = await queryOne<RuleRow>(client, `
    SELECT rule.id::text, rule.merchant_id, rule.store_id, store.display_name AS store_name,
           rule.recipient_id::text, recipient.display_name AS recipient_display_name,
           recipient.store_id AS recipient_store_id,
           rule.name, rule.enabled, rule.event_scope, rule.channel_filter, rule.event_types,
           rule.template_profile, rule.created_at, rule.updated_at
    FROM notification.telegram_notification_rules rule
    JOIN notification.telegram_recipients recipient ON recipient.id = rule.recipient_id
    LEFT JOIN app.stores store ON store.id = rule.store_id
    WHERE rule.id = $1::uuid AND rule.merchant_id = $2
    LIMIT 1
    ${lock ? "FOR UPDATE OF rule" : ""}
  `, [ruleId, merchantId]);
  if (!row) throw new PlatformError("resource_not_found", "Telegram notification rule not found", 404, { ruleId });
  return row;
}

export async function getTelegramNotificationSettings(
  merchantId: string,
  scope: MerchantTargetScope,
): Promise<{ data: TelegramNotificationSettingsDto }> {
  ensureScope(scope, merchantId);
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const recipients = await client.query<RecipientRow>(`
      SELECT r.id::text, r.merchant_id, r.store_id, s.display_name AS store_name,
             r.telegram_user_id, r.telegram_chat_id, r.telegram_username, r.linked_operator_id,
             r.display_name, r.recipient_kind, r.status, r.created_at, r.updated_at
      FROM notification.telegram_recipients r
      LEFT JOIN app.stores s ON s.id = r.store_id
      WHERE r.merchant_id = $1
      ORDER BY r.status ASC, r.recipient_kind ASC, r.display_name ASC
    `, [merchantId]);
    const rules = await client.query<RuleRow>(`
      SELECT rule.id::text, rule.merchant_id, rule.store_id, store.display_name AS store_name,
             rule.recipient_id::text, recipient.display_name AS recipient_display_name,
             rule.name, rule.enabled, rule.event_scope, rule.channel_filter, rule.event_types,
             rule.template_profile, rule.created_at, rule.updated_at
      FROM notification.telegram_notification_rules rule
      JOIN notification.telegram_recipients recipient ON recipient.id = rule.recipient_id
      LEFT JOIN app.stores store ON store.id = rule.store_id
      WHERE rule.merchant_id = $1
      ORDER BY rule.enabled DESC, rule.event_scope ASC, rule.name ASC
    `, [merchantId]);
    return { data: { recipients: recipients.rows.map(recipientDto), rules: rules.rows.map(ruleDto) } };
  });
}

export async function createTelegramNotificationRecipient(
  merchantId: string,
  input: CreateTelegramNotificationRecipientInput,
  actor: AuditActor,
  scope: MerchantTargetScope,
): Promise<{ data: TelegramNotificationRecipientDto }> {
  ensureScope(scope, merchantId);
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockNotificationMerchant(client, merchantId);
    const storeId = text(input.storeId, "storeId", 120);
    await assertStoreBelongsToMerchant(client, merchantId, storeId);
    const row = await queryOne<RecipientRow>(client, `
      INSERT INTO notification.telegram_recipients (
        merchant_id, store_id, telegram_user_id, telegram_chat_id, telegram_username,
        linked_operator_id, display_name, recipient_kind, status, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id::text, merchant_id, store_id, NULL::text AS store_name,
        telegram_user_id, telegram_chat_id, telegram_username, linked_operator_id,
        display_name, recipient_kind, status, created_at, updated_at
    `, [
      merchantId,
      storeId,
      text(input.telegramUserId, "telegramUserId", 80, { required: true }),
      text(input.telegramChatId ?? input.telegramUserId, "telegramChatId", 80),
      text(input.telegramUsername, "telegramUsername", 80)?.replace(/^@/, "") || null,
      text(input.linkedOperatorId, "linkedOperatorId", 120),
      text(input.displayName, "displayName", 160, { required: true }),
      normalizeRecipientKind(input.recipientKind),
      normalizeStatus(input.status),
      actor.operatorId,
    ]);
    if (!row) throw new PlatformError("settings_update_failed", "Telegram recipient could not be created", 500);
    const after = recipientDto({ ...row, store_name: null });
    await recordAuditEntry(client, actor, "settings.telegram_recipient.created", "telegram_recipient", row.id, {
      after,
      merchantId,
      storeId: storeId || undefined,
    });
    return { data: after };
  });
}

export async function updateTelegramNotificationRecipient(
  merchantId: string,
  recipientId: string,
  input: UpdateTelegramNotificationRecipientInput,
  actor: AuditActor,
  scope: MerchantTargetScope,
): Promise<{ data: TelegramNotificationRecipientDto }> {
  ensureScope(scope, merchantId);
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockNotificationMerchant(client, merchantId);
    const current = await recipientRow(client, merchantId, recipientId, true);
    await lockNotificationStores(client, merchantId, current.store_id);
    const before = recipientDto(current);
    const storeId = "storeId" in input ? text(input.storeId, "storeId", 120) : current.store_id;
    await assertStoreBelongsToMerchant(client, merchantId, storeId);
    const row = await queryOne<RecipientRow>(client, `
      UPDATE notification.telegram_recipients
      SET store_id = $3,
          telegram_user_id = $4,
          telegram_chat_id = $5,
          telegram_username = $6,
          linked_operator_id = $7,
          display_name = $8,
          recipient_kind = $9,
          status = $10,
          updated_by = $11,
          updated_at = now()
      WHERE id = $1::uuid AND merchant_id = $2
      RETURNING id::text, merchant_id, store_id, NULL::text AS store_name,
        telegram_user_id, telegram_chat_id, telegram_username, linked_operator_id,
        display_name, recipient_kind, status, created_at, updated_at
    `, [
      recipientId,
      merchantId,
      storeId,
      "telegramUserId" in input ? text(input.telegramUserId, "telegramUserId", 80, { required: true }) : current.telegram_user_id,
      "telegramChatId" in input ? text(input.telegramChatId ?? input.telegramUserId, "telegramChatId", 80) : current.telegram_chat_id,
      "telegramUsername" in input ? text(input.telegramUsername, "telegramUsername", 80)?.replace(/^@/, "") || null : current.telegram_username,
      "linkedOperatorId" in input ? text(input.linkedOperatorId, "linkedOperatorId", 120) : current.linked_operator_id,
      "displayName" in input ? text(input.displayName, "displayName", 160, { required: true }) : current.display_name,
      "recipientKind" in input ? normalizeRecipientKind(input.recipientKind) : current.recipient_kind,
      "status" in input ? normalizeStatus(input.status) : current.status,
      actor.operatorId,
    ]);
    if (!row) throw new PlatformError("settings_update_failed", "Telegram recipient could not be updated", 500);
    const after = recipientDto({ ...row, store_name: null });
    await recordAuditEntry(client, actor, "settings.telegram_recipient.updated", "telegram_recipient", recipientId, {
      before,
      after,
      merchantId,
      storeId: storeId || undefined,
    });
    return { data: after };
  });
}

export async function createTelegramNotificationRule(
  merchantId: string,
  input: CreateTelegramNotificationRuleInput,
  actor: AuditActor,
  scope: MerchantTargetScope,
): Promise<{ data: TelegramNotificationRuleDto }> {
  ensureScope(scope, merchantId);
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockNotificationMerchant(client, merchantId);
    const storeId = text(input.storeId, "storeId", 120);
    await assertStoreBelongsToMerchant(client, merchantId, storeId);
    const recipient = await recipientRow(client, merchantId, input.recipientId);
    await lockNotificationStores(client, merchantId, recipient.store_id);
    const row = await queryOne<RuleRow>(client, `
      INSERT INTO notification.telegram_notification_rules (
        merchant_id, store_id, recipient_id, name, enabled, event_scope,
        channel_filter, event_types, template_profile, created_by
      )
      VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8::text[], $9, $10)
      RETURNING id::text, merchant_id, store_id, NULL::text AS store_name,
        recipient_id::text, $11::text AS recipient_display_name,
        name, enabled, event_scope, channel_filter, event_types, template_profile, created_at, updated_at
    `, [
      merchantId,
      storeId,
      input.recipientId,
      text(input.name, "name", 180, { required: true }),
      input.enabled ?? true,
      text(input.eventScope, "eventScope", 80, { required: true }),
      normalizeChannelFilter(input.channelFilter),
      normalizeEventTypes(input.eventTypes),
      text(input.templateProfile || "default", "templateProfile", 80, { required: true }),
      actor.operatorId,
      (await recipientRow(client, merchantId, input.recipientId)).display_name,
    ]);
    if (!row) throw new PlatformError("settings_update_failed", "Telegram notification rule could not be created", 500);
    const after = ruleDto(row);
    await recordAuditEntry(client, actor, "settings.telegram_notification_rule.created", "telegram_notification_rule", row.id, {
      after,
      merchantId,
      storeId: storeId || undefined,
    });
    return { data: after };
  });
}

export async function updateTelegramNotificationRule(
  merchantId: string,
  ruleId: string,
  input: UpdateTelegramNotificationRuleInput,
  actor: AuditActor,
  scope: MerchantTargetScope,
): Promise<{ data: TelegramNotificationRuleDto }> {
  ensureScope(scope, merchantId);
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockNotificationMerchant(client, merchantId);
    const current = await ruleRow(client, merchantId, ruleId, true);
    await lockNotificationStores(client, merchantId, current.store_id, current.recipient_store_id);
    const before = ruleDto(current);
    const storeId = "storeId" in input ? text(input.storeId, "storeId", 120) : current.store_id;
    await assertStoreBelongsToMerchant(client, merchantId, storeId);
    const recipientId = "recipientId" in input && input.recipientId ? input.recipientId : current.recipient_id;
    const recipient = await recipientRow(client, merchantId, recipientId);
    await lockNotificationStores(client, merchantId, recipient.store_id);
    const row = await queryOne<RuleRow>(client, `
      UPDATE notification.telegram_notification_rules
      SET store_id = $3,
          recipient_id = $4::uuid,
          name = $5,
          enabled = $6,
          event_scope = $7,
          channel_filter = $8,
          event_types = $9::text[],
          template_profile = $10,
          updated_by = $11,
          updated_at = now()
      WHERE id = $1::uuid AND merchant_id = $2
      RETURNING id::text, merchant_id, store_id, NULL::text AS store_name,
        recipient_id::text, $12::text AS recipient_display_name,
        name, enabled, event_scope, channel_filter, event_types, template_profile, created_at, updated_at
    `, [
      ruleId,
      merchantId,
      storeId,
      recipientId,
      "name" in input ? text(input.name, "name", 180, { required: true }) : current.name,
      "enabled" in input ? Boolean(input.enabled) : current.enabled,
      "eventScope" in input ? text(input.eventScope, "eventScope", 80, { required: true }) : current.event_scope,
      "channelFilter" in input ? normalizeChannelFilter(input.channelFilter) : current.channel_filter,
      "eventTypes" in input ? normalizeEventTypes(input.eventTypes) : current.event_types,
      "templateProfile" in input ? text(input.templateProfile || "default", "templateProfile", 80, { required: true }) : current.template_profile,
      actor.operatorId,
      recipient.display_name,
    ]);
    if (!row) throw new PlatformError("settings_update_failed", "Telegram notification rule could not be updated", 500);
    const after = ruleDto(row);
    await recordAuditEntry(client, actor, "settings.telegram_notification_rule.updated", "telegram_notification_rule", ruleId, {
      before,
      after,
      merchantId,
      storeId: storeId || undefined,
    });
    return { data: after };
  });
}

export async function sendTelegramNotificationRecipientTest(
  merchantId: string,
  recipientId: string,
  actor: AuditActor,
  scope: MerchantTargetScope,
): Promise<{ data: { queued: true; recipientId: string } }> {
  ensureScope(scope, merchantId);
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockNotificationMerchant(client, merchantId);
    const recipient = await recipientRow(client, merchantId, recipientId);
    await lockNotificationStores(client, merchantId, recipient.store_id);
    if (recipient.status !== "active") {
      throw new PlatformError("validation_error", "Cannot send a test notification to a disabled recipient", 400);
    }
    await enqueueTelegramNotificationForClient(client, `telegram-test:${merchantId}:${recipientId}:${Date.now()}`, {
      organizationId: actor.organizationId || "org_default",
      merchantId,
      storeId: recipient.store_id,
      recipientId,
      telegramChatId: recipient.telegram_chat_id || recipient.telegram_user_id,
      template: "telegram_sales_request_created",
      payload: {
        text: [
          "Telegram notification test",
          `Recipient: ${recipient.display_name}`,
          "If you received this, routing is configured.",
        ].join("\n"),
      },
    });
    await recordAuditEntry(client, actor, "settings.telegram_recipient.test_sent", "telegram_recipient", recipientId, {
      after: { queued: true },
      merchantId,
      storeId: recipient.store_id || undefined,
    });
    return { data: { queued: true, recipientId } };
  });
}
