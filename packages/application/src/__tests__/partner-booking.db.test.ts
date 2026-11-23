import { randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { seedPartnerReadFixture } from "./helpers/partner-read-fixture";
import { requireSafeTestDatabaseTarget, assertSafeTestDatabaseSentinel } from "../db/test-database-target";
import { createPartnerQuoteForClient } from "../partner/quotes";
import { bookPartnerOrderForClient } from "../partner/booking";
import { maintainPartnerRetentionForClient } from "../partner/maintenance";
import { partnerFingerprint } from "../partner/fingerprints";
import { readPartnerOrder,listPartnerOrders } from "../partner/orders";
import { readPartnerIdentity, selectPartnerStore } from "../partner/registry";
import { isPartnerSchema, partnerScopes, type PartnerOrderRequest } from "@medusa-snus/contracts/partner-api";
let pool: Pool; let db: PoolClient; let request: PartnerOrderRequest;
const keys = {current:"v1",keys:{v1:randomBytes(32).toString("base64url")}};
const token = {issuer:"https://pr.invalid",clientId:"reads",subject:"subject",scopes:partnerScopes,expiresAt:9999999999};
async function context(scope:"orders:quote"|"orders:write"="orders:write",requestId="req_booking") {
  const identity = await readPartnerIdentity(db,token,"sandbox",requestId,"a".repeat(32));
  const ctx = selectPartnerStore(identity,"pr_s1",scope,scope!=="orders:read");
  if(scope!=="orders:read") await db.query("SELECT integration.lock_authorization($1,$2,$3)",[ctx.integrationId,ctx.registryClientId,ctx.storeId]);
  return ctx;
}
const key = "booking-synthetic-key-0001";
async function book(body=request,idempotencyKey=key,requestId="req_booking") {
  return bookPartnerOrderForClient(db,await context("orders:write",requestId),keys,body,idempotencyKey);
}
beforeAll(async()=>{
  const target=requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);pool=new Pool({connectionString:target.connectionString});
  db=await pool.connect();await assertSafeTestDatabaseSentinel(db,target);
});
beforeEach(async()=>{
  await db.query("BEGIN");await seedPartnerReadFixture(db);
  await db.query(`UPDATE integration.store_grants SET allowed_scopes=array_append(array_append(allowed_scopes,'orders:quote'),'orders:read') WHERE store_id='pr_s1';
    INSERT INTO public.price_set(id,merchant_id) VALUES('pr_ps','pr_m');
    INSERT INTO public.product_variant_price_set(id,variant_id,price_set_id) VALUES('pr_vps','pr_v1','pr_ps');
    INSERT INTO public.price(id,price_set_id,currency_code,amount,raw_amount) VALUES('pr_price','pr_ps','vnd',250000,'{"value":"250000","precision":20}');
    INSERT INTO inventory.product_settings(variant_id,product_id,merchant_id,cost_price) VALUES('pr_v1','pr_product','pr_m',100000);`);
  const quote=await createPartnerQuoteForClient(db,await context("orders:quote"),keys,
    {store_id:"pr_s1",items:[{variant_id:"pr_v1",quantity:2}],fulfillment_mode:"pickup"});
  request={store_id:"pr_s1",quote_id:quote.data.quote_id,external_order_id:"synthetic-external-1",payment_method:"cod",fulfillment:{mode:"pickup"}};
});
afterEach(async()=>{await db.query("ROLLBACK");});
afterAll(async()=>{db?.release();await pool?.end();});
async function stock(){return Number((await db.query("SELECT stocked_quantity FROM public.inventory_level WHERE id='pr_il1'")).rows[0].stocked_quantity);}
describe("S5 atomic booking using real core and PostgreSQL",()=>{
  async function zeroQuote() {
    await db.query("UPDATE public.price SET amount=0,raw_amount='{\"value\":\"0\",\"precision\":20}' WHERE id='pr_price'");
    const quote = await createPartnerQuoteForClient(db, await context("orders:quote"), keys,
      {store_id:"pr_s1",items:[{variant_id:"pr_v1",quantity:2}],fulfillment_mode:"pickup"});
    request = {...request, quote_id:quote.data.quote_id};
    return quote;
  }
  it("books and replays a zero-value COD order without inventing payment or collection facts", async () => {
    await zeroQuote();
    await db.query("SET LOCAL ROLE snus_partner_api");
    const first = await book();
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({total:0,collection_status:"unconfirmed",stock_deducted:true});
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    const replay = await book(request,key,"req_zero_retry");
    expect(replay.body.data).toEqual(first.body.data);
    const detail = await readPartnerOrder(db,await context("orders:read"),first.body.data.order_id);
    expect(detail.data).toMatchObject({total:0,collection_status:"unconfirmed"});
    const list = await listPartnerOrders(db,await context("orders:read"),keys,{limit:20});
    expect(list.data).toEqual([detail.data]);
    await db.query("RESET ROLE");
    expect(await stock()).toBe(8);
    for (const table of ["app.payment_events","app.commercial_obligations","app.payment_event_evidence",
      "app.payment_event_allocations","app.payment_event_component_allocations","app.payment_entries","app.customer_refund_payables"]) {
      expect((await db.query(`SELECT count(*) FROM ${table} WHERE merchant_id='pr_m'`)).rows[0].count).toBe("0");
    }
    const facts = await db.query(`SELECT c.total_minor, r.revision FROM app.order_commercial_revisions r
      JOIN app.order_commercial_revision_components c ON c.revision_id=r.id WHERE r.merchant_id='pr_m'`);
    expect(facts.rows).toEqual([{total_minor:"0",revision:0}]);
    const event = (await db.query("SELECT payload FROM outbox.events WHERE merchant_id='pr_m' AND event_type='sale.created'")).rows;
    expect(event).toHaveLength(1);
    expect(event[0].payload).toMatchObject({total:0,cogs:200000,paymentEntryId:null,paymentStatus:null});
  });
  it("defaults list history to seven days while explicit range and external reference find older orders",async()=>{
    const first=await book();
    const now=Date.now();
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(now+8*86400000);
    try {
      const ctx=await context("orders:read");
      expect((await listPartnerOrders(db,ctx,keys,{limit:20})).data).toEqual([]);
      expect((await listPartnerOrders(db,ctx,keys,{limit:20,date_from:new Date(now-23*86400000).toISOString(),
        date_to:new Date().toISOString()})).data.map(row=>row.order_id)).toEqual([first.body.data.order_id]);
      expect((await listPartnerOrders(db,ctx,keys,{limit:20,external_order_id:request.external_order_id})).data.map(row=>row.order_id))
        .toEqual([first.body.data.order_id]);
    } finally {vi.useRealTimers();}
  });
  it.each([0,null])("distinguishes known zero cost from missing cost evidence: %s",async(cost)=>{
    await zeroQuote();
    if(cost===null)await db.query("DELETE FROM inventory.product_settings WHERE variant_id='pr_v1'");
    else await db.query("UPDATE inventory.product_settings SET cost_price=0 WHERE variant_id='pr_v1'");
    if(cost===null){
      await db.query("SAVEPOINT missing_cost");
      await expect(book()).rejects.toThrow();
      await db.query("ROLLBACK TO SAVEPOINT missing_cost");expect(await stock()).toBe(10);
    }else{
      expect((await book()).body.data.total).toBe(0);
      expect((await db.query("SELECT payload->>'cogs' AS cogs FROM outbox.events WHERE merchant_id='pr_m' AND event_type='sale.created'")).rows[0].cogs).toBe("0");
    }
  });
  it("rejects price drift both into and out of a zero-value quote", async () => {
    await db.query("UPDATE public.price SET amount=0 WHERE id='pr_price'");
    await expect(book()).rejects.toMatchObject({code:"quote_changed"});
    await zeroQuote();
    await db.query("UPDATE public.price SET amount=250000 WHERE id='pr_price'");
    await expect(book()).rejects.toMatchObject({code:"quote_changed"});
    expect(await stock()).toBe(10);
  });
  it("rolls back zero-value stock and commercial facts with the caller transaction", async () => {
    await zeroQuote();
    await db.query("SAVEPOINT before_zero_booking");
    const first = await book();
    expect(await stock()).toBe(8);
    await db.query("ROLLBACK TO SAVEPOINT before_zero_booking");
    expect(await stock()).toBe(10);
    expect((await db.query("SELECT count(*) FROM integration.partner_orders WHERE id=$1",[first.body.data.order_id])).rows[0].count).toBe("0");
    expect((await db.query("SELECT count(*) FROM app.order_commercial_revisions WHERE merchant_id='pr_m'")).rows[0].count).toBe("0");
    expect((await book()).status).toBe(201);
  });
  it("keeps replay and external dedup stable across fingerprint key rotation",async()=>{
    const original=await book();
    const rotated={current:"v2",keys:{...keys.keys,v2:randomBytes(32).toString("base64url")}};
    const replay=await bookPartnerOrderForClient(db,await context(),rotated,request,key);
    expect(replay.status).toBe(200);expect(replay.body.data).toEqual(original.body.data);
    const external=await bookPartnerOrderForClient(db,await context(),rotated,request,"rotated-key-number-0002");
    expect(external.status).toBe(200);expect(external.body.data).toEqual(original.body.data);
    expect(await stock()).toBe(8);
    expect((await db.query("SELECT fingerprint_version FROM integration.idempotency_records WHERE key_fingerprint=$1",
      [partnerFingerprint(rotated,"rotated-key-number-0002")])).rows[0].fingerprint_version).toBe("v2");
  });
  it("permanently tombstones expired replay without deleting external ownership or consumed quotes",async()=>{
    const original=await book();const expiredKey="expired-replay-key-0001";
    await db.query(`INSERT INTO integration.idempotency_records
      SELECT (jsonb_populate_record(NULL::integration.idempotency_records,to_jsonb(r)||jsonb_build_object(
        'key_fingerprint',$1::text,'created_at',now()-interval '31 days','expires_at',now()-interval '1 day'))).*
      FROM integration.idempotency_records r WHERE integration_id='pr_i'`,[partnerFingerprint(keys,expiredKey)]);
    await expect(book(request,expiredKey)).rejects.toMatchObject({code:"idempotency_record_expired"});
    await db.query(`INSERT INTO integration.quotes SELECT (jsonb_populate_record(NULL::integration.quotes,
      to_jsonb(q)||jsonb_build_object('id','pr_expired_quote','created_at',now()-interval '31 days',
        'expires_at',now()-interval '31 days'+interval '5 minutes','consumed_order_id',NULL))).*
      FROM integration.quotes q WHERE id=$1`,[request.quote_id]);
    await db.query("SET LOCAL ROLE snus_partner_maintenance");
    const result=await maintainPartnerRetentionForClient(db,500);expect(result.tombstones).toBeGreaterThanOrEqual(1);
    await db.query("RESET ROLE");
    expect((await db.query("SELECT state,public_response FROM integration.idempotency_records WHERE key_fingerprint=$1",[partnerFingerprint(keys,expiredKey)])).rows[0])
      .toEqual({state:"tombstone",public_response:null});
    expect((await db.query("SELECT count(*) FROM integration.quotes WHERE id='pr_expired_quote'")).rows[0].count).toBe("0");
    expect((await db.query("SELECT consumed_order_id FROM integration.quotes WHERE id=$1",[request.quote_id])).rows[0].consumed_order_id).toBe(original.body.data.order_id);
    await expect(book(request,expiredKey)).rejects.toMatchObject({code:"idempotency_record_expired"});
    const freshKey=await book(request,"after-retention-key-0001");expect(freshKey.status).toBe(200);
    expect(freshKey.body.data).toEqual(original.body.data);expect(await stock()).toBe(8);
  });
  it.each([false,true])("rolls back all core effects on durable booking audit failure, zero=%s",async(zero)=>{
    if(zero)await zeroQuote();
    await db.query(`CREATE FUNCTION pg_temp.reject_partner_booking_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='partner.order_booked' AND NEW.integration_id='pr_i' THEN
        RAISE EXCEPTION 'synthetic audit failure' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_partner_audit_failure BEFORE INSERT ON audit.events FOR EACH ROW
        EXECUTE FUNCTION pg_temp.reject_partner_booking_audit(); SAVEPOINT before_audit_failure`);
    await db.query("SET LOCAL ROLE snus_partner_api");
    await expect(book()).rejects.toMatchObject({code:"P0001"});
    await db.query("ROLLBACK TO SAVEPOINT before_audit_failure");
    expect(await stock()).toBe(10);
    for(const table of ["integration.partner_orders","integration.idempotency_records"]){
      expect((await db.query(`SELECT count(*) FROM ${table} WHERE integration_id='pr_i'`)).rows[0].count).toBe("0");
    }
    expect((await db.query("SELECT count(*) FROM public.order WHERE merchant_id='pr_m'")).rows[0].count).toBe("0");
    expect((await db.query("SELECT count(*) FROM outbox.events WHERE merchant_id='pr_m'")).rows[0].count).toBe("0");
    await db.query("DROP TRIGGER synthetic_partner_audit_failure ON audit.events");
    expect((await book()).status).toBe(201);
  });

  it("reads only the public scoped projection and keeps COD posted charge unconfirmed",async()=>{
    const result=await book();await db.query("SET LOCAL ROLE snus_partner_api;SET LOCAL transaction_read_only=on");
    const ctx=selectPartnerStore(await readPartnerIdentity(db,token,"sandbox","req_get","c".repeat(32)),"pr_s1","orders:read");
    const detail=await readPartnerOrder(db,ctx,result.body.data.order_id);
    expect(isPartnerSchema("OrderResponse",detail)).toBe(true);
    expect(detail.data).toMatchObject({total:500000,collection_status:"unconfirmed",booking_status:"confirmed"});
    const page=await listPartnerOrders(db,ctx,keys,{limit:20,external_order_id:request.external_order_id});
    expect(page.data).toHaveLength(1);expect(page.data[0]).toEqual(detail.data);
    await expect(readPartnerOrder(db,ctx,"po_foreign")).rejects.toMatchObject({code:"resource_not_found"});
  });
  it("runs through the restricted public API role including deferred constraints",async()=>{
    await db.query("SET LOCAL ROLE snus_partner_api");
    const result=await book();expect(result.status).toBe(201);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  });
  it("commits all linked facts in caller transaction and replays the original safe response",async()=>{
    const first=await book();expect(first.status).toBe(201);expect(isPartnerSchema("OrderResponse",first.body)).toBe(true);
    expect(first.body.data).toMatchObject({total:500000,collection_status:"unconfirmed",stock_deducted:true});
    expect(await stock()).toBe(8);
    const second=await book(request,key,"req_retry");expect(second.status).toBe(200);expect(second.body.data).toEqual(first.body.data);
    expect(second.body.meta).toEqual({request_id:"req_retry",original_request_id:"req_booking"});expect(await stock()).toBe(8);
    expect((await db.query("SELECT count(*) FROM integration.partner_orders WHERE integration_id='pr_i'")).rows[0].count).toBe("1");
    const outbox=await db.query("SELECT count(*) FROM outbox.events WHERE event_type='sale.created' AND aggregate_id=(SELECT core_order_id FROM integration.partner_orders WHERE id=$1)",[first.body.data.order_id]);
    expect(outbox.rows[0].count).toBe("1");
  });
  it("reuses an identical external reference with a different key but rejects different content",async()=>{
    const first=await book();const second=await book(request,"booking-synthetic-key-0002");
    expect(second.status).toBe(200);expect(second.body.data).toEqual(first.body.data);
    await expect(book({...request,quote_id:"unknown"},"booking-synthetic-key-0003")).rejects.toMatchObject({code:"external_order_conflict"});
    expect(await stock()).toBe(8);
  });
  it("rejects changed content under the same key",async()=>{
    await book();await expect(book({...request,external_order_id:"different"})).rejects.toMatchObject({code:"idempotency_conflict"});
  });
  it("rejects a quote consumed by another external reference",async()=>{
    await book();await expect(book({...request,external_order_id:"different"},"booking-synthetic-key-0002")).rejects.toMatchObject({code:"quote_consumed"});
  });
  it("rejects concurrent stock loss after quoting",async()=>{
    await db.query("UPDATE public.inventory_level SET stocked_quantity=2 WHERE id='pr_il1'");
    await expect(book()).rejects.toMatchObject({code:"insufficient_stock"});expect(await stock()).toBe(2);
  });
  it("rejects actual price changes without silently changing the quoted total",async()=>{
    await db.query("UPDATE public.price SET amount=260000 WHERE id='pr_price'");
    await expect(book()).rejects.toMatchObject({code:"quote_changed"});expect(await stock()).toBe(10);
  });
  it("rolls back order/stock/mapping/audit/outbox if the facade fails before commit",async()=>{
    await db.query("SAVEPOINT before_booking");const result=await book();expect(await stock()).toBe(8);
    await db.query("ROLLBACK TO SAVEPOINT before_booking");expect(await stock()).toBe(10);
    expect((await db.query("SELECT count(*) FROM integration.partner_orders WHERE id=$1",[result.body.data.order_id])).rows[0].count).toBe("0");
    expect((await db.query("SELECT consumed_order_id FROM integration.quotes WHERE id=$1",[request.quote_id])).rows[0].consumed_order_id).toBe(null);
    expect((await book()).status).toBe(201);
  });
});
