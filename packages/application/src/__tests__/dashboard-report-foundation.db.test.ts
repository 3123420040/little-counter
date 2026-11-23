import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { shutdownPlatformDb } from "../platform-db";
import {
  resolveDashboardStoreWindows,
  withDashboardReadSnapshot,
} from "../services/dashboard-report-foundation";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const merchantId = `dash-clock-merchant-${runId}`;
const otherMerchantId = `dash-clock-other-${runId}`;
const storeIds = {
  utc: `dash-clock-utc-${runId}`,
  vn: `dash-clock-vn-${runId}`,
  ny: `dash-clock-ny-${runId}`,
  fallback: `dash-clock-fallback-${runId}`,
  other: `dash-clock-other-store-${runId}`,
};

let reader: PoolClient;
let writer: PoolClient;

async function insertMerchant(client: PoolClient, id: string) {
  await client.query(`
    INSERT INTO app.merchants (id, display_name, legacy_organization_id, status, metadata)
    VALUES ($1, $2, $3, 'active', '{}'::jsonb)
  `, [id, id, `org-${id}`]);
}

async function insertStore(
  client: PoolClient,
  input: { id: string; merchantId: string; timeZone: string },
) {
  await client.query(`
    INSERT INTO public.stock_location (id, name)
    VALUES ($1, $2)
    ON CONFLICT (id) DO NOTHING
  `, [`sloc-${input.id}`, input.id]);
  await client.query(`
    INSERT INTO app.stores (
      id, merchant_id, display_name, stock_location_id, is_primary, status, metadata
    )
    VALUES ($1, $2, $1, $3, false, 'active', jsonb_build_object(
      'ownerSettings', jsonb_build_object('timezone', $4::text)
    ))
  `, [input.id, input.merchantId, `sloc-${input.id}`, input.timeZone]);
}

async function insertStoreWithoutTimeZone(
  client: PoolClient,
  input: { id: string; merchantId: string },
) {
  await client.query(`
    INSERT INTO public.stock_location (id, name)
    VALUES ($1, $2)
    ON CONFLICT (id) DO NOTHING
  `, [`sloc-${input.id}`, input.id]);
  await client.query(`
    INSERT INTO app.stores (
      id, merchant_id, display_name, stock_location_id, is_primary, status, metadata
    )
    VALUES ($1, $2, $1, $3, false, 'active', '{}'::jsonb)
  `, [input.id, input.merchantId, `sloc-${input.id}`]);
}

beforeAll(async () => {
  reader = await connectPlatformClient();
  writer = await connectPlatformClient();
  await insertMerchant(writer, merchantId);
  await insertMerchant(writer, otherMerchantId);
  await insertStore(writer, { id: storeIds.utc, merchantId, timeZone: "UTC" });
  await insertStore(writer, { id: storeIds.vn, merchantId, timeZone: "Asia/Ho_Chi_Minh" });
  await insertStore(writer, { id: storeIds.ny, merchantId, timeZone: "America/New_York" });
  await insertStoreWithoutTimeZone(writer, { id: storeIds.fallback, merchantId });
  await insertStore(writer, { id: storeIds.other, merchantId: otherMerchantId, timeZone: "UTC" });
});

