import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "../db/client";
import {
  DASHBOARD_REPORT_MAX_LOCAL_DAYS,
  generateDashboardLocalDateLabels,
  normalizeDashboardLocalDateRange,
  resolveDashboardStoreWindows,
  withDashboardReadSnapshot,
} from "../services/dashboard-report-foundation";

const scope = {
  scopeKind: "report" as const,
  merchantId: "merchant-a",
  storeIds: ["store-utc", "store-vn", "store-ny"],
};

function storeWindowRows() {
  return [
    {
      requested_store_id: "store-ny",
      owned_store_id: "store-ny",
      time_zone: "America/New_York",
      start_inclusive: "2026-03-08T05:00:00.000Z",
      end_exclusive: "2026-03-09T04:00:00.000Z",
    },
    {
      requested_store_id: "store-utc",
      owned_store_id: "store-utc",
      time_zone: "UTC",
      start_inclusive: "2026-03-08T00:00:00.000Z",
      end_exclusive: "2026-03-09T00:00:00.000Z",
    },
    {
      requested_store_id: "store-vn",
      owned_store_id: "store-vn",
      time_zone: "Asia/Ho_Chi_Minh",
      start_inclusive: "2026-03-07T17:00:00.000Z",
      end_exclusive: "2026-03-08T17:00:00.000Z",
    },
  ];
}

