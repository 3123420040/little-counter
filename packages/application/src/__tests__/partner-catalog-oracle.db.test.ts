import { Pool, type PoolClient } from "pg";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { seedCatalogOracle } from "./helpers/catalog-oracle-fixture";
import { readPartnerCatalog, readPartnerCatalogSummary } from "../partner/catalog";
import { readPartnerIdentity, selectPartnerStore } from "../partner/registry";
import { partnerScopes } from "@medusa-snus/contracts/partner-api";

let pool: Pool, db: PoolClient;
const prefix="cat",keys={current:"oracle",keys:{oracle:randomBytes(32).toString("base64url")}};
beforeAll(async()=>{
  const target=requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool=new Pool({connectionString:target.connectionString});db=await pool.connect();
  await assertSafeTestDatabaseSentinel(db,target);
});
beforeEach(async()=>{await db.query("BEGIN");await seedCatalogOracle(db,prefix);});
afterEach(async()=>{await db.query("ROLLBACK");});
afterAll(async()=>{db?.release();await pool?.end();});
async function context(mode:"explicit"|"merchant_published"){
  await db.query("SET LOCAL ROLE snus_partner_api; SET LOCAL transaction_read_only=on");
  const identity=await readPartnerIdentity(db,{issuer:"https://cat.invalid",clientId:"reads",subject:"subject",scopes:partnerScopes,expiresAt:9999999999},"sandbox","oracle","oracle");
  return {...selectPartnerStore(identity,"cat_s1",["catalog:read","inventory:read"]),catalogMode:mode};
}
describe("independent 210 product / 211 inventory / 206 published SKU oracle",()=>{
  it.each([["explicit",200,200,3,197,16],["merchant_published",205,206,4,202,22]] as const)("enumerates every eligible identity and matches summary in %s",async(mode,products,skus,available,out,sum)=>{
    const ctx=await context(mode),summary=await readPartnerCatalogSummary(db,ctx);
    expect(summary.data).toMatchObject({product_count:products,sku_count:skus,available_sku_count:available,out_of_stock_sku_count:out,
      unavailable_sku_count:0,available_quantity_sum:sum,quantity_basis:"per_variant",has_shared_inventory_items:false,inventory_complete:true});
    for(const inventory of [false,true]){
      const ids:string[]=[];let cursor:string|undefined;
      do{
        const page=await readPartnerCatalog(db,ctx,keys,{limit:20,...(cursor?{cursor}:{})},inventory);
        ids.push(...page.data.map(row=>row.variant_id));cursor=page.page.next_cursor??undefined;
      }while(cursor);
      expect(ids).toHaveLength(skus);expect(new Set(ids).size).toBe(skus);
      expect(ids.includes("cat_ov0205")).toBe(mode==="merchant_published");
    }
  });
  it("preserves safety2 and warns that shared variants sum32 while physical stock is22",async()=>{
    await db.query("UPDATE public.product_variant_inventory_item SET inventory_item_id='cat_oi1' WHERE variant_id='cat_ov0211'");
    const ctx=await context("merchant_published");
    expect((await readPartnerCatalogSummary(db,ctx)).data).toMatchObject({available_quantity_sum:32,has_shared_inventory_items:true,quantity_basis:"per_variant"});
    const safety=await readPartnerCatalogSummary(db,{...ctx,policy:{...ctx.policy,safetyStock:2}});
    expect(safety.data).toMatchObject({available_quantity_sum:23,available_sku_count:4,out_of_stock_sku_count:202});
  });
  it("matches the independent safety2 branch without shared stock",async()=>{
    const ctx=await context("merchant_published");
    expect((await readPartnerCatalogSummary(db,{...ctx,policy:{...ctx.policy,safetyStock:2}})).data)
      .toMatchObject({available_quantity_sum:15,available_sku_count:3,out_of_stock_sku_count:203});
  });
});
