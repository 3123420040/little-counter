import type { UsageMetricBucket, UsageMetricKey } from "@medusa-snus/contracts";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { getCatalogVersionSnapshot } from "./package-catalog-service";
import { getMerchantSubscriptionStatus, clampUtcDay } from "./subscription-service";

interface UsageBucketRow {
  [key: string]: unknown;
  id: string;
  merchant_id: string;
  subscription_id: string;
  metric_key: UsageMetricKey;
  window_start: Date | string;
  window_end: Date | string;
  included_quantity: string | number | null;
  used_quantity: string | number;
  reserved_quantity: string | number;
}

interface ReservationRow {
  [key: string]: unknown;
  id: string;
  reservation_token: string;
  bucket_id: string;
  merchant_id: string;
  metric_key: UsageMetricKey;
  quantity: string | number;
  status: "reserved" | "committed" | "released";
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function utcDate(year: number, monthIndex: number, day: number, hours = 0, minutes = 0, seconds = 0, ms = 0): Date {
  return new Date(Date.UTC(year, monthIndex, day, hours, minutes, seconds, ms));
}

function addUtcMonthsClamped(start: Date, months: number, anchorDay: number): Date {
  const baseMonth = start.getUTCMonth() + months;
  const year = start.getUTCFullYear() + Math.floor(baseMonth / 12);
  const month = ((baseMonth % 12) + 12) % 12;
  const day = clampUtcDay(year, month, anchorDay);
  return utcDate(year, month, day, start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds());
}

export function usageWindowForAnchor(currentPeriodStartIso: string, anchorDay: number, now: Date): { start: Date; end: Date } {
  const periodStart = new Date(currentPeriodStartIso);
  let windowStart = utcDate(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    clampUtcDay(now.getUTCFullYear(), now.getUTCMonth(), anchorDay),
    periodStart.getUTCHours(),
    periodStart.getUTCMinutes(),
    periodStart.getUTCSeconds(),
    periodStart.getUTCMilliseconds(),
  );

  if (now.getTime() < windowStart.getTime()) {
    windowStart = addUtcMonthsClamped(windowStart, -1, anchorDay);
  }
  const windowEnd = addUtcMonthsClamped(windowStart, 1, anchorDay);
  return { start: windowStart, end: windowEnd };
}

function includedQuantityForMetric(metricKey: UsageMetricKey, snapshot: Awaited<ReturnType<typeof getCatalogVersionSnapshot>>): number | null {
  if (metricKey === "product_research_runs") return snapshot.researchRunsPerMonth;
  if (metricKey === "telegram_ai_drafts") return snapshot.telegramAiDraftsPerMonth;
  return null;
}

function rowToBucket(row: UsageBucketRow): UsageMetricBucket {
  return {
    merchantId: row.merchant_id,
    metricKey: row.metric_key,
    windowStart: iso(row.window_start),
    windowEnd: iso(row.window_end),
    includedQuantity: toNumber(row.included_quantity) ?? 0,
    usedQuantity: toNumber(row.used_quantity) ?? 0,
    reservedQuantity: toNumber(row.reserved_quantity) ?? 0,
  };
}

async function fetchBucket(client: PoolClient, merchantId: string, metricKey: UsageMetricKey, windowStart: Date): Promise<UsageBucketRow | null> {
  return queryOne<UsageBucketRow>(client, `
    SELECT id, merchant_id, subscription_id, metric_key, window_start, window_end,
           included_quantity, used_quantity, reserved_quantity
    FROM app.subscription_usage_buckets
    WHERE merchant_id = $1 AND metric_key = $2 AND window_start = $3::timestamptz
    LIMIT 1
  `, [merchantId, metricKey, windowStart.toISOString()]);
}

export async function getOrCreateUsageBucket(
  merchantId: string,
  metricKey: UsageMetricKey,
  options?: { client?: PoolClient; now?: Date },
): Promise<UsageMetricBucket> {
  const now = options?.now || new Date();
  const run = async (client: PoolClient) => {
    const subscription = await getMerchantSubscriptionStatus(merchantId, { client, now });
    const { start, end } = usageWindowForAnchor(subscription.currentPeriodStart, new Date(subscription.currentPeriodStart).getUTCDate(), now);
    let row = await fetchBucket(client, merchantId, metricKey, start);
    if (!row) {
      const snapshot = await getCatalogVersionSnapshot(subscription.catalogVersionId, { client });
      const includedQuantity = includedQuantityForMetric(metricKey, snapshot);
      row = await queryOne<UsageBucketRow>(client, `
        INSERT INTO app.subscription_usage_buckets (
          merchant_id, subscription_id, metric_key, window_start, window_end,
          included_quantity, used_quantity, reserved_quantity, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, 0, 0, '{}'::jsonb)
        ON CONFLICT (merchant_id, metric_key, window_start) DO UPDATE SET updated_at = now()
        RETURNING id, merchant_id, subscription_id, metric_key, window_start, window_end,
                  included_quantity, used_quantity, reserved_quantity
      `, [merchantId, subscription.subscriptionId, metricKey, start.toISOString(), end.toISOString(), includedQuantity]);
    }
    if (!row) throw new PlatformError("usage_bucket_unavailable", "Could not resolve usage bucket", 500, { merchantId, metricKey });
    return rowToBucket(row);
  };

  if (options?.client) return run(options.client);
  await ensurePlatformSchema();
  return withConnectedClient(run);
}

export async function reserveUsage(input: {
  merchantId: string;
  metricKey: UsageMetricKey;
  reservationToken: string;
  quantity?: number;
  referenceType?: string;
  referenceId?: string;
  now?: Date;
}): Promise<{ data: UsageMetricBucket & { reservationToken: string } }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const existing = await queryOne<ReservationRow>(client, `
      SELECT id, reservation_token, bucket_id, merchant_id, metric_key, quantity, status
      FROM app.subscription_usage_reservations
      WHERE reservation_token = $1
      LIMIT 1
    `, [input.reservationToken]);
    const quantity = Math.max(1, input.quantity || 1);

