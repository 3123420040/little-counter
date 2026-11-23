import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { permissions } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import { resolveRequestAccess } from "../services/access-service";
import { decideScopeCoupledAuthorization } from "../services/coupled-authorization-policy";
import { signJwt } from "../middleware/auth";
import { GET, POST } from "../../../../src/api/admin/customers/route";
import { GET as categoryList, POST as categoryCreate } from "../../../../src/api/platform/admin/product-categories/route";
import { GET as categoryDetail, PATCH as categoryUpdate, DELETE as categoryDelete } from "../../../../src/api/platform/admin/product-categories/[id]/route";
import { GET as productList } from "../../../../src/api/admin/products/route";
import { GET as productExport } from "../../../../src/api/platform/admin/products/export/route";
import { GET as categoryExport } from "../../../../src/api/platform/admin/product-categories/export/route";
import { GET as categoryTemplate } from "../../../../src/api/platform/admin/product-categories/import-template/route";


const ids = {
  operator: "v19_coupled_operator",
  merchant: "v19_coupled_merchant",
  storeA: "v19_coupled_store_a",
  storeB: "v19_coupled_store_b",
  locationA: "v19_coupled_location_a",
  locationB: "v19_coupled_location_b",
};

let client: PoolClient;
let categorySeedDescription: string | undefined;
let categorySeedRoles: string[] = [];

async function cleanup(): Promise<void> {
  await client.query("DELETE FROM app.operator_explicit_permission_grants WHERE operator_id=$1", [ids.operator]);
  await client.query("DELETE FROM public.product_category_product WHERE product_id IN (SELECT id FROM public.product WHERE merchant_id=$1)", [ids.merchant]);
  await client.query("DELETE FROM public.product WHERE merchant_id=$1", [ids.merchant]);
  await client.query("DELETE FROM public.product_category WHERE merchant_id = $1", [ids.merchant]);
  await client.query(
    "DELETE FROM ai_module.customer_profiles WHERE merchant_id = $1",
    [ids.merchant],
  );
  await client.query("DELETE FROM public.customer WHERE merchant_id = $1", [
    ids.merchant,
  ]);
  await client.query(
    "DELETE FROM app.operator_memberships WHERE operator_id = $1",
    [ids.operator],
  );
  await client.query(
    "DELETE FROM app.operator_security_state WHERE operator_id = $1",
    [ids.operator],
  );
  await client.query("DELETE FROM medusa.staff_users WHERE operator_id = $1", [
    ids.operator,
  ]);
  await client.query("DELETE FROM app.stores WHERE id = ANY($1::text[])", [
    [ids.storeA, ids.storeB],
  ]);
  await client.query("DELETE FROM outbox.aggregate_sequences WHERE merchant_id = $1", [ids.merchant]);
  await client.query("DELETE FROM app.merchants WHERE id = $1", [ids.merchant]);
  await client.query(
    "DELETE FROM public.stock_location WHERE id = ANY($1::text[])",
    [[ids.locationA, ids.locationB]],
  );
}

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await cleanup();
  categorySeedDescription = (await client.query("SELECT description FROM app.permissions WHERE id=$1", [permissions.categoryRead])).rows[0]?.description;
  categorySeedRoles = (await client.query("SELECT role FROM app.role_permissions WHERE permission_id=$1", [permissions.categoryRead])).rows.map(row => row.role);
  await client.query("DELETE FROM app.role_permissions WHERE permission_id=$1", [permissions.categoryRead]);
  await client.query("DELETE FROM app.permissions WHERE id=$1", [permissions.categoryRead]);
  await client.query(
    `
      INSERT INTO public.stock_location (id, name)
      VALUES ($1, 'v1.9 Coupled A'), ($2, 'v1.9 Coupled B')
    `,
    [ids.locationA, ids.locationB],
  );
  await client.query(
    `
      INSERT INTO app.merchants (id, display_name, legacy_organization_id, status)
      VALUES ($1, 'v1.9 Coupled Merchant', 'v19_coupled_org', 'active')
    `,
    [ids.merchant],
  );
  await client.query(
    `
      INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status)
      VALUES
        ($1, $3, 'Store A', $4, true, 'active'),
        ($2, $3, 'Store B', $5, false, 'active')
    `,
    [ids.storeA, ids.storeB, ids.merchant, ids.locationA, ids.locationB],
  );
  await client.query(`INSERT INTO public.product_category (id, name, handle, mpath, is_active, is_internal, rank, merchant_id)
    VALUES ('v22_category_active', 'Assigned active', 'v22-category-active', 'v22_category_active.', true, false, 1, $1),
           ('v22_category_hidden', 'Assigned hidden', 'v22-category-hidden', 'v22_category_hidden.', false, true, 2, $1)`, [ids.merchant]);
  await client.query(`INSERT INTO public.product (id, title, handle, status, merchant_id)
    VALUES ('v22_category_product', 'Assigned categorized', 'v22-category-product', 'published', $1),
           ('v22_uncategorized_product', 'Assigned uncategorized', 'v22-uncategorized-product', 'published', $1)`, [ids.merchant]);
  await client.query("INSERT INTO public.product_category_product (product_id,product_category_id) VALUES ('v22_category_product','v22_category_active')");
});

