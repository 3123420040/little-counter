import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { permissions, type RequestAccess } from "@medusa-snus/contracts";
import { requireSafeTestDatabaseTarget, assertSafeTestDatabaseSentinel } from "../db/test-database-target";
import { seedPartnerReadFixture } from "./helpers/partner-read-fixture";
import { executePartnerControlForClient, readPartnerControlForClient } from "../partner/control";
import type { OperatorContext } from "../services/auth-service";
import { verifyPartnerMcpKey } from "../partner/mcp-key";

let pool: Pool; let db: PoolClient;
function actor(merchantId = "pr_m"): OperatorContext {
  const access: RequestAccess = { actorId: "pr_staff", legacyOrganizationId: "pr_org", isPlatformAdmin: false,
    permissionIds: [permissions.partnerManage], explicitPermissions: [], memberships: [{
      membershipId: "pr_membership", operatorId: "pr_staff", scopeType: "merchant", merchantId, storeId: null,
      roleKey: "owner", status: "active", permissionIds: [permissions.partnerManage],
    }] };
  return { operatorId: "pr_staff", role: "owner", organizationId: "pr_org", displayName: "Synthetic staff", access };
}
const scope = { scopeKind: "merchant_target" as const, merchantId: "pr_m" };
const policy = { currency: "VND", max_order_total: 10000000, max_quantity: 100, safety_stock: 0, delivery_fee: null,
  contact_retention_days: 30, read_per_minute: 120, read_burst: 20, quote_per_minute: 30, quote_burst: 5,
  book_per_minute: 10, book_burst: 2, mutation_concurrency: 2 };
