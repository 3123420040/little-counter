import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "../db/client";
import {
  EffectiveOrderProjectionError,
  readEffectiveOrderV1,
  readEffectiveOrdersV1,
  readEffectiveOrdersV2,
} from "../services/effective-order-projection-service";
import { EFFECTIVE_ORDER_FIXTURES } from "./effective-order-oracle-fixtures";

const reportScope = {
  scopeKind: "report" as const,
  merchantId: "merchant-a",
  storeIds: ["store-b", "store-a"],
};
const asOf = "2026-08-05T00:00:00.000Z";

type ProjectionRow = Record<string, unknown>;

function rowsForFixture(
  fixture: (typeof EFFECTIVE_ORDER_FIXTURES)[number],
  overrides: ProjectionRow = {},
): ProjectionRow[] {
  const expected = fixture.expected;
  const base = {
    requested_order_id: expected.orderId,
    request_ordinal: 1,
    revision_id: `revision-${expected.orderId}-${expected.effectiveRevision}`,
    revision: String(expected.effectiveRevision),
    commercial_state: expected.commercialState,
    currency_code: expected.currencyCode,
    minor_unit_exponent: "0",
    data_quality: "complete",
    effective_at: "2026-08-04T12:00:00.000Z",
    tax_mode: expected.components.taxMode,
    merchandise_gross_minor: String(expected.components.merchandiseGrossMinor),
    discount_minor: String(expected.components.discountMinor),
    merchandise_net_minor: String(expected.components.merchandiseNetMinor),
    shipping_minor: String(expected.components.shippingMinor),
    merchandise_vat_minor: String(expected.components.merchandiseVatMinor),
    shipping_vat_minor: String(expected.components.shippingVatMinor),
    vat_minor: String(expected.components.vatMinor),
    unclassified_minor: String(expected.components.unclassifiedMinor),
    total_minor: String(expected.components.totalMinor),
  };

  if (expected.lines.length === 0) {
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
      ...overrides,
    }];
  }

  return expected.lines.map((line, index) => ({
    ...base,
    line_key: `${expected.orderId}:line:${index}`,
    product_id: `product-${line.sku}`,
    variant_id: `variant-${line.sku}`,
    sku_snapshot: line.sku,
    title_snapshot: `Product ${line.sku}`,
    archived_variant: Boolean(line.archived),
    quantity: String(line.quantity),
    unit_price_minor: String(line.unitPriceMinor),
    line_total_minor: String(line.quantity * line.unitPriceMinor),
    cost_minor: "100",
    cost_evidence_id: `cost:${expected.orderId}:${index}`,
    ...overrides,
  }));
}

function expectedProjection(fixture: (typeof EFFECTIVE_ORDER_FIXTURES)[number]) {
  const expected = fixture.expected;
  return {
    schemaVersion: 1,
    orderId: expected.orderId,
    currencyCode: expected.currencyCode,
    minorUnitExponent: 0,
    effectiveRevision: expected.effectiveRevision,
    commercialState: expected.commercialState,
    lines: expected.lines.map((line, index) => ({
      lineId: `${expected.orderId}:line:${index}`,
      productId: `product-${line.sku}`,
      variantId: `variant-${line.sku}`,
      skuSnapshot: line.sku,
      titleSnapshot: `Product ${line.sku}`,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      archivedVariant: Boolean(line.archived),
    })),
    components: expected.components,
    currentOrderGrossValueMinor: expected.currentOrderGrossValueMinor,
    dataQuality: {
      status: "complete",
      costCoverage: {
        knownLines: expected.lines.length,
        totalLines: expected.lines.length,
      },
      warnings: [],
    },
  };
}

function clientReturning(rows: ProjectionRow[]) {
  const query = vi.fn(async () => ({ rows }));
  return { client: { query } as unknown as PoolClient, query };
}

