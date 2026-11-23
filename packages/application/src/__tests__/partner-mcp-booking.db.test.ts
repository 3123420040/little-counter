import { randomBytes,randomUUID } from "node:crypto";
import { Pool,type PoolClient } from "pg";
import { beforeAll,afterAll,describe,it,expect } from "vitest";
import { partnerScopes,type PartnerOrderRequest } from "@medusa-snus/contracts/partner-api";
import { requireSafeTestDatabaseTarget,assertSafeTestDatabaseSentinel } from "../db/test-database-target";
import { seedPartnerBookingFixture } from "./helpers/partner-booking-fixture";
import { generatePartnerMcpKey } from "../partner/mcp-key";
import { readPartnerMcpIdentity,readPartnerIdentity,selectPartnerStore } from "../partner/registry";
import { createPartnerQuoteForClient } from "../partner/quotes";
import { bookPartnerOrderForClient } from "../partner/booking";
import { readPartnerOrder } from "../partner/orders";

let pool:Pool,owner:PoolClient;
const fixtures:string[]=[];
const fingerprints={current:"v1",keys:{v1:randomBytes(32).toString("base64url")}};
async function transaction<T>(work:(db:PoolClient)=>Promise<T>,role=true){
  const db=await pool.connect();
  try{await db.query("BEGIN");await db.query("SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='3s'");
    if(role)await db.query("SET LOCAL ROLE snus_partner_api");const result=await work(db);await db.query("COMMIT");return result;
  }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
}
async function fixture(){
  const prefix=`mk${randomBytes(6).toString("hex")}`;const key=generatePartnerMcpKey("sandbox");
  await transaction(async db=>{await seedPartnerBookingFixture(db,prefix);
    await db.query(`INSERT INTO integration.partner_mcp_keys(id,integration_id,label,secret_hash,scopes,created_by,expires_at)
      VALUES($1,$2,'Synthetic',$3,$4,'fixture-owner',clock_timestamp()+interval '1 day')`,
    [key.keyId,`${prefix}_i`,key.secretHash,partnerScopes]);},false);
  fixtures.push(prefix);return {prefix,key};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function context(db:PoolClient,f:Fixture,method:"mcp_key"|"oauth_client",scope:"orders:quote"|"orders:write"|"orders:read",store="s1"){
  const read=()=>method==="mcp_key"?readPartnerMcpIdentity(db,`Bearer ${f.key.key}`,"sandbox",`req_${randomUUID()}`,"d".repeat(32))
    :readPartnerIdentity(db,{issuer:`https://${f.prefix}.invalid`,clientId:"reads",subject:"subject",scopes:partnerScopes,expiresAt:9999999999},"sandbox",`req_${randomUUID()}`,"c".repeat(32));
  let identity=await read();const storeId=`${f.prefix}_${store}`;
  selectPartnerStore(identity,storeId,scope,scope!=="orders:read");
  if(scope!=="orders:read"){
    await db.query("SELECT integration.lock_authorization($1,$2,$3,$4)",[identity.integrationId,identity.registryClientId??identity.keyId,storeId,identity.authMethod]);
    identity=await read();
  }
  return selectPartnerStore(identity,storeId,scope,scope!=="orders:read");
}
async function quoted(f:Fixture,method:"mcp_key"|"oauth_client"="mcp_key",quantity=2):Promise<PartnerOrderRequest>{
  const quote=await transaction(async db=>createPartnerQuoteForClient(db,await context(db,f,method,"orders:quote"),fingerprints,
    {store_id:`${f.prefix}_s1`,items:[{variant_id:`${f.prefix}_v1`,quantity}],fulfillment_mode:"pickup"}));
  return {store_id:`${f.prefix}_s1`,quote_id:quote.data.quote_id,external_order_id:`synthetic-${randomUUID()}`,payment_method:"cod",fulfillment:{mode:"pickup"}};
}
beforeAll(async()=>{const target=requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);pool=new Pool({connectionString:target.connectionString,max:8});
  owner=await pool.connect();await assertSafeTestDatabaseSentinel(owner,target);});
afterAll(async()=>{for(const prefix of fixtures)await owner.query("UPDATE integration.integrations SET status='revoked',writes_enabled=false WHERE id=$1",[`${prefix}_i`]);
  owner?.release();await pool?.end();});
