import { createHash, randomUUID } from "node:crypto";
import {
  lifecycleNotificationIdempotencyPrefix,
  lifecycleNotificationTemplateVersion,
  type LifecycleNotificationTemplateKey,
  type SubscriptionLifecycleNotificationType,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedTransaction } from "../db/transaction";
import type { DeliveryResult, TransactionalEmailProvider } from "../email/provider";
import { renderTemplate, type EmailTemplateKey } from "../email/templates";
import { recordAuditEntry } from "../repositories/audit-repository";

const MAPPED_EVENT_TYPES = [
  "subscription.renewal_reminder",
  "subscription.entered_grace",
  "subscription.grace_ending",
  "subscription.expired",
  "subscription.renewed",
  "subscription.reactivated",
  "subscription.upgraded",
] as const;

type CurrentState = "active" | "grace" | "expired";

export interface SubscriptionLifecycleEvent {
  id: string;
  merchantId: string;
  subscriptionId: string;
  eventType: string;
  reminderOffsetDays: number | null;
  periodEnd: string;
  payload: Record<string, unknown>;
}

export interface MappedLifecycleNotification {
  notificationType: SubscriptionLifecycleNotificationType;
  templateKey: LifecycleNotificationTemplateKey;
  templateVersion: number;
  currentState: CurrentState;
  reminderOffsetDays: number | null;
}

interface OwnerRecipient {
  operatorId: string;
  email: string;
}

