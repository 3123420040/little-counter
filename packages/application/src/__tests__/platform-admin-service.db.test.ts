import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { permissions, type PlatformReadScope } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import {
  createPlatformStore,
  getPlatformMerchantDetail,
  getPlatformStoreDetail,
  grantPlatformMembership,
  listPlatformAudit,
  listPlatformBillingOrders,
  listPlatformIntegrations,
  listPlatformMemberships,
  listPlatformMerchants,
  listPlatformPaymentExceptions,
  listPlatformSignupIdentities,
  listPlatformStores,
  mutatePlatformIntegrationConfig,
  revokePlatformMembership,
} from "../services/platform-admin-service";
import { resolveRequestAccess } from "../services/access-service";

const migrationsDir = resolve(__dirname, "../../../../db/migrations");
const migration001 = readFileSync(resolve(migrationsDir, "001_custom_schemas.sql"), "utf8");
const migration002 = readFileSync(resolve(migrationsDir, "002_tenant_foundation_expand.sql"), "utf8");
const migration006 = readFileSync(resolve(migrationsDir, "006_signup_identity_and_verification.sql"), "utf8");
const migration008 = readFileSync(resolve(migrationsDir, "008_platform_package_billing.sql"), "utf8");
const migration012 = readFileSync(resolve(migrationsDir, "012_platform_admin_integration_configs.sql"), "utf8");

const merchantA = "merchant_platform_a";
const merchantB = "merchant_platform_b";
const storeA = "store_platform_a";
const storeB = "store_platform_b";
const stockA = "sloc_platform_a";
const stockB = "sloc_platform_b";
const managedOperatorId = "op_platform_managed_member";
const billingOrderId = "bill_platform_manual_review";
const paymentIntentId = "pi_platform_manual_review";
const signupIdentityId = "signup_platform_pending";
const actor = { operatorId: "op_platform_config", role: "owner" as const, organizationId: "org_platform" };
const readOnlyActor = { operatorId: "op_platform_config_readonly", role: "staff" as const, organizationId: "org_platform" };
const scope: PlatformReadScope = {
  scopeKind: "platform_read",
  merchantIds: [merchantA, merchantB],
  storeIds: [storeA, storeB],
};

let client: PoolClient;

function writeOnlyTestValue(): string {
  return randomBytes(24).toString("base64url");
}

async function cleanup() {
  await client.query("DELETE FROM audit.events WHERE actor_id = $1", [actor.operatorId]).catch(() => undefined);
  await client.query("DELETE FROM app.integration_configs WHERE merchant_id IN ($1, $2) OR scope_type = 'platform'", [merchantA, merchantB]).catch(() => undefined);
  await client.query("DELETE FROM app.operator_memberships WHERE operator_id IN ($1, $2, $3, $4)", [actor.operatorId, readOnlyActor.operatorId, "op_merchant_owner_only", managedOperatorId]).catch(() => undefined);
  await client.query("DELETE FROM app.billing_provider_events WHERE billing_order_id = $1", [billingOrderId]).catch(() => undefined);
  await client.query("DELETE FROM app.billing_orders WHERE id = $1", [billingOrderId]).catch(() => undefined);
  await client.query("DELETE FROM app.payment_provider_events WHERE payment_intent_id = $1", [paymentIntentId]).catch(() => undefined);
  await client.query("DELETE FROM app.payment_intents WHERE id = $1", [paymentIntentId]).catch(() => undefined);
  await client.query("DELETE FROM app.signup_verification_tokens WHERE request_id = $1", [signupIdentityId]).catch(() => undefined);
  await client.query("DELETE FROM app.signup_requests WHERE id = $1", [signupIdentityId]).catch(() => undefined);
  await client.query("DELETE FROM app.stores WHERE id IN ($1, $2)", [storeA, storeB]).catch(() => undefined);
  const generatedStores = await client.query<{ id: string; stock_location_id: string }>(`
    SELECT id, stock_location_id FROM app.stores
    WHERE display_name IN ('Platform Managed Store', 'Concurrent Managed Store')
  `).catch(() => ({ rows: [] }));
  for (const store of generatedStores.rows) {
    await client.query("DELETE FROM app.stores WHERE id = $1", [store.id]).catch(() => undefined);
    await client.query("DELETE FROM public.stock_location WHERE id = $1", [store.stock_location_id]).catch(() => undefined);
  }
  await client.query("DELETE FROM app.merchants WHERE id IN ($1, $2)", [merchantA, merchantB]).catch(() => undefined);
  await client.query("DELETE FROM public.stock_location WHERE id IN ($1, $2)", [stockA, stockB]).catch(() => undefined);
  await client.query("DELETE FROM medusa.staff_users WHERE operator_id = $1", [managedOperatorId]).catch(() => undefined);
}