    if (existing) {
      const bucket = await queryOne<UsageBucketRow>(client, `
        SELECT id, merchant_id, subscription_id, metric_key, window_start, window_end,
               included_quantity, used_quantity, reserved_quantity
        FROM app.subscription_usage_buckets
        WHERE id = $1
        LIMIT 1
      `, [existing.bucket_id]);
      if (!bucket) throw new PlatformError("usage_bucket_missing", "Reservation bucket is missing", 409, { reservationToken: input.reservationToken });
      return { data: { ...rowToBucket(bucket), reservationToken: existing.reservation_token } };
    }

    const bucket = await getOrCreateUsageBucket(input.merchantId, input.metricKey, { client, now: input.now });
    const bucketRow = await fetchBucket(client, input.merchantId, input.metricKey, new Date(bucket.windowStart));
    if (!bucketRow) throw new PlatformError("usage_bucket_missing", "Usage bucket not found after create", 500, { merchantId: input.merchantId, metricKey: input.metricKey });

    const included = toNumber(bucketRow.included_quantity);
    const used = toNumber(bucketRow.used_quantity) ?? 0;
    const reserved = toNumber(bucketRow.reserved_quantity) ?? 0;
    if (included !== null && used + reserved + quantity > included) {
      throw new PlatformError("quota_exceeded", `Quota exceeded for ${input.metricKey}`, 403, {
        metricKey: input.metricKey,
        includedQuantity: included,
        usedQuantity: used,
        reservedQuantity: reserved,
        requestedQuantity: quantity,
      });
    }

    await client.query(`
      UPDATE app.subscription_usage_buckets
      SET reserved_quantity = reserved_quantity + $2,
          updated_at = now()
      WHERE id = $1
    `, [bucketRow.id, quantity]);

    await client.query(`
      INSERT INTO app.subscription_usage_reservations (
        reservation_token, bucket_id, merchant_id, metric_key, quantity, status, reference_type, reference_id
      ) VALUES ($1, $2, $3, $4, $5, 'reserved', $6, $7)
    `, [input.reservationToken, bucketRow.id, input.merchantId, input.metricKey, quantity, input.referenceType || null, input.referenceId || null]);

    const updated = await queryOne<UsageBucketRow>(client, `
      SELECT id, merchant_id, subscription_id, metric_key, window_start, window_end,
             included_quantity, used_quantity, reserved_quantity
      FROM app.subscription_usage_buckets
      WHERE id = $1
      LIMIT 1
    `, [bucketRow.id]);
    if (!updated) throw new PlatformError("usage_bucket_missing", "Usage bucket missing after reservation", 500, { merchantId: input.merchantId, metricKey: input.metricKey });

