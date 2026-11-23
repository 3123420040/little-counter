import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import {
  getMerchantSettingsProfile,
  getSettingsMe,
  getOwnerIntegrations,
  getOwnerPackagePage,
  getStoreSettingsTarget,
  updateMerchantSettingsProfile,
  updateStoreSettingsProfile,
} from "../services/owner-settings-service";
import { mutatePlatformIntegrationConfig } from "../services/platform-admin-service";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../db/migrations");
const migration001 = readFileSync(resolve(MIGRATIONS_DIR, "001_custom_schemas.sql"), "utf8");
const migration002 = readFileSync(resolve(MIGRATIONS_DIR, "002_tenant_foundation_expand.sql"), "utf8");
const migration010OwnerSettings = readFileSync(resolve(MIGRATIONS_DIR, "010_owner_settings_permissions.sql"), "utf8");
const migration012PlatformAdmin = readFileSync(resolve(MIGRATIONS_DIR, "012_platform_admin_integration_configs.sql"), "utf8");

const MERCHANT_A = "merchant_settings_a";
const MERCHANT_B = "merchant_settings_b";
const STORE_A = "store_settings_a";
const STORE_B = "store_settings_b";
const SLOC_A = "sloc_settings_a";
const SLOC_B = "sloc_settings_b";

const actor = { operatorId: "op_owner_settings", role: "owner", organizationId: "org_settings_a" };
const platformActor = { operatorId: "op_platform_settings", role: "owner" as const, displayName: "Platform Settings", organizationId: "org_platform" };
const scopeA = { scopeKind: "merchant_target" as const, merchantId: MERCHANT_A };
const scopeB = { scopeKind: "merchant_target" as const, merchantId: MERCHANT_B };

let client: PoolClient;

async function cleanup() {
  await client.query("DELETE FROM app.telegram_bot_configs WHERE merchant_id IN ($1, $2)", [MERCHANT_A, MERCHANT_B]).catch(() => undefined);
  await client.query("DELETE FROM app.integration_configs WHERE merchant_id IN ($1, $2)", [MERCHANT_A, MERCHANT_B]).catch(() => undefined);
  await client.query("DELETE FROM audit.events WHERE merchant_id IN ($1, $2) OR actor_id = $3", [MERCHANT_A, MERCHANT_B, actor.operatorId]).catch(() => undefined);
  await client.query("DELETE FROM app.subscription_usage_reservations WHERE merchant_id IN ($1, $2)", [MERCHANT_A, MERCHANT_B]).catch(() => undefined);
  await client.query("DELETE FROM app.subscription_usage_buckets WHERE merchant_id IN ($1, $2)", [MERCHANT_A, MERCHANT_B]).catch(() => undefined);
  await client.query("DELETE FROM app.subscription_events WHERE merchant_id IN ($1, $2)", [MERCHANT_A, MERCHANT_B]).catch(() => undefined);
  await client.query("DELETE FROM app.merchant_subscriptions WHERE merchant_id IN ($1, $2)", [MERCHANT_A, MERCHANT_B]).catch(() => undefined);
  await client.query("DELETE FROM app.operator_memberships WHERE merchant_id IN ($1, $2) OR operator_id = $3", [MERCHANT_A, MERCHANT_B, platformActor.operatorId]).catch(() => undefined);
  await client.query("DELETE FROM app.stores WHERE id IN ($1, $2)", [STORE_A, STORE_B]).catch(() => undefined);
  await client.query("DELETE FROM app.merchants WHERE id IN ($1, $2)", [MERCHANT_A, MERCHANT_B]).catch(() => undefined);
  await client.query("DELETE FROM public.stock_location WHERE id IN ($1, $2)", [SLOC_A, SLOC_B]).catch(() => undefined);
  await client.query("DELETE FROM medusa.staff_users WHERE operator_id IN ($1, $2)", [actor.operatorId, platformActor.operatorId]).catch(() => undefined);
}

