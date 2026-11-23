import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPlatformClient, shutdownPlatformPool, type PoolClient } from "../db/client";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { ensurePlatformSchema } from "../db/schema";
import type { OperatorContext } from "../services/auth-service";
import { changePlatformBusinessStatus } from "../services/platform-business-lifecycle-service";
import { lockActiveBusinessScopeForClient } from "../services/business-lifecycle-service";
import { revokePlatformMembership } from "../services/platform-admin-service";
import { signJwt } from "../middleware/auth";
import { POST as merchantStatusRoute } from "../../../../src/api/platform/admin/merchants/[merchantId]/status/route";
import { POST as storeStatusRoute } from "../../../../src/api/platform/admin/stores/[storeId]/status/route";
import { GET as meRoute } from "../../../../src/api/me/route";
import type { MedusaRequest, MedusaResponse } from "../../../../src/lib/http-types";

const runId = randomUUID();
let db: PoolClient;
async function actor(role = "platform_admin"): Promise<OperatorContext> {
  const operatorId = `lifecycle-admin-${randomUUID()}`;
  await db.query(`INSERT INTO medusa.staff_users(operator_id,password_hash,display_name,role,organization_id,is_active)
    VALUES($1,'not-a-live-password-hash','Lifecycle UAT','owner','org_default',true)`, [operatorId]);
  await db.query("INSERT INTO app.operator_security_state(operator_id) VALUES($1)", [operatorId]);
  // This actor is already authorized, rather than a clock-boundary membership activation.
  await db.query(`INSERT INTO app.operator_memberships(operator_id,scope_type,role_key,status,granted_by,valid_from)
    VALUES($1,'platform',$2,'active','UAT',clock_timestamp()-interval '1 day')`, [operatorId, role]);
  return { operatorId, displayName: "Lifecycle UAT", role: "owner", organizationId: "org_default",
    sessionVersion: 1, authState: "authenticated", sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString() };
}
async function fixture(status = "active") {
  const merchantId = `lifecycle-command-${randomUUID()}`, storeId = `${merchantId}:store`;
  await db.query("INSERT INTO app.merchants(id,display_name,legacy_organization_id,status) VALUES($1,'Lifecycle command',$1,$2)", [merchantId, status]);
  for (const state of ["active", "suspended", "closed"]) {
    const id = state === "active" ? storeId : `${storeId}:${state}`;
    await db.query("INSERT INTO public.stock_location(id,name) VALUES($1,'Lifecycle UAT')", [id]);
    await db.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,status,is_primary) VALUES($1,$2,$1,$1,$3,$4)", [id, merchantId, state, state === "active"]);
  }
  return { merchantId, storeId };
}
const command = (status = "suspended", expectedVersion = 1) => ({ status, expectedVersion, reason: "  Handover UAT  " });
const headers = (key = randomUUID()) => ({ "idempotency-key": `${runId}:${key}` });
async function facts(kind: "merchant" | "store", id: string) {
  return (await db.query(`SELECT status,status_version::text,status_changed_at FROM app.${kind === "merchant" ? "merchants" : "stores"} WHERE id=$1`, [id])).rows[0];
}
async function auditCount(id: string) {
  return (await db.query("SELECT count(*)::int AS count FROM audit.events WHERE subject_id=$1 AND action LIKE 'platform.%.status_changed'", [id])).rows[0].count;
}
async function request(who: OperatorContext | null, handler: typeof merchantStatusRoute | typeof meRoute,
  params: Record<string, string>, input: unknown = command(), extraHeaders: Record<string, string> = {}) {
  const token = who ? signJwt({ ...who, displayName: who.displayName }) : null;
  let status = 200, payload: unknown;
  const responseHeaders: Record<string, unknown> = {};
  const req = { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers(), ...extraHeaders }, params, body: input, query: {} } as MedusaRequest;
  const res = { status(code: number) { status = code; return res; }, json(value: unknown) { payload = value; },
    setHeader(key: string, value: unknown) { responseHeaders[key] = value; } } as MedusaResponse;
  await handler(req, res); return { status, payload, responseHeaders };
}
beforeAll(async () => {
  db = await connectPlatformClient(); await assertSafeTestDatabaseSentinel(db, requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL));
  await ensurePlatformSchema();
  expect((await db.query("SELECT count(*)::int AS count FROM app.schema_migrations WHERE filename='070_business_lifecycle_versions.sql'")).rows[0].count).toBe(1);
});
afterAll(async () => { db?.release(); await shutdownPlatformPool(); });