    return { data: { ...rowToBucket(updated), reservationToken: input.reservationToken } };
  });
}

async function resolveReservation(client: PoolClient, reservationToken: string): Promise<{ reservation: ReservationRow; bucket: UsageBucketRow }> {
  const reservation = await queryOne<ReservationRow>(client, `
    SELECT id, reservation_token, bucket_id, merchant_id, metric_key, quantity, status
    FROM app.subscription_usage_reservations
    WHERE reservation_token = $1
    LIMIT 1
  `, [reservationToken]);
  if (!reservation) throw new PlatformError("usage_reservation_not_found", "Usage reservation not found", 404, { reservationToken });
  const bucket = await queryOne<UsageBucketRow>(client, `
    SELECT id, merchant_id, subscription_id, metric_key, window_start, window_end,
           included_quantity, used_quantity, reserved_quantity
    FROM app.subscription_usage_buckets
    WHERE id = $1
    LIMIT 1
  `, [reservation.bucket_id]);
  if (!bucket) throw new PlatformError("usage_bucket_missing", "Usage bucket missing for reservation", 409, { reservationToken });
  return { reservation, bucket };
}

export async function commitUsage(reservationToken: string): Promise<{ data: UsageMetricBucket & { reservationToken: string; status: string } }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const { reservation, bucket } = await resolveReservation(client, reservationToken);
    if (reservation.status === "committed") {
      return { data: { ...rowToBucket(bucket), reservationToken, status: reservation.status } };
    }
    if (reservation.status === "released") {
      throw new PlatformError("usage_reservation_released", "Released reservation cannot be committed", 409, { reservationToken });
    }
    await client.query(`
      UPDATE app.subscription_usage_buckets
      SET reserved_quantity = GREATEST(0, reserved_quantity - $2),
          used_quantity = used_quantity + $2,
          updated_at = now()
      WHERE id = $1
    `, [bucket.id, reservation.quantity]);
    await client.query(`
      UPDATE app.subscription_usage_reservations
      SET status = 'committed', resolved_at = now()
      WHERE id = $1
    `, [reservation.id]);
    const updated = await queryOne<UsageBucketRow>(client, `
      SELECT id, merchant_id, subscription_id, metric_key, window_start, window_end,
             included_quantity, used_quantity, reserved_quantity
      FROM app.subscription_usage_buckets WHERE id = $1 LIMIT 1
    `, [bucket.id]);
    if (!updated) throw new PlatformError("usage_bucket_missing", "Usage bucket missing after commit", 500, { reservationToken });
    return { data: { ...rowToBucket(updated), reservationToken, status: "committed" } };
  });
}

export async function releaseUsage(reservationToken: string): Promise<{ data: UsageMetricBucket & { reservationToken: string; status: string } }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const { reservation, bucket } = await resolveReservation(client, reservationToken);
    if (reservation.status === "released") {
      return { data: { ...rowToBucket(bucket), reservationToken, status: reservation.status } };
    }
    if (reservation.status === "committed") {
      throw new PlatformError("usage_reservation_committed", "Committed reservation cannot be released", 409, { reservationToken });
    }
    await client.query(`
      UPDATE app.subscription_usage_buckets
      SET reserved_quantity = GREATEST(0, reserved_quantity - $2),
          updated_at = now()
      WHERE id = $1
    `, [bucket.id, reservation.quantity]);
    await client.query(`
      UPDATE app.subscription_usage_reservations
      SET status = 'released', resolved_at = now()
      WHERE id = $1
    `, [reservation.id]);
    const updated = await queryOne<UsageBucketRow>(client, `
      SELECT id, merchant_id, subscription_id, metric_key, window_start, window_end,
             included_quantity, used_quantity, reserved_quantity
      FROM app.subscription_usage_buckets WHERE id = $1 LIMIT 1
    `, [bucket.id]);
    if (!updated) throw new PlatformError("usage_bucket_missing", "Usage bucket missing after release", 500, { reservationToken });
    return { data: { ...rowToBucket(updated), reservationToken, status: "released" } };
  });
}
