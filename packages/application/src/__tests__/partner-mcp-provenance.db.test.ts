import { randomBytes } from "node:crypto";
import { Pool,type PoolClient } from "pg";
import { beforeAll,afterAll,beforeEach,afterEach,describe,it,expect } from "vitest";
import { requireSafeTestDatabaseTarget,assertSafeTestDatabaseSentinel } from "../db/test-database-target";
import { seedPartnerBookingFixture } from "./helpers/partner-booking-fixture";
import { generatePartnerMcpKey } from "../partner/mcp-key";
import { partnerScopes } from "@medusa-snus/contracts/partner-api";
import { readPartnerMcpIdentity,selectPartnerStore } from "../partner/registry";
import { createPartnerQuoteForClient } from "../partner/quotes";
import { createOrderForClient } from "../services/order-service";

let pool:Pool,db:PoolClient,key:ReturnType<typeof generatePartnerMcpKey>;
beforeAll(async()=>{const target=requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);pool=new Pool({connectionString:target.connectionString});db=await pool.connect();await assertSafeTestDatabaseSentinel(db,target);});
afterAll(async()=>{db.release();await pool.end();});
beforeEach(async()=>{
  await db.query("BEGIN");await seedPartnerBookingFixture(db,"mp");key=generatePartnerMcpKey("sandbox");
  await db.query(`INSERT INTO integration.integrations(id,partner_id,merchant_id,environment,installation_key,status,policy_id,policy_version)
    VALUES('mp_sibling','mp_p','mp_m','sandbox','sibling','active','mp_policy',1)`);
  await db.query(`INSERT INTO integration.partner_mcp_keys(id,integration_id,label,secret_hash,scopes,created_by,expires_at)
    VALUES($1,'mp_i','constraint fixture',$2,$3,'fixture',clock_timestamp()+interval '1 day')`,[key.keyId,key.secretHash,partnerScopes]);
});

