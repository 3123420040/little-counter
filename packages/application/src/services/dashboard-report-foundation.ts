import {
  DASHBOARD_METRIC_TIME_BASIS_V2,
  DASHBOARD_REPORT_MAX_LOCAL_DAYS,
  DASHBOARD_SYSTEM_DEFAULT_TIME_ZONE,
  DashboardReportContextV1Schema,
  ReportScopeSchema,
  type DashboardMetricTimeBasisV2,
  type DashboardReportContextV1,
  type DashboardStoreTimeWindowV1,
  type ReportScope,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";

export { DASHBOARD_REPORT_MAX_LOCAL_DAYS };

export const DASHBOARD_SNAPSHOT_TIMEOUT_HARD_CAP_MS = 30_000;

export interface DashboardLocalDateRangeInput {
  date?: string;
  from?: string;
  to?: string;
}

export interface NormalizedDashboardLocalDateRange {
  from: string;
  to: string;
  inclusiveDays: number;
}

export type DashboardStoreStatusPolicy = "active" | "active_or_suspended";

export interface DashboardSnapshotRequest {
  scope: ReportScope;
  range: DashboardLocalDateRangeInput;
  statementTimeoutMs: number;
  storeStatusPolicy?: DashboardStoreStatusPolicy;
}

export interface DashboardSnapshotReadContext {
  normalizedScope: ReportScope;
  localDateRange: NormalizedDashboardLocalDateRange;
  storeTimeWindows: DashboardStoreTimeWindowV1[];
  reportAsOf: string;
  metricTimeBasis: DashboardMetricTimeBasisV2;
}

export interface DashboardSnapshotResult<T> {
  context: DashboardReportContextV1;
  data: T;
}

type StoreWindowRow = {
  requested_store_id: unknown;
  owned_store_id: unknown;
  time_zone: unknown;
  start_inclusive: unknown;
  end_exclusive: unknown;
};

const ISO_LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1_000;

function rangeError(code: string, message: string, details?: Record<string, unknown>): PlatformError {
  return new PlatformError(code, message, 400, details);
}

function parseLocalDate(value: unknown, field: "date" | "from" | "to"): number {
  if (typeof value !== "string") {
    throw rangeError("dashboard_range_invalid", `${field} must be an ISO local date`, { field });
  }
  const match = ISO_LOCAL_DATE.exec(value);
  if (!match) {
    throw rangeError("dashboard_range_invalid", `${field} must use YYYY-MM-DD`, { field });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const epochMs = Date.UTC(year, month - 1, day);
  const parsed = new Date(epochMs);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw rangeError("dashboard_range_invalid", `${field} is not a calendar date`, { field });
  }
  return epochMs;
}

export function normalizeDashboardLocalDateRange(
  input: DashboardLocalDateRangeInput = {},
): NormalizedDashboardLocalDateRange {
  const hasDate = input.date !== undefined;
  const hasFrom = input.from !== undefined;
  const hasTo = input.to !== undefined;
  if ((!hasDate && !hasFrom && !hasTo) || (hasDate && (hasFrom || hasTo)) || (hasFrom !== hasTo)) {
    throw rangeError(
      "dashboard_range_required",
      "Provide either date or an explicit from/to local-date range",
    );
  }

  const from = hasDate ? input.date : input.from;
  const to = hasDate ? input.date : input.to;
  const fromEpochMs = parseLocalDate(from, hasDate ? "date" : "from");
  const toEpochMs = parseLocalDate(to, hasDate ? "date" : "to");
  if (fromEpochMs > toEpochMs) {
    throw rangeError("dashboard_range_reversed", "Dashboard range must not be reversed", { from, to });
  }
  const inclusiveDays = Math.floor((toEpochMs - fromEpochMs) / DAY_MS) + 1;
  if (inclusiveDays > DASHBOARD_REPORT_MAX_LOCAL_DAYS) {
    throw rangeError(
      "dashboard_range_too_large",
      `Dashboard range cannot exceed ${DASHBOARD_REPORT_MAX_LOCAL_DAYS} local days`,
      { from, to, inclusiveDays, maximumDays: DASHBOARD_REPORT_MAX_LOCAL_DAYS },
    );
  }
  return { from: from as string, to: to as string, inclusiveDays };
}

export function generateDashboardLocalDateLabels(
  range: NormalizedDashboardLocalDateRange,
): string[] {
  const verifiedRange = normalizeDashboardLocalDateRange({
    from: range.from,
    to: range.to,
  });
  if (verifiedRange.inclusiveDays !== range.inclusiveDays) {
    throw rangeError("dashboard_range_invalid", "Dashboard inclusiveDays does not match its dates", {
      expectedInclusiveDays: verifiedRange.inclusiveDays,
      inclusiveDays: range.inclusiveDays,
    });
  }
  const fromEpochMs = parseLocalDate(verifiedRange.from, "from");
  return Array.from({ length: verifiedRange.inclusiveDays }, (_unused, index) => (
    new Date(fromEpochMs + (index * DAY_MS)).toISOString().slice(0, 10)
  ));
}

function normalizeScope(scope: ReportScope): ReportScope {
  const parsed = ReportScopeSchema.safeParse(scope);
  if (!parsed.success || new Set(parsed.data.storeIds).size !== parsed.data.storeIds.length) {
    throw new PlatformError(
      "scope_required",
      "Dashboard snapshot requires a non-empty, duplicate-free ReportScope",
      409,
    );
  }
  return {
    scopeKind: "report",
    merchantId: parsed.data.merchantId,
    storeIds: [...parsed.data.storeIds].sort(),
  };
}

function isoInstant(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string" || !value.trim()) return null;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}

export async function resolveDashboardStoreWindows(
  client: Pick<PoolClient, "query">,
  scope: ReportScope,
  range: NormalizedDashboardLocalDateRange,
  storeStatusPolicy: DashboardStoreStatusPolicy = "active",
): Promise<DashboardStoreTimeWindowV1[]> {
  if (!["active", "active_or_suspended"].includes(storeStatusPolicy)) throw rangeError("scope_required", "Invalid store read policy");
  const normalizedScope = normalizeScope(scope);
  const verifiedRange = normalizeDashboardLocalDateRange({ from: range.from, to: range.to });
  if (verifiedRange.inclusiveDays !== range.inclusiveDays) {
    throw rangeError("dashboard_range_invalid", "Dashboard inclusiveDays does not match its dates", {
      expectedInclusiveDays: verifiedRange.inclusiveDays,
      inclusiveDays: range.inclusiveDays,
    });
  }
  const result = await client.query<StoreWindowRow>(`
    WITH requested_stores AS (
      SELECT requested.store_id, requested.ordinality
      FROM unnest($2::text[]) WITH ORDINALITY AS requested(store_id, ordinality)
    ), configured_stores AS (
      SELECT
        requested.store_id AS requested_store_id,
        requested.ordinality,
        s.id AS owned_store_id,
        NULLIF(BTRIM(s.metadata->'ownerSettings'->>'timezone'), '') AS configured_time_zone
      FROM requested_stores requested
      LEFT JOIN app.stores s
        ON s.id = requested.store_id
       AND s.merchant_id = $1
       AND (s.status = 'active' OR ($6::boolean AND s.status = 'suspended'))
    )
    SELECT
      configured.requested_store_id,
      configured.owned_store_id,
      zone.name AS time_zone,
      ($3::date::timestamp AT TIME ZONE zone.name) AS start_inclusive,
      (($4::date + 1)::timestamp AT TIME ZONE zone.name) AS end_exclusive
    FROM configured_stores configured
    LEFT JOIN LATERAL (
      SELECT names.name
      FROM pg_timezone_names names
      WHERE names.name = CASE
        WHEN configured.configured_time_zone IS NULL THEN $5::text
        ELSE configured.configured_time_zone
      END
      LIMIT 1
    ) zone ON true
    ORDER BY configured.requested_store_id
  `, [
    normalizedScope.merchantId,
    normalizedScope.storeIds,
    verifiedRange.from,
    verifiedRange.to,
    DASHBOARD_SYSTEM_DEFAULT_TIME_ZONE,
    storeStatusPolicy === "active_or_suspended",
  ]);

  const issues: Array<Record<string, unknown>> = [];
  const windows = result.rows.map((row) => {
    const storeId = typeof row.requested_store_id === "string" ? row.requested_store_id : "";
    const ownedStoreId = typeof row.owned_store_id === "string" ? row.owned_store_id : null;
    const timeZone = typeof row.time_zone === "string" ? row.time_zone : null;
    const startInclusive = isoInstant(row.start_inclusive);
    const endExclusive = isoInstant(row.end_exclusive);
    if (!storeId || !ownedStoreId || !timeZone || !startInclusive || !endExclusive) {
      issues.push({
        storeId: storeId || null,
        reason: !ownedStoreId
          ? "unowned_or_missing_store"
          : !timeZone
            ? "missing_or_invalid_timezone"
            : "invalid_time_window",
      });
      return null;
    }
    if (ownedStoreId !== storeId || Date.parse(startInclusive) >= Date.parse(endExclusive)) {
      issues.push({ storeId, reason: "invalid_time_window" });
      return null;
    }
    return { storeId, timeZone, startInclusive, endExclusive };
  });

  if (
    result.rows.length !== normalizedScope.storeIds.length
    || windows.some((window) => window === null)
    || windows.some((window, index) => window?.storeId !== normalizedScope.storeIds[index])
  ) {
    throw new PlatformError(
      "dashboard_store_time_unavailable",
      "Dashboard store ownership or IANA timezone evidence is incomplete",
      422,
      { issues },
    );
  }
  return windows as DashboardStoreTimeWindowV1[];
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > DASHBOARD_SNAPSHOT_TIMEOUT_HARD_CAP_MS) {
    throw new PlatformError(
      "dashboard_snapshot_timeout_invalid",
      `statementTimeoutMs must be between 1 and ${DASHBOARD_SNAPSHOT_TIMEOUT_HARD_CAP_MS}`,
      500,
    );
  }
  return value;
}

async function readDatabaseInstant(
  client: Pick<PoolClient, "query">,
  sql: string,
  column: "report_as_of" | "generated_at",
): Promise<string> {
  const result = await client.query<Record<string, unknown>>(sql);
  const instant = isoInstant(result.rows[0]?.[column]);
  if (!instant) {
    throw new PlatformError(
      "dashboard_snapshot_clock_unavailable",
      `Database did not provide ${column}`,
      503,
    );
  }
  return instant;
}

export function resolveDashboardHistoryStoreWindows(client: Pick<PoolClient, "query">, scope: ReportScope, range: NormalizedDashboardLocalDateRange): Promise<DashboardStoreTimeWindowV1[]> {
  return resolveDashboardStoreWindows(client, scope, range, "active_or_suspended");
}

export async function withDashboardReadSnapshot<T>(
  client: PoolClient,
  request: DashboardSnapshotRequest,
  read: (client: PoolClient, context: DashboardSnapshotReadContext) => Promise<T>,
): Promise<DashboardSnapshotResult<T>> {
  const normalizedScope = normalizeScope(request.scope);
  const localDateRange = normalizeDashboardLocalDateRange(request.range);
  const statementTimeoutMs = validateTimeout(request.statementTimeoutMs);
  let transactionStarted = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionStarted = true;
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${statementTimeoutMs}ms`]);
    const reportAsOf = await readDatabaseInstant(
      client,
      "SELECT transaction_timestamp() AS report_as_of",
      "report_as_of",
    );
    const storeTimeWindows = await resolveDashboardStoreWindows(
      client,
      normalizedScope,
      localDateRange,
      request.storeStatusPolicy,
    );
    if (storeTimeWindows.every((window) => Date.parse(window.startInclusive) >= Date.parse(reportAsOf))) {
      throw rangeError("dashboard_range_future", "Dashboard range is wholly in the future", {
        from: localDateRange.from,
        to: localDateRange.to,
        reportAsOf,
      });
    }
    const readContext: DashboardSnapshotReadContext = {
      normalizedScope,
      localDateRange,
      storeTimeWindows,
      reportAsOf,
      metricTimeBasis: DASHBOARD_METRIC_TIME_BASIS_V2,
    };
    const data = await read(client, readContext);
    const generatedAt = await readDatabaseInstant(
      client,
      "SELECT clock_timestamp() AS generated_at",
      "generated_at",
    );
    const context = DashboardReportContextV1Schema.parse({
      schemaVersion: 1,
      ...readContext,
      generatedAt,
      freshness: {
        databaseSnapshot: { status: "fresh", asOf: reportAsOf },
      },
    });
    await client.query("COMMIT");
    return { context, data };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
