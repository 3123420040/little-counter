import { Pool, type PoolClient } from "pg";
import { beforeAll,afterAll,beforeEach,afterEach,describe,it,expect } from "vitest";
import { requireSafeTestDatabaseTarget,assertSafeTestDatabaseSentinel } from "../db/test-database-target";
import { createOrderForClient,type NormalizedOrderInput } from "../services/order-service";
import type { OperatorContext } from "../services/auth-service";
let pool:Pool;let db:PoolClient;let levelId:string;let itemId:string;
const actor:OperatorContext={operatorId:"op_owner",role:"owner",displayName:"Synthetic",organizationId:"org_default"};
const options={source:"remote" as const,salesChannelId:"sc_remote" as const,orderStatus:"completed" as const,remoteStatus:"confirmed" as const,
 merchantId:"merchant_default",storeId:"store_default",stockLocationId:"sloc_default"};
async function order(items:NormalizedOrderInput["items"]){return createOrderForClient(db,{items,paymentMethod:"cod",amountReceived:0,salesChannel:"telegram"},actor,options);}
async function stock(){return Number((await db.query("SELECT stocked_quantity FROM public.inventory_level WHERE id=$1",[levelId])).rows[0].stocked_quantity);}
beforeAll(async()=>{
 const target=requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);pool=new Pool({connectionString:target.connectionString});db=await pool.connect();await assertSafeTestDatabaseSentinel(db,target);
 const row=(await db.query(`SELECT il.id,vii.inventory_item_id FROM public.product_variant_inventory_item vii
 JOIN public.inventory_level il ON il.inventory_item_id=vii.inventory_item_id AND il.location_id='sloc_default' AND il.deleted_at IS NULL
 WHERE vii.variant_id='var_mint_20' AND vii.deleted_at IS NULL`)).rows[0];levelId=row.id;itemId=row.inventory_item_id;
});
afterAll(async()=>{db?.release();await pool?.end();});
beforeEach(async()=>{await db.query("BEGIN");await db.query("UPDATE public.inventory_level SET stocked_quantity=10,reserved_quantity=0 WHERE id=$1",[levelId]);});
afterEach(async()=>{await db.query("ROLLBACK");});
const partnerActor={actorType:"partner" as const,partnerId:"ptn_core",integrationId:"int_core",clientId:"oauth_core",registryClientId:"pcl_core",authMethod:"oauth_client" as const,credentialId:"oauth_core",keyId:null,
 merchantId:"merchant_default",storeId:"store_default",organizationId:"org_default",requestId:"req_core",traceId:"a".repeat(32),grantVersion:3,storeGrantVersion:4};
