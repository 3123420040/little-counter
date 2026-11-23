import type { PoolClient } from "../db/client";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import type { HeadersLike } from "../http/headers";
import { authenticateChannelServiceOnlyHeaders } from "./channel-auth-service";

export interface TelegramNotificationRequest {
  organizationId?: string;
  organization_id?: string;
  merchantId?: string | null;
  merchant_id?: string | null;
  storeId?: string | null;
  store_id?: string | null;
  recipient_operator_id?: string;
  recipientOperatorId?: string;
  recipient_id?: string;
  recipientId?: string;
  rule_id?: string;
  ruleId?: string;
  telegram_chat_id?: string;
  telegramChatId?: string;
  telegram_user_id?: string;
  telegramUserId?: string;
  dedupe_key?: string;
  dedupeKey?: string;
  template?: string;
  payload?: Record<string, unknown>;
}

function money(value: unknown): string {
  return `${Math.round(Number(value || 0)).toLocaleString("vi-VN")} VND`;
}

function notificationText(template: string, payload: Record<string, unknown>): string {
  if (typeof payload.text === "string" && payload.text.trim()) return payload.text.trim();
  if (template === "daily_summary") {
    return [
      "Bao cao ngay",
      `Don hang: ${payload.order_count ?? payload.orderCount ?? 0}`,
      `Doanh thu: ${money(payload.gross_sales ?? payload.grossSales ?? payload.totalRevenue)}`,
      payload.low_stock || payload.lowStock ? `Sap het hang: ${payload.low_stock ?? payload.lowStock}` : "",
    ].filter(Boolean).join("\n");
  }
  if (template === "low_stock_alert") {
    return [
      "Canh bao ton kho",
      `San pham: ${payload.product_title ?? payload.productTitle ?? payload.productId ?? "unknown"}`,
      `Ton hien tai: ${payload.current_stock ?? payload.currentStock ?? 0}`,
      `Muc dat lai: ${payload.reorder_level ?? payload.reorderLevel ?? 0}`,
    ].join("\n");
  }
  if (template === "refund_created") {
    return [
      "Da ghi nhan refund",
      `Don: ${payload.orderNumber ?? payload.order_id ?? payload.orderId ?? ""}`,
      `So tien: ${money(payload.amount)}`,
      payload.reason ? `Ly do: ${payload.reason}` : "",
    ].filter(Boolean).join("\n");
  }
  if (template === "remote_order_created") {
    return [
      "Don remote moi",
      `Don: ${payload.orderNumber ?? payload.order_id ?? payload.orderId ?? ""}`,
      `Tong: ${money(payload.total)}`,
      payload.paymentMethod ? `Thanh toan: ${payload.paymentMethod}` : "",
    ].filter(Boolean).join("\n");
  }
  if (template === "telegram_sales_request_created") {
    return [
      "Telegram sales request moi",
      `Draft: ${payload.draftId ?? payload.draft_id ?? ""}`,
      `Khach: ${payload.customer ?? payload.telegramUserId ?? payload.telegram_user_id ?? ""}`,
      `Tong du kien: ${money(payload.total)}`,
      payload.telegramUrl ? `Chat Telegram: ${payload.telegramUrl}` : "",
      payload.portalPath ? `Xu ly tai POS: ${payload.portalPath}` : "",
      payload.actionLabel ? `Thao tac: ${payload.actionLabel}` : "",
    ].filter(Boolean).join("\n");
  }
  if (template === "order_created") {
    return [
      "Don hang moi",
      `Don: ${payload.orderNumber ?? payload.order_id ?? payload.orderId ?? ""}`,
      `Tong: ${money(payload.total)}`,
      payload.channel || payload.salesChannel ? `Kenh: ${payload.channel ?? payload.salesChannel}` : "",
      payload.storeId ? `Store: ${payload.storeId}` : "",
      payload.portalPath ? `Xu ly tai POS: ${payload.portalPath}` : "",
    ].filter(Boolean).join("\n");
  }
  if (template === "order_cancelled") {
    return [
      "Don hang da huy",
      `Don: ${payload.orderNumber ?? payload.order_id ?? payload.orderId ?? ""}`,
      payload.reason ? `Ly do: ${payload.reason}` : "",
    ].filter(Boolean).join("\n");
  }
  if (template === "order_shipping_adjusted") {
    return [
      "Phi ship don hang da cap nhat",
      `Don: ${payload.orderNumber ?? payload.order_id ?? payload.orderId ?? ""}`,
      `Phi moi: ${money(payload.shippingFee ?? payload.newShippingFee)}`,
    ].filter(Boolean).join("\n");
  }
  if (template === "order_corrected") {
    return [
      "Don hang da dieu chinh",
      `Don: ${payload.orderNumber ?? payload.order_id ?? payload.orderId ?? ""}`,
      `Chenhlech: ${money(payload.totalDelta)}`,
    ].filter(Boolean).join("\n");
  }
  if (template === "shift_discrepancy_alert") {
    return [
      "Canh bao chenh lech ca",
      `Ca: ${payload.zNumber ?? payload.shiftId ?? ""}`,
      `Lech tien mat: ${money(payload.cashVarianceAmount)}`,
      payload.maxStockDiscrepancy ? `Lech ton cao nhat: ${payload.maxStockDiscrepancy}` : "",
      payload.storeId ? `Store: ${payload.storeId}` : "",
    ].filter(Boolean).join("\n");
  }
  return `${template}\n${JSON.stringify(payload, null, 2)}`;
}

