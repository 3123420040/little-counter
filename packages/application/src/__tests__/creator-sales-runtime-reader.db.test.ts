import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { readCreatorSalesDashboardV2 } from "../services/creator-sales-dashboard-v2-service";
import { shutdownPlatformPool } from "../db/client";
import { signJwt } from "../middleware/auth";
import { GET as dashboard } from "../../../../src/api/admin/dashboard/creator-sales-v2/route";
import { GET as legacyDashboard } from "../../../../src/api/dashboard/route";
import { GET as adminLegacyDashboard } from "../../../../src/api/admin/dashboard/route";
import { GET as partialDashboard } from "../../../../src/api/admin/dashboard/partial-financial/route";
import { GET as orders } from "../../../../src/api/admin/orders/effective-v4/route";
import type { MedusaRequest, MedusaResponse } from "../../../../src/lib/http-types";

let pool: Pool;
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  const password = process.env.TEST_REPORT_DB_PASS;
  if (!password) throw new Error("An actual test report-reader credential is required");
  const url = new URL(target.connectionString);
  url.username = "snus_v19_report_reader";
  url.password = password;
  pool = new Pool({ connectionString: url.toString() });
  await assertSafeTestDatabaseSentinel(pool, target);
  vi.stubEnv("ORDER_CURSOR_CURRENT_KEY_ID", "creator-uat");
  vi.stubEnv("ORDER_CURSOR_CURRENT_KEY", randomBytes(32).toString("base64url"));
});
afterAll(async () => { vi.unstubAllEnvs(); await pool?.end(); await shutdownPlatformPool(); });

async function request(handler: (req: MedusaRequest, res: MedusaResponse) => Promise<void>, operatorId: string, role: string, query: Record<string, unknown> = {}, scope = { merchantId: "merchant_default", storeIds: ["store_default"] }) {
  let status = 200;
  let payload: unknown;
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  const res: MedusaResponse = {
    status(code) { status = code; return this; },
    json(body) { payload = body; }, send(body) { payload = body; }, setHeader() {},
  };
  await handler({ headers: {
    authorization: `Bearer ${signJwt({ operatorId, role, displayName: "Synthetic operator", organizationId: "org_default", sessionVersion: 1 })}`,
    "x-report-merchant-id": scope.merchantId, "x-report-store-ids": scope.storeIds.join(","),
  }, query: { from: date, to: date, ...query } }, res);
  return { status, payload };
}

