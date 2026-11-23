import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectPlatformClient,
  shutdownPlatformPool,
  type PoolClient,
} from "../db/client";
import {
  assertSafeTestDatabaseSentinel,
  requireSafeTestDatabaseTarget,
} from "../db/test-database-target";
import { resolveScopeBootstrap } from "../services/access-service";
import {
  getPlatformMerchantDetail,
  getPlatformStoreDetail,
  listPlatformMerchants,
  listPlatformStores,
} from "../services/platform-admin-service";
import { recordAuditEntry } from "../repositories/audit-repository";
import { hashPassword, signJwt } from "../middleware/auth";
import { loginOperator } from "../services/auth-service";
import { resolveOrderHistoryScope, resolveDashboardHistoryScope } from "../services/historical-read-scope-service";
import { permissions, assertMutationScope } from "@medusa-snus/contracts";
import { GET as dashboardRoute } from "../../../../src/api/dashboard/route";
import { GET as creatorDashboardRoute } from "../../../../src/api/admin/dashboard/creator-sales-v2/route";
import { GET as orderExportRoute } from "../../../../src/api/admin/orders/export/route";
import { createCustomer } from "../services/customer-service";
import { createProductCategory } from "../services/product-category-service";
import { adjustStock, createPurchaseOrder } from "../services/inventory-service";
import { completeSale, updateOrder, cancelOrder, refundOrder, createOrderForClient, normalizeRemoteOrderInput } from "../services/order-service";
import { applyOrderCorrection } from "../services/order-correction-service";
import { createProduct } from "../services/product-management-service";
import { getStoreSettingsTarget, getStoreSettingsProfile, updateMerchantSettingsProfile, updateStoreSettingsProfile } from "../services/owner-settings-service";
import { updateStoreSettlementPolicy } from "../services/store-settlement-policy-service";
import { updateMerchantCheckoutPolicy } from "../services/merchant-checkout-policy-service";
import { createTeamOperator } from "../services/operator-team-service";
import { initiateNewSubscription } from "../services/subscription-billing-service";
import { createScanGoCheckoutToken, updateScanGoCart, redeemScanGoCartForStaff } from "../services/scan-go-service";
import { rejectTelegramSalesDraft } from "../services/telegram-sales-service";
import { GET as merchantDetailRoute } from "../../../../src/api/platform/admin/merchants/[merchantId]/route";
import { GET as storeDetailRoute } from "../../../../src/api/platform/admin/stores/[storeId]/route";
import { GET as merchantListRoute } from "../../../../src/api/platform/admin/merchants/route";
import { PATCH as storeSettingsPatchRoute } from "../../../../src/api/settings/stores/[storeId]/route";
import { GET as meRoute } from "../../../../src/api/me/route";
import { GET as ordersRoute } from "../../../../src/api/admin/orders/route";
import type {
  MedusaRequest,
  MedusaResponse,
} from "../../../../src/lib/http-types";

const runId = randomUUID(),
  merchantId = `merchant-status-read-${runId}`,
  storeId = `store-status-read-${runId}`;
