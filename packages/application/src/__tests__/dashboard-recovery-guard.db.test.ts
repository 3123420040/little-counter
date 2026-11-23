import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { signJwt } from "../middleware/auth";
import { shutdownPlatformPool } from "../db/client";
import { GET as legacy } from "../../../../src/api/dashboard/route";
import { GET as admin } from "../../../../src/api/admin/dashboard/route";
import { GET as financial } from "../../../../src/api/admin/dashboard/partial-financial/route";

let report:Pool;
let setup:Pool;
const channelToken=randomUUID();
const channelOperators=[`recovery-manager-${randomUUID()}`,`recovery-staff-${randomUUID()}`];
beforeAll(async()=>{
  const target=requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  const url=new URL(target.connectionString);
  if(!process.env.TEST_REPORT_DB_PASS)throw Error("Actual report credential required");
  url.username="snus_v19_report_reader";url.password=process.env.TEST_REPORT_DB_PASS;
  report=new Pool({connectionString:url.toString()});await assertSafeTestDatabaseSentinel(report,target);
  expect((await report.query("SELECT current_user AS role,current_setting('transaction_read_only') AS read_only")).rows[0])
    .toEqual({role:"snus_v19_report_reader",read_only:"on"});
  setup=new Pool({connectionString:target.connectionString,max:1});
  await assertSafeTestDatabaseSentinel(setup,target);
  vi.stubEnv("TELEGRAM_SERVICE_TOKEN",channelToken);
  vi.stubEnv("TELEGRAM_SERVICE_ID","telegram");
  for(const [index,id] of channelOperators.entries()){
    const role=index===0?"manager":"staff";
    await setup.query(`INSERT INTO medusa.staff_users(operator_id,password_hash,display_name,role,organization_id,is_active)
      VALUES($1,'unused','Synthetic channel',$2,'org_default',true)`,[id,role]);
    await setup.query("INSERT INTO app.operator_security_state(operator_id,session_version) VALUES($1,1)",[id]);
    await setup.query(`INSERT INTO app.operator_memberships(operator_id,scope_type,merchant_id,store_id,role_key,granted_by)
      VALUES($1,'store','merchant_default','store_default',$2,'synthetic')`,[id,role]);
    await setup.query(`INSERT INTO app.operator_identities(organization_id,merchant_id,default_store_id,provider,provider_user_id,operator_id)
      VALUES('org_default','merchant_default','store_default','telegram',$1,$1)`,[id]);
  }
});
afterAll(async()=>{
  if(setup){
    for(const table of ["operator_identities","operator_memberships","operator_security_state"]){
      await setup.query(`DELETE FROM app.${table} WHERE operator_id=ANY($1::text[])`,[channelOperators]);
    }
    await setup.query("DELETE FROM medusa.staff_users WHERE operator_id=ANY($1::text[])",[channelOperators]);
    await setup.end();
  }
  vi.unstubAllEnvs();await report?.end();await shutdownPlatformPool();
});
async function call(handler:typeof legacy,operatorId:string,role:string,channel=false){
  let status=200;
  const res={status(code:number){status=code;return this;},json(){},setHeader(){}};
  const authentication=channel?{authorization:`Bearer ${channelToken}`,"x-channel":"telegram","x-channel-user-id":operatorId,"x-merchant-id":"merchant_default"}
    :{authorization:`Bearer ${signJwt({operatorId,role,displayName:"Synthetic",organizationId:"org_default",sessionVersion:1})}`};
  await handler({headers:{...authentication,
    "x-report-merchant-id":"merchant_default","x-report-store-ids":"store_default"},query:{from:"2026-10-18",to:"2026-10-18"}} as never,res as never);
  return status;
}
describe.each([["legacy",legacy],["admin",admin],["financial",financial]] as const)("recovery %s actual role route",(_name,handler)=>{
  it.each([[0,"manager",200],[1,"staff",403]] as const)("keeps actual channel %s %s at %s",async(index,role,status)=>{
    expect(await call(handler,channelOperators[index]!,role,true)).toBe(status);
  });
  it("denies a real staff even with an owner claim",async()=>{expect(await call(handler,"op_staff1","owner")).toBe(403);});
  it.each([["op_owner","owner"],["op_manager","manager"],["op_accountant","accountant"]])("retains %s full access",async(id,role)=>{
    expect(await call(handler,id,role)).toBe(200);
  });
});