export async function enqueueTelegramNotificationForClient(
  client: PoolClient,
  eventId: string,
  input: TelegramNotificationRequest,
): Promise<void> {
  const recipientOperatorId = String(input.recipientOperatorId || input.recipient_operator_id || "").trim();
  const recipientId = String(input.recipientId || input.recipient_id || "").trim();
  const ruleId = String(input.ruleId || input.rule_id || "").trim();
  const telegramChatId = String(input.telegramChatId || input.telegram_chat_id || input.telegramUserId || input.telegram_user_id || "").trim();
  const template = String(input.template || "").trim();
  const organizationId = String(input.organizationId || input.organization_id || "org_default").trim() || "org_default";
  const merchantId = input.merchantId ?? input.merchant_id ?? null;
  const storeId = input.storeId ?? input.store_id ?? null;
  const dedupeKey = String(input.dedupeKey || input.dedupe_key || (recipientId ? `${eventId}:${recipientId}` : eventId)).trim();
  if ((!recipientOperatorId && !recipientId && !telegramChatId) || !template) {
    throw new PlatformError("validation_error", "recipient or recipient_operator_id and template are required", 400);
  }
  await client.query(`
    INSERT INTO notification.telegram_notifications (
      organization_id,
      merchant_id,
      store_id,
      recipient_operator_id,
      recipient_id,
      rule_id,
      telegram_chat_id,
      template,
      payload,
      source_event_id,
      dedupe_key
    )
    VALUES ($1, $2, $3, $4, NULLIF($5, '')::uuid, NULLIF($6, '')::uuid, NULLIF($7, ''), $8, $9::jsonb, $10, $11)
    ON CONFLICT (dedupe_key) DO NOTHING
  `, [
    organizationId,
    merchantId,
    storeId,
    recipientOperatorId || null,
    recipientId,
    ruleId,
    telegramChatId,
    template,
    JSON.stringify(input.payload || {}),
    eventId,
    dedupeKey,
  ]);
}

async function resolveTelegramNotificationScope(
  client: PoolClient,
  service: ReturnType<typeof authenticateChannelServiceOnlyHeaders>,
): Promise<{ organizationId: string; merchantId: string | null }> {
  if (service.merchantId) {
    const merchant = await queryOne<{ legacy_organization_id: string }>(client, `
      SELECT legacy_organization_id
      FROM app.merchants
      WHERE id = $1 AND status = 'active'
      LIMIT 1
    `, [service.merchantId]);
    if (!merchant) throw new PlatformError("merchant_not_found", "Merchant not found for Telegram notification channel", 403);
    return { organizationId: merchant.legacy_organization_id, merchantId: service.merchantId };
  }

  if (service.telegramBotConfigId) {
    const config = await queryOne<{ merchant_id: string; legacy_organization_id: string }>(client, `
      SELECT tbc.merchant_id, m.legacy_organization_id
      FROM app.telegram_bot_configs tbc
      JOIN app.merchants m ON m.id = tbc.merchant_id AND m.status = 'active'
      WHERE tbc.id = $1 AND tbc.status = 'active'
      LIMIT 1
    `, [service.telegramBotConfigId]);
    if (!config) throw new PlatformError("telegram_bot_config_not_found", "Telegram bot config not found", 403);
    return { organizationId: config.legacy_organization_id, merchantId: config.merchant_id };
  }

  return { organizationId: "org_default", merchantId: null };
}

export async function handleTelegramNotificationRequested(
  client: PoolClient,
  eventId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await enqueueTelegramNotificationForClient(client, eventId, payload as TelegramNotificationRequest);
}