describe("S4 shared core stock and caller-owned transaction checkpoint",()=>{
 it("rejects an autocommit partner core invocation before writing commerce facts",async()=>{
  const separate=await pool.connect();
  try {
   await expect(createOrderForClient(separate,{items:[{variantId:"var_mint_20",quantity:1}],paymentMethod:"cod",amountReceived:0,
    salesChannel:"website",sourceFlow:"partner_api_v1"},partnerActor,options)).rejects.toMatchObject({code:"25P01"});
  } finally {separate.release();}
  expect(await stock()).toBe(10);
 });
 it("aggregates duplicate variant lines before stock deduction and commercial facts",async()=>{
  const result=await order([{variantId:"var_mint_20",quantity:2},{variantId:"var_mint_20",quantity:3}]);
  expect(await stock()).toBe(5);
  expect(result.data.items).toHaveLength(1);expect(Number(result.data.items[0].quantity)).toBe(5);
  const movement=await db.query("SELECT quantity_change,quantity_after FROM medusa.stock_movements WHERE reference_id=$1 AND movement_type='sale'",[result.data.orderId]);
  expect(movement.rows.map(r=>[Number(r.quantity_change),Number(r.quantity_after)])).toEqual([[-5,5]]);
 });
 it("checks combined need when duplicate lines exceed stock",async()=>{
  await expect(order([{variantId:"var_mint_20",quantity:6},{variantId:"var_mint_20",quantity:6}])).rejects.toMatchObject({code:"insufficient_stock"});
 });
 it("deducts both variants sharing one inventory item rather than overwriting first deduction",async()=>{
  await db.query("UPDATE public.product_variant_inventory_item SET inventory_item_id=$1 WHERE variant_id='var_citrus_20' AND deleted_at IS NULL",[itemId]);
  const result=await order([{variantId:"var_mint_20",quantity:2},{variantId:"var_citrus_20",quantity:3}]);
  expect(await stock()).toBe(5);expect(result.data.items).toHaveLength(2);
  const movement=await db.query("SELECT quantity_change,quantity_after FROM medusa.stock_movements WHERE reference_id=$1 AND movement_type='sale' ORDER BY created_at,id",[result.data.orderId]);
  expect(movement.rows.reduce((sum,r)=>sum+Number(r.quantity_change),0)).toBe(-5);
  expect(movement.rows.some(r=>Number(r.quantity_after)===5)).toBe(true);
 });
 it("rejects combined shared-item shortage before creating a partial order",async()=>{
  await db.query("UPDATE public.product_variant_inventory_item SET inventory_item_id=$1 WHERE variant_id='var_citrus_20' AND deleted_at IS NULL",[itemId]);
  await expect(order([{variantId:"var_mint_20",quantity:6},{variantId:"var_citrus_20",quantity:6}])).rejects.toMatchObject({code:"insufficient_stock"});
 });
 it("keeps all effects inside the caller transaction and rolls back on a later facade failure",async()=>{
  await db.query("SAVEPOINT facade");const result=await order([{variantId:"var_mint_20",quantity:1}]);
  expect(await stock()).toBe(9);await db.query("ROLLBACK TO SAVEPOINT facade");expect(await stock()).toBe(10);
  for(const [table,column] of [['public."order"','id'],['app.payment_entries','order_id'],['audit.events','subject_id'],['outbox.events','aggregate_id'],['medusa.stock_movements','reference_id']]){
   expect((await db.query(`SELECT count(*) FROM ${table} WHERE ${column}=$1`,[result.data.orderId])).rows[0].count).toBe("0");
  }
 });
 it("records a real partner actor without cashier, shift or received-cash evidence",async()=>{
  const result=await createOrderForClient(db,{items:[{variantId:"var_mint_20",quantity:1}],paymentMethod:"cod",amountReceived:0,
   salesChannel:"website",sourceFlow:"partner_api_v1"},partnerActor,options);
  expect(await stock()).toBe(9);
  const orderId=result.data.orderId;
  const audit=(await db.query("SELECT * FROM audit.events WHERE subject_id=$1 AND action='order.partner_created'",[orderId])).rows[0];
  expect(audit).toMatchObject({actor_type:"partner",actor_id:"oauth_core",partner_id:"ptn_core",integration_id:"int_core",client_id:"oauth_core",
   request_id:"req_core",origin_request_id:"req_core",trace_id:"a".repeat(32),grant_version:4,actual_actor_id:null,effective_actor_id:null,channel:"partner_api"});
  const movement=(await db.query("SELECT * FROM medusa.stock_movements WHERE reference_id=$1",[orderId])).rows[0];
  expect(movement).toMatchObject({performed_by:"oauth_core",actor_role_snapshot:"partner",actual_operator_id:null,source_channel:"partner_api",source_action:"partner_booking"});
  const events=(await db.query("SELECT event_type,payload FROM outbox.events WHERE aggregate_id=$1",[orderId])).rows;
  expect(events.find(e=>e.event_type==='sale.created').payload).toMatchObject({actorType:"partner",integrationId:"int_core",clientId:"oauth_core",requestId:"req_core",shiftId:null});
  const payment=(await db.query("SELECT status,evidence_type FROM app.payment_events WHERE order_id=$1 AND kind='charge'",[orderId])).rows[0];
  expect(payment).toEqual({status:"posted",evidence_type:"cod_order_created"});
 });
 it.each([{paymentMethod:"cash",amountReceived:1000000},{shiftId:"staff-shift"},{customerId:"cus_demo"},{discountValue:1000},{amountReceived:1}])("denies staff/payment overrides for partner actor %s",async(overrides)=>{
  await expect(createOrderForClient(db,{items:[{variantId:"var_mint_20",quantity:1}],paymentMethod:"cod",amountReceived:0,
   salesChannel:"website",sourceFlow:"partner_api_v1",...overrides},partnerActor,options)).rejects.toMatchObject({code:"forbidden"});
  expect(await stock()).toBe(10);
 });

});
