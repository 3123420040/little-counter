import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPlatformClient, shutdownPlatformPool, type PoolClient } from "../db/client";
import { createProduct, getDefaultVariantRow, updateProduct } from "../services/product-management-service";
import { previewProductImport, applyProductImport } from "../services/catalog-import-export-service";
import { resolveProductScan } from "../services/product-qr-service";

const run = `codes_${Date.now()}`;
const actor = { operatorId: "op_owner", role: "owner" as const, displayName: "Fixture", organizationId: "org_default" };
const scopes = ["a", "b"].map((suffix) => ({ scopeKind: "operating" as const, merchantId: `${run}_${suffix}`, storeId: `${run}_store_${suffix}`, stockLocationId: `${run}_loc_${suffix}` }));
const target = (i: number) => ({ scopeKind: "merchant_target" as const, merchantId: scopes[i]!.merchantId });
let sequence = 0;
const headers = () => ({ "idempotency-key": `${run}:${++sequence}` });
const input = (sku: string, barcode = "") => ({ title: `Catalog ${sku}`, sku, barcode, price: 10000, costPrice: 6000, reorderLevel: 2, categoryIds: [] });
let client: PoolClient;
let first: Awaited<ReturnType<typeof createProduct>>;

beforeAll(async () => {
  client = await connectPlatformClient();
  for (const scope of scopes) {
    await client.query("INSERT INTO app.merchants(id,display_name,legacy_organization_id) VALUES($1,$1,$1)", [scope.merchantId]);
    await client.query("INSERT INTO public.stock_location(id,name) VALUES($1,$1)", [scope.stockLocationId]);
    await client.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id) VALUES($1,$2,$1,$3)", [scope.storeId, scope.merchantId, scope.stockLocationId]);
  }
});
afterAll(async () => { client?.release(); await shutdownPlatformPool(); });