describe("MCP credential shared booking and lock protocol on PostgreSQL",()=>{
  it.each(["mcp_key", "oauth_client"] as const)("refuses unsupported fees for %s quote/booking before any quote, receipt or stock change", async method => {
    const f = await fixture(), order = await quoted(f, method);
    const beforeStock = (await owner.query("SELECT stocked_quantity FROM public.inventory_level WHERE id=$1", [`${f.prefix}_il1`])).rows[0].stocked_quantity;
    await transaction(async db => {
      const quoteContext = await context(db, f, method, "orders:quote"), bookingContext = await context(db, f, method, "orders:write");
      const facts = async () => (await db.query(`SELECT
        (SELECT count(*) FROM integration.quotes WHERE integration_id=$1) AS quotes,
        (SELECT count(*) FROM integration.partner_orders WHERE integration_id=$1) AS orders,
        (SELECT count(*) FROM integration.idempotency_records WHERE integration_id=$1) AS receipts`, [quoteContext.integrationId])).rows[0];
      const before = await facts();
      for (const paymentFeeValue of [0, 2]) {
        const fee = { paymentFeeType: "percent", paymentFeeValue };
        await expect(createPartnerQuoteForClient(db, quoteContext, fingerprints, {
          store_id: `${f.prefix}_s1`, items: [{ variant_id: `${f.prefix}_v1`, quantity: 2 }], fulfillment_mode: "pickup", ...fee,
        })).rejects.toMatchObject({ code: "invalid_request" });
        await expect(bookPartnerOrderForClient(db, bookingContext, fingerprints, { ...order, ...fee }, `fee-refusal-${method}-${paymentFeeValue}`))
          .rejects.toMatchObject({ code: "invalid_request" });
        expect(await facts()).toEqual(before);
      }
    });
    expect((await owner.query("SELECT stocked_quantity FROM public.inventory_level WHERE id=$1", [`${f.prefix}_il1`])).rows[0].stocked_quantity).toBe(beforeStock);
  });
  it("uses the same core for MCP booking, preserves key FK/audit/outbox and lets OAuth reconcile/replay",async()=>{
    const f=await fixture(),body=await quoted(f);
    const first=await transaction(async db=>bookPartnerOrderForClient(db,await context(db,f,"mcp_key","orders:write"),fingerprints,body,"mcp-stable-reference-0001"));
    const replay=await transaction(async db=>bookPartnerOrderForClient(db,await context(db,f,"oauth_client","orders:write"),fingerprints,body,"oauth-other-key-0001"));
    expect(first.status).toBe(201);expect(replay.status).toBe(200);expect(replay.body.data).toEqual(first.body.data);
    const current=await transaction(async db=>readPartnerOrder(db,await context(db,f,"oauth_client","orders:read"),first.body.data.order_id));
    expect(current.data.order_id).toBe(first.body.data.order_id);
    const mapped=(await owner.query("SELECT auth_method,created_by_client_id,created_by_key_id,core_order_id FROM integration.partner_orders WHERE id=$1",[first.body.data.order_id])).rows[0];
    expect(mapped).toMatchObject({auth_method:"mcp_key",created_by_client_id:null,created_by_key_id:f.key.keyId});
    const audit=(await owner.query("SELECT auth_method,credential_id,client_id,key_id,actor_id FROM audit.events WHERE subject_id=$1 AND action='partner.order_booked'",[first.body.data.order_id])).rows;
    expect(audit).toEqual([{auth_method:"mcp_key",credential_id:f.key.keyId,client_id:null,key_id:f.key.keyId,actor_id:f.key.keyId}]);
    const events=(await owner.query("SELECT payload FROM outbox.events WHERE aggregate_id=$1 AND event_type='sale.created'",[mapped.core_order_id])).rows;
    expect(events).toHaveLength(1);expect(events[0].payload).toMatchObject({authMethod:"mcp_key",credentialId:f.key.keyId,keyId:f.key.keyId,clientId:null,transport:"mcp_http"});
    expect(JSON.stringify(events).includes(f.key.key)).toBe(false);
    expect(Number((await owner.query("SELECT stocked_quantity FROM public.inventory_level WHERE id=$1",[`${f.prefix}_il1`])).rows[0].stocked_quantity)).toBe(8);
  });
  it("allows full-mode MCP quote and book only while current, keeps OAuth explicit, and replays a committed booking after mode changes",async()=>{
    const f=await fixture();
    await owner.query("UPDATE integration.store_grants SET mcp_catalog_mode='merchant_published' WHERE integration_id=$1 AND store_id=$2",[`${f.prefix}_i`,`${f.prefix}_s1`]);
    await owner.query("DELETE FROM integration.assortment_items WHERE assortment_id=$1 AND variant_id=$2",[`${f.prefix}_a`,`${f.prefix}_v1`]);
    const stale=await quoted(f,"mcp_key"),committed=await quoted(f,"mcp_key");
    expect((await owner.query("SELECT snapshot->>'catalogMode' AS mode FROM integration.quotes WHERE id=$1",[stale.quote_id])).rows[0].mode).toBe("merchant_published");
    await expect(quoted(f,"oauth_client")).rejects.toMatchObject({code:"resource_not_found"});
    const first=await transaction(async db=>bookPartnerOrderForClient(db,await context(db,f,"mcp_key","orders:write"),fingerprints,committed,"mode-first-book-0001"));
    expect(first.status).toBe(201);
    await owner.query("UPDATE integration.store_grants SET mcp_catalog_mode='explicit' WHERE integration_id=$1 AND store_id=$2",[`${f.prefix}_i`,`${f.prefix}_s1`]);
    await expect(quoted(f,"mcp_key")).rejects.toMatchObject({code:"resource_not_found"});
    await expect(transaction(async db=>bookPartnerOrderForClient(db,await context(db,f,"mcp_key","orders:write"),fingerprints,stale,"mode-stale-book-0001")))
      .rejects.toMatchObject({code:"quote_changed"});
    const replay=await transaction(async db=>bookPartnerOrderForClient(db,await context(db,f,"mcp_key","orders:write"),fingerprints,committed,"mode-replay-other-0001"));
    expect(replay).toMatchObject({status:200,replayed:true,body:{data:first.body.data}});
  });
  it("serializes concurrent OAuth and MCP attempts for the same external reference",async()=>{
    const f=await fixture(),body=await quoted(f,"oauth_client");
    const result=await Promise.all(["mcp_key","oauth_client"].map((method,n)=>transaction(async db=>bookPartnerOrderForClient(db,
      await context(db,f,method as "mcp_key"|"oauth_client","orders:write"),fingerprints,body,`cross-channel-key-${n}-0001`))));
    expect(result.map(r=>r.status).sort()).toEqual([200,201]);expect(result[0].body.data.order_id).toBe(result[1].body.data.order_id);
  });
  it("does not transfer key scope from the selected store's sibling grant",async()=>{
    const f=await fixture();await owner.query("UPDATE integration.store_grants SET allowed_scopes=ARRAY['orders:read'] WHERE integration_id=$1 AND store_id=$2",[`${f.prefix}_i`,`${f.prefix}_s2`]);
    await expect(transaction(db=>context(db,f,"mcp_key","orders:write","s2"))).rejects.toMatchObject({code:"insufficient_scope"});
    await owner.query("UPDATE integration.partner_mcp_keys SET scopes=ARRAY['orders:read'] WHERE id=$1",[f.key.keyId]);
    await expect(transaction(db=>context(db,f,"mcp_key","orders:write"))).rejects.toMatchObject({code:"insufficient_scope"});
  });
  it("holds revoke behind an in-flight mutation and rejects every new key attempt after revoke ACK",async()=>{
    const f=await fixture();const inflight=await pool.connect(),control=await pool.connect();
    try{
      await inflight.query("BEGIN");await inflight.query("SET LOCAL ROLE snus_partner_api");await context(inflight,f,"mcp_key","orders:write");
      await control.query("BEGIN");await control.query("SET LOCAL ROLE snus_partner_control");
      const pid=Number((await control.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const revoking=control.query("SELECT id FROM integration.integrations WHERE id=$1 FOR UPDATE",[`${f.prefix}_i`]);
      let blocked=false;
      for(let attempt=0;attempt<50;attempt++){
        blocked=(await owner.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",[pid])).rows[0].blocked;
        if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);await inflight.query("COMMIT");await revoking;
      await control.query("UPDATE integration.partner_mcp_keys SET status='revoked',revoked_at=clock_timestamp(),revoked_by='fixture-owner' WHERE id=$1",[f.key.keyId]);
      await control.query("COMMIT");
      await expect(transaction(db=>context(db,f,"mcp_key","orders:write"))).rejects.toMatchObject({code:"invalid_token"});
    }finally{await inflight.query("ROLLBACK");await control.query("ROLLBACK");inflight.release();control.release();}
  });
});
