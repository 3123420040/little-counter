import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "../db/client";
import { DASHBOARD_METRIC_TIME_BASIS_V2 } from "@medusa-snus/contracts";
import { readDashboardPaymentFlowSliceV1 } from "../services/dashboard-payment-flow-slice";

const context = {
  normalizedScope: {
    scopeKind: "report" as const,
    merchantId: "merchant-a",
    storeIds: ["store-a"],
  },
  localDateRange: { from: "2026-08-16", to: "2026-08-16", inclusiveDays: 1 },
  storeTimeWindows: [{
    storeId: "store-a",
    timeZone: "Asia/Ho_Chi_Minh",
    startInclusive: "2026-08-15T17:00:00.000Z",
    endExclusive: "2026-08-16T17:00:00.000Z",
  }],
  reportAsOf: "2026-08-16T12:00:00.000Z",
  metricTimeBasis: { ...DASHBOARD_METRIC_TIME_BASIS_V2 },
};

describe("dashboard payment flow and method slice", () => {
  it("keeps negative flows, payable and method net values in one snapshot scope", async () => {
    const query = vi.fn(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("GROUP BY events.currency_code, events.minor_unit_exponent, events.method")) {
        return { rows: [
          {
            currency_code: "VND",
            minor_unit_exponent: "0",
            method: "cash",
            charge_order_count: "2",
            negative_count: "1",
            gross_minor: "300000",
            negative_minor: "50000",
          },
          {
            currency_code: "VND",
            minor_unit_exponent: "0",
            method: "manual_bank",
            charge_order_count: "1",
            negative_count: "0",
            gross_minor: "200000",
            negative_minor: "0",
          },
        ] };
      }
      return { rows: [{
        currency_code: "VND",
        minor_unit_exponent: "0",
        refund_count: "1",
        reversal_count: "1",
        chargeback_count: "0",
        refunds_minor: "50000",
        reversals_minor: "10000",
        chargebacks_minor: "0",
        payable_minor: "25000",
      }] };
    });
    await expect(readDashboardPaymentFlowSliceV1(
      { query } as unknown as PoolClient,
      context,
    )).resolves.toEqual([{
      currencyCode: "VND",
      minorUnitExponent: 0,
      postedRefundEventCount: 1,
      postedReversalEventCount: 1,
      postedChargebackEventCount: 0,
      refundsMinor: 50_000,
      reversalsMinor: 10_000,
      chargebacksMinor: 0,
      negativeCollectionsMinor: 60_000,
      customerRefundPayableAsOfMinor: 25_000,
      methods: [
        {
          method: "cash",
          postedChargeOrderCount: 2,
          postedNegativeEventCount: 1,
          recordedGrossCollectionsMinor: 300_000,
          recordedNegativeCollectionsMinor: 50_000,
          recordedNetCollectionsMinor: 250_000,
        },
        {
          method: "manual_bank",
          postedChargeOrderCount: 1,
          postedNegativeEventCount: 0,
          recordedGrossCollectionsMinor: 200_000,
          recordedNegativeCollectionsMinor: 0,
          recordedNetCollectionsMinor: 200_000,
        },
      ],
    }]);
    expect(query).toHaveBeenCalledTimes(2);
    for (const call of query.mock.calls) {
      expect(call[1]).toEqual([
        "merchant-a",
        ["store-a"],
        ["2026-08-15T17:00:00.000Z"],
        ["2026-08-16T17:00:00.000Z"],
        context.reportAsOf,
        "all", [],
      ]);
      expect(String(call[0])).not.toContain("app.payment_entries");
    }
  });

  it("fails closed on an empty payment method identity", async () => {
    let call = 0;
    const query = vi.fn(async () => {
      call += 1;
      if (call === 1) return { rows: [] };
      return { rows: [{
        currency_code: "VND",
        minor_unit_exponent: "0",
        method: "",
        charge_order_count: "1",
        negative_count: "0",
        gross_minor: "1",
        negative_minor: "0",
      }] };
    });
    await expect(readDashboardPaymentFlowSliceV1(
      { query } as unknown as PoolClient,
      context,
    )).rejects.toMatchObject({
      code: "dashboard_payment_flow_data_quality",
      statusCode: 422,
    });
  });

  it("keeps a charge-only currency block even when it has no negative flow or payable", async () => {
    let call = 0;
    const query = vi.fn(async () => {
      call += 1;
      if (call === 1) return { rows: [] };
      return { rows: [{
        currency_code: "USD",
        minor_unit_exponent: "2",
        method: "provider",
        charge_order_count: "1",
        negative_count: "0",
        gross_minor: "12345",
        negative_minor: "0",
      }] };
    });

    await expect(readDashboardPaymentFlowSliceV1(
      { query } as unknown as PoolClient,
      context,
    )).resolves.toEqual([{
      currencyCode: "USD",
      minorUnitExponent: 2,
      postedRefundEventCount: 0,
      postedReversalEventCount: 0,
      postedChargebackEventCount: 0,
      refundsMinor: 0,
      reversalsMinor: 0,
      chargebacksMinor: 0,
      negativeCollectionsMinor: 0,
      customerRefundPayableAsOfMinor: 0,
      methods: [{
        method: "provider",
        postedChargeOrderCount: 1,
        postedNegativeEventCount: 0,
        recordedGrossCollectionsMinor: 12345,
        recordedNegativeCollectionsMinor: 0,
        recordedNetCollectionsMinor: 12345,
      }],
    }]);
  });
});
