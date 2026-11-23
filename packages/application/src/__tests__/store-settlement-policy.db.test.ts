import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import { STORE_BANK_SETTLEMENT_POLICY_METADATA_KEY } from "@medusa-snus/contracts";
import {
  readCheckoutSettlementPolicy,
  readStoreSettlementPolicy,
  StoreSettlementPolicyErrorV1,
  updateStoreSettlementPolicy,
} from "../services/store-settlement-policy-service";
import { readMerchantCheckoutPolicy, readFoundStockPolicyForClient, updateMerchantCheckoutPolicy } from "../services/merchant-checkout-policy-service";
import { getStoreSettingsProfile, updateStoreSettingsProfile } from "../services/owner-settings-service";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../db/migrations");
const migration001 = readFileSync(resolve(MIGRATIONS_DIR, "001_custom_schemas.sql"), "utf8");
const migration002 = readFileSync(resolve(MIGRATIONS_DIR, "002_tenant_foundation_expand.sql"), "utf8");
const migration010OwnerSettings = readFileSync(resolve(MIGRATIONS_DIR, "010_owner_settings_permissions.sql"), "utf8");

const MERCHANT_A = "merchant_settle_a";
const MERCHANT_B = "merchant_settle_b";
const STORE_A = "store_settle_a";
const STORE_B = "store_settle_b";
const SLOC_A = "sloc_settle_a";
const SLOC_B = "sloc_settle_b";

const ownerA = { operatorId: "op_settle_owner_a", role: "owner", organizationId: "org_settle_a" };
const ownerB = { operatorId: "op_settle_owner_b", role: "owner", organizationId: "org_settle_b" };
const scopeA = { scopeKind: "merchant_target" as const, merchantId: MERCHANT_A };
const scopeB = { scopeKind: "merchant_target" as const, merchantId: MERCHANT_B };

let client: PoolClient;

async function cleanup() {
  await client.query("DELETE FROM audit.events WHERE merchant_id IN ($1, $2)", [MERCHANT_A, MERCHANT_B]).catch(() => undefined);
  await client.query("DELETE FROM app.stores WHERE id IN ($1, $2)", [STORE_A, STORE_B]).catch(() => undefined);
  await client.query("DELETE FROM app.merchants WHERE id IN ($1, $2)", [MERCHANT_A, MERCHANT_B]).catch(() => undefined);
  await client.query("DELETE FROM public.stock_location WHERE id IN ($1, $2)", [SLOC_A, SLOC_B]).catch(() => undefined);
  await client.query("DELETE FROM medusa.staff_users WHERE operator_id IN ($1, $2)", [ownerA.operatorId, ownerB.operatorId]).catch(() => undefined);
}

async function seed() {
  await client.query("INSERT INTO public.stock_location (id, name) VALUES ($1, 'Settle A'), ($2, 'Settle B') ON CONFLICT (id) DO NOTHING", [SLOC_A, SLOC_B]);
  await client.query(`
    INSERT INTO app.merchants (id, display_name, legacy_organization_id, status, metadata)
    VALUES
      ($1, 'Merchant Settle A', 'org_settle_a', 'active', '{}'::jsonb),
      ($2, 'Merchant Settle B', 'org_settle_b', 'active', '{}'::jsonb)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, metadata = '{}'::jsonb
  `, [MERCHANT_A, MERCHANT_B]);
  await client.query(`
    INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status, metadata)
    VALUES
      ($1, $2, 'Store Settle A', $3, true, 'active', '{}'::jsonb),
      ($4, $5, 'Store Settle B', $6, true, 'active', '{}'::jsonb)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, metadata = '{}'::jsonb
  `, [STORE_A, MERCHANT_A, SLOC_A, STORE_B, MERCHANT_B, SLOC_B]);
  await client.query(`
    INSERT INTO medusa.staff_users (operator_id, password_hash, display_name, role, organization_id, is_active)
    VALUES ($1, 'unused', 'Settle Owner A', 'owner', 'org_settle_a', true),
           ($2, 'unused', 'Settle Owner B', 'owner', 'org_settle_b', true)
    ON CONFLICT (operator_id) DO UPDATE SET display_name = EXCLUDED.display_name, role = 'owner', is_active = true
  `, [ownerA.operatorId, ownerB.operatorId]);
}

async function auditCount(storeId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit.events WHERE subject_id = $1 AND action = 'settings.store.bank_settlement_policy.updated'",
    [storeId],
  );
  return Number(result.rows[0]?.count || 0);
}

beforeAll(async () => {
  client = await connectPlatformClient();
  await client.query(migration001);
  await ensurePlatformSchema();
  await client.query(migration002);
  await client.query(migration010OwnerSettings);
  await cleanup();
  await seed();
}, 30000);