async function seed() {
  await client.query("INSERT INTO public.stock_location (id, name) VALUES ($1, 'Settings A'), ($2, 'Settings B') ON CONFLICT (id) DO NOTHING", [SLOC_A, SLOC_B]);
  await client.query(`
    INSERT INTO app.merchants (id, display_name, legacy_organization_id, status, metadata)
    VALUES
      ($1, 'Merchant A', 'org_settings_a', 'active', '{}'::jsonb),
      ($2, 'Merchant B', 'org_settings_b', 'active', '{}'::jsonb)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, metadata = '{}'::jsonb
  `, [MERCHANT_A, MERCHANT_B]);
  await client.query(`
    INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status, metadata)
    VALUES
      ($1, $2, 'Store A', $3, true, 'active', '{}'::jsonb),
      ($4, $5, 'Store B', $6, true, 'active', '{}'::jsonb)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, metadata = '{}'::jsonb
  `, [STORE_A, MERCHANT_A, SLOC_A, STORE_B, MERCHANT_B, SLOC_B]);
  await client.query(`
    INSERT INTO medusa.staff_users (operator_id, password_hash, display_name, role, organization_id, is_active)
    VALUES ($1, 'unused', 'Settings Owner', 'owner', 'org_settings_a', true)
    ON CONFLICT (operator_id) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, is_active = true
  `, [actor.operatorId]);
  await client.query(`
    INSERT INTO medusa.staff_users (operator_id, password_hash, display_name, role, organization_id, is_active)
    VALUES ($1, 'unused', 'Platform Settings', 'owner', 'org_platform', true)
    ON CONFLICT (operator_id) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, is_active = true
  `, [platformActor.operatorId]);
  await client.query(`
    INSERT INTO app.operator_memberships (operator_id, scope_type, role_key, status, granted_by)
    VALUES ($1, 'platform', 'platform_admin', 'active', 'test')
    ON CONFLICT DO NOTHING
  `, [platformActor.operatorId]);
}

beforeAll(async () => {
  client = await connectPlatformClient();
  await client.query(migration001);
  await ensurePlatformSchema();
  await client.query(migration002);
  await client.query(migration010OwnerSettings);
  await client.query(migration012PlatformAdmin);
  await cleanup();
  await seed();
}, 30000);

beforeEach(async () => {
  await client.query("DELETE FROM app.telegram_bot_configs WHERE merchant_id IN ($1, $2)", [MERCHANT_A, MERCHANT_B]);
  await client.query("DELETE FROM app.integration_configs WHERE merchant_id IN ($1, $2)", [MERCHANT_A, MERCHANT_B]);
});

afterAll(async () => {
  if (client) {
    await cleanup();
    client.release();
  }
  await shutdownPlatformDb().catch(() => undefined);
});