describe("merchant-scoped catalog identity", () => {
  it("creates the same visible SKU and leading-zero barcode for different merchants", async () => {
    first = await createProduct(headers(), input(`${run}-same`, `001${run}`), actor, target(0), scopes[0]!);
    const second = await createProduct(headers(), input(`${run}-same`, `001${run}`), actor, target(1), scopes[1]!);
    expect(first.response.product.id).not.toBe(second.response.product.id);
    for (let i = 0; i < 2; i++) {
      const scan = await resolveProductScan({ code: `001${run}`, context: "pos_add_to_cart" }, scopes[i]!);
      expect(scan.data.productId).toBe(i === 0 ? first.response.product.id : second.response.product.id);
    }
  });
  it("rejects same-merchant normalized SKU and barcode on create/update", async () => {
    await expect(createProduct(headers(), input(` ${run.toUpperCase()}-SAME `), actor, target(0), scopes[0]!)).rejects.toMatchObject({ statusCode: 409 });
    await expect(createProduct(headers(), input(`${run}-different`, `001${run}`), actor, target(0), scopes[0]!)).rejects.toMatchObject({ statusCode: 409 });
    const other = await createProduct(headers(), input(`${run}-update`), actor, target(0), scopes[0]!);
    await expect(updateProduct(headers(), other.response.product.id, input(`${run}-same`), actor, target(0))).rejects.toMatchObject({ statusCode: 409 });
  });
  it("returns conflict for one of two concurrent canonical writers", async () => {
    const results = await Promise.allSettled([0, 1].map((i) => createProduct(headers(), { ...input(`${run}-race`), title: `${run}-race-${i}` }, actor, target(0), scopes[0]!)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 409 });
  });
  it("uses database normalization for CSV preview and preserves merchant scope on apply", async () => {
    const header = "action,productId,title,status,sku,barcode,price,costPrice,reorderLevel,categoryHandles,imageUrl\n";
    const csv = header + `create,,CSV,published,${run}-csv,000${run},10000,6000,2,,`;
    expect((await applyProductImport({}, csv, actor, target(0), scopes[0]!)).appliedRows).toBe(1);
    expect((await previewProductImport(csv, scopes[1]!.merchantId)).valid).toBe(true);
    expect((await applyProductImport({}, csv, actor, target(1), scopes[1]!)).appliedRows).toBe(1);
    expect((await previewProductImport(csv.toUpperCase().replace(header.toUpperCase(), header), scopes[0]!.merchantId)).valid).toBe(false);
    const duplicate = header + `create,,CSV,published,${run}-À,,10000,6000,2,,\ncreate,,CSV,published,${run}-à,,10000,6000,2,,`;
    expect((await previewProductImport(duplicate, scopes[0]!.merchantId)).valid).toBe(false);
  });
  it("permits unbound inventory but refuses levels and forged binding until an exact merchant link exists", async () => {
    const item = `${run}_unbound`;
    await client.query("INSERT INTO public.inventory_item(id,sku,title) VALUES($1,$2,'Temporary')", [item, `${run}-temp`]);
    await expect(client.query("INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity,incoming_quantity) VALUES($1,$2,$3,0,0,0)", [`${run}_level`, item, scopes[0]!.stockLocationId])).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("UPDATE public.inventory_item SET merchant_id=$2 WHERE id=$1", [item, scopes[0]!.merchantId])).rejects.toMatchObject({ code: "23514" });
    const variant = first.response.product.variants[0]!.id;
    await client.query("INSERT INTO public.product_variant_inventory_item(id,variant_id,inventory_item_id,required_quantity) VALUES($1,$2,$3,2)", [`${run}_map`, variant, item]);
    expect((await client.query("SELECT merchant_id FROM public.inventory_item WHERE id=$1", [item])).rows[0].merchant_id).toBe(scopes[0]!.merchantId);
    await expect(client.query("INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity,incoming_quantity) VALUES($1,$2,$3,0,0,0)", [`${run}_wrong_level`, item, scopes[1]!.stockLocationId])).rejects.toMatchObject({ code: "23514" });
    await client.query("INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity,incoming_quantity) VALUES($1,$2,$3,0,0,0)", [`${run}_level`, item, scopes[0]!.stockLocationId]);
  });
  it("serializes competing merchant claims and rolls back the losing mapping", async () => {
    const item = `${run}_claim`;
    await client.query("INSERT INTO public.inventory_item(id,sku,title) VALUES($1,$2,'Temporary claim')", [item, `${run}-claim`]);
    const a = first.response.product.variants[0]!.id;
    const b = (await client.query("SELECT v.id FROM public.product_variant v JOIN public.product p ON p.id=v.product_id WHERE p.merchant_id=$1 ORDER BY v.id LIMIT 1", [scopes[1]!.merchantId])).rows[0].id;
    const contender = await connectPlatformClient();
    try {
      await client.query("BEGIN"); await contender.query("BEGIN; SET LOCAL lock_timeout='2s'");
      await client.query("INSERT INTO public.product_variant_inventory_item(id,variant_id,inventory_item_id,required_quantity) VALUES($1,$2,$3,1)", [`${run}_claim_a`,a,item]);
      await expect(contender.query("INSERT INTO public.product_variant_inventory_item(id,variant_id,inventory_item_id,required_quantity) VALUES($1,$2,$3,1)", [`${run}_claim_b`,b,item])).rejects.toMatchObject({ code: "55P03" });
      await contender.query("ROLLBACK"); await client.query("COMMIT");
      await expect(contender.query("INSERT INTO public.product_variant_inventory_item(id,variant_id,inventory_item_id,required_quantity) VALUES($1,$2,$3,1)", [`${run}_claim_b`,b,item])).rejects.toMatchObject({ code: "23514" });
      expect((await client.query("SELECT count(*)::int AS count FROM public.product_variant_inventory_item WHERE inventory_item_id=$1", [item])).rows[0].count).toBe(1);
    } finally { await client.query("ROLLBACK"); await contender.query("ROLLBACK"); contender.release(); }
  });
  it("runs ownership triggers for the real runtime role without exposing definer functions", async () => {
    const names = ["catalog_variant_owner", "catalog_item_owner", "catalog_mapping_owner", "catalog_mapping_bind", "catalog_stock_owner", "catalog_parent_owner"];
    const capabilities = await client.query("SELECT p.proname, p.prosecdef, p.proconfig, has_function_privilege('snus_v19_runtime_writer',p.oid,'EXECUTE') AS runtime, has_function_privilege('snus_partner_api',p.oid,'EXECUTE') AS partner, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='integration' AND p.proname=ANY($1::text[]) AND pg_get_function_identity_arguments(p.oid)=''", [names]);
    expect(capabilities.rows).toHaveLength(names.length);
    for (const row of capabilities.rows) expect(row).toMatchObject({ prosecdef: true, proconfig: ["search_path=pg_catalog"], runtime: false, partner: false, public: false });
    await client.query("BEGIN; SET LOCAL ROLE snus_v19_runtime_writer");
    try {
      const item = `${run}_runtime`;
      await client.query("INSERT INTO public.inventory_item(id,sku,title) VALUES($1,$2,'Runtime')", [item, `${run}-runtime`]);
      await client.query("INSERT INTO public.product_variant_inventory_item(id,variant_id,inventory_item_id,required_quantity) VALUES($1,$2,$3,1)", [`${run}_runtime_map`,first.response.product.variants[0]!.id,item]);
      await client.query("INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity,incoming_quantity) VALUES($1,$2,$3,0,0,0)", [`${run}_runtime_level`,item,scopes[0]!.stockLocationId]);
    } finally { await client.query("ROLLBACK"); }
  });

  it("retains cross-namespace scan ambiguity and blocks conflicting undelete", async () => {
    await createProduct(headers(), input(`001${run}`, `${run}-other-barcode`), actor, target(0), scopes[0]!);
    await expect(resolveProductScan({ code: `001${run}`, context: "pos_add_to_cart" }, scopes[0]!)).rejects.toMatchObject({ statusCode: 409 });
    const product = first.response.product.id;
    const sku = `${run}-soft`;
    await client.query("INSERT INTO public.product_variant(id,title,product_id,sku) VALUES($1,'Soft delete',$2,$3)", [`${run}_soft_a`,product,sku]);
    await client.query("UPDATE public.product_variant SET deleted_at=now() WHERE id=$1", [`${run}_soft_a`]);
    await client.query("INSERT INTO public.product_variant(id,title,product_id,sku) VALUES($1,'Reuse',$2,$3)", [`${run}_soft_b`,product,sku]);
    await expect(client.query("UPDATE public.product_variant SET deleted_at=NULL WHERE id=$1", [`${run}_soft_a`])).rejects.toMatchObject({ code: "23505", constraint: "catalog_variant_sku_unique" });
  });

  it("reallocates auto SKU after a proven concurrent unique collision", async () => {
    await client.query("BEGIN; LOCK TABLE public.product_variant IN SHARE MODE");
    const pending = Promise.allSettled([0, 1].map((i) => createProduct(headers(), {
      ...input(""), title: `${run}-${"auto".repeat(12)}-${i}`,
    }, actor, target(0), scopes[0]!)));
    try {
      const deadline = Date.now() + 2000;
      let waiting = 0;
      do {
        await client.query("SELECT pg_stat_clear_snapshot()");
        waiting = Number((await client.query("SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='relation' AND position('INSERT INTO public.product_variant (' IN query)>0")).rows[0].count);
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 10));
      } while (waiting < 2 && Date.now() < deadline);
      expect(waiting).toBe(2);
    } finally { await client.query("ROLLBACK"); }
    const results = await pending;
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const skus = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof createProduct>>>).value.response.product.variants[0]!.sku);
    expect(new Set(skus).size).toBe(2);
  });

  it("includes component inventory codes in preview and excludes the exact update item", async () => {
    const component = `${run}-component`;
    const selected = await getDefaultVariantRow(client, first.response.product.id);
    expect(selected?.inventory_item_id).toBeTruthy();
    await client.query("UPDATE public.inventory_item SET sku=$2 WHERE id=$1", [selected!.inventory_item_id,component]);
    const header = "action,productId,title,status,sku,barcode,price,costPrice,reorderLevel,categoryHandles,imageUrl\n";
    const create = header + `create,,Component conflict,published,${component},,10000,6000,2,,`;
    expect((await previewProductImport(create, scopes[0]!.merchantId)).valid).toBe(false);
    expect((await previewProductImport(create, scopes[1]!.merchantId)).valid).toBe(true);
    await expect(createProduct(headers(), input(component), actor, target(0), scopes[0]!)).rejects.toMatchObject({ statusCode: 409 });
    const update = header + `update,${first.response.product.id},Own component,published,${component},001${run},10000,6000,2,,`;
    expect((await previewProductImport(update, scopes[0]!.merchantId)).valid).toBe(true);
    expect((await applyProductImport({}, update, actor, target(0), scopes[0]!)).appliedRows).toBe(1);
  });

});
