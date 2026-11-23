import { describe, expect, it, vi } from "vitest";
import { DASHBOARD_METRIC_TIME_BASIS_V2 } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import {
  DashboardCommercialDataQualityError,
  readDashboardCommercialSliceV2,
  readDashboardCommercialSliceV1,
  readDashboardCommercialSnapshotV1,
} from "../services/dashboard-commercial-slice";
import { EFFECTIVE_ORDER_FIXTURES } from "./effective-order-oracle-fixtures";

const context = {
  normalizedScope: {
    scopeKind: "report" as const,
    merchantId: "merchant-a",
    storeIds: ["store-a", "store-b"],
  },
  localDateRange: { from: "2026-03-08", to: "2026-03-08", inclusiveDays: 1 },
  storeTimeWindows: [
    {
      storeId: "store-a",
      timeZone: "UTC",
      startInclusive: "2026-03-08T00:00:00.000Z",
      endExclusive: "2026-03-09T00:00:00.000Z",
    },
    {
      storeId: "store-b",
      timeZone: "Asia/Ho_Chi_Minh",
      startInclusive: "2026-03-07T17:00:00.000Z",
      endExclusive: "2026-03-08T17:00:00.000Z",
    },
  ],
  reportAsOf: "2026-03-08T12:00:00.000Z",
  metricTimeBasis: { ...DASHBOARD_METRIC_TIME_BASIS_V2 },
};

type CommercialRow = Record<string, unknown>;

function orderRows(input: {
  orderId: string;
  storeId: string;
  revision: number;
  state: "active" | "cancelled";
  quality?: "complete" | "partial" | "unavailable";
  taxMode?: "inclusive" | "exclusive";
  gross: number;
  discount: number;
  shipping: number;
  vat: number;
  merchandiseVat?: number;
  shippingVat?: number;
  unclassified?: number;
  lines: Array<{
    lineKey: string;
    productId: string;
    variantId: string;
    sku: string;
    title: string;
    quantity: number;
    unitPrice: number;
    unitCost?: number;
  }>;
}): CommercialRow[] {
  const taxMode = input.taxMode ?? "exclusive";
  const merchandiseNet = input.gross - input.discount;
  const merchandiseVat = input.merchandiseVat ?? input.vat;
  const shippingVat = input.shippingVat ?? 0;
  const total = merchandiseNet
    + input.shipping
    + (taxMode === "exclusive" ? input.vat : 0)
    + (input.unclassified || 0);
  const base = {
    order_id: input.orderId,
    store_id: input.storeId,
    order_created_at: "2026-03-08T01:00:00.000Z",
    revision_id: `revision-${input.orderId}-${input.revision}`,
    revision: String(input.revision),
    commercial_state: input.state,
    currency_code: "VND",
    minor_unit_exponent: "0",
    data_quality: input.quality || "complete",
    effective_at: "2026-03-08T02:00:00.000Z",
    tax_mode: taxMode,
    merchandise_gross_minor: String(input.gross),
    discount_minor: String(input.discount),
    merchandise_net_minor: String(merchandiseNet),
    shipping_minor: String(input.shipping),
    merchandise_vat_minor: String(merchandiseVat),
    shipping_vat_minor: String(shippingVat),
    vat_minor: String(input.vat),
    unclassified_minor: String(input.unclassified || 0),
    total_minor: String(total),
  };
  if (input.lines.length === 0) {
    return [{
      ...base,
      line_key: null,
      product_id: null,
      variant_id: null,
      sku_snapshot: null,
      title_snapshot: null,
      archived_variant: null,
      quantity: null,
      unit_price_minor: null,
      line_total_minor: null,
      cost_minor: null,
      cost_evidence_id: null,
    }];
  }
  return input.lines.map((line) => ({
    ...base,
    line_key: line.lineKey,
    product_id: line.productId,
    variant_id: line.variantId,
    sku_snapshot: line.sku,
    title_snapshot: line.title,
    archived_variant: false,
    quantity: String(line.quantity),
    unit_price_minor: String(line.unitPrice),
    line_total_minor: String(line.quantity * line.unitPrice),
    cost_minor: line.unitCost == null ? null : String(line.unitCost),
    cost_evidence_id: line.unitCost == null ? null : `cost:${line.lineKey}`,
  }));
}