interface NotificationDeliveryRow {
  id: string;
  source_event_id: string;
  merchant_id: string;
  subscription_id: string;
  event_type: string;
  notification_type: SubscriptionLifecycleNotificationType;
  template_key: LifecycleNotificationTemplateKey;
  template_version: number;
  period_end: string | Date;
  reminder_offset_days: number | null;
  recipient_operator_id: string | null;
  recipient_email: string | null;
  recipient_active: boolean;
  idempotency_key: string;
  payload_summary: Record<string, unknown>;
  attempt_count: number;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Lifecycle notification payload requires ${key}`);
  }
  return value;
}

/**
 * Validates the deliberately small, secret-free payload contract stored in the
 * lifecycle notification outbox. Full rendered email bodies are never stored.
 */
export function validateLifecycleTemplatePayload(payload: Record<string, unknown>): void {
  const allowed = new Set([
    "packageKey",
    "renewalDate",
    "graceEndDate",
    "currentState",
    "actionUrl",
    "daysBeforeRenewal",
    "daysRemainingInGrace",
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new Error(`Unsupported lifecycle notification payload field: ${key}`);
  }
  requiredString(payload, "packageKey");
  requiredString(payload, "renewalDate");
  const currentState = requiredString(payload, "currentState");
  if (!["active", "grace", "expired"].includes(currentState)) {
    throw new Error("Lifecycle notification payload has an invalid currentState");
  }
  requiredString(payload, "actionUrl");
  if (payload.graceEndDate !== undefined) requiredString(payload, "graceEndDate");
}

/** Maps canonical subscription events; it never reads or changes subscription state. */
export function mapSubscriptionLifecycleEvent(event: SubscriptionLifecycleEvent): MappedLifecycleNotification | null {
  switch (event.eventType) {
    case "subscription.renewal_reminder":
      if (![30, 14, 7, 1].includes(event.reminderOffsetDays ?? -1)) return null;
      return {
        notificationType: "renewal_reminder",
        templateKey: "subscription.renewal_reminder",
        templateVersion: lifecycleNotificationTemplateVersion,
        currentState: "active",
        reminderOffsetDays: event.reminderOffsetDays,
      };
    case "subscription.entered_grace":
      return {
        notificationType: "grace_started",
        templateKey: "subscription.entered_grace",
        templateVersion: lifecycleNotificationTemplateVersion,
        currentState: "grace",
        reminderOffsetDays: null,
      };
    case "subscription.grace_ending":
      return {
        notificationType: "grace_ending",
        templateKey: "subscription.grace_ending",
        templateVersion: lifecycleNotificationTemplateVersion,
        currentState: "grace",
        reminderOffsetDays: null,
      };
    case "subscription.expired":
      return {
        notificationType: "expired_basic_fallback",
        templateKey: "subscription.expired",
        templateVersion: lifecycleNotificationTemplateVersion,
        currentState: "expired",
        reminderOffsetDays: null,
      };
    case "subscription.renewed":
    case "subscription.reactivated":
      return {
        notificationType: "renewal_applied",
        templateKey: "subscription.renewal_applied",
        templateVersion: lifecycleNotificationTemplateVersion,
        currentState: "active",
        reminderOffsetDays: null,
      };
    case "subscription.upgraded":
      return {
        notificationType: "upgrade_applied",
        templateKey: "subscription.upgrade_applied",
        templateVersion: lifecycleNotificationTemplateVersion,
        currentState: "active",
        reminderOffsetDays: null,
      };
    default:
      return null;
  }
}

export function buildLifecycleNotificationIdempotencyKey(
  event: Pick<SubscriptionLifecycleEvent, "merchantId" | "subscriptionId" | "periodEnd">,
  mapped: Pick<MappedLifecycleNotification, "notificationType" | "reminderOffsetDays" | "templateKey" | "templateVersion">,
): string {
  return [
    lifecycleNotificationIdempotencyPrefix,
    event.merchantId,
    event.subscriptionId,
    new Date(event.periodEnd).toISOString(),
    mapped.notificationType,
    mapped.reminderOffsetDays ?? "none",
    mapped.templateKey,
    mapped.templateVersion,
  ].join(":");
}

function actionUrlFor(merchantId: string): string {
  const base = (process.env.PUBLIC_APP_URL || "http://localhost:8080").replace(/\/$/, "");
  return `${base}/settings/merchant/${encodeURIComponent(merchantId)}/package`;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function buildLifecyclePayloadSummary(
  event: SubscriptionLifecycleEvent,
  mapped: MappedLifecycleNotification,
  now: Date,
): Record<string, unknown> {
  const packageKey = typeof event.payload.packageKey === "string" ? event.payload.packageKey : "basic";
  const periodEnd = iso(event.periodEnd);
  const graceEndDate = typeof event.payload.graceEndsAt === "string"
    ? new Date(event.payload.graceEndsAt).toISOString()
    : new Date(new Date(periodEnd).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const summary: Record<string, unknown> = {
    packageKey,
    renewalDate: periodEnd,
    currentState: mapped.currentState,
    actionUrl: actionUrlFor(event.merchantId),
  };
  if (mapped.notificationType === "renewal_reminder") summary.daysBeforeRenewal = mapped.reminderOffsetDays;
  if (mapped.currentState === "grace") {
    summary.graceEndDate = graceEndDate;
    summary.daysRemainingInGrace = Math.max(0, Math.ceil((new Date(graceEndDate).getTime() - now.getTime()) / 86_400_000));
  }
  validateLifecycleTemplatePayload(summary);
  return summary;
}

async function resolveOwnerRecipient(client: PoolClient, merchantId: string, now: Date): Promise<OwnerRecipient | null> {
  const result = await client.query<{ operator_id: string; normalized_email: string }>(`
    SELECT membership.operator_id, request.normalized_email
    FROM app.operator_memberships AS membership
    JOIN app.signup_requests AS request
      ON request.owner_merchant_id = membership.merchant_id
     AND request.status = 'provisioned'
    WHERE membership.merchant_id = $1
      AND membership.scope_type = 'merchant'
      AND membership.role_key = 'owner'
      AND membership.status = 'active'
      AND membership.valid_from <= $2::timestamptz
      AND (membership.valid_to IS NULL OR membership.valid_to > $2::timestamptz)
    ORDER BY membership.created_at ASC, membership.operator_id ASC
    LIMIT 1
  `, [merchantId, now.toISOString()]);
  const row = result.rows[0];
  return row ? { operatorId: row.operator_id, email: row.normalized_email } : null;
}

function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/**
 * Keeps the provider-facing key stable while avoiding merchant/subscription
 * identifiers in a third-party request and staying below provider key limits.
 */
export function buildProviderDeliveryIdempotencyKey(notificationIdempotencyKey: string): string {
  return `subscription-${createHash("sha256").update(notificationIdempotencyKey).digest("hex")}`;
}

function renderLifecycleMessage(row: NotificationDeliveryRow) {
  const payload = row.payload_summary;
  validateLifecycleTemplatePayload(payload);
  const rendered = renderTemplate(row.template_key as EmailTemplateKey, {
    packageKey: String(payload.packageKey),
    periodEnd: String(payload.renewalDate),
    renewalDate: String(payload.renewalDate),
    graceEndsAt: payload.graceEndDate ? String(payload.graceEndDate) : undefined,
    daysLeft: typeof (payload.daysBeforeRenewal ?? payload.daysRemainingInGrace) === "number"
      ? (payload.daysBeforeRenewal ?? payload.daysRemainingInGrace) as number
      : undefined,
    renewUrl: String(payload.actionUrl),
    actionUrl: String(payload.actionUrl),
    currentState: String(payload.currentState),
  });
  return {
    to: row.recipient_email || "",
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    templateKey: row.template_key,
    requestId: row.source_event_id,
    idempotencyKey: buildProviderDeliveryIdempotencyKey(row.idempotency_key),
  };
}

export async function queueSubscriptionLifecycleNotifications(input: { limit?: number; now?: Date; merchantIds?: string[] } = {}): Promise<{ queued: number; skipped: number }> {
  await ensurePlatformSchema();
  const now = input.now || new Date();
  return withConnectedTransaction(async (client) => {
    const eventRows = await client.query<{
      id: string;
      merchant_id: string;
      subscription_id: string;
      event_type: string;
      reminder_offset_days: number | null;
      period_end: string | Date;
      payload: Record<string, unknown>;
    }>(`
      SELECT id, merchant_id, subscription_id, event_type, reminder_offset_days, period_end, payload
      FROM app.subscription_events AS event
      WHERE event.event_type = ANY($1::text[])
        AND ($4::text[] IS NULL OR event.merchant_id = ANY($4::text[]))
        AND (event.event_type <> 'subscription.renewal_reminder'
          OR event.reminder_offset_days = ANY(ARRAY[30, 14, 7, 1]::smallint[]))
        AND NOT EXISTS (
          SELECT 1 FROM app.subscription_notifications AS notification
          WHERE notification.source_event_id = event.id
            AND notification.template_version = $2
        )
      ORDER BY event.created_at ASC, event.id ASC
      LIMIT $3
      FOR UPDATE OF event SKIP LOCKED
    `, [
      MAPPED_EVENT_TYPES,
      lifecycleNotificationTemplateVersion,
      input.limit ?? 100,
      input.merchantIds && input.merchantIds.length > 0 ? input.merchantIds : null,
    ]);
    let queued = 0;
    let skipped = 0;

    for (const row of eventRows.rows) {
      const event: SubscriptionLifecycleEvent = {
        id: row.id,
        merchantId: row.merchant_id,
        subscriptionId: row.subscription_id,
        eventType: row.event_type,
        reminderOffsetDays: row.reminder_offset_days,
        periodEnd: iso(row.period_end),
        payload: row.payload || {},
      };
      const mapped = mapSubscriptionLifecycleEvent(event);
      if (!mapped) continue;
      const recipient = await resolveOwnerRecipient(client, event.merchantId, now);
      const summary = buildLifecyclePayloadSummary(event, mapped, now);
      const deliveryStatus = recipient ? "pending" : "skipped_no_recipient";
      const inserted = await client.query<{ id: string }>(`
        INSERT INTO app.subscription_notifications (
          merchant_id, subscription_id, source_event_id, event_type, reminder_offset_days, period_end,
          notification_type, template_key, template_version, idempotency_key,
          recipient_operator_id, recipient_email_hash, delivery_status, payload_summary
        ) VALUES ($1, $2, $3::uuid, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
        ON CONFLICT (source_event_id, template_key, template_version) DO NOTHING
        RETURNING id
      `, [
        event.merchantId,
        event.subscriptionId,
        event.id,
        event.eventType,
        mapped.reminderOffsetDays,
        event.periodEnd,
        mapped.notificationType,
        mapped.templateKey,
        mapped.templateVersion,
        buildLifecycleNotificationIdempotencyKey(event, mapped),
        recipient?.operatorId ?? null,
        recipient ? hashEmail(recipient.email) : null,
        deliveryStatus,
        JSON.stringify(summary),
      ]);
      if (!inserted.rows[0]) continue;
      if (recipient) queued += 1;
      else skipped += 1;
    }
    return { queued, skipped };
  });
}

export async function deliverSubscriptionLifecycleNotifications(
  provider: TransactionalEmailProvider,
  input: { limit?: number; now?: Date } = {},
  workerId?: string,
): Promise<{ sent: number; failed: number; deferred: number }> {
  await ensurePlatformSchema();
  const now = input.now || new Date();
  // Each invocation claims a unique lease so concurrent workers cannot pick
  // the same rows. The lease is asserted again when outcomes are persisted.
  const effectiveWorkerId = workerId || randomUUID();
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1000);

  type DeliveryPlan = {
    row: NotificationDeliveryRow;
    message: ReturnType<typeof renderLifecycleMessage>;
    skipStatus: "skipped_no_recipient" | "skipped_no_contact_email" | null;
  };

  // 1. Short transaction: lock candidate rows, claim them via a lease, render
  // messages, mark skips. No provider/network call happens here, so the
  // transaction never waits on an external request and cannot be held open by
  // a slow provider. The lease prevents another worker from reselecting the
  // same rows while this worker is delivering outside the transaction.
  const plans = await withConnectedTransaction(async (client) => {
    const rows = await client.query<NotificationDeliveryRow>(`
      SELECT notification.*, request.normalized_email AS recipient_email,
             (membership.operator_id IS NOT NULL) AS recipient_active
      FROM app.subscription_notifications AS notification
      LEFT JOIN app.operator_memberships AS membership
        ON membership.operator_id = notification.recipient_operator_id
       AND membership.merchant_id = notification.merchant_id
       AND membership.scope_type = 'merchant'
       AND membership.role_key = 'owner'
       AND membership.status = 'active'
       AND membership.valid_from <= $2::timestamptz
       AND (membership.valid_to IS NULL OR membership.valid_to > $2::timestamptz)
      LEFT JOIN app.signup_requests AS request
        ON request.owner_merchant_id = notification.merchant_id
       AND request.status = 'provisioned'
      WHERE notification.delivery_status IN ('pending', 'failed', 'deferred')
        AND (notification.next_retry_at IS NULL OR notification.next_retry_at <= $2::timestamptz)
        AND notification.recipient_operator_id IS NOT NULL
        AND (notification.lease_expires_at IS NULL OR notification.lease_expires_at < $2::timestamptz)
      ORDER BY notification.created_at ASC, notification.id ASC
      LIMIT $1
      FOR UPDATE OF notification SKIP LOCKED
    `, [input.limit ?? 100, now.toISOString()]);

    if (rows.rows.length > 0) {
      // Claim the locked rows with this worker's lease while the row locks are
      // still held. Another worker running concurrently will now see these rows
      // as leased and skip them.
      await client.query(`
        UPDATE app.subscription_notifications
        SET claimed_by = $2,
            lease_token = $3,
            lease_expires_at = $4::timestamptz
        WHERE id = ANY($1::uuid[])
      `, [rows.rows.map((row) => row.id), effectiveWorkerId, leaseToken, leaseExpiresAt.toISOString()]);
    }

    const collected: DeliveryPlan[] = [];
    for (const row of rows.rows) {
      const message = renderLifecycleMessage(row);
      let skipStatus: DeliveryPlan["skipStatus"] = null;
      if (!row.recipient_active) {
        skipStatus = "skipped_no_recipient";
      } else if (!message.to) {
        skipStatus = "skipped_no_contact_email";
      }
      collected.push({ row, message, skipStatus });
    }
    return collected;
  });

  let sent = 0;
  let failed = 0;
  let deferred = 0;

  // 2. Deliver outside any DB transaction. The provider call may be slow or
  // fail; holding a transaction open across it would extend row locks and
  // couple delivery latency to database connection lifetime.
  const outcomes: Array<{ plan: DeliveryPlan; status: DeliveryResult["status"]; result: DeliveryResult }> = [];
  for (const plan of plans) {
    if (plan.skipStatus) {
      outcomes.push({ plan, status: plan.skipStatus as DeliveryResult["status"], result: { provider: provider.provider, status: plan.skipStatus as DeliveryResult["status"] } });
      continue;
    }
    const result = await provider.send(plan.message);
    outcomes.push({ plan, status: result.status, result });
  }

  // 3. Short transaction: persist the delivery outcome and audit evidence.
  // Each UPDATE asserts that this worker still owns the lease; if the lease
  // was stolen or expired (0 rows updated) the outcome is discarded so the row
  // becomes eligible for another worker to retry. The lease is released
  // (lease_token, claimed_by, lease_expires_at cleared) once the outcome is
  // recorded so the row is dispatchable again on the next attempt interval.
  await withConnectedTransaction(async (client) => {
    for (const outcome of outcomes) {
      const { row, message } = outcome.plan;
      if (outcome.plan.skipStatus) {
        const skipped = await client.query(`
          UPDATE app.subscription_notifications
          SET delivery_status = $2,
              updated_at = now(),
              lease_token = NULL,
              claimed_by = NULL,
              lease_expires_at = NULL
          WHERE id = $1 AND lease_token = $3
        `, [row.id, outcome.plan.skipStatus, leaseToken]);
        if (skipped.rowCount === 0) continue;
        continue;
      }
      const status = outcome.status;
      const retryDelay = status === "failed" ? "5 minutes" : "1 minute";
      const delivered = await client.query(`
        UPDATE app.subscription_notifications
        SET delivery_status = $2,
            provider = $3,
            provider_message_id = $4,
            attempt_count = attempt_count + 1,
            last_error = $5,
            next_retry_at = CASE WHEN $2 = 'sent' THEN NULL ELSE $7::timestamptz + $8::interval END,
            sent_at = CASE WHEN $2 = 'sent' THEN $7::timestamptz ELSE sent_at END,
            updated_at = $7::timestamptz,
            lease_token = NULL,
            claimed_by = NULL,
            lease_expires_at = NULL
        WHERE id = $1 AND lease_token = $6
      `, [row.id, status, outcome.result.provider, outcome.result.messageId ?? null, (outcome.result.errorMessage ?? "").slice(0, 500) || null, leaseToken, now.toISOString(), retryDelay]);
      if (delivered.rowCount === 0) continue;
      await recordAuditEntry(client, { operatorId: "subscription_notification_worker", role: "system", serviceIdentity: "subscription_notification_worker" }, "subscription.notification.delivery_recorded", "subscription_notification", row.id, {
        merchantId: row.merchant_id,
        after: {
          sourceEventId: row.source_event_id,
          subscriptionId: row.subscription_id,
          notificationType: row.notification_type,
          templateKey: row.template_key,
          templateVersion: row.template_version,
          recipientOperatorId: row.recipient_operator_id,
          recipientEmailHash: hashEmail(message.to),
          deliveryStatus: status,
        },
      });
      if (status === "sent") sent += 1;
      else if (status === "failed") failed += 1;
      else deferred += 1;
    }
  });

  return { sent, failed, deferred };
}

export async function runSubscriptionLifecycleNotificationPipeline(
  provider: TransactionalEmailProvider,
  input: { limit?: number; now?: Date } = {},
  workerId?: string,
): Promise<{ queued: number; skipped: number; sent: number; failed: number; deferred: number }> {
  const queued = await queueSubscriptionLifecycleNotifications(input);
  const delivered = await deliverSubscriptionLifecycleNotifications(provider, input, workerId);
  return { ...queued, ...delivered };
}
