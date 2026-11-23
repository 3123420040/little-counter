import { randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { permissions, type RequestAccess } from "@medusa-snus/contracts";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { executePartnerControlForClient } from "../partner/control";
import { seedPartnerBookingFixture } from "./helpers/partner-booking-fixture";
import { readPartnerIdentity, selectPartnerStore } from "../partner/registry";
import { createPartnerQuoteForClient } from "../partner/quotes";
import { bookPartnerOrderForClient } from "../partner/booking";
import { partnerScopes, type PartnerOrderRequest } from "@medusa-snus/contracts/partner-api";
import { changePlatformBusinessStatus } from "../services/platform-business-lifecycle-service";
import { shutdownPlatformPool } from "../db/client";
import type { OperatorContext } from "../services/auth-service";

let pool: Pool, observer: PoolClient;
const fixtures: string[] = [];
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString, max: 4 });
  observer = await pool.connect(); await assertSafeTestDatabaseSentinel(observer, target);
});
afterAll(async () => {
  for (const prefix of fixtures) await observer.query("UPDATE integration.integrations SET status='revoked',writes_enabled=false WHERE id=$1", [`${prefix}_i`]);
  observer?.release(); await pool?.end();
  await shutdownPlatformPool();
});
async function fixture() {
  const prefix = `cl${randomBytes(6).toString("hex")}`;
  await observer.query("BEGIN");
  try { await seedPartnerBookingFixture(observer, prefix); await observer.query("COMMIT"); }
  catch (error) { await observer.query("ROLLBACK"); throw error; }
  fixtures.push(prefix); return prefix;
}
const fingerprints = { current: "v1", keys: { v1: randomBytes(32).toString("base64url") } };
async function platformActor(): Promise<OperatorContext> {
  const operatorId = `platform-lock-${randomBytes(8).toString("hex")}`;
  await observer.query(`INSERT INTO medusa.staff_users(operator_id,password_hash,display_name,role,organization_id,is_active)
    VALUES($1,'not-a-live-password-hash','Partner status UAT','owner','org_default',true)`, [operatorId]);
  await observer.query("INSERT INTO app.operator_security_state(operator_id) VALUES($1)", [operatorId]);
  await observer.query(`INSERT INTO app.operator_memberships(operator_id,scope_type,role_key,status,granted_by)
    VALUES($1,'platform','platform_admin','active','UAT')`, [operatorId]);
  return { operatorId, role: "owner", organizationId: "org_default", displayName: "Partner status UAT", authState: "authenticated",
    sessionVersion: 1, sessionExpiresAt: new Date(Date.now() + 60_000).toISOString() };
}
async function bookingContext(db: PoolClient, prefix: string) {
  const token = { issuer: `https://${prefix}.invalid`, clientId: "reads", subject: "subject", scopes: partnerScopes, expiresAt: 9999999999 };
  let identity = await readPartnerIdentity(db, token, "sandbox", `${prefix}:request`, "a".repeat(32));
  selectPartnerStore(identity, `${prefix}_s1`, "orders:write", true);
  await db.query("SELECT integration.lock_authorization($1,$2,$3)", [identity.integrationId, identity.registryClientId, `${prefix}_s1`]);
  identity = await readPartnerIdentity(db, token, "sandbox", `${prefix}:request`, "a".repeat(32));
  return selectPartnerStore(identity, `${prefix}_s1`, "orders:write", true);
}
async function quote(prefix: string): Promise<PartnerOrderRequest> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN; SET LOCAL ROLE snus_partner_api");
    const ctx = await bookingContext(db, prefix);
    const result = await createPartnerQuoteForClient(db, ctx, fingerprints, { store_id: `${prefix}_s1`,
      items: [{ variant_id: `${prefix}_v1`, quantity: 1 }], fulfillment_mode: "pickup" });
    await db.query("COMMIT");
    return { store_id: `${prefix}_s1`, quote_id: result.data.quote_id, external_order_id: `${prefix}:external`, payment_method: "cod", fulfillment: { mode: "pickup" } };
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
function activate(db: PoolClient, prefix: string) {
  const access: RequestAccess = { actorId: "op_owner", legacyOrganizationId: `${prefix}_org`, isPlatformAdmin: false,
    permissionIds: [permissions.partnerManage], explicitPermissions: [], memberships: [{ membershipId: `${prefix}_membership`,
      operatorId: "op_owner", scopeType: "merchant", merchantId: `${prefix}_m`, storeId: null, roleKey: "owner", status: "active",
      permissionIds: [permissions.partnerManage] }] };
  return executePartnerControlForClient(db, { operatorId: "op_owner", role: "owner", organizationId: `${prefix}_org`, displayName: "UAT", access },
    { scopeKind: "merchant_target", merchantId: `${prefix}_m` }, { action: "set_status", integration_id: `${prefix}_i`,
      status: "active", writes_enabled: false, reason: "onboarding", conformance_receipt_sha256: "a".repeat(64) },
    "sandbox", `https://${prefix}.invalid`, `${prefix}:activate`);
}

