import { describe, expect, it, vi } from "vitest";
import { DASHBOARD_METRIC_TIME_BASIS_V2 } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import {
  DASHBOARD_RECORDED_COLLECTION_DEFAULT_CONFIG_V1,
  DashboardRecordedCollectionDataQualityErrorV1,
  readDashboardRecordedCollectionSliceV2,
  readDashboardRecordedCollectionSliceV1,
  readDashboardRecordedCollectionSnapshotV1,
} from "../services/dashboard-recorded-collection-slice";

const context = {
  normalizedScope: {
    scopeKind: "report" as const,
    merchantId: "merchant-a",
    storeIds: ["store-a", "store-b"],
  },
  localDateRange: { from: "2026-08-05", to: "2026-08-05", inclusiveDays: 1 },
  storeTimeWindows: [
    {
      storeId: "store-a",
      timeZone: "UTC",
      startInclusive: "2026-08-05T00:00:00.000Z",
      endExclusive: "2026-08-06T00:00:00.000Z",
    },
    {
      storeId: "store-b",
      timeZone: "Asia/Ho_Chi_Minh",
      startInclusive: "2026-08-04T17:00:00.000Z",
      endExclusive: "2026-08-05T17:00:00.000Z",
    },
  ],
  reportAsOf: "2026-08-05T12:00:00.000Z",
  metricTimeBasis: { ...DASHBOARD_METRIC_TIME_BASIS_V2 },
};

function mixedRow(overrides: Record<string, unknown> = {}) {
  return {
    local_date: "2026-08-05",
    currency_code: "VND",
    minor_unit_exponent: "0",
    posted_event_count: "2",
    valid_bundle_event_count: "2",
    tax_modes: ["exclusive", "inclusive"],
    recorded_gross_collections_minor: "253000",
    merchandise_gross_minor: "210000",
    discount_minor: "0",
    merchandise_net_minor: "210000",
    shipping_minor: "31000",
    merchandise_vat_minor: "20000",
    shipping_vat_minor: "3000",
    vat_minor: "23000",
    vat_included_in_price_minor: "11000",
    vat_added_to_price_minor: "12000",
    unclassified_minor: "0",
    component_total_minor: "253000",
    ...overrides,
  };
}

function clientReturning(rows: Array<Record<string, unknown>>) {
  const query = vi.fn(async () => ({ rows }));
  return { client: { query } as unknown as PoolClient, query };
}