// Real quote and core order satisfy every unrelated ownership FK. Each test
// rolls back its entire fixture so failed inserts cannot leave commerce facts.
async function order(overrides:Record<string,unknown>={},legacy=false){
  const identity=await readPartnerMcpIdentity(db,`Bearer ${key.key}`,"sandbox","req_constraint","a".repeat(32));
  const ctx=selectPartnerStore(identity,"mp_s1","orders:write",true);
  const quote=await createPartnerQuoteForClient(db,ctx,{current:"v1",keys:{v1:randomBytes(32).toString("base64url")}},
    {store_id:"mp_s1",items:[{variant_id:"mp_v1",quantity:1}],fulfillment_mode:"pickup"});
  const core=await createOrderForClient(db,{items:[{variantId:"mp_v1",quantity:1}],paymentMethod:"cod",amountReceived:0,
    salesChannel:"website",sourceFlow:"partner_api_v1",shippingFee:0},ctx,
  {merchantId:"mp_m",storeId:"mp_s1",stockLocationId:ctx.stockLocationId,source:"remote",salesChannelId:"sc_remote",orderStatus:"completed",remoteStatus:"confirmed"});
  const value={auth_method:"mcp_key",created_by_client_id:null,created_by_key_id:key.keyId,...overrides};
  const columns=legacy?"created_by_client_id":"created_by_client_id,auth_method,created_by_key_id";
  const placeholders=legacy?"$4":"$4,$5,$6";
  return db.query(`INSERT INTO integration.partner_orders(id,integration_id,partner_id,merchant_id,store_id,stock_location_id,
    core_order_id,quote_id,external_order_id,request_hash,fingerprint_version,origin_request_id,trace_id,initial_response,${columns})
    VALUES('mp_order','mp_i','mp_p','mp_m','mp_s1',$1,$2,$3,'constraint-reference',repeat('a',64),'v1',
      'req_constraint',repeat('a',32),'{}',${placeholders}) RETURNING auth_method,created_by_client_id,created_by_key_id`,
  [ctx.stockLocationId,core.data.orderId,quote.data.quote_id,value.created_by_client_id,...(legacy?[]:[value.auth_method,value.created_by_key_id])]);
}
describe("MCP order discriminator and composite credential ownership constraints",()=>{
  it("accepts a same-integration MCP key with no OAuth client",async()=>{
    expect((await order()).rows[0]).toEqual({auth_method:"mcp_key",created_by_client_id:null,created_by_key_id:key.keyId});
  });
  it("preserves the legacy OAuth insert shape via the schema default",async()=>{
    expect((await order({created_by_client_id:"mp_c"},true)).rows[0]).toEqual({auth_method:"oauth_client",created_by_client_id:"mp_c",created_by_key_id:null});
  });
  it.each([
    {created_by_key_id:null},{created_by_client_id:"mp_c"},{auth_method:"other"},
    {auth_method:"oauth_client"},{auth_method:"oauth_client",created_by_key_id:null},
    {auth_method:"oauth_client",created_by_client_id:"mp_c"},
  ])("rejects contradictory or missing order credentials %#",async fields=>{
    await expect(order(fields)).rejects.toMatchObject({code:"23514",constraint:"partner_order_credential_kind"});
  });
  it("rejects a NULL order discriminator rather than bypassing the XOR",async()=>{
    await expect(order({auth_method:null})).rejects.toMatchObject({code:"23502",column:"auth_method"});
  });
  it.each(["missing","sibling"])("rejects a %s key even when all commerce ownership is valid",async kind=>{
    const foreign=generatePartnerMcpKey("sandbox");
    if(kind==="sibling")await db.query(`INSERT INTO integration.partner_mcp_keys(id,integration_id,label,secret_hash,scopes,created_by,expires_at)
      VALUES($1,'mp_sibling','sibling',$2,ARRAY['orders:read'],'fixture',clock_timestamp()+interval '1 day')`,[foreign.keyId,foreign.secretHash]);
    await expect(order({created_by_key_id:foreign.keyId})).rejects.toMatchObject({code:"23503",constraint:"partner_order_key_ownership_fk"});
  });
});
afterEach(async()=>{await db.query("ROLLBACK");});
async function audit(overrides:Record<string,unknown>={}){
  const value={integration_id:"mp_i",client_id:null,auth_method:"mcp_key",credential_id:key.keyId,key_id:key.keyId,...overrides};
  return db.query(`INSERT INTO audit.events(organization_id,merchant_id,actor_type,actor_id,action,subject_type,subject_id,correlation_id,
    integration_id,client_id,auth_method,credential_id,key_id)
    VALUES('mp_org','mp_m','partner',$1,'constraint.test','fixture','mp_subject','mp_correlation',$2,$3,$4,$5,$6) RETURNING id`,
  [key.keyId,value.integration_id,value.client_id,value.auth_method,value.credential_id,value.key_id]);
}
describe("MCP audit discriminator and composite ownership constraints",()=>{
  it("accepts exact MCP identity and legacy audit with no new discriminator",async()=>{
    await expect(audit()).resolves.toHaveProperty("rowCount",1);
    await expect(audit({auth_method:null,credential_id:null,key_id:null,client_id:"legacy-public-client"})).resolves.toHaveProperty("rowCount",1);
    await expect(audit({auth_method:"oauth_client",credential_id:"public-client",client_id:"public-client",key_id:null})).resolves.toHaveProperty("rowCount",1);
  });
  it.each([
    {auth_method:null},{credential_id:null},{key_id:null},{integration_id:null},
    {auth_method:"other"},{client_id:"fake-oauth"},{credential_id:"f".repeat(32)},
    {auth_method:"oauth_client",client_id:"public-client",credential_id:"other-client",key_id:null},
  ])("rejects partial or contradictory credential provenance %#",async fields=>{
    await expect(audit(fields)).rejects.toMatchObject({code:"23514"});
  });
  it("rejects a valid key attached to a sibling integration",async()=>{
    await expect(audit({integration_id:"mp_sibling"})).rejects.toMatchObject({code:"23503",constraint:"partner_audit_key_ownership_fk"});
  });
  it("rejects a well-formed nonexistent audit key by composite FK",async()=>{
    const missing=generatePartnerMcpKey("sandbox").keyId;
    await expect(audit({credential_id:missing,key_id:missing})).rejects.toMatchObject({code:"23503",constraint:"partner_audit_key_ownership_fk"});
  });
  it("retains old OAuth lock entrypoint and denies unsupported credential kinds",async()=>{
    await db.query("SET LOCAL ROLE snus_partner_api");
    await expect(db.query("SELECT integration.lock_authorization('mp_i','mp_c','mp_s1')")).resolves.toHaveProperty("rowCount",1);
    await expect(db.query("SELECT integration.lock_authorization('mp_i',$1,'mp_s1','mcp_key')",[key.keyId])).resolves.toHaveProperty("rowCount",1);
    await expect(db.query("SELECT integration.lock_authorization('mp_i',$1,'mp_s1','staff')",[key.keyId])).rejects.toMatchObject({code:"22023"});
  });
});
