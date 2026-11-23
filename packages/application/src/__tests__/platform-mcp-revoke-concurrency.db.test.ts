import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { partnerScopes } from "@medusa-snus/contracts/partner-api";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { seedPartnerBookingFixture } from "./helpers/partner-booking-fixture";
import { generatePartnerMcpKey } from "../partner/mcp-key";
import { revokePlatformMcpKeyForClient, issuePlatformMcpKeyForClient, createPlatformMcpConnectionForClient, rotatePlatformMcpKeyForClient } from "../partner/platform-mcp-control";
import { loadPlatformMcpAuthorizationForClient } from "../partner/platform-mcp-authorization";
import { platformMcpReadinessFixture } from "./helpers/platform-mcp-readiness-fixture";
import { readPartnerMcpIdentity, selectPartnerStore } from "../partner/registry";
import { createPartnerQuoteForClient } from "../partner/quotes";
import { bookPartnerOrderForClient } from "../partner/booking";
import type { OperatorContext } from "../services/auth-service";
import { listPlatformMcpConnectionsForClient, getPlatformMcpConnectionForClient } from "../partner/platform-mcp-metadata";
let pool: Pool, observer: PoolClient;
const fixtures: string[] = [];
const managedConnections: string[] = [];
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString, max: 4 });
  observer = await pool.connect(); await assertSafeTestDatabaseSentinel(observer, target);
});
afterAll(async () => {
  for (const p of fixtures) await observer.query("UPDATE integration.integrations SET status='revoked',writes_enabled=false WHERE id=$1", [`${p}_i`]);
  for (const integrationId of managedConnections) await observer.query("UPDATE integration.integrations SET status='revoked',writes_enabled=false WHERE id=$1", [integrationId]);
  observer?.release(); await pool?.end();
});
async function fixture() {
  const p = `mr${randomBytes(6).toString("hex")}`, key = generatePartnerMcpKey("sandbox"), operatorId = `${p}_admin`;
  await observer.query("BEGIN");
  try {
    await seedPartnerBookingFixture(observer, p);
    await observer.query(`INSERT INTO medusa.staff_users(operator_id,password_hash,display_name,role,organization_id,is_active)
      VALUES($1,'not-a-live-password-hash','MCP concurrency UAT','owner',$2,true)`, [operatorId, `${p}_org`]);
    await observer.query("INSERT INTO app.operator_security_state(operator_id) VALUES($1)", [operatorId]);
    await observer.query(`INSERT INTO app.operator_memberships(operator_id,scope_type,role_key,status,granted_by)
      VALUES($1,'platform','platform_admin','active','UAT')`, [operatorId]);
    await observer.query(`INSERT INTO integration.partner_mcp_keys(id,integration_id,label,secret_hash,scopes,created_by,expires_at)
      VALUES($1,$2,'MCP concurrency UAT',$3,$4,$5,clock_timestamp()+interval '1 day')`, [key.keyId, `${p}_i`, key.secretHash, partnerScopes, operatorId]);
    await observer.query("COMMIT"); fixtures.push(p);
  } catch (error) { await observer.query("ROLLBACK"); throw error; }
  const actor: OperatorContext = { operatorId, role: "owner", displayName: "MCP concurrency UAT", organizationId: `${p}_org`,
    authState: "authenticated", sessionVersion: 1, sessionExpiresAt: new Date(Date.now() + 60_000).toISOString() };
  return { p, actor, key };
}
const input = { expectedKeyVersion: 1, reason: "security_incident" };
async function waitForBlocked(pid: number) {
  const end = Date.now() + 1500;
  while (Date.now() < end) {
    const row = (await observer.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
    if (row?.wait_event_type === "Lock") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Concurrent MCP command did not reach its authorization lock");
}

describe("platform MCP revoke native concurrency", () => {
  it("serializes identical rotation attempts to one new key and first-response-only overlap context", async () => {
    const f = await fixture(), a = await pool.connect(), b = await pool.connect();
    const authorization = await loadPlatformMcpAuthorizationForClient(observer, `${f.p}_m`, `${f.p}_i`, "sandbox");
    const readiness = await platformMcpReadinessFixture((await observer.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha, "commerce");
    const input = { expectedIntegrationVersion: 1, expectedKeyVersion: 1, expectedAuthorizationSnapshotSha256: authorization.sha256, reason: "credential_rotation" };
    const headers = { "idempotency-key": `concurrent-rotate-${randomUUID()}` };
    let running: ReturnType<typeof rotatePlatformMcpKeyForClient> | undefined;
    try {
      await a.query("BEGIN; SET LOCAL ROLE snus_partner_control"); await b.query("BEGIN; SET LOCAL ROLE snus_partner_control");
      const first = await rotatePlatformMcpKeyForClient(a, f.actor, `${f.p}_m`, `${f.p}_i`, f.key.keyId, input, headers, "sandbox", readiness.proof);
      const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      running = rotatePlatformMcpKeyForClient(b, f.actor, `${f.p}_m`, `${f.p}_i`, f.key.keyId, input, headers, "sandbox");
      await waitForBlocked(pid); await a.query("COMMIT"); const replay = await running; await b.query("COMMIT");
      expect(first).toMatchObject({ replayed: false, rotation: { previousKeyId: f.key.keyId, previousKeyExpiresAt: expect.any(String) } });
      expect(replay).toMatchObject({ replayed: true, secretStatus: "unavailable_on_replay", data: first.data });
      expect(replay).not.toHaveProperty("revealedKey"); expect(replay).not.toHaveProperty("rotation");
      expect((await observer.query("SELECT count(*)::int AS n FROM integration.partner_mcp_keys WHERE integration_id=$1", [`${f.p}_i`])).rows[0].n).toBe(2);
      expect((await observer.query("SELECT count(*)::int AS n FROM audit.events WHERE subject_id=$1 AND action='platform.mcp.key_rotated'", [`${f.p}_i`])).rows[0].n).toBe(1);
    } finally { await a.query("ROLLBACK"); await b.query("ROLLBACK"); await running?.catch(() => undefined); a.release(); b.release(); await readiness.cleanup(); }
  });
  it("serializes identical new-connection requests to one registry, key and durable origin", async () => {
    const f = await fixture(), a = await pool.connect(), b = await pool.connect();
    const readiness = await platformMcpReadinessFixture((await observer.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha);
    const request = { name: "Concurrent synthetic", storeIds: [`${f.p}_s1`, `${f.p}_s2`], reason: "onboarding" }, headers = { "idempotency-key": `concurrent-new-connection-${randomUUID()}` };
    let running: ReturnType<typeof createPlatformMcpConnectionForClient> | undefined;
    try {
      await a.query("BEGIN; SET LOCAL ROLE snus_partner_control"); await b.query("BEGIN; SET LOCAL ROLE snus_partner_control");
      const first = await createPlatformMcpConnectionForClient(a, f.actor, `${f.p}_m`, request, headers, "sandbox", readiness.proof);
      managedConnections.push(first.data.integrationId);
      const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      running = createPlatformMcpConnectionForClient(b, f.actor, `${f.p}_m`, request, headers, "sandbox");
      await waitForBlocked(pid); await a.query("COMMIT"); const replay = await running; await b.query("COMMIT");
      expect(first).toMatchObject({ replayed: false, secretStatus: "available_once", revealedKey: expect.any(String) });
      expect(replay).toMatchObject({ replayed: true, secretStatus: "unavailable_on_replay", data: first.data }); expect(replay).not.toHaveProperty("revealedKey");
      expect((await observer.query("SELECT count(*)::int AS n FROM integration.integrations WHERE merchant_id=$1", [`${f.p}_m`])).rows[0].n).toBe(2);
      expect((await observer.query("SELECT count(*)::int AS n FROM integration.partner_mcp_keys WHERE integration_id=$1", [first.data.integrationId])).rows[0].n).toBe(1);
      expect((await observer.query("SELECT count(*)::int AS n FROM integration.control_request_receipts WHERE operation='create_connection' AND merchant_id=$1", [`${f.p}_m`])).rows[0].n).toBe(1);
      expect((await observer.query("SELECT count(*)::int AS n FROM audit.events WHERE action='platform.mcp.connection_created' AND subject_id=$1", [first.data.integrationId])).rows[0].n).toBe(1);
    } finally { await a.query("ROLLBACK"); await b.query("ROLLBACK"); await running?.catch(() => undefined); a.release(); b.release(); await readiness.cleanup(); }
  });
  it("uses a newly created commerce key to quote/book COD and replay without a second stock decrement", async () => {
    const f = await fixture(), control = await pool.connect(), booking = await pool.connect();
    const readiness = await platformMcpReadinessFixture((await observer.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha, "commerce");
    const fingerprints = { current: "v1", keys: { v1: randomBytes(32).toString("base64url") } };
    try {
      await control.query("BEGIN; SET LOCAL ROLE snus_partner_control");
      const created = await createPlatformMcpConnectionForClient(control, f.actor, `${f.p}_m`, { name: "Synthetic commerce", profile: "commerce", storeIds: [`${f.p}_s1`], reason: "onboarding" },
        { "idempotency-key": `commerce-onboarding-${randomUUID()}` }, "sandbox", readiness.proof);
      managedConnections.push(created.data.integrationId); await control.query("COMMIT");
      if (!created.revealedKey || !("key" in created.data) || !created.data.key) throw new Error("Synthetic creation did not return its first credential");
      const integrationId = created.data.integrationId, keyId = created.data.key.id, bearer = `Bearer ${created.revealedKey}`;
      await booking.query("BEGIN; SET LOCAL ROLE snus_partner_api");
      await booking.query("SELECT integration.lock_authorization($1,$2,$3,'mcp_key')", [integrationId, keyId, `${f.p}_s1`]);
      const identity = await readPartnerMcpIdentity(booking, bearer, "sandbox", `${f.p}:new-book`, "a".repeat(32));
      const ctx = selectPartnerStore(identity, `${f.p}_s1`, ["orders:quote", "orders:write"], true);
      expect(ctx.catalogMode).toBe("merchant_published");
      const quote = await createPartnerQuoteForClient(booking, ctx, fingerprints, { store_id: `${f.p}_s1`, items: [{ variant_id: `${f.p}_v1`, quantity: 1 }], fulfillment_mode: "pickup" });
      const body = { store_id: `${f.p}_s1`, quote_id: quote.data.quote_id, external_order_id: `${f.p}:new-order`, payment_method: "cod", fulfillment: { mode: "pickup" } } as const;
      const requestKey = `new-key-book-${randomUUID()}`, first = await bookPartnerOrderForClient(booking, ctx, fingerprints, body, requestKey);
      expect(first).toMatchObject({ status: 201, replayed: false, body: { data: { payment_method: "cod", collection_status: "unconfirmed" } } });
      await booking.query("COMMIT; BEGIN; SET LOCAL ROLE snus_partner_api");
      await booking.query("SELECT integration.lock_authorization($1,$2,$3,'mcp_key')", [integrationId, keyId, `${f.p}_s1`]);
      const fresh = selectPartnerStore(await readPartnerMcpIdentity(booking, bearer, "sandbox", `${f.p}:new-book-retry`, "b".repeat(32)), `${f.p}_s1`, "orders:write", true);
      expect(await bookPartnerOrderForClient(booking, fresh, fingerprints, body, requestKey)).toMatchObject({ status: 200, replayed: true });
      await booking.query("COMMIT");
      expect((await observer.query("SELECT count(*)::int AS n FROM integration.partner_orders WHERE integration_id=$1", [integrationId])).rows[0].n).toBe(1);
      expect(Number((await observer.query("SELECT stocked_quantity FROM public.inventory_level WHERE id=$1", [`${f.p}_il1`])).rows[0].stocked_quantity)).toBe(9);
    } finally { await control.query("ROLLBACK"); await booking.query("ROLLBACK"); control.release(); booking.release(); await readiness.cleanup(); }
  });
  it.each(["store", "subscription", "catalog"])("holds the complete selected business %s stable until command commit", async resource => {
    const f = await fixture(), control = await pool.connect(), writer = await pool.connect();
    let running: Promise<unknown> | undefined;
    try {
      await control.query("BEGIN; SET LOCAL ROLE snus_partner_control");
      expect((await control.query("SELECT integration.lock_platform_mcp_business_scope($1,$2) AS commerce", [`${f.p}_m`, [`${f.p}_s1`, `${f.p}_s2`]])).rows[0].commerce).toBe(true);
      await writer.query("BEGIN"); const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      running = resource === "store" ? writer.query("UPDATE app.stores SET status='suspended' WHERE id=$1", [`${f.p}_s2`])
        : resource === "subscription" ? writer.query("UPDATE app.merchant_subscriptions SET grace_ends_at=current_period_end WHERE merchant_id=$1", [`${f.p}_m`])
        : writer.query("UPDATE app.package_catalog_versions SET feature_keys='[]' WHERE id=$1", [`${f.p}_cat`]);
      await waitForBlocked(pid); await control.query("COMMIT"); await running;
    } finally { await control.query("ROLLBACK"); await writer.query("ROLLBACK"); await running?.catch(() => undefined); control.release(); writer.release(); }
  });
  it("rechecks every selected store after waiting for a concurrent suspension", async () => {
    const f = await fixture(), holder = await pool.connect(), control = await pool.connect();
    let running: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN"); await holder.query("UPDATE app.stores SET status='suspended' WHERE id=$1", [`${f.p}_s2`]);
      await control.query("BEGIN; SET LOCAL ROLE snus_partner_control"); const pid = (await control.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      running = control.query("SELECT integration.lock_platform_mcp_business_scope($1,$2)", [`${f.p}_m`, [`${f.p}_s1`, `${f.p}_s2`]]);
      const rejected = expect(running).rejects.toMatchObject({ code: "P0001" });
      await waitForBlocked(pid); await holder.query("COMMIT"); await rejected;
    } finally { await holder.query("ROLLBACK"); await control.query("ROLLBACK"); await running?.catch(() => undefined); holder.release(); control.release(); }
  });
  it("serializes identical first issuance commands to one key and metadata-only replay", async () => {
    const f = await fixture(), a = await pool.connect(), b = await pool.connect();
    const authorization = await loadPlatformMcpAuthorizationForClient(observer, `${f.p}_m`, `${f.p}_i`, "sandbox");
    const readiness = await platformMcpReadinessFixture((await observer.query("SELECT integration.platform_mcp_schema_fingerprint() AS sha")).rows[0].sha);
    const request = { expectedIntegrationVersion: 1, expectedAuthorizationSnapshotSha256: authorization.sha256, reason: "onboarding" };
    const headers = { "idempotency-key": `concurrent-issue-${randomUUID()}` };
    let running: ReturnType<typeof issuePlatformMcpKeyForClient> | undefined;
    try {
      await a.query("BEGIN; SET LOCAL ROLE snus_partner_control"); await b.query("BEGIN; SET LOCAL ROLE snus_partner_control");
      const first = await issuePlatformMcpKeyForClient(a, f.actor, `${f.p}_m`, `${f.p}_i`, request, headers, "sandbox", readiness.proof);
      const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      running = issuePlatformMcpKeyForClient(b, f.actor, `${f.p}_m`, `${f.p}_i`, request, headers, "sandbox");
      await waitForBlocked(pid); await a.query("COMMIT"); const replay = await running; await b.query("COMMIT");
      expect(first).toMatchObject({ replayed: false, secretStatus: "available_once", revealedKey: expect.any(String) });
      expect(replay).toMatchObject({ replayed: true, secretStatus: "unavailable_on_replay", data: first.data });
      expect(replay).not.toHaveProperty("revealedKey");
      expect((await observer.query("SELECT count(*)::int AS n FROM integration.partner_mcp_keys WHERE integration_id=$1", [`${f.p}_i`])).rows[0].n).toBe(2);
      expect((await observer.query("SELECT count(*)::int AS n FROM audit.events WHERE action='platform.mcp.key_issued' AND subject_id=$1", [`${f.p}_i`])).rows[0].n).toBe(1);
    } finally { await a.query("ROLLBACK"); await b.query("ROLLBACK"); await running?.catch(() => undefined); a.release(); b.release(); await readiness.cleanup(); }
  });
  it("pages only safe metadata for the selected merchant with independent cursors in READ ONLY mode", async () => {
    const f = await fixture(), reader = await pool.connect(), extraKeys = [generatePartnerMcpKey("sandbox"), generatePartnerMcpKey("sandbox")];
    const previousHost = process.env.PARTNER_PUBLIC_HOST;
    process.env.PARTNER_PUBLIC_HOST = "partner.example";
    try {
      for (const suffix of ["i2", "i3"]) await observer.query(`INSERT INTO integration.integrations(id,partner_id,merchant_id,environment,installation_key,policy_id,policy_version)
        VALUES($1,$2,$3,'sandbox',$1,$4,1)`, [`${f.p}_${suffix}`, `${f.p}_p`, `${f.p}_m`, `${f.p}_policy`]);
      for (const key of extraKeys) await observer.query(`INSERT INTO integration.partner_mcp_keys(id,integration_id,label,secret_hash,scopes,created_by,expires_at)
        VALUES($1,$2,'Metadata UAT',$3,$4,$5,clock_timestamp()+interval '1 day')`, [key.keyId, `${f.p}_i`, key.secretHash, partnerScopes, f.actor.operatorId]);
      await reader.query("BEGIN; SET LOCAL ROLE snus_partner_control");
      for (const key of extraKeys) await revokePlatformMcpKeyForClient(reader, f.actor, `${f.p}_m`, `${f.p}_i`, key.keyId, input,
        { "idempotency-key": `metadata-revoke-${randomUUID()}` }, "sandbox");
      await reader.query("COMMIT; BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY; SET LOCAL ROLE snus_partner_control");
      const one = await listPlatformMcpConnectionsForClient(reader, f.actor, `${f.p}_m`, { limit: "1" }, "sandbox");
      const two = await listPlatformMcpConnectionsForClient(reader, f.actor, `${f.p}_m`, { limit: "1", after: one.nextAfter }, "sandbox");
      expect(one.data).toHaveLength(1); expect(two.data).toHaveLength(1);
      expect(one.data[0].integrationId).not.toBe(two.data[0].integrationId);
      expect(one).toMatchObject({ canRevokeKeys: true, mcpUrl: "https://partner.example/mcp" });
      const detail = await getPlatformMcpConnectionForClient(reader, f.actor, `${f.p}_m`, `${f.p}_i`, { limit: 1 }, "sandbox");
      expect(detail.keys.data).toHaveLength(1); expect(detail.grants.data).toHaveLength(1); expect(detail.receipts.data).toHaveLength(1);
      expect(detail).toMatchObject({ maxApprovedProfile: null, authorizationWarning: null,
        connection: { merchantId: `${f.p}_m`, managedByPlatform: false, hasOauthClients: true } });
      expect(detail.authorizationSnapshotSha256).toMatch(/^[a-f0-9]{64}$/);
      const next = await getPlatformMcpConnectionForClient(reader, f.actor, `${f.p}_m`, `${f.p}_i`, { limit: 1,
        keysAfter: detail.keys.nextAfter, grantsAfter: detail.grants.nextAfter, receiptsAfter: detail.receipts.nextAfter }, "sandbox");
      expect(next.keys.data[0].id).not.toBe(detail.keys.data[0].id);
      expect(next.grants.data[0].storeId).not.toBe(detail.grants.data[0].storeId);
      expect(next.receipts.data[0].receiptId).not.toBe(detail.receipts.data[0].receiptId);
      expect(next.grants.nextAfter).toBeNull(); expect(next.receipts.nextAfter).toBeNull();
      for (const value of [f.key.key, f.key.secretHash, ...extraKeys.flatMap(key => [key.key, key.secretHash]), "credential_reference", "oauth_client_id", "secret_hash", "result_metadata"]) {
        expect(JSON.stringify({ one, detail, next })).not.toContain(value);
      }
      await expect(getPlatformMcpConnectionForClient(reader, f.actor, `${f.p}_other`, `${f.p}_i`, {}, "sandbox")).rejects.toMatchObject({ code: "resource_not_found" });
      await expect(getPlatformMcpConnectionForClient(reader, f.actor, `${f.p}_m`, `${f.p}_i`, {}, "production")).rejects.toMatchObject({ code: "resource_not_found" });
      await expect(listPlatformMcpConnectionsForClient(reader, f.actor, `${f.p}_m`, { environment: "production" }, "sandbox")).rejects.toMatchObject({ code: "validation_error" });
    } finally {
      await reader.query("ROLLBACK"); reader.release();
      if (previousHost === undefined) delete process.env.PARTNER_PUBLIC_HOST; else process.env.PARTNER_PUBLIC_HOST = previousHost;
    }
  });
  it("allows readonly platform metadata and sees membership revocation in the same READ COMMITTED read-only transaction", async () => {
    const f = await fixture(), reader = await pool.connect();
    await observer.query("UPDATE app.operator_memberships SET role_key='platform_readonly' WHERE operator_id=$1", [f.actor.operatorId]);
    try {
      await reader.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY; SET LOCAL ROLE snus_partner_control");
      expect(await listPlatformMcpConnectionsForClient(reader, f.actor, `${f.p}_m`, {}, "sandbox")).toMatchObject({ canRevokeKeys: false });
      expect(await getPlatformMcpConnectionForClient(reader, f.actor, `${f.p}_m`, `${f.p}_i`, {}, "sandbox")).toMatchObject({ canRevokeKeys: false });
      await observer.query("UPDATE app.operator_memberships SET status='revoked' WHERE operator_id=$1", [f.actor.operatorId]);
      await expect(listPlatformMcpConnectionsForClient(reader, f.actor, `${f.p}_m`, {}, "sandbox")).rejects.toMatchObject({ code: "forbidden" });
      await expect(getPlatformMcpConnectionForClient(reader, f.actor, `${f.p}_m`, "missing", {}, "sandbox")).rejects.toMatchObject({ code: "forbidden" });
    } finally { await reader.query("ROLLBACK"); reader.release(); }
  });
  it("rejects a caller transaction that could serve stale authorization or write during metadata reads", async () => {
    const f = await fixture(), reader = await pool.connect();
    try {
      for (const begin of ["BEGIN", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]) {
        await reader.query(begin); await reader.query("SET LOCAL ROLE snus_partner_control");
        await expect(listPlatformMcpConnectionsForClient(reader, f.actor, `${f.p}_m`, {}, "sandbox")).rejects.toMatchObject({ code: "dependency_unavailable" });
        await reader.query("ROLLBACK");
      }
    } finally { await reader.query("ROLLBACK"); reader.release(); }
  });
  it("returns all metadata beyond fifty connections, keys and grants without leaking another merchant", async () => {
    const f = await fixture(), reader = await pool.connect(), keys = Array.from({ length: 55 }, () => generatePartnerMcpKey("sandbox"));
    await observer.query(`INSERT INTO integration.integrations(id,partner_id,merchant_id,environment,installation_key,policy_id,policy_version)
      SELECT $1||'_extra_'||n,$1||'_p',$1||'_m','sandbox',$1||'_extra_'||n,$1||'_policy',1 FROM generate_series(1,55) n`, [f.p]);
    await observer.query(`INSERT INTO integration.partner_mcp_keys(id,integration_id,label,secret_hash,scopes,created_by,expires_at)
      SELECT k.id,$1,'Paged metadata UAT',k.hash,$2,$3,clock_timestamp()+interval '1 day'
      FROM unnest($4::text[],$5::text[]) k(id,hash)`, [`${f.p}_i`, partnerScopes, f.actor.operatorId, keys.map(key => key.keyId), keys.map(key => key.secretHash)]);
    await observer.query("INSERT INTO public.stock_location(id,name) SELECT $1||'_extra_l_'||n,'Metadata UAT '||n FROM generate_series(1,55) n", [f.p]);
    await observer.query(`INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,status)
      SELECT $1||'_extra_s_'||n,$1||'_m','Metadata UAT '||n,$1||'_extra_l_'||n,'active' FROM generate_series(1,55) n`, [f.p]);
    await observer.query(`INSERT INTO integration.store_grants(integration_id,merchant_id,store_id,stock_location_id,allowed_scopes,assortment_id,status)
      SELECT $1||'_i',$1||'_m',$1||'_extra_s_'||n,$1||'_extra_l_'||n,$2,$1||'_a','active' FROM generate_series(1,55) n`, [f.p, partnerScopes]);
    try {
      await reader.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY; SET LOCAL ROLE snus_partner_control");
      const first = await listPlatformMcpConnectionsForClient(reader, f.actor, `${f.p}_m`, {}, "sandbox");
      const second = await listPlatformMcpConnectionsForClient(reader, f.actor, `${f.p}_m`, { after: first.nextAfter }, "sandbox");
      expect(first.data).toHaveLength(50); expect(second.data).toHaveLength(6); expect(second.nextAfter).toBeNull();
      expect(new Set([...first.data, ...second.data].map(row => row.integrationId)).size).toBe(56);
      expect([...first.data, ...second.data].every(row => row.merchantId === `${f.p}_m`)).toBe(true);
      const detail = await getPlatformMcpConnectionForClient(reader, f.actor, `${f.p}_m`, `${f.p}_i`, {}, "sandbox");
      const next = await getPlatformMcpConnectionForClient(reader, f.actor, `${f.p}_m`, `${f.p}_i`, { keysAfter: detail.keys.nextAfter, grantsAfter: detail.grants.nextAfter }, "sandbox");
      expect(detail.keys.data).toHaveLength(50); expect(next.keys.data).toHaveLength(6); expect(next.keys.nextAfter).toBeNull();
      expect(detail.grants.data).toHaveLength(50); expect(next.grants.data).toHaveLength(7); expect(next.grants.nextAfter).toBeNull();
      expect(new Set([...detail.keys.data, ...next.keys.data].map(key => key.id)).size).toBe(56);
      expect(new Set([...detail.grants.data, ...next.grants.data].map(grant => grant.storeId)).size).toBe(57);
      expect(detail.authorizationSnapshotSha256).toBe(next.authorizationSnapshotSha256);
      expect(await listPlatformMcpConnectionsForClient(reader, f.actor, `${f.p}_other`, {}, "sandbox")).toMatchObject({ data: [], nextAfter: null });
    } finally { await reader.query("ROLLBACK"); reader.release(); }
  });
  it("serializes identical first requests to one mutation and metadata-only replay", async () => {
    const f = await fixture(), a = await pool.connect(), b = await pool.connect();
    let running: Promise<unknown> | undefined;
    try {
      await a.query("BEGIN; SET LOCAL ROLE snus_partner_control");
      await b.query("BEGIN; SET LOCAL ROLE snus_partner_control");
      const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const headers = { "idempotency-key": `same-mcp-revoke-${randomUUID()}` };
      const first = await revokePlatformMcpKeyForClient(a, f.actor, `${f.p}_m`, `${f.p}_i`, f.key.keyId, input, headers, "sandbox");
      const second = revokePlatformMcpKeyForClient(b, f.actor, `${f.p}_m`, `${f.p}_i`, f.key.keyId, input, headers, "sandbox");
      running = second; void second.catch(() => undefined);
      await waitForBlocked(pid); await a.query("COMMIT");
      expect(await second).toMatchObject({ data: first.data, replayed: true, secretStatus: "unavailable_on_replay" });
      await b.query("COMMIT");
      expect((await observer.query("SELECT count(*)::int AS count FROM integration.control_request_receipts WHERE result_integration_id=$1", [`${f.p}_i`])).rows[0].count).toBe(1);
      expect((await observer.query("SELECT count(*)::int AS count FROM audit.events WHERE subject_id=$1 AND action='platform.mcp.key_revoked'", [`${f.p}_i`])).rows[0].count).toBe(1);
    } finally { await a.query("ROLLBACK"); if (running) await running.catch(() => undefined); await b.query("ROLLBACK"); a.release(); b.release(); }
  });
  it("rechecks key version after a different concurrent command commits", async () => {
    const f = await fixture(), a = await pool.connect(), b = await pool.connect();
    let running: Promise<unknown> | undefined;
    try {
      await a.query("BEGIN; SET LOCAL ROLE snus_partner_control"); await b.query("BEGIN; SET LOCAL ROLE snus_partner_control");
      const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await revokePlatformMcpKeyForClient(a, f.actor, `${f.p}_m`, `${f.p}_i`, f.key.keyId, input, { "idempotency-key": `first-${randomUUID()}` }, "sandbox");
      const second = revokePlatformMcpKeyForClient(b, f.actor, `${f.p}_m`, `${f.p}_i`, f.key.keyId, input, { "idempotency-key": `second-${randomUUID()}` }, "sandbox");
      running = second; void second.catch(() => undefined);
      await waitForBlocked(pid); await a.query("COMMIT");
      await expect(second).rejects.toMatchObject({ code: "mcp_key_version_conflict", statusCode: 409 });
    } finally { await a.query("ROLLBACK"); if (running) await running.catch(() => undefined); await b.query("ROLLBACK"); a.release(); b.release(); }
  });
  it.each(["session", "membership", "expiry"])("denies authority lost while the command waits for its integration: %s", async loss => {
    const f = await fixture(), holder = await pool.connect(), control = await pool.connect();
    let running: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM integration.integrations WHERE id=$1 FOR UPDATE", [`${f.p}_i`]);
      await control.query("BEGIN; SET LOCAL ROLE snus_partner_control");
      const pid = (await control.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      if (loss === "expiry") f.actor.sessionExpiresAt = new Date(Date.now() + 500).toISOString();
      const command = revokePlatformMcpKeyForClient(control, f.actor, `${f.p}_m`, `${f.p}_i`, f.key.keyId, input,
        { "idempotency-key": `authority-${randomUUID()}` }, "sandbox");
      running = command; void command.catch(() => undefined);
      await waitForBlocked(pid);
      if (loss === "session") await observer.query("UPDATE app.operator_security_state SET session_version=session_version+1 WHERE operator_id=$1", [f.actor.operatorId]);
      if (loss === "membership") await observer.query("UPDATE app.operator_memberships SET status='revoked' WHERE operator_id=$1", [f.actor.operatorId]);
      if (loss === "expiry") await observer.query("SELECT pg_sleep(0.6)");
      await holder.query("COMMIT");
      await expect(command).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
      expect((await observer.query("SELECT status,version FROM integration.partner_mcp_keys WHERE id=$1", [f.key.keyId])).rows[0]).toEqual({ status: "active", version: 1 });
      expect((await observer.query("SELECT count(*)::int AS count FROM integration.control_request_receipts WHERE result_integration_id=$1", [`${f.p}_i`])).rows[0].count).toBe(0);
    } finally { await holder.query("ROLLBACK"); if (running) await running.catch(() => undefined); await control.query("ROLLBACK"); holder.release(); control.release(); }
  });
  it("waits for an authorized booking to commit, then denies the revoked key after ACK", async () => {
    const f = await fixture(), booking = await pool.connect(), control = await pool.connect();
    let running: Promise<unknown> | undefined;
    const bearer = `Bearer ${f.key.key}`, fingerprints = { current: "v1", keys: { v1: randomBytes(32).toString("base64url") } };
    try {
      await booking.query("BEGIN; SET LOCAL ROLE snus_partner_api");
      await booking.query("SELECT integration.lock_authorization($1,$2,$3,'mcp_key')", [`${f.p}_i`, f.key.keyId, `${f.p}_s1`]);
      const identity = await readPartnerMcpIdentity(booking, bearer, "sandbox", `${f.p}:booking`, "a".repeat(32));
      const ctx = selectPartnerStore(identity, `${f.p}_s1`, "orders:write", true);
      const quote = await createPartnerQuoteForClient(booking, ctx, fingerprints, { store_id: `${f.p}_s1`, items: [{ variant_id: `${f.p}_v1`, quantity: 1 }], fulfillment_mode: "pickup" });
      await control.query("BEGIN; SET LOCAL ROLE snus_partner_control");
      const pid = (await control.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const revocation = revokePlatformMcpKeyForClient(control, f.actor, `${f.p}_m`, `${f.p}_i`, f.key.keyId, input, { "idempotency-key": `booking-revoke-${randomUUID()}` }, "sandbox");
      running = revocation; void revocation.catch(() => undefined);
      await waitForBlocked(pid);
      const result = await bookPartnerOrderForClient(booking, ctx, fingerprints, { store_id: `${f.p}_s1`, quote_id: quote.data.quote_id,
        external_order_id: `${f.p}:order`, payment_method: "cod", fulfillment: { mode: "pickup" } }, `book-${randomUUID()}`);
      expect(result.status).toBe(201); await booking.query("COMMIT");
      await revocation; await control.query("COMMIT");
      await booking.query("BEGIN; SET LOCAL ROLE snus_partner_api");
      await expect(readPartnerMcpIdentity(booking, bearer, "sandbox", `${f.p}:after-ack`, "a".repeat(32))).rejects.toMatchObject({ code: "invalid_token" });
      expect((await observer.query("SELECT count(*)::int AS count FROM integration.partner_orders WHERE integration_id=$1", [`${f.p}_i`])).rows[0].count).toBe(1);
      expect(Number((await observer.query("SELECT stocked_quantity FROM public.inventory_level WHERE id=$1", [`${f.p}_il1`])).rows[0].stocked_quantity)).toBe(9);
    } finally { await booking.query("ROLLBACK"); if (running) await running.catch(() => undefined); await control.query("ROLLBACK"); booking.release(); control.release(); }
  });
});