afterAll(async () => {
  if (client) {
    if (categorySeedDescription !== undefined) {
      await client.query("INSERT INTO app.permissions (id,description) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET description=EXCLUDED.description", [permissions.categoryRead,categorySeedDescription]);
      for (const role of categorySeedRoles) await client.query("INSERT INTO app.role_permissions (role,permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [role,permissions.categoryRead]);
    }
    await cleanup().catch(() => undefined);
    client.release();
  }
  await shutdownPlatformDb().catch(() => undefined);
});

describe("AUTH-08..10 scope-coupled PostgreSQL matrix", () => {
  it("keeps manager Store A and staff Store B permissions separate", async () => {
    await client.query(
      `
      INSERT INTO app.operator_memberships
        (operator_id, scope_type, merchant_id, store_id, role_key, status, valid_from, valid_to, granted_by)
      VALUES
        ($1, 'store', $2, $3, 'manager', 'active', now() - interval '1 day', NULL, 'v1.9-test'),
        ($1, 'store', $2, $4, 'staff', 'active', now() - interval '1 day', NULL, 'v1.9-test'),
        ($1, 'store', $2, $4, 'manager', 'revoked', now() - interval '1 day', NULL, 'v1.9-test'),
        ($1, 'store', $2, $4, 'manager', 'active', now() + interval '1 day', NULL, 'v1.9-test'),
        ($1, 'platform', NULL, NULL, 'platform_readonly', 'active', now() - interval '1 day', NULL, 'v1.9-test')
    `,
      [ids.operator, ids.merchant, ids.storeA, ids.storeB],
    );

    const beforeCount = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM app.operator_memberships WHERE operator_id = $1",
      [ids.operator],
    );
    const access = await resolveRequestAccess({
      operatorId: ids.operator,
      role: "manager",
      organizationId: "v19_coupled_org",
    });
    const managerA = access.memberships.find(
      (membership) => membership.storeId === ids.storeA,
    );
    const staffB = access.memberships.find(
      (membership) => membership.storeId === ids.storeB,
    );
    if (!managerA || !staffB)
      throw new Error("Expected coupled membership fixtures");

    expect(managerA.permissionIds).toContain(permissions.catalogWrite);
    expect(staffB.permissionIds).not.toContain(permissions.catalogWrite);
    expect(staffB.permissionIds).toContain(permissions.customerWrite);
    expect(
      access.memberships.filter(
        (membership) => membership.storeId === ids.storeB,
      ),
    ).toHaveLength(1);
    expect(
      decideScopeCoupledAuthorization(access, permissions.catalogWrite, {
        scopeType: "store",
        merchantId: ids.merchant,
        storeId: ids.storeA,
      }).allowed,
    ).toBe(true);
    expect(
      decideScopeCoupledAuthorization(access, permissions.catalogWrite, {
        scopeType: "store",
        merchantId: ids.merchant,
        storeId: ids.storeB,
      }).allowed,
    ).toBe(false);
    expect(
      decideScopeCoupledAuthorization(access, permissions.customerWrite, {
        scopeType: "store",
        merchantId: ids.merchant,
        storeId: ids.storeB,
      }).allowed,
    ).toBe(true);
    expect(
      decideScopeCoupledAuthorization(access, permissions.catalogWrite, {
        scopeType: "store",
        merchantId: "merchant_other",
        storeId: "store_other",
      }).allowed,
    ).toBe(false);
    const afterCount = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM app.operator_memberships WHERE operator_id = $1",
      [ids.operator],
    );
    expect(afterCount.rows[0]?.count).toBe(beforeCount.rows[0]?.count);
  });

  it.each(["staff", "manager", "accountant", "owner"] as const)(
    "allows %s customer list/create through the real route with store membership",
    async (role) => {
      await client.query(
        "DELETE FROM app.operator_memberships WHERE operator_id = $1",
        [ids.operator],
      );
      await client.query(
        `INSERT INTO app.operator_memberships (operator_id, scope_type, merchant_id, store_id, role_key, granted_by)
      VALUES ($1, 'store', $2, $3, $4, 'customer-access-test')`,
        [ids.operator, ids.merchant, ids.storeB, role],
      );
      await client.query(
        `INSERT INTO medusa.staff_users (operator_id, password_hash, display_name, role, organization_id)
      VALUES ($1, 'not-a-login-credential', 'Customer access test', $2, 'v19_coupled_org')
      ON CONFLICT (operator_id) DO UPDATE SET role = EXCLUDED.role`,
        [ids.operator, role],
      );
      const headers = {
        authorization: `Bearer ${signJwt({ operatorId: ids.operator, role, displayName: "Test", organizationId: "v19_coupled_org", sessionVersion: 1 })}`,
        "x-operating-merchant-id": ids.merchant,
        "x-operating-store-id": ids.storeB,
        "idempotency-key": `customer-access-${role}-${randomUUID()}`,
      };
      const req = {
        headers,
        body: { phone: `test-customer-access-${role}`, first_name: role },
        query: {},
        params: {},
      } as never;
      let status = 200;
      let body: Record<string, unknown> = {};
      const res = {
        status(code: number) {
          status = code;
          return this;
        },
        json(value: Record<string, unknown>) {
          body = value;
        },
      } as never;
      await POST(req, res);
      expect(status, JSON.stringify(body)).toBe(201);
      const customerId = (body.customer as { id: string }).id;
      const persisted = await client.query(
        "SELECT merchant_id FROM public.customer WHERE id = $1",
        [customerId],
      );
      expect(persisted.rows[0]?.merchant_id).toBe(ids.merchant);
      status = 200;
      await GET(req, res);
      expect(status).toBe(200);
      expect(body.customers).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: customerId })]),
      );
      await GET(
        {
          ...(req as object),
          headers: { ...headers, "x-merchant-id": "merchant_other" },
        } as never,
        res,
      );
      expect(status).toBe(403);
      await client.query(
        "DELETE FROM ai_module.customer_profiles WHERE customer_id = $1",
        [customerId],
      );
      await client.query("DELETE FROM public.customer WHERE id = $1", [
        customerId,
      ]);
    },
  );
  it.each(["staff", "manager", "accountant", "owner"] as const)(
    "allows %s category list/detail/count from store-only membership without widening catalog",
    async (role) => {
      await client.query("DELETE FROM app.operator_memberships WHERE operator_id=$1", [ids.operator]);
      await client.query(`INSERT INTO app.operator_memberships (operator_id, scope_type, merchant_id, store_id, role_key, granted_by)
        VALUES ($1, 'store', $2, $3, $4, 'category-read-test')`, [ids.operator, ids.merchant, ids.storeB, role]);
      await client.query(`INSERT INTO medusa.staff_users (operator_id, password_hash, display_name, role, organization_id)
        VALUES ($1, 'not-a-login-credential', 'Category read test', $2, 'v19_coupled_org')
        ON CONFLICT (operator_id) DO UPDATE SET role=EXCLUDED.role`, [ids.operator, role]);
      const headers = {
        authorization: `Bearer ${signJwt({ operatorId: ids.operator, role, displayName: "Test", organizationId: "v19_coupled_org", sessionVersion: 1 })}`,
        "x-operating-merchant-id": ids.merchant,
        "x-operating-store-id": ids.storeB,
      };
      const req = { headers, query: {}, params: { id: "v22_category_active" }, body: {} } as never;
      async function call(handler: typeof categoryList, request = req) {
        const result = { status: 200, body: {} as Record<string, unknown> };
        await handler(request, { status(code: number) { result.status = code; return this; }, json(body: Record<string, unknown>) { result.body = body; } } as never);
        return result;
      }
      const access = await resolveRequestAccess({ operatorId: ids.operator, role, organizationId: "v19_coupled_org" });
      expect(access.memberships[0]?.permissionIds).toContain(permissions.categoryRead);
      expect((await client.query("SELECT id FROM app.permissions WHERE id=$1", [permissions.categoryRead])).rowCount).toBe(0);
      const listed = await call(categoryList);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect(listed.body).toMatchObject({ count: 2, meta: { uncategorizedProductCount: 1 } });
      expect(listed.body.product_categories).toEqual([
        expect.objectContaining({ id: "v22_category_active", productCount: 1, isActive: true }),
        expect.objectContaining({ id: "v22_category_hidden", isActive: false, isInternal: true }),
      ]);
      expect(JSON.stringify(listed.body)).not.toMatch(/cost_price|costPrice|inventory_quantity/);
      const detail = await call(categoryDetail);
      expect(detail.status).toBe(200);
      expect(detail.body.product_category).toMatchObject({ id: "v22_category_active" });
      for (const status of ["active", "inactive"]) {
        const filtered = await call(categoryList, { ...(req as object), query: { status, includeProductCounts: "false", q: "Assigned" } } as never);
        expect(filtered.status).toBe(200);
        expect(filtered.body.count).toBe(1);
      }
      const page = await call(categoryList, { ...(req as object), query: { limit: "1", offset: "1" } } as never);
      expect(page.body.product_categories).toEqual([expect.objectContaining({ id: "v22_category_hidden" })]);
      expect((await call(categoryList, { ...(req as object), headers: { ...headers, "x-merchant-id": "merchant_default" } } as never)).status).toBe(403);
      expect((await call(categoryDetail, { ...(req as object), params: { id: "pcat_snus" } } as never)).status).toBe(403);
      for (const handler of [productList, productExport, categoryExport, categoryTemplate, categoryCreate, categoryUpdate, categoryDelete]) {
        expect((await call(handler)).status).toBe(403);
      }
    },
  );

  it("preserves merchant catalog grant readers and keeps platform/store grants isolated", async () => {
    await client.query("DELETE FROM app.operator_memberships WHERE operator_id=$1", [ids.operator]);
    await client.query(`INSERT INTO app.operator_memberships (operator_id, scope_type, role_key, granted_by)
      VALUES ($1, 'platform', 'platform_readonly', 'category-read-test')`, [ids.operator]);
    const headers = { authorization: `Bearer ${signJwt({ operatorId: ids.operator, role: "owner", displayName: "Test", organizationId: "v19_coupled_org", sessionVersion: 1 })}`, "x-merchant-id": ids.merchant };
    const req = { headers, query: {}, params: { id: "v22_category_active" } } as never;
    async function call(handler: typeof categoryList) {
      const result = { status: 200, body: {} as Record<string, unknown> };
      await handler(req, { status(code: number) { result.status=code;return this; }, json(body: Record<string, unknown>) { result.body=body; } } as never);
      return result;
    }
    try {
      expect((await call(categoryList)).status).toBe(403);
      await client.query(`INSERT INTO app.operator_explicit_permission_grants (operator_id, permission_id, scope_type, merchant_id, store_id, granted_by)
        VALUES ($1, 'catalog:read', 'store', $2, $3, 'category-read-test')`, [ids.operator, ids.merchant, ids.storeB]);
      expect((await call(categoryList)).status).toBe(403);
      await client.query("UPDATE app.operator_explicit_permission_grants SET scope_type='merchant',store_id=NULL WHERE operator_id=$1", [ids.operator]);
      expect((await call(categoryList)).status).toBe(200);
      expect((await call(categoryDetail)).status).toBe(200);
      expect((await call(categoryCreate)).status).toBe(403);
    } finally {
      await client.query("DELETE FROM app.operator_explicit_permission_grants WHERE operator_id=$1", [ids.operator]);
    }
  });

  it.each(["merchant", "store", "revoked", "expired", "future"])("denies %s-inactive category memberships through the real GET", async (invalid) => {
    await client.query("DELETE FROM app.operator_memberships WHERE operator_id=$1", [ids.operator]);
    await client.query(`INSERT INTO app.operator_memberships (operator_id,scope_type,merchant_id,store_id,role_key,granted_by)
      VALUES ($1,'store',$2,$3,'staff','category-read-test')`, [ids.operator,ids.merchant,ids.storeB]);
    const headers = { authorization: `Bearer ${signJwt({ operatorId:ids.operator,role:"owner",displayName:"Test",organizationId:"v19_coupled_org",sessionVersion:1 })}`, "x-merchant-id":ids.merchant };
    let status=200;
    try {
      if (invalid === "merchant") await client.query("UPDATE app.merchants SET status='suspended' WHERE id=$1", [ids.merchant]);
      if (invalid === "store") await client.query("UPDATE app.stores SET status='closed' WHERE id=$1", [ids.storeB]);
      if (invalid === "revoked") await client.query("UPDATE app.operator_memberships SET status='revoked' WHERE operator_id=$1", [ids.operator]);
      if (invalid === "expired") await client.query("UPDATE app.operator_memberships SET valid_to=now()-interval '1 minute' WHERE operator_id=$1", [ids.operator]);
      if (invalid === "future") await client.query("UPDATE app.operator_memberships SET valid_from=now()+interval '1 day' WHERE operator_id=$1", [ids.operator]);
      await categoryList({headers,query:{},params:{}} as never, {status(code:number){status=code;return this;},json(){}} as never);
      expect(status).toBe(403);
    } finally {
      await client.query("UPDATE app.merchants SET status='active' WHERE id=$1", [ids.merchant]);
      await client.query("UPDATE app.stores SET status='active' WHERE id=$1", [ids.storeB]);
    }
  });

});
