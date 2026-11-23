import { randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { seedPartnerReadFixture } from "./helpers/partner-read-fixture";
import { requireSafeTestDatabaseTarget, assertSafeTestDatabaseSentinel } from "../db/test-database-target";
import { createPartnerQuoteForClient } from "../partner/quotes";
import { readPartnerIdentity, selectPartnerStore } from "../partner/registry";
import { isPartnerSchema, partnerScopes, type PartnerQuoteRequest } from "@medusa-snus/contracts/partner-api";
let pool: Pool; let db: PoolClient;
const keys = { current: "v1", keys: { v1: randomBytes(32).toString("base64url") } };
const input: PartnerQuoteRequest = { store_id: "pr_s1", items: [{ variant_id: "pr_v1", quantity: 2 }], fulfillment_mode: "pickup" };
async function quote(body = input) {
  await db.query("SET LOCAL ROLE snus_partner_api");
  const identity = await readPartnerIdentity(db, { issuer: "https://pr.invalid", clientId: "reads", subject: "subject", scopes: partnerScopes, expiresAt: 9999999999 }, "sandbox", "req_quote", "a".repeat(32));
  const ctx = selectPartnerStore(identity, body.store_id, "orders:quote", true);
  await db.query("SELECT integration.lock_authorization($1,$2,$3)", [ctx.integrationId,ctx.registryClientId,ctx.storeId]);
  return createPartnerQuoteForClient(db, ctx, keys, body);
}
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString }); db = await pool.connect(); await assertSafeTestDatabaseSentinel(db, target);
});
beforeEach(async () => {
  await db.query("BEGIN"); await seedPartnerReadFixture(db);
  await db.query(`UPDATE integration.store_grants SET allowed_scopes=array_append(allowed_scopes,'orders:quote') WHERE store_id='pr_s1';
    INSERT INTO public.price_set(id,merchant_id) VALUES('pr_ps','pr_m');
    INSERT INTO public.product_variant_price_set(id,variant_id,price_set_id) VALUES('pr_vps','pr_v1','pr_ps');
    INSERT INTO public.price(id,price_set_id,currency_code,amount,raw_amount) VALUES('pr_price','pr_ps','vnd',250000,'{"value":"250000","precision":20}');`);
});
afterEach(async () => { await db.query("ROLLBACK"); });
afterAll(async () => { db?.release(); await pool?.end(); });
describe("S4 quote pricing, ownership and query-only stock", () => {
  it("persists a contract quote and durable client audit without reserving or creating an order", async () => {
    const result = await quote(); expect(isPartnerSchema("QuoteResponse", result)).toBe(true);
    expect(result.data).toMatchObject({ subtotal:500000,total:500000,shipping_fee:0,stock_reserved:false });
    const row = (await db.query("SELECT snapshot,expires_at-created_at AS ttl FROM integration.quotes WHERE id=$1", [result.data.quote_id])).rows[0];
    expect(row.ttl.minutes).toBe(5); expect(row.snapshot.fingerprintVersion).toBe("v1");
    const stock = (await db.query("SELECT stocked_quantity,reserved_quantity FROM public.inventory_level WHERE inventory_item_id='pr_item1' AND location_id='pr_l1'")).rows[0];
    expect(Number(stock.stocked_quantity)).toBe(10); expect(Number(stock.reserved_quantity)).toBe(0);
    await db.query("RESET ROLE");
    const audit = (await db.query("SELECT actor_id,channel,integration_id FROM audit.events WHERE subject_id=$1", [result.data.quote_id])).rows[0];
    expect(audit).toEqual({actor_id:"reads",channel:"partner_api",integration_id:"pr_i"});
  });
  it("normalizes duplicate lines but does not allow their combined quantity to oversell", async () => {
    await expect(quote({...input,items:[{variant_id:"pr_v1",quantity:6},{variant_id:"pr_v1",quantity:5}]})).rejects.toMatchObject({code:"insufficient_stock"});
  });
  it.each(["unknown_variant", "var_mint_20"])("hides missing or other-merchant variant %s", async variant_id => {
    await expect(quote({...input,items:[{variant_id,quantity:1}]})).rejects.toMatchObject({code:"resource_not_found"});
  });
  it("denies delivery until shipping and contact workflow are both enabled", async () => {
    await expect(quote({...input,fulfillment_mode:"delivery"})).rejects.toMatchObject({code:"shipping_policy_unavailable"});
  });
  it("denies the entire reservation-enabled location", async () => {
    await db.query("UPDATE public.inventory_level SET reserved_quantity=1 WHERE id='pr_il3'");
    await expect(quote()).rejects.toMatchObject({code:"unsupported_inventory_model"});
  });
  it.each([
    "UPDATE public.price SET amount=0.5 WHERE id='pr_price'",
    "UPDATE public.price SET rules_count=1 WHERE id='pr_price'",
    "UPDATE public.price SET min_quantity=2 WHERE id='pr_price'",
    "UPDATE public.price SET deleted_at=now() WHERE id='pr_price'",
    "INSERT INTO public.price(id,price_set_id,currency_code,amount,raw_amount) VALUES('pr_price2','pr_ps','vnd',250000,'{\"value\":\"250000\",\"precision\":20}')",
  ])("rejects ambiguous or unsupported pricing: %s", async sql => {
    await db.query(sql); await expect(quote()).rejects.toMatchObject({code:"quote_changed"});
  });
  it("changes the fingerprint when the actual price changes", async () => {
    const first = await quote(); await db.query("RESET ROLE");
    await db.query("UPDATE public.price SET amount=260000,updated_at=clock_timestamp() WHERE id='pr_price'");
    const next = await quote(); expect(next.data.pricing_version).not.toBe(first.data.pricing_version); expect(next.data.total).toBe(520000);
  });
  it("rolls back the quote if its durable audit fails", async () => {
    await db.query("SAVEPOINT audit_failure");
    await db.query("REVOKE INSERT ON audit.events FROM snus_partner_api");
    await expect(quote()).rejects.toMatchObject({code:"42501"});
    await db.query("ROLLBACK TO SAVEPOINT audit_failure");
    expect((await db.query("SELECT count(*) FROM integration.quotes WHERE integration_id='pr_i'")).rows[0].count).toBe("0");
  });
});
