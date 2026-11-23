import { describe, expect, it } from "vitest";
import {
  isPartnerSchema, normalizePartnerQuote, partnerOpenApi,
  PartnerOrderQuery, PartnerInventoryQuery, PartnerProductQuery, PartnerCatalogSummaryQuery,
} from "../partner-api";

const quote = { store_id: "store_a", items: [{ variant_id: "variant_a", quantity: 2 }], fulfillment_mode: "pickup" as const };
const order = { store_id: "store_a", quote_id: "pq_a", external_order_id: "external_a", payment_method: "cod", fulfillment: { mode: "pickup" } };

describe("Partner public v1 contract", () => {
  it.each([
    { paymentFeeType: "percent", paymentFeeValue: 0 }, { paymentFeeType: "percent", paymentFeeValue: 2 },
    { payment_fee_type: "amount", payment_fee_value: 1000 }, { paymentFeeMinor: 1000 },
  ])("refuses unsupported payment fees instead of stripping them from quote or COD booking: %j", fee => {
    for (const [schema, input] of [["QuoteRequest", quote], ["OrderRequest", order]] as const) {
      const body = { ...input, ...fee }, bytes = JSON.stringify(body);
      expect(isPartnerSchema(schema, body)).toBe(false);
      expect(JSON.stringify(body)).toBe(bytes);
      expect(isPartnerSchema(schema, input)).toBe(true);
    }
  });
  it("provides all eight supported operations in the public contract", () => {
    expect(Object.values(partnerOpenApi.paths).flatMap(Object.keys)).toHaveLength(8);
  });
  it.each(["merchant_id", "actor_id", "amount_received", "price", "paid", "discount", "customer_id"])("rejects mass assignment of %s", (field) => {
    expect(isPartnerSchema("OrderRequest", { ...order, [field]: 1 })).toBe(false);
    expect(isPartnerSchema("QuoteRequest", { ...quote, [field]: 1 })).toBe(false);
  });
  it.each([0, -1, 1.5, 101, NaN, Infinity, "2", null])("rejects invalid quantity %s", (quantity) => {
    expect(isPartnerSchema("QuoteRequest", { ...quote, items: [{ variant_id: "variant_a", quantity }] })).toBe(false);
  });
  it("accepts COD and requires all delivery contact fields while rejecting unexpected fields", () => {
    expect(isPartnerSchema("OrderRequest", order)).toBe(true);
    expect(isPartnerSchema("OrderRequest", { ...order, payment_method: "cash" })).toBe(false);
    expect(isPartnerSchema("OrderRequest", { ...order, fulfillment: { mode: "delivery" } })).toBe(false);
    expect(isPartnerSchema("OrderRequest", { ...order, fulfillment: { mode: "delivery", recipient_name: "Synthetic", phone: "000", address: "Fixture" } })).toBe(true);
    expect(isPartnerSchema("OrderRequest", { ...order, fulfillment: { mode: "pickup", address: "Fixture" } })).toBe(false);
  });
  it("rejects empty or excessive carts and empty external reference", () => {
    expect(isPartnerSchema("QuoteRequest", { ...quote, items: [] })).toBe(false);
    expect(isPartnerSchema("QuoteRequest", { ...quote, items: Array(51).fill(quote.items[0]) })).toBe(false);
    expect(isPartnerSchema("OrderRequest", { ...order, external_order_id: "" })).toBe(false);
  });
  it("aggregates duplicate variants before the quantity cap and sorts deterministically", () => {
    expect(normalizePartnerQuote({ ...quote, items: [{ variant_id: "b", quantity: 2 }, { variant_id: "a", quantity: 1 }, { variant_id: "b", quantity: 3 }] }).items)
      .toEqual([{ variant_id: "a", quantity: 1 }, { variant_id: "b", quantity: 5 }]);
    expect(() => normalizePartnerQuote({ ...quote, items: [{ variant_id: "a", quantity: 100 }, { variant_id: "a", quantity: 1 }] })).toThrow();
  });
  it.each([
    ["available", null, false], ["available", 0, false], ["available", 1, true],
    ["unavailable", null, true], ["unavailable", 1, false],
    ["out_of_stock", 0, true], ["out_of_stock", 1, false],
  ])("keeps availability %s and quantity %s consistent", (availability_status, available_quantity, valid) => {
    expect(isPartnerSchema("InventoryItem", { variant_id: "v", store_id: "s", as_of: "2026-09-12T00:00:00Z", availability_status, available_quantity })).toBe(valid);
  });
  it.each([
    { external_order_id: "x", cursor: "cursor" },
    { date_from: "2026-09-01T00:00:00Z" },
    { date_from: "2026-09-01T00:00:00Z", date_to: "2026-08-01T00:00:00Z" },
    { date_from: "2026-09-01T00:00:00Z", date_to: "2026-11-01T00:00:00Z" },
    { limit: "101" }, { limit: "2.5" }, { merchant_id: "other" },
  ])("rejects unbounded or conflicting order query %j", (query) => {
    expect(PartnerOrderQuery.safeParse({ store_id: "s", ...query }).success).toBe(false);
  });
  it("supports external-reference lookup without imposing the default date window", () => {
    expect(PartnerOrderQuery.parse({ store_id: "s", external_order_id: "old_order" }))
      .toEqual({ store_id: "s", external_order_id: "old_order", limit: 20 });
  });
  it("rejects duplicate query parameters, unknown filters and duplicate variant IDs", () => {
    expect(PartnerProductQuery.safeParse({ store_id: ["a", "b"] }).success).toBe(false);
    expect(PartnerProductQuery.safeParse({ store_id: "a", token: "fake" }).success).toBe(false);
    expect(PartnerInventoryQuery.safeParse({ store_id: "a", variant_ids: "v,v" }).success).toBe(false);
  });
  it("keeps catalog summary store-scoped without pagination or caller-selected mode", () => {
    expect(PartnerCatalogSummaryQuery.safeParse({ store_id: "s" }).success).toBe(true);
    expect(PartnerCatalogSummaryQuery.safeParse({ store_id: "s", limit: "1" }).success).toBe(false);
    expect(PartnerCatalogSummaryQuery.safeParse({ store_id: "s", mcp_catalog_mode: "merchant_published" }).success).toBe(false);
    expect(isPartnerSchema("CatalogSummaryResponse", {data:{store_id:"s",as_of:"2026-10-18T00:00:00Z",
      catalog_mode:"explicit",catalog_scope:"eligible_published_variants",quantity_basis:"per_variant",has_shared_inventory_items:false,inventory_complete:true,product_count:1,sku_count:1,
      available_sku_count:1,out_of_stock_sku_count:0,unavailable_sku_count:0,available_quantity_sum:1},meta:{request_id:"r"}})).toBe(true);
  });
});
