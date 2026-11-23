import { seedPartnerReadFixture } from "./helpers/partner-read-fixture";
import { Pool, type PoolClient } from "pg";
import { randomBytes } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { requireSafeTestDatabaseTarget, assertSafeTestDatabaseSentinel } from "../db/test-database-target";
import { readPartnerIdentity, readPartnerMcpIdentity, selectPartnerStore, partnerMe } from "../partner/registry";
import { readPartnerCatalog, readPartnerCatalogSummary } from "../partner/catalog";
import { isPartnerSchema, partnerScopes, type PartnerScope } from "@medusa-snus/contracts/partner-api";
import { decodePartnerCursor, encodePartnerCursor } from "../partner/fingerprints";
import { generatePartnerMcpKey } from "../partner/mcp-key";

let pool: Pool;
let db: PoolClient;
const keys = { current: "v1", keys: { v1: randomBytes(32).toString("base64url") } };
const token = { issuer: "https://pr.invalid", clientId: "reads", subject: "subject", scopes: partnerScopes, expiresAt: 9999999999 };
async function identity() { return readPartnerIdentity(db, token, "sandbox", "req_reads", "trace_reads"); }
async function readonly() {
  await db.query("SET LOCAL ROLE snus_partner_api; SET LOCAL transaction_read_only=on");
  expect((await db.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
}
async function context(store = "pr_s1", scope: PartnerScope | readonly PartnerScope[] = "inventory:read") {
  return selectPartnerStore(await identity(), store, scope);
}

beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString, max: 1 });
  db = await pool.connect();
  await assertSafeTestDatabaseSentinel(db, target);
});
afterAll(async () => { db?.release(); await pool?.end(); });
beforeEach(async () => {
  await db.query("BEGIN");
  await seedPartnerReadFixture(db);
});
afterEach(async () => { await db.query("ROLLBACK"); });