function completeRows(): CommercialRow[] {
  return [
    ...orderRows({
      orderId: "order-active-a",
      storeId: "store-a",
      revision: 2,
      state: "active",
      gross: 300,
      discount: 30,
      shipping: 20,
      vat: 29,
      unclassified: 1,
      lines: [
        {
          lineKey: "line-a-1",
          productId: "product-a",
          variantId: "variant-a",
          sku: "SKU-A",
          title: "Product A",
          quantity: 2,
          unitPrice: 100,
          unitCost: 60,
        },
        {
          lineKey: "line-a-2",
          productId: "product-b",
          variantId: "variant-b",
          sku: "SKU-B",
          title: "Product B",
          quantity: 1,
          unitPrice: 100,
          unitCost: 50,
        },
      ],
    }),
    ...orderRows({
      orderId: "order-active-b",
      storeId: "store-b",
      revision: 3,
      state: "active",
      quality: "partial",
      taxMode: "inclusive",
      gross: 100,
      discount: 0,
      shipping: 0,
      vat: 10,
      lines: [{
        lineKey: "line-b-1",
        productId: "product-a",
        variantId: "variant-a",
        sku: "SKU-A",
        title: "Product A",
        quantity: 1,
        unitPrice: 100,
      }],
    }),
    ...orderRows({
      orderId: "order-cancelled",
      storeId: "store-a",
      revision: 4,
      state: "cancelled",
      gross: 100,
      discount: 0,
      shipping: 0,
      vat: 10,
      lines: [{
        lineKey: "line-c-1",
        productId: "product-c",
        variantId: "variant-c",
        sku: "SKU-C",
        title: "Product C",
        quantity: 1,
        unitPrice: 100,
        unitCost: 40,
      }],
    }),
  ];
}

function clientReturning(rows: CommercialRow[]) {
  const query = vi.fn(async () => ({ rows }));
  return { client: { query } as unknown as PoolClient, query };
}

