import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { requireSafeTestDatabaseTarget, assertSafeTestDatabaseSentinel } from "../db/test-database-target";

let pool: Pool;
let reader: PoolClient;
let writer: PoolClient;
let priceSet: string;
let priceId: string;
let productId: string;
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString });
  reader = await pool.connect(); writer = await pool.connect();
  await assertSafeTestDatabaseSentinel(reader, target);
  const row = (await reader.query(`SELECT v.product_id, ps.price_set_id, p.id AS price_id
    FROM public.product_variant v JOIN public.product_variant_price_set ps ON ps.variant_id=v.id AND ps.deleted_at IS NULL
    JOIN public.price p ON p.price_set_id=ps.price_set_id AND p.deleted_at IS NULL AND p.currency_code='vnd'
    WHERE v.id='var_mint_20'`)).rows[0];
  priceSet = row.price_set_id; priceId = row.price_id; productId = row.product_id;
});
beforeEach(async () => {
  await reader.query("BEGIN"); await writer.query("BEGIN");
  await writer.query("SET LOCAL lock_timeout='150ms'; SET LOCAL statement_timeout='2s'");
});
afterEach(async () => { await reader.query("ROLLBACK"); await writer.query("ROLLBACK"); });
afterAll(async () => { reader?.release(); writer?.release(); await pool?.end(); });

async function lockInputs(ids = ["var_mint_20"]) {
  await reader.query("SELECT integration.lock_commerce_inputs('merchant_default',$1::text[])", [ids]);
}
async function expectSerialized(sql: string, parameters: unknown[]) {
  await writer.query("SAVEPOINT blocked_writer");
  await expect(writer.query(sql, parameters)).rejects.toMatchObject({ code: "55P03" });
  await writer.query("ROLLBACK TO SAVEPOINT blocked_writer");
  await reader.query("ROLLBACK");
  await expect(writer.query(sql, parameters)).resolves.toBeDefined();
}
describe("real PostgreSQL commerce parent-lock protocol", () => {
  it.each(["UPDATE public.price SET amount=amount+1 WHERE id=$1", "DELETE FROM public.price WHERE id=$1"])(
    "serializes existing price writers: %s", async (sql) => {
      await lockInputs(); await expectSerialized(sql, [priceId]);
    });
  it("prevents new base-price rows from appearing between snapshot validation and booking", async () => {
    await lockInputs();
    await expectSerialized(`INSERT INTO public.price(id,price_set_id,currency_code,amount,raw_amount)
      VALUES('price_partner_lock_probe',$1,'vnd',12345,'{"value":"12345","precision":20}')`, [priceSet]);
  });
  it.each([
    "UPDATE public.product_variant_price_set SET deleted_at=now() WHERE variant_id=$1",
    "DELETE FROM public.product_variant_price_set WHERE variant_id=$1",
    "UPDATE public.product_variant_inventory_item SET required_quantity=2 WHERE variant_id=$1",
    "DELETE FROM public.product_variant_inventory_item WHERE variant_id=$1",
    "UPDATE public.product_variant SET deleted_at=now() WHERE id=$1",
  ])("serializes product mapping/model changes: %s", async (sql) => {
    await lockInputs(); await expectSerialized(sql, ["var_mint_20"]);
  });
  it("prevents a variant insert from changing legacy product-id resolution", async () => {
    await lockInputs([productId]);
    await expectSerialized(`INSERT INTO public.product_variant(id,title,product_id)
      VALUES('var_partner_lock_probe','Synthetic lock probe',$1)`, [productId]);
  });
  it("allows two readers with reversed item ordering without mutual exclusion", async () => {
    await lockInputs(["var_mint_20", "var_citrus_20"]);
    await expect(writer.query("SELECT integration.lock_commerce_inputs('merchant_default',$1::text[])",
      [["var_citrus_20", "var_mint_20"]])).resolves.toBeDefined();
  });
  it("serializes moving a variant into the product whose expansion is locked", async () => {
    await lockInputs([productId]);
    await expectSerialized("UPDATE public.product_variant SET product_id=$1 WHERE id='var_citrus_20'", [productId]);
  });
  it("aborts reservation writers immediately instead of waiting child-to-parent against booking", async () => {
    const row=(await writer.query("SELECT id,location_id FROM public.inventory_level WHERE inventory_item_id=(SELECT inventory_item_id FROM public.product_variant_inventory_item WHERE variant_id='var_mint_20' LIMIT 1) LIMIT 1")).rows[0];
    await writer.query("SELECT id FROM public.inventory_level WHERE id=$1 FOR UPDATE",[row.id]);
    await reader.query("SELECT id FROM public.stock_location WHERE id=$1 FOR SHARE",[row.location_id]);
    await writer.query("SET LOCAL lock_timeout='5s'");
    const started=performance.now();
    await expect(writer.query("UPDATE public.inventory_level SET reserved_quantity=reserved_quantity+1 WHERE id=$1",[row.id])).rejects.toMatchObject({code:"55P03"});
    expect(performance.now()-started).toBeLessThan(500);
    await writer.query("ROLLBACK");
    await expect(reader.query("SELECT id FROM public.inventory_level WHERE id=$1 FOR UPDATE",[row.id])).resolves.toBeDefined();
  });
  it("aborts variant reparent immediately when a reader holds its destination product",async()=>{
    await writer.query("SELECT id FROM public.product_variant WHERE id='var_citrus_20' FOR UPDATE");
    await reader.query("SELECT id FROM public.product WHERE id=$1 FOR SHARE",[productId]);
    await writer.query("SET LOCAL lock_timeout='5s'");
    const started=performance.now();
    await expect(writer.query("UPDATE public.product_variant SET product_id=$1 WHERE id='var_citrus_20'",[productId])).rejects.toMatchObject({code:"55P03"});
    expect(performance.now()-started).toBeLessThan(500);
  });
  it("exposes only the lock function to the restricted API role", async () => {
    await reader.query("SET LOCAL ROLE snus_partner_api");
    await lockInputs();
    await expect(reader.query("UPDATE public.price SET amount=1 WHERE id=$1", [priceId]))
      .rejects.toMatchObject({ code: "42501" });
  });
});