describe("READ-01 canonical effective-order projection", () => {
  it("refuses the entire legacy cohort when an order carries a payment surcharge", async () => {
    const fixture = EFFECTIVE_ORDER_FIXTURES[0]!;
    const { client } = clientReturning(rowsForFixture(fixture, {
      component_version: 2, payment_fee_minor: "100", payment_fee_vat_minor: "10",
      vat_minor: String(fixture.expected.components.vatMinor + 10),
      total_minor: String(fixture.expected.components.totalMinor + 110),
    }));
    await expect(readEffectiveOrdersV1(client, { scope: reportScope,
      orderIds: [fixture.input.orderId], currencyCode: "VND", asOf,
    })).rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 });
  });
  it("projects mixed V1/V2 orders without recomputing persisted surcharge or tax", async () => {
    const legacy = EFFECTIVE_ORDER_FIXTURES[0]!, fee = EFFECTIVE_ORDER_FIXTURES[1]!;
    const { client, query } = clientReturning([
      ...rowsForFixture(legacy, { component_version: 1, payment_fee_minor: "0", payment_fee_vat_minor: "0" }),
      ...rowsForFixture(fee, { request_ordinal: 2, component_version: 2,
        payment_fee_minor: "100", payment_fee_vat_minor: "10",
        vat_minor: String(fee.expected.components.vatMinor + 10),
        total_minor: String(fee.expected.components.totalMinor + 110) }),
    ]);
    const result = await readEffectiveOrdersV2(client, { scope: reportScope,
      orderIds: [legacy.input.orderId, fee.input.orderId], currencyCode: "VND", asOf });
    expect(result).toEqual([
      { ...expectedProjection(legacy), schemaVersion: 2, componentVersion: 1,
        components: { ...legacy.expected.components, paymentFeeMinor: 0, paymentFeeVatMinor: 0 } },
      { ...expectedProjection(fee), schemaVersion: 2, componentVersion: 2,
        components: { ...fee.expected.components, paymentFeeMinor: 100, paymentFeeVatMinor: 10,
          vatMinor: fee.expected.components.vatMinor + 10, totalMinor: fee.expected.components.totalMinor + 110 },
        currentOrderGrossValueMinor: fee.expected.currentOrderGrossValueMinor + 110 },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("keeps an explicit zero-fee V2 snapshot readable through the unchanged legacy DTO", async () => {
    const fixture = EFFECTIVE_ORDER_FIXTURES[0]!;
    const { client } = clientReturning(rowsForFixture(fixture, {
      component_version: 2, payment_fee_minor: "0", payment_fee_vat_minor: "0",
    }));
    await expect(readEffectiveOrderV1(client, { scope: reportScope,
      orderId: fixture.input.orderId, currencyCode: "VND", asOf,
    })).resolves.toEqual(expectedProjection(fixture));
  });
  it("retains partial cost evidence rather than fabricating a complete fee projection", async () => {
    const fixture = EFFECTIVE_ORDER_FIXTURES[0]!;
    const { client } = clientReturning(rowsForFixture(fixture, { component_version: 2,
      payment_fee_minor: "100", payment_fee_vat_minor: "10", data_quality: "partial",
      cost_minor: null, cost_evidence_id: null,
      vat_minor: String(fixture.expected.components.vatMinor + 10), total_minor: String(fixture.expected.components.totalMinor + 110) }));
    const [projection] = await readEffectiveOrdersV2(client, { scope: reportScope,
      orderIds: [fixture.input.orderId], currencyCode: "VND", asOf });
    expect(projection!.dataQuality).toEqual({ status: "partial", costCoverage: { knownLines: 0, totalLines: fixture.expected.lines.length },
      warnings: ["commercial_snapshot_partial", "historical_cost_evidence_incomplete"] });
  });
  it.each(["component_version", "payment_fee_minor", "payment_fee_vat_minor"])(
    "rejects inconsistent %s across lines of the same fee snapshot", async (field) => {
      const fixture = EFFECTIVE_ORDER_FIXTURES[1]!;
      const rows = rowsForFixture(fixture, { component_version: 2, payment_fee_minor: "0", payment_fee_vat_minor: "0" });
      expect(rows.length).toBeGreaterThan(1);
      rows[1]![field] = field === "component_version" ? 1 : "1";
      const { client } = clientReturning(rows);
      await expect(readEffectiveOrdersV2(client, { scope: reportScope,
        orderIds: [fixture.input.orderId], currencyCode: "VND", asOf,
      })).rejects.toMatchObject({ code: "effective_order_data_quality" });
    },
  );
  it("matches every independent TEST-01 revision shape in one scoped batch query", async () => {
    const rows = EFFECTIVE_ORDER_FIXTURES.flatMap((fixture, fixtureIndex) =>
      rowsForFixture(fixture).map((row) => ({
        ...row,
        request_ordinal: fixtureIndex + 1,
      })),
    );
    const { client, query } = clientReturning(rows);

    await expect(readEffectiveOrdersV1(client, {
      scope: reportScope,
      orderIds: EFFECTIVE_ORDER_FIXTURES.map((fixture) => fixture.input.orderId),
      currencyCode: "VND",
      asOf,
    })).resolves.toEqual(EFFECTIVE_ORDER_FIXTURES.map(expectedProjection));

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]!;
    const normalizedSql = String(sql).toLowerCase();
    expect(normalizedSql).toContain("app.order_commercial_revisions");
    expect(normalizedSql).toContain("app.order_commercial_revision_components");
    expect(normalizedSql).toContain("app.order_commercial_revision_lines");
    expect(normalizedSql).toContain("lines.product_id");
    expect(normalizedSql).toContain("lines.variant_id");
    expect(normalizedSql).toContain("revisions.merchant_id = $1");
    expect(normalizedSql).toContain("revisions.store_id = any($2::text[])");
    expect(normalizedSql).toContain("revisions.currency_code = $3");
    expect(normalizedSql).toContain("revisions.effective_at <= $5::timestamptz");
    expect(normalizedSql).toContain("revisions.revision desc nulls last");
    expect(normalizedSql).not.toContain('from public."order"');
    expect(normalizedSql).not.toContain("order_item");
    expect(normalizedSql).not.toContain("order_line_item");
    expect(normalizedSql).not.toContain("product_variant");
    expect(normalizedSql).not.toContain("product_settings");
    expect(params).toEqual([
      "merchant-a",
      ["store-a", "store-b"],
      "VND",
      EFFECTIVE_ORDER_FIXTURES.map((fixture) => fixture.input.orderId),
      asOf,
    ]);
  });

  it("uses the same bounded query for the scalar projection", async () => {
    const fixture = EFFECTIVE_ORDER_FIXTURES[1]!;
    const { client, query } = clientReturning(rowsForFixture(fixture));

    await expect(readEffectiveOrderV1(client, {
      scope: reportScope,
      orderId: fixture.input.orderId,
      currencyCode: "VND",
      asOf,
    })).resolves.toEqual(expectedProjection(fixture));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns partial cost coverage explicitly without consulting current catalog cost", async () => {
    const fixture = EFFECTIVE_ORDER_FIXTURES.find((item) => item.name === "add sku")!;
    const rows = rowsForFixture(fixture).map((row, index) => index === 1
      ? {
          ...row,
          data_quality: "partial",
          cost_minor: null,
          cost_evidence_id: null,
        }
      : { ...row, data_quality: "partial" });
    const { client } = clientReturning(rows);

    const result = await readEffectiveOrderV1(client, {
      scope: reportScope,
      orderId: fixture.input.orderId,
      currencyCode: "VND",
      asOf,
    });

    expect(result.dataQuality).toEqual({
      status: "partial",
      costCoverage: { knownLines: 1, totalLines: 2 },
      warnings: ["commercial_snapshot_partial", "historical_cost_evidence_incomplete"],
    });
  });

  it("fails closed for missing canonical history and never falls back to original facts", async () => {
    const { client, query } = clientReturning([]);

    await expect(readEffectiveOrdersV1(client, {
      scope: reportScope,
      orderIds: ["order-missing", "order-outside-scope"],
      currencyCode: "VND",
      asOf,
    })).rejects.toMatchObject({
      code: "effective_order_data_quality",
      statusCode: 422,
      details: {
        issues: [
          { orderId: "order-missing", reason: "missing_revision" },
          { orderId: "order-outside-scope", reason: "missing_revision" },
        ],
      },
    });

    const sql = String(query.mock.calls[0]?.[0] || "").toLowerCase();
    expect(sql).not.toContain('public."order"');
    expect(sql).not.toContain("order_item");
  });

  it.each([
    {
      name: "missing components",
      mutate: (row: ProjectionRow) => ({ ...row, total_minor: null }),
      reason: "missing_components",
    },
    {
      name: "line arithmetic mismatch",
      mutate: (row: ProjectionRow) => ({ ...row, line_total_minor: "999" }),
      reason: "invalid_projection",
    },
    {
      name: "unsafe integer money",
      mutate: (row: ProjectionRow) => ({ ...row, total_minor: "9007199254740992" }),
      reason: "invalid_projection",
    },
    {
      name: "complete quality with missing cost evidence",
      mutate: (row: ProjectionRow) => ({
        ...row,
        cost_minor: null,
        cost_evidence_id: null,
      }),
      reason: "invalid_projection",
    },
  ])("fails closed for $name", async ({ mutate, reason }) => {
    const fixture = EFFECTIVE_ORDER_FIXTURES[0]!;
    const { client } = clientReturning(rowsForFixture(fixture).map(mutate));

    await expect(readEffectiveOrderV1(client, {
      scope: reportScope,
      orderId: fixture.input.orderId,
      currencyCode: "VND",
      asOf,
    })).rejects.toMatchObject({
      code: "effective_order_data_quality",
      details: { issues: [{ orderId: fixture.input.orderId, reason }] },
    });
  });

  it("rejects duplicate lines as malformed history", async () => {
    const fixture = EFFECTIVE_ORDER_FIXTURES[0]!;
    const row = rowsForFixture(fixture)[0]!;
    const { client } = clientReturning([row, row]);

    await expect(readEffectiveOrderV1(client, {
      scope: reportScope,
      orderId: fixture.input.orderId,
      currencyCode: "VND",
      asOf,
    })).rejects.toBeInstanceOf(EffectiveOrderProjectionError);
  });

  it("validates explicit time, currency and the maximum 200-order batch before querying", async () => {
    const { client, query } = clientReturning([]);

    await expect(readEffectiveOrdersV1(client, {
      scope: reportScope,
      orderIds: Array.from({ length: 201 }, (_, index) => `order-${index}`),
      currencyCode: "VND",
      asOf,
    })).rejects.toMatchObject({ code: "validation_error" });
    await expect(readEffectiveOrdersV1(client, {
      scope: reportScope,
      orderIds: ["order-1"],
      currencyCode: "USD",
      asOf,
    })).rejects.toMatchObject({ code: "validation_error" });
    await expect(readEffectiveOrdersV1(client, {
      scope: reportScope,
      orderIds: ["order-1"],
      currencyCode: "VND",
      asOf: "2026-08-05",
    })).rejects.toMatchObject({ code: "validation_error" });
    expect(query).not.toHaveBeenCalled();
  });
});