describe("S3 primary PostgreSQL reads with public role and server read-only transaction", () => {
  it("returns contract identity and explicit capability without provisioning", async () => {
    await readonly();
    const me = partnerMe(await identity());
    expect(me.writes_enabled).toBe(true);
    expect(me.integration_id).toBe("pr_i");
    expect(isPartnerSchema("MeResponse", { data: me, meta: { request_id: "req_reads" } })).toBe(true);
  });
  it("never unions store A write scope into store B", async () => {
    await readonly();
    const id = await identity();
    expect(selectPartnerStore(id, "pr_s1", "orders:write", true).storeId).toBe("pr_s1");
    expect(() => selectPartnerStore(id, "pr_s2", "orders:write", true)).toThrowError(expect.objectContaining({ code: "insufficient_scope" }));
  });
  it("intersects token scopes with selected-store grants", async () => {
    await readonly();
    const id = await readPartnerIdentity(db, { ...token, scopes: ["inventory:read"] }, "sandbox", "req_reads", "trace_reads");
    expect(() => selectPartnerStore(id, "pr_s1", "orders:write", true)).toThrowError(expect.objectContaining({ code: "insufficient_scope" }));
  });
  it("rejects an ungranted store without returning catalog", async () => {
    await readonly();
    await expect(context("foreign")).rejects.toMatchObject({ code: "store_not_allowed" });
  });
  it.each(["subject", "environment", "client"])("rejects wrong verified %s registry mapping", async (field) => {
    await readonly();
    const changed = { ...token, ...(field === "subject" ? { subject: "different" } : field === "client" ? { clientId: "foreign" } : {}) };
    await expect(readPartnerIdentity(db, changed, field === "environment" ? "production" : "sandbox", "req", "trace"))
      .rejects.toMatchObject({ code: "invalid_token" });
  });
  it.each(["client", "integration", "partner", "merchant"])("fails closed for inactive %s", async (kind) => {
    const statements: Record<string, string> = {
      client: "UPDATE integration.clients SET status='revoked' WHERE id='pr_c'",
      integration: "UPDATE integration.integrations SET status='paused' WHERE id='pr_i'",
      partner: "UPDATE integration.partners SET status='revoked' WHERE id='pr_p'",
      merchant: "UPDATE app.merchants SET status='inactive' WHERE id='pr_m'",
    };
    await db.query(statements[kind]);
    await readonly();
    await expect(identity()).rejects.toMatchObject({ code: "integration_disabled" });
  });
  it("denies retired credentials while their JWT is still cryptographically valid", async () => {
    await db.query("UPDATE integration.clients SET retire_at=now()-interval '1 second' WHERE id='pr_c'");
    await readonly();
    await expect(identity()).rejects.toMatchObject({ code: "integration_disabled" });
  });
  it.each(["missing", "expired", "no-feature", "paused"])("allows scoped reconciliation but denies writes when capability is %s", async (kind) => {
    const statements: Record<string, string> = {
      missing: "DELETE FROM app.merchant_subscriptions WHERE id='pr_sub'",
      expired: "UPDATE app.merchant_subscriptions SET current_period_start=now()-interval '40 days',current_period_end=now()-interval '9 days' WHERE id='pr_sub'",
      "no-feature": "UPDATE app.package_catalog_versions SET feature_keys='[]' WHERE id='pr_cat'",
      paused: "UPDATE integration.integrations SET writes_enabled=false WHERE id='pr_i'",
    };
    await db.query(statements[kind]);
    await readonly();
    const id = await identity();
    expect(partnerMe(id).writes_enabled).toBe(false);
    expect(selectPartnerStore(id, "pr_s2", "orders:read").storeId).toBe("pr_s2");
    expect(() => selectPartnerStore(id, "pr_s1", "orders:write", true)).toThrowError(expect.objectContaining({
      code: kind === "paused" ? "integration_disabled" : "merchant_capability_denied",
    }));
  });
  it("uses bounded subscription grace without a lazy update", async () => {
    await db.query("UPDATE app.merchant_subscriptions SET current_period_start=now()-interval '40 days',current_period_end=now()-interval '1 day' WHERE id='pr_sub'");
    await readonly();
    expect(partnerMe(await identity()).writes_enabled).toBe(true);
  });
  it("returns exact location stock minus safety, missing level zero and clamps negatives", async () => {
    await readonly();
    const a = await readPartnerCatalog(db, await context(), keys, { limit: 20 }, true);
    expect(a.data.map((v) => [v.variant_id, "available_quantity" in v ? v.available_quantity : null]))
      .toEqual([["pr_v1", 8], ["pr_v2", 0], ["pr_v3", 0]]);
    expect(isPartnerSchema("InventoryResponse", a)).toBe(true);
    const b = await readPartnerCatalog(db, await context("pr_s2"), keys, { limit: 20, variant_ids: ["pr_v1", "foreign"] }, true);
    expect(b.data).toHaveLength(1);
    expect(b.data[0]).toMatchObject({ available_quantity: 38, store_id: "pr_s2" });
  });
  it("returns one repeatable-read catalog aggregate with explicit scope and safe per-variant totals", async () => {
    await readonly();
    const summary = await readPartnerCatalogSummary(db, await context("pr_s1", ["catalog:read", "inventory:read"]));
    expect(summary.data).toMatchObject({ store_id: "pr_s1", catalog_mode: "explicit", catalog_scope: "eligible_published_variants",
      inventory_complete: true, product_count: 1, sku_count: 3, available_sku_count: 1, out_of_stock_sku_count: 2,
      unavailable_sku_count: 0, available_quantity_sum: 8 });
    expect(new Date(summary.data.as_of).toString()).not.toBe("Invalid Date");
    expect(isPartnerSchema("CatalogSummaryResponse", summary)).toBe(true);
  });
  it("marks a summary incomplete rather than guessing a stock total", async () => {
    await db.query("UPDATE public.product_variant SET manage_inventory=false WHERE id='pr_v1'");
    await readonly();
    const summary = await readPartnerCatalogSummary(db, await context("pr_s1", ["catalog:read", "inventory:read"]));
    expect(summary.data).toMatchObject({ inventory_complete: false, available_sku_count: 0, out_of_stock_sku_count: 2,
      unavailable_sku_count: 1, available_quantity_sum: null });
  });
  it("labels per-variant quantity and warns when variants share one physical inventory item", async () => {
    await db.query("UPDATE public.product_variant_inventory_item SET inventory_item_id='pr_item1' WHERE variant_id='pr_v2'");
    await readonly();
    const summary = await readPartnerCatalogSummary(db, await context("pr_s1", ["catalog:read", "inventory:read"]));
    expect(summary.data).toMatchObject({ quantity_basis: "per_variant", has_shared_inventory_items: true,
      available_quantity_sum: 16, available_sku_count: 2, sku_count: 3 });
    expect(isPartnerSchema("CatalogSummaryResponse", summary)).toBe(true);
  });
  it.each([2.5, -2.5])("summary and inventory both reject fractional per-SKU stock %s even when the sum is an integer", async (stocked) => {
    await db.query("UPDATE public.inventory_level SET stocked_quantity=$1 WHERE location_id='pr_l1' AND inventory_item_id IN ('pr_item1','pr_item3')", [stocked]);
    await readonly();
    const ctx = await context("pr_s1", ["catalog:read", "inventory:read"]);
    const inventory = await readPartnerCatalog(db, ctx, keys, { limit: 20 }, true);
    expect(inventory.data.filter((row) => row.variant_id !== "pr_v2")).toEqual([
      expect.objectContaining({ variant_id: "pr_v1", availability_status: "unavailable", available_quantity: null }),
      expect.objectContaining({ variant_id: "pr_v3", availability_status: "unavailable", available_quantity: null }),
    ]);
    const summary = await readPartnerCatalogSummary(db, ctx);
    expect(summary.data).toMatchObject({ inventory_complete: false, available_sku_count: 0,
      out_of_stock_sku_count: 1, unavailable_sku_count: 2, available_quantity_sum: null });
  });
  it("uses merchant-published mode only for an authenticated MCP key and keeps OAuth explicit", async () => {
    const key = generatePartnerMcpKey("sandbox");
    await db.query(`INSERT INTO integration.partner_mcp_keys(id,integration_id,label,secret_hash,scopes,created_by,expires_at)
      VALUES($1,'pr_i','Read fixture',$2,$3,'fixture-owner',clock_timestamp()+interval '1 day')`, [key.keyId, key.secretHash, partnerScopes]);
    await db.query("UPDATE integration.store_grants SET mcp_catalog_mode='merchant_published' WHERE integration_id='pr_i' AND store_id='pr_s1'");
    await db.query(`INSERT INTO public.product(id,title,handle,status,merchant_id) VALUES
      ('pr_extra_product','Extra published product','pr_extra_product','published','pr_m');
      INSERT INTO public.product_variant(id,title,sku,product_id) VALUES ('pr_v4','Extra','pr_sku4','pr_extra_product')`);
    await readonly();
    const oauth = selectPartnerStore(await identity(), "pr_s1", "catalog:read");
    const mcpIdentity = await readPartnerMcpIdentity(db, `Bearer ${key.key}`, "sandbox", "req_mcp", "trace_mcp");
    const mcp = selectPartnerStore(mcpIdentity, "pr_s1", "catalog:read");
    expect(oauth.catalogMode).toBe("explicit");
    expect(mcp.catalogMode).toBe("merchant_published");
    const [oauthCatalog, mcpCatalog] = await Promise.all([
      readPartnerCatalog(db, oauth, keys, { limit: 20 }), readPartnerCatalog(db, mcp, keys, { limit: 20 }),
    ]);
    expect(oauthCatalog.data.map((row) => row.variant_id)).not.toContain("pr_v4");
    expect(mcpCatalog.data.map((row) => row.variant_id)).toContain("pr_v4");
    const oauthIdentity = await identity();
    expect(() => selectPartnerStore(oauthIdentity, "pr_s2", ["catalog:read", "inventory:read"])).toThrowError(expect.objectContaining({ code: "insufficient_scope" }));
  });
  it("paginates safe products by signed keyset and excludes foreign filter IDs", async () => {
    await readonly();
    const ctx = await context();
    const first = await readPartnerCatalog(db, ctx, keys, { limit: 2 });
    expect(isPartnerSchema("ProductsResponse", first)).toBe(true);
    expect(first.data.map((v) => v.variant_id)).toEqual(["pr_v1", "pr_v2"]);
    const last = await readPartnerCatalog(db, ctx, keys, { limit: 2, cursor: first.page.next_cursor! });
    expect(last.data.map((v) => v.variant_id)).toEqual(["pr_v3"]);
    expect(last.page.next_cursor).toBeNull();
    expect(Object.keys(last.data[0]).sort()).toEqual(["sku", "title", "variant_id"]);
  });
  it.each(["deleted-item", "multi-component", "quantity-two", "unmanaged", "backorder", "reserved-location"])("marks unsupported %s inventory unavailable", async (kind) => {
    const statements: Record<string, string> = {
      "deleted-item": "UPDATE public.inventory_item SET deleted_at=now() WHERE id='pr_item1'",
      "multi-component": "INSERT INTO public.product_variant_inventory_item(id,variant_id,inventory_item_id) VALUES ('pr_extra','pr_v1','pr_item2')",
      "quantity-two": "UPDATE public.product_variant_inventory_item SET required_quantity=2 WHERE id='pr_map1'",
      unmanaged: "UPDATE public.product_variant SET manage_inventory=false WHERE id='pr_v1'",
      backorder: "UPDATE public.product_variant SET allow_backorder=true WHERE id='pr_v1'",
      "reserved-location": "UPDATE public.inventory_level SET reserved_quantity=1 WHERE id='pr_il3'",
    };
    await db.query(statements[kind]);
    await readonly();
    const result = await readPartnerCatalog(db, await context(), keys, { limit: 20, variant_ids: ["pr_v1"] }, true);
    expect(result.data[0]).toMatchObject({ availability_status: "unavailable", available_quantity: null });
  });
  it.each(["unpublished", "deleted", "not-assorted"])("omits %s variants without leaking why", async (kind) => {
    const statements: Record<string, string> = {
      unpublished: "UPDATE public.product SET status='draft' WHERE id='pr_product'",
      deleted: "UPDATE public.product_variant SET deleted_at=now() WHERE id='pr_v1'",
      "not-assorted": "DELETE FROM integration.assortment_items WHERE variant_id='pr_v1'",
    };
    await db.query(statements[kind]);
    await readonly();
    const result = await readPartnerCatalog(db, await context(), keys, { limit: 20, variant_ids: ["pr_v1"] }, true);
    expect(result.data).toEqual([]);
  });
  it("omits a live foreign-merchant variant in both explicit and merchant-published catalogs", async () => {
    await db.query(`INSERT INTO public.product(id,title,handle,status,merchant_id) VALUES ('pr_foreign_product','Foreign','pr_foreign_product','published','pr_other');
      INSERT INTO public.product_variant(id,title,sku,product_id) VALUES ('pr_foreign_variant','Foreign','FOREIGN','pr_foreign_product')`);
    await readonly();
    const ctx = await context();
    for (const catalogMode of ["explicit", "merchant_published"] as const) {
      const result = await readPartnerCatalog(db, { ...ctx, catalogMode }, keys, { limit: 20, variant_ids: ["pr_foreign_variant"] }, true);
      expect(result.data).toEqual([]);
    }
  });
  it.each(["tamper", "store", "integration", "grant", "assortment", "mode", "filter"])("rejects cursor with changed %s", async (kind) => {
    await readonly();
    const ctx = await context();
    const filter = { operation: "inventory", catalogMode: ctx.catalogMode, variantIds: [] };
    let cursor = encodePartnerCursor(keys, ctx, filter, ["pr_v1"]);
    const nextCtx = { ...ctx };
    if (kind === "tamper") cursor += "0";
    if (kind === "store") nextCtx.storeId = "pr_s2";
    if (kind === "integration") nextCtx.integrationId = "other";
    if (kind === "grant") nextCtx.storeGrantVersion++;
    if (kind === "assortment") nextCtx.assortmentVersion++;
    if (kind === "mode") nextCtx.catalogMode = "merchant_published";
    expect(() => decodePartnerCursor(keys, nextCtx, kind === "filter" ? {} : filter, cursor))
      .toThrowError(expect.objectContaining({ code: "invalid_cursor" }));
  });
  it("public read role cannot read cost or write core stock", async () => {
    await readonly();
    await db.query("SAVEPOINT denied");
    await expect(db.query("UPDATE public.inventory_level SET stocked_quantity=999 WHERE id='pr_il1'"))
      .rejects.toMatchObject({ code: "25006" });
    await db.query("ROLLBACK TO SAVEPOINT denied");
    await expect(db.query("SELECT metadata FROM public.product WHERE id='pr_product'"))
      .rejects.toMatchObject({ code: "42501" });
  });
});
