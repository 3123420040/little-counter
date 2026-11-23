import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MerchantTargetScope } from "@medusa-snus/contracts";
import { connectPlatformClient, type PoolClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import { getCatalogEntry } from "../services/package-catalog-service";
import { getMerchantSubscriptionStatus } from "../services/subscription-service";
import {
  createTeamOperator,
  disableTeamMembership,
  enableTeamMembership,
  updateTeamMembership,
} from "../services/operator-team-service";

const runId = `${Date.now()}`;
const merchantId = `uat_team_race_merchant_${runId}`;
const storeId = `uat_team_race_store_${runId}`;
const locationId = `uat_team_race_location_${runId}`;
const ownerId = `uat_team_race_owner_${runId}`;
const candidateIds = [
  `uat_team_race_candidate_a_${runId}`,
  `uat_team_race_candidate_b_${runId}`,
];
const lifecycleOperatorId = `uat_team_lifecycle_${runId}`;
const fixturePrefix = `uat_team_race_existing_${runId}_`;
let fixtureOperatorIds: string[] = [];
let client: PoolClient;

const actor = {
  operatorId: ownerId,
  role: "owner" as const,
  displayName: "Concurrency Owner",
  organizationId: `uat_team_race_org_${runId}`,
};
const scope: MerchantTargetScope = { scopeKind: "merchant_target", merchantId };

async function cleanup(): Promise<void> {
  const operatorIds = [ownerId, lifecycleOperatorId, ...candidateIds, ...fixtureOperatorIds];
  await client.query(
    "DELETE FROM audit.events WHERE merchant_id = $1 OR actor_id = ANY($2::text[])",
    [merchantId, operatorIds],
  ).catch(() => undefined);
  await client.query("DELETE FROM app.operator_security_state WHERE operator_id = ANY($1::text[])", [operatorIds]).catch(() => undefined);
  await client.query("DELETE FROM app.operator_profiles WHERE operator_id = ANY($1::text[])", [operatorIds]).catch(() => undefined);
  await client.query("DELETE FROM app.operator_memberships WHERE merchant_id = $1", [merchantId]).catch(() => undefined);
  await client.query("DELETE FROM app.merchant_subscriptions WHERE merchant_id = $1", [merchantId]).catch(() => undefined);
  await client.query("DELETE FROM app.stores WHERE id = $1", [storeId]).catch(() => undefined);
  await client.query("DELETE FROM app.merchants WHERE id = $1", [merchantId]).catch(() => undefined);
  await client.query("DELETE FROM public.stock_location WHERE id = $1", [locationId]).catch(() => undefined);
  await client.query("DELETE FROM medusa.staff_users WHERE operator_id = ANY($1::text[])", [operatorIds]).catch(() => undefined);
  fixtureOperatorIds = [];
}

async function seedAtOneBelowLimit(): Promise<number> {
  await client.query("INSERT INTO public.stock_location (id, name) VALUES ($1, 'Team race location')", [locationId]);
  await client.query(`
    INSERT INTO app.merchants (id, display_name, legacy_organization_id, status)
    VALUES ($1, 'Team race merchant', $2, 'active')
  `, [merchantId, actor.organizationId]);
  await client.query(`
    INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status)
    VALUES ($1, $2, 'Team race store', $3, true, 'active')
  `, [storeId, merchantId, locationId]);

  const subscription = await getMerchantSubscriptionStatus(merchantId);
  const catalog = await getCatalogEntry(subscription.packageKey, { client });
  expect(catalog.staffLimit).toBeGreaterThanOrEqual(2);

  fixtureOperatorIds = Array.from(
    { length: Math.max(0, catalog.staffLimit - 2) },
    (_, index) => `${fixturePrefix}${index}`,
  );
  const seededIds = [ownerId, ...fixtureOperatorIds];
  for (const [index, operatorId] of seededIds.entries()) {
    const role = index === 0 ? "owner" : "staff";
    await client.query(`
      INSERT INTO medusa.staff_users (
        operator_id, password_hash, display_name, role, organization_id, is_active
      ) VALUES ($1, 'unused', $1, $2, $3, true)
    `, [operatorId, role, actor.organizationId]);
    await client.query(`
      INSERT INTO app.operator_memberships (
        operator_id, scope_type, merchant_id, store_id, role_key, status, granted_by
      ) VALUES ($1, $2, $3, $4, $5, 'active', $6)
    `, [
      operatorId,
      index === 0 ? "merchant" : "store",
      merchantId,
      index === 0 ? null : storeId,
      role,
      ownerId,
    ]);
  }
  return catalog.staffLimit;
}

async function seedLifecycleOperator(): Promise<{ merchantMembershipId: string; storeMembershipId: string }> {
  await client.query(`
    INSERT INTO medusa.staff_users (
      operator_id, password_hash, display_name, role, organization_id, is_active
    ) VALUES ($1, 'unused', 'Lifecycle operator', 'manager', $2, true)
  `, [lifecycleOperatorId, actor.organizationId]);
  const merchantMembership = await client.query<{ id: string }>(`
    INSERT INTO app.operator_memberships (
      operator_id, scope_type, merchant_id, role_key, status, granted_by
    ) VALUES ($1, 'merchant', $2, 'manager', 'active', $3)
    RETURNING id::text
  `, [lifecycleOperatorId, merchantId, ownerId]);
  const storeMembership = await client.query<{ id: string }>(`
    INSERT INTO app.operator_memberships (
      operator_id, scope_type, merchant_id, store_id, role_key, status, granted_by
    ) VALUES ($1, 'store', $2, $3, 'staff', 'disabled', $4)
    RETURNING id::text
  `, [lifecycleOperatorId, merchantId, storeId, ownerId]);
  return {
    merchantMembershipId: String(merchantMembership.rows[0]?.id),
    storeMembershipId: String(storeMembership.rows[0]?.id),
  };
}

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup().catch(() => undefined);
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("operator team entitlement concurrency", () => {
  it("serializes creates at the staff limit and leaves no orphan for the rejected candidate", async () => {
    const staffLimit = await seedAtOneBelowLimit();
    const results = await Promise.allSettled(candidateIds.map((operatorId, index) => (
      createTeamOperator(merchantId, {
        operatorId,
        displayName: `Candidate ${index + 1}`,
        role: "staff",
        scopeType: "store",
        storeId,
      }, actor, scope)
    )));

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => (
      result.status === "rejected"
      && result.reason?.code === "staff_limit_exceeded"
      && result.reason?.statusCode === 409
    ))).toHaveLength(1);

    const state = await client.query<{
      active_count: number;
      candidate_users: number;
      candidate_profiles: number;
      candidate_memberships: number;
      candidate_security_states: number;
    }>(`
      SELECT
        (SELECT count(DISTINCT operator_id)::int
         FROM app.operator_memberships
         WHERE merchant_id = $1 AND status = 'active'
           AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())) AS active_count,
        (SELECT count(*)::int FROM medusa.staff_users WHERE operator_id = ANY($2::text[])) AS candidate_users,
        (SELECT count(*)::int FROM app.operator_profiles WHERE operator_id = ANY($2::text[])) AS candidate_profiles,
        (SELECT count(*)::int FROM app.operator_memberships WHERE operator_id = ANY($2::text[])) AS candidate_memberships,
        (SELECT count(*)::int FROM app.operator_security_state WHERE operator_id = ANY($2::text[])) AS candidate_security_states
    `, [merchantId, candidateIds]);
    expect(state.rows[0]).toEqual({
      active_count: staffLimit,
      candidate_users: 1,
      candidate_profiles: 1,
      candidate_memberships: 1,
      candidate_security_states: 1,
    });
  }, 30_000);

  it("allows only one concurrent enable transition for the same disabled membership", async () => {
    await seedAtOneBelowLimit();
    const { storeMembershipId } = await seedLifecycleOperator();
    const blocker = await connectPlatformClient();
    let blockerInTransaction = false;

    try {
      await blocker.query("BEGIN");
      blockerInTransaction = true;
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`team_staff_entitlement\u001f${merchantId}`],
      );

      let settledCount = 0;
      const enableA = enableTeamMembership(storeMembershipId, actor).finally(() => {
        settledCount += 1;
      });
      const enableB = enableTeamMembership(storeMembershipId, actor).finally(() => {
        settledCount += 1;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settledCount).toBe(0);

      await blocker.query("COMMIT");
      blockerInTransaction = false;
      const results = await Promise.allSettled([enableA, enableB]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        status: "rejected",
        reason: { code: "membership_state_conflict", statusCode: 409 },
      });

      const state = await client.query<{ status: string; audits: number }>(`
        SELECT om.status,
          (SELECT count(*)::int FROM audit.events
           WHERE action = 'team.membership.enabled' AND subject_id = om.id::text) AS audits
        FROM app.operator_memberships om
        WHERE om.id::text = $1
      `, [storeMembershipId]);
      expect(state.rows[0]).toEqual({ status: "active", audits: 1 });
    } finally {
      if (blockerInTransaction) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  }, 30_000);

  it("rejects repeated or invalid lifecycle transitions", async () => {
    await seedAtOneBelowLimit();
    const { storeMembershipId } = await seedLifecycleOperator();

    await expect(enableTeamMembership(storeMembershipId, actor)).resolves.toMatchObject({
      data: { status: "active" },
    });
    await expect(enableTeamMembership(storeMembershipId, actor)).rejects.toMatchObject({
      code: "membership_state_conflict",
      statusCode: 409,
    });
    await expect(disableTeamMembership(storeMembershipId, actor)).resolves.toMatchObject({
      data: { status: "disabled" },
    });
    await expect(disableTeamMembership(storeMembershipId, actor)).rejects.toMatchObject({
      code: "membership_state_conflict",
      statusCode: 409,
    });
    await expect(updateTeamMembership(storeMembershipId, actor, { role: "staff" })).rejects.toMatchObject({
      code: "membership_state_conflict",
      statusCode: 409,
    });
    await client.query("UPDATE app.operator_memberships SET status = 'revoked' WHERE id::text = $1", [storeMembershipId]);
    await expect(enableTeamMembership(storeMembershipId, actor)).rejects.toMatchObject({
      code: "membership_state_conflict",
      statusCode: 409,
    });
  });

  it("keeps the legacy role aligned to the highest remaining active membership", async () => {
    await seedAtOneBelowLimit();
    const { merchantMembershipId, storeMembershipId } = await seedLifecycleOperator();

    await enableTeamMembership(storeMembershipId, actor);
    await updateTeamMembership(storeMembershipId, actor, { role: "staff" });
    let role = await client.query<{ role: string }>(
      "SELECT role FROM medusa.staff_users WHERE operator_id = $1",
      [lifecycleOperatorId],
    );
    expect(role.rows[0]?.role).toBe("manager");

    await disableTeamMembership(merchantMembershipId, actor);
    role = await client.query<{ role: string }>(
      "SELECT role FROM medusa.staff_users WHERE operator_id = $1",
      [lifecycleOperatorId],
    );
    expect(role.rows[0]?.role).toBe("staff");
  });
});
