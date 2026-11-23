import { fork } from "node:child_process";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { seedPartnerBookingFixture } from "./helpers/partner-booking-fixture";
import { requireSafeTestDatabaseTarget, assertSafeTestDatabaseSentinel } from "../db/test-database-target";
import { createPartnerQuoteForClient } from "../partner/quotes";
import { bookPartnerOrderForClient } from "../partner/booking";
import { readPartnerIdentity, selectPartnerStore } from "../partner/registry";
import { partnerScopes, type PartnerOrderRequest } from "@medusa-snus/contracts/partner-api";
import { createOrderForClient,getOrder,cancelOrder,quoteOrderCancellation,updateOrderShippingFee,previewOrderShippingFee } from "../services/order-service";
import { readPartnerOrder,listPartnerOrders } from "../partner/orders";
import { ensurePlatformSchema } from "../db/schema";
import { applyOrderCorrection,previewOrderCorrection } from "../services/order-correction-service";
import { shutdownPlatformDb } from "../platform-db";
import { withPartnerTransaction } from "../partner/transaction";
let pool: Pool; let owner: PoolClient;
const keys={current:"v1",keys:{v1:randomBytes(32).toString("base64url")}};
const fixtures: string[]=[];
async function transaction<T>(work:(db:PoolClient)=>Promise<T>,role=true){
  return withPartnerTransaction(pool, async db => {
    if(role) await db.query("SET LOCAL ROLE snus_partner_api");
    return work(db);
  }, { timeoutMs: 5000, statementTimeoutMs: 3000, begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE" });
}
async function context(db:PoolClient,p:string,client="reads",scope:"orders:quote"|"orders:write"|"orders:read"="orders:write",store="s1"){
  const token={issuer:`https://${p}.invalid`,clientId:client,subject:client==="reads"?"subject":"subject2",scopes:partnerScopes,expiresAt:9999999999};
  let identity=await readPartnerIdentity(db,token,"sandbox",`req_${randomUUID()}`,"b".repeat(32));
  let ctx=selectPartnerStore(identity,`${p}_${store}`,scope,scope!=="orders:read");
  if(scope!=="orders:read")await db.query("SELECT integration.lock_authorization($1,$2,$3)",[ctx.integrationId,ctx.registryClientId,ctx.storeId]);
  identity=await readPartnerIdentity(db,token,"sandbox",identity.requestId,identity.traceId);
  ctx=selectPartnerStore(identity,`${p}_${store}`,scope,scope!=="orders:read");return ctx;
}
async function fixture(){
  const p=`pc${randomBytes(6).toString("hex")}`;
  await transaction(async db=>{
    await seedPartnerBookingFixture(db,p);
    await db.query(`INSERT INTO app.operator_memberships(operator_id,scope_type,merchant_id,store_id,role_key,status,granted_by)
      VALUES('op_owner','merchant',$1,NULL,'owner','active','synthetic-test')`, [`${p}_m`]);
    await db.query(`DELETE FROM integration.clients WHERE integration_id=$1`,[`${p}_i`]);
    await db.query(`INSERT INTO integration.clients(id,integration_id,issuer,oauth_client_id,subject,status,auth_method,credential_reference)
      VALUES($1,$3,$4,'reads','subject','active','private_key_jwt','fixture'),($2,$3,$4,'reads2','subject2','active','private_key_jwt','fixture')`,[`${p}_c`,`${p}_c2`,`${p}_i`,`https://${p}.invalid`]);

  },false);
  fixtures.push(p);return p;
}
async function quoted(p:string,quantity=2,external="synthetic-external",store="s1"):Promise<PartnerOrderRequest>{
  const quote=await transaction(async db=>createPartnerQuoteForClient(db,await context(db,p,"reads","orders:quote",store),keys,
    {store_id:`${p}_${store}`,items:[{variant_id:`${p}_v1`,quantity}],fulfillment_mode:"pickup"}));
  return {store_id:`${p}_${store}`,quote_id:quote.data.quote_id,external_order_id:external,payment_method:"cod",fulfillment:{mode:"pickup"}};
}
async function book(p:string,body:PartnerOrderRequest,key:string,client="reads",store="s1"){
  return transaction(async db=>bookPartnerOrderForClient(db,await context(db,p,client,"orders:write",store),keys,body,key));
}
async function stock(p:string){return Number((await owner.query("SELECT stocked_quantity FROM public.inventory_level WHERE id=$1",[`${p}_il1`])).rows[0].stocked_quantity);}
beforeAll(async()=>{
  const target=requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);pool=new Pool({connectionString:target.connectionString,max:24});owner=await pool.connect();
  await assertSafeTestDatabaseSentinel(owner,target);
  await ensurePlatformSchema(owner);
});
afterAll(async()=>{
  // Financial facts are append-only even in test. Keep bounded synthetic
  // fixtures for evidence; revoke integrations so they cannot be used later.
  for(const p of fixtures)await owner.query("UPDATE integration.integrations SET status='revoked',writes_enabled=false WHERE id=$1",[`${p}_i`]);
  owner?.release();await pool?.end();await shutdownPlatformDb();
});
describe("S5 real concurrent first calls and commit boundaries",()=>{
  it.each([[false,false],[true,false],[false,true],[true,true]])("recovers a real process kill at commit=%s zero=%s without duplicate effects",async(commit,zero)=>{
    const p=await fixture();if(zero)await owner.query("UPDATE public.price SET amount=0 WHERE id=$1",[`${p}_price`]);const body=await quoted(p);const key="crash-process-key-0001";
    const child=fork(resolve("packages/application/src/__tests__/helpers/partner-booking-crash-process.ts"),[],
      {execArgv:["--import","tsx"],stdio:["ignore","ignore","ignore","ipc"]});
    let observed:{phase:string;orderId?:string};
    try{
      observed=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error("Crash fixture boundary timeout")),8000);
        child.once("message",message=>{clearTimeout(timer);resolve(message as typeof observed);});
        child.once("error",error=>{clearTimeout(timer);reject(error);});
        child.once("exit",()=>{clearTimeout(timer);reject(new Error("Crash fixture exited before boundary"));});
        child.send({prefix:p,body,key,keys,commit});
      });
      expect(observed.phase).toBe(commit?"committed":"before_commit");
    }finally{
      if(child.exitCode===null&&child.signalCode===null)await new Promise<void>(resolve=>{child.once("exit",()=>resolve());child.kill("SIGKILL");});
    }
    const retry=await book(p,body,key);
    expect(retry.status).toBe(commit?200:201);
    if(commit)expect(retry.body.data.order_id).toBe(observed!.orderId);
    expect(await stock(p)).toBe(8);
    expect((await owner.query("SELECT count(*) FROM integration.partner_orders WHERE integration_id=$1",[`${p}_i`])).rows[0].count).toBe("1");
    expect((await owner.query("SELECT count(*) FROM outbox.events WHERE merchant_id=$1 AND event_type='sale.created'",[`${p}_m`])).rows[0].count).toBe("1");
  },12000);

  it("commits zero-value COD, exposes the staff receipt, and cancels without refund or payment facts",async()=>{
    const p=await fixture();
    await owner.query("UPDATE public.price SET amount=0 WHERE id=$1",[`${p}_price`]);
    const body=await quoted(p);const original=await book(p,body,"zero-committed-key-0001");
    expect(original.status).toBe(201);expect(original.body.data.total).toBe(0);
    const coreId=(await owner.query("SELECT core_order_id FROM integration.partner_orders WHERE id=$1",[original.body.data.order_id])).rows[0].core_order_id;
    const scope={scopeKind:"operating" as const,merchantId:`${p}_m`,storeId:`${p}_s1`,stockLocationId:`${p}_l1`};
    const actor={operatorId:"op_owner",role:"owner" as const,organizationId:`${p}_org`,displayName:"Synthetic"};
    const staff=await getOrder(coreId,{merchantId:scope.merchantId,storeIds:[scope.storeId]});
    expect(staff.order).toMatchObject({total:0,paymentStatus:null});
    const cancellation=await quoteOrderCancellation(coreId, scope, actor);
    await cancelOrder({"idempotency-key":`zero-cancel-${randomUUID()}`},coreId,
      {reason:"Synthetic zero cancellation",quoteId:cancellation.quote.quoteId,
       effectiveRevision:cancellation.quote.effectiveRevision,quoteGeneratedAt:cancellation.quote.generatedAt},actor,scope);
    expect(await stock(p)).toBe(10);
    const current=await transaction(async db=>readPartnerOrder(db,await context(db,p,"reads","orders:read"),original.body.data.order_id));
    expect(current.data).toMatchObject({total:0,booking_status:"cancelled",collection_status:"unconfirmed"});
    expect((await book(p,body,"zero-committed-key-0001")).body.data).toEqual(original.body.data);
    expect(await stock(p)).toBe(10);
    for(const table of ["app.payment_events","app.commercial_obligations","app.payment_entries","app.customer_refund_payables"]){
      expect((await owner.query(`SELECT count(*) FROM ${table} WHERE order_id=$1`,[coreId])).rows[0].count).toBe("0");
    }
  });

  it("corrects zero-price quantities and then adds a positively priced item through the staff workflow",async()=>{
    const p=await fixture();await owner.query("UPDATE public.price SET amount=0 WHERE id=$1",[`${p}_price`]);
    const body=await quoted(p);const original=await book(p,body,"zero-correction-key-0001");
    const coreId=(await owner.query("SELECT core_order_id FROM integration.partner_orders WHERE id=$1",[original.body.data.order_id])).rows[0].core_order_id;
    const scope={scopeKind:"operating" as const,merchantId:`${p}_m`,storeId:`${p}_s1`,stockLocationId:`${p}_l1`};
    const actor={operatorId:"op_owner",role:"owner" as const,organizationId:`${p}_org`,displayName:"Synthetic"};
    for(const [baseRevision,quantity] of [[0,3],[1,1]]){
      const correction={baseRevision,reason:"Synthetic free quantity correction",items:[{variantId:`${p}_v1`,quantity}],settlement:{method:"cod",amountReceived:0}};
      expect((await previewOrderCorrection(coreId,correction,actor,scope)).data.totalDelta).toBe(0);
      await applyOrderCorrection({"idempotency-key":`zero-correct-${randomUUID()}`},coreId,correction,actor,scope);
      expect(await stock(p)).toBe(10-quantity);
    }
    expect((await owner.query("SELECT count(*) FROM app.payment_events WHERE order_id=$1",[coreId])).rows[0].count).toBe("0");
    await owner.query("INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity) VALUES($1,$2,$3,10,0)",
      [`${p}_ilv2`,`${p}_item2`,`${p}_l1`]);
    await owner.query("INSERT INTO public.product_variant_price_set(id,variant_id,price_set_id) VALUES($1,$2,$3)",
      [`${p}_vps2`,`${p}_v2`,`${p}_ps`]);
    await owner.query("INSERT INTO inventory.product_settings(variant_id,product_id,merchant_id,cost_price) VALUES($1,$2,$3,100000)",
      [`${p}_v2`,`${p}_product`,`${p}_m`]);
    await owner.query("UPDATE public.price SET amount=250000 WHERE id=$1",[`${p}_price`]);
    const correction={baseRevision:2,reason:"Synthetic positive item correction",items:[{variantId:`${p}_v1`,quantity:1},{variantId:`${p}_v2`,quantity:1}],
      settlement:{method:"cod",amountReceived:250000}};
    expect((await previewOrderCorrection(coreId,correction,actor,scope)).data.totalDelta).toBe(250000);
    await applyOrderCorrection({"idempotency-key":`zero-positive-${randomUUID()}`},coreId,correction,actor,scope);
    const current=await transaction(async db=>readPartnerOrder(db,await context(db,p,"reads","orders:read"),original.body.data.order_id));
    expect(current.data.total).toBe(250000);
    expect((await owner.query("SELECT amount_minor FROM app.payment_events WHERE order_id=$1",[coreId])).rows).toEqual([{amount_minor:"250000"}]);
    const cancellation=await quoteOrderCancellation(coreId, scope, actor);
    await cancelOrder({"idempotency-key":`corrected-zero-cancel-${randomUUID()}`},coreId,
      {reason:"Synthetic corrected cancellation",quoteId:cancellation.quote.quoteId,effectiveRevision:cancellation.quote.effectiveRevision,
        quoteGeneratedAt:cancellation.quote.generatedAt},actor,scope);
    expect(await stock(p)).toBe(10);
    expect(Number((await owner.query("SELECT stocked_quantity FROM public.inventory_level WHERE id=$1",[`${p}_ilv2`])).rows[0].stocked_quantity)).toBe(10);
  });

  it("returns effective staff shipping/cancellation updates while replay retains the booking snapshot",async()=>{
    const p=await fixture();const body=await quoted(p);const original=await book(p,body,"effective-read-key-0001");
    const coreId=(await owner.query("SELECT core_order_id FROM integration.partner_orders WHERE id=$1",[original.body.data.order_id])).rows[0].core_order_id;
    const scope={scopeKind:"operating" as const,merchantId:`${p}_m`,storeId:`${p}_s1`,stockLocationId:`${p}_l1`};
    const actor={operatorId:"op_owner",role:"owner" as const,organizationId:`${p}_org`,displayName:"Synthetic"};
    const shipping={shippingFee:30000,reason:"Synthetic shipping adjustment",paymentMethod:"cod",amountReceived:30000};
    const preview=await previewOrderShippingFee(coreId,shipping,actor,scope);
    await updateOrderShippingFee({"idempotency-key":`shipping-${randomUUID()}`},coreId,
      {...shipping,confirmationToken:preview.data.confirmationToken},actor,scope);
    const detail=await transaction(async db=>{await db.query("SET LOCAL transaction_read_only=on");return readPartnerOrder(db,await context(db,p,"reads","orders:read"),original.body.data.order_id);});
    expect(detail.data.total).toBe(530000);expect(detail.data.collection_status).toBe("unconfirmed");
    const cancellation=await quoteOrderCancellation(coreId, scope, actor);
    await cancelOrder({"idempotency-key":`cancel-${randomUUID()}`},coreId,{reason:"Synthetic cancellation regression",quoteId:cancellation.quote.quoteId,
      effectiveRevision:cancellation.quote.effectiveRevision,quoteGeneratedAt:cancellation.quote.generatedAt},actor,scope);
    const cancelled=await transaction(async db=>{await db.query("SET LOCAL transaction_read_only=on");return readPartnerOrder(db,await context(db,p,"reads","orders:read"),original.body.data.order_id);});
    expect(cancelled.data).toMatchObject({booking_status:"cancelled",total:0});expect(await stock(p)).toBe(10);
    const replay=await book(p,body,"effective-read-key-0001");expect(replay.body.data).toEqual(original.body.data);
  });
  it("paginates owned orders without duplicate rows and binds the cursor to filters/store",async()=>{
    const p=await fixture();
    for(let i=0;i<3;i++)await book(p,await quoted(p,1,`page-order-${i}`),`page-key-number-${i}`);
    const first=await transaction(async db=>listPartnerOrders(db,await context(db,p,"reads","orders:read"),keys,{limit:2}));
    expect(first.data).toHaveLength(2);expect(first.page.next_cursor).toBeTypeOf("string");
    const last=await transaction(async db=>listPartnerOrders(db,await context(db,p,"reads","orders:read"),keys,{limit:2,cursor:first.page.next_cursor!}));
    expect(last.data).toHaveLength(1);expect(new Set([...first.data,...last.data].map(o=>o.order_id)).size).toBe(3);
    await expect(transaction(async db=>listPartnerOrders(db,await context(db,p,"reads","orders:read","s2"),keys,{limit:2,cursor:first.page.next_cursor!})))
      .rejects.toMatchObject({code:"invalid_cursor"});
  });
  it("serializes 20 first calls from two clients into exactly one committed order",async()=>{
    const p=await fixture();const body=await quoted(p);
    const results=await Promise.all(Array.from({length:20},(_,i)=>book(p,body,"concurrent-key-0001",i%2?"reads":"reads2")));
    expect(results.filter(r=>r.status===201)).toHaveLength(1);expect(results.filter(r=>r.status===200)).toHaveLength(19);
    expect(new Set(results.map(r=>r.body.data.order_id)).size).toBe(1);expect(await stock(p)).toBe(8);
    const row=(await owner.query(`SELECT count(*) AS orders,(SELECT count(*) FROM outbox.events WHERE event_type='sale.created'
      AND merchant_id=$2) AS sales FROM integration.partner_orders WHERE integration_id=$1`,[`${p}_i`,`${p}_m`])).rows[0];
    expect(row).toEqual({orders:"1",sales:"1"});
  });
  it("serializes 20 different keys sharing one external reference without double effects",async()=>{
    const p=await fixture();const body=await quoted(p);
    const results=await Promise.all(Array.from({length:20},(_,i)=>book(p,body,`external-key-${String(i).padStart(6,"0")}`)));
    expect(results.filter(r=>r.status===201)).toHaveLength(1);expect(await stock(p)).toBe(8);
    expect((await owner.query("SELECT count(*) FROM integration.idempotency_records WHERE integration_id=$1",[`${p}_i`])).rows[0].count).toBe("20");
  });
  it("keeps external reference uniqueness across stores",async()=>{
    const p=await fixture();const first=await quoted(p);const other=await quoted(p,2,"synthetic-external","s2");
    const results=await Promise.allSettled([book(p,first,"cross-store-key-0001"),book(p,other,"cross-store-key-0002","reads","s2")]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:{code:"external_order_conflict"}});
  });
  it("shares last stock with a staff remote order and never oversells",async()=>{
    const p=await fixture();const body=await quoted(p,6);
    const results=await Promise.allSettled([book(p,body,"last-stock-key-0001"),transaction(db=>createOrderForClient(db,
      {items:[{variantId:`${p}_v1`,quantity:6}],paymentMethod:"cod",amountReceived:0,salesChannel:"telegram"},
      {operatorId:"op_owner",role:"owner",organizationId:`${p}_org`,displayName:"Synthetic"},
      {merchantId:`${p}_m`,storeId:`${p}_s1`,stockLocationId:`${p}_l1`,source:"remote",salesChannelId:"sc_remote",orderStatus:"completed",remoteStatus:"confirmed"}),false)]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(await stock(p)).toBe(4);
    expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:{code:"insufficient_stock"}});
  });
  it("reconciles a lost acknowledgement after commit via the original response",async()=>{
    const p=await fixture();const body=await quoted(p);
    const committed=await book(p,body,"lost-ack-key-0001");
    // Discarding the delivered result represents transport loss after COMMIT;
    // process-kill/socket-level evidence is a separate required E2E case.
    const retried=await book(p,body,"lost-ack-key-0001");expect(retried.status).toBe(200);
    expect(retried.body.data).toEqual(committed.body.data);expect(await stock(p)).toBe(8);
  });
});
