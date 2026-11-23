import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { permissions, type PermissionId, type RequestAccess } from "@medusa-snus/contracts";
import type { OperatorContext } from "../services/auth-service";
import { requireSafeTestDatabaseTarget, assertSafeTestDatabaseSentinel } from "../db/test-database-target";
import { seedPartnerReadFixture } from "./helpers/partner-read-fixture";
import { readPartnerOperationsForClient } from "../partner/operations";
import { ingestPartnerLogs, maintainPartnerObservability } from "../partner/observability";

let pool:Pool,db:PoolClient;
const scope={scopeKind:"merchant_target" as const,merchantId:"pr_m"};
function actor(merchantId="pr_m",grants:PermissionId[]=[permissions.partnerLogsRead]):OperatorContext {
  const access:RequestAccess={actorId:"pr_staff",legacyOrganizationId:"pr_org",isPlatformAdmin:false,
    permissionIds:grants,explicitPermissions:[],memberships:[{membershipId:"pr_member",operatorId:"pr_staff",
      scopeType:"merchant",merchantId,storeId:null,roleKey:"manager",status:"active",permissionIds:grants}]};
  return {operatorId:"pr_staff",role:"manager",organizationId:"pr_org",displayName:"Synthetic",access};
}
function logs(rows:Array<Record<string,unknown>>,ageDays=0) {
  return {resourceLogs:[{scopeLogs:[{logRecords:rows.map(attrs=>({timeUnixNano:String(BigInt(Date.now()-ageDays*86400000)*1000000n),
    severityNumber:attrs.outcome==="denied"?13:9,attributes:Object.entries({environment:"sandbox",merchant_id:"pr_m",integration_id:"pr_i",
    request_id:randomUUID(),method:"GET",...attrs}).map(([key,value])=>({key,value:typeof value==="number"?{doubleValue:value}:{stringValue:String(value)}}))}))}]}]};
}
function query(mode="overview") {return {mode,from:new Date(Date.now()-3600000).toISOString(),to:new Date(Date.now()+10000).toISOString(),limit:2};}
async function run(raw:unknown=query(),who=actor()) {return readPartnerOperationsForClient(db,who,scope,raw,"sandbox",`req_${randomUUID()}`);}
beforeAll(async()=>{const target=requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);pool=new Pool({connectionString:target.connectionString});
  db=await pool.connect();await assertSafeTestDatabaseSentinel(db,target);});