describe("creator dashboard with the actual read-only report identity", () => {
  it.each(["", [""], { nested: "op_staff1" }, [123]])("rejects malformed creator query %j", async (creatorOperatorId) => {
    expect((await request(dashboard, "op_staff1", "staff", { creatorOperatorId })).status).toBe(400);
  });
  it("requires coupled platform report grants and rejects a mixed full/self report audience", async () => {
    const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
    const admin = new Pool({ connectionString: target.connectionString, max: 1 });
    await assertSafeTestDatabaseSentinel(admin, target);
    const id = `audience-${randomUUID()}`, merchant = `${id}-m`, a = `${id}-a`, b = `${id}-b`;
    const call = (stores: string[]) => request(dashboard, id, "owner", {}, { merchantId: merchant, storeIds: stores });
    try {
      await admin.query("INSERT INTO app.merchants(id,display_name,legacy_organization_id) VALUES($1,$1,$1)", [merchant]);
      await admin.query("INSERT INTO public.stock_location(id,name) VALUES($1,$1),($2,$2)", [a,b]);
      await admin.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id) VALUES($1,$3,$1,$1),($2,$3,$2,$2)", [a,b,merchant]);
      await admin.query(`INSERT INTO medusa.staff_users(operator_id,password_hash,display_name,role,organization_id,is_active)
        VALUES($1,'unused','Synthetic audience','owner','org_default',true)`, [id]);
      await admin.query("INSERT INTO app.operator_security_state(operator_id,session_version) VALUES($1,1)", [id]);
      await admin.query("INSERT INTO app.operator_memberships(operator_id,scope_type,role_key,granted_by) VALUES($1,'platform','platform_admin','synthetic')", [id]);
      expect((await call([a])).status).toBe(403);
      await admin.query(`INSERT INTO app.operator_explicit_permission_grants(operator_id,permission_id,scope_type,merchant_id,store_id,granted_by)
        VALUES($1,'reports:read','store',$2,$3,'synthetic')`, [id,merchant,a]);
      const platform = await call([a]);
      expect(platform.status, JSON.stringify(platform.payload)).toBe(200);
      expect(platform.payload).toMatchObject({ audience: "full" });
      expect((await call([b])).status).toBe(403);
      await admin.query("DELETE FROM app.operator_memberships WHERE operator_id=$1", [id]);
      await admin.query(`INSERT INTO app.operator_memberships(operator_id,scope_type,merchant_id,store_id,role_key,granted_by)
        VALUES($1,'store',$2,$3,'manager','synthetic'),($1,'store',$2,$4,'staff','synthetic')`, [id,merchant,a,b]);
      await admin.query(`INSERT INTO app.operator_explicit_permission_grants(operator_id,permission_id,scope_type,merchant_id,store_id,granted_by)
        VALUES($1,'reports:read','store',$2,$4,'synthetic'),($1,'dashboard:self:read','store',$2,$3,'synthetic')`, [id,merchant,a,b]);
      expect((await call([a])).payload).toMatchObject({ audience: "full" });
      expect((await call([b])).payload).toMatchObject({ audience: "self" });
      expect((await call([a,b])).status).toBe(403);
      expect((await request(legacyDashboard,id,"owner",{}, { merchantId: merchant, storeIds: [b] })).status).toBe(403);
    } finally {
      await admin.query("DELETE FROM app.operator_explicit_permission_grants WHERE operator_id=$1", [id]);
      await admin.query("DELETE FROM app.operator_memberships WHERE operator_id=$1", [id]);
      await admin.query("DELETE FROM app.operator_security_state WHERE operator_id=$1", [id]);
      await admin.query("DELETE FROM medusa.staff_users WHERE operator_id=$1", [id]);
      await admin.query("DELETE FROM app.stores WHERE merchant_id=$1", [merchant]);
      await admin.query("DELETE FROM app.merchants WHERE id=$1", [merchant]);
      await admin.query("DELETE FROM public.stock_location WHERE id=ANY($1::text[])", [[a,b]]);
      await admin.end();
    }
  });
  it("enforces self at the real route even when a staff token claims owner, rejects tampering and closes legacy aliases", async () => {
    const self = await request(dashboard, "op_staff1", "owner");
    expect(self.status).toBe(200);
    expect(self.payload).toMatchObject({ audience: "self", creatorSelection: { mode: "selected", creatorOperatorIds: ["op_staff1"] } });
    expect(JSON.stringify(self.payload)).not.toMatch(/cogs|profit|costCoverage|password|financial/i);
    const tampered = await request(dashboard, "op_staff1", "staff", { creatorOperatorId: ["op_staff1", "op_owner"] });
    expect(tampered.status).toBe(403);
    for (const alias of [legacyDashboard, adminLegacyDashboard, partialDashboard]) {
      expect((await request(alias, "op_staff1", "staff")).status).toBe(403);
    }
    const orderPage = await request(orders, "op_staff1", "staff");
    expect(orderPage.status).toBe(200);
    expect(orderPage.payload).toMatchObject({ schemaVersion: 4, creatorSelection: { mode: "all", creatorOperatorIds: [] } });
  });
  it.each([["op_owner", "owner"], ["op_manager", "manager"], ["op_accountant", "accountant"]])("keeps %s full dashboard authority without broadening order access", async (operatorId, role) => {
    const full = await request(dashboard, operatorId, role);
    expect(full.status).toBe(200);
    expect(full.payload).toMatchObject({ audience: "full", creatorSelection: { mode: "all", creatorOperatorIds: [] } });
    if (role === "accountant") expect((await request(orders, operatorId, role)).status).toBe(403);
  });
  it("reads names without access to credentials, and returns full/self projections", async () => {
    const client = await pool.connect();
    try {
      const rights = await client.query(`SELECT current_user AS role,
        current_setting('transaction_read_only') AS read_only,
        has_column_privilege(current_user,'medusa.staff_users','password_hash','SELECT') AS can_read_password`);
      expect(rights.rows[0]).toEqual({ role: "snus_v19_report_reader", read_only: "on", can_read_password: false });
      const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
      const request = {
        scope: { scopeKind: "report" as const, merchantId: "merchant_default", storeIds: ["store_default"] },
        range: { from: date, to: date }, statementTimeoutMs: 10000,
      };
      const full = await readCreatorSalesDashboardV2(client, { ...request, audience: "full", creatorSelection: { mode: "all", creatorOperatorIds: [] } });
      expect(full.financial).toBeDefined();
      expect(full.creatorOptions).toEqual(expect.arrayContaining([expect.objectContaining({ operatorId: "op_staff1", displayName: "Nhan Vien 1" })]));
      const self = await readCreatorSalesDashboardV2(client, { ...request, audience: "self", selfOperatorId: "op_staff1", creatorSelection: { mode: "selected", creatorOperatorIds: ["op_staff1"] } });
      expect(self.creatorOptions.map((option) => option.operatorId)).toEqual(["op_staff1"]);
      expect(self.financial).toBeUndefined();
      expect(JSON.stringify(self)).not.toMatch(/cogs|profit|costCoverage|password|financial/i);
      expect(self.operationalSnapshot.reportMerchantCatalog).toEqual(full.operationalSnapshot.reportMerchantCatalog);
      await expect(client.query("UPDATE app.stores SET display_name=display_name WHERE false")).rejects.toMatchObject({ code: "25006" });
    } finally { client.release(); }
  });
});