describe("DASH-00 report scope, clock and snapshot foundation", () => {
  it("normalizes exact local dates and rejects ambiguous, reversed, invalid and oversized ranges", () => {
    expect(normalizeDashboardLocalDateRange({ date: "2026-08-05" })).toEqual({
      from: "2026-08-05",
      to: "2026-08-05",
      inclusiveDays: 1,
    });
    expect(normalizeDashboardLocalDateRange({
      from: "2024-01-01",
      to: "2024-12-31",
    })).toEqual({
      from: "2024-01-01",
      to: "2024-12-31",
      inclusiveDays: DASHBOARD_REPORT_MAX_LOCAL_DAYS,
    });

    for (const input of [
      {},
      { from: "2026-08-05" },
      { date: "2026-08-05", from: "2026-08-05", to: "2026-08-05" },
      { date: "2026-8-5" },
      { date: "2026-02-30" },
      { from: "2026-08-06", to: "2026-08-05" },
      { from: "2024-01-01", to: "2025-01-01" },
    ]) {
      expect(() => normalizeDashboardLocalDateRange(input)).toThrowError(expect.objectContaining({
        statusCode: 400,
      }));
    }
  });

  it("generates every requested inclusive local-date label with a 366-day hard bound", () => {
    expect(generateDashboardLocalDateLabels({
      from: "2024-02-28",
      to: "2024-03-01",
      inclusiveDays: 3,
    })).toEqual([
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
    ]);

    expect(() => generateDashboardLocalDateLabels({
      from: "2024-01-01",
      to: "2024-12-31",
      inclusiveDays: DASHBOARD_REPORT_MAX_LOCAL_DAYS + 1,
    })).toThrowError(expect.objectContaining({
      code: "dashboard_range_invalid",
      statusCode: 400,
    }));
  });

  it("resolves one half-open instant window per exact owned store and preserves a 23-hour DST day", async () => {
    const query = vi.fn(async () => ({ rows: storeWindowRows() }));
    const client = { query } as unknown as PoolClient;

    await expect(resolveDashboardStoreWindows(client, scope, {
      from: "2026-03-08",
      to: "2026-03-08",
      inclusiveDays: 1,
    })).resolves.toEqual([
      {
        storeId: "store-ny",
        timeZone: "America/New_York",
        startInclusive: "2026-03-08T05:00:00.000Z",
        endExclusive: "2026-03-09T04:00:00.000Z",
      },
      {
        storeId: "store-utc",
        timeZone: "UTC",
        startInclusive: "2026-03-08T00:00:00.000Z",
        endExclusive: "2026-03-09T00:00:00.000Z",
      },
      {
        storeId: "store-vn",
        timeZone: "Asia/Ho_Chi_Minh",
        startInclusive: "2026-03-07T17:00:00.000Z",
        endExclusive: "2026-03-08T17:00:00.000Z",
      },
    ]);

    const [sql, params] = query.mock.calls[0]!;
    const normalizedSql = String(sql).toLowerCase().replace(/\s+/g, " ");
    expect(normalizedSql).toContain("unnest($2::text[])");
    expect(normalizedSql).toContain("s.merchant_id = $1");
    expect(normalizedSql).toContain("s.metadata->'ownersettings'->>'timezone'");
    expect(normalizedSql).toContain("pg_timezone_names");
    expect(normalizedSql).toContain("at time zone");
    expect(normalizedSql).toContain("configured_time_zone is null");
    expect(normalizedSql).not.toContain("created_at::date");
    expect(params).toEqual([
      "merchant-a",
      ["store-ny", "store-utc", "store-vn"],
      "2026-03-08",
      "2026-03-08",
      "Asia/Ho_Chi_Minh",
      false,
    ]);

    const ny = storeWindowRows()[0]!;
    expect(Date.parse(ny.end_exclusive) - Date.parse(ny.start_inclusive)).toBe(23 * 60 * 60 * 1_000);
  });

  it("uses the approved system timezone when store metadata is missing", async () => {
    const query = vi.fn(async () => ({ rows: [{
      requested_store_id: "store-default",
      owned_store_id: "store-default",
      time_zone: "Asia/Ho_Chi_Minh",
      start_inclusive: "2026-03-07T17:00:00.000Z",
      end_exclusive: "2026-03-08T17:00:00.000Z",
    }] }));

    await expect(resolveDashboardStoreWindows(
      { query } as unknown as PoolClient,
      {
        scopeKind: "report",
        merchantId: "merchant-a",
        storeIds: ["store-default"],
      },
      { from: "2026-03-08", to: "2026-03-08", inclusiveDays: 1 },
    )).resolves.toEqual([{
      storeId: "store-default",
      timeZone: "Asia/Ho_Chi_Minh",
      startInclusive: "2026-03-07T17:00:00.000Z",
      endExclusive: "2026-03-08T17:00:00.000Z",
    }]);
  });

  it("fails closed for duplicate scope, unowned store and an invalid configured timezone", async () => {
    const client = { query: vi.fn() } as unknown as PoolClient;
    await expect(resolveDashboardStoreWindows(client, {
      ...scope,
      storeIds: ["store-utc", "store-utc"],
    }, { from: "2026-03-08", to: "2026-03-08", inclusiveDays: 1 }))
      .rejects.toMatchObject({ code: "scope_required", statusCode: 409 });

    for (const row of [
      {
        requested_store_id: "store-other",
        owned_store_id: null,
        time_zone: null,
        start_inclusive: null,
        end_exclusive: null,
      },
      {
        requested_store_id: "store-utc",
        owned_store_id: "store-utc",
        time_zone: "Mars/Olympus_Mons",
        start_inclusive: null,
        end_exclusive: null,
      },
    ]) {
      const query = vi.fn(async () => ({ rows: [row] }));
      await expect(resolveDashboardStoreWindows(
        { query } as unknown as PoolClient,
        { ...scope, storeIds: [String(row.requested_store_id)] },
        { from: "2026-03-08", to: "2026-03-08", inclusiveDays: 1 },
      )).rejects.toMatchObject({
        code: "dashboard_store_time_unavailable",
        statusCode: 422,
      });
    }
  });

  it("does not trust a forged normalized range or query the database for it", async () => {
    const query = vi.fn();
    await expect(resolveDashboardStoreWindows(
      { query } as unknown as PoolClient,
      { ...scope, storeIds: ["store-utc"] },
      { from: "2026-03-08", to: "2026-03-09", inclusiveDays: 1 },
    )).rejects.toMatchObject({
      code: "dashboard_range_invalid",
      statusCode: 400,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("runs all slice reads inside one bounded repeatable-read/read-only snapshot", async () => {
    const statements: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sqlValue: unknown, params?: unknown[]) => {
      const sql = String(sqlValue);
      statements.push({ sql, params });
      if (sql.includes("transaction_timestamp")) {
        return { rows: [{ report_as_of: "2026-03-08T12:00:00.000Z" }] };
      }
      if (sql.includes("requested_stores")) return { rows: storeWindowRows() };
      if (sql.includes("clock_timestamp")) {
        return { rows: [{ generated_at: "2026-03-08T12:00:00.250Z" }] };
      }
      if (sql.includes("SELECT 'slice-one'")) return { rows: [{ value: 1 }] };
      if (sql.includes("SELECT 'slice-two'")) return { rows: [{ value: 2 }] };
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;

    const result = await withDashboardReadSnapshot(client, {
      scope,
      range: { date: "2026-03-08" },
      statementTimeoutMs: 5_000,
    }, async (snapshotClient, context) => {
      expect(context.reportAsOf).toBe("2026-03-08T12:00:00.000Z");
      await snapshotClient.query("SELECT 'slice-one'");
      await snapshotClient.query("SELECT 'slice-two'");
      return { first: 1, second: 2 };
    });

    expect(result.data).toEqual({ first: 1, second: 2 });
    expect(result.context).toMatchObject({
      schemaVersion: 1,
      normalizedScope: {
        scopeKind: "report",
        merchantId: "merchant-a",
        storeIds: ["store-ny", "store-utc", "store-vn"],
      },
      localDateRange: { from: "2026-03-08", to: "2026-03-08", inclusiveDays: 1 },
      reportAsOf: "2026-03-08T12:00:00.000Z",
      generatedAt: "2026-03-08T12:00:00.250Z",
      freshness: {
        databaseSnapshot: { status: "fresh", asOf: "2026-03-08T12:00:00.000Z" },
      },
    });
    expect(statements.map((entry) => entry.sql.trim())).toEqual(expect.arrayContaining([
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "COMMIT",
    ]));
    expect(statements[1]).toEqual({
      sql: "SELECT set_config('statement_timeout', $1, true)",
      params: ["5000ms"],
    });
    expect(query).toHaveBeenCalledTimes(8);
    const beginIndex = statements.findIndex((entry) => entry.sql.includes("BEGIN TRANSACTION"));
    const firstSliceIndex = statements.findIndex((entry) => entry.sql.includes("slice-one"));
    const secondSliceIndex = statements.findIndex((entry) => entry.sql.includes("slice-two"));
    const commitIndex = statements.findIndex((entry) => entry.sql === "COMMIT");
    expect(beginIndex).toBeLessThan(firstSliceIndex);
    expect(firstSliceIndex).toBeLessThan(secondSliceIndex);
    expect(secondSliceIndex).toBeLessThan(commitIndex);
  });

  it("rolls back the one snapshot and never returns partial slice data", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sqlValue: unknown) => {
        const sql = String(sqlValue);
        statements.push(sql.trim());
        if (sql.includes("transaction_timestamp")) {
          return { rows: [{ report_as_of: "2026-03-08T12:00:00.000Z" }] };
        }
        if (sql.includes("requested_stores")) return { rows: storeWindowRows() };
        return { rows: [] };
      }),
    } as unknown as PoolClient;

    await expect(withDashboardReadSnapshot(client, {
      scope,
      range: { date: "2026-03-08" },
      statementTimeoutMs: 5_000,
    }, async () => {
      throw new Error("slice failed");
    })).rejects.toThrow("slice failed");

    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("rejects an unknown history policy before issuing a query", async () => {
    const query = vi.fn();
    await expect(resolveDashboardStoreWindows({ query } as unknown as PoolClient, scope,
      { from: "2026-03-08", to: "2026-03-08", inclusiveDays: 1 }, "all" as never))
      .rejects.toMatchObject({ code: "scope_required", statusCode: 400 });
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects an unbounded snapshot timeout before opening a transaction", async () => {
    const query = vi.fn();
    await expect(withDashboardReadSnapshot({ query } as unknown as PoolClient, {
      scope,
      range: { date: "2026-03-08" },
      statementTimeoutMs: 30_001,
    }, async () => null)).rejects.toMatchObject({
      code: "dashboard_snapshot_timeout_invalid",
      statusCode: 500,
    });
    expect(query).not.toHaveBeenCalled();
  });
});
