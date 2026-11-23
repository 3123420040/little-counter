import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectPlatformClient, shutdownPlatformPool, type PoolClient } from "../db/client";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { seedPartnerReadFixture } from "./helpers/partner-read-fixture";
import { generatePartnerMcpKey } from "../partner/mcp-key";
import { PlatformMcpCommandMetadataV1Schema, type PlatformMcpCommandMetadataV1 } from "@medusa-snus/contracts";
import { revokePlatformMcpKeyForClient, pausePlatformMcpConnectionForClient, issuePlatformMcpKeyForClient, rotatePlatformMcpKeyForClient,
  createPlatformMcpConnectionForClient, resumePlatformMcpConnectionForClient } from "../partner/platform-mcp-control";
import { platformMcpReadinessFixture } from "./helpers/platform-mcp-readiness-fixture";
import { maintainPartnerRetentionForClient } from "../partner/maintenance";
import { platformMcpIssuancePresetV1, platformMcpProfileScopesV1 } from "../services/platform-mcp-policy";
import { hashPlatformMcpPolicyV1 } from "../services/platform-mcp-authorization-snapshot";
import { loadPlatformMcpAuthorizationForClient } from "../partner/platform-mcp-authorization";
import { getPlatformMcpConnectionForClient } from "../partner/platform-mcp-metadata";
import type { OperatorContext } from "../services/auth-service";
import { readPartnerMcpIdentity, selectPartnerStore } from "../partner/registry";
import { readPartnerCatalog } from "../partner/catalog";
let db: PoolClient;
beforeAll(async () => { db = await connectPlatformClient(); await assertSafeTestDatabaseSentinel(db, requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL)); });
afterAll(async () => { db?.release(); await shutdownPlatformPool(); });
beforeEach(async () => { await db.query("BEGIN"); await seedPartnerReadFixture(db); });
afterEach(async () => { await db.query("ROLLBACK"); });

