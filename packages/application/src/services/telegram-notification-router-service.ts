import type { PoolClient } from "../db/client";
import { enqueueTelegramNotificationForClient } from "./telegram-notification-service";

export interface TelegramNotificationRouteEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
}

interface RuleRow {
  rule_id: string;
  recipient_id: string;
  organization_id: string;
  merchant_id: string;
  store_id: string | null;
  telegram_user_id: string;
  telegram_chat_id: string | null;
  channel_filter: string;
  template_profile: string;
  event_scope: string;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function eventMerchantId(payload: Record<string, unknown>): string {
  return textValue(payload.merchantId || payload.merchant_id);
}

function eventStoreId(payload: Record<string, unknown>): string | null {
  return textValue(payload.storeId || payload.store_id) || null;
}

function eventChannel(eventType: string, payload: Record<string, unknown>): string {
  const explicit = textValue(payload.channel || payload.salesChannel || payload.sales_channel || payload.source);
  if (explicit) return explicit.toLowerCase();
  return eventType.startsWith("telegram_sales") ? "telegram" : "all";
}

function channelMatches(ruleChannel: string, channel: string): boolean {
  const normalizedRule = (ruleChannel || "all").toLowerCase();
  if (normalizedRule === "all") return true;
  if (normalizedRule === "telegram") return channel === "telegram";
  return normalizedRule === channel;
}

function templateForEvent(eventType: string): string {
  if (eventType === "telegram_sales_request_created") return "telegram_sales_request_created";
  if (eventType === "sale.created") return "order_created";
  if (eventType === "sale.cancelled") return "order_cancelled";
  if (eventType === "refund.created") return "refund_created";
  if (eventType === "order.shipping_adjusted") return "order_shipping_adjusted";
  if (eventType === "order.corrected") return "order_corrected";
  return eventType.replace(/\./g, "_");
}

function payloadForTemplate(event: TelegramNotificationRouteEvent, channel: string): Record<string, unknown> {
  const payload = event.payload || {};
  if (event.eventType === "telegram_sales_request_created") {
    const telegramUsername = textValue(payload.telegramUsername || payload.telegram_username);
    const telegramUserId = textValue(payload.telegramUserId || payload.telegram_user_id);
    const telegramUrl = telegramUsername
      ? `https://t.me/${telegramUsername.replace(/^@/, "")}`
      : telegramUserId ? `tg://user?id=${telegramUserId}` : undefined;
    return {
      ...payload,
      channel,
      customer: telegramUsername ? `@${telegramUsername.replace(/^@/, "")}` : telegramUserId,
      telegramUrl,
      portalPath: payload.portalPath || "/telegram-sales",
      actionLabel: payload.actionLabel || "Thanh toán",
    };
  }
  if (event.eventType === "sale.created") {
    return {
      ...payload,
      channel,
      portalPath: payload.portalPath || "/orders",
    };
  }
  return {
    ...payload,
    channel,
  };
}

export async function routeTelegramNotificationEvent(
  client: PoolClient,
  event: TelegramNotificationRouteEvent,
): Promise<{ matched: number; enqueued: number }> {
  const payload = event.payload || {};
  const merchantId = eventMerchantId(payload);
  if (!merchantId || !event.id || !event.eventType) return { matched: 0, enqueued: 0 };

  const storeId = eventStoreId(payload);
  const channel = eventChannel(event.eventType, payload);
  const rules = await client.query<RuleRow>(`
    SELECT
      rule.id::text AS rule_id,
      recipient.id::text AS recipient_id,
      merchant.legacy_organization_id AS organization_id,
      rule.merchant_id,
      rule.store_id,
      recipient.telegram_user_id,
      recipient.telegram_chat_id,
      rule.channel_filter,
      rule.template_profile,
      rule.event_scope
    FROM notification.telegram_notification_rules rule
    JOIN app.merchants merchant
      ON merchant.id = rule.merchant_id
     AND merchant.status = 'active'
    JOIN notification.telegram_recipients recipient
      ON recipient.id = rule.recipient_id
     AND recipient.status = 'active'
     AND recipient.merchant_id = rule.merchant_id
     AND (recipient.store_id IS NULL OR recipient.store_id = $2::text)
    WHERE rule.merchant_id = $1
      AND rule.enabled = true
      AND (rule.store_id IS NULL OR rule.store_id = $2::text)
      AND ($3 = ANY(rule.event_types) OR cardinality(rule.event_types) = 0)
    ORDER BY rule.created_at ASC, rule.id ASC
  `, [merchantId, storeId, event.eventType]);

  let matched = 0;
  let enqueued = 0;
  const template = templateForEvent(event.eventType);
  const notificationPayload = payloadForTemplate(event, channel);
  for (const rule of rules.rows) {
    const ruleChannel = textValue(rule.channel_filter) || "all";
    if (!channelMatches(ruleChannel, channel)) continue;
    matched += 1;
    await enqueueTelegramNotificationForClient(client, event.id, {
      organizationId: rule.organization_id,
      merchantId,
      storeId,
      recipientId: rule.recipient_id,
      ruleId: rule.rule_id,
      telegramChatId: rule.telegram_chat_id || rule.telegram_user_id,
      template,
      payload: notificationPayload,
      dedupeKey: `${event.id}:${rule.recipient_id}`,
    });
    enqueued += 1;
  }

  return { matched, enqueued };
}