afterAll(async () => {
  await writer?.query("DELETE FROM app.stores WHERE id = ANY($1::text[])", [Object.values(storeIds)]).catch(() => undefined);
  await writer?.query(
    "DELETE FROM public.stock_location WHERE id = ANY($1::text[])",
    [Object.values(storeIds).map((id) => `sloc-${id}`)],
  ).catch(() => undefined);
  await writer?.query("DELETE FROM app.merchants WHERE id = ANY($1::text[])", [[merchantId, otherMerchantId]]).catch(() => undefined);
  reader?.release();
  writer?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("DASH-00 PostgreSQL clock and atomic snapshot", () => {
  it("matches independent UTC, Vietnam and New York DST half-open windows", async () => {
    const windows = await resolveDashboardStoreWindows(reader, {
      scopeKind: "report",
      merchantId,
      storeIds: [storeIds.vn, storeIds.ny, storeIds.utc],
    }, {
      from: "2026-03-08",
      to: "2026-03-08",
      inclusiveDays: 1,
    });

    expect(windows).toEqual([
      {
        storeId: storeIds.ny,
        timeZone: "America/New_York",
        startInclusive: "2026-03-08T05:00:00.000Z",
        endExclusive: "2026-03-09T04:00:00.000Z",
      },
      {
        storeId: storeIds.utc,
        timeZone: "UTC",
        startInclusive: "2026-03-08T00:00:00.000Z",
        endExclusive: "2026-03-09T00:00:00.000Z",
      },
      {
        storeId: storeIds.vn,
        timeZone: "Asia/Ho_Chi_Minh",
        startInclusive: "2026-03-07T17:00:00.000Z",
        endExclusive: "2026-03-08T17:00:00.000Z",
      },
    ]);

    const dstFallBack = await resolveDashboardStoreWindows(reader, {
      scopeKind: "report",
      merchantId,
      storeIds: [storeIds.ny],
    }, {
      from: "2026-11-01",
      to: "2026-11-01",
      inclusiveDays: 1,
    });
    expect(dstFallBack).toEqual([{
      storeId: storeIds.ny,
      timeZone: "America/New_York",
      startInclusive: "2026-11-01T04:00:00.000Z",
      endExclusive: "2026-11-02T05:00:00.000Z",
    }]);
    expect(
      Date.parse(dstFallBack[0]!.endExclusive) - Date.parse(dstFallBack[0]!.startInclusive),
    ).toBe(25 * 60 * 60 * 1_000);
  });

  it("rejects a cross-merchant store without falling back to merchant-wide scope", async () => {
    await expect(resolveDashboardStoreWindows(reader, {
      scopeKind: "report",
      merchantId,
      storeIds: [storeIds.other],
    }, {
      from: "2026-03-08",
      to: "2026-03-08",
      inclusiveDays: 1,
    })).rejects.toMatchObject({
      code: "dashboard_store_time_unavailable",
      statusCode: 422,
      details: { issues: [{ storeId: storeIds.other, reason: "unowned_or_missing_store" }] },
    });
  });

  it("uses Asia/Ho_Chi_Minh only when an owned active store has no timezone metadata", async () => {
    await expect(resolveDashboardStoreWindows(reader, {
      scopeKind: "report",
      merchantId,
      storeIds: [storeIds.fallback],
    }, {
      from: "2026-03-08",
      to: "2026-03-08",
      inclusiveDays: 1,
    })).resolves.toEqual([{
      storeId: storeIds.fallback,
      timeZone: "Asia/Ho_Chi_Minh",
      startInclusive: "2026-03-07T17:00:00.000Z",
      endExclusive: "2026-03-08T17:00:00.000Z",
    }]);

    await writer.query(`
      UPDATE app.stores
      SET metadata = jsonb_build_object(
        'ownerSettings',
        jsonb_build_object('timezone', 'Mars/Olympus_Mons')
      )
      WHERE id = $1 AND merchant_id = $2
    `, [storeIds.fallback, merchantId]);
    await expect(resolveDashboardStoreWindows(reader, {
      scopeKind: "report",
      merchantId,
      storeIds: [storeIds.fallback],
    }, {
      from: "2026-03-08",
      to: "2026-03-08",
      inclusiveDays: 1,
    })).rejects.toMatchObject({
      code: "dashboard_store_time_unavailable",
      statusCode: 422,
      details: {
        issues: [{
          storeId: storeIds.fallback,
          reason: "missing_or_invalid_timezone",
        }],
      },
    });
  });

  it("keeps both slice reads on the pre-writer snapshot", async () => {
    const result = await withDashboardReadSnapshot(reader, {
      scope: {
        scopeKind: "report",
        merchantId,
        storeIds: [storeIds.utc],
      },
      range: { date: "2026-03-08" },
      statementTimeoutMs: 5_000,
    }, async (snapshotClient) => {
      const before = await snapshotClient.query<{ time_zone: string }>(`
        SELECT metadata->'ownerSettings'->>'timezone' AS time_zone
        FROM app.stores
        WHERE id = $1 AND merchant_id = $2
      `, [storeIds.utc, merchantId]);
      await writer.query(`
        UPDATE app.stores
        SET metadata = jsonb_set(metadata, '{ownerSettings,timezone}', '"Asia/Tokyo"'::jsonb),
            updated_at = now()
        WHERE id = $1 AND merchant_id = $2
      `, [storeIds.utc, merchantId]);
      const after = await snapshotClient.query<{ time_zone: string }>(`
        SELECT metadata->'ownerSettings'->>'timezone' AS time_zone
        FROM app.stores
        WHERE id = $1 AND merchant_id = $2
      `, [storeIds.utc, merchantId]);
      return {
        before: before.rows[0]?.time_zone,
        after: after.rows[0]?.time_zone,
      };
    });

    expect(result.data).toEqual({ before: "UTC", after: "UTC" });
    expect(result.context.storeTimeWindows).toEqual([{
      storeId: storeIds.utc,
      timeZone: "UTC",
      startInclusive: "2026-03-08T00:00:00.000Z",
      endExclusive: "2026-03-09T00:00:00.000Z",
    }]);
    expect(Date.parse(result.context.generatedAt)).toBeGreaterThanOrEqual(Date.parse(result.context.reportAsOf));

    const committed = await writer.query<{ time_zone: string }>(`
      SELECT metadata->'ownerSettings'->>'timezone' AS time_zone
      FROM app.stores
      WHERE id = $1 AND merchant_id = $2
    `, [storeIds.utc, merchantId]);
    expect(committed.rows[0]?.time_zone).toBe("Asia/Tokyo");
    await writer.query(`
      UPDATE app.stores
      SET metadata = jsonb_set(metadata, '{ownerSettings,timezone}', '"UTC"'::jsonb),
          updated_at = now()
      WHERE id = $1 AND merchant_id = $2
    `, [storeIds.utc, merchantId]);
  });
});