const stockLocationId = `sloc-status-read-${runId}`;
const actor = (role: string) => ({
  operatorId: `${runId}:${role}`,
  role: "owner" as const,
  organizationId: `org-status-read-${runId}`,
});
let client: PoolClient;
beforeAll(async () => {
  client = await connectPlatformClient();
  await assertSafeTestDatabaseSentinel(
    client,
    requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL),
  );
  await client.query(
    `INSERT INTO app.merchants(id,display_name,legacy_organization_id,status,metadata)
    VALUES($1,'Suspended merchant read fixture',$2,'suspended','{"privateMcpMaterial":"UAT-PRIVATE-NOT-A-REAL-SECRET"}')`,
    [merchantId, actor("owner").organizationId],
  );
  await client.query(
    `INSERT INTO public.stock_location(id,name) VALUES($1,'Status read fixture')`,
    [stockLocationId],
  );
  await client.query(
    `INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,is_primary,status,metadata)
    VALUES($1,$2,'Active child of suspended merchant',$3,true,'active','{"privateMaterial":"UAT-PRIVATE-NOT-A-REAL-SECRET"}')`,
    [storeId, merchantId, stockLocationId],
  );
  const passwordHash = await hashPassword("UAT-only-history-login-2026!");
  for (const role of ["platform_admin", "platform_readonly", "owner"]) {
    const user = actor(role);
    await client.query(
      `INSERT INTO medusa.staff_users(operator_id,password_hash,display_name,role,organization_id,is_active)
      VALUES($1,$3,'Status read fixture','owner',$2,true)`,
      [user.operatorId, user.organizationId, passwordHash],
    );
    await client.query(
      `INSERT INTO app.operator_memberships(operator_id,scope_type,merchant_id,role_key,status,granted_by,valid_from)
      VALUES($1,$2,$3,$4,'active','UAT','2026-01-01T00:00:00Z')`,
      [
        user.operatorId,
        role === "owner" ? "merchant" : "platform",
        role === "owner" ? merchantId : null,
        role,
      ],
    );
  }
  await client.query(
    `INSERT INTO public.stock_location(id,name) VALUES($1,'Closed status read fixture')`,
    [`${stockLocationId}:closed`],
  );
  await client.query(
    `INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,is_primary,status)
    VALUES($1,$2,'Closed child store',$3,false,'closed')`,
    [`${storeId}:closed`, merchantId, `${stockLocationId}:closed`],
  );
  for (let index = 0; index < 25; index++)
    await recordAuditEntry(
      client,
      actor("platform_admin"),
      "platform.merchant.status_changed",
      "merchant",
      merchantId,
      {
        merchantId,
        before: {
          status: "active",
          privateMaterial: "UAT-PRIVATE-NOT-A-REAL-SECRET",
        },
        after: { status: "suspended" },
        reason: `UAT audit fixture ${index}`,
      },
    );
});
afterAll(async () => {
  client?.release();
  await shutdownPlatformPool();
});

async function requestRoute(
  role: string,
  handler: typeof merchantDetailRoute,
  query: Record<string, string> = {},
  scopeHeaders: Record<string, string> = {},
  requestBody: Record<string, unknown> = {},
) {
  const user = actor(role),
    token = signJwt({
      ...user,
      displayName: "Status read fixture",
      sessionVersion: 1,
      authState: "authenticated",
    });
  const req = {
    headers: { authorization: `Bearer ${token}`, ...scopeHeaders },
    params: { merchantId, storeId },
    query,
    body: requestBody,
  } as MedusaRequest;
  let status = 200,
    payload: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(body: unknown) {
      payload = body;
    },
    send(body: unknown) { payload = body; },
    setHeader() {},
  } as MedusaResponse;
  await handler(req, res);
  return { status, payload };
}

