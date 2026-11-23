import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { requireSafeTestDatabaseTarget, assertSafeTestDatabaseSentinel } from "../db/test-database-target";
import { seedPartnerReadFixture } from "./helpers/partner-read-fixture";
import { generatePartnerMcpKey, verifyPartnerMcpKey } from "../partner/mcp-key";

let pool: Pool, db: PoolClient;
let generated: ReturnType<typeof generatePartnerMcpKey>;
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString });
  db = await pool.connect();
  await assertSafeTestDatabaseSentinel(db, target);
});
afterAll(async () => { db?.release(); await pool?.end(); });
beforeEach(async () => {
  await db.query("BEGIN");
  await seedPartnerReadFixture(db);
  generated = generatePartnerMcpKey("sandbox");
  await db.query(`INSERT INTO integration.partner_mcp_keys(id,integration_id,label,secret_hash,scopes,created_by,expires_at)
    VALUES($1,'pr_i','Synthetic',$2,ARRAY['inventory:read'],'fixture-owner',clock_timestamp()+interval '1 day')`,
  [generated.keyId, generated.secretHash]);
});
afterEach(async () => { await db.query("ROLLBACK"); });

describe("Remote MCP key registry and primary query-only verifier", () => {
  it("generates canonical 256-bit bearer secret and persists only its SHA-256 hash", async () => {
    const other = generatePartnerMcpKey("sandbox");
    expect(other.keyId === generated.keyId).toBe(false);
    expect(Buffer.from(generated.key.split('.')[1], "base64url").length).toBe(32);
    const rows = await db.query("SELECT to_jsonb(k) AS data FROM integration.partner_mcp_keys k WHERE id=$1", [generated.keyId]);
    expect(JSON.stringify(rows.rows).includes(generated.key)).toBe(false);
    await db.query("SET LOCAL ROLE snus_partner_api");
    const verified = await verifyPartnerMcpKey(db, `Bearer ${generated.key}`, "sandbox");
    expect(verified).toMatchObject({authMethod:"mcp_key",credentialId:generated.keyId,keyId:generated.keyId,
      clientId:null,integrationId:"pr_i",scopes:["inventory:read"],version:1});
    expect(Object.isFrozen(verified) && Object.isFrozen(verified.scopes)).toBe(true);
    expect(JSON.stringify(verified).includes(generated.secretHash)).toBe(false);
    const before = (await db.query("SELECT to_jsonb(k) AS data FROM integration.partner_mcp_keys k WHERE id=$1", [generated.keyId])).rows;
    await verifyPartnerMcpKey(db, `Bearer ${generated.key}`, "sandbox");
    expect((await db.query("SELECT to_jsonb(k) AS data FROM integration.partner_mcp_keys k WHERE id=$1", [generated.keyId])).rows).toEqual(before);
  });
  it.each([undefined, "", "Bearer staff.jwt.token", "Basic abc", ["Bearer key"], "Bearer " + "x".repeat(200)])(
    "rejects malformed credentials without exposing a different auth profile (%#)", async value => {
      await expect(verifyPartnerMcpKey(db,value,"sandbox")).rejects.toMatchObject({code:"invalid_token",status:401});
    });
  it("gives the same unauthorized error for missing IDs, wrong secret and wrong environment", async () => {
    const missing = generatePartnerMcpKey("sandbox");
    for (const key of [missing.key, generated.key.replace(/\..+$/, `.${missing.key.split('.')[1]}`), generated.key.replace("_test_","_live_")]) {
      await expect(verifyPartnerMcpKey(db,`Bearer ${key}`,"sandbox")).rejects.toMatchObject({code:"invalid_token",status:401});
    }
    await expect(verifyPartnerMcpKey(db,`Bearer ${generated.key}`,"production")).rejects.toMatchObject({code:"invalid_token",status:401});
  });
  it("MCP-20 verifies a production-format hash in a rollback-only registry fixture and denies both cross-environment directions", async () => {
    const production = generatePartnerMcpKey("production");
    await db.query(`INSERT INTO integration.integrations(id,partner_id,merchant_id,environment,installation_key,policy_id,policy_version)
      VALUES('pr_prod_i','pr_p','pr_m','production','production-key-fixture','pr_policy',1)`);
    await db.query(`INSERT INTO integration.partner_mcp_keys(id,integration_id,label,secret_hash,scopes,created_by,expires_at)
      VALUES($1,'pr_prod_i','Rollback-only production format',$2,ARRAY['inventory:read'],'fixture-owner',clock_timestamp()+interval '1 day')`,
    [production.keyId, production.secretHash]);
    const registry = (await db.query("SELECT to_jsonb(k) AS data FROM integration.partner_mcp_keys k WHERE id=$1", [production.keyId])).rows;
    expect(JSON.stringify(registry).includes(production.key)).toBe(false);
    expect(registry[0].data.secret_hash === production.secretHash).toBe(true);
    await db.query("SET LOCAL ROLE snus_partner_api");
    expect(await verifyPartnerMcpKey(db, `Bearer ${production.key}`, "production"))
      .toMatchObject({ keyId: production.keyId, integrationId: "pr_prod_i", authMethod: "mcp_key", clientId: null });
    await expect(verifyPartnerMcpKey(db, `Bearer ${production.key}`, "sandbox")).rejects.toMatchObject({ code: "invalid_token", status: 401 });
    await expect(verifyPartnerMcpKey(db, `Bearer ${generated.key}`, "production")).rejects.toMatchObject({ code: "invalid_token", status: 401 });
    await expect(verifyPartnerMcpKey(db, `Bearer ${production.key.replace("_live_", "_test_")}`, "sandbox")).rejects.toMatchObject({ code: "invalid_token", status: 401 });
    const wrongSecret = production.key.replace(/\..+$/, `.${generated.key.split(".")[1]}`);
    await expect(verifyPartnerMcpKey(db, `Bearer ${wrongSecret}`, "production")).rejects.toMatchObject({ code: "invalid_token", status: 401 });
  });
  it("revocation is final and immediately visible to the verifier", async () => {
    await db.query("UPDATE integration.partner_mcp_keys SET status='revoked',revoked_at=clock_timestamp(),revoked_by='fixture-owner' WHERE id=$1",[generated.keyId]);
    await expect(verifyPartnerMcpKey(db,`Bearer ${generated.key}`,"sandbox")).rejects.toMatchObject({code:"invalid_token"});
    await expect(db.query("UPDATE integration.partner_mcp_keys SET status='active',revoked_at=NULL,revoked_by=NULL WHERE id=$1",[generated.keyId]))
      .rejects.toMatchObject({code:"23514"});
  });
  it("checks expiry against wall clock even in a transaction opened before expiry", async () => {
    await db.query("UPDATE integration.partner_mcp_keys SET expires_at=clock_timestamp()+interval '60 milliseconds' WHERE id=$1",[generated.keyId]);
    await db.query("SELECT pg_sleep(0.08)");
    await expect(verifyPartnerMcpKey(db,`Bearer ${generated.key}`,"sandbox")).rejects.toMatchObject({code:"invalid_token"});
  });
  it.each([
    "UPDATE integration.partner_mcp_keys SET secret_hash=repeat('f',64)",
    "UPDATE integration.partner_mcp_keys SET integration_id='foreign'",
    "UPDATE integration.partner_mcp_keys SET expires_at=expires_at+interval '1 day'",
    "DELETE FROM integration.partner_mcp_keys",
    "UPDATE integration.partner_mcp_keys SET scopes=ARRAY['admin:all']",
  ])("rejects unsafe registry mutation %s", async sql => {
    await expect(db.query(`${sql} WHERE id=$1`,[generated.keyId])).rejects.toMatchObject({code:"23514"});
  });
  it("versions scope edits and denies public credential mutation", async () => {
    await db.query("UPDATE integration.partner_mcp_keys SET scopes=ARRAY['orders:read'],version=99 WHERE id=$1",[generated.keyId]);
    expect((await verifyPartnerMcpKey(db,`Bearer ${generated.key}`,"sandbox")).version).toBe(2);
    await db.query("SET LOCAL ROLE snus_partner_api");
    await expect(db.query("UPDATE integration.partner_mcp_keys SET label='spoof' WHERE id=$1",[generated.keyId])).rejects.toMatchObject({code:"42501"});
  });
  it("maps database failure to a sanitized unavailable response", async () => {
    await db.query("SET LOCAL ROLE snus_partner_maintenance");
    await expect(verifyPartnerMcpKey(db,`Bearer ${generated.key}`,"sandbox")).rejects.toMatchObject({code:"dependency_unavailable",status:503});
  });
});
