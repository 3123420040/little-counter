import type { MerchantSubscriptionStatus, PackageKey, SubscriptionStatus } from "@medusa-snus/contracts";
import { subscriptionPolicySnapshot } from "@medusa-snus/contracts";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { id } from "../utils/id";
import { findCatalogVersionIdByPackageKey } from "./package-catalog-service";

export type SubscriptionEventType =
  | "subscription.activated"
  | "subscription.renewed"
  | "subscription.upgraded"
  | "subscription.renewal_reminder"
  | "subscription.entered_grace"
  | "subscription.grace_ending"
  | "subscription.expired"
  | "subscription.reactivated";

export interface SubscriptionRow {
  [key: string]: unknown;
  id: string;
  merchant_id: string;
  package_key: PackageKey;
  catalog_version_id: string;
  status: SubscriptionStatus;
  current_period_start: Date | string;
  current_period_end: Date | string;
  grace_ends_at: Date | string | null;
  primary_store_id: string;
  usage_anchor_day: number;
  policy_version: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REMINDER_OFFSETS = [30, 14, 7, 1] as const;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function utcDate(year: number, monthIndex: number, day: number, hours = 0, minutes = 0, seconds = 0, ms = 0): Date {
  return new Date(Date.UTC(year, monthIndex, day, hours, minutes, seconds, ms));
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function clampUtcDay(year: number, monthIndex: number, anchorDay: number): number {
  return Math.min(anchorDay, daysInUtcMonth(year, monthIndex));
}

export function addCalendarYearsClamped(start: Date, years: number): Date {
  const targetYear = start.getUTCFullYear() + years;
  const month = start.getUTCMonth();
  const day = clampUtcDay(targetYear, month, start.getUTCDate());
  return utcDate(
    targetYear,
    month,
    day,
    start.getUTCHours(),
    start.getUTCMinutes(),
    start.getUTCSeconds(),
    start.getUTCMilliseconds(),
  );
}

export function addCalendarDays(start: Date, days: number): Date {
  return utcDate(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate() + days,
    start.getUTCHours(),
    start.getUTCMinutes(),
    start.getUTCSeconds(),
    start.getUTCMilliseconds(),
  );
}

export function statusForClock(periodEnd: Date, graceEndsAt: Date | null, now: Date): SubscriptionStatus {
  if (now.getTime() < periodEnd.getTime()) return "active";
  if (graceEndsAt && now.getTime() < graceEndsAt.getTime()) return "grace";
  return "expired";
}

function graceEndsAt(periodEnd: Date): Date {
  return addCalendarDays(periodEnd, subscriptionPolicySnapshot.graceDays);
}

function rowToStatus(row: SubscriptionRow, now = new Date()): MerchantSubscriptionStatus {
  const periodEnd = new Date(row.current_period_end);
  const grace = row.grace_ends_at ? new Date(row.grace_ends_at) : graceEndsAt(periodEnd);
  return {
    subscriptionId: row.id,
    merchantId: row.merchant_id,
    packageKey: row.package_key,
    catalogVersionId: row.catalog_version_id,
    status: statusForClock(periodEnd, grace, now),
    currentPeriodStart: iso(row.current_period_start),
    currentPeriodEnd: periodEnd.toISOString(),
    graceEndsAt: grace.toISOString(),
    primaryStoreId: row.primary_store_id,
    policySnapshot: subscriptionPolicySnapshot,
  };
}

async function getPrimaryStoreId(client: PoolClient, merchantId: string): Promise<string> {
  const store = await queryOne<{ id: string }>(client, `
    SELECT id FROM app.stores
    WHERE merchant_id = $1 AND is_primary = true AND status = 'active'
    ORDER BY created_at ASC
    LIMIT 1
  `, [merchantId]);
  if (!store) throw new PlatformError("subscription_primary_store_missing", "Merchant primary store is required", 409, { merchantId });
  return store.id;
}

export async function getMerchantIdForLegacyOrganization(
  organizationId = "org_default",
  options?: { client?: PoolClient },
): Promise<string> {
  const run = async (client: PoolClient) => {
    const merchant = await queryOne<{ id: string }>(client, `
      SELECT id FROM app.merchants WHERE legacy_organization_id = $1 LIMIT 1
    `, [organizationId]);
    return merchant?.id || "merchant_default";
  };
  if (options?.client) return run(options.client);
  await ensurePlatformSchema();
  return withConnectedClient(run);
}

async function fetchSubscriptionRow(client: PoolClient, merchantId: string): Promise<SubscriptionRow | null> {
  return queryOne<SubscriptionRow>(client, `
    SELECT id, merchant_id, package_key, catalog_version_id, status,
           current_period_start, current_period_end, grace_ends_at,
           primary_store_id, usage_anchor_day, policy_version
    FROM app.merchant_subscriptions
    WHERE merchant_id = $1
    LIMIT 1
  `, [merchantId]);
}

async function updateDerivedStatus(client: PoolClient, row: SubscriptionRow, now: Date): Promise<SubscriptionRow> {
  const derived = rowToStatus(row, now);
  if (derived.status === row.status && row.grace_ends_at) return row;
  const updated = await queryOne<SubscriptionRow>(client, `
    UPDATE app.merchant_subscriptions
    SET status = $2,
        grace_ends_at = COALESCE(grace_ends_at, $3::timestamptz),
        updated_at = now()
    WHERE id = $1
    RETURNING id, merchant_id, package_key, catalog_version_id, status,
              current_period_start, current_period_end, grace_ends_at,
              primary_store_id, usage_anchor_day, policy_version
  `, [row.id, derived.status, derived.graceEndsAt]);
  return updated || row;
}

export async function getMerchantSubscriptionStatus(
  merchantId: string,
  options?: { client?: PoolClient; now?: Date },
): Promise<MerchantSubscriptionStatus> {
  const run = async (client: PoolClient) => {
    let row = await fetchSubscriptionRow(client, merchantId);
    if (!row) row = await createBasicSubscriptionForMerchant(client, merchantId, options?.now || new Date());
    row = await updateDerivedStatus(client, row, options?.now || new Date());
    return rowToStatus(row, options?.now || new Date());
  };
  if (options?.client) return run(options.client);
  await ensurePlatformSchema();
  return withConnectedClient(run);
}

async function createBasicSubscriptionForMerchant(client: PoolClient, merchantId: string, now: Date): Promise<SubscriptionRow> {
  const primaryStoreId = await getPrimaryStoreId(client, merchantId);
  const catalogVersionId = await findCatalogVersionIdByPackageKey("basic", { client });
  const periodStart = new Date(now);
  const periodEnd = addCalendarYearsClamped(periodStart, 1);
  const row = await queryOne<SubscriptionRow>(client, `
    INSERT INTO app.merchant_subscriptions (
      id, merchant_id, package_key, catalog_version_id, status,
      current_period_start, current_period_end, grace_ends_at,
      primary_store_id, usage_anchor_day, metadata
    ) VALUES ($1, $2, 'basic', $3, 'active', $4, $5, $6, $7, $8, jsonb_build_object('source', 'service_basic_fallback'))
    ON CONFLICT (merchant_id) DO UPDATE SET updated_at = app.merchant_subscriptions.updated_at
    RETURNING id, merchant_id, package_key, catalog_version_id, status,
              current_period_start, current_period_end, grace_ends_at,
              primary_store_id, usage_anchor_day, policy_version
  `, [id("sub"), merchantId, catalogVersionId, periodStart.toISOString(), periodEnd.toISOString(), graceEndsAt(periodEnd).toISOString(), primaryStoreId, periodStart.getUTCDate()]);
  if (!row) throw new PlatformError("subscription_create_failed", "Could not create subscription", 500, { merchantId });
  await appendSubscriptionEvent(client, merchantId, row.id, "subscription.activated", periodEnd, null, { packageKey: "basic" });
  return row;
}

export async function applySubscriptionPurchase(input: {
  merchantId: string;
  packageKey: PackageKey;
  effectiveAt?: Date;
  primaryStoreId?: string;
  eventType?: Extract<SubscriptionEventType, "subscription.activated" | "subscription.renewed" | "subscription.upgraded" | "subscription.reactivated">;
}): Promise<{ data: MerchantSubscriptionStatus }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const now = input.effectiveAt || new Date();
    const catalogVersionId = await findCatalogVersionIdByPackageKey(input.packageKey, { client });
    const existing = await fetchSubscriptionRow(client, input.merchantId);
    const primaryStoreId = input.primaryStoreId || existing?.primary_store_id || await getPrimaryStoreId(client, input.merchantId);
    const currentPeriodStart = now;
    const currentPeriodEnd = addCalendarYearsClamped(currentPeriodStart, 1);
    const eventType = input.eventType || (existing ? "subscription.renewed" : "subscription.activated");
    const row = await queryOne<SubscriptionRow>(client, `
      INSERT INTO app.merchant_subscriptions (
        id, merchant_id, package_key, catalog_version_id, status,
        current_period_start, current_period_end, grace_ends_at,
        primary_store_id, usage_anchor_day, metadata
      ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, jsonb_build_object('source', 'paid_purchase'))
      ON CONFLICT (merchant_id) DO UPDATE SET
        package_key = EXCLUDED.package_key,
        catalog_version_id = EXCLUDED.catalog_version_id,
        status = 'active',
        current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end,
        grace_ends_at = EXCLUDED.grace_ends_at,
        primary_store_id = EXCLUDED.primary_store_id,
        usage_anchor_day = EXCLUDED.usage_anchor_day,
        updated_at = now(),
        metadata = app.merchant_subscriptions.metadata || EXCLUDED.metadata
      RETURNING id, merchant_id, package_key, catalog_version_id, status,
                current_period_start, current_period_end, grace_ends_at,
                primary_store_id, usage_anchor_day, policy_version
    `, [
      existing?.id || id("sub"),
      input.merchantId,
      input.packageKey,
      catalogVersionId,
      currentPeriodStart.toISOString(),
      currentPeriodEnd.toISOString(),
      graceEndsAt(currentPeriodEnd).toISOString(),
      primaryStoreId,
      currentPeriodStart.getUTCDate(),
    ]);
    if (!row) throw new PlatformError("subscription_apply_failed", "Could not apply subscription", 500, { merchantId: input.merchantId });
    await appendSubscriptionEvent(client, input.merchantId, row.id, eventType, currentPeriodEnd, null, { packageKey: input.packageKey });
    return { data: rowToStatus(row, now) };
  });
}