async function seed() {
  await client.query(`
    INSERT INTO medusa.staff_users (operator_id, password_hash, display_name, role, organization_id, is_active)
    VALUES ($1, 'test-only-hash', 'Managed Member', 'staff', 'org_platform_a', true)
    ON CONFLICT (operator_id) DO UPDATE SET display_name = EXCLUDED.display_name, is_active = true
  `, [managedOperatorId]);
  await client.query("INSERT INTO public.stock_location (id, name) VALUES ($1, 'Platform A'), ($2, 'Platform B') ON CONFLICT (id) DO NOTHING", [stockA, stockB]);
  await client.query(`
    INSERT INTO app.merchants (id, display_name, legacy_organization_id, status)
    VALUES ($1, 'Platform Merchant A', 'org_platform_a', 'active'), ($2, 'Platform Merchant B', 'org_platform_b', 'active')
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, status = 'active'
  `, [merchantA, merchantB]);
  await client.query(`
    INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status)
    VALUES ($1, $2, 'Platform Store A', $3, true, 'active'), ($4, $5, 'Platform Store B', $6, true, 'active')
    ON CONFLICT (id) DO UPDATE SET merchant_id = EXCLUDED.merchant_id, status = 'active'
  `, [storeA, merchantA, stockA, storeB, merchantB, stockB]);
  await client.query(`
    INSERT INTO app.operator_memberships (operator_id, scope_type, merchant_id, role_key, status, granted_by)
    VALUES
      ($1, 'platform', NULL, 'platform_admin', 'active', 'test'),
      ($2, 'platform', NULL, 'platform_readonly', 'active', 'test'),
      ($3, 'merchant', $4, 'owner', 'active', 'test')
  `, [actor.operatorId, readOnlyActor.operatorId, "op_merchant_owner_only", merchantA]);
  const catalog = await client.query<{ id: string }>(`
    SELECT id FROM app.package_catalog_versions WHERE package_key = 'plus' ORDER BY effective_from DESC LIMIT 1
  `);
  await client.query(`
    INSERT INTO app.billing_orders (
      id, merchant_id, purpose, target_package_key, catalog_version_id,
      period_start, period_end, amount_vnd, status, manual_review_reason,
      quote_expires_at, idempotency_key
    )
    VALUES ($1, $2, 'renewal', 'plus', $3, now(), now() + interval '1 year', 1200000,
            'manual_review', 'billing_amount_mismatch', now() + interval '1 hour', 'platform-test-billing')
    ON CONFLICT (id) DO NOTHING
  `, [billingOrderId, merchantA, catalog.rows[0]!.id]);
  await client.query(`
    INSERT INTO app.payment_intents (
      id, merchant_id, store_id, provider, status, amount, currency_code,
      order_input, reference_code, expires_at, manual_review_reason, created_by
    )
    VALUES ($1, $2, $3, 'sepay_va', 'manual_review', 250000, 'vnd', '{}'::jsonb,
            'PLATFORM-REVIEW-1', now() + interval '1 hour', 'retail_reference_mismatch', $4)
    ON CONFLICT (id) DO NOTHING
  `, [paymentIntentId, merchantA, storeA, actor.operatorId]);
  await client.query(`
    INSERT INTO app.signup_requests (id, normalized_email, email_hash, password_hash, status)
    VALUES ($1, 'pending-platform@example.test', 'email-hash-platform', 'password-hash-platform', 'pending')
    ON CONFLICT (id) DO NOTHING
  `, [signupIdentityId]);
  await client.query(`
    INSERT INTO app.signup_verification_tokens (request_id, token_hash, purpose, attempts_remaining, expires_at)
    VALUES ($1, 'verification-token-hash-platform', 'email_verification', 3, now() + interval '1 hour')
    ON CONFLICT (token_hash) DO UPDATE
      SET request_id = EXCLUDED.request_id,
          purpose = EXCLUDED.purpose,
          attempts_remaining = EXCLUDED.attempts_remaining,
          expires_at = EXCLUDED.expires_at,
          consumed_at = NULL,
          created_at = now()
  `, [signupIdentityId]);
}