export async function claimTelegramNotifications(headers: HeadersLike, limit = 10) {
  const service = authenticateChannelServiceOnlyHeaders(headers);
  await ensurePlatformSchema();
  const safeLimit = Math.max(1, Math.min(25, Number(limit || 10)));

  return withConnectedTransaction(async (client) => {
    const scope = await resolveTelegramNotificationScope(client, service);
    const result = await client.query<{
      id: string;
      telegram_user_id: string;
      recipient_operator_id: string | null;
      recipient_id: string | null;
      rule_id: string | null;
      template: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>(`
      WITH eligible AS (
        SELECT
          tn.id,
          COALESCE(tn.telegram_chat_id, tr.telegram_chat_id, tr.telegram_user_id, oi.provider_user_id) AS telegram_user_id
        FROM notification.telegram_notifications tn
        LEFT JOIN notification.telegram_recipients tr
          ON tr.id = tn.recipient_id
         AND tr.status = 'active'
         AND ($3::text IS NULL OR tr.merchant_id = $3::text)
        LEFT JOIN app.operator_identities oi
          ON oi.organization_id = tn.organization_id
         AND oi.provider = $2
         AND oi.operator_id = tn.recipient_operator_id
         AND oi.is_active = true
         AND ($3::text IS NULL OR oi.merchant_id = $3::text OR oi.merchant_id IS NULL)
        WHERE tn.status IN ('pending', 'processing')
          AND tn.organization_id = $4
          AND ($3::text IS NULL OR tn.merchant_id = $3::text OR tn.merchant_id IS NULL)
          AND (tn.recipient_id IS NULL OR tr.id IS NOT NULL)
          AND (tn.recipient_id IS NOT NULL OR oi.provider_user_id IS NOT NULL)
          AND COALESCE(tn.telegram_chat_id, tr.telegram_chat_id, tr.telegram_user_id, oi.provider_user_id) IS NOT NULL
          AND (tn.status = 'pending' OR tn.claimed_until <= now())
          AND (tn.next_retry_at IS NULL OR tn.next_retry_at <= now())
          AND tn.attempts < 5
        ORDER BY
          CASE WHEN $3::text IS NOT NULL AND tn.merchant_id = $3::text THEN 0 ELSE 1 END,
          tn.created_at ASC
        LIMIT $1
        FOR UPDATE OF tn SKIP LOCKED
      )
      UPDATE notification.telegram_notifications tn
      SET status = 'processing',
          attempts = tn.attempts + 1,
          claimed_until = now() + interval '60 seconds',
          updated_at = now()
      FROM eligible
      WHERE tn.id = eligible.id
      RETURNING
        tn.id::text,
        eligible.telegram_user_id AS telegram_user_id,
        tn.recipient_operator_id,
        tn.recipient_id::text,
        tn.rule_id::text,
        tn.template,
        tn.payload,
        tn.attempts
    `, [safeLimit, service.channel, scope.merchantId, scope.organizationId]);

    return {
      data: result.rows.map((row) => ({
        id: row.id,
        telegramUserId: row.telegram_user_id,
        recipientOperatorId: row.recipient_operator_id,
        recipientId: row.recipient_id,
        ruleId: row.rule_id,
        template: row.template,
        payload: row.payload,
        text: notificationText(row.template, row.payload || {}),
        attempts: Number(row.attempts || 0),
      })),
    };
  });
}

export async function markTelegramNotificationSent(headers: HeadersLike, notificationId: string) {
  authenticateChannelServiceOnlyHeaders(headers);
  await ensurePlatformSchema();

  return withConnectedClient(async (client) => {
    const row = await queryOne<{ id: string }>(client, `
      UPDATE notification.telegram_notifications
      SET status = 'sent',
          sent_at = now(),
          claimed_until = NULL,
          next_retry_at = NULL,
          last_error = NULL,
          updated_at = now()
      WHERE id = $1
      RETURNING id::text
    `, [notificationId]);
    if (!row) throw new PlatformError("resource_not_found", "Notification not found", 404);
    return { data: { id: row.id, status: "sent" } };
  });
}

export async function markTelegramNotificationFailed(headers: HeadersLike, notificationId: string, error: string) {
  authenticateChannelServiceOnlyHeaders(headers);
  await ensurePlatformSchema();

  return withConnectedClient(async (client) => {
    const row = await queryOne<{ id: string; status: string }>(client, `
      UPDATE notification.telegram_notifications
      SET status = CASE WHEN attempts >= 5 THEN 'dead_lettered' ELSE 'pending' END,
          claimed_until = NULL,
          next_retry_at = CASE WHEN attempts >= 5 THEN NULL ELSE now() + interval '30 seconds' END,
          last_error = $2,
          updated_at = now()
      WHERE id = $1
      RETURNING id::text, status
    `, [notificationId, error || "Telegram dispatch failed"]);
    if (!row) throw new PlatformError("resource_not_found", "Notification not found", 404);
    return { data: { id: row.id, status: row.status } };
  });
}