describe("platform administrative lifecycle reads stay separate from operating scope", () => {
  it.each([2_147_483_648, Number.MAX_SAFE_INTEGER])("reads safe lifecycle version %s through merchant/store lists and detail contracts without narrowing to int32", async version => {
    const scope = { scopeKind: "platform_read" as const, merchantIds: [merchantId], storeIds: [storeId] };
    await client.query("UPDATE app.merchants SET status_version=$2 WHERE id=$1", [merchantId, version]);
    await client.query("UPDATE app.stores SET status_version=$2 WHERE id=$1", [storeId, version]);
    try {
      expect((await listPlatformMerchants(scope, "all")).data).toMatchObject([{ merchantId, statusVersion: version }]);
      expect((await listPlatformStores(scope, merchantId, "all")).data).toMatchObject([{ storeId, statusVersion: version }]);
      expect((await getPlatformMerchantDetail(scope, merchantId)).data).toMatchObject({ merchantId, statusVersion: version });
      expect((await getPlatformStoreDetail(scope, storeId)).data).toMatchObject({ storeId, statusVersion: version });
      expect(await requestRoute("platform_admin", merchantDetailRoute)).toMatchObject({ status: 200,
        payload: { data: { merchantId, statusVersion: version } } });
      expect(await requestRoute("platform_admin", storeDetailRoute)).toMatchObject({ status: 200,
        payload: { data: { storeId, statusVersion: version } } });
    } finally {
      await client.query("UPDATE app.merchants SET status_version=1 WHERE id=$1", [merchantId]);
      await client.query("UPDATE app.stores SET status_version=1 WHERE id=$1", [storeId]);
    }
  });
  it.each(["platform_admin", "platform_readonly"])(
    "authorizes %s at the actual metadata HTTP route seam",
    async (role) => {
      const merchant = await requestRoute(role, merchantDetailRoute);
      expect(merchant.status).toBe(200);
      expect(merchant.payload).toMatchObject({
        data: {
          merchantId,
          status: "suspended",
          owners: [{ operatorId: actor("owner").operatorId }],
        },
      });
      const store = await requestRoute(role, storeDetailRoute);
      expect(store.status).toBe(200);
      expect(store.payload).toMatchObject({
        data: { storeId, effectiveStatus: "suspended" },
      });
      expect((await requestRoute(role, merchantDetailRoute, {}, {
        "x-merchant-id": merchantId, "x-store-id": storeId,
      })).status).toBe(200);
      expect(JSON.stringify({ merchant, store })).not.toMatch(
        /UAT-PRIVATE|privateMaterial|password_hash|secret_hash/,
      );
      const listed = await requestRoute(role, merchantListRoute, {
        status: "suspended",
      });
      expect(listed.status).toBe(200);
      expect(listed.payload).toMatchObject({
        data: expect.arrayContaining([
          expect.objectContaining({ merchantId, status: "suspended" }),
        ]),
      });
    },
  );
  it("rejects merchant-only and revoked platform membership at HTTP without returning metadata", async () => {
    const denied = await requestRoute("owner", merchantDetailRoute);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.payload)).not.toContain(
      "Suspended merchant read fixture",
    );
    const user = actor("platform_readonly");
    await client.query(
      `UPDATE app.operator_memberships SET status='revoked' WHERE operator_id=$1`,
      [user.operatorId],
    );
    try {
      const revoked = await requestRoute(
        "platform_readonly",
        merchantDetailRoute,
      );
      expect(revoked.status).toBe(403);
      expect(JSON.stringify(revoked.payload)).not.toContain(
        "Suspended merchant read fixture",
      );
    } finally {
      await client.query(
        `UPDATE app.operator_memberships SET status='active' WHERE operator_id=$1`,
        [user.operatorId],
      );
    }
  });
  it("checks operator suspension and invalidated sessions before returning lifecycle metadata", async () => {
    const user = actor("platform_admin");
    await requestRoute("platform_admin", merchantDetailRoute);
    await client.query(
      `UPDATE app.operator_security_state SET global_status='suspended' WHERE operator_id=$1`,
      [user.operatorId],
    );
    try {
      expect(
        await requestRoute("platform_admin", merchantDetailRoute),
      ).toMatchObject({
        status: 403,
        payload: { error: { code: "operator_suspended" } },
      });
    } finally {
      await client.query(
        `UPDATE app.operator_security_state SET global_status='active' WHERE operator_id=$1`,
        [user.operatorId],
      );
    }
    await client.query(
      `UPDATE app.operator_security_state SET session_version=2 WHERE operator_id=$1`,
      [user.operatorId],
    );
    try {
      expect(
        await requestRoute("platform_admin", merchantDetailRoute),
      ).toMatchObject({
        status: 401,
        payload: { error: { code: "session_invalidated" } },
      });
    } finally {
      await client.query(
        `UPDATE app.operator_security_state SET session_version=1 WHERE operator_id=$1`,
        [user.operatorId],
      );
    }
  });
  it.each(["platform_admin", "platform_readonly"])(
    "%s sees inactive entities but cannot select the active child for commerce",
    async (role) => {
      const bootstrap = await resolveScopeBootstrap(actor(role));
      expect(bootstrap.platformReadScope?.merchantIds).toContain(merchantId);
      expect(bootstrap.platformReadScope?.storeIds).toContain(storeId);
      expect(bootstrap.merchants.map((row) => row.id)).not.toContain(
        merchantId,
      );
      expect(bootstrap.stores.map((row) => row.id)).not.toContain(storeId);
      expect(
        bootstrap.reportOptions.some((row) => row.merchantId === merchantId),
      ).toBe(false);
      if (!bootstrap.platformReadScope)
        throw new Error("platform read scope required");
      const scope = {
        ...bootstrap.platformReadScope,
        merchantIds: [merchantId],
        storeIds: [storeId],
      };
      expect((await listPlatformMerchants(scope)).data).toEqual([]);
      expect((await listPlatformMerchants(scope, "all")).data).toEqual([
        expect.objectContaining({
          merchantId,
          status: "suspended",
          statusVersion: 1,
        }),
      ]);
      expect(
        (await listPlatformMerchants(scope, "suspended")).data,
      ).toHaveLength(1);
      expect((await listPlatformMerchants(scope, "closed")).data).toEqual([]);
      expect((await listPlatformStores(scope, merchantId)).data).toEqual([]);
      expect((await listPlatformStores(scope, merchantId, "all")).data).toEqual(
        [
          expect.objectContaining({
            storeId,
            status: "active",
            merchantStatus: "suspended",
            effectiveStatus: "suspended",
            statusVersion: 1,
          }),
        ],
      );
      const merchant = await getPlatformMerchantDetail(scope, merchantId),
        store = await getPlatformStoreDetail(scope, storeId);
      expect(merchant.data).toMatchObject({
        merchantId,
        status: "suspended",
        subscriptionStatus: "active",
      storeCount:2,
      ownerCount:1,
      });
      expect(store.data).toMatchObject({
        storeId,
        status: "active",
        merchantStatus: "suspended",
        effectiveStatus: "suspended",
      });
      expect(merchant.data.checkoutPolicy).toMatchObject({
        enabled: true,
        source: "default",
      });
      expect(merchant.data.owners).toEqual([
        expect.objectContaining({
          operatorId: actor("owner").operatorId,
          scopeType: "merchant",
        }),
      ]);
      expect(merchant.data.lifecycleAudit).toMatchObject({
        offset: 0,
        limit: 20,
        hasMore: true,
      });
      expect(merchant.data.lifecycleAudit.data).toHaveLength(20);
      const next = await getPlatformMerchantDetail(scope, merchantId, 20);
      expect(next.data.lifecycleAudit).toMatchObject({
        offset: 20,
        hasMore: false,
      });
      expect(next.data.lifecycleAudit.data).toHaveLength(5);
      expect(
        new Set(
          [
            ...merchant.data.lifecycleAudit.data,
            ...next.data.lifecycleAudit.data,
          ].map((row) => row.id),
        ).size,
      ).toBe(25);
      expect(JSON.stringify({ merchant, store })).not.toMatch(
        /privateMaterial|privateMcpMaterial|UAT-PRIVATE|password_hash|secret_hash/,
      );
    },
  );
  it("keeps closed child status distinct from a suspended parent in filters and detail", async () => {
    const bootstrap = await resolveScopeBootstrap(actor("platform_admin"));
    if (!bootstrap.platformReadScope)
      throw new Error("platform read scope required");
    const rows = await listPlatformStores(
      {
        ...bootstrap.platformReadScope,
        storeIds: [storeId, `${storeId}:closed`],
      },
      merchantId,
      "closed",
    );
    expect(rows.data).toEqual([
      expect.objectContaining({
        storeId: `${storeId}:closed`,
        status: "closed",
        merchantStatus: "suspended",
        effectiveStatus: "closed",
      }),
    ]);
    await expect(
      getPlatformMerchantDetail(bootstrap.platformReadScope, merchantId, -1),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      getPlatformStoreDetail(bootstrap.platformReadScope, storeId, 0.5),
    ).rejects.toMatchObject({ code: "validation_error" });
  });
  it("rejects invalid filters and out-of-scope detail IDs", async () => {
    const bootstrap = await resolveScopeBootstrap(actor("platform_admin"));
    if (!bootstrap.platformReadScope)
      throw new Error("platform read scope required");
    await expect(
      listPlatformMerchants(bootstrap.platformReadScope, "unexpected" as never),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      listPlatformStores(
        bootstrap.platformReadScope,
        merchantId,
        "unexpected" as never,
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
    const empty = {
      ...bootstrap.platformReadScope,
      merchantIds: [],
      storeIds: [],
    };
    await expect(
      getPlatformMerchantDetail(empty, merchantId),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(getPlatformStoreDetail(empty, storeId)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("keeps suspended owner history separate from operating and administrative authority", async () => {
    const bootstrap = await resolveScopeBootstrap(actor("owner"));
    expect(bootstrap.access.memberships).toEqual([]);
    expect(bootstrap.access.permissionIds).toEqual([]);
    expect(bootstrap.platformReadScope).toBeNull();
    expect(bootstrap.activeOperatingScope).toBeNull();
    expect(bootstrap.stores).toEqual([]);
    expect(bootstrap.reportOptions).toEqual([]);
    expect(bootstrap.historicalStores).toEqual([
      expect.objectContaining({ id: storeId, merchantId, merchantStatus: "suspended" }),
    ]);
  });
  it("serves the suspended owner's me and order history without advertising operating permissions", async () => {
    const scopeHeaders = { "x-merchant-id": merchantId, "x-store-id": storeId,
      "x-report-merchant-id": merchantId, "x-report-store-ids": storeId };
    expect(await requestRoute("owner", meRoute, {}, scopeHeaders)).toMatchObject({
      status: 200, payload: { stores: [], permissionIds: [],
        historicalPermissionIds: expect.arrayContaining(["orders:read"]),
        historicalStores: [expect.objectContaining({ storeId, merchantId })] },
    });
    expect((await requestRoute("owner", ordersRoute, {}, scopeHeaders)).status).toBe(200);
    expect((await requestRoute("owner", ordersRoute, {}, {
      ...scopeHeaders, "x-report-store-ids": `${storeId}:closed`,
    })).status).toBe(403);
  });
  it.each(["owner", "manager", "accountant"])("keeps %s history permissions without adding missing read or financial authority", async roleKey => {
    const owner = actor("owner");
    await client.query("UPDATE app.operator_memberships SET role_key=$2 WHERE operator_id=$1", [owner.operatorId, roleKey]);
    try {
      const login = await loginOperator({ operatorId: owner.operatorId, password: "UAT-only-history-login-2026!" });
      expect(login.data.token).toBeTruthy();
      const scopeHeaders = { "x-report-merchant-id": merchantId, "x-report-store-ids": storeId };
      const scope = await resolveDashboardHistoryScope(owner, scopeHeaders);
      expect(scope).toMatchObject({ audience: "full", scope: { scopeKind: "historical_read", merchantId, storeIds: [storeId] } });
      expect(() => assertMutationScope(scope.scope)).toThrow();
      expect((await requestRoute("owner", dashboardRoute, {}, scopeHeaders)).status).toBe(200);
      const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
      const dashboard = await requestRoute("owner", creatorDashboardRoute, { from: date, to: date }, scopeHeaders);
      expect(dashboard.status, JSON.stringify(dashboard.payload)).toBe(200);
      expect(dashboard.payload).toMatchObject({ audience: "full" });
      expect((await requestRoute("owner", orderExportRoute, {}, scopeHeaders)).status).toBe(200);
      expect((await requestRoute("owner", ordersRoute, {}, scopeHeaders)).status).toBe(roleKey === "accountant" ? 403 : 200);
      await expect(resolveOrderHistoryScope(owner, scopeHeaders, permissions.orderWrite)).rejects.toMatchObject({ code: "forbidden" });
      await expect(resolveOrderHistoryScope(owner, { ...scopeHeaders, "x-report-merchant-id": "foreign-merchant" }, permissions.ordersRead))
        .rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await client.query("UPDATE app.operator_memberships SET role_key='owner' WHERE operator_id=$1", [owner.operatorId]);
    }
  });
  it.each(["staff", "revoked", "expired", "future"])("does not open suspended history for %s membership", async invalid => {
    const owner = actor("owner");
    if (invalid === "staff") await client.query("UPDATE app.operator_memberships SET role_key='staff' WHERE operator_id=$1", [owner.operatorId]);
    if (invalid === "revoked") await client.query("UPDATE app.operator_memberships SET status='revoked' WHERE operator_id=$1", [owner.operatorId]);
    if (invalid === "expired") await client.query("UPDATE app.operator_memberships SET valid_to=now()-interval '1 minute' WHERE operator_id=$1", [owner.operatorId]);
    if (invalid === "future") await client.query("UPDATE app.operator_memberships SET valid_from=now()+interval '1 day' WHERE operator_id=$1", [owner.operatorId]);
    try {
      expect((await requestRoute("owner", meRoute)).status).toBe(403);
      expect((await requestRoute("owner", ordersRoute)).status).toBe(403);
    } finally {
      await client.query("UPDATE app.operator_memberships SET role_key='owner',status='active',valid_from='2026-01-01T00:00:00Z',valid_to=NULL WHERE operator_id=$1", [owner.operatorId]);
    }
  });
  it.each(["disabled", "suspended", "invalidated-session"])("denies every history route after %s", async invalid => {
    const owner = actor("owner");
    await requestRoute("owner", meRoute);
    if (invalid === "disabled") await client.query("UPDATE medusa.staff_users SET is_active=false WHERE operator_id=$1", [owner.operatorId]);
    if (invalid === "suspended") await client.query("UPDATE app.operator_security_state SET global_status='suspended' WHERE operator_id=$1", [owner.operatorId]);
    if (invalid === "invalidated-session") await client.query("UPDATE app.operator_security_state SET session_version=2 WHERE operator_id=$1", [owner.operatorId]);
    try {
      for (const handler of [meRoute, ordersRoute, dashboardRoute, orderExportRoute]) {
        const response = await requestRoute("owner", handler);
        expect(response.status).toBe(invalid === "suspended" ? 403 : 401);
        expect(JSON.stringify(response.payload)).not.toContain("Suspended merchant read fixture");
      }
    } finally {
      await client.query("UPDATE medusa.staff_users SET is_active=true WHERE operator_id=$1", [owner.operatorId]);
      await client.query("UPDATE app.operator_security_state SET global_status='active', session_version=1 WHERE operator_id=$1", [owner.operatorId]);
    }
  });
  it("rejects a direct customer writer with cached scope after merchant suspension before any business writes", async () => {
    await expect(createCustomer({ "idempotency-key": `${runId}:suspended-customer` },
      { phone: `UAT-${runId}`, first_name: "Suspended scope must not write" },
      { ...actor("owner"), displayName: "UAT owner" }, { scopeKind: "merchant_target", merchantId }))
      .rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
    expect((await client.query("SELECT count(*)::int AS count FROM public.customer WHERE merchant_id=$1", [merchantId])).rows[0].count).toBe(0);
  });
  it("rejects category, inventory and purchase-order writers before mutation under the suspended parent", async () => {
    const owner = { ...actor("owner"), displayName: "UAT owner" };
    const scope = { scopeKind: "operating" as const, merchantId, storeId, stockLocationId };
    const headers = { "idempotency-key": `${runId}:suspended-writes` };
    for (const write of [
      () => createProductCategory(headers, { name: "Suspended category" }, owner, { scopeKind: "merchant_target", merchantId }),
      () => adjustStock(headers, { inventoryItemId: "not-reached", adjustment: 1, reason: "UAT" }, owner, scope),
      () => createPurchaseOrder(headers, { supplierName: "UAT", items: [{ variantId: "not-reached", quantity: 1, unitCost: 100 }] }, owner, scope),
    ]) await expect(write()).rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
    expect((await client.query("SELECT count(*)::int AS count FROM inventory.purchase_orders WHERE merchant_id=$1", [merchantId])).rows[0].count).toBe(0);
    expect((await client.query("SELECT count(*)::int AS count FROM public.product_category WHERE merchant_id=$1", [merchantId])).rows[0].count).toBe(0);
  });
  it("checks lifecycle before replaying an ordinary writer's cached idempotency receipt", async () => {
    const owner = { ...actor("owner"), displayName: "UAT owner" };
    const scope = { scopeKind: "merchant_target" as const, merchantId };
    const headers = { "idempotency-key": `${runId}:cached-customer` };
    const body = { phone: `UAT-replay-${runId}`, first_name: "Lifecycle replay fixture" };
    await client.query("UPDATE app.merchants SET status='active' WHERE id=$1", [merchantId]);
    try {
      expect((await createCustomer(headers, body, owner, scope)).statusCode).toBe(201);
    } finally {
      await client.query("UPDATE app.merchants SET status='suspended' WHERE id=$1", [merchantId]);
    }
    await expect(createCustomer(headers, body, owner, scope)).rejects.toMatchObject({ code: "scope_suspended" });
    expect((await client.query("SELECT count(*)::int AS count FROM public.customer WHERE merchant_id=$1 AND phone=$2", [merchantId, body.phone])).rows[0].count).toBe(1);
  });
  it.each(["suspended", "closed"])("denies a %s store settings PATCH at the lifecycle guard without writing", async (status) => {
    await client.query("UPDATE app.merchants SET status='active' WHERE id=$1", [merchantId]);
    await client.query("UPDATE app.stores SET status=$2 WHERE id=$1", [storeId, status]);
    const snapshot = async () => (await client.query(`
      SELECT row_to_json(s) AS store,
        (SELECT count(*)::int FROM audit.events WHERE merchant_id=$2) AS audits
      FROM app.stores s WHERE id=$1`, [storeId, merchantId])).rows;
    const before = await snapshot();
    try {
      await expect(getStoreSettingsTarget(storeId)).resolves.toEqual({ storeId, merchantId });
      const result = await requestRoute("owner", storeSettingsPatchRoute, {}, {
        "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId,
        "x-scope-kind": "historical_read", "x-allow-suspended": "true",
      }, { publicName: "Forbidden rename", scopeKind: "historical_read", allowSuspended: true });
      expect(result).toMatchObject({ status: 403, payload: { error: { code: "scope_suspended" } } });
      await expect(getStoreSettingsProfile(storeId, { scopeKind: "merchant_target", merchantId }))
        .rejects.toMatchObject({ code: "resource_not_found", statusCode: 404 });
      await expect(getStoreSettingsTarget(`${storeId}-missing`))
        .rejects.toMatchObject({ code: "resource_not_found", statusCode: 404 });
      expect(await snapshot()).toEqual(before);
    } finally {
      await client.query("UPDATE app.merchants SET status='suspended' WHERE id=$1", [merchantId]);
      await client.query("UPDATE app.stores SET status='active' WHERE id=$1", [storeId]);
    }
  });
  it("fences ordinary financial, product and settings writers even with a cached scope", async () => {
    const owner = { ...actor("owner"), displayName: "UAT owner" };
    const scope = { scopeKind: "operating" as const, merchantId, storeId, stockLocationId };
    const merchantScope = { scopeKind: "merchant_target" as const, merchantId };
    const headers = { "idempotency-key": `${runId}:suspended-financial-settings` };
    for (const write of [
      () => completeSale(headers, { items: [], amountReceived: 0 }, owner, scope),
      () => updateOrder(headers, "not-reached", { notes: "UAT" }, owner, scope),
      () => cancelOrder(headers, "not-reached", { reason: "UAT lifecycle guard" }, owner, scope),
      () => refundOrder(headers, "not-reached", { amount: 1, method: "cash", reason: "UAT", confirmationToken: "not-reached" }, owner, scope),
      () => applyOrderCorrection(headers, "not-reached", { baseRevision: 0, reason: "UAT lifecycle guard", items: [] }, owner, scope),
      () => createProduct(headers, { title: "Suspended product", price: 100, costPrice: 1 }, owner, merchantScope, scope),
      () => updateMerchantSettingsProfile(merchantId, { publicName: "UAT" }, owner, merchantScope),
      () => updateStoreSettingsProfile(storeId, { publicName: "UAT" }, owner, merchantScope),
      () => updateStoreSettlementPolicy(storeId, { mode: "manual_confirmation", expectedVersion: 0 }, owner, merchantScope),
      () => updateMerchantCheckoutPolicy(merchantId, { enabled: true, expectedVersion: 0 }, owner),
      () => createTeamOperator(merchantId, { operatorId: "UAT_lifecycle_staff", displayName: "UAT staff", role: "staff" }, owner, merchantScope),
      () => initiateNewSubscription({ merchantId, targetPackageKey: "plus", requestedBy: owner.operatorId }),
      () => redeemScanGoCartForStaff({ tokenOrPayload: "not-reached" }, scope, owner),
      () => rejectTelegramSalesDraft(runId, { reason: "UAT lifecycle guard" }, owner, scope),
    ]) await expect(write()).rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
    expect((await client.query('SELECT count(*)::int AS count FROM public."order" WHERE merchant_id=$1', [merchantId])).rows[0].count).toBe(0);
    expect((await client.query("SELECT count(*)::int AS count FROM public.product WHERE merchant_id=$1", [merchantId])).rows[0].count).toBe(0);
  });
  it("combines authorized active/suspended history stores without making the inactive store operational", async () => {
    const owner = actor("owner");
    const activeId = `${storeId}:history-active`;
    await client.query("INSERT INTO public.stock_location(id,name) VALUES($1,'UAT mixed history')", [activeId]);
    await client.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,status) VALUES($1,$2,'UAT active history store',$1,'active')", [activeId, merchantId]);
    await client.query("UPDATE app.merchants SET status='active' WHERE id=$1", [merchantId]);
    await client.query("UPDATE app.stores SET status='suspended' WHERE id=$1", [storeId]);
    try {
      const bootstrap = await resolveScopeBootstrap(owner);
      expect(bootstrap.stores.map(store => store.id)).toEqual([activeId]);
      expect(bootstrap.historicalStores.map(store => store.id).sort()).toEqual([activeId, storeId].sort());
      const headers = { "x-report-merchant-id": merchantId, "x-report-store-ids": `${activeId},${storeId}` };
      expect(await resolveOrderHistoryScope(owner, headers, permissions.ordersRead)).toEqual({
        scopeKind: "historical_read", merchantId, storeIds: [activeId, storeId],
      });
      expect(await resolveDashboardHistoryScope(owner, headers)).toMatchObject({ audience: "full" });
      expect((await requestRoute("owner", ordersRoute, {}, headers)).status).toBe(200);
      await expect(resolveScopeBootstrap(owner, { "x-store-id": storeId, "x-merchant-id": merchantId }))
        .rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await client.query("UPDATE app.stores SET status='active' WHERE id=$1", [storeId]);
      await client.query("DELETE FROM app.stores WHERE id=$1", [activeId]);
      await client.query("DELETE FROM public.stock_location WHERE id=$1", [activeId]);
      await client.query("UPDATE app.merchants SET status='suspended' WHERE id=$1", [merchantId]);
    }
  });
  it("does not issue new Scan & Go tokens or edit an existing public cart after suspension", async () => {
    const cartId = `${runId}:suspended-public-cart`, editSecret = `UAT-only-${runId}`;
    await client.query(`INSERT INTO app.scan_go_carts(id,merchant_id,store_id,merchant_slug,store_slug,age_acknowledged_at,edit_secret_hash)
      VALUES($1,$2,$3,$2,$3,now(),$4)`, [cartId, merchantId, storeId, createHash("sha256").update(editSecret).digest("hex")]);
    for (const write of [() => createScanGoCheckoutToken(cartId, { editSecret }),
      () => updateScanGoCart(cartId, { editSecret, customerNickname: "Must not change" })]) {
      await expect(write()).rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
    }
    expect((await client.query("SELECT status,token_hash,customer_nickname FROM app.scan_go_carts WHERE id=$1", [cartId])).rows)
      .toEqual([{ status: "draft", token_hash: null, customer_nickname: null }]);
  });
  it("fences the exported direct order core before interpreting commerce input", async () => {
    await client.query("BEGIN");
    try {
      await expect(createOrderForClient(client, normalizeRemoteOrderInput({ items: [] }),
        { ...actor("owner"), displayName: "UAT owner" }, {
          source: "remote", salesChannelId: "sc_remote", orderStatus: "completed", merchantId, storeId, stockLocationId,
        })).rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
      expect((await client.query('SELECT count(*)::int AS count FROM public."order" WHERE merchant_id=$1', [merchantId])).rows[0].count).toBe(0);
    } finally { await client.query("ROLLBACK"); }
  });
  it("rejects a forged stock location even when the direct core merchant/store are active", async () => {
    await client.query("BEGIN");
    try {
      await client.query("UPDATE app.merchants SET status='active' WHERE id=$1", [merchantId]);
      await expect(createOrderForClient(client, normalizeRemoteOrderInput({ items: [] }),
        { ...actor("owner"), displayName: "UAT owner" }, {
          source: "remote", salesChannelId: "sc_remote", orderStatus: "completed", merchantId, storeId, stockLocationId: "foreign-location",
        })).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
      expect((await client.query('SELECT count(*)::int AS count FROM public."order" WHERE merchant_id=$1', [merchantId])).rows[0].count).toBe(0);
    } finally { await client.query("ROLLBACK"); }
  });
});