describe("owner settings PostgreSQL service", () => {
  it("lists every granted merchant's stores for a multi-merchant owner without exposing other merchants", async () => {
    await client.query(`INSERT INTO app.operator_memberships
      (operator_id,scope_type,merchant_id,role_key,status,granted_by)
      VALUES ($1,'merchant',$2,'owner','active','test'),($1,'merchant',$3,'owner','active','test')`,
    [actor.operatorId,MERCHANT_A,MERCHANT_B]);
    try {
      const owner = { ...actor, role: "owner" as const, displayName: "Settings Owner" };
      const me = await getSettingsMe(owner, {});
      expect(me.isPlatformAdmin).toBe(false);
      expect(me.stores.map((store) => store.storeId).sort()).toEqual([STORE_A,STORE_B].sort());
      await client.query("UPDATE app.operator_memberships SET status='revoked' WHERE operator_id=$1 AND merchant_id=$2", [actor.operatorId,MERCHANT_B]);
      const narrowed = await getSettingsMe(owner, {});
      expect(narrowed.stores.map((store) => store.storeId)).toEqual([STORE_A]);
      expect(me.permissionVersion).toMatch(/^pv1:[a-f0-9]{64}$/);
      expect(narrowed.permissionVersion).not.toBe(me.permissionVersion);
      expect(narrowed.security.sessionVersion).toBe(me.security.sessionVersion);
    } finally {
      await client.query("DELETE FROM app.operator_memberships WHERE operator_id=$1 AND merchant_id IN ($2,$3)", [actor.operatorId,MERCHANT_A,MERCHANT_B]);
    }
  });

  it("returns all active stores with merchant identity for platform-only admins", async () => {
    const me = await getSettingsMe(platformActor, {});

    expect(me.merchant).toBeNull();
    expect(me.isPlatformAdmin).toBe(true);
    expect(me.featureEntitlements).toEqual([]);
    expect(me.stores).toEqual(expect.arrayContaining([
      expect.objectContaining({
        storeId: STORE_A,
        merchantId: MERCHANT_A,
        merchantDisplayName: "Merchant A",
      }),
      expect.objectContaining({
        storeId: STORE_B,
        merchantId: MERCHANT_B,
        merchantDisplayName: "Merchant B",
      }),
    ]));
  });

  it("persists merchant settings in metadata and writes tenant-stamped audit evidence", async () => {
    const updated = await updateMerchantSettingsProfile(MERCHANT_A, {
      internalName: "Merchant A Internal",
      publicName: "Merchant A Public",
      receiptName: "Receipt A",
      messageName: "Message A",
      email: "owner@example.com",
      website: "https://example.com",
      address: { street: "1 Test", city: "HCM", country: "VN" },
    }, actor, scopeA);

    expect(updated.data).toMatchObject({
      merchantId: MERCHANT_A,
      internalName: "Merchant A Internal",
      publicName: "Merchant A Public",
      receiptName: "Receipt A",
      messageName: "Message A",
      email: "owner@example.com",
      website: "https://example.com",
      address: { street: "1 Test", city: "HCM", country: "VN" },
    });

    const audit = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM audit.events
      WHERE merchant_id = $1 AND action = 'settings.merchant.updated' AND actor_id = $2
    `, [MERCHANT_A, actor.operatorId]);
    expect(audit.rows[0]?.count).toBe("1");

    const cleared = await updateMerchantSettingsProfile(MERCHANT_A, {
      email: "",
      website: "",
    }, actor, scopeA);
    expect(cleared.data.email).toBeUndefined();
    expect(cleared.data.website).toBeUndefined();
  });

  it("rejects cross-merchant profile reads and updates before touching merchant B", async () => {
    await expect(getMerchantSettingsProfile(MERCHANT_B, scopeA)).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateMerchantSettingsProfile(MERCHANT_B, { publicName: "Wrong" }, actor, scopeA))
      .rejects.toMatchObject({ code: "forbidden" });

    const row = await client.query<{ display_name: string; metadata: Record<string, unknown> }>(
      "SELECT display_name, metadata FROM app.merchants WHERE id = $1",
      [MERCHANT_B],
    );
    expect(row.rows[0]?.display_name).toBe("Merchant B");
    expect(row.rows[0]?.metadata).toEqual({});
  });

  it("resolves store targets and rejects wrong merchant scope before updating store metadata", async () => {
    await expect(getStoreSettingsTarget(STORE_B)).resolves.toEqual({ storeId: STORE_B, merchantId: MERCHANT_B });

    await expect(updateStoreSettingsProfile(STORE_B, { publicName: "Wrong" }, actor, scopeA)).rejects.toMatchObject({ code: "forbidden" });

    const row = await client.query<{ display_name: string; metadata: Record<string, unknown> }>(
      "SELECT display_name, metadata FROM app.stores WHERE id = $1",
      [STORE_B],
    );
    expect(row.rows[0]?.display_name).toBe("Store B");
    expect(row.rows[0]?.metadata).toEqual({});

    const updated = await updateStoreSettingsProfile(STORE_B, { publicName: "Store B Public" }, actor, scopeB);
    expect(updated.data.publicName).toBe("Store B Public");
  });

  it("returns a backward-compatible package page when no settings rows existed", async () => {
    const page = await getOwnerPackagePage(MERCHANT_A, scopeA);

    expect(page.data.currentStatus).toMatchObject({
      merchantId: MERCHANT_A,
      currentPackageKey: "basic",
      subscriptionStatus: "active",
    });
    expect(page.data.catalog.map((entry) => entry.packageKey)).toEqual(["basic", "plus", "ai_fan"]);
  });

  it("shows Telegram readiness without exposing a secret when no runtime is configured", async () => {
    const integrations = await getOwnerIntegrations(MERCHANT_A, scopeA);
    expect(integrations.data.find((item) => item.providerKey === "telegram")).toMatchObject({
      integrationId: `telegram:${MERCHANT_A}`,
      purpose: "telegram_runtime",
      scope: "merchant",
      status: "pending_config",
      healthSummary: "Not included in current package",
      requiredAction: "Upgrade to AI Fan",
    });
    expect(JSON.stringify(integrations)).not.toMatch(/token|secret/i);
  });

  it("projects a platform-admin-created merchant config without secret evidence", async () => {
    const rawSecret = "owner-settings-merchant-secret-value";
    const created = await mutatePlatformIntegrationConfig({
      action: "set",
      providerKey: "nowpayments",
      purpose: "merchant_retail",
      scope: "merchant",
      merchantId: MERCHANT_A,
      secret: rawSecret,
    }, platformActor);
    await client.query(`
      UPDATE app.integration_configs
      SET callback_url = 'https://merchant-a.example.test/ipn',
          health_summary = 'Retail provider configured',
          required_action = NULL
      WHERE id = $1
    `, [created.data.configId]);

    const integrations = await getOwnerIntegrations(MERCHANT_A, scopeA);
    const config = integrations.data.find((item) => item.integrationId === created.data.configId);
    expect(config).toMatchObject({
      providerKey: "nowpayments",
      purpose: "merchant_retail",
      scope: "merchant",
      status: "active",
      callbackUrl: "https://merchant-a.example.test/ipn",
      healthSummary: "Retail provider configured",
      lastCheckedAt: expect.any(String),
    });
    expect(Object.keys(config || {})).not.toEqual(expect.arrayContaining(["secret", "maskedSecret", "secretDigest", "hasSecret"]));
    expect(JSON.stringify(integrations)).not.toContain(rawSecret);
  });

  it("shows only store configs whose store ownership matches the target merchant", async () => {
    const visible = await mutatePlatformIntegrationConfig({
      action: "set",
      providerKey: "mock",
      purpose: "merchant_retail",
      scope: "store",
      merchantId: MERCHANT_A,
      storeId: STORE_A,
      secret: "owner-settings-store-a-secret",
    }, platformActor);
    const hidden = await mutatePlatformIntegrationConfig({
      action: "set",
      providerKey: "sepay_va",
      purpose: "merchant_retail",
      scope: "store",
      merchantId: MERCHANT_B,
      storeId: STORE_B,
      secret: "owner-settings-store-b-secret",
    }, platformActor);
    const hiddenMerchant = await mutatePlatformIntegrationConfig({
      action: "set",
      providerKey: "mock",
      purpose: "merchant_retail",
      scope: "merchant",
      merchantId: MERCHANT_B,
      secret: "owner-settings-merchant-b-secret",
    }, platformActor);

    const integrations = await getOwnerIntegrations(MERCHANT_A, scopeA);
    expect(integrations.data.find((item) => item.integrationId === visible.data.configId)).toMatchObject({
      providerKey: "mock",
      purpose: "merchant_retail",
      scope: "store",
      storeId: STORE_A,
      storeName: "Store A",
    });
    expect(integrations.data.some((item) => item.integrationId === hidden.data.configId)).toBe(false);
    expect(integrations.data.some((item) => item.integrationId === hiddenMerchant.data.configId)).toBe(false);
    expect(JSON.stringify(integrations)).not.toContain(STORE_B);
    expect(JSON.stringify(integrations)).not.toContain(MERCHANT_B);
  });

  it("lets explicit inactive and error config metadata override environment fallback safely", async () => {
    const inactive = await mutatePlatformIntegrationConfig({
      action: "set",
      providerKey: "sepay_va",
      purpose: "merchant_retail",
      scope: "merchant",
      merchantId: MERCHANT_A,
      secret: "owner-settings-inactive-secret",
    }, platformActor);
    await mutatePlatformIntegrationConfig({
      action: "disable",
      providerKey: "sepay_va",
      purpose: "merchant_retail",
      scope: "merchant",
      merchantId: MERCHANT_A,
    }, platformActor);

    const errored = await mutatePlatformIntegrationConfig({
      action: "set",
      providerKey: "mock",
      purpose: "merchant_retail",
      scope: "merchant",
      merchantId: MERCHANT_A,
      secret: "owner-settings-error-secret",
    }, platformActor);
    await client.query(`
      UPDATE app.integration_configs
      SET status = 'error',
          health_summary = 'Provider health check failed',
          required_action = 'Contact platform support'
      WHERE id = $1
    `, [errored.data.configId]);

    const integrations = await getOwnerIntegrations(MERCHANT_A, scopeA);
    expect(integrations.data.find((item) => item.integrationId === inactive.data.configId)).toMatchObject({
      status: "inactive",
      healthSummary: "Configuration inactive",
      requiredAction: "Contact platform support to enable provider",
    });
    expect(integrations.data.find((item) => item.integrationId === errored.data.configId)).toMatchObject({
      status: "error",
      healthSummary: "Provider health check failed",
      requiredAction: "Contact platform support",
    });
  });
});