describe("PAY-READ-01 canonical recorded gross collection slice", () => {
  it("is frozen default-off and performs no validation or SQL", async () => {
    const { client, query } = clientReturning([]);
    expect(DASHBOARD_RECORDED_COLLECTION_DEFAULT_CONFIG_V1).toEqual({ enabled: false });
    expect(Object.isFrozen(DASHBOARD_RECORDED_COLLECTION_DEFAULT_CONFIG_V1)).toBe(true);
    await expect(readDashboardRecordedCollectionSliceV1(client, {
      ...context,
      normalizedScope: { ...context.normalizedScope, merchantId: "" },
    })).resolves.toEqual({ enabled: false, status: "disabled" });
    expect(query).not.toHaveBeenCalled();
  });

  it("sums posted customer charges once and exposes included versus added VAT", async () => {
    const { client, query } = clientReturning([mixedRow()]);
    await expect(readDashboardRecordedCollectionSliceV1(
      client,
      context,
      { enabled: true },
    )).resolves.toEqual({
      enabled: true,
      data: {
        schemaVersion: 1,
        aggregateReadSource: "app.payment_events",
        currencies: [{
          currencyCode: "VND",
          minorUnitExponent: 0,
          postedChargeEventCount: 2,
          bundleCoverage: { validEvents: 2, totalEvents: 2 },
          recordedGrossCollectionsMinor: 253_000,
          dailyRecordedGrossCollectionsSeries: [{
            localDate: "2026-08-05",
            recordedGrossCollectionsMinor: 253_000,
          }],
          components: {
            taxModes: ["exclusive", "inclusive"],
            merchandiseGrossMinor: 210_000,
            discountMinor: 0,
            merchandiseNetMinor: 210_000,
            shippingMinor: 31_000,
            merchandiseVatMinor: 20_000,
            shippingVatMinor: 3_000,
            vatMinor: 23_000,
            vatIncludedInPriceMinor: 11_000,
            vatAddedToPriceMinor: 12_000,
            unclassifiedMinor: 0,
            totalMinor: 253_000,
          },
        }],
      },
    });

    const [sql, params] = query.mock.calls.find(([statement]) => (
      String(statement).includes("FROM app.payment_events events")
    ))!;
    expect(sql).toContain("FROM app.payment_events events");
    expect(sql).toContain("events.kind = 'charge'");
    expect(sql).toContain("events.status = 'posted'");
    expect(sql).toContain("events.source_occurred_at >= windows.start_inclusive");
    expect(sql).toContain("events.source_occurred_at < LEAST(windows.end_exclusive, $5::timestamptz)");
    expect(sql).toContain("events.source_occurred_at AT TIME ZONE windows.time_zone");
    expect(sql).toContain("events.recorded_at <= $5::timestamptz");
    expect(sql).not.toContain("app.payment_entries");
    expect(params).toEqual([
      "merchant-a",
      ["store-a", "store-b"],
      ["2026-08-05T00:00:00.000Z", "2026-08-04T17:00:00.000Z"],
      ["2026-08-06T00:00:00.000Z", "2026-08-05T17:00:00.000Z"],
      context.reportAsOf,
      ["UTC", "Asia/Ho_Chi_Minh"],
      "all", [],
    ]);
  });

  it("aggregates same-currency daily rows and zero-fills missing local dates", async () => {
    const multiDayContext = {
      ...context,
      localDateRange: { from: "2026-08-04", to: "2026-08-06", inclusiveDays: 3 },
      storeTimeWindows: [
        {
          storeId: "store-a",
          timeZone: "UTC",
          startInclusive: "2026-08-04T00:00:00.000Z",
          endExclusive: "2026-08-07T00:00:00.000Z",
        },
        {
          storeId: "store-b",
          timeZone: "Asia/Ho_Chi_Minh",
          startInclusive: "2026-08-03T17:00:00.000Z",
          endExclusive: "2026-08-06T17:00:00.000Z",
        },
      ],
      reportAsOf: "2026-08-07T00:00:00.000Z",
    };
    const dayRow = (localDate: string, amount: number) => mixedRow({
      local_date: localDate,
      posted_event_count: "1",
      valid_bundle_event_count: "1",
      tax_modes: ["exclusive"],
      recorded_gross_collections_minor: String(amount),
      merchandise_gross_minor: String(amount),
      discount_minor: "0",
      merchandise_net_minor: String(amount),
      shipping_minor: "0",
      merchandise_vat_minor: "0",
      shipping_vat_minor: "0",
      vat_minor: "0",
      vat_included_in_price_minor: "0",
      vat_added_to_price_minor: "0",
      unclassified_minor: "0",
      component_total_minor: String(amount),
    });
    const { client } = clientReturning([
      dayRow("2026-08-04", 100),
      dayRow("2026-08-05", 200),
    ]);

    const result = await readDashboardRecordedCollectionSliceV1(
      client,
      multiDayContext,
      { enabled: true },
    );
    if (!result.enabled) throw new Error("expected enabled reader");

    expect(result.data.currencies).toEqual([expect.objectContaining({
      currencyCode: "VND",
      postedChargeEventCount: 2,
      recordedGrossCollectionsMinor: 300,
      dailyRecordedGrossCollectionsSeries: [
        { localDate: "2026-08-04", recordedGrossCollectionsMinor: 100 },
        { localDate: "2026-08-05", recordedGrossCollectionsMinor: 200 },
        { localDate: "2026-08-06", recordedGrossCollectionsMinor: 0 },
      ],
    })]);
  });

  it("returns sorted independent currency blocks and no cross-currency scalar", async () => {
    const { client } = clientReturning([
      mixedRow({ currency_code: "VND" }),
      mixedRow({ currency_code: "USD", minor_unit_exponent: "2" }),
    ]);
    const result = await readDashboardRecordedCollectionSliceV1(
      client,
      context,
      { enabled: true },
    );
    if (!result.enabled) throw new Error("expected enabled reader");
    expect(result.data.currencies.map((item) => item.currencyCode)).toEqual(["USD", "VND"]);
    expect(result.data).not.toHaveProperty("recordedGrossCollectionsMinor");
  });

  it("returns an empty canonical slice when no posted charge exists", async () => {
    const { client } = clientReturning([]);
    await expect(readDashboardRecordedCollectionSliceV1(
      client,
      context,
      { enabled: true },
    )).resolves.toEqual({
      enabled: true,
      data: {
        schemaVersion: 1,
        aggregateReadSource: "app.payment_events",
        currencies: [],
      },
    });
  });

  it("withholds financial metrics when scoped historical payment quarantine exists", async () => {
    const query = vi.fn(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("to_regclass('app.historical_reconciliation_items')")) {
        return { rows: [{ present: true }] };
      }
      if (sql.includes("FROM app.historical_reconciliation_items items")) {
        return { rows: [{ quarantined_count: "2", quarantined_minor: "37000" }] };
      }
      return { rows: [mixedRow()] };
    });
    await expect(readDashboardRecordedCollectionSliceV1(
      { query } as unknown as PoolClient,
      context,
      { enabled: true },
    )).rejects.toMatchObject({
      code: "dashboard_recorded_collection_data_quality",
      details: {
        fields: [
          "historical_payment_quarantine_count:2",
          "historical_payment_quarantine_minor:37000",
        ],
      },
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("FROM app.payment_events events")))
      .toBe(false);
  });

  it.each([
    ["missing evidence/component/allocation bundle", { valid_bundle_event_count: "1" }],
    ["headline/component drift", { component_total_minor: "252999" }],
    ["VAT attribution drift", { vat_included_in_price_minor: "10000" }],
    ["unsafe integer", { recorded_gross_collections_minor: "9007199254740992" }],
    ["invalid currency", { currency_code: "btc" }],
    ["unsorted tax modes", { tax_modes: ["inclusive", "exclusive"] }],
  ])("fails closed on %s", async (_name, overrides) => {
    const { client } = clientReturning([mixedRow(overrides)]);
    await expect(readDashboardRecordedCollectionSliceV1(
      client,
      context,
      { enabled: true },
    )).rejects.toBeInstanceOf(DashboardRecordedCollectionDataQualityErrorV1);
  });

  it("offers an enabled atomic snapshot seam without an alternate legacy reader", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      statements.push(sql.trim());
      if (sql.includes("transaction_timestamp")) {
        return { rows: [{ report_as_of: context.reportAsOf }] };
      }
      if (sql.includes("requested_stores")) {
        return {
          rows: context.storeTimeWindows.map((window) => ({
            requested_store_id: window.storeId,
            owned_store_id: window.storeId,
            time_zone: window.timeZone,
            start_inclusive: window.startInclusive,
            end_exclusive: window.endExclusive,
          })),
        };
      }
      if (sql.includes("FROM app.payment_events events")) return { rows: [mixedRow()] };
      if (sql.includes("clock_timestamp")) {
        return { rows: [{ generated_at: "2026-08-05T12:00:00.250Z" }] };
      }
      return { rows: [] };
    });

    const result = await readDashboardRecordedCollectionSnapshotV1(
      { query } as unknown as PoolClient,
      {
        scope: context.normalizedScope,
        range: { date: "2026-08-05" },
        statementTimeoutMs: 5_000,
      },
      { enabled: true },
    );
    if (!result.enabled) throw new Error("expected enabled snapshot reader");
    expect(result.snapshot.context.reportAsOf).toBe(context.reportAsOf);
    expect(result.snapshot.data.aggregateReadSource).toBe("app.payment_events");
    expect(statements.some((sql) => sql.includes("app.payment_entries"))).toBe(false);
    expect(statements.findIndex((sql) => sql.includes("BEGIN TRANSACTION")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("FROM app.payment_events events")));
  });
});


