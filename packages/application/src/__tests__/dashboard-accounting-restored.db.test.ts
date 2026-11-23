import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { shutdownPlatformDb } from "../platform-db";
import { createDashboardMetricRuntimeBindingV1 } from "../services/dashboard-factor-runtime-binding";
import { readDashboardPartialFinancialSnapshotV1 } from "../services/dashboard-partial-financial-model";

const enabled = process.env.DASHBOARD_RESTORED_ACCOUNTING_PROOF === "enabled";

let client: PoolClient;

beforeAll(async () => {
  if (!enabled) return;
  client = await connectPlatformClient();
  const database = await client.query<{ name: string }>(
    "SELECT current_database() AS name",
  );
  expect(database.rows[0]?.name).toBe("medusa_snus_restore_20260817_gap15_r4");
});

afterAll(async () => {
  if (!enabled) return;
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe.runIf(enabled)("restored accounting-backed dashboard proof", () => {
  it("reaches 27/27 on a complete real journal/cost period", async () => {
    const result = await readDashboardPartialFinancialSnapshotV1(client, {
      scope: {
        scopeKind: "report",
        merchantId: "merchant_snus_nha_trang",
        storeIds: ["store_snus_nha_trang"],
      },
      range: { date: "2026-08-13" },
      statementTimeoutMs: 30_000,
    }, { enabled: true });
    if (!result.enabled) throw new Error("canonical dashboard unexpectedly disabled");

    const binding = createDashboardMetricRuntimeBindingV1({
      reportAsOf: result.snapshot.context.reportAsOf,
    }, result.snapshot.data);
    expect(result.snapshot.context.storeTimeWindows).toEqual([{
      storeId: "store_snus_nha_trang",
      timeZone: "Asia/Ho_Chi_Minh",
      startInclusive: "2026-08-12T17:00:00.000Z",
      endExclusive: "2026-08-13T17:00:00.000Z",
    }]);
    expect(result.snapshot.data.currencies[0]?.accounting).toEqual({
      currencyCode: "VND",
      minorUnitExponent: 0,
      status: "available",
      dataQualityStatus: "complete",
      postedJournalCount: 3,
      revenueExcludingVatMinor: 1_236_364,
      cogsRecognizedMinor: 810_000,
      grossProfitMinor: 426_364,
      grossMarginPercent: 34.5,
    });
    expect(binding.availableCount).toBe(27);
    expect(binding.unavailableCount).toBe(0);
  });

  it("keeps historical accounting factors unavailable when cost provenance is incomplete", async () => {
    const result = await readDashboardPartialFinancialSnapshotV1(client, {
      scope: {
        scopeKind: "report",
        merchantId: "merchant_default",
        storeIds: ["store_default"],
      },
      range: { from: "2026-08-10", to: "2026-08-17" },
      statementTimeoutMs: 30_000,
    }, { enabled: true });
    if (!result.enabled) throw new Error("canonical dashboard unexpectedly disabled");

    const binding = createDashboardMetricRuntimeBindingV1({
      reportAsOf: result.snapshot.context.reportAsOf,
    }, result.snapshot.data);
    expect(result.snapshot.data.currencies[0]?.accounting).toEqual({
      currencyCode: "VND",
      minorUnitExponent: 0,
      status: "unavailable",
      dataQualityStatus: "unavailable",
      issues: ["incomplete_cost_provenance"],
    });
    expect(result.snapshot.data.operationalSnapshot?.reportMerchantCustomerAcquisition)
      .toMatchObject({
        status: "available",
        businessTimeZone: "Asia/Ho_Chi_Minh",
      });
    expect(binding.factors.find(
      (factor) => factor.factorId === "new_customer_count",
    )?.runtimeStatus).toBe("available");
    expect(binding.factors.find(
      (factor) => factor.factorId === "current_gross_profit",
    )).toMatchObject({
      runtimeStatus: "unavailable",
      runtimeReason: expect.stringContaining("incomplete_cost_provenance"),
    });
    expect(binding.factors.find(
      (factor) => factor.factorId === "gross_margin_percent",
    )?.runtimeStatus).toBe("unavailable");
  });
});