describe("control activation lifecycle concurrency", () => {
  it("rejects booking a pre-suspension quote after the actual platform status command commits", async () => {
    const prefix = await fixture(), admin = await platformActor(), body = await quote(prefix), db = await pool.connect();
    await changePlatformBusinessStatus("merchant", `${prefix}_m`, { status: "suspended", expectedVersion: 1, reason: "UAT suspend after quote" }, admin,
      { "idempotency-key": `${prefix}:suspend` });
    try {
      await db.query("BEGIN; SET LOCAL ROLE snus_partner_api");
      await expect(bookingContext(db, prefix)).rejects.toMatchObject({ code: "integration_disabled" });
      expect(body.quote_id).toBeTruthy();
      expect((await observer.query("SELECT count(*)::int AS count FROM integration.partner_orders WHERE integration_id=$1", [`${prefix}_i`])).rows[0].count).toBe(0);
      expect(Number((await observer.query("SELECT stocked_quantity FROM public.inventory_level WHERE id=$1", [`${prefix}_il1`])).rows[0].stocked_quantity)).toBe(10);
    } finally { await db.query("ROLLBACK"); db.release(); }
  });
  it("completes an authorized Partner booking before a queued platform suspension without lock inversion", async () => {
    const prefix = await fixture(), admin = await platformActor(), body = await quote(prefix), db = await pool.connect();
    let status: ReturnType<typeof changePlatformBusinessStatus> | undefined;
    try {
      await db.query("BEGIN; SET LOCAL ROLE snus_partner_api");
      const ctx = await bookingContext(db, prefix), pid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      status = changePlatformBusinessStatus("merchant", `${prefix}_m`, { status: "suspended", expectedVersion: 1, reason: "UAT queued suspend" }, admin,
        { "idempotency-key": `${prefix}:queued-suspend` });
      const deadline = Date.now() + 1_000; let waiting = false;
      while (!waiting && Date.now() < deadline) {
        waiting = (await observer.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting", [pid])).rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      const booked = await bookPartnerOrderForClient(db, ctx, fingerprints, body, `${prefix}:book-stable-key`);
      expect(booked.body.data.order_id).toBeTruthy(); await db.query("COMMIT");
      await expect(status).resolves.toMatchObject({ response: { data: { status: "suspended", statusVersion: 2 } } });
      expect((await observer.query("SELECT count(*)::int AS count FROM integration.partner_orders WHERE integration_id=$1", [`${prefix}_i`])).rows[0].count).toBe(1);
      expect(Number((await observer.query("SELECT stocked_quantity FROM public.inventory_level WHERE id=$1", [`${prefix}_il1`])).rows[0].stocked_quantity)).toBe(9);
    } finally { await db.query("ROLLBACK"); if (status) await status.catch(() => undefined); db.release(); }
  });
  it("uses the remaining eligible store when the first candidate is suspended while acquiring its lock", async () => {
    const prefix = await fixture(), holder = await pool.connect(), control = await pool.connect();
    let running: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("UPDATE app.stores SET status='suspended' WHERE id=$1", [`${prefix}_s1`]);
      const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const controlPid = (await control.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await control.query("BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='3s'; SET LOCAL ROLE snus_partner_control");
      running = activate(control, prefix);
      const deadline = Date.now() + 1_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        waiting = (await observer.query("SELECT $1=ANY(pg_blocking_pids($2)) AS waiting", [holderPid, controlPid])).rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await holder.query("COMMIT");
      await expect(running).resolves.toMatchObject({ status: "active", writes_enabled: false });
      await control.query("COMMIT");
      expect((await observer.query("SELECT count(*)::int AS count FROM audit.events WHERE subject_id=$1 AND action='partner.set_status'", [`${prefix}_i`])).rows[0].count).toBe(1);
    } finally {
      await holder.query("ROLLBACK");
      if (running) await running.catch(() => undefined);
      await control.query("ROLLBACK"); holder.release(); control.release();
    }
  });
  it("refuses activation when no active eligible store remains", async () => {
    const prefix = await fixture(), control = await pool.connect();
    await observer.query("UPDATE app.stores SET status='suspended' WHERE merchant_id=$1", [`${prefix}_m`]);
    try {
      await control.query("BEGIN; SET LOCAL ROLE snus_partner_control");
      await expect(activate(control, prefix)).rejects.toMatchObject({ code: "integration_not_ready", statusCode: 409 });
    } finally { await control.query("ROLLBACK"); control.release(); }
  });
});