function feeCollectionRow(overrides: Record<string, unknown> = {}) {
  return mixedRow({ payment_fee_minor: "1000", payment_fee_vat_minor: "100", payment_fee_vat_included_in_price_minor: "40",
    payment_fee_vat_added_to_price_minor: "60", vat_minor: "23100", vat_included_in_price_minor: "11040", vat_added_to_price_minor: "12060",
    component_total_minor: "254060", recorded_gross_collections_minor: "254060", incompatible_fee_event_count: "2", ...overrides });
}
describe("fee-aware posted charge collection source V2", () => {
  it("reads persisted mixed-tax fee allocations without replacing the actual posted cash headline", async () => {
    const result = await readDashboardRecordedCollectionSliceV2(clientReturning([feeCollectionRow()]).client, context, { enabled: true });
    expect(result).toMatchObject({ enabled: true, data: { schemaVersion: 2, aggregateReadSource: "app.payment_events", currencies: [{
      postedChargeEventCount: 2, recordedGrossCollectionsMinor: 254060, components: { paymentFeeMinor: 1000, paymentFeeVatMinor: 100,
        paymentFeeVatIncludedInPriceMinor: 40, paymentFeeVatAddedToPriceMinor: 60, vatMinor: 23100, totalMinor: 254060 },
      dailyRecordedGrossCollectionsSeries: [{ localDate: "2026-08-05", recordedGrossCollectionsMinor: 254060 }] }] } });
  });
  it("retains signed fee allocation on a positive correction charge, even when goods decrease", async () => {
    const row = feeCollectionRow({ posted_event_count: "1", valid_bundle_event_count: "1", tax_modes: ["exclusive"],
      merchandise_gross_minor: "-100", discount_minor: "0", merchandise_net_minor: "-100", shipping_minor: "0",
      merchandise_vat_minor: "0", shipping_vat_minor: "0", vat_minor: "0", vat_included_in_price_minor: "0", vat_added_to_price_minor: "0",
      payment_fee_minor: "150", payment_fee_vat_minor: "0", payment_fee_vat_included_in_price_minor: "0", payment_fee_vat_added_to_price_minor: "0",
      component_total_minor: "50", recorded_gross_collections_minor: "50", incompatible_fee_event_count: "1" });
    expect(await readDashboardRecordedCollectionSliceV2(clientReturning([row]).client, context, { enabled: true })).toMatchObject({ enabled: true,
      data: { currencies: [{ recordedGrossCollectionsMinor: 50, components: { merchandiseNetMinor: -100, paymentFeeMinor: 150, totalMinor: 50 } }] } });
  });
  it("keeps the default-off and no-fee legacy results", async () => {
    const { client, query } = clientReturning([mixedRow()]);
    expect(await readDashboardRecordedCollectionSliceV2(client, context)).toEqual({ enabled: false, status: "disabled" });
    expect(query).not.toHaveBeenCalled();
    const old = await readDashboardRecordedCollectionSliceV1(client, context, { enabled: true });
    const next = await readDashboardRecordedCollectionSliceV2(client, context, { enabled: true });
    if (!old.enabled || !next.enabled) throw new Error("Expected enabled reads");
    expect(next.data.currencies.map(row => { const { paymentFeeMinor, paymentFeeVatMinor, paymentFeeVatIncludedInPriceMinor, paymentFeeVatAddedToPriceMinor, ...components } = row.components; return { ...row, components }; })).toEqual(old.data.currencies);
  });
  it("rejects legacy fee-bearing events even when their fee sums cancel out", async () => {
    await expect(readDashboardRecordedCollectionSliceV1(clientReturning([{ ...mixedRow(), incompatible_fee_event_count: "2" }]).client, context, { enabled: true }))
      .rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 });
  });
  it.each([
    { payment_fee_vat_minor: "101" }, { payment_fee_minor: "1001" }, { payment_fee_vat_included_in_price_minor: "41" },
    { valid_bundle_event_count: "1" }, { payment_fee_minor: "1.5" }, { payment_fee_minor: "9007199254740992" },
  ])("keeps invalid fee/tax/bundle coverage unavailable: %j", async patch => {
    await expect(readDashboardRecordedCollectionSliceV2(clientReturning([feeCollectionRow(patch)]).client, context, { enabled: true }))
      .rejects.toMatchObject({ code: "dashboard_recorded_collection_data_quality", statusCode: 422 });
  });
});