afterAll(async()=>{db?.release();await pool?.end();});
beforeEach(async()=>{await db.query("BEGIN");await seedPartnerReadFixture(db);});
afterEach(async()=>{await db.query("ROLLBACK");});
describe("Operational logs, dashboard, alerts and retention with PostgreSQL ACL",()=>{
  it("deduplicates OTLP delivery and discards forbidden fields before storage",async()=>{
    await db.query("SET LOCAL ROLE snus_partner_observer");const payload=logs([{status:200,body:"SECRET_CANARY",authorization:"SECRET_CANARY"}]);
    expect(await ingestPartnerLogs(db,payload,"sandbox")).toEqual({inserted:1,rejected:0});expect(await ingestPartnerLogs(db,payload,"sandbox")).toEqual({inserted:0,rejected:0});
    expect(JSON.stringify((await db.query("SELECT attributes FROM observability.partner_logs WHERE integration_id='pr_i'")).rows)).not.toContain("SECRET_CANARY");
  });
  it("rejects poison records without discarding valid records in the same committed batch",async()=>{
    await db.query("SET LOCAL ROLE snus_partner_observer");
    const result=await ingestPartnerLogs(db,logs([{status:200},{status:200,environment:"production"},
      {status:200,integration_id:"foreign"},{status:900},{duration_ms:-1}]),"sandbox");
    expect(result).toEqual({inserted:1,rejected:4});
    expect((await db.query("SELECT count(*)::int n FROM observability.partner_logs WHERE integration_id='pr_i'")).rows[0].n).toBe(1);
  });
  it("rejects PostgreSQL-incompatible Unicode and JSONB space expansion before SQL",async()=>{
    const oversized:Record<string,unknown>={};
    for(const key of ["timestamp","service","release","source","request_id","trace_id","span_id","partner_id","client_id","store_id",
      "route","method","outcome","error_code","idempotency_replayed","client_correlation_id","origin_request_id","event_id","core_order_id",
      "parent_span_id","original_request_id","auth_method","credential_id","key_id","transport","tool_name"])oversized[key]="x".repeat(256);
    // Multi-byte characters exercise octet_length rather than JS string length.
    oversized.route="é".repeat(256);oversized.source="é".repeat(256);oversized.service="é".repeat(256);
    oversized.release="é".repeat(256);oversized.timestamp="é".repeat(256);
    const row=logs([oversized]).resourceLogs[0].scopeLogs[0].logRecords[0];
    const attributes=Object.fromEntries(row.attributes.map(attr=>[attr.key,"stringValue" in attr.value?attr.value.stringValue:attr.value.doubleValue]));
    const length=Buffer.byteLength(JSON.stringify(attributes));
    if(length>8190){const bytes=512-(length-8190);oversized.timestamp="é".repeat(Math.floor(bytes/2))+"x".repeat(bytes%2);}
    expect(Object.values(oversized).every(value=>typeof value==="string"&&value.length<=256)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(Object.fromEntries(logs([oversized]).resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map(attr=>[attr.key,"stringValue" in attr.value?attr.value.stringValue:attr.value.doubleValue]))))).toBe(8190);
    await db.query("SET LOCAL ROLE snus_partner_observer");
    const result=await ingestPartnerLogs(db,logs([{request_id:"bad\u0000"},{merchant_id:"bad\u0000"},{request_id:"bad\uD800"},oversized,{request_id:"valid😀"}]),"sandbox");
    expect(result).toEqual({inserted:1,rejected:4});
  });
  it("rejects numeric exponent expansion while retaining finite fractional durations",async()=>{
    await db.query("SET LOCAL ROLE snus_partner_observer");
    expect(await ingestPartnerLogs(db,logs([{source:1e300},{source:1e-300},{duration_ms:1e-300},{duration_ms:"1e-300"},
      {duration_ms:0.000001},{duration_ms:12.5}]),"sandbox")).toEqual({inserted:2,rejected:4});
  });
  it("separates access and security permission and binds scope to the same membership",async()=>{
    await ingestPartnerLogs(db,logs([{status:200},{status:403,outcome:"denied"}]),"sandbox");
    await db.query("SET LOCAL ROLE snus_partner_operations");
    expect((await run(query("access"))).data.rows).toHaveLength(1);
    await expect(run(query("security"))).rejects.toMatchObject({statusCode:403});
    expect((await run(query("security"),actor("pr_m",[permissions.partnerLogsRead,permissions.partnerSecurityRead]))).data.rows).toHaveLength(1);
    await expect(run(query(),actor("pr_other"))).rejects.toMatchObject({statusCode:403});
    await expect(run({...query(),integration_id:"foreign"})).rejects.toMatchObject({statusCode:404});
    await expect(run({...query("access"),after_event_key:"a".repeat(64)})).rejects.toMatchObject({statusCode:400});
  });
  it("computes dashboard metrics and records disclosure audit",async()=>{
    await ingestPartnerLogs(db,logs([{status:200,duration_ms:10},{status:503,duration_ms:30,outcome:"denied"}]),"sandbox");
    await db.query("SET LOCAL ROLE snus_partner_operations");const result=await run();
    expect(result.data.telemetry).toMatchObject({requests:2,server_errors:1,denied:1,p50_ms:20});
    expect(result.data.commerce).toMatchObject({orders:0,booked_value_vnd_minor:"0"});
    await db.query("RESET ROLE");expect((await db.query("SELECT action FROM audit.events WHERE id=$1",[result.meta.audit_id])).rows[0].action).toBe("partner.log_view");
  });
  it("fails closed when disclosure audit cannot be written",async()=>{
    await db.query(`CREATE FUNCTION pg_temp.reject_ops() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='partner.log_view' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await db.query("CREATE TRIGGER fixture_reject_ops BEFORE INSERT ON audit.events FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_ops()");
    await db.query("SET LOCAL ROLE snus_partner_operations");await expect(run()).rejects.toThrow("synthetic audit failure");
  });
  it("separates credential statistics without including worker or foreign-environment traffic",async()=>{
    await ingestPartnerLogs(db,logs([{credential_id:"client-a",status:200,duration_ms:10.5},
      {credential_id:"client-b",status:503,duration_ms:30.5},{credential_id:"client-a",method:"PROCESS",status:500,duration_ms:9999}]),"sandbox");
    await db.query("SET LOCAL ROLE snus_partner_operations");const result=await run();
    expect(result.data.by_credential).toEqual([
      {integration_id:"pr_i",credential_id:"client-a",requests:1,server_errors:0,replays:0,p95_ms:10.5},
      {integration_id:"pr_i",credential_id:"client-b",requests:1,server_errors:1,replays:0,p95_ms:30.5}]);
    expect(result.data.credentials_truncated).toBe(false);
  });
  it("excludes worker traffic and the other environment from HTTP dashboard metrics",async()=>{
    await ingestPartnerLogs(db,logs([{status:200,duration_ms:10},{status:500,duration_ms:9999,method:"PROCESS"}]),"sandbox");
    await db.query(`INSERT INTO observability.partner_logs(event_key,observed_at,merchant_id,integration_id,security,attributes)
      VALUES($1,clock_timestamp(),'pr_m','pr_i',false,'{"environment":"production","method":"GET","status":500,"duration_ms":9999}')`,["b".repeat(64)]);
    await db.query("SET LOCAL ROLE snus_partner_operations");const result=await run();
    expect(result.data.telemetry).toMatchObject({requests:1,server_errors:0,p95_ms:10});
    expect((await run(query("access"))).data.rows).toHaveLength(2);
  });
  it("purges expired access at 30 days and security at 90 days while preserving retained records",async()=>{
    await db.query("SET LOCAL ROLE snus_partner_observer");
    for(const age of [29,31,89,91])await ingestPartnerLogs(db,logs([{status:200},{status:403,outcome:"denied"}],age),"sandbox");
    await maintainPartnerObservability(db);
    const rows=(await db.query("SELECT security,count(*)::int n FROM observability.partner_logs WHERE integration_id='pr_i' GROUP BY security ORDER BY security")).rows;
    expect(rows).toEqual([{security:false,n:1},{security:true,n:3}]);
  });
  it("activates and recovers business and exporter alerts",async()=>{
    await db.query("SET LOCAL ROLE snus_partner_observer");
    await ingestPartnerLogs(db,logs(Array.from({length:51},(_,n)=>({status:n<3?503:200,duration_ms:2500,
      method:"POST",tool_name:"book_order",outcome:n<22?"denied":"success",...(n===0?{error_code:"internal_error"}:{})}))),"sandbox");
    await maintainPartnerObservability(db,[{source:"process-1",code:"telemetry_dropped",active:true}]);
    const codes=(await db.query("SELECT code FROM observability.partner_alerts WHERE active AND (merchant_id='pr_m' OR code='telemetry_dropped')")).rows.map(r=>r.code);
    expect(codes).toEqual(expect.arrayContaining(["partner_5xx_rate","partner_auth_denials","partner_booking_latency","partner_internal_failure","telemetry_dropped"]));
    await db.query("DELETE FROM observability.partner_logs WHERE integration_id='pr_i'");await maintainPartnerObservability(db);
    expect((await db.query("SELECT count(*)::int n FROM observability.partner_alerts WHERE active AND code='telemetry_dropped'")).rows[0].n).toBe(0);
  });
  it.each(["SELECT secret_hash FROM integration.partner_mcp_keys","SELECT * FROM integration.order_contacts",
    "UPDATE audit.events SET reason='bad' WHERE false","DELETE FROM observability.partner_logs WHERE false"])("operations role denies %s",async sql=>{
    await db.query("SET LOCAL ROLE snus_partner_operations");await expect(db.query(sql)).rejects.toMatchObject({code:"42501"});
  });
});
