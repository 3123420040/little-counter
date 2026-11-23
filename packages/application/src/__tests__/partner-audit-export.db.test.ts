import { createHash,randomUUID } from "node:crypto";
import { Pool,type PoolClient } from "pg";
import { beforeAll,afterAll,beforeEach,afterEach,describe,it,expect } from "vitest";
import { permissions,type RequestAccess } from "@medusa-snus/contracts";
import type { OperatorContext } from "../services/auth-service";
import { requireSafeTestDatabaseTarget,assertSafeTestDatabaseSentinel } from "../db/test-database-target";
import { seedPartnerReadFixture } from "./helpers/partner-read-fixture";
import { exportPartnerAuditForClient } from "../partner/audit-export";

let pool:Pool,db:PoolClient;
const scope={scopeKind:"merchant_target" as const,merchantId:"pr_m"};
function actor(merchantId="pr_m",permission=permissions.accountingRead):OperatorContext{
  const access:RequestAccess={actorId:"pr_staff",legacyOrganizationId:"pr_org",isPlatformAdmin:false,
    permissionIds:[permission],explicitPermissions:[],memberships:[{membershipId:"pr_member",operatorId:"pr_staff",
      scopeType:"merchant",merchantId,storeId:null,roleKey:"accountant",status:"active",permissionIds:[permission]}]};
  return {operatorId:"pr_staff",role:"accountant",organizationId:"pr_org",displayName:"Synthetic",access};
}
const query={integration_id:"pr_i",from:"2026-01-01T00:00:00Z",to:"2026-01-02T00:00:00Z",limit:2};
async function run(raw:unknown=query,who=actor(),environment:"sandbox"|"production"="sandbox"){
  return exportPartnerAuditForClient(db,who,scope,raw,environment,`req_${randomUUID()}`);
}
beforeAll(async()=>{const target=requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);pool=new Pool({connectionString:target.connectionString});
  db=await pool.connect();await assertSafeTestDatabaseSentinel(db,target);});
afterAll(async()=>{db?.release();await pool?.end();});
beforeEach(async()=>{
  await db.query("BEGIN");await seedPartnerReadFixture(db);
  for(let n=1;n<=3;n++)await db.query(`INSERT INTO audit.events(organization_id,merchant_id,actor_type,actor_id,action,
    subject_type,subject_id,created_at,before,after,reason,correlation_id)
    VALUES('pr_org','pr_m','owner','pr_staff','partner.set_status','partner_integration','pr_i',
      '2026-01-01T01:00:00Z'::timestamptz + $1*interval '1 microsecond','{"private":"SECRET_CANARY"}','{"contact":"SECRET_CANARY"}','SECRET_CANARY','synthetic')`,[n]);
  await db.query("SET LOCAL ROLE snus_partner_audit");
});
afterEach(async()=>{await db.query("ROLLBACK");});
describe("Scoped partner audit projection/export with real ACL and disclosure audit",()=>{
  it("exports exact checksummed bytes and writes receipt without raw private fields",async()=>{
    const result=await run(),data=JSON.parse(result.data.content);
    expect(data.rows).toHaveLength(2);expect(result.data.sha256).toBe(createHash("sha256").update(result.data.content).digest("hex"));
    expect(result.data.content).not.toMatch(/SECRET_CANARY|before|reason|actor_chain/);
    await db.query("RESET ROLE");const receipt=(await db.query("SELECT action,after,merchant_id,actor_id FROM audit.events WHERE id=$1",[result.meta.audit_id])).rows[0];
    expect(receipt).toMatchObject({action:"partner.audit_export",merchant_id:"pr_m",actor_id:"pr_staff",after:{sha256:result.data.sha256,row_count:2}});
    expect(createHash("sha256").update(result.data.content+" ").digest("hex")).not.toBe(result.data.sha256);
  });
  it("paginates microsecond timestamps without duplicate or missing rows",async()=>{
    const first=await run(),second=await run({...query,after_id:first.data.next_after_id});
    const rows=[...JSON.parse(first.data.content).rows,...JSON.parse(second.data.content).rows];
    expect(rows).toHaveLength(3);expect(new Set(rows.map(r=>r.id)).size).toBe(3);expect(second.data.next_after_id).toBeNull();
  });
  it("requires permission and target from the same membership",async()=>{
    await expect(run(query,actor("pr_other_m"))).rejects.toMatchObject({statusCode:403});
    const wrong=actor();wrong.access!.memberships[0].permissionIds=[];
    await expect(run(query,wrong)).rejects.toMatchObject({statusCode:403});
    await expect(run({...query,integration_id:"pr_other_i"})).rejects.toMatchObject({statusCode:404});
    await expect(run(query,actor(),"production")).rejects.toMatchObject({statusCode:404});
  });
  it("rejects foreign cursor, broad range, oversized page and unknown properties",async()=>{
    for(const raw of [{...query,after_id:randomUUID()},{...query,to:"2026-03-01T00:00:00Z"},
      {...query,limit:201},{...query,merchant_id:"pr_other_m"}])await expect(run(raw)).rejects.toMatchObject({statusCode:400});
  });
  it("reads retained events from a revoked integration",async()=>{
    await db.query("RESET ROLE");await db.query("UPDATE integration.integrations SET status='revoked' WHERE id='pr_i'");
    await db.query("SET LOCAL ROLE snus_partner_audit");expect((await run()).data.row_count).toBe(2);
  });
  it("does not disclose a page when transactional export audit fails",async()=>{
    await db.query("RESET ROLE");await db.query(`CREATE FUNCTION pg_temp.reject_audit_export() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='partner.audit_export' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await db.query("CREATE TRIGGER fixture_reject_export BEFORE INSERT ON audit.events FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_audit_export()");
    await db.query("SET LOCAL ROLE snus_partner_audit");await expect(run()).rejects.toThrow("synthetic audit failure");
  });
  it.each(["SELECT before FROM audit.events","SELECT secret_hash FROM integration.partner_mcp_keys",
    "SELECT * FROM integration.order_contacts","UPDATE audit.events SET reason='bad' WHERE false","DELETE FROM audit.events WHERE false"])("denies forbidden SQL: %s",async sql=>{
    await expect(db.query(sql)).rejects.toMatchObject({code:"42501"});
  });
});