describe("DASH-01 effective commercial dashboard slice", () => {
  it("aggregates latest active revisions, ignores cancelled values and exposes incomplete cost", async () => {
    const { client, query } = clientReturning(completeRows());

    await expect(readDashboardCommercialSliceV1(client, context)).resolves.toEqual({
      schemaVersion: 1,
      dailyActiveOrderCountSeries: [{
        localDate: "2026-03-08",
        activeOrderCount: 2,
      }],
      currencies: [{
        currencyCode: "VND",
        minorUnitExponent: 0,
        validOrderCount: 2,
        cancelledOrderCohortCount: 1,
        activeOrdersWithShippingCount: 1,
        currentOrderGrossValueMinor: 420,
        dailyCurrentOrderGrossValueSeries: [{
          localDate: "2026-03-08",
          currentOrderGrossValueMinor: 420,
        }],
        currentMerchandiseGrossValueMinor: 400,
        currentDiscountMinor: 30,
        currentMerchandiseRevenueExVatMinor: 360,
        currentShippingRevenueExVatMinor: 20,
        currentShippingGrossValueMinor: 20,
        currentShippingSharePercent: 4.8,
        currentVatMinor: 39,
        currentUnclassifiedMinor: 1,
        effectiveItemQuantity: 4,
        averageCurrentOrderValueMinor: 210,
        currentCogsMinor: null,
        currentMerchandiseGrossProfitMinor: null,
        currentContributionBeforeShippingCostMinor: null,
        costCoverage: { knownLines: 2, totalLines: 3 },
        dataQuality: {
          status: "partial",
          costCoverage: { knownLines: 2, totalLines: 3 },
          warnings: [
            "commercial_snapshot_partial",
            "historical_cost_evidence_incomplete",
          ],
        },
        topProducts: [
          {
            productId: "product-a",
            variantId: "variant-a",
            skuSnapshot: "SKU-A",
            titleSnapshot: "Product A",
            archivedVariant: false,
            quantity: 3,
            grossLineSalesBeforeDiscountMinor: 300,
            currentCogsMinor: null,
            costCoverage: { knownLines: 1, totalLines: 2 },
          },
          {
            productId: "product-b",
            variantId: "variant-b",
            skuSnapshot: "SKU-B",
            titleSnapshot: "Product B",
            archivedVariant: false,
            quantity: 1,
            grossLineSalesBeforeDiscountMinor: 100,
            currentCogsMinor: 50,
            costCoverage: { knownLines: 1, totalLines: 1 },
          },
        ],
      }],
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]!;
    const normalizedSql = String(sql).toLowerCase().replace(/\s+/g, " ");
    expect(normalizedSql).toContain('from public."order" o');
    expect(normalizedSql).toContain("app.order_commercial_revisions");
    expect(normalizedSql).toContain("app.order_commercial_revision_components");
    expect(normalizedSql).toContain("app.order_commercial_revision_lines");
    expect(normalizedSql).toContain("o.merchant_id = $1");
    expect(normalizedSql).toContain("o.created_at >= windows.start_inclusive");
    expect(normalizedSql).toContain("o.created_at < least(windows.end_exclusive, $5::timestamptz)");
    expect(normalizedSql).toContain("revision.effective_at <= $5::timestamptz");
    expect(normalizedSql).toContain("order by revision.revision desc");
    expect(normalizedSql).not.toContain("created_at::date");
    expect(normalizedSql).not.toContain("order_item");
    expect(normalizedSql).not.toContain("order_line_item");
    expect(normalizedSql).not.toContain("metadata->");
    expect(normalizedSql).not.toContain("product_variant");
    expect(params).toEqual([
      "merchant-a",
      ["store-a", "store-b"],
      ["2026-03-08T00:00:00.000Z", "2026-03-07T17:00:00.000Z"],
      ["2026-03-09T00:00:00.000Z", "2026-03-08T17:00:00.000Z"],
      "2026-03-08T12:00:00.000Z",
      "all", [],
    ]);
  });

  it("equals the independent TEST-01 oracle across every correction shape", async () => {
    const rows = EFFECTIVE_ORDER_FIXTURES.flatMap((fixture, fixtureIndex) => {
      const expected = fixture.expected;
      return orderRows({
        orderId: expected.orderId,
        storeId: fixtureIndex % 2 === 0 ? "store-a" : "store-b",
        revision: expected.effectiveRevision,
        state: expected.commercialState,
        taxMode: expected.components.taxMode,
        gross: expected.components.merchandiseGrossMinor,
        discount: expected.components.discountMinor,
        shipping: expected.components.shippingMinor,
        vat: expected.components.vatMinor,
        merchandiseVat: expected.components.merchandiseVatMinor,
        shippingVat: expected.components.shippingVatMinor,
        unclassified: expected.components.unclassifiedMinor,
        lines: expected.lines.map((line, lineIndex) => ({
          lineKey: `${expected.orderId}:line:${lineIndex}`,
          productId: `product-${line.sku}`,
          variantId: `variant-${line.sku}`,
          sku: line.sku,
          title: `Product ${line.sku}`,
          quantity: line.quantity,
          unitPrice: line.unitPriceMinor,
          unitCost: 1,
        })),
      }).map((row) => ({
        ...row,
        archived_variant: expected.lines.find(
          (line) => line.sku === row.sku_snapshot,
        )?.archived || false,
      }));
    });
    const active = EFFECTIVE_ORDER_FIXTURES
      .map((fixture) => fixture.expected)
      .filter((order) => order.commercialState === "active");
    const sum = (select: (order: (typeof active)[number]) => number) =>
      active.reduce((total, order) => total + select(order), 0);
    const effectiveQuantity = sum((order) =>
      order.lines.reduce((total, line) => total + line.quantity, 0));
    const { client } = clientReturning(rows);

    const result = await readDashboardCommercialSliceV1(client, context);
    expect(result.currencies[0]).toMatchObject({
      validOrderCount: active.length,
      cancelledOrderCohortCount: 1,
      activeOrdersWithShippingCount: active.filter((order) => {
        const shippingGross = order.components.shippingMinor
          + (order.components.taxMode === "exclusive"
            ? order.components.shippingVatMinor
            : 0);
        return shippingGross > 0;
      }).length,
      currentOrderGrossValueMinor: sum((order) => order.components.totalMinor),
      currentMerchandiseGrossValueMinor: sum(
        (order) => order.components.merchandiseGrossMinor,
      ),
      currentDiscountMinor: sum((order) => order.components.discountMinor),
      currentMerchandiseRevenueExVatMinor: sum(
        (order) => order.components.merchandiseNetMinor,
      ),
      currentShippingRevenueExVatMinor: sum((order) => order.components.shippingMinor),
      currentShippingGrossValueMinor: sum((order) => (
        order.components.shippingMinor
          + (order.components.taxMode === "exclusive"
            ? order.components.shippingVatMinor
            : 0)
      )),
      currentVatMinor: sum((order) => order.components.vatMinor),
      currentUnclassifiedMinor: sum((order) => order.components.unclassifiedMinor),
      effectiveItemQuantity: effectiveQuantity,
      currentCogsMinor: effectiveQuantity,
      costCoverage: {
        knownLines: sum((order) => order.lines.length),
        totalLines: sum((order) => order.lines.length),
      },
      dataQuality: { status: "complete", warnings: [] },
    });
    expect(result.currencies[0].currentMerchandiseGrossProfitMinor).toBe(
      sum((order) => order.components.merchandiseNetMinor) - effectiveQuantity,
    );
    expect(result.currencies[0].currentContributionBeforeShippingCostMinor).toBe(
      sum((order) => order.components.merchandiseNetMinor)
        + sum((order) => order.components.shippingMinor)
        - effectiveQuantity,
    );
  });

  it("returns an explicit zero VND block for an empty cohort", async () => {
    const { client } = clientReturning([]);
    const result = await readDashboardCommercialSliceV1(client, context);
    expect(result.dailyActiveOrderCountSeries).toEqual([{
      localDate: "2026-03-08",
      activeOrderCount: 0,
    }]);
    expect(result.currencies).toEqual([expect.objectContaining({
      currencyCode: "VND",
      validOrderCount: 0,
      cancelledOrderCohortCount: 0,
      activeOrdersWithShippingCount: 0,
      currentOrderGrossValueMinor: 0,
      dailyCurrentOrderGrossValueSeries: [{
        localDate: "2026-03-08",
        currentOrderGrossValueMinor: 0,
      }],
      currentShippingGrossValueMinor: 0,
      currentShippingSharePercent: null,
      currentCogsMinor: 0,
      averageCurrentOrderValueMinor: null,
      costCoverage: { knownLines: 0, totalLines: 0 },
      topProducts: [],
    })]);
    expect(result.currencies[0].dataQuality.status).toBe("complete");
  });

  it("aggregates equal owning-store local dates and zero-fills the requested range", async () => {
    const multiDayContext = {
      ...context,
      localDateRange: { from: "2026-03-07", to: "2026-03-09", inclusiveDays: 3 },
      storeTimeWindows: [
        {
          storeId: "store-a",
          timeZone: "UTC",
          startInclusive: "2026-03-07T00:00:00.000Z",
          endExclusive: "2026-03-10T00:00:00.000Z",
        },
        {
          storeId: "store-b",
          timeZone: "Asia/Ho_Chi_Minh",
          startInclusive: "2026-03-06T17:00:00.000Z",
          endExclusive: "2026-03-09T17:00:00.000Z",
        },
      ],
      reportAsOf: "2026-03-10T00:00:00.000Z",
    };
    const rows = [
      ...orderRows({
        orderId: "order-utc",
        storeId: "store-a",
        revision: 2,
        state: "active",
        gross: 100,
        discount: 0,
        shipping: 0,
        vat: 0,
        lines: [{
          lineKey: "line-utc",
          productId: "product-utc",
          variantId: "variant-utc",
          sku: "SKU-UTC",
          title: "UTC order",
          quantity: 1,
          unitPrice: 100,
          unitCost: 50,
        }],
      }).map((row) => ({ ...row, order_created_at: "2026-03-08T00:30:00.000Z" })),
      ...orderRows({
        orderId: "order-vn",
        storeId: "store-b",
        revision: 3,
        state: "active",
        gross: 200,
        discount: 0,
        shipping: 0,
        vat: 0,
        lines: [{
          lineKey: "line-vn",
          productId: "product-vn",
          variantId: "variant-vn",
          sku: "SKU-VN",
          title: "Vietnam order",
          quantity: 1,
          unitPrice: 200,
          unitCost: 100,
        }],
      }).map((row) => ({ ...row, order_created_at: "2026-03-07T18:00:00.000Z" })),
    ];
    const { client, query } = clientReturning(rows);

    const result = await readDashboardCommercialSliceV1(client, multiDayContext);

    expect(result.dailyActiveOrderCountSeries).toEqual([
      { localDate: "2026-03-07", activeOrderCount: 0 },
      { localDate: "2026-03-08", activeOrderCount: 2 },
      { localDate: "2026-03-09", activeOrderCount: 0 },
    ]);
    expect(result.currencies[0]!.dailyCurrentOrderGrossValueSeries).toEqual([
      { localDate: "2026-03-07", currentOrderGrossValueMinor: 0 },
      { localDate: "2026-03-08", currentOrderGrossValueMinor: 300 },
      { localDate: "2026-03-09", currentOrderGrossValueMinor: 0 },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("groups top products by canonical variant, uses the newest snapshot label and caps stable ties", async () => {
    const productRows = [
      ...orderRows({
        orderId: "order-label-old",
        storeId: "store-a",
        revision: 1,
        state: "active",
        gross: 100,
        discount: 0,
        shipping: 0,
        vat: 10,
        lines: [{
          lineKey: "line-label-old",
          productId: "product-a",
          variantId: "variant-a",
          sku: "SKU-A-OLD",
          title: "Old product label",
          quantity: 1,
          unitPrice: 100,
          unitCost: 50,
        }],
      }).map((row) => ({ ...row, order_created_at: "2026-03-08T00:30:00.000Z" })),
      ...orderRows({
        orderId: "order-label-new",
        storeId: "store-a",
        revision: 1,
        state: "active",
        gross: 100,
        discount: 0,
        shipping: 0,
        vat: 10,
        lines: [{
          lineKey: "line-label-new",
          productId: "product-a",
          variantId: "variant-a",
          sku: "SKU-A-NEW",
          title: "New product label",
          quantity: 1,
          unitPrice: 100,
          unitCost: 50,
        }],
      }).map((row) => ({ ...row, order_created_at: "2026-03-08T02:00:00.000Z" })),
      ...["b", "c", "d", "e", "f"].flatMap((suffix) => orderRows({
        orderId: `order-${suffix}`,
        storeId: "store-a",
        revision: 1,
        state: "active",
        gross: 100,
        discount: 0,
        shipping: 0,
        vat: 10,
        lines: [{
          lineKey: `line-${suffix}`,
          productId: `product-${suffix}`,
          variantId: `variant-${suffix}`,
          sku: `SKU-${suffix.toUpperCase()}`,
          title: `Product ${suffix.toUpperCase()}`,
          quantity: 1,
          unitPrice: 100,
          unitCost: 50,
        }],
      })),
    ];
    const { client } = clientReturning(productRows);

    const result = await readDashboardCommercialSliceV1(client, context);
    expect(result.currencies[0].topProducts).toHaveLength(5);
    expect(result.currencies[0].topProducts[0]).toMatchObject({
      productId: "product-a",
      variantId: "variant-a",
      skuSnapshot: "SKU-A-NEW",
      titleSnapshot: "New product label",
      quantity: 2,
      grossLineSalesBeforeDiscountMinor: 200,
      currentCogsMinor: 100,
      costCoverage: { knownLines: 2, totalLines: 2 },
    });
    expect(result.currencies[0].topProducts.map((product) => product.productId)).toEqual([
      "product-a",
      "product-b",
      "product-c",
      "product-d",
      "product-e",
    ]);
  });

  it.each([
    {
      name: "missing revision",
      rows: [{ order_id: "order-missing", store_id: "store-a", revision_id: null }],
      reason: "missing_revision",
    },
    {
      name: "unavailable revision",
      rows: () => orderRows({
        orderId: "order-unavailable",
        storeId: "store-a",
        revision: 1,
        state: "active",
        quality: "unavailable",
        gross: 100,
        discount: 0,
        shipping: 0,
        vat: 10,
        lines: [],
      }),
      reason: "unavailable_revision",
    },
    {
      name: "component arithmetic mismatch",
      rows: () => orderRows({
        orderId: "order-invalid",
        storeId: "store-a",
        revision: 1,
        state: "active",
        gross: 100,
        discount: 0,
        shipping: 0,
        vat: 10,
        lines: [{
          lineKey: "line-invalid",
          productId: "product-a",
          variantId: "variant-a",
          sku: "SKU-A",
          title: "Product A",
          quantity: 1,
          unitPrice: 100,
          unitCost: 50,
        }],
      }).map((row) => ({ ...row, total_minor: "111" })),
      reason: "invalid_projection",
    },
    {
      name: "unsafe integer",
      rows: () => orderRows({
        orderId: "order-unsafe",
        storeId: "store-a",
        revision: 1,
        state: "active",
        gross: 100,
        discount: 0,
        shipping: 0,
        vat: 10,
        lines: [],
      }).map((row) => ({ ...row, total_minor: "9007199254740992" })),
      reason: "invalid_projection",
    },
  ])("fails closed for $name", async ({ rows, reason }) => {
    const materializedRows = typeof rows === "function" ? rows() : rows;
    const { client } = clientReturning(materializedRows);
    await expect(readDashboardCommercialSliceV1(client, context)).rejects.toMatchObject({
      code: "dashboard_commercial_data_quality",
      statusCode: 422,
      details: { issues: [expect.objectContaining({ reason })] },
    });
  });

  it("rejects a forged context before querying", async () => {
    const { client, query } = clientReturning([]);
    await expect(readDashboardCommercialSliceV1(client, {
      ...context,
      normalizedScope: { ...context.normalizedScope, storeIds: ["store-b", "store-a"] },
    })).rejects.toBeInstanceOf(DashboardCommercialDataQualityError);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "store outside normalized scope",
      mutate: (row: CommercialRow) => ({ ...row, store_id: "store-other" }),
    },
    {
      name: "order outside the store-local cohort window",
      mutate: (row: CommercialRow) => ({
        ...row,
        order_created_at: "2026-03-09T00:00:00.000Z",
      }),
    },
  ])("fails closed when the SQL result contains $name", async ({ mutate }) => {
    const rows = orderRows({
      orderId: "order-query-contract",
      storeId: "store-a",
      revision: 1,
      state: "active",
      gross: 100,
      discount: 0,
      shipping: 0,
      vat: 10,
      lines: [{
        lineKey: "line-query-contract",
        productId: "product-a",
        variantId: "variant-a",
        sku: "SKU-A",
        title: "Product A",
        quantity: 1,
        unitPrice: 100,
        unitCost: 50,
      }],
    }).map(mutate);
    const { client } = clientReturning(rows);

    await expect(readDashboardCommercialSliceV1(client, context)).rejects.toMatchObject({
      code: "dashboard_commercial_data_quality",
      details: {
        issues: [{
          orderId: "order-query-contract",
          reason: "query_contract_violation",
        }],
      },
    });
  });

  it("offers only an atomic snapshot orchestration seam to platform consumers", async () => {
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
      if (sql.includes("cohort_orders")) return { rows: completeRows() };
      if (sql.includes("clock_timestamp")) {
        return { rows: [{ generated_at: "2026-03-08T12:00:00.250Z" }] };
      }
      return { rows: [] };
    });

    const result = await readDashboardCommercialSnapshotV1(
      { query } as unknown as PoolClient,
      {
        scope: context.normalizedScope,
        range: { date: "2026-03-08" },
        statementTimeoutMs: 5_000,
      },
    );

    expect(result.context.reportAsOf).toBe(context.reportAsOf);
    expect(result.data.currencies[0]).toMatchObject({
      validOrderCount: 2,
      cancelledOrderCohortCount: 1,
      currentOrderGrossValueMinor: 420,
    });
    const beginIndex = statements.findIndex((sql) => sql.includes("BEGIN TRANSACTION"));
    const sliceIndex = statements.findIndex((sql) => sql.includes("cohort_orders"));
    const commitIndex = statements.findIndex((sql) => sql === "COMMIT");
    expect(query).toHaveBeenCalledTimes(7);
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeLessThan(sliceIndex);
    expect(sliceIndex).toBeLessThan(commitIndex);
  });
});


function feeRows(orderId: string, taxMode: "inclusive" | "exclusive", cancelled = false): CommercialRow[] {
  return orderRows({ orderId, storeId: "store-a", revision: 0, state: cancelled ? "cancelled" : "active", taxMode,
    gross: 1000, discount: 0, shipping: 0, vat: taxMode === "inclusive" ? 91 : 100,
    lines: [{ lineKey: `${orderId}:a`, productId: "p-a", variantId: "v-a", sku: "SKU-A", title: "A", quantity: 1, unitPrice: 600, unitCost: 10 },
      { lineKey: `${orderId}:b`, productId: "p-b", variantId: "v-b", sku: "SKU-B", title: "B", quantity: 2, unitPrice: 200, unitCost: 10 }] })
    .map(row => ({ ...row, component_version: 2, payment_fee_minor: "100", payment_fee_vat_minor: taxMode === "inclusive" ? "9" : "10",
      vat_minor: String(Number(row.vat_minor) + (taxMode === "inclusive" ? 9 : 10)),
      total_minor: String(Number(row.total_minor) + 100 + (taxMode === "exclusive" ? 10 : 0)) }));
}
describe("fee-aware commercial Dashboard slice V2", () => {
  it("counts stored fees once per order, preserving cost and merchandise-only profit", async () => {
    const { client } = clientReturning([...feeRows("fee-inclusive", "inclusive"), ...feeRows("fee-exclusive", "exclusive"), ...feeRows("fee-cancelled", "inclusive", true)]);
    const result = await readDashboardCommercialSliceV2(client, context);
    expect(result.schemaVersion).toBe(2);
    expect(result.currencies.find(row => row.currencyCode === "VND")).toMatchObject({ validOrderCount: 2, cancelledOrderCohortCount: 1,
      currentOrderGrossValueMinor: 2310, currentPaymentFeeMinor: 200, currentPaymentFeeVatMinor: 19, currentPaymentFeeCustomerTotalMinor: 210,
      currentPaymentFeeRevenueExVatMinor: 191, currentVatMinor: 210, effectiveItemQuantity: 6, currentCogsMinor: 60,
      currentMerchandiseGrossProfitMinor: 1849, currentContributionBeforeShippingCostMinor: 1849,
      dailyCurrentOrderGrossValueSeries: [{ localDate: "2026-03-08", currentOrderGrossValueMinor: 2310 }] });
  });
  it("keeps incomplete cost unavailable while retaining verified commercial fees", async () => {
    const rows = feeRows("fee-partial", "exclusive"); rows[0]!.cost_minor = null; rows[0]!.cost_evidence_id = null;
    const { client } = clientReturning(rows);
    const result = await readDashboardCommercialSliceV2(client, context);
    expect(result.currencies.find(row => row.currencyCode === "VND")).toMatchObject({ currentPaymentFeeMinor: 100,
      currentCogsMinor: null, currentMerchandiseGrossProfitMinor: null, dataQuality: { status: "partial" } });
  });
  it("explicitly refuses legacy nonzero fee cohorts, including cancelled orders", async () => {
    for (const state of [false, true]) {
      const { client } = clientReturning(feeRows("fee-legacy", "inclusive", state));
      await expect(readDashboardCommercialSliceV1(client, context)).rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 });
    }
  });
  it("keeps an explicit-zero V2 order readable by legacy money readers", async () => {
    const rows = feeRows("fee-zero", "exclusive").map(row => ({ ...row, payment_fee_minor: "0", payment_fee_vat_minor: "0",
      vat_minor: String(Number(row.vat_minor) - 10), total_minor: String(Number(row.total_minor) - 110) }));
    const old = await readDashboardCommercialSliceV1(clientReturning(rows).client, context);
    expect(old.currencies.find(row => row.currencyCode === "VND")).toMatchObject({ validOrderCount: 1, currentOrderGrossValueMinor: 1100 });
    const next = await readDashboardCommercialSliceV2(clientReturning(rows).client, context);
    expect(next.currencies.find(row => row.currencyCode === "VND")).toMatchObject({ currentOrderGrossValueMinor: 1100,
      currentPaymentFeeMinor: 0, currentPaymentFeeVatMinor: 0, currentPaymentFeeCustomerTotalMinor: 0, currentPaymentFeeRevenueExVatMinor: 0 });
  });
  it("keeps legacy no-fee results unchanged when read through V2", async () => {
    const rows = completeRows(), legacy = await readDashboardCommercialSliceV1(clientReturning(rows).client, context);
    const next = await readDashboardCommercialSliceV2(clientReturning(rows).client, context);
    expect(next.currencies.map(({ currentPaymentFeeMinor, currentPaymentFeeVatMinor, currentPaymentFeeCustomerTotalMinor, currentPaymentFeeRevenueExVatMinor, ...row }) => row)).toEqual(legacy.currencies);
  });
  it.each(["payment_fee_minor", "payment_fee_vat_minor", "component_version"])("rejects inconsistent %s across a multi-line revision", async key => {
    const rows = feeRows("fee-drift", "exclusive"); rows[1]![key] = key === "component_version" ? 1 : "0";
    await expect(readDashboardCommercialSliceV2(clientReturning(rows).client, context)).rejects.toMatchObject({ code: "dashboard_commercial_data_quality", statusCode: 422 });
  });
});