describe("atomic platform lifecycle commands", () => {
  it("enforces fresh platform role at the authenticated HTTP seams and exposes command authority separately from visibility", async () => {
    const admin = await actor(), reader = await actor("platform_readonly"), f = await fixture();
    await db.query(`INSERT INTO app.operator_explicit_permission_grants(operator_id,permission_id,scope_type,status,granted_by)
      VALUES($1,'platform:write','platform','active','UAT')`, [reader.operatorId]);
    expect((await request(admin, meRoute, {})).payload).toMatchObject({ isPlatformAdmin: true, canManageMerchantLifecycle: true });
    expect((await request(reader, meRoute, {})).payload).toMatchObject({ isPlatformAdmin: true, canManageMerchantLifecycle: false });
    const denied = await request(reader, merchantStatusRoute, { merchantId: f.merchantId });
    expect(denied).toMatchObject({ status: 403, payload: { error: { code: "forbidden" } }, responseHeaders: { "Cache-Control": "no-store" } });
    const allowed = await request(admin, merchantStatusRoute, { merchantId: f.merchantId }, command(), { "x-operating-store-id": "foreign-stale-store" });
    expect(allowed).toMatchObject({ status: 200, payload: { data: { entityId: f.merchantId, status: "suspended", statusVersion: 2 } } });
    const store = await request(admin, storeStatusRoute, { storeId: f.storeId });
    expect(store).toMatchObject({ status: 200, payload: { data: { entityType: "store", entityId: f.storeId, status: "suspended" } } });
    expect((await request(null, merchantStatusRoute, { merchantId: f.merchantId })).status).toBe(401);
  });
  it("rejects strict HTTP fields and a merchant owner without platform membership", async () => {
    const who = await actor(), f = await fixture();
    for (const fields of [{ merchantId: "foreign" }, { status: "closed" }, { reason: " " }, { expectedVersion: "1" }]) {
      expect((await request(who, merchantStatusRoute, { merchantId: f.merchantId }, { ...command(), ...fields })).status).toBe(400);
    }
    await db.query("DELETE FROM app.operator_memberships WHERE operator_id=$1", [who.operatorId]);
    await db.query(`INSERT INTO app.operator_memberships(operator_id,scope_type,merchant_id,role_key,status,granted_by)
      VALUES($1,'merchant',$2,'owner','active','UAT')`, [who.operatorId, f.merchantId]);
    expect((await request(who, merchantStatusRoute, { merchantId: f.merchantId })).status).toBe(403);
    expect((await facts("merchant", f.merchantId)).status).toBe("active");
  });
  it("suspends and enables a parent without cascading child states, permissions or stock location", async () => {
    const who = await actor(), f = await fixture();
    const before = (await db.query("SELECT id,status,stock_location_id,is_primary FROM app.stores WHERE merchant_id=$1 ORDER BY id", [f.merchantId])).rows;
    const first = await changePlatformBusinessStatus("merchant", f.merchantId, command(), who, headers());
    expect(first).toMatchObject({ statusCode: 200, response: { data: { status: "suspended", statusVersion: 2, changed: true, statusChangedAt: expect.any(String) } } });
    expect((await db.query("SELECT id,status,stock_location_id,is_primary FROM app.stores WHERE merchant_id=$1 ORDER BY id", [f.merchantId])).rows).toEqual(before);
    const second = await changePlatformBusinessStatus("merchant", f.merchantId, command("active", 2), who, headers());
    expect(second.response.data).toMatchObject({ status: "active", statusVersion: 3, changed: true });
    expect((await db.query("SELECT id,status,stock_location_id,is_primary FROM app.stores WHERE merchant_id=$1 ORDER BY id", [f.merchantId])).rows).toEqual(before);
    expect(await auditCount(f.merchantId)).toBe(2);
    expect((await db.query("SELECT reason,before,after FROM audit.events WHERE subject_id=$1 ORDER BY created_at", [f.merchantId])).rows[0])
      .toMatchObject({ reason: "Handover UAT", before: { status: "active", statusVersion: 1 }, after: { status: "suspended", statusVersion: 2 } });
  });
  it("replays the same committed command without another transition and rejects a different body", async () => {
    const who = await actor(), f = await fixture(), h = headers();
    const first = await changePlatformBusinessStatus("merchant", f.merchantId, command(), who, h);
    expect((await changePlatformBusinessStatus("merchant", f.merchantId, command(), who, h)).response).toEqual(first.response);
    await expect(changePlatformBusinessStatus("merchant", f.merchantId, command("active"), who, h)).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await auditCount(f.merchantId)).toBe(1);
  });
  it("rechecks membership expiry after an idempotent replay waited for its request lock", async () => {
    const who = await actor(), f = await fixture(), h = headers();
    await changePlatformBusinessStatus("merchant", f.merchantId, command(), who, h);
    await db.query("UPDATE app.operator_memberships SET valid_to=clock_timestamp()+interval '400 milliseconds' WHERE operator_id=$1", [who.operatorId]);
    await db.query("BEGIN");
    let pending: ReturnType<typeof changePlatformBusinessStatus> | undefined;
    try {
      const key = `platform:${who.operatorId}\u001fplatform.merchant.status\u001f${h["idempotency-key"]}`;
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
      const pid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      pending = changePlatformBusinessStatus("merchant", f.merchantId, command(), who, h);
      const deadline = Date.now() + 1_000; let waiting = false;
      while (!waiting && Date.now() < deadline) {
        waiting = (await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting", [pid])).rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await db.query("SELECT pg_sleep(0.45)"); await db.query("COMMIT");
      await expect(pending).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
      expect(await auditCount(f.merchantId)).toBe(1);
    } finally { await db.query("ROLLBACK"); if (pending) await pending.catch(() => undefined); }
  });
  it("records an idempotent no-op without changing version, timestamp or audit", async () => {
    const who = await actor(), f = await fixture();
    expect((await changePlatformBusinessStatus("merchant", f.merchantId, command("active"), who, headers())).response.data)
      .toMatchObject({ status: "active", statusVersion: 1, changed: false, statusChangedAt: null });
    expect(await auditCount(f.merchantId)).toBe(0);
    await expect(changePlatformBusinessStatus("merchant", f.merchantId, command("active", 2), who, headers())).rejects.toMatchObject({ code: "lifecycle_version_conflict" });
  });
  it("keeps closed entities read-only and validates the store parent", async () => {
    const who = await actor(), closed = await fixture("closed"), f = await fixture("suspended");
    for (const [kind, id] of [["merchant", closed.merchantId], ["store", closed.storeId], ["store", `${f.storeId}:closed`]] as const) {
      await expect(changePlatformBusinessStatus(kind, id, command("active"), who, headers())).rejects.toMatchObject({ code: "entity_closed" });
    }
    await expect(changePlatformBusinessStatus("store", `${f.storeId}:suspended`, command("active"), who, headers())).rejects.toMatchObject({ code: "parent_suspended" });
    expect((await changePlatformBusinessStatus("store", f.storeId, command(), who, headers())).response.data).toMatchObject({ status: "suspended", statusVersion: 2 });
    expect((await facts("merchant", f.merchantId)).status).toBe("suspended");
  });
  it("allows suspension of the last primary store without replacing or enabling another store", async () => {
    const who = await actor(), f = await fixture();
    await changePlatformBusinessStatus("store", f.storeId, command(), who, headers());
    expect((await db.query("SELECT count(*)::int AS count FROM app.stores WHERE merchant_id=$1 AND status='active'", [f.merchantId])).rows[0].count).toBe(0);
    expect((await db.query("SELECT is_primary FROM app.stores WHERE id=$1", [f.storeId])).rows[0].is_primary).toBe(true);
    expect((await facts("merchant", f.merchantId)).status).toBe("active");
  });
  it("requires idempotency and refuses unknown targets or unsafe versions without mutation", async () => {
    const who = await actor(), f = await fixture();
    await expect(changePlatformBusinessStatus("merchant", f.merchantId, command(), who, {})).rejects.toMatchObject({ code: "idempotency_key_required" });
    await expect(changePlatformBusinessStatus("store", "missing-store", command(), who, headers())).rejects.toMatchObject({ code: "resource_not_found" });
    await db.query("UPDATE app.merchants SET status_version=$2 WHERE id=$1", [f.merchantId, Number.MAX_SAFE_INTEGER]);
    await expect(changePlatformBusinessStatus("merchant", f.merchantId, command("suspended", Number.MAX_SAFE_INTEGER), who, headers())).rejects.toMatchObject({ code: "lifecycle_version_exhausted" });
    expect(await auditCount(f.merchantId)).toBe(0);
  });
  it("denies platform_readonly even with an explicit platform write grant and a forged cached admin role", async () => {
    const who = await actor("platform_readonly"), f = await fixture();
    await db.query(`INSERT INTO app.operator_explicit_permission_grants(operator_id,permission_id,scope_type,status,granted_by)
      VALUES($1,'platform:write','platform','active','UAT')`, [who.operatorId]);
    await expect(changePlatformBusinessStatus("merchant", f.merchantId, command(), who, headers())).rejects.toMatchObject({ code: "forbidden" });
    expect((await facts("merchant", f.merchantId)).status).toBe("active");
  });
  it.each(["staff-disabled", "global-suspended", "password-change", "session-version", "session-expired", "membership-expired", "membership-revoked", "impersonation"])("denies fresh authority failure %s including committed replay", async failure => {
    const who = await actor(), f = await fixture(), h = headers();
    await changePlatformBusinessStatus("merchant", f.merchantId, command(), who, h);
    if (failure === "staff-disabled") await db.query("UPDATE medusa.staff_users SET is_active=false WHERE operator_id=$1", [who.operatorId]);
    if (failure === "global-suspended") await db.query("UPDATE app.operator_security_state SET global_status='suspended' WHERE operator_id=$1", [who.operatorId]);
    if (failure === "password-change") await db.query("UPDATE app.operator_security_state SET requires_password_change=true WHERE operator_id=$1", [who.operatorId]);
    if (failure === "session-version") await db.query("UPDATE app.operator_security_state SET session_version=session_version+1 WHERE operator_id=$1", [who.operatorId]);
    if (failure === "session-expired") who.sessionExpiresAt = new Date(Date.now() - 1_000).toISOString();
    if (failure === "membership-expired") await db.query("UPDATE app.operator_memberships SET valid_to=clock_timestamp()-interval '1 second' WHERE operator_id=$1", [who.operatorId]);
    if (failure === "membership-revoked") await db.query("UPDATE app.operator_memberships SET status='revoked' WHERE operator_id=$1", [who.operatorId]);
    if (failure === "impersonation") who.impersonationMode = "read_only";
    await expect(changePlatformBusinessStatus("merchant", f.merchantId, command(), who, h)).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
    expect(await auditCount(f.merchantId)).toBe(1);
    expect((await facts("merchant", f.merchantId)).status_version).toBe("2");
  });
  it("serializes simultaneous first commands and preserves compare-and-set for different keys", async () => {
    const who = await actor(), f = await fixture(), h = headers();
    const pair = await Promise.all([1, 2].map(() => changePlatformBusinessStatus("merchant", f.merchantId, command(), who, h)));
    expect(pair[0].response).toEqual(pair[1].response); expect(await auditCount(f.merchantId)).toBe(1);
    const results = await Promise.allSettled([1, 2].map(() => changePlatformBusinessStatus("merchant", f.merchantId, command("active", 2), who, headers())));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "lifecycle_version_conflict" } });
    expect(await auditCount(f.merchantId)).toBe(2);
  });
  it("rolls status/version/timestamp and idempotency back when audit fails", async () => {
    const who = await actor(), f = await fixture(), h = headers(), trigger = `lifecycle_audit_${randomUUID().replaceAll("-", "")}`;
    await db.query(`CREATE FUNCTION pg_temp.reject_lifecycle_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.subject_id=TG_ARGV[0] THEN RAISE EXCEPTION 'UAT audit fault'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit.events FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_lifecycle_audit('${f.merchantId}')`);
    try { await expect(changePlatformBusinessStatus("merchant", f.merchantId, command(), who, h)).rejects.toThrow("UAT audit fault"); }
    finally { await db.query(`DROP TRIGGER ${trigger} ON audit.events`); }
    expect(await facts("merchant", f.merchantId)).toEqual({ status: "active", status_version: "1", status_changed_at: null });
    expect(await auditCount(f.merchantId)).toBe(0);
    expect((await changePlatformBusinessStatus("merchant", f.merchantId, command(), who, h)).response.data.statusVersion).toBe(2);
  });
  it("waits behind an ordinary writer and prevents a new writer after suspension commit", async () => {
    const who = await actor(), f = await fixture(), writer = await connectPlatformClient();
    let pending: ReturnType<typeof changePlatformBusinessStatus> | undefined;
    try {
      await writer.query("BEGIN"); await lockActiveBusinessScopeForClient(writer, { scopeType: "store", ...f });
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      pending = changePlatformBusinessStatus("merchant", f.merchantId, command(), who, headers());
      const deadline = Date.now() + 1_000; let waiting = false;
      while (!waiting && Date.now() < deadline) {
        waiting = (await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting", [pid])).rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true); expect((await facts("merchant", f.merchantId)).status).toBe("active");
      await writer.query("COMMIT"); await pending;
      await writer.query("BEGIN");
      await expect(lockActiveBusinessScopeForClient(writer, { scopeType: "store", ...f })).rejects.toMatchObject({ code: "scope_suspended" });
    } finally { await writer.query("ROLLBACK"); if (pending) await pending.catch(() => undefined); writer.release(); }
  });
  it("does not lock the acting staff row ahead of the target lifecycle row used by team writers", async () => {
    const who = await actor(), f = await fixture(), writer = await connectPlatformClient();
    let pending: ReturnType<typeof changePlatformBusinessStatus> | undefined;
    try {
      await writer.query("BEGIN; SET LOCAL lock_timeout='150ms'");
      await lockActiveBusinessScopeForClient(writer, { scopeType: "store", ...f });
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      pending = changePlatformBusinessStatus("merchant", f.merchantId, command(), who, headers());
      const deadline = Date.now() + 1_000; let waiting = false;
      while (!waiting && Date.now() < deadline) {
        waiting = (await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting", [pid])).rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await writer.query("UPDATE medusa.staff_users SET display_name='Concurrent team update UAT' WHERE operator_id=$1", [who.operatorId]);
      await writer.query("COMMIT");
      await expect(pending).resolves.toMatchObject({ response: { data: { status: "suspended" } } });
    } finally { await writer.query("ROLLBACK"); if (pending) await pending.catch(() => undefined); writer.release(); }
  });
  it.each(["membership", "session"])("denies a queued first command after %s authority is revoked before the target lock", async revocation => {
    const who = await actor(), f = await fixture(), writer = await connectPlatformClient();
    let pending: ReturnType<typeof changePlatformBusinessStatus> | undefined;
    try {
      await writer.query("BEGIN"); await writer.query("SELECT id FROM app.merchants WHERE id=$1 FOR UPDATE", [f.merchantId]);
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      pending = changePlatformBusinessStatus("merchant", f.merchantId, command(), who, headers());
      const deadline = Date.now() + 1_000; let waiting = false;
      while (!waiting && Date.now() < deadline) {
        waiting = (await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting", [pid])).rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      if (revocation === "membership") await db.query("UPDATE app.operator_memberships SET status='revoked' WHERE operator_id=$1", [who.operatorId]);
      else await db.query("UPDATE app.operator_security_state SET session_version=session_version+1 WHERE operator_id=$1", [who.operatorId]);
      await writer.query("COMMIT");
      await expect(pending).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
      expect(await facts("merchant", f.merchantId)).toEqual({ status: "active", status_version: "1", status_changed_at: null });
      expect(await auditCount(f.merchantId)).toBe(0);
    } finally { await writer.query("ROLLBACK"); if (pending) await pending.catch(() => undefined); writer.release(); }
  });
  it("rolls every command fact back on target lock timeout and permits retry with the same key", async () => {
    const who = await actor(), f = await fixture(), h = headers();
    await db.query("BEGIN");
    try {
      await db.query("SELECT id FROM app.merchants WHERE id=$1 FOR UPDATE", [f.merchantId]);
      await expect(changePlatformBusinessStatus("merchant", f.merchantId, command(), who, h)).rejects.toMatchObject({ code: "55P03" });
      expect(await facts("merchant", f.merchantId)).toEqual({ status: "active", status_version: "1", status_changed_at: null });
      expect(await auditCount(f.merchantId)).toBe(0);
      expect((await db.query("SELECT count(*)::int AS count FROM app.idempotency_records WHERE tenant_id=$1 AND operation='platform.merchant.status' AND idempotency_key=$2", [`platform:${who.operatorId}`, h["idempotency-key"]])).rows[0].count).toBe(0);
    } finally { await db.query("ROLLBACK"); }
    expect((await changePlatformBusinessStatus("merchant", f.merchantId, command(), who, h)).response.data.statusVersion).toBe(2);
  });
  it("serializes membership revocation behind an authorized command and denies requests after revoke acknowledgement", async () => {
    const who = await actor(), revoker = await actor(), f = await fixture(), h = headers();
    const membershipId = (await db.query("SELECT id::text FROM app.operator_memberships WHERE operator_id=$1", [who.operatorId])).rows[0].id;
    const key = `status-audit-${randomUUID()}`, trigger = `lifecycle_hold_${randomUUID().replaceAll("-", "")}`;
    await db.query(`CREATE FUNCTION pg_temp.hold_lifecycle_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.subject_id=TG_ARGV[0] THEN PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[1],0)); END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit.events FOR EACH ROW EXECUTE FUNCTION pg_temp.hold_lifecycle_audit('${f.merchantId}','${key}')`);
    let pending: ReturnType<typeof changePlatformBusinessStatus> | undefined, revoked: ReturnType<typeof revokePlatformMembership> | undefined;
    try {
      const pid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await db.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
      pending = changePlatformBusinessStatus("merchant", f.merchantId, command(), who, h);
      const deadline = Date.now() + 1_000; let commandPid: number | undefined;
      while (!commandPid && Date.now() < deadline) {
        commandPid = (await db.query("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event='advisory'", [pid])).rows[0]?.pid;
        if (!commandPid) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(commandPid).toBeTypeOf("number");
      revoked = revokePlatformMembership(membershipId, revoker, { reason: "UAT role revoke" });
      const revokeDeadline = Date.now() + 1_000; let waiting = false;
      while (!waiting && Date.now() < revokeDeadline) {
        waiting = (await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting", [commandPid])).rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
      await expect(pending).resolves.toMatchObject({ response: { data: { statusVersion: 2 } } });
      await expect(revoked).resolves.toMatchObject({ data: { status: "revoked" } });
      await expect(changePlatformBusinessStatus("merchant", f.merchantId, command(), who, h)).rejects.toMatchObject({ code: "forbidden" });
      expect(await auditCount(f.merchantId)).toBe(1);
    } finally {
      await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
      if (pending) await pending.catch(() => undefined); if (revoked) await revoked.catch(() => undefined);
      await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON audit.events`);
    }
  });
});