beforeEach(async () => {
  await client.query("UPDATE app.merchants SET metadata=metadata - 'foundStockCheckout' WHERE id IN ($1, $2)", [MERCHANT_A, MERCHANT_B]);
  await client.query("DELETE FROM audit.events WHERE merchant_id IN ($1, $2) AND action='merchant.checkout_policy.updated'", [MERCHANT_A, MERCHANT_B]);
  await client.query("UPDATE app.stores SET metadata = '{}'::jsonb WHERE id IN ($1, $2)", [STORE_A, STORE_B]);
  await client.query(
    "DELETE FROM audit.events WHERE subject_id IN ($1, $2) AND action = 'settings.store.bank_settlement_policy.updated'",
    [STORE_A, STORE_B],
  );
});

afterAll(async () => {
  if (client) {
    await cleanup();
    client.release();
  }
  await shutdownPlatformDb().catch(() => undefined);
});

describe("store settlement policy DB behavior (T01/PAY01)", () => {
  it("serializes merchant CAS, preserves sibling settings, and does not change another merchant", async () => {
    await client.query("UPDATE app.merchants SET metadata='{\"ownerSettings\":{\"name\":\"Keep\"}}'::jsonb WHERE id=$1", [MERCHANT_A]);
    const attempts = await Promise.allSettled([
      updateMerchantCheckoutPolicy(MERCHANT_A, { enabled: false, expectedVersion: 0 }, ownerA),
      updateMerchantCheckoutPolicy(MERCHANT_A, { enabled: true, expectedVersion: 0 }, ownerB),
    ]);
    expect(attempts.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((attempts.find((x) => x.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "policy_version_conflict" });
    expect((await client.query("SELECT metadata FROM app.merchants WHERE id=$1", [MERCHANT_A])).rows[0].metadata.ownerSettings).toEqual({ name: "Keep" });
    expect((await readMerchantCheckoutPolicy({ scopeKind: "platform_read", merchantIds: [MERCHANT_B] }, MERCHANT_B)).data).toMatchObject({ enabled: true, version: 0 });
    await expect(readMerchantCheckoutPolicy({ scopeKind: "platform_read", merchantIds: [MERCHANT_B] }, MERCHANT_A)).rejects.toMatchObject({ code: "forbidden" });
    expect((await client.query("SELECT count(*)::int AS n FROM audit.events WHERE merchant_id=$1 AND action='merchant.checkout_policy.updated'", [MERCHANT_A])).rows[0].n).toBe(1);
  });

  it("holds the checkout merchant policy stable until the transaction completes", async () => {
    await client.query("BEGIN");
    let update: ReturnType<typeof updateMerchantCheckoutPolicy> | undefined;
    try {
      expect((await readFoundStockPolicyForClient(client, MERCHANT_A, true)).enabled).toBe(true);
      update = updateMerchantCheckoutPolicy(MERCHANT_A, { enabled: false, expectedVersion: 0 }, ownerA);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((await readFoundStockPolicyForClient(client, MERCHANT_A, true)).enabled).toBe(true);
      await client.query("COMMIT");
      expect((await update).data.enabled).toBe(false);
    } finally {
      await client.query("ROLLBACK");
      await update;
    }
  });

  it("activates confirm_on_booking for one store only and defaults others to manual", async () => {
    const updated = await updateStoreSettlementPolicy(STORE_A, {
      mode: "confirm_on_booking",
      expectedVersion: 0,
    }, ownerA, scopeA);
    expect(updated.data).toMatchObject({ mode: "confirm_on_booking", version: 1, source: "configured" });

    const other = await readStoreSettlementPolicy(STORE_B, scopeB);
    expect(other.data).toMatchObject({ mode: "manual_confirmation", version: 0, source: "default" });

    const scopedRead = await readCheckoutSettlementPolicy(MERCHANT_A, STORE_A);
    expect(scopedRead.data).toMatchObject({
      mode: "confirm_on_booking",
      policyVersion: 1,
      acknowledgmentVersion: 1,
      source: "configured",
    });
    const scopedReadOther = await readCheckoutSettlementPolicy(MERCHANT_B, STORE_B);
    expect(scopedReadOther.data).toMatchObject({ mode: "manual_confirmation", policyVersion: 0, source: "default" });
  });

  it("rejects a stale expectedVersion with a typed conflict", async () => {
    await updateStoreSettlementPolicy(STORE_A, { mode: "confirm_on_booking", expectedVersion: 0 }, ownerA, scopeA);
    await expect(
      updateStoreSettlementPolicy(STORE_A, { mode: "manual_confirmation", expectedVersion: 0 }, ownerA, scopeA),
    ).rejects.toMatchObject({ code: "policy_version_conflict" });
    const after = await readStoreSettlementPolicy(STORE_A, scopeA);
    expect(after.data.mode).toBe("confirm_on_booking");
  });

  it("rejects invalid enum modes and cross-scope mutation", async () => {
    await expect(
      updateStoreSettlementPolicy(STORE_A, { mode: "auto_settle" as never, expectedVersion: 0 }, ownerA, scopeA),
    ).rejects.toMatchObject({ code: "validation_error" });

    await expect(
      updateStoreSettlementPolicy(STORE_A, { mode: "confirm_on_booking", expectedVersion: 0 }, ownerB, scopeB),
    ).rejects.toMatchObject({ code: "forbidden" });
    const untouched = await readStoreSettlementPolicy(STORE_A, scopeA);
    expect(untouched.data).toMatchObject({ mode: "manual_confirmation", version: 0, source: "default" });
  });

  it("fails closed when the stored policy is malformed", async () => {
    await client.query(
      `UPDATE app.stores SET metadata = jsonb_build_object($2::text, '{"mode":"surprise"}'::jsonb) WHERE id = $1`,
      [STORE_A, STORE_BANK_SETTLEMENT_POLICY_METADATA_KEY],
    );
    await expect(readCheckoutSettlementPolicy(MERCHANT_A, STORE_A)).rejects.toBeInstanceOf(StoreSettlementPolicyErrorV1);
    const profile = await getStoreSettingsProfile(STORE_A, scopeA);
    expect(profile.data.bankSettlementPolicy).toEqual({ status: "invalid" });
  });

  it("audits each policy change and repairs a malformed policy through settings write", async () => {
    await client.query(
      `UPDATE app.stores SET metadata = jsonb_build_object($2::text, '{"mode":"surprise"}'::jsonb) WHERE id = $1`,
      [STORE_A, STORE_BANK_SETTLEMENT_POLICY_METADATA_KEY],
    );
    const repaired = await updateStoreSettingsProfile(STORE_A, {
      bankTransferSettlement: { mode: "manual_confirmation", expectedVersion: 0 },
    }, ownerA, scopeA);
    expect(repaired.data.bankSettlementPolicy).toMatchObject({ status: "ok", mode: "manual_confirmation", version: 1 });
    expect(await auditCount(STORE_A)).toBe(1);

    await updateStoreSettlementPolicy(STORE_A, { mode: "confirm_on_booking", expectedVersion: 1 }, ownerA, scopeA);
    expect(await auditCount(STORE_A)).toBe(2);
    const row = await client.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM app.stores WHERE id = $1",
      [STORE_A],
    );
    const policy = (row.rows[0]!.metadata as Record<string, unknown>)[STORE_BANK_SETTLEMENT_POLICY_METADATA_KEY] as Record<string, unknown>;
    expect(policy).toMatchObject({ mode: "confirm_on_booking", version: 2, updatedBy: ownerA.operatorId });
  });

  it("preserves unrelated settings namespaces through a combined profile+policy update", async () => {
    await updateStoreSettingsProfile(STORE_A, { publicName: "Original Public" }, ownerA, scopeA);
    const combined = await updateStoreSettingsProfile(STORE_A, {
      internalName: "Store Settle A",
      publicName: "Updated Public",
      bankTransferSettlement: { mode: "confirm_on_booking", expectedVersion: 0 },
    }, ownerA, scopeA);
    expect(combined.data.publicName).toBe("Updated Public");
    expect(combined.data.bankSettlementPolicy).toMatchObject({ mode: "confirm_on_booking", version: 1 });
    expect(await auditCount(STORE_A)).toBe(1);
    const row = await client.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM app.stores WHERE id = $1",
      [STORE_A],
    );
    const metadata = row.rows[0]!.metadata as Record<string, unknown>;
    expect((metadata.ownerSettings as Record<string, unknown>).publicName).toBe("Updated Public");
    expect(metadata[STORE_BANK_SETTLEMENT_POLICY_METADATA_KEY]).toMatchObject({ mode: "confirm_on_booking" });
  });

  it("serializes concurrent updates so exactly one CAS write wins", async () => {
    const attempts = await Promise.allSettled([
      updateStoreSettlementPolicy(STORE_A, { mode: "confirm_on_booking", expectedVersion: 0 }, ownerA, scopeA),
      updateStoreSettlementPolicy(STORE_A, { mode: "manual_confirmation", expectedVersion: 0 }, ownerA, scopeA),
      updateStoreSettlementPolicy(STORE_A, { mode: "confirm_on_booking", expectedVersion: 0 }, ownerA, scopeA),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const rejectedAttempt of rejected) {
      expect((rejectedAttempt as PromiseRejectedResult).reason).toMatchObject({ code: "policy_version_conflict" });
    }
    const finalPolicy = await readStoreSettlementPolicy(STORE_A, scopeA);
    expect(finalPolicy.data.version).toBe(1);
    expect(await auditCount(STORE_A)).toBe(1);
  });
});