async function keyFixture(integrationId: string, ttlDays = 1, scopes: readonly string[] = platformMcpProfileScopesV1.read) {
  const generated = generatePartnerMcpKey("sandbox");
  await db.query(`INSERT INTO integration.partner_mcp_keys(id,integration_id,label,secret_hash,scopes,created_by,expires_at)
    VALUES($1,$2,'UAT agent',$3,$5,'UAT',clock_timestamp()+$4*interval '1 day')`,
  [generated.keyId, integrationId, generated.secretHash, ttlDays, scopes]);
  return { id: generated.keyId, raw: generated.key };
}
async function receiptFixture(managed = false, profile: "read" | "commerce" = "read") {
  const scopes = platformMcpProfileScopesV1[profile];
  const receiptId = randomUUID(), integrationId = managed ? `managed_${randomUUID()}` : "pr_i";
  const policyId = managed ? `managed_policy_${randomUUID()}` : "pr_policy";
  if (managed) await db.query(`INSERT INTO integration.policies(id,version,merchant_id,currency,max_order_total,max_quantity,safety_stock,delivery_fee,
    contact_retention_days,read_per_minute,read_burst,quote_per_minute,quote_burst,book_per_minute,book_burst,mutation_concurrency)
    SELECT $1,1,merchant_id,currency,max_order_total,max_quantity,0,delivery_fee,contact_retention_days,read_per_minute,read_burst,
      quote_per_minute,quote_burst,book_per_minute,book_burst,mutation_concurrency FROM integration.policies WHERE id='pr_policy' AND version=1`, [policyId]);
  if (managed) await db.query(`INSERT INTO integration.integrations(id,partner_id,merchant_id,environment,installation_key,policy_id,policy_version,platform_mcp_origin_receipt_id)
    VALUES($1,'pr_p','pr_m','sandbox',$1,$3,1,$2)`, [integrationId, receiptId, policyId]);
  if (managed) {
    await db.query(`INSERT INTO integration.store_grants(integration_id,merchant_id,store_id,stock_location_id,allowed_scopes,assortment_id,status,mcp_catalog_mode)
      VALUES($1,'pr_m','pr_s1','pr_l1',$2,'pr_a','active','merchant_published')`, [integrationId, scopes]);
    await db.query("UPDATE integration.integrations SET status='active',writes_enabled=$2 WHERE id=$1", [integrationId, profile === "commerce"]);
  }
  const key = await keyFixture(integrationId, 1, managed ? scopes : platformMcpProfileScopesV1.read);
  const i = (await db.query("SELECT status,writes_enabled,grant_version FROM integration.integrations WHERE id=$1", [integrationId])).rows[0];
  const k = (await db.query("SELECT * FROM integration.partner_mcp_keys WHERE id=$1", [key.id])).rows[0];
  const metadata = PlatformMcpCommandMetadataV1Schema.parse({ receiptId, integrationId, merchantId: "pr_m", environment: "sandbox",
    integrationVersion: i.grant_version, integrationStatus: i.status, writesEnabled: i.writes_enabled, mcpUrl: "https://partner.example/mcp",
    key: { id: k.id, version: k.version, status: k.status, label: k.label, scopes: k.scopes, expiresAt: k.expires_at.toISOString() } });
  const row: Record<string, unknown> = { id: receiptId, environment: "sandbox", merchant_id: "pr_m", actor_id: "UAT", operation: managed ? "create_connection" : "issue_key",
    target_integration_id: managed ? "" : integrationId, target_key_id: "", idempotency_key_sha256: "a".repeat(64), request_sha256: "b".repeat(64),
    result_integration_id: integrationId, result_key_id: key.id, result_metadata: JSON.stringify(metadata) };
  // Synthetic binding/shape fixture only; these digests are never a readiness attestation.
  if (managed) Object.assign(row, { workflow_version: "platform-mcp-v1", max_approved_profile: profile,
    approved_scopes: [...scopes], approved_store_ids: ["pr_s1"],
    preset_version: "platform-mcp-v1", policy_id: policyId, policy_version: 1,
    policy_sha256: hashPlatformMcpPolicyV1(platformMcpIssuancePresetV1.policy), readiness_sha256: "d".repeat(64) });
  return { row, metadata, receiptId, integrationId, key };
}
async function insert(row: Record<string, unknown>) {
  const entries = Object.entries(row);
  return db.query(`INSERT INTO integration.control_request_receipts(${entries.map(([key]) => key).join(",")})
    VALUES(${entries.map((_, index) => `$${index + 1}`).join(",")}) RETURNING id`, entries.map(([, value]) => value));
}
async function rejected(action: () => Promise<unknown>, code: string) {
  await db.query("SAVEPOINT rejection");
  try { await expect(action()).rejects.toMatchObject({ code }); }
  finally { await db.query("ROLLBACK TO SAVEPOINT rejection; RELEASE SAVEPOINT rejection"); }
}
async function revokeAuditCount(action = "platform.mcp.key_revoked") {
  await db.query("RESET ROLE");
  try { return (await db.query("SELECT count(*)::int AS count FROM audit.events WHERE action=$1 AND merchant_id='pr_m'", [action])).rows[0].count; }
  finally { await db.query("SET LOCAL ROLE snus_partner_control"); }
}
async function adminFixture(role = "platform_admin"): Promise<OperatorContext> {
  const operatorId = `mcp_${randomUUID()}`;
  await db.query(`INSERT INTO medusa.staff_users(operator_id,password_hash,display_name,role,organization_id,is_active)
    VALUES($1,'not-a-live-password-hash','MCP command UAT','owner','pr_org',true)`, [operatorId]);
  await db.query("INSERT INTO app.operator_security_state(operator_id) VALUES($1)", [operatorId]);
  await db.query(`INSERT INTO app.operator_memberships(operator_id,scope_type,role_key,status,granted_by) VALUES($1,'platform',$2,'active','UAT')`, [operatorId, role]);
  return { operatorId, displayName: "MCP command UAT", role: "owner", organizationId: "pr_org", authState: "authenticated", sessionVersion: 1,
    sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString() };
}
async function registryCounts() {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM integration.partners) AS partners,
    (SELECT count(*)::int FROM integration.policies WHERE merchant_id='pr_m') AS policies,
    (SELECT count(*)::int FROM integration.integrations WHERE merchant_id='pr_m') AS integrations,
    (SELECT count(*)::int FROM integration.assortments WHERE merchant_id='pr_m') AS assortments,
    (SELECT count(*)::int FROM integration.store_grants WHERE merchant_id='pr_m') AS grants,
    (SELECT count(*)::int FROM integration.partner_mcp_keys WHERE integration_id IN (SELECT id FROM integration.integrations WHERE merchant_id='pr_m')) AS keys,
    (SELECT count(*)::int FROM integration.control_request_receipts WHERE merchant_id='pr_m') AS receipts`)).rows[0];
}

describe("platform MCP control receipt and authority PostgreSQL foundation", () => {
  it("rolls resume back if its last qualifying key expires while the audit waits", async () => {
    const origin = await receiptFixture(true, "commerce"); await insert(origin.row); const actor = await adminFixture();
    await db.query("UPDATE integration.integrations SET status='paused',writes_enabled=false WHERE id=$1", [origin.integrationId]);
    const a = await loadPlatformMcpAuthorizationForClient(db, "pr_m", origin.integrationId, "sandbox"), proof = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha, "commerce");
    try {
      await db.query(`CREATE FUNCTION pg_temp.delay_mcp_resume_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END $$;
        CREATE TRIGGER delay_mcp_resume_audit BEFORE INSERT ON audit.events FOR EACH ROW WHEN (NEW.action='platform.mcp.resumed') EXECUTE FUNCTION pg_temp.delay_mcp_resume_audit()`);
      await db.query("UPDATE integration.partner_mcp_keys SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1", [origin.key.id]);
      await db.query("SET LOCAL ROLE snus_partner_control"); const started = performance.now();
      await rejected(() => resumePlatformMcpConnectionForClient(db, actor, "pr_m", origin.integrationId, { status: "active", profile: "commerce", expectedIntegrationVersion: 3,
        expectedAuthorizationSnapshotSha256: a.sha256, reason: "onboarding" }, { "idempotency-key": `expiring-key-resume-${randomUUID()}` }, "sandbox", proof.proof), "mcp_key_required");
      expect(performance.now() - started).toBeGreaterThanOrEqual(500);
      expect((await db.query("SELECT status,writes_enabled,grant_version FROM integration.integrations WHERE id=$1", [origin.integrationId])).rows[0]).toEqual({ status: "paused", writes_enabled: false, grant_version: 3 });
      expect(await revokeAuditCount("platform.mcp.resumed")).toBe(0);
    } finally { await proof.cleanup(); }
  });
  it("preserves immutable origin approval through metadata retention and resumes without minting a new key", async () => {
    const actor = await adminFixture(), proof = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha, "commerce");
    const input = { name: "Retained synthetic", profile: "commerce", storeIds: ["pr_s1"], reason: "onboarding" }, headers = { "idempotency-key": `retained-new-connection-${randomUUID()}` };
    try {
      await db.query("SET LOCAL ROLE snus_partner_control");
      const created = await createPlatformMcpConnectionForClient(db, actor, "pr_m", input, headers, "sandbox", proof.proof);
      await pausePlatformMcpConnectionForClient(db, actor, "pr_m", created.data.integrationId, { status: "paused", expectedIntegrationVersion: 2, reason: "security_incident" },
        { "idempotency-key": `retained-pause-${randomUUID()}` }, "sandbox");
      await db.query("RESET ROLE; ALTER TABLE integration.control_request_receipts DISABLE TRIGGER platform_mcp_receipt_guard");
      await db.query("UPDATE integration.control_request_receipts SET created_at=clock_timestamp()-interval '31 days',replay_until=clock_timestamp()-interval '1 day' WHERE id=$1", [created.data.receiptId]);
      await db.query("ALTER TABLE integration.control_request_receipts ENABLE TRIGGER platform_mcp_receipt_guard; SET LOCAL ROLE snus_partner_maintenance");
      await maintainPartnerRetentionForClient(db, 100); await db.query("SET LOCAL ROLE snus_partner_control");
      expect((await db.query("SELECT state,max_approved_profile,result_metadata FROM integration.control_request_receipts WHERE id=$1", [created.data.receiptId])).rows[0])
        .toEqual({ state: "tombstone", max_approved_profile: "commerce", result_metadata: null });
      const a = await loadPlatformMcpAuthorizationForClient(db, "pr_m", created.data.integrationId, "sandbox");
      expect(await resumePlatformMcpConnectionForClient(db, actor, "pr_m", created.data.integrationId, { status: "active", profile: "commerce", expectedIntegrationVersion: 3,
        expectedAuthorizationSnapshotSha256: a.sha256, reason: "onboarding" }, { "idempotency-key": `retained-resume-${randomUUID()}` }, "sandbox", proof.proof))
        .toMatchObject({ data: { integrationStatus: "active", writesEnabled: true, integrationVersion: 4 } });
      expect(await createPlatformMcpConnectionForClient(db, actor, "pr_m", input, headers, "sandbox"))
        .toMatchObject({ replayed: true, requestState: "expired", secretStatus: "unavailable_on_replay", data: { integrationId: created.data.integrationId, keyId: created.data.key?.id } });
      expect((await db.query("SELECT count(*)::int AS n FROM integration.partner_mcp_keys WHERE integration_id=$1", [created.data.integrationId])).rows[0].n).toBe(1);
    } finally { await proof.cleanup(); }
  });
  it.each(["missing-proof", "readonly", "suspended-merchant", "closed-merchant", "foreign-store", "suspended-store", "no-entitlement", "raw-scopes"])("creates no registry resources when onboarding fails: %s", async invalid => {
    const actor = await adminFixture(invalid === "readonly" ? "platform_readonly" : "platform_admin"), profile = invalid === "no-entitlement" ? "commerce" : "read";
    if (invalid === "suspended-merchant" || invalid === "closed-merchant") await db.query("UPDATE app.merchants SET status=$1 WHERE id='pr_m'", [invalid === "closed-merchant" ? "closed" : "suspended"]);
    if (invalid === "suspended-store") await db.query("UPDATE app.stores SET status='suspended' WHERE id='pr_s2'");
    if (invalid === "no-entitlement") await db.query("UPDATE app.package_catalog_versions SET feature_keys='[]' WHERE id='pr_cat'");
    if (invalid === "foreign-store") {
      await db.query("INSERT INTO public.stock_location(id,name) VALUES('pr_foreign_loc','Foreign')");
      await db.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,status) VALUES('pr_foreign_store','pr_other','Foreign','pr_foreign_loc','active')");
    }
    const proof = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha, profile), before = await registryCounts();
    try {
      await db.query("SET LOCAL ROLE snus_partner_control");
      const error = ({ "missing-proof": "mcp_readiness_unavailable", readonly: "forbidden", "suspended-merchant": "mcp_scope_inactive", "closed-merchant": "mcp_scope_inactive",
        "foreign-store": "mcp_scope_inactive", "suspended-store": "mcp_scope_inactive", "no-entitlement": "merchant_capability_denied", "raw-scopes": "validation_error" })[invalid];
      await rejected(() => createPlatformMcpConnectionForClient(db, actor, "pr_m", { name: "Synthetic", profile,
        storeIds: ["pr_s1", invalid === "foreign-store" ? "pr_foreign_store" : "pr_s2"], reason: "onboarding", ...(invalid === "raw-scopes" ? { scopes: ["orders:write"] } : {}) },
      { "idempotency-key": `rejected-onboarding-${randomUUID()}` }, "sandbox", invalid === "missing-proof" ? undefined : proof.proof), error);
      expect(await registryCounts()).toEqual(before);
    } finally { await proof.cleanup(); }
  });
  it.each(["key", "audit", "receipt"])("rolls complete new connection setup back on an injected %s failure", async failing => {
    const actor = await adminFixture(), before = await registryCounts();
    const proof = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha);
    try {
      const relation = failing === "key" ? "integration.partner_mcp_keys" : failing === "audit" ? "audit.events" : "integration.control_request_receipts";
      await db.query(`CREATE FUNCTION pg_temp.reject_mcp_setup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic setup failure'; END $$;
        CREATE TRIGGER reject_mcp_setup BEFORE INSERT ON ${relation} FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_mcp_setup()`);
      await db.query("SET LOCAL ROLE snus_partner_control");
      await rejected(() => createPlatformMcpConnectionForClient(db, actor, "pr_m", { name: "Synthetic", storeIds: ["pr_s1", "pr_s2"], reason: "onboarding" },
        { "idempotency-key": `setup-failure-${randomUUID()}` }, "sandbox", proof.proof), "P0001");
      expect(await registryCounts()).toEqual(before); expect(await revokeAuditCount("platform.mcp.connection_created")).toBe(0);
    } finally { await proof.cleanup(); }
  });
  it.each(["read-maximum", "legacy", "shared-oauth", "suspended-merchant", "closed-store", "expired-entitlement", "stale-cas", "missing-proof", "inactive-grant", "deleted-location"])("does not change connection or keys when resume is ineligible: %s", async invalid => {
    const origin = await receiptFixture(true, invalid === "read-maximum" ? "read" : "commerce"); await insert(origin.row); const actor = await adminFixture();
    const integrationId = invalid === "legacy" ? "pr_i" : origin.integrationId;
    await db.query("UPDATE integration.integrations SET status='paused',writes_enabled=false WHERE id=$1", [integrationId]);
    if (invalid === "shared-oauth") await db.query(`INSERT INTO integration.clients(id,integration_id,issuer,oauth_client_id,subject,status,auth_method,credential_reference)
      VALUES('resume_shared_client',$1,'https://pr.invalid','resume-shared','resume-subject','active','private_key_jwt','synthetic-reference')`, [integrationId]);
    if (invalid === "suspended-merchant") await db.query("UPDATE app.merchants SET status='suspended' WHERE id='pr_m'");
    if (invalid === "closed-store") await db.query("UPDATE app.stores SET status='closed' WHERE id='pr_s1'");
    if (invalid === "expired-entitlement") await db.query("UPDATE app.merchant_subscriptions SET current_period_start=now()-interval '38 days',current_period_end=now()-interval '8 days',grace_ends_at=NULL WHERE merchant_id='pr_m'");
    if (invalid === "inactive-grant") await db.query("UPDATE integration.store_grants SET status='inactive' WHERE integration_id=$1", [integrationId]);
    if (invalid === "deleted-location") await db.query("UPDATE public.stock_location SET deleted_at=clock_timestamp() WHERE id='pr_l1'");
    const a = await loadPlatformMcpAuthorizationForClient(db, "pr_m", integrationId, "sandbox"), before = await registryCounts();
    const state = (await db.query("SELECT status,writes_enabled,grant_version FROM integration.integrations WHERE id=$1", [integrationId])).rows[0];
    const proof = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha, "commerce");
    try {
      await db.query("SET LOCAL ROLE snus_partner_control");
      const error = ({ "read-maximum": "mcp_profile_not_approved", legacy: "mcp_managed_connection_required", "shared-oauth": "mcp_managed_connection_required",
        "suspended-merchant": "mcp_scope_inactive", "closed-store": "mcp_scope_inactive", "expired-entitlement": "merchant_capability_denied",
        "stale-cas": "mcp_authorization_version_conflict", "missing-proof": "mcp_readiness_unavailable", "inactive-grant": "mcp_scope_inactive", "deleted-location": "mcp_scope_inactive" })[invalid];
      await rejected(() => resumePlatformMcpConnectionForClient(db, actor, "pr_m", integrationId, { status: "active", profile: "commerce",
        expectedIntegrationVersion: state.grant_version, expectedAuthorizationSnapshotSha256: invalid === "stale-cas" ? "0".repeat(64) : a.sha256, reason: "onboarding" },
      { "idempotency-key": `ineligible-resume-${randomUUID()}` }, "sandbox", invalid === "missing-proof" ? undefined : proof.proof), error);
      expect(await registryCounts()).toEqual(before);
      expect((await db.query("SELECT status,writes_enabled,grant_version FROM integration.integrations WHERE id=$1", [integrationId])).rows[0]).toEqual(state);
    } finally { await proof.cleanup(); }
  });
  it.each(["revoked", "expired", "only-read-scopes"])("does not resume commerce without a usable approved key: %s", async unusable => {
    const origin = await receiptFixture(true, "commerce"); await insert(origin.row); const actor = await adminFixture();
    await db.query("UPDATE integration.integrations SET status='paused',writes_enabled=false WHERE id=$1", [origin.integrationId]);
    if (unusable === "revoked") await db.query("UPDATE integration.partner_mcp_keys SET status='revoked',revoked_at=clock_timestamp(),revoked_by='UAT' WHERE id=$1", [origin.key.id]);
    if (unusable === "expired") {
      await db.query("UPDATE integration.partner_mcp_keys SET expires_at=clock_timestamp()+interval '10 milliseconds' WHERE id=$1", [origin.key.id]);
      await db.query("SELECT pg_sleep(0.02)");
    }
    if (unusable === "only-read-scopes") await db.query("UPDATE integration.partner_mcp_keys SET scopes=$2 WHERE id=$1", [origin.key.id, [...platformMcpProfileScopesV1.read]]);
    const authorization = await loadPlatformMcpAuthorizationForClient(db, "pr_m", origin.integrationId, "sandbox");
    const proof = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha, "commerce");
    try {
      await db.query("SET LOCAL ROLE snus_partner_control");
      await rejected(() => resumePlatformMcpConnectionForClient(db, actor, "pr_m", origin.integrationId, { status: "active", profile: "commerce", expectedIntegrationVersion: 3,
        expectedAuthorizationSnapshotSha256: authorization.sha256, reason: "onboarding" }, { "idempotency-key": `no-live-key-resume-${randomUUID()}` }, "sandbox", proof.proof), "mcp_key_required");
      expect((await db.query("SELECT status,writes_enabled,grant_version FROM integration.integrations WHERE id=$1", [origin.integrationId])).rows[0]).toEqual({ status: "paused", writes_enabled: false, grant_version: 3 });
    } finally { await proof.cleanup(); }
  });
  it.each(["read", "commerce"] as const)("creates a complete %s connection and durable origin once with normalized selected stores", async profile => {
    const actor = await adminFixture(), proof = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha, profile);
    const prior = (await db.query("SELECT to_jsonb(i) AS value FROM integration.integrations i WHERE id='pr_i'")).rows;
    try {
      await db.query("SET LOCAL ROLE snus_partner_control");
      const input = { name: "Synthetic merchant agent", storeIds: ["pr_s2", "pr_s1"], reason: "onboarding", ...(profile === "commerce" ? { profile } : {}) };
      const headers = { "idempotency-key": `create-connection-${randomUUID()}` };
      const result = await createPlatformMcpConnectionForClient(db, actor, "pr_m", input, headers, "sandbox", proof.proof);
      expect(result).toMatchObject({ replayed: false, secretStatus: "available_once", revealedKey: expect.stringMatching(/^snus_mcp_test_/),
        data: { integrationStatus: "active", integrationVersion: 2, writesEnabled: profile === "commerce", key: { scopes: [...platformMcpProfileScopesV1[profile]] } } });
      await db.query("SET CONSTRAINTS ALL IMMEDIATE");
      const integrationId = result.data.integrationId;
      const auth = await loadPlatformMcpAuthorizationForClient(db, "pr_m", integrationId, "sandbox");
      expect(auth.snapshot.approval).toMatchObject({ maxApprovedProfile: profile, approvedStoreIds: ["pr_s1", "pr_s2"], policySha256: hashPlatformMcpPolicyV1(platformMcpIssuancePresetV1.policy) });
      expect(auth.snapshot.grants).toHaveLength(2);
      expect(auth.snapshot.grants.every(grant => grant.status === "active" && grant.mcpCatalogMode === "merchant_published" && grant.assortmentStatus === "active")).toBe(true);
      expect((await db.query("SELECT count(*)::int AS n FROM integration.assortment_items WHERE assortment_id=ANY($1)", [auth.snapshot.grants.map(grant => grant.assortmentId)])).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int AS n FROM integration.clients WHERE integration_id=$1", [integrationId])).rows[0].n).toBe(0);
      const replay = await createPlatformMcpConnectionForClient(db, actor, "pr_m", { ...input, profile, storeIds: ["pr_s1", "pr_s2"] }, headers, "sandbox");
      expect(replay).toMatchObject({ replayed: true, secretStatus: "unavailable_on_replay", data: result.data });
      expect(replay).not.toHaveProperty("revealedKey");
      expect((await db.query("SELECT to_jsonb(i) AS value FROM integration.integrations i WHERE id='pr_i'")).rows).toEqual(prior);
      await rejected(() => createPlatformMcpConnectionForClient(db, actor, "pr_m", { ...input, name: "changed" }, headers, "sandbox"), "idempotency_conflict");
      await db.query("RESET ROLE");
      expect((await db.query("SELECT count(*)::int AS n FROM app.operator_memberships WHERE operator_id=$1 AND scope_type<>'platform'", [actor.operatorId])).rows[0].n).toBe(0);
      await db.query(`INSERT INTO public.product_variant(id,title,sku,product_id) VALUES('pr_v4','Created after onboarding','pr_sku4','pr_product');
        INSERT INTO public.product(id,title,handle,status,merchant_id) VALUES('pr_foreign_product','Foreign','pr_foreign_product','published','pr_other');
        INSERT INTO public.product_variant(id,title,sku,product_id) VALUES('pr_foreign_v','Foreign','pr_foreign_sku','pr_foreign_product');
        INSERT INTO public.stock_location(id,name) VALUES('pr_future_loc','Future');
        INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,status) VALUES('pr_future_store','pr_m','Future','pr_future_loc','active')`);
      await db.query("SET LOCAL ROLE snus_partner_api");
      const identity = await readPartnerMcpIdentity(db, `Bearer ${result.revealedKey}`, "sandbox", "req_new_connection", "a".repeat(32));
      const context = selectPartnerStore(identity, "pr_s1", "catalog:read"), fingerprints = { current: "v1", keys: { v1: randomBytes(32).toString("base64url") } };
      expect((await readPartnerCatalog(db, context, fingerprints, { limit: 20 })).data.map(row => row.variant_id).sort()).toEqual(["pr_v1", "pr_v2", "pr_v3", "pr_v4"]);
      expect(() => selectPartnerStore(identity, "pr_future_store", "catalog:read")).toThrowError(expect.objectContaining({ code: "store_not_allowed" }));
      if (profile === "read") expect(() => selectPartnerStore(identity, "pr_s1", "orders:write", true)).toThrowError(expect.objectContaining({ code: "insufficient_scope" }));
    } finally { await proof.cleanup(); }
  });
  it("resumes a managed connection with default read or explicit commerce while preserving key/grant identities", async () => {
    const origin = await receiptFixture(true, "commerce"); await insert(origin.row); const actor = await adminFixture();
    const beforeKeys = (await db.query("SELECT to_jsonb(k) AS value FROM integration.partner_mcp_keys k WHERE integration_id=$1", [origin.integrationId])).rows;
    const beforeGrants = (await db.query("SELECT to_jsonb(g) AS value FROM integration.store_grants g WHERE integration_id=$1 ORDER BY store_id", [origin.integrationId])).rows;
    await db.query("SET LOCAL ROLE snus_partner_control");
    await pausePlatformMcpConnectionForClient(db, actor, "pr_m", origin.integrationId,
      { status: "paused", expectedIntegrationVersion: 2, reason: "security_incident" }, { "idempotency-key": `pause-to-resume-${randomUUID()}` }, "sandbox");
    for (const [profile, version] of [["read", 3], ["commerce", 4]] as const) {
      const a = await loadPlatformMcpAuthorizationForClient(db, "pr_m", origin.integrationId, "sandbox");
      const proof = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha, profile);
      try {
        const input = { status: "active", expectedIntegrationVersion: version, expectedAuthorizationSnapshotSha256: a.sha256,
          reason: "onboarding", ...(profile === "commerce" ? { profile } : {}) }, headers = { "idempotency-key": `resume-${profile}-${randomUUID()}` };
        const result = await resumePlatformMcpConnectionForClient(db, actor, "pr_m", origin.integrationId, input, headers, "sandbox", proof.proof);
        expect(result).toMatchObject({ replayed: false, secretStatus: "not_applicable", data: { integrationStatus: "active", writesEnabled: profile === "commerce", integrationVersion: version + 1, key: null } });
        expect(result).not.toHaveProperty("revealedKey");
        expect(await resumePlatformMcpConnectionForClient(db, actor, "pr_m", origin.integrationId, input, headers, "sandbox"))
          .toMatchObject({ replayed: true, secretStatus: "unavailable_on_replay", data: result.data });
      } finally { await proof.cleanup(); }
    }
    expect((await db.query("SELECT to_jsonb(k) AS value FROM integration.partner_mcp_keys k WHERE integration_id=$1", [origin.integrationId])).rows).toEqual(beforeKeys);
    expect((await db.query("SELECT to_jsonb(g) AS value FROM integration.store_grants g WHERE integration_id=$1 ORDER BY store_id", [origin.integrationId])).rows).toEqual(beforeGrants);
  });
  it.each(["entitlement", "membership"])("rechecks %s wall-clock expiry after audit waits and rolls the generated key back", async expiring => {
    const origin = await receiptFixture(true, "commerce"); await insert(origin.row);
    const actor = await adminFixture(), a = await loadPlatformMcpAuthorizationForClient(db, "pr_m", origin.integrationId, "sandbox");
    const f = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha, "commerce");
    try {
      await db.query("SAVEPOINT command_wall_clock");
      await db.query(`CREATE FUNCTION pg_temp.delay_platform_mcp_issue_audit() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END $$;
        CREATE TRIGGER delay_platform_mcp_issue_audit BEFORE INSERT ON audit.events FOR EACH ROW
        WHEN (NEW.action='platform.mcp.key_issued') EXECUTE FUNCTION pg_temp.delay_platform_mcp_issue_audit()`);
      if (expiring === "entitlement") await db.query("UPDATE app.merchant_subscriptions SET current_period_end=clock_timestamp()-interval '1 second',grace_ends_at=clock_timestamp()+interval '500 milliseconds' WHERE merchant_id='pr_m'");
      else await db.query("UPDATE app.operator_memberships SET valid_to=clock_timestamp()+interval '500 milliseconds' WHERE operator_id=$1 AND scope_type='platform'", [actor.operatorId]);
      await db.query("SET LOCAL ROLE snus_partner_control");
      const started = performance.now();
      await expect(issuePlatformMcpKeyForClient(db, actor, "pr_m", origin.integrationId, { profile: "commerce", expectedIntegrationVersion: 2,
        expectedAuthorizationSnapshotSha256: a.sha256, reason: "onboarding" }, { "idempotency-key": `expiring-issue-key-${randomUUID()}` }, "sandbox", f.proof))
        .rejects.toMatchObject({ code: expiring === "entitlement" ? "merchant_capability_denied" : "forbidden" });
      expect(performance.now() - started).toBeGreaterThanOrEqual(500);
      await db.query("ROLLBACK TO SAVEPOINT command_wall_clock; RELEASE SAVEPOINT command_wall_clock; SET LOCAL ROLE snus_partner_control");
      expect((await db.query("SELECT count(*)::int AS n FROM integration.partner_mcp_keys WHERE integration_id=$1", [origin.integrationId])).rows[0].n).toBe(1);
      expect((await db.query("SELECT count(*)::int AS n FROM integration.control_request_receipts WHERE merchant_id='pr_m' AND operation='issue_key'")).rows[0].n).toBe(0);
    } finally { await f.cleanup(); }
  });
  it("keeps shared OAuth connections out of generic platform status and new commerce-key changes", async () => {
    const origin = await receiptFixture(true, "commerce"); await insert(origin.row);
    await db.query(`INSERT INTO integration.clients(id,integration_id,issuer,oauth_client_id,subject,status,auth_method,credential_reference)
      VALUES('synthetic_shared_client',$1,'https://pr.invalid','shared-reads','shared-subject','active','private_key_jwt','synthetic-reference')`, [origin.integrationId]);
    const actor = await adminFixture(), a = await loadPlatformMcpAuthorizationForClient(db, "pr_m", origin.integrationId, "sandbox");
    const f = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha, "commerce");
    try {
      await db.query("SET LOCAL ROLE snus_partner_control");
      await rejected(() => pausePlatformMcpConnectionForClient(db, actor, "pr_m", origin.integrationId,
        { status: "paused", expectedIntegrationVersion: 2, reason: "security_incident" }, { "idempotency-key": `shared-status-${randomUUID()}` }, "sandbox"), "mcp_managed_connection_required");
      await rejected(() => issuePlatformMcpKeyForClient(db, actor, "pr_m", origin.integrationId,
        { profile: "commerce", expectedIntegrationVersion: 2, expectedAuthorizationSnapshotSha256: a.sha256, reason: "onboarding" },
        { "idempotency-key": `shared-commerce-key-${randomUUID()}` }, "sandbox", f.proof), "mcp_profile_not_approved");
      expect((await db.query("SELECT status,writes_enabled FROM integration.integrations WHERE id=$1", [origin.integrationId])).rows[0]).toEqual({ status: "active", writes_enabled: true });
    } finally { await f.cleanup(); }
  });
  it.each(["approved", "read-maximum", "expired-subscription"])("enforces durable maximum profile and fresh commerce entitlement: %s", async state => {
    const origin = await receiptFixture(true, state === "read-maximum" ? "read" : "commerce"); await insert(origin.row);
    const actor = await adminFixture(), a = await loadPlatformMcpAuthorizationForClient(db, "pr_m", origin.integrationId, "sandbox");
    const f = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha, "commerce");
    try {
      if (state === "expired-subscription") await db.query("UPDATE app.merchant_subscriptions SET current_period_start=now()-interval '38 days',current_period_end=now()-interval '8 days',grace_ends_at=NULL WHERE merchant_id='pr_m'");
      await db.query("SET LOCAL ROLE snus_partner_control");
      const call = () => issuePlatformMcpKeyForClient(db, actor, "pr_m", origin.integrationId, { profile: "commerce", expectedIntegrationVersion: 2,
        expectedAuthorizationSnapshotSha256: a.sha256, reason: "onboarding" }, { "idempotency-key": `managed-commerce-key-${randomUUID()}` }, "sandbox", f.proof);
      if (state === "approved") expect(await call()).toMatchObject({ replayed: false, secretStatus: "available_once", data: { key: { scopes: [...platformMcpProfileScopesV1.commerce] } } });
      else {
        await rejected(call, state === "read-maximum" ? "mcp_profile_not_approved" : "merchant_capability_denied");
        expect((await db.query("SELECT count(*)::int AS n FROM integration.partner_mcp_keys WHERE integration_id=$1", [origin.integrationId])).rows[0].n).toBe(1);
      }
    } finally { await f.cleanup(); }
  });
  it("issues a read key without reactivating a paused connection or restoring writes", async () => {
    const origin = await receiptFixture(true, "commerce"); await insert(origin.row);
    await db.query("UPDATE integration.integrations SET status='paused',writes_enabled=false WHERE id=$1", [origin.integrationId]);
    const actor = await adminFixture(), a = await loadPlatformMcpAuthorizationForClient(db, "pr_m", origin.integrationId, "sandbox");
    const f = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha);
    try {
      await db.query("SET LOCAL ROLE snus_partner_control");
      expect(await issuePlatformMcpKeyForClient(db, actor, "pr_m", origin.integrationId, { expectedIntegrationVersion: 3,
        expectedAuthorizationSnapshotSha256: a.sha256, reason: "onboarding" }, { "idempotency-key": `paused-read-key-${randomUUID()}` }, "sandbox", f.proof))
        .toMatchObject({ data: { integrationStatus: "paused", writesEnabled: false, integrationVersion: 3, key: { scopes: [...platformMcpProfileScopesV1.read] } } });
    } finally { await f.cleanup(); }
  });
  it("rolls a generated key and receipt back when the mandatory issuance audit fails", async () => {
    const actor = await adminFixture(), a = await loadPlatformMcpAuthorizationForClient(db, "pr_m", "pr_i", "sandbox");
    const f = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha);
    try {
      await db.query("SAVEPOINT issue_audit_failure");
      await db.query(`CREATE FUNCTION pg_temp.reject_platform_mcp_issue_audit() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
        CREATE TRIGGER reject_platform_mcp_issue_audit BEFORE INSERT ON audit.events FOR EACH ROW
        WHEN (NEW.action='platform.mcp.key_issued' AND NEW.subject_id='pr_i') EXECUTE FUNCTION pg_temp.reject_platform_mcp_issue_audit()`);
      await db.query("SET LOCAL ROLE snus_partner_control");
      await expect(issuePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", { expectedIntegrationVersion: 1,
        expectedAuthorizationSnapshotSha256: a.sha256, reason: "onboarding" }, { "idempotency-key": `audit-failed-issue-${randomUUID()}` }, "sandbox", f.proof)).rejects.toMatchObject({ code: "P0001" });
      await db.query("ROLLBACK TO SAVEPOINT issue_audit_failure; RELEASE SAVEPOINT issue_audit_failure; SET LOCAL ROLE snus_partner_control");
      expect((await db.query("SELECT count(*)::int AS n FROM integration.partner_mcp_keys WHERE integration_id='pr_i'")).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int AS n FROM integration.control_request_receipts WHERE merchant_id='pr_m' AND operation='issue_key'")).rows[0].n).toBe(0);
    } finally { await f.cleanup(); }
  });
  it("issues a default read key on a legacy shared connection, preserves OAuth/grants and replays metadata without readiness", async () => {
    const actor = await adminFixture(), before = (await db.query("SELECT to_jsonb(g) AS value FROM integration.store_grants g WHERE integration_id='pr_i' ORDER BY store_id")).rows;
    const clients = (await db.query("SELECT to_jsonb(c) AS value FROM integration.clients c WHERE integration_id='pr_i'")).rows;
    const a = await loadPlatformMcpAuthorizationForClient(db, "pr_m", "pr_i", "sandbox");
    const f = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha);
    try {
      await db.query("SET LOCAL ROLE snus_partner_control");
      const input = { expectedIntegrationVersion: 1, expectedAuthorizationSnapshotSha256: a.sha256, reason: "onboarding" };
      const headers = { "idempotency-key": `new-read-key-${randomUUID()}` };
      const result = await issuePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", input, headers, "sandbox", f.proof);
      expect(result).toMatchObject({ replayed: false, secretStatus: "available_once", revealedKey: expect.stringMatching(/^snus_mcp_test_/), data: {
        integrationStatus: "active", integrationVersion: 1, writesEnabled: true, key: { scopes: [...platformMcpProfileScopesV1.read] } } });
      const serialized = (await db.query("SELECT result_metadata::text AS metadata FROM integration.control_request_receipts WHERE id=$1", [result.data.receiptId])).rows[0].metadata;
      expect(serialized).not.toContain(result.revealedKey); expect(serialized).not.toContain("secret_hash");
      expect(await issuePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", input, headers, "sandbox"))
        .toMatchObject({ replayed: true, secretStatus: "unavailable_on_replay", data: result.data });
      expect((await db.query("SELECT to_jsonb(g) AS value FROM integration.store_grants g WHERE integration_id='pr_i' ORDER BY store_id")).rows).toEqual(before);
      expect((await db.query("SELECT to_jsonb(c) AS value FROM integration.clients c WHERE integration_id='pr_i'")).rows).toEqual(clients);
      expect(await revokeAuditCount("platform.mcp.key_issued")).toBe(1);
      await rejected(() => issuePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", { ...input, label: "changed" }, headers, "sandbox"), "idempotency_conflict");
    } finally { await f.cleanup(); }
  });
  it.each(["missing-proof", "stale-cas", "wrong-version", "readonly", "foreign-merchant", "suspended-store", "commerce-legacy", "schema-drift"])("does not mint on %s", async bad => {
    const actor = await adminFixture(bad === "readonly" ? "platform_readonly" : "platform_admin");
    const a = await loadPlatformMcpAuthorizationForClient(db, "pr_m", "pr_i", "sandbox");
    const f = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha, bad === "commerce-legacy" ? "commerce" : "read");
    try {
      if (bad === "schema-drift") await db.query("INSERT INTO app.schema_migrations(filename,checksum) VALUES('999_synthetic_command_drift.sql',$1)", ["f".repeat(64)]);
      if (bad === "suspended-store") await db.query("UPDATE app.stores SET status='suspended' WHERE id='pr_s2'");
      await db.query("SET LOCAL ROLE snus_partner_control");
      await rejected(() => issuePlatformMcpKeyForClient(db, actor, bad === "foreign-merchant" ? "pr_other" : "pr_m", "pr_i",
        { expectedIntegrationVersion: bad === "wrong-version" ? 2 : 1, expectedAuthorizationSnapshotSha256: bad === "stale-cas" ? "0".repeat(64) : a.sha256,
          profile: bad === "commerce-legacy" ? "commerce" : "read", reason: "onboarding" },
        { "idempotency-key": `deny-new-key-${randomUUID()}` }, "sandbox", bad === "missing-proof" ? undefined : f.proof),
      ({ "missing-proof": "mcp_readiness_unavailable", "stale-cas": "mcp_authorization_version_conflict", "wrong-version": "mcp_integration_version_conflict",
        readonly: "forbidden", "foreign-merchant": "resource_not_found", "suspended-store": "mcp_scope_inactive", "commerce-legacy": "mcp_profile_not_approved", "schema-drift": "mcp_readiness_unavailable" })[bad]);
      expect((await db.query("SELECT count(*)::int AS n FROM integration.partner_mcp_keys WHERE integration_id='pr_i'")).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int AS n FROM integration.control_request_receipts WHERE merchant_id='pr_m' AND operation='issue_key'")).rows[0].n).toBe(0);
    } finally { await f.cleanup(); }
  });
  it("rotates an exact key version with preserved scopes, overlap and metadata-only replay", async () => {
    const actor = await adminFixture(), key = await keyFixture("pr_i", 2);
    const a = await loadPlatformMcpAuthorizationForClient(db, "pr_m", "pr_i", "sandbox");
    const f = await platformMcpReadinessFixture((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha);
    try {
      await db.query("SET LOCAL ROLE snus_partner_control");
      const input = { expectedIntegrationVersion: 1, expectedKeyVersion: 1, expectedAuthorizationSnapshotSha256: a.sha256, reason: "credential_rotation" };
      const headers = { "idempotency-key": `rotate-read-key-${randomUUID()}` };
      const result = await rotatePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", key.id, input, headers, "sandbox", f.proof);
      expect(result).toMatchObject({ replayed: false, secretStatus: "available_once", data: { key: { scopes: [...platformMcpProfileScopesV1.read] } } });
      expect(result).toMatchObject({ rotation: { previousKeyId: key.id, previousKeyVersion: 2, previousKeyExpiresAt: expect.any(String) } });
      expect(result.data.key?.id).not.toBe(key.id);
      expect(await rotatePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", key.id, input, headers, "sandbox"))
        .toMatchObject({ replayed: true, secretStatus: "unavailable_on_replay", data: result.data });
      expect(await rotatePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", key.id, input, headers, "sandbox")).not.toHaveProperty("rotation");
      const old = (await db.query("SELECT status,version,expires_at,expires_at<=clock_timestamp()+interval '24 hours' AS overlap FROM integration.partner_mcp_keys WHERE id=$1", [key.id])).rows[0];
      expect(old).toMatchObject({ status: "active", version: 2, overlap: true });
      expect(result.rotation?.previousKeyExpiresAt).toBe(old.expires_at.toISOString());
      expect(await revokeAuditCount("platform.mcp.key_rotated")).toBe(1);
      await rejected(() => rotatePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", key.id, input,
        { "idempotency-key": `stale-rotate-key-${randomUUID()}` }, "sandbox", f.proof), "mcp_key_version_conflict");
    } finally { await f.cleanup(); }
  });
  it("locks every selected live store and the subscription without granting tenant mutation rights", async () => {
    await db.query("SET LOCAL ROLE snus_partner_control");
    expect((await db.query("SELECT integration.lock_platform_mcp_business_scope('pr_m',ARRAY['pr_s2','pr_s1']) AS commerce")).rows[0].commerce).toBe(true);
    await rejected(() => db.query("UPDATE app.stores SET display_name='forbidden' WHERE id='pr_s1'"), "42501");
    await rejected(() => db.query("UPDATE app.merchant_subscriptions SET current_period_end=now() WHERE merchant_id='pr_m'"), "42501");
  });
  it.each(["foreign", "suspended", "deleted-location", "missing-store", "inactive-merchant"])("rejects the entire selected scope when %s", async bad => {
    if (bad === "suspended") await db.query("UPDATE app.stores SET status='suspended' WHERE id='pr_s2'");
    if (bad === "deleted-location") await db.query("UPDATE public.stock_location SET deleted_at=now() WHERE id='pr_l2'");
    if (bad === "inactive-merchant") await db.query("UPDATE app.merchants SET status='suspended' WHERE id='pr_m'");
    await db.query("SET LOCAL ROLE snus_partner_control");
    await rejected(() => db.query("SELECT integration.lock_platform_mcp_business_scope($1,$2)",
      [bad === "foreign" ? "pr_other" : "pr_m", bad === "missing-store" ? ["pr_s1", "missing"] : ["pr_s1", "pr_s2"]]), "P0001");
  });
  it.each([null, [], ["pr_s1", "pr_s1"], [null], [["pr_s1"]]])("rejects malformed selected stores %j", async stores => {
    await db.query("SET LOCAL ROLE snus_partner_control");
    await rejected(() => db.query("SELECT integration.lock_platform_mcp_business_scope('pr_m',$1::text[])", [stores]), "22023");
  });
  it.each(["expired", "no-feature", "no-subscription"])("returns no commerce entitlement for %s while allowing active read scope", async bad => {
    if (bad === "expired") await db.query("UPDATE app.merchant_subscriptions SET current_period_start=now()-interval '38 days',current_period_end=now()-interval '8 days',grace_ends_at=NULL WHERE merchant_id='pr_m'");
    if (bad === "no-feature") await db.query("UPDATE app.package_catalog_versions SET feature_keys='[]' WHERE id='pr_cat'");
    if (bad === "no-subscription") await db.query("DELETE FROM app.merchant_subscriptions WHERE merchant_id='pr_m'");
    await db.query("SET LOCAL ROLE snus_partner_control");
    expect((await db.query("SELECT integration.lock_platform_mcp_business_scope('pr_m',ARRAY['pr_s1']) AS commerce")).rows[0].commerce).toBe(false);
  });
  it("keeps the complete scope lock helper control-only and fixed to catalog functions", async () => {
    const row = await db.query(`SELECT p.prosecdef,p.proconfig,
      EXISTS(SELECT 1 FROM aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute,
      has_function_privilege('snus_partner_control',p.oid,'EXECUTE') AS control,
      has_function_privilege('snus_partner_api',p.oid,'EXECUTE') AS api,
      has_function_privilege('snus_partner_maintenance',p.oid,'EXECUTE') AS maintenance
      FROM pg_proc p WHERE p.oid='integration.lock_platform_mcp_business_scope(text,text[])'::regprocedure`);
    expect(row.rows).toEqual([{ prosecdef: true, proconfig: ["search_path=pg_catalog"], public_execute: false, control: true, api: false, maintenance: false }]);
  });
  it.each(["snus_partner_control", "snus_partner_api"])("provides the exact schema fingerprint without exposing the migration ledger to %s", async role => {
    const ledger = (await db.query("SELECT filename,checksum FROM app.schema_migrations ORDER BY filename")).rows;
    const expected = createHash("sha256").update(ledger.map(row => `${row.filename}:${row.checksum}`).join("\n")).digest("hex");
    await db.query(`SET LOCAL ROLE ${role}`);
    expect((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS fingerprint")).rows[0].fingerprint).toBe(expected);
    await rejected(() => db.query("SELECT filename,checksum FROM app.schema_migrations"), "42501");
    await db.query("RESET ROLE");
    await db.query("INSERT INTO app.schema_migrations(filename,checksum) VALUES('999_synthetic_conformance_drift.sql',$1)", ["f".repeat(64)]);
    await db.query(`SET LOCAL ROLE ${role}`);
    expect((await db.query("SELECT integration.platform_mcp_schema_fingerprint() AS fingerprint")).rows[0].fingerprint).not.toBe(expected);
  });
  it("keeps schema fingerprint authority narrow and fixed to catalog functions", async () => {
    const row = await db.query(`SELECT p.prosecdef,p.proconfig,
      EXISTS(SELECT 1 FROM aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute,
      has_function_privilege('snus_partner_control',p.oid,'EXECUTE') AS control,
      has_function_privilege('snus_partner_api',p.oid,'EXECUTE') AS api,
      has_function_privilege('snus_partner_maintenance',p.oid,'EXECUTE') AS maintenance
      FROM pg_proc p WHERE p.oid='integration.platform_mcp_schema_fingerprint()'::regprocedure`);
    expect(row.rows).toEqual([{ prosecdef: true, proconfig: ["search_path=pg_catalog"], public_execute: false, control: true, api: true, maintenance: false }]);
  });
  it.each(["active", "suspended", "closed"])("pauses a managed connection without changing keys/grants while merchant is %s", async state => {
    const f = await receiptFixture(true); await insert(f.row); const actor = await adminFixture();
    await db.query("UPDATE app.merchants SET status=$1 WHERE id='pr_m'", [state]);
    await db.query("SET LOCAL ROLE snus_partner_control");
    const grants = (await db.query("SELECT store_id,status,version,allowed_scopes,assortment_id FROM integration.store_grants WHERE integration_id=$1", [f.integrationId])).rows;
    const input = { status: "paused", expectedIntegrationVersion: 2, reason: "security_incident" }, headers = { "idempotency-key": `pause-${randomUUID()}` };
    const run = () => pausePlatformMcpConnectionForClient(db, actor, "pr_m", f.integrationId, input, headers, "sandbox");
    const first = await run();
    expect(first).toMatchObject({ replayed: false, data: { integrationId: f.integrationId, integrationVersion: 3,
      integrationStatus: "paused", writesEnabled: false, key: null } });
    expect(await run()).toMatchObject({ replayed: true, data: first.data, secretStatus: "unavailable_on_replay" });
    expect((await db.query("SELECT status,version FROM integration.partner_mcp_keys WHERE id=$1", [f.key.id])).rows[0]).toEqual({ status: "active", version: 1 });
    expect((await db.query("SELECT store_id,status,version,allowed_scopes,assortment_id FROM integration.store_grants WHERE integration_id=$1", [f.integrationId])).rows).toEqual(grants);
    await rejected(() => pausePlatformMcpConnectionForClient(db, actor, "pr_m", f.integrationId,
      { ...input, reason: "operator_request" }, headers, "sandbox"), "idempotency_conflict");
    await pausePlatformMcpConnectionForClient(db, actor, "pr_m", f.integrationId, { ...input, expectedIntegrationVersion: 3 },
      { "idempotency-key": `noop-pause-${randomUUID()}` }, "sandbox");
    expect(await revokeAuditCount("platform.mcp.paused")).toBe(1);
    expect((await db.query("SELECT grant_version FROM integration.integrations WHERE id=$1", [f.integrationId])).rows[0].grant_version).toBe(3);
  });
  it("rejects legacy/shared pause, terminal revive and stale managed versions", async () => {
    const f = await receiptFixture(true); await insert(f.row); const actor = await adminFixture();
    await db.query("SET LOCAL ROLE snus_partner_control");
    const pause = (integrationId: string, version: number) => pausePlatformMcpConnectionForClient(db, actor, "pr_m", integrationId,
      { status: "paused", expectedIntegrationVersion: version, reason: "security_incident" }, { "idempotency-key": `rejected-pause-${randomUUID()}` }, "sandbox");
    await rejected(() => pause("pr_i", 1), "mcp_managed_connection_required");
    await rejected(() => pause(f.integrationId, 1), "mcp_integration_version_conflict");
    await db.query("UPDATE integration.integrations SET status='revoked',writes_enabled=false WHERE id=$1", [f.integrationId]);
    await rejected(() => pause(f.integrationId, 3), "mcp_connection_terminal");
    expect((await db.query("SELECT status,writes_enabled FROM integration.integrations WHERE id='pr_i'")).rows[0]).toEqual({ status: "active", writes_enabled: true });
    expect((await db.query("SELECT count(*)::int AS count FROM integration.control_request_receipts WHERE merchant_id='pr_m' AND operation='set_status'")).rows[0].count).toBe(0);
  });
  it("keeps pause available during approval drift, denies a readonly actor and never accepts activation through this internal port", async () => {
    const f = await receiptFixture(true); await insert(f.row); const actor = await adminFixture(), reader = await adminFixture("platform_readonly");
    await db.query("UPDATE integration.integrations SET policy_id='pr_policy',policy_version=1 WHERE id=$1", [f.integrationId]);
    await db.query("SET LOCAL ROLE snus_partner_control");
    const input = { status: "paused", expectedIntegrationVersion: 3, reason: "security_incident" };
    const headers = { "idempotency-key": `approval-drift-pause-${randomUUID()}` };
    await rejected(() => pausePlatformMcpConnectionForClient(db, reader, "pr_m", f.integrationId, input, headers, "sandbox"), "forbidden");
    await rejected(() => pausePlatformMcpConnectionForClient(db, actor, "pr_m", f.integrationId,
      { status: "active", expectedIntegrationVersion: 3, profile: "read", expectedAuthorizationSnapshotSha256: "a".repeat(64), reason: "onboarding" }, headers, "sandbox"), "validation_error");
    expect(await pausePlatformMcpConnectionForClient(db, actor, "pr_m", f.integrationId, input, headers, "sandbox"))
      .toMatchObject({ data: { integrationStatus: "paused", integrationVersion: 4, writesEnabled: false } });
  });
  it("retains pause identity after metadata retention without replaying a status mutation", async () => {
    const f = await receiptFixture(true); await insert(f.row); const actor = await adminFixture();
    await db.query("SET LOCAL ROLE snus_partner_control");
    const input = { status: "paused", expectedIntegrationVersion: 2, reason: "security_incident" }, headers = { "idempotency-key": `expired-pause-${randomUUID()}` };
    const first = await pausePlatformMcpConnectionForClient(db, actor, "pr_m", f.integrationId, input, headers, "sandbox");
    await db.query("RESET ROLE; ALTER TABLE integration.control_request_receipts DISABLE TRIGGER platform_mcp_receipt_guard");
    await db.query("UPDATE integration.control_request_receipts SET created_at=clock_timestamp()-interval '31 days',replay_until=clock_timestamp()-interval '1 day' WHERE id=$1", [first.data.receiptId]);
    await db.query("ALTER TABLE integration.control_request_receipts ENABLE TRIGGER platform_mcp_receipt_guard; SET LOCAL ROLE snus_partner_maintenance");
    await maintainPartnerRetentionForClient(db, 1); await db.query("SET LOCAL ROLE snus_partner_control");
    expect(await pausePlatformMcpConnectionForClient(db, actor, "pr_m", f.integrationId, input, headers, "sandbox"))
      .toMatchObject({ replayed: true, requestState: "expired", data: { receiptId: first.data.receiptId, integrationId: f.integrationId, keyId: null } });
    expect((await db.query("SELECT grant_version,status FROM integration.integrations WHERE id=$1", [f.integrationId])).rows[0]).toEqual({ grant_version: 3, status: "paused" });
    expect(await revokeAuditCount("platform.mcp.paused")).toBe(1);
  });
  it("rolls the pause status/version and receipt back with an audit failure", async () => {
    const f = await receiptFixture(true); await insert(f.row); const actor = await adminFixture();
    await db.query("SAVEPOINT pause_audit_failure");
    await db.query(`CREATE FUNCTION pg_temp.reject_platform_mcp_pause_audit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'Synthetic UAT pause audit failure' USING ERRCODE='P0001'; END $$;
      CREATE TRIGGER reject_platform_mcp_pause_audit BEFORE INSERT ON audit.events FOR EACH ROW
      WHEN (NEW.action='platform.mcp.paused') EXECUTE FUNCTION pg_temp.reject_platform_mcp_pause_audit()`);
    await db.query("SET LOCAL ROLE snus_partner_control");
    await expect(pausePlatformMcpConnectionForClient(db, actor, "pr_m", f.integrationId,
      { status: "paused", expectedIntegrationVersion: 2, reason: "security_incident" }, { "idempotency-key": `failed-pause-${randomUUID()}` }, "sandbox")).rejects.toMatchObject({ code: "P0001" });
    await db.query("ROLLBACK TO SAVEPOINT pause_audit_failure; RELEASE SAVEPOINT pause_audit_failure");
    expect((await db.query("SELECT status,grant_version FROM integration.integrations WHERE id=$1", [f.integrationId])).rows[0]).toEqual({ status: "active", grant_version: 2 });
    expect((await db.query("SELECT count(*)::int AS count FROM integration.control_request_receipts WHERE merchant_id='pr_m' AND operation='set_status'")).rows[0].count).toBe(0);
  });
  it.each([false, true])("handles the final integration version without overflow; already paused=%s", async paused => {
    const f = await receiptFixture(true); await insert(f.row); const actor = await adminFixture();
    if (paused) await db.query("UPDATE integration.integrations SET status='paused' WHERE id=$1", [f.integrationId]);
    // Owner-only integer boundary fixture; the entire transaction is rolled back.
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await db.query("ALTER TABLE integration.integrations DISABLE TRIGGER partner_integration_identity");
    await db.query("UPDATE integration.integrations SET grant_version=2147483647 WHERE id=$1", [f.integrationId]);
    await db.query("ALTER TABLE integration.integrations ENABLE TRIGGER partner_integration_identity; SET LOCAL ROLE snus_partner_control");
    const run = () => pausePlatformMcpConnectionForClient(db, actor, "pr_m", f.integrationId,
      { status: "paused", expectedIntegrationVersion: 2147483647, reason: "security_incident" }, { "idempotency-key": `final-version-pause-${randomUUID()}` }, "sandbox");
    if (paused) expect(await run()).toMatchObject({ data: { integrationVersion: 2147483647, integrationStatus: "paused" } });
    else await rejected(run, "mcp_version_exhausted");
  });
  it.each([false, true])("keeps safe metadata available when managed approval is invalid=%s without providing an authorization hash", async broken => {
    const f = await receiptFixture(true); await insert(f.row);
    const actor = await adminFixture();
    if (broken) await db.query("UPDATE integration.integrations SET policy_id='pr_policy',policy_version=1 WHERE id=$1", [f.integrationId]);
    await db.query("SET TRANSACTION READ ONLY; SET LOCAL ROLE snus_partner_control");
    const data = await getPlatformMcpConnectionForClient(db, actor, "pr_m", f.integrationId, {}, "sandbox");
    expect(data).toMatchObject({ canRevokeKeys: true, connection: { managedByPlatform: true, hasOauthClients: false },
      keys: { data: [{ id: f.key.id, status: "active" }] },
      authorizationWarning: broken ? "mcp_approval_invalid" : null, maxApprovedProfile: broken ? null : "read" });
    if (broken) expect(data.authorizationSnapshotSha256).toBeNull();
    else expect(data.authorizationSnapshotSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(data)).not.toContain(f.key.raw);
  });
  it.each(["platform_admin", "platform_readonly", "merchant_owner", "revoked", "wrong-session", "expired-session"])("evaluates fresh metadata authority for %s", async variant => {
    const actor = await adminFixture(variant === "platform_readonly" ? variant : "platform_admin");
    if (variant === "merchant_owner") {
      await db.query("DELETE FROM app.operator_memberships WHERE operator_id=$1", [actor.operatorId]);
      await db.query(`INSERT INTO app.operator_memberships(operator_id,scope_type,merchant_id,role_key,status,granted_by)
        VALUES($1,'merchant','pr_m','owner','active','UAT')`, [actor.operatorId]);
    }
    if (variant === "revoked") await db.query("UPDATE app.operator_memberships SET status='revoked' WHERE operator_id=$1", [actor.operatorId]);
    await db.query("SET LOCAL ROLE snus_partner_control");
    const role = (await db.query("SELECT integration.platform_mcp_reader_role($1,$2,$3::timestamptz) AS role", [actor.operatorId,
      variant === "wrong-session" ? 2 : 1, variant === "expired-session" ? new Date(0).toISOString() : actor.sessionExpiresAt])).rows[0].role;
    expect(role).toBe(variant === "platform_admin" || variant === "platform_readonly" ? variant : null);
  });
  it("loads every legacy grant for authorization CAS, including grants beyond a metadata page", async () => {
    await db.query("INSERT INTO public.stock_location(id,name) SELECT 'snapshot_l_'||n,'Snapshot '||n FROM generate_series(1,55) n");
    await db.query(`INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,status)
      SELECT 'snapshot_s_'||n,'pr_m','Snapshot '||n,'snapshot_l_'||n,'active' FROM generate_series(1,55) n`);
    await db.query(`INSERT INTO integration.store_grants(integration_id,merchant_id,store_id,stock_location_id,allowed_scopes,assortment_id,status)
      SELECT 'pr_i','pr_m','snapshot_s_'||n,'snapshot_l_'||n,$1,'pr_a','active' FROM generate_series(1,55) n`, [platformMcpProfileScopesV1.read]);
    await db.query("SET LOCAL ROLE snus_partner_control");
    const first = await loadPlatformMcpAuthorizationForClient(db, "pr_m", "pr_i", "sandbox");
    expect(first.snapshot.approval).toBeNull();
    expect(first.snapshot.grants).toHaveLength(57);
    await db.query("UPDATE integration.store_grants SET mcp_catalog_mode='merchant_published' WHERE integration_id='pr_i' AND store_id='snapshot_s_9'");
    const changed = await loadPlatformMcpAuthorizationForClient(db, "pr_m", "pr_i", "sandbox");
    expect(changed.sha256).not.toBe(first.sha256);
    const key = await keyFixture("pr_i");
    await db.query("UPDATE integration.partner_mcp_keys SET status='revoked',revoked_at=clock_timestamp(),revoked_by='UAT' WHERE id=$1", [key.id]);
    expect((await loadPlatformMcpAuthorizationForClient(db, "pr_m", "pr_i", "sandbox")).sha256).toBe(changed.sha256);
    await rejected(() => loadPlatformMcpAuthorizationForClient(db, "pr_other", "pr_i", "sandbox"), "resource_not_found");
    await rejected(() => loadPlatformMcpAuthorizationForClient(db, "pr_m", "pr_i", "production"), "resource_not_found");
  });
  it("loads immutable managed approval before and after metadata cleanup without inferring it from current keys", async () => {
    const f = await receiptFixture(true); await insert(f.row);
    await db.query("SET LOCAL ROLE snus_partner_control");
    const first = await loadPlatformMcpAuthorizationForClient(db, "pr_m", f.integrationId, "sandbox");
    expect(first.snapshot.approval).toMatchObject({ maxApprovedProfile: "read", approvedStoreIds: ["pr_s1"], policyId: f.row.policy_id });
    await db.query("UPDATE integration.integrations SET status='paused' WHERE id=$1", [f.integrationId]);
    expect((await loadPlatformMcpAuthorizationForClient(db, "pr_m", f.integrationId, "sandbox")).snapshot.approval).toEqual(first.snapshot.approval);
    await db.query("RESET ROLE; ALTER TABLE integration.control_request_receipts DISABLE TRIGGER platform_mcp_receipt_guard");
    await db.query("UPDATE integration.control_request_receipts SET created_at=clock_timestamp()-interval '31 days',replay_until=clock_timestamp()-interval '1 day' WHERE id=$1", [f.receiptId]);
    await db.query("ALTER TABLE integration.control_request_receipts ENABLE TRIGGER platform_mcp_receipt_guard; SET LOCAL ROLE snus_partner_maintenance");
    await maintainPartnerRetentionForClient(db, 1);
    await db.query("SET LOCAL ROLE snus_partner_control");
    expect((await loadPlatformMcpAuthorizationForClient(db, "pr_m", f.integrationId, "sandbox")).snapshot.approval).toEqual(first.snapshot.approval);
  });
  it.each(["missing-origin", "policy", "grant-extra", "grant-scope", "grant-catalog", "writes-escalation"])("fails closed instead of treating contradictory managed approval as legacy: %s", async bad => {
    const f = await receiptFixture(true); if (bad !== "missing-origin") await insert(f.row);
    await db.query("SET LOCAL ROLE snus_partner_control");
    if (bad === "policy") await db.query("UPDATE integration.integrations SET policy_id='pr_policy',policy_version=1 WHERE id=$1", [f.integrationId]);
    if (bad === "grant-extra") await db.query(`INSERT INTO integration.store_grants(integration_id,merchant_id,store_id,stock_location_id,allowed_scopes,assortment_id,status,mcp_catalog_mode)
      VALUES($1,'pr_m','pr_s2','pr_l2',$2,'pr_a','active','merchant_published')`, [f.integrationId, platformMcpProfileScopesV1.read]);
    if (bad === "grant-scope") await db.query("UPDATE integration.store_grants SET allowed_scopes=$2 WHERE integration_id=$1", [f.integrationId, platformMcpProfileScopesV1.commerce]);
    if (bad === "grant-catalog") await db.query("UPDATE integration.store_grants SET mcp_catalog_mode='explicit' WHERE integration_id=$1", [f.integrationId]);
    if (bad === "writes-escalation") await db.query("UPDATE integration.integrations SET writes_enabled=true WHERE id=$1", [f.integrationId]);
    await rejected(() => loadPlatformMcpAuthorizationForClient(db, "pr_m", f.integrationId, "sandbox"), "mcp_approval_invalid");
  });
  it.each(["active", "suspended", "closed"])("revokes exactly one key with durable metadata replay while merchant is %s", async state => {
    const actor = await adminFixture(), key = await keyFixture("pr_i"), other = await keyFixture("pr_i");
    await db.query("UPDATE app.merchants SET status=$1 WHERE id='pr_m'", [state]);
    await db.query("SET LOCAL ROLE snus_partner_control");
    const headers = { "idempotency-key": `platform-mcp-revoke-${randomUUID()}` }, input = { expectedKeyVersion: 1, reason: "security_incident" };
    const run = () => revokePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", key.id, input, headers, "sandbox");
    const first = await run(), replay = await run();
    expect(first).toMatchObject({ data: { merchantId: "pr_m", integrationId: "pr_i", key: { id: key.id, version: 2, status: "revoked" } }, replayed: false });
    expect(replay).toMatchObject({ data: first.data, replayed: true, secretStatus: "unavailable_on_replay" });
    expect(JSON.stringify(first).includes(key.raw)).toBe(false);
    expect((await db.query("SELECT status,version FROM integration.partner_mcp_keys WHERE id=$1", [other.id])).rows[0]).toEqual({ status: "active", version: 1 });
    expect(await revokeAuditCount()).toBe(1);
    expect((await db.query("SELECT count(*)::int AS count FROM integration.control_request_receipts WHERE merchant_id='pr_m'")).rows[0].count).toBe(1);
    await rejected(() => revokePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", key.id, { ...input, reason: "operator_request" }, headers, "sandbox"), "idempotency_conflict");
    await rejected(() => revokePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", key.id, input, { "idempotency-key": `stale-mcp-revoke-${randomUUID()}` }, "sandbox"), "mcp_key_version_conflict");
    await revokePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", key.id, { ...input, expectedKeyVersion: 2 }, { "idempotency-key": `noop-mcp-revoke-${randomUUID()}` }, "sandbox");
    expect(await revokeAuditCount()).toBe(1);
  });
  it("denies fresh role/session failures before lookup or replay and leaves key/receipt untouched", async () => {
    const reader = await adminFixture("platform_readonly"), actor = await adminFixture(), key = await keyFixture("pr_i");
    await db.query("SET LOCAL ROLE snus_partner_control");
    const input = { expectedKeyVersion: 1, reason: "security_incident" }, headers = { "idempotency-key": `auth-mcp-revoke-${randomUUID()}` };
    for (const integrationId of ["pr_i", "missing"]) await rejected(() => revokePlatformMcpKeyForClient(db, reader, "pr_m", integrationId, key.id, input, headers, "sandbox"), "forbidden");
    await rejected(() => revokePlatformMcpKeyForClient(db, { ...actor, impersonationMode: "read_only" }, "pr_m", "pr_i", key.id, input, headers, "sandbox"), "forbidden");
    await revokePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", key.id, input, headers, "sandbox");
    await db.query("RESET ROLE"); await db.query("UPDATE app.operator_security_state SET session_version=2 WHERE operator_id=$1", [actor.operatorId]);
    await db.query("SET LOCAL ROLE snus_partner_control");
    await rejected(() => revokePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", key.id, input, headers, "sandbox"), "forbidden");
    expect((await db.query("SELECT count(*)::int AS count FROM integration.control_request_receipts WHERE merchant_id='pr_m'")).rows[0].count).toBe(1);
  });
  it("returns only stable resource identity after receipt expiry and never reactivates or creates a key", async () => {
    const actor = await adminFixture(), key = await keyFixture("pr_i"), input = { expectedKeyVersion: 1, reason: "security_incident" };
    const headers = { "idempotency-key": `expired-mcp-revoke-${randomUUID()}` };
    await db.query("SET LOCAL ROLE snus_partner_control");
    const first = await revokePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", key.id, input, headers, "sandbox");
    await db.query("RESET ROLE; ALTER TABLE integration.control_request_receipts DISABLE TRIGGER platform_mcp_receipt_guard");
    await db.query("UPDATE integration.control_request_receipts SET created_at=clock_timestamp()-interval '31 days',replay_until=clock_timestamp()-interval '1 day' WHERE id=$1", [first.data.receiptId]);
    await db.query("ALTER TABLE integration.control_request_receipts ENABLE TRIGGER platform_mcp_receipt_guard; SET LOCAL ROLE snus_partner_control");
    const expired = await revokePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", key.id, input, headers, "sandbox");
    expect(expired).toMatchObject({ data: { receiptId: first.data.receiptId, integrationId: "pr_i", keyId: key.id }, replayed: true, requestState: "expired" });
    expect(expired.data).not.toHaveProperty("key");
    expect((await db.query("SELECT status,version FROM integration.partner_mcp_keys WHERE id=$1", [key.id])).rows[0]).toEqual({ status: "revoked", version: 2 });
    await rejected(() => revokePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", key.id, { ...input, expectedKeyVersion: 2 }, headers, "sandbox"), "idempotency_conflict");
  });
  it("rolls key mutation back with the caller transaction when audit insertion fails", async () => {
    const actor = await adminFixture(), key = await keyFixture("pr_i");
    await db.query("SAVEPOINT audit_failure");
    await db.query(`CREATE FUNCTION pg_temp.reject_platform_mcp_audit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'Synthetic UAT audit failure' USING ERRCODE='P0001'; END $$;
      CREATE TRIGGER reject_platform_mcp_audit BEFORE INSERT ON audit.events FOR EACH ROW
      WHEN (NEW.action='platform.mcp.key_revoked' AND NEW.subject_id='pr_i') EXECUTE FUNCTION pg_temp.reject_platform_mcp_audit()`);
    await db.query("SET LOCAL ROLE snus_partner_control");
    await expect(revokePlatformMcpKeyForClient(db, actor, "pr_m", "pr_i", key.id, { expectedKeyVersion: 1, reason: "security_incident" },
      { "idempotency-key": `audit-failure-${randomUUID()}` }, "sandbox")).rejects.toMatchObject({ code: "P0001" });
    await db.query("ROLLBACK TO SAVEPOINT audit_failure; RELEASE SAVEPOINT audit_failure");
    expect((await db.query("SELECT status,version FROM integration.partner_mcp_keys WHERE id=$1", [key.id])).rows[0]).toEqual({ status: "active", version: 1 });
    expect((await db.query("SELECT count(*)::int AS count FROM integration.control_request_receipts WHERE merchant_id='pr_m'")).rows[0].count).toBe(0);
    expect((await db.query("SELECT count(*)::int AS count FROM audit.events WHERE action='platform.mcp.key_revoked' AND merchant_id='pr_m'")).rows[0].count).toBe(0);
  });
  it.each(["revoke-null", "rotate-missing", "rotate-foreign"])("rejects an unbound target key for %s", async bad => {
    await db.query("SET LOCAL ROLE snus_partner_control"); const f = await receiptFixture();
    if (bad === "revoke-null") {
      Object.assign(f.row, { operation: "revoke_key", target_key_id: "e".repeat(32), result_key_id: null,
        result_metadata: JSON.stringify({ ...f.metadata, key: null }) });
    } else {
      let target = "e".repeat(32);
      if (bad === "rotate-foreign") {
        const other = `other_${randomUUID()}`;
        await db.query(`INSERT INTO integration.integrations(id,partner_id,merchant_id,environment,installation_key,policy_id,policy_version)
          VALUES($1,'pr_p','pr_m','sandbox',$1,'pr_policy',1)`, [other]);
        target = (await keyFixture(other)).id;
      }
      Object.assign(f.row, { operation: "rotate_key", target_key_id: target });
    }
    await rejected(() => insert(f.row), "23514");
  });
  it.each(["key-commerce", "writes-commerce", "grant-extra", "grant-scope", "grant-catalog"])("rejects origin authority contradicting its durable read approval: %s", async bad => {
    await db.query("SET LOCAL ROLE snus_partner_control"); const f = await receiptFixture(true);
    if (bad === "key-commerce") {
      await db.query("UPDATE integration.partner_mcp_keys SET scopes=scopes||ARRAY['orders:quote','orders:write'] WHERE id=$1", [f.key.id]);
      const k = (await db.query("SELECT scopes,version FROM integration.partner_mcp_keys WHERE id=$1", [f.key.id])).rows[0];
      f.row.result_metadata = JSON.stringify({ ...f.metadata, key: { ...f.metadata.key, scopes: k.scopes, version: k.version } });
    }
    if (bad === "writes-commerce") {
      await db.query("UPDATE integration.integrations SET writes_enabled=true WHERE id=$1", [f.integrationId]);
      const i = (await db.query("SELECT grant_version FROM integration.integrations WHERE id=$1", [f.integrationId])).rows[0];
      f.row.result_metadata = JSON.stringify({ ...f.metadata, integrationVersion: i.grant_version, writesEnabled: true });
    }
    if (bad.startsWith("grant-")) {
      await db.query(`INSERT INTO integration.store_grants(integration_id,merchant_id,store_id,stock_location_id,allowed_scopes,assortment_id,status,mcp_catalog_mode)
        VALUES($1,'pr_m',$2,$3,$4,'pr_a','active',$5) ON CONFLICT(integration_id,store_id) DO UPDATE SET allowed_scopes=EXCLUDED.allowed_scopes,mcp_catalog_mode=EXCLUDED.mcp_catalog_mode`, [f.integrationId, bad === "grant-extra" ? "pr_s2" : "pr_s1", bad === "grant-extra" ? "pr_l2" : "pr_l1",
        bad === "grant-scope" ? ["catalog:read", "orders:write"] : ["partner:read", "catalog:read", "inventory:read", "orders:read"], bad === "grant-catalog" ? "explicit" : "merchant_published"]);
    }
    await rejected(() => insert(f.row), "23514");
  });
  it("has bounded receipt ACLs and control-only fresh admin helper without staff UPDATE or password access", async () => {
    const row = await db.query(`SELECT has_table_privilege('snus_partner_control','integration.control_request_receipts','SELECT,INSERT') AS control,
      has_table_privilege('snus_partner_control','integration.control_request_receipts','UPDATE,DELETE') AS control_mutate,
      has_table_privilege('snus_partner_api','integration.control_request_receipts','SELECT') AS api,
      has_column_privilege('snus_partner_control','medusa.staff_users','password_hash','SELECT') AS password,
      has_column_privilege('snus_partner_control','medusa.staff_users','is_active','UPDATE') AS staff_update`);
    expect(row.rows).toEqual([{ control: true, control_mutate: false, api: false, password: false, staff_update: false }]);
  });
  it("persists safe metadata under the real control role while the raw key stays outside the receipt", async () => {
    await db.query("SET LOCAL ROLE snus_partner_control"); const f = await receiptFixture(); await insert(f.row);
    const row = (await db.query("SELECT * FROM integration.control_request_receipts WHERE id=$1", [f.receiptId])).rows[0];
    expect(PlatformMcpCommandMetadataV1Schema.safeParse(row.result_metadata).success).toBe(true);
    expect(JSON.stringify(row).includes(f.key.raw)).toBe(false);
    expect(row.replay_until.getTime() - row.created_at.getTime()).toBe(30 * 86_400_000);
    await rejected(() => db.query("DELETE FROM integration.control_request_receipts WHERE id=$1", [f.receiptId]), "42501");
    await rejected(() => db.query("UPDATE integration.control_request_receipts SET actor_id='other' WHERE id=$1", [f.receiptId]), "42501");
  });
  it("binds a managed origin once, preserves grant_version behavior and refuses retrofitting an existing integration", async () => {
    await db.query("SET LOCAL ROLE snus_partner_control"); const f = await receiptFixture(true); await insert(f.row);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await rejected(() => db.query("UPDATE integration.integrations SET platform_mcp_origin_receipt_id=NULL WHERE id=$1", [f.integrationId]), "23514");
    await rejected(() => db.query("UPDATE integration.integrations SET platform_mcp_origin_receipt_id=$1 WHERE id='pr_i'", [f.receiptId]), "23514");
    await db.query("UPDATE integration.integrations SET status='paused' WHERE id=$1", [f.integrationId]);
    expect((await db.query("SELECT grant_version FROM integration.integrations WHERE id=$1", [f.integrationId])).rows[0].grant_version).toBe(3);
  });
  it("checks the deferred origin against the actual environment/merchant/result integration", async () => {
    const f = await receiptFixture(true); await insert(f.row);
    await db.query("SAVEPOINT wrong_origin");
    try {
      await db.query(`INSERT INTO integration.integrations(id,partner_id,merchant_id,environment,installation_key,policy_id,policy_version,platform_mcp_origin_receipt_id)
        VALUES('misbound_origin','pr_p','pr_m','sandbox','misbound_origin','pr_policy',1,$1)`, [f.receiptId]);
      await expect(db.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({ code: "23514" });
    } finally { await db.query("ROLLBACK TO SAVEPOINT wrong_origin"); }
  });
  it.each(["secret", "nested-secret", "foreign-environment", "foreign-key", "foreign-result", "wrong-version"])("rejects bad durable metadata %s", async bad => {
    await db.query("SET LOCAL ROLE snus_partner_control"); const f = await receiptFixture();
    const metadata: Record<string, unknown> = structuredClone(f.metadata);
    if (bad === "secret") metadata.revealedKey = "must-not-persist";
    if (bad === "nested-secret") metadata.key = { ...f.metadata.key, secret_hash: "must-not-persist" };
    if (bad === "foreign-environment") f.row.environment = "production";
    if (bad === "foreign-key") metadata.key = { ...f.metadata.key, id: "f".repeat(32) };
    if (bad === "foreign-result") metadata.integrationId = "foreign";
    if (bad === "wrong-version") metadata.integrationVersion = 9;
    f.row.result_metadata = JSON.stringify(metadata);
    await rejected(() => insert(f.row), "23514");
  });
  it("serializes receipt identity with nonnull target sentinels and rejects duplicate bindings", async () => {
    await db.query("SET LOCAL ROLE snus_partner_control"); const f = await receiptFixture(); await insert(f.row);
    const id = randomUUID();
    await rejected(() => insert({ ...f.row, id, result_metadata: JSON.stringify({ ...f.metadata, receiptId: id }) }), "23505");
    expect((await db.query("SELECT count(*)::int AS count FROM integration.control_request_receipts WHERE merchant_id='pr_m'")).rows[0].count).toBe(1);
  });
  it.each(["profile", "scope", "store", "duplicate-store", "policy", "missing-approval"])("refuses contradictory maximum approval %s", async bad => {
    await db.query("SET LOCAL ROLE snus_partner_control"); const f = await receiptFixture(true);
    if (bad === "profile") f.row.max_approved_profile = "commerce";
    if (bad === "scope") f.row.approved_scopes = ["catalog:read"];
    if (bad === "store") f.row.approved_store_ids = ["store_other"];
    if (bad === "duplicate-store") f.row.approved_store_ids = ["pr_s1", "pr_s1"];
    if (bad === "policy") f.row.policy_id = "foreign_policy";
    if (bad === "missing-approval") delete f.row.readiness_sha256;
    await rejected(() => insert(f.row), "23514");
  });
  it("keeps tombstone identity/approval after expiry and permits only the maintenance metadata transition", async () => {
    const f = await receiptFixture(true); await insert(f.row);
    await rejected(() => db.query("UPDATE integration.control_request_receipts SET state='tombstone',result_metadata=NULL WHERE id=$1", [f.receiptId]), "23514");
    // Owner-only clock fixture in a rollback transaction; no runtime clock bypass exists.
    await db.query("ALTER TABLE integration.control_request_receipts DISABLE TRIGGER platform_mcp_receipt_guard");
    await db.query("UPDATE integration.control_request_receipts SET created_at=clock_timestamp()-interval '31 days',replay_until=clock_timestamp()-interval '1 day' WHERE id=$1", [f.receiptId]);
    await db.query("ALTER TABLE integration.control_request_receipts ENABLE TRIGGER platform_mcp_receipt_guard");
    await db.query("SET LOCAL ROLE snus_partner_maintenance");
    await db.query("UPDATE integration.control_request_receipts SET state='tombstone',result_metadata=NULL WHERE id=$1", [f.receiptId]);
    const row = (await db.query("SELECT state,result_metadata,result_integration_id,result_key_id,max_approved_profile,readiness_sha256 FROM integration.control_request_receipts WHERE id=$1", [f.receiptId])).rows[0];
    expect(row).toMatchObject({ state: "tombstone", result_metadata: null, result_integration_id: f.integrationId, result_key_id: f.key.id, max_approved_profile: "read", readiness_sha256: "d".repeat(64) });
    await rejected(() => db.query("UPDATE integration.control_request_receipts SET state='completed',result_metadata=$2 WHERE id=$1", [f.receiptId, JSON.stringify(f.metadata)]), "23514");
    await rejected(() => db.query("UPDATE integration.control_request_receipts SET max_approved_profile='commerce' WHERE id=$1", [f.receiptId]), "42501");
    await db.query("RESET ROLE");
    await rejected(() => db.query("DELETE FROM integration.control_request_receipts WHERE id=$1", [f.receiptId]), "23514");
    await rejected(() => db.query("UPDATE integration.control_request_receipts SET request_sha256=$2 WHERE id=$1", [f.receiptId, "e".repeat(64)]), "23514");
  });
  it("cleans expired platform receipt metadata through retention while preserving fresh receipts and durable origin approval", async () => {
    const expired = await receiptFixture(true); await insert(expired.row);
    const fresh = await receiptFixture(); await insert(fresh.row);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await db.query("ALTER TABLE integration.control_request_receipts DISABLE TRIGGER platform_mcp_receipt_guard");
    await db.query("UPDATE integration.control_request_receipts SET created_at=clock_timestamp()-interval '31 days',replay_until=clock_timestamp()-interval '1 day' WHERE id=$1", [expired.receiptId]);
    await db.query("ALTER TABLE integration.control_request_receipts ENABLE TRIGGER platform_mcp_receipt_guard; SET LOCAL ROLE snus_partner_maintenance");
    expect(await maintainPartnerRetentionForClient(db, 1)).toMatchObject({ outcome: "completed", tombstones: 1 });
    const row = (await db.query("SELECT * FROM integration.control_request_receipts WHERE id=$1", [expired.receiptId])).rows[0];
    expect(row).toMatchObject({ state: "tombstone", result_metadata: null, result_integration_id: expired.integrationId,
      result_key_id: expired.key.id, max_approved_profile: "read", approved_store_ids: ["pr_s1"], policy_sha256: expired.row.policy_sha256 });
    expect((await db.query("SELECT state,result_metadata FROM integration.control_request_receipts WHERE id=$1", [fresh.receiptId])).rows[0])
      .toEqual({ state: "completed", result_metadata: fresh.metadata });
    expect(await maintainPartnerRetentionForClient(db, 1)).toMatchObject({ outcome: "completed", tombstones: 0 });
    await db.query("RESET ROLE");
    expect((await db.query("SELECT platform_mcp_origin_receipt_id::text FROM integration.integrations WHERE id=$1", [expired.integrationId])).rows[0].platform_mcp_origin_receipt_id).toBe(expired.receiptId);
    expect((await db.query("SELECT status,version FROM integration.partner_mcp_keys WHERE id=$1", [expired.key.id])).rows[0]).toEqual({ status: "active", version: 1 });
  });
  it.each(["platform_admin", "platform_readonly", "merchant_owner", "disabled", "suspended", "password-change", "expired-membership", "revoked", "wrong-session", "expired-session", "missing"])("checks fresh actor %s under actual control role without password access", async variant => {
    const operatorId = `mcp_admin_${randomUUID()}`;
    if (variant !== "missing") {
      await db.query(`INSERT INTO medusa.staff_users(operator_id,password_hash,display_name,role,organization_id,is_active)
        VALUES($1,'not-a-live-password-hash','MCP authority UAT','owner','pr_org',$2)`, [operatorId, variant !== "disabled"]);
      await db.query("INSERT INTO app.operator_security_state(operator_id,global_status,requires_password_change) VALUES($1,$2,$3)", [operatorId, variant === "suspended" ? "suspended" : "active", variant === "password-change"]);
      await db.query(`INSERT INTO app.operator_memberships(operator_id,scope_type,merchant_id,role_key,status,valid_from,valid_to,granted_by)
        VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day',CASE WHEN $6 THEN clock_timestamp()-interval '1 second' ELSE NULL END,'UAT')`,
      [operatorId, variant === "merchant_owner" ? "merchant" : "platform", variant === "merchant_owner" ? "pr_m" : null,
        variant === "platform_readonly" ? "platform_readonly" : variant === "merchant_owner" ? "owner" : "platform_admin", variant === "revoked" ? "revoked" : "active", variant === "expired-membership"]);
    }
    await db.query("SET LOCAL ROLE snus_partner_control");
    const result = await db.query("SELECT integration.lock_platform_mcp_admin($1,$2,clock_timestamp()+$3::interval) AS allowed", [operatorId, variant === "wrong-session" ? 2 : 1, variant === "expired-session" ? "-1 second" : "1 hour"]);
    expect(result.rows[0].allowed).toBe(variant === "platform_admin");
  });
  it("keeps the privileged actor lock signature/search_path closed to business API and PUBLIC", async () => {
    const row = await db.query(`SELECT p.prosecdef,p.proconfig,
      EXISTS(SELECT 1 FROM aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute,
      has_function_privilege('snus_partner_control',p.oid,'EXECUTE') AS control,
      has_function_privilege('snus_partner_api',p.oid,'EXECUTE') AS api
      FROM pg_proc p WHERE p.oid='integration.lock_platform_mcp_admin(text,integer,timestamptz)'::regprocedure`);
    expect(row.rows).toEqual([{ prosecdef: true, proconfig: ["search_path=pg_catalog"], public_execute: false, control: true, api: false }]);
  });
  it("keeps the metadata helper control-only without granting identity-table access", async () => {
    const row = await db.query(`SELECT p.prosecdef,p.proconfig,
      EXISTS(SELECT 1 FROM aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute,
      has_function_privilege('snus_partner_control',p.oid,'EXECUTE') AS control,
      has_function_privilege('snus_partner_api',p.oid,'EXECUTE') AS api,
      has_function_privilege('snus_partner_maintenance',p.oid,'EXECUTE') AS maintenance,
      has_table_privilege('snus_partner_control','app.operator_security_state','SELECT,UPDATE') AS identity_access
      FROM pg_proc p WHERE p.oid='integration.platform_mcp_reader_role(text,integer,timestamptz)'::regprocedure`);
    expect(row.rows).toEqual([{ prosecdef: true, proconfig: ["search_path=pg_catalog"], public_execute: false,
      control: true, api: false, maintenance: false, identity_access: false }]);
  });
});