async function execute(command: unknown, who = actor()) {
  return executePartnerControlForClient(db, who, scope, command, "sandbox", "https://fixture.invalid", "pr_request");
}
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString }); db = await pool.connect();
  await assertSafeTestDatabaseSentinel(db, target);
});
afterAll(async () => { db?.release(); await pool?.end(); });
beforeEach(async () => { await db.query("BEGIN"); await seedPartnerReadFixture(db); await db.query("SET LOCAL ROLE snus_partner_control"); });
afterEach(async () => { await db.query("ROLLBACK"); });
describe("S2 staff control commands with real PostgreSQL ACL and coupled scope proof", () => {
  it("changes key scopes under staff control with versioned audit and immediate verifier effect", async()=>{
    const created=await execute({action:"create_mcp_key",integration_id:"pr_i",reason:"onboarding"});
    const result=await execute({action:"set_mcp_key_scopes",integration_id:"pr_i",key_id:created.key_id,scopes:["orders:read"],reason:"commercial_policy"});
    expect(result).toMatchObject({key_id:created.key_id,scopes:["orders:read"],version:2});
    expect(result.revealed_key).toBeUndefined();
    expect(await verifyPartnerMcpKey(db,`Bearer ${created.revealed_key}`,"sandbox")).toMatchObject({version:2,scopes:["orders:read"]});
    await db.query("RESET ROLE");
    const audit=(await db.query("SELECT after FROM audit.events WHERE subject_id='pr_i' AND action='partner.set_mcp_key_scopes'")).rows;
    expect(audit).toHaveLength(1);expect(audit[0].after).toMatchObject({scopes:["orders:read"],version:2});
    expect(JSON.stringify(audit).includes(String(created.revealed_key))).toBe(false);
  });
  it("creates a usable MCP key without an OAuth issuer and never includes secrets in lifecycle audit or status", async () => {
    const result=await executePartnerControlForClient(db,actor(),scope,
      {action:"create_mcp_key",integration_id:"pr_i",reason:"onboarding"},"sandbox",undefined,"req_key_create");
    const key=String(result.revealed_key);
    expect(key.startsWith("snus_mcp_test_")).toBe(true);
    const status=await readPartnerControlForClient(db,actor(),scope,{integration_id:"pr_i"},"sandbox");
    expect(status.keys).toHaveLength(1);
    expect(status.keys[0].scopes).toEqual(["partner:read","catalog:read","inventory:read","orders:read"]);
    expect(JSON.stringify(status).includes(key)).toBe(false);
    expect(JSON.stringify(status)).not.toMatch(/secret_hash|revealed_key/);
    await db.query("RESET ROLE");
    const audit=(await db.query("SELECT action,actor_id,after FROM audit.events WHERE request_id='req_key_create'")).rows;
    expect(audit).toHaveLength(1);expect(audit[0]).toMatchObject({action:"partner.create_mcp_key",actor_id:"pr_staff"});
    expect(JSON.stringify(audit).includes(key)).toBe(false);expect(JSON.stringify(audit)).not.toMatch(/secret_hash|revealed_key/);
    expect((await verifyPartnerMcpKey(db,`Bearer ${key}`,"sandbox")).clientId).toBeNull();
  });
  it("sets MCP catalog mode without an OAuth issuer, versions the grant and preserves it through legacy set_grant", async () => {
    const result = await executePartnerControlForClient(db, actor(), scope,
      { action: "set_mcp_catalog_mode", integration_id: "pr_i", store_id: "pr_s1", mcp_catalog_mode: "merchant_published", reason: "commercial_policy" },
      "sandbox", undefined, "req_catalog_mode");
    expect(result).toMatchObject({ store_id: "pr_s1", mcp_catalog_mode: "merchant_published", version: 2 });
    await execute({ action: "set_grant", integration_id: "pr_i", store_id: "pr_s1", assortment_id: "pr_a",
      scopes: ["partner:read", "inventory:read", "catalog:read", "orders:write"], status: "active", reason: "commercial_policy" });
    const status = await readPartnerControlForClient(db, actor(), scope, { integration_id: "pr_i" }, "sandbox");
    expect(status.grants).toContainEqual(expect.objectContaining({ store_id: "pr_s1", mcp_catalog_mode: "merchant_published", version: 2 }));
    await db.query("RESET ROLE");
    const audit = (await db.query("SELECT after FROM audit.events WHERE request_id='req_catalog_mode'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].after).toMatchObject({ store_id: "pr_s1", mcp_catalog_mode: "merchant_published", version: 2 });
  });
  it("activates a key-only integration and revokes the key with integration disable", async () => {
    const result=await execute({action:"create_mcp_key",integration_id:"pr_i",reason:"onboarding"});
    await db.query("UPDATE integration.clients SET status='revoked' WHERE integration_id='pr_i'");
    await expect(execute({action:"set_status",integration_id:"pr_i",status:"active",writes_enabled:false,
      conformance_receipt_sha256:"a".repeat(64),reason:"onboarding"})).resolves.toMatchObject({status:"active"});
    await execute({action:"set_status",integration_id:"pr_i",status:"revoked",writes_enabled:false,reason:"security_incident"});
    await expect(verifyPartnerMcpKey(db,`Bearer ${result.revealed_key}`,"sandbox")).rejects.toMatchObject({code:"invalid_token"});
  });
  it("rotates within 24 hours without changing integration or scopes and supports orphan revoke", async () => {
    const first=await execute({action:"create_mcp_key",integration_id:"pr_i",scopes:["orders:read"],reason:"onboarding"});
    const next=await execute({action:"rotate_mcp_key",integration_id:"pr_i",key_id:first.key_id,reason:"credential_rotation"});
    const a=await verifyPartnerMcpKey(db,`Bearer ${first.revealed_key}`,"sandbox");
    const b=await verifyPartnerMcpKey(db,`Bearer ${next.revealed_key}`,"sandbox");
    expect(a.keyId===b.keyId).toBe(false);expect(a.integrationId).toBe(b.integrationId);expect(a.scopes).toEqual(b.scopes);
    expect((await db.query(`SELECT expires_at<=clock_timestamp()+interval '24 hours' AS bounded
      FROM integration.partner_mcp_keys WHERE id=$1`,[first.key_id])).rows[0].bounded).toBe(true);
    await execute({action:"revoke_mcp_key",integration_id:"pr_i",key_id:next.key_id,reason:"operator_request"});
    await expect(verifyPartnerMcpKey(db,`Bearer ${next.revealed_key}`,"sandbox")).rejects.toMatchObject({code:"invalid_token"});
    await expect(execute({action:"revoke_mcp_key",integration_id:"pr_i",key_id:next.key_id,reason:"operator_request"})).resolves.toMatchObject({status:"revoked"});
  });
  it("rolls back a newly generated hash if lifecycle audit fails", async () => {
    await db.query("SAVEPOINT failed_key");
    const who=actor();
    await db.query("RESET ROLE");
    await db.query(`CREATE FUNCTION pg_temp.reject_mcp_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='partner.create_mcp_key' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await db.query("CREATE TRIGGER fixture_mcp_audit_failure BEFORE INSERT ON audit.events FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_mcp_audit()");
    await db.query("SET LOCAL ROLE snus_partner_control");
    await expect(execute({action:"create_mcp_key",integration_id:"pr_i",reason:"onboarding"},who)).rejects.toThrow("synthetic audit failure");
    await db.query("ROLLBACK TO SAVEPOINT failed_key");
    expect((await db.query("SELECT count(*)::int AS n FROM integration.partner_mcp_keys WHERE integration_id='pr_i'")).rows[0].n).toBe(0);
  });
  it("reads scoped lifecycle status without exposing AS credential references or writing", async () => {
    const queued=await execute({action:"provision_client",integration_id:"pr_i",auth_method:"client_secret_basic",credential_reference:"private-canary",reason:"onboarding"});
    const before=(await db.query("SELECT count(*) FROM integration.control_operations")).rows[0];
    await db.query("SET TRANSACTION READ ONLY");
    const status=await readPartnerControlForClient(db,actor(),scope,{integration_id:"pr_i"},"sandbox");
    expect(status).toMatchObject({integration_id:"pr_i",environment:"sandbox",status:"active",clients:[{client_id:"pr_c"}],
      operations:[{operation_id:queued.operation_id,status:"pending",attempts:0}]});
    expect(JSON.stringify(status)).not.toMatch(/private-canary|credential_reference|as_client_id|claim_token/);
    expect((await db.query("SELECT count(*) FROM integration.control_operations")).rows[0]).toEqual(before);
  });
  it("keeps status ownership, environment, input and merchant authority fail closed", async () => {
    const read=(query: unknown, who=actor(), env="sandbox" as "sandbox"|"production")=>readPartnerControlForClient(db,who,scope,query,env);
    await expect(read({integration_id:"pr_i"},actor("foreign"))).rejects.toMatchObject({statusCode:403});
    await expect(read({integration_id:"missing"})).rejects.toMatchObject({statusCode:404});
    await expect(read({integration_id:"pr_i"},actor(),"production")).rejects.toMatchObject({statusCode:404});
    await expect(read({integration_id:"pr_i",merchant_id:"foreign"})).rejects.toMatchObject({statusCode:400});
    await expect(read({integration_id:["pr_i"]})).rejects.toMatchObject({statusCode:400});
  });
  it("pages operation history with a bounded stable keyset", async () => {
    for(let index=0;index<53;index++)await execute({action:"provision_client",integration_id:"pr_i",auth_method:"client_secret_basic",credential_reference:"fixture",reason:"onboarding"});
    const first=await readPartnerControlForClient(db,actor(),scope,{integration_id:"pr_i"},"sandbox");
    expect(first.operations).toHaveLength(50); expect(first.next.operations_after).toBeTruthy();
    const second=await readPartnerControlForClient(db,actor(),scope,{integration_id:"pr_i",operations_after:first.next.operations_after},"sandbox");
    expect(second.operations).toHaveLength(3); expect(second.next.operations_after).toBeNull();
    expect(new Set([...first.operations,...second.operations].map((op)=>op.operation_id)).size).toBe(53);
  });
  it("creates an inactive integration with immutable finite policy and transactional audit", async () => {
    const result = await execute({ action: "create", installation_key: "fixture", partner_name: "Synthetic", environment: "sandbox", policy, reason: "onboarding" });
    expect(result).toMatchObject({ status: "inactive", writes_enabled: false, policy_version: 1 });
    const row = (await db.query("SELECT * FROM integration.integrations WHERE id=$1", [result.integration_id])).rows[0];
    expect(row.merchant_id).toBe("pr_m");
    await db.query("RESET ROLE");
    const audit = (await db.query("SELECT action,actor_id,merchant_id,after FROM audit.events WHERE request_id='pr_request'")).rows[0];
    expect(audit).toMatchObject({ action: "partner.create", actor_id: "pr_staff", merchant_id: "pr_m" });
    expect(JSON.stringify(audit.after)).not.toContain("credential");
  });
  it("rejects permission from a different merchant despite its aggregate permission union", async () => {
    await expect(execute({ action: "set_policy", integration_id: "pr_i", policy, reason: "commercial_policy" }, actor("pr_other")))
      .rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
  });
  it("does not use store-scoped manage permission as merchant-wide authority", async () => {
    const who = actor(); who.access!.memberships[0].scopeType = "store"; who.access!.memberships[0].storeId = "pr_s1";
    await expect(execute({ action: "set_policy", integration_id: "pr_i", policy, reason: "commercial_policy" }, who))
      .rejects.toMatchObject({ code: "forbidden" });
  });
  it("rejects unknown integration within a valid staff merchant scope", async () => {
    await expect(execute({ action: "set_policy", integration_id: "foreign", policy, reason: "commercial_policy" }))
      .rejects.toMatchObject({ code: "resource_not_found" });
  });
  it("appends a policy revision and bumps integration authorization version", async () => {
    await execute({ action: "set_policy", integration_id: "pr_i", policy, reason: "commercial_policy" });
    const row = (await db.query("SELECT policy_version,grant_version FROM integration.integrations WHERE id='pr_i'")).rows[0];
    expect(row).toEqual({ policy_version: 2, grant_version: 2 });
    expect((await db.query("SELECT version FROM integration.policies WHERE id='pr_policy' ORDER BY version")).rows.map((r) => r.version)).toEqual([1, 2]);
  });
  it("replaces a scoped assortment and resolves grant stock location on the server", async () => {
    const result = await execute({ action: "set_assortment", integration_id: "pr_i", variant_ids: ["pr_v1"], status: "active", reason: "commercial_policy" });
    await execute({ action: "set_grant", integration_id: "pr_i", store_id: "pr_s2", assortment_id: result.assortment_id,
      scopes: ["orders:read"], status: "active", reason: "operator_request" });
    const row = (await db.query("SELECT stock_location_id,allowed_scopes,version FROM integration.store_grants WHERE integration_id='pr_i' AND store_id='pr_s2'")).rows[0];
    expect(row).toEqual({ stock_location_id: "pr_l2", allowed_scopes: ["orders:read"], version: 2 });
  });
  it("rejects assortment variants outside the merchant", async () => {
    await expect(execute({ action: "set_assortment", integration_id: "pr_i", variant_ids: ["foreign"], status: "active", reason: "commercial_policy" }))
      .rejects.toMatchObject({ code: "resource_not_found" });
  });
  it("creates a packet-bound assortment identity and refuses to overwrite it", async () => {
    const command = { action: "set_assortment", integration_id: "pr_i", new_assortment_id: "pr_packet_assortment",
      variant_ids: ["pr_v1"], status: "active", reason: "onboarding" };
    const result = await execute(command);
    expect(result.assortment_id).toBe(command.new_assortment_id);
    await expect(execute({ ...command, variant_ids: [] })).rejects.toMatchObject({ code: "assortment_identity_conflict", statusCode: 409 });
    expect((await db.query("SELECT variant_id FROM integration.assortment_items WHERE assortment_id=$1", [command.new_assortment_id])).rows)
      .toEqual([{ variant_id: "pr_v1" }]);
  });
  it("does not treat a foreign assortment collision as an update", async () => {
    await db.query("INSERT INTO integration.assortments(id,merchant_id,status) VALUES ('pr_foreign_reserved','pr_other','inactive')");
    await expect(execute({ action: "set_assortment", integration_id: "pr_i", new_assortment_id: "pr_foreign_reserved",
      variant_ids: ["pr_v1"], status: "active", reason: "onboarding" })).rejects.toMatchObject({ code: "assortment_identity_conflict" });
    expect((await db.query("SELECT merchant_id,status FROM integration.assortments WHERE id='pr_foreign_reserved'")).rows[0])
      .toEqual({ merchant_id: "pr_other", status: "inactive" });
  });
  it("rejects simultaneous new and existing assortment identities", async () => {
    await expect(execute({ action: "set_assortment", integration_id: "pr_i", assortment_id: "pr_a", new_assortment_id: "pr_new",
      variant_ids: [], status: "active", reason: "onboarding" })).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("rejects stock location override instead of silently ignoring it", async () => {
    await expect(execute({ action: "set_grant", integration_id: "pr_i", store_id: "pr_s1", assortment_id: "pr_a", stock_location_id: "foreign",
      scopes: ["orders:read"], status: "active", reason: "operator_request" })).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("queues AS provisioning before any registry client becomes active", async () => {
    const result = await execute({ action: "provision_client", integration_id: "pr_i", auth_method: "private_key_jwt", credential_reference: "public-key-fixture", reason: "onboarding" });
    expect(result.status).toBe("pending");
    const op = (await db.query("SELECT * FROM integration.control_operations WHERE id=$1", [result.operation_id])).rows[0];
    expect(op.client_id).toBeNull(); expect(op.credential_reference).toBe("public-key-fixture");
    expect((await db.query("SELECT count(*) FROM integration.clients WHERE integration_id='pr_i'")).rows[0].count).toBe("1");
  });
  it("revokes locally and durably queues AS cleanup in the same transaction", async () => {
    const result = await execute({ action: "revoke_client", integration_id: "pr_i", client_id: "pr_c", reason: "security_incident" });
    expect(result.status).toBe("revoked");
    expect((await db.query("SELECT status FROM integration.clients WHERE id='pr_c'")).rows[0].status).toBe("revoked");
    expect((await db.query("SELECT kind,status FROM integration.control_operations WHERE id=$1", [result.operation_id])).rows[0])
      .toEqual({ kind: "revoke", status: "pending" });
  });
  it("requires conformance attestation before activation and capability before enabling writes", async () => {
    await expect(execute({ action: "set_status", integration_id: "pr_i", status: "active", writes_enabled: true, reason: "onboarding" }))
      .rejects.toMatchObject({ code: "conformance_required" });
    await execute({ action: "set_status", integration_id: "pr_i", status: "active", writes_enabled: true,
      conformance_receipt_sha256: "a".repeat(64), reason: "onboarding" });
    await db.query("RESET ROLE"); await db.query("DELETE FROM app.merchant_subscriptions WHERE id='pr_sub'"); await db.query("SET LOCAL ROLE snus_partner_control");
    await expect(execute({ action: "set_status", integration_id: "pr_i", status: "active", writes_enabled: true,
      conformance_receipt_sha256: "a".repeat(64), reason: "onboarding" })).rejects.toMatchObject({ code: "merchant_capability_denied" });
  });
  it("rolls back a control mutation if durable audit INSERT fails", async () => {
    await db.query("RESET ROLE; SAVEPOINT audit_failure; REVOKE INSERT ON audit.events FROM snus_partner_control; SET LOCAL ROLE snus_partner_control");
    await expect(execute({ action: "set_policy", integration_id: "pr_i", policy, reason: "commercial_policy" }))
      .rejects.toMatchObject({ code: "42501" });
    await db.query("ROLLBACK TO SAVEPOINT audit_failure");
    expect((await db.query("SELECT policy_version FROM integration.integrations WHERE id='pr_i'")).rows[0].policy_version).toBe(1);
  });
});