export async function appendSubscriptionEvent(
  client: PoolClient,
  merchantId: string,
  subscriptionId: string,
  eventType: SubscriptionEventType,
  periodEnd: Date,
  reminderOffsetDays: number | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(`
    INSERT INTO app.subscription_events
      (merchant_id, subscription_id, event_type, reminder_offset_days, period_end, payload)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    ON CONFLICT DO NOTHING
  `, [merchantId, subscriptionId, eventType, reminderOffsetDays, periodEnd.toISOString(), JSON.stringify(payload)]);
}

export async function runSubscriptionLifecycleScheduler(input: { now?: Date } = {}): Promise<{
  data: { emitted: number; reminders: number; enteredGrace: number; graceEnding: number; expired: number };
}> {
  const now = input.now || new Date();
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const result = await client.query<SubscriptionRow>(`
      SELECT id, merchant_id, package_key, catalog_version_id, status,
             current_period_start, current_period_end, grace_ends_at,
             primary_store_id, usage_anchor_day, policy_version
      FROM app.merchant_subscriptions
      WHERE status IN ('active', 'grace') OR current_period_end <= $1::timestamptz + INTERVAL '30 days'
      FOR UPDATE
    `, [now.toISOString()]);
    let reminders = 0;
    let enteredGrace = 0;
    let graceEnding = 0;
    let expired = 0;

    for (const row of result.rows) {
      const periodEnd = new Date(row.current_period_end);
      const grace = row.grace_ends_at ? new Date(row.grace_ends_at) : graceEndsAt(periodEnd);
      const previous = row.status;
      const next = statusForClock(periodEnd, grace, now);
      if (next !== previous || !row.grace_ends_at) {
        await client.query(`UPDATE app.merchant_subscriptions SET status = $2, grace_ends_at = COALESCE(grace_ends_at, $3::timestamptz), updated_at = now() WHERE id = $1`, [row.id, next, grace.toISOString()]);
      }
      if (next === "grace" && previous !== "grace") {
        await appendSubscriptionEvent(client, row.merchant_id, row.id, "subscription.entered_grace", periodEnd, null, { packageKey: row.package_key });
        enteredGrace += 1;
      }
      if (next === "expired" && previous !== "expired") {
        await appendSubscriptionEvent(client, row.merchant_id, row.id, "subscription.expired", periodEnd, null, { packageKey: row.package_key, fallbackPackageKey: "basic", primaryStoreId: row.primary_store_id });
        expired += 1;
      }
      const graceEndingAt = addCalendarDays(grace, -1);
      if (next === "grace" && now.getTime() >= graceEndingAt.getTime()) {
        await appendSubscriptionEvent(client, row.merchant_id, row.id, "subscription.grace_ending", periodEnd, null, {
          packageKey: row.package_key,
          graceEndsAt: grace.toISOString(),
        });
        graceEnding += 1;
      }
      for (const offset of REMINDER_OFFSETS) {
        const sendAt = new Date(periodEnd.getTime() - offset * MS_PER_DAY);
        if (now.getTime() >= sendAt.getTime() && now.getTime() < periodEnd.getTime()) {
          await appendSubscriptionEvent(client, row.merchant_id, row.id, "subscription.renewal_reminder", periodEnd, offset, { packageKey: row.package_key, daysBeforeRenewal: offset });
          reminders += 1;
        }
      }
    }

    return { data: { emitted: reminders + enteredGrace + graceEnding + expired, reminders, enteredGrace, graceEnding, expired } };
  });
}

export function renewalReminderOffsets(): readonly number[] {
  return REMINDER_OFFSETS;
}
