import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 } from "@medusa-snus/contracts/runtime-capabilities";

const mocks = vi.hoisted(() => ({ query: vi.fn(), preview: vi.fn(), apply: vi.fn() }));
vi.mock("../db/schema", () => ({ ensurePlatformSchema: vi.fn() }));
vi.mock("../db/transaction", () => ({
  withConnectedClient: (read: (client: unknown) => Promise<unknown>) => read({ query: mocks.query }),
  withConnectedTransaction: vi.fn(),
}));
vi.mock("../services/order-correction-service", () => ({
  getOrderCorrectionProjectionForClient: vi.fn(async () => ({
    effectiveTotals: null, effectiveItems: null, correctionSummary: { latestRevision: 0 }, corrections: [],
  })),
  previewOrderCorrection: mocks.preview,
  applyOrderCorrection: mocks.apply,
}));

import { createOrderExportCsv, getOrder, listOrders, prepareOrderRecreatePrefill, previewOrderShippingFee, updateOrderShippingFee } from "../services/order-service";

const scope = { scopeKind: "operating" as const, merchantId: "merchant-a", storeId: "store-a", stockLocationId: "stock-a" };
const reportScope = { merchantId: scope.merchantId, storeIds: [scope.storeId] };
const actor = { operatorId: "owner-a", role: "owner", organizationId: "org-a" };
let row: Record<string, unknown> | null;
let canonical: { payment_fee_minor?: string; payment_fee_vat_minor?: string } | null;
const feeQueries = () => mocks.query.mock.calls.filter(([sql]) => sql.includes("app.order_commercial_revisions"));

beforeEach(() => {
  vi.clearAllMocks();
  row = { id: "order-a", merchant_id: scope.merchantId, store_id: scope.storeId, order_number: "ORD-A", status: "completed", metadata: { total: 240320 } };
  canonical = { payment_fee_minor: "4320", payment_fee_vat_minor: "393" };
  mocks.query.mockImplementation(async (sql: string) => {
    const hasFee = !!canonical && (Number(canonical.payment_fee_minor ?? 0) !== 0 || Number(canonical.payment_fee_vat_minor ?? 0) !== 0);
    if (sql.includes("AS total_count")) return { rows: [{ total_count: "1", incompatible_fee_count: hasFee ? "1" : "0" }] };
    if (sql.includes("AS order_id")) return { rows: hasFee ? [{ incompatible_fee: true, order_id: "order-a" }] : [] };
    if (sql.includes("SELECT o.id")) return { rows: [] };
    if (sql.includes("app.order_commercial_revisions")) {
      return { rows: hasFee ? [{ has_fee: true }] : [] };
    }
    if (sql.includes('FROM public."order" o')) return { rows: row ? [row] : [] };
    if (["public.order_item", "audit.events", "app.payment_entries", "app.commercial_obligations", "app.payment_events"]
      .some(table => sql.includes(`FROM ${table}`))) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  mocks.preview.mockResolvedValue({ data: {
    beforeTotals: { shippingFee: 0, shippingTax: 0, shippingRevenue: 0, total: 240320 },
    afterTotals: { shippingFee: 100, shippingTax: 0, shippingRevenue: 100, total: 240420 }, totalDelta: 100,
  } });
  mocks.apply.mockResolvedValue({ response: { data: { orderId: "order-a" } } });
});

describe("raw legacy order read compatibility", () => {
  const reads = [
    ["detail", () => getOrder("order-a", reportScope)],
    ["recreate", () => prepareOrderRecreatePrefill("order-a", scope)],
  ] as const;

  for (const [name, read] of reads) {
    it.each([
      ["fee", "4320", "0"], ["fee VAT", "0", "393"], ["smallest nonzero fee", "1", "0"],
    ])(`${name} refuses %s instead of returning an incomplete financial view`, async (_label, fee, vat) => {
      canonical = { payment_fee_minor: fee, payment_fee_vat_minor: vat };
      await expect(read()).rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 });
      expect(feeQueries()[0]?.[1]).toEqual(["order-a", scope.merchantId, scope.storeId]);
    });

    it(`${name} also refuses a cancelled fee-bearing order`, async () => {
      row!.status = "canceled";
      await expect(read()).rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 });
    });

    it.each([null, {}, { payment_fee_minor: "0", payment_fee_vat_minor: "0" }])(
      `${name} keeps pre-canonical, V1 and explicit-zero V2 orders readable (%j)`, async value => {
        canonical = value;
        await expect(read()).resolves.toBeDefined();
      },
    );

    it.each(["merchant_id", "store_id"])(`${name} denies foreign %s before consulting fees`, async field => {
      row![field] = "foreign";
      await expect(read()).rejects.toMatchObject({ code: name === "detail" ? "resource_not_found" : "forbidden" });
      expect(feeQueries()).toEqual([]);
    });

    it(`${name} preserves missing-order behavior`, async () => {
      row = null;
      await expect(read()).rejects.toMatchObject({ code: "resource_not_found", statusCode: 404 });
      expect(feeQueries()).toEqual([]);
    });
  }

  it("keeps the explicit internal fee-aware detail read available", async () => {
    await expect(getOrder("order-a", reportScope, undefined, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1))
      .resolves.toMatchObject({ order: { orderId: "order-a", total: 240320 } });
    expect(feeQueries()).toEqual([]);
  });

  it("keeps both shipping preview and post-correction response on the fee-aware internal path", async () => {
    const input = { shippingFee: 100, reason: "Adjust delivery charge", paymentMethod: "cash" };
    const preview = await previewOrderShippingFee("order-a", input, actor, scope);
    expect(preview.data.totalDelta).toBe(100);
    await expect(updateOrderShippingFee({ "idempotency-key": "shipping-test" }, "order-a",
      { ...input, confirmationToken: preview.data.confirmationToken }, actor, scope))
      .resolves.toMatchObject({ statusCode: 200, response: { order: { orderId: "order-a" } } });
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(feeQueries()).toEqual([]);
  });

  it("refuses a full filtered list cohort even when its fee order is outside the requested page", async () => {
    await expect(listOrders({ ...reportScope, customer_id: "customer-a", dateFrom: "2026-10-01", dateTo: "2026-10-30", limit: 1 }))
      .rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 });
    expect(mocks.query).toHaveBeenCalledOnce();
    const [sql, params] = mocks.query.mock.calls[0]!;
    expect(sql).not.toContain("LIMIT");
    expect(params).toEqual(["customer-a", scope.merchantId, [scope.storeId], "2026-10-01", "2026-10-30"]);
  });

  it("refuses CSV before serializing a fee-bearing row while preserving its scope and filters", async () => {
    await expect(createOrderExportCsv({ dateFrom: "2026-10-01", dateTo: "2026-10-30", status: "completed", search: "mint" },
      { scopeKind: "report", ...reportScope })).rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("o.store_id = ANY($2::text[])"),
      [scope.merchantId, [scope.storeId], "2026-10-01", "2026-10-30", "%mint%"]);
  });

  it.each([null, {}, { payment_fee_minor: "0", payment_fee_vat_minor: "0" }])("keeps fee-free raw list/CSV results readable (%j)", async value => {
    canonical = value;
    await expect(listOrders({ ...reportScope, limit: 1 })).resolves.toMatchObject({ orders: [], totalCount: 1 });
    await expect(createOrderExportCsv({ dateFrom: "2026-10-01", dateTo: "2026-10-30" }, { scopeKind: "report", ...reportScope }))
      .resolves.toContain("order_id");
  });
});