beforeAll(async () => {
  client = await connectPlatformClient();
  await client.query(migration001);
  await ensurePlatformSchema();
  await client.query(migration002);
  await client.query(migration006);
  await client.query(migration008);
  await client.query(migration012);
  await cleanup();
  await seed();
}, 30000);

afterAll(async () => {
  if (client) {
    await cleanup();
    client.release();
  }
  await shutdownPlatformDb().catch(() => undefined);
});

describe("platform integration config persistence", () => {
  it("returns scoped merchant/store list and detail read models", async () => {
    const merchants = await listPlatformMerchants(scope);
    expect(merchants.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ merchantId: merchantA, displayName: "Platform Merchant A", storeCount: 1 }),
      expect.objectContaining({ merchantId: merchantB, displayName: "Platform Merchant B", storeCount: 1 }),
    ]));
    await expect(getPlatformMerchantDetail(scope, merchantA)).resolves.toMatchObject({ data: { merchantId: merchantA } });

    const stores = await listPlatformStores(scope, merchantA);
    expect(stores.data).toEqual([expect.objectContaining({ storeId: storeA, merchantId: merchantA })]);
    await expect(getPlatformStoreDetail(scope, storeA)).resolves.toMatchObject({ data: { storeId: storeA } });

    const scopeA = { ...scope, merchantIds: [merchantA], storeIds: [storeA] };
    await expect(getPlatformMerchantDetail(scopeA, merchantB)).rejects.toMatchObject({ code: "forbidden" });
    await expect(getPlatformStoreDetail(scopeA, storeB)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("returns billing, payment exception, signup identity, and sanitized audit read models", async () => {
    const billing = await listPlatformBillingOrders(scope);
    expect(billing.data.find((item) => item.billingOrderId === billingOrderId)).toMatchObject({
      merchantId: merchantA,
      amountVnd: "1200000",
      status: "manual_review",
    });

    const exceptions = await listPlatformPaymentExceptions(scope);
    expect(exceptions.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ exceptionId: `billing:${billingOrderId}`, issue: "billing_amount_mismatch" }),
      expect.objectContaining({ exceptionId: `payment:${paymentIntentId}`, issue: "retail_reference_mismatch" }),
    ]));

    const identities = await listPlatformSignupIdentities(scope);
    expect(identities.data.find((item) => item.identityId === signupIdentityId)).toMatchObject({
      email: "pending-platform@example.test",
      status: "pending_verification",
    });

    await mutatePlatformIntegrationConfig({
      action: "set",
      providerKey: "nowpayments",
      purpose: "merchant_retail",
      scope: "merchant",
      merchantId: merchantA,
      secret: writeOnlyTestValue(),
    }, actor);
    const audit = await listPlatformAudit(scope);
    expect(audit.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: actor.operatorId, action: "platform.integration_config.set" }),
    ]));
    expect(JSON.stringify(audit)).not.toContain("audit-read-secret");
  });

  it("keeps platform membership and merchant ownership permission sets separate", async () => {
    const platformAccess = await resolveRequestAccess(actor);
    expect(platformAccess.isPlatformAdmin).toBe(true);
    expect(platformAccess.permissionIds).toEqual(expect.arrayContaining([
      permissions.platformRead,
      permissions.platformWrite,
      permissions.integrationConfigRead,
      permissions.integrationConfigWrite,
    ]));
    expect(platformAccess.permissionIds).not.toContain(permissions.orderWrite);
    expect(platformAccess.permissionIds).not.toContain(permissions.accountingWrite);

    const readOnlyAccess = await resolveRequestAccess(readOnlyActor);
    expect(readOnlyAccess.isPlatformAdmin).toBe(true);
    expect(readOnlyAccess.permissionIds).toContain(permissions.platformRead);
    expect(readOnlyAccess.permissionIds).toContain(permissions.integrationConfigRead);
    expect(readOnlyAccess.permissionIds).not.toContain(permissions.platformWrite);
    expect(readOnlyAccess.permissionIds).not.toContain(permissions.integrationConfigWrite);

    const merchantOwnerAccess = await resolveRequestAccess({
      operatorId: "op_merchant_owner_only",
      role: "owner",
      organizationId: "org_platform_a",
    });
    expect(merchantOwnerAccess.isPlatformAdmin).toBe(false);
    expect(merchantOwnerAccess.permissionIds).not.toContain(permissions.platformRead);
  });

  it("creates a store and its stock location atomically with audit evidence", async () => {
    const result = await createPlatformStore({
      merchantId: merchantA,
      displayName: "Platform Managed Store",
      stockLocationName: "Platform Managed Stock",
      isPrimary: false,
    }, actor);

    const persisted = await client.query<{
      merchant_id: string;
      display_name: string;
      stock_location_id: string;
      stock_location_name: string;
      is_primary: boolean;
    }>(`
      SELECT s.merchant_id, s.display_name, s.stock_location_id, sl.name AS stock_location_name, s.is_primary
      FROM app.stores s
      JOIN public.stock_location sl ON sl.id = s.stock_location_id
      WHERE s.id = $1
    `, [result.data.storeId]);
    expect(persisted.rows[0]).toEqual({
      merchant_id: merchantA,
      display_name: "Platform Managed Store",
      stock_location_id: result.data.stockLocationId,
      stock_location_name: "Platform Managed Stock",
      is_primary: false,
    });
    const audit = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM audit.events
      WHERE actor_id = $1 AND action = 'platform.store.created' AND subject_id = $2
    `, [actor.operatorId, result.data.storeId]);
    expect(audit.rows[0]?.count).toBe("1");
  });

  it("serializes concurrent same-name store creation into distinct store and stock-location ids", async () => {
    const input = {
      merchantId: merchantA,
      displayName: "Concurrent Managed Store",
      stockLocationName: "Concurrent Managed Stock",
      isPrimary: false,
    };
    const [first, second] = await Promise.all([
      createPlatformStore(input, actor),
      createPlatformStore(input, actor),
    ]);

    expect(first.data.storeId).not.toBe(second.data.storeId);
    expect(first.data.stockLocationId).not.toBe(second.data.stockLocationId);
    const rows = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM app.stores s
      JOIN public.stock_location sl ON sl.id = s.stock_location_id
      WHERE s.id = ANY($1::text[]) AND s.merchant_id = $2
    `, [[first.data.storeId, second.data.storeId], merchantA]);
    expect(rows.rows[0]?.count).toBe("2");
  });

  it("grants, lists, validates, and revokes scoped memberships without hard-delete", async () => {
    const granted = await grantPlatformMembership({
      operatorId: managedOperatorId,
      scopeType: "store",
      merchantId: merchantA,
      storeId: storeA,
      roleKey: "manager",
    }, actor);
    expect(granted.data).toMatchObject({
      operatorId: managedOperatorId,
      scopeType: "store",
      merchantId: merchantA,
      storeId: storeA,
      roleKey: "manager",
      status: "active",
    });
    const listed = await listPlatformMemberships(scope);
    expect(listed.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ membershipId: granted.data.membershipId, displayName: "Managed Member" }),
    ]));

    await expect(grantPlatformMembership({
      operatorId: managedOperatorId,
      scopeType: "store",
      merchantId: merchantA,
      storeId: storeB,
      roleKey: "staff",
    }, actor)).rejects.toMatchObject({ code: "forbidden" });

    const revokeReason = "Store responsibility transferred";
    await expect(revokePlatformMembership(granted.data.membershipId, actor, { reason: revokeReason })).resolves.toEqual({
      data: { membershipId: granted.data.membershipId, status: "revoked" },
    });
    const row = await client.query<{ status: string; valid_to: Date | null }>(
      "SELECT status, valid_to FROM app.operator_memberships WHERE id = $1::uuid",
      [granted.data.membershipId],
    );
    expect(row.rows[0]?.status).toBe("revoked");
    expect(row.rows[0]?.valid_to).toBeInstanceOf(Date);
    const audit = await client.query<{ reason: string | null }>(`
      SELECT reason FROM audit.events
      WHERE action = 'platform.membership.revoked' AND subject_id = $1
      ORDER BY created_at DESC LIMIT 1
    `, [granted.data.membershipId]);
    expect(audit.rows[0]?.reason).toBe(revokeReason);
  });

  it("requires a bounded revoke reason before any membership mutation", async () => {
    const granted = await grantPlatformMembership({
      operatorId: managedOperatorId,
      scopeType: "merchant",
      merchantId: merchantB,
      roleKey: "staff",
    }, actor);

    await expect(revokePlatformMembership(granted.data.membershipId, actor, { reason: " " }))
      .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    await expect(revokePlatformMembership(granted.data.membershipId, actor, { reason: "x".repeat(501) }))
      .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });

    const row = await client.query<{ status: string }>(
      "SELECT status FROM app.operator_memberships WHERE id = $1::uuid",
      [granted.data.membershipId],
    );
    expect(row.rows[0]?.status).toBe("active");
  });

  it("refuses to revoke the final active platform admin", async () => {
    const adminMembership = await client.query<{ id: string }>(`
      SELECT id::text FROM app.operator_memberships
      WHERE operator_id = $1 AND scope_type = 'platform' AND role_key = 'platform_admin' AND status = 'active'
    `, [actor.operatorId]);
    const otherAdmins = await client.query<{ id: string }>(`
      SELECT id::text FROM app.operator_memberships
      WHERE scope_type = 'platform' AND role_key = 'platform_admin' AND status = 'active'
        AND id <> $1::uuid
    `, [adminMembership.rows[0]!.id]);
    const otherAdminIds = otherAdmins.rows.map((row) => row.id);
    if (otherAdminIds.length) {
      await client.query("UPDATE app.operator_memberships SET status = 'disabled' WHERE id = ANY($1::uuid[])", [otherAdminIds]);
    }
    try {
      const scheduledAdmin = await grantPlatformMembership({
        operatorId: managedOperatorId,
        scopeType: "platform",
        roleKey: "platform_admin",
        validFrom: "2100-01-01T00:00:00.000Z",
      }, actor);
      await expect(revokePlatformMembership(adminMembership.rows[0]!.id, actor, {
        reason: "Attempt final administrator revoke",
      })).rejects.toMatchObject({
        code: "last_platform_admin",
      });
      await client.query("UPDATE app.operator_memberships SET status = 'revoked', valid_to = now() WHERE id = $1::uuid", [scheduledAdmin.data.membershipId]);
    } finally {
      if (otherAdminIds.length) {
        await client.query("UPDATE app.operator_memberships SET status = 'active' WHERE id = ANY($1::uuid[])", [otherAdminIds]);
      }
    }
  });

  it("rejects a malformed membership id before issuing a UUID query", async () => {
    await expect(revokePlatformMembership("not-a-uuid", actor, { reason: "Malformed identifier check" })).rejects.toMatchObject({
      code: "validation_error",
      statusCode: 400,
    });
  });

  it("accepts a write-only secret without returning it or storing it in plaintext", async () => {
    const rawSecret = writeOnlyTestValue();
    const result = await mutatePlatformIntegrationConfig({
      action: "set",
      providerKey: "nowpayments",
      purpose: "merchant_retail",
      scope: "merchant",
      merchantId: merchantA,
      secret: rawSecret,
    }, actor);

    expect(result.data).toMatchObject({ status: "active" });

    const listed = await listPlatformIntegrations(scope);
    const config = listed.data.find((item) => item.configId === result.data.configId);
    expect(config).toMatchObject({
      providerKey: "nowpayments",
      purpose: "merchant_retail",
      scope: "merchant",
      merchantId: merchantA,
      hasSecret: true,
      status: "active",
    });
    const serializedList = JSON.stringify(listed);
    expect(serializedList.includes(rawSecret)).toBe(false);
    expect(serializedList.includes(rawSecret.slice(-6))).toBe(false);

    const stored = await client.query<{
      has_digest: boolean;
      digest_shape_valid: boolean;
      equals_raw_value: boolean;
      suffix_matches: boolean;
    }>(`
      SELECT secret_digest IS NOT NULL AS has_digest,
             secret_digest ~ '^[a-f0-9]{64}$' AS digest_shape_valid,
             secret_digest = $2 AS equals_raw_value,
             right(secret_digest, 6) = right($2, 6) AS suffix_matches
      FROM app.integration_configs
      WHERE id = $1
    `, [result.data.configId, rawSecret]);
    expect(stored.rows[0]).toEqual({
      has_digest: true,
      digest_shape_valid: true,
      equals_raw_value: false,
      suffix_matches: false,
    });

    const audit = await client.query<{ after: Record<string, unknown> }>(`
      SELECT after FROM audit.events WHERE actor_id = $1 AND action = 'platform.integration_config.set'
    `, [actor.operatorId]);
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.rows).includes(rawSecret)).toBe(false);
  });

  it("rotates an existing secret and exposes only rotation metadata", async () => {
    const rotatedSecret = writeOnlyTestValue();
    const result = await mutatePlatformIntegrationConfig({
      action: "rotate",
      providerKey: "nowpayments",
      purpose: "merchant_retail",
      scope: "merchant",
      merchantId: merchantA,
      secret: rotatedSecret,
    }, actor);

    const row = await client.query<{ last_rotated_at: Date | null }>(`
      SELECT last_rotated_at FROM app.integration_configs WHERE id = $1
    `, [result.data.configId]);
    expect(row.rows[0]?.last_rotated_at).toBeInstanceOf(Date);

    const listed = await listPlatformIntegrations(scope);
    expect(listed.data.find((item) => item.configId === result.data.configId)).toMatchObject({
      hasSecret: true,
      lastRotatedAt: expect.any(String),
    });
    const serializedList = JSON.stringify(listed);
    expect(serializedList.includes(rotatedSecret)).toBe(false);
    expect(serializedList.includes(rotatedSecret.slice(-6))).toBe(false);
  });

  it("rejects replace when the target config does not already exist", async () => {
    await expect(mutatePlatformIntegrationConfig({
      action: "replace",
      providerKey: "mock",
      purpose: "merchant_retail",
      scope: "merchant",
      merchantId: merchantB,
      secret: writeOnlyTestValue(),
    }, actor)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects a store whose merchant target does not match before mutation", async () => {
    const before = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM app.integration_configs");

    await expect(mutatePlatformIntegrationConfig({
      action: "set",
      providerKey: "sepay_va",
      purpose: "merchant_retail",
      scope: "store",
      merchantId: merchantA,
      storeId: storeB,
      secret: writeOnlyTestValue(),
    }, actor)).rejects.toMatchObject({ code: "forbidden" });

    const after = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM app.integration_configs");
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("serializes concurrent Set retries onto one canonical target row", async () => {
    const input = {
      action: "set" as const,
      providerKey: "sepay_va",
      purpose: "merchant_retail",
      scope: "merchant",
      merchantId: merchantB,
      secret: writeOnlyTestValue(),
    };
    const [first, second] = await Promise.all([
      mutatePlatformIntegrationConfig(input, actor),
      mutatePlatformIntegrationConfig(input, actor),
    ]);

    expect(first.data.configId).toBe(second.data.configId);
    const rows = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM app.integration_configs
      WHERE provider_key = 'sepay_va' AND purpose = 'merchant_retail'
        AND scope_type = 'merchant' AND merchant_id = $1
    `, [merchantB]);
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("normalizes the existing platform subscription purpose and disables without returning secret evidence", async () => {
    const created = await mutatePlatformIntegrationConfig({
      action: "set",
      providerKey: "nowpayments",
      purpose: "platform_subscription",
      scope: "platform",
      secret: writeOnlyTestValue(),
    }, actor);
    const disabled = await mutatePlatformIntegrationConfig({
      action: "disable",
      providerKey: "nowpayments",
      purpose: "platform_billing",
      scope: "platform",
    }, actor);

    expect(disabled.data).toEqual({ configId: created.data.configId, status: "inactive" });
    const listed = await listPlatformIntegrations(scope);
    expect(listed.data.find((item) => item.configId === created.data.configId)).toMatchObject({
      purpose: "platform_billing",
      status: "inactive",
      hasSecret: false,
    });
  });

  it("normalizes retail_order and rejects unsupported purpose examples before mutation", async () => {
    const created = await mutatePlatformIntegrationConfig({
      action: "set",
      providerKey: "mock",
      purpose: "retail_order",
      scope: "store",
      merchantId: merchantA,
      storeId: storeA,
      secret: writeOnlyTestValue(),
    }, actor);
    const listed = await listPlatformIntegrations(scope);
    expect(listed.data.find((item) => item.configId === created.data.configId)).toMatchObject({
      purpose: "merchant_retail",
      scope: "store",
      merchantId: merchantA,
      storeId: storeA,
      storeName: "Platform Store A",
    });

    const before = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM app.integration_configs");
    for (const purpose of ["merchant_retail_crypto", "sepay_retail"]) {
      await expect(mutatePlatformIntegrationConfig({
        action: "set",
        providerKey: "mock",
        purpose,
        scope: "merchant",
        merchantId: merchantB,
        secret: writeOnlyTestValue(),
      }, actor)).rejects.toMatchObject({ code: "validation_error" });
    }
    const after = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM app.integration_configs");
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
