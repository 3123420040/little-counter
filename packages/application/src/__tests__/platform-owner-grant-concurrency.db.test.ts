import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { permissions } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import {
  grantPlatformOperatorPermission,
  PLATFORM_OWNER_GRANT_LOCK_KEY,
  revokePlatformOperatorPermission,
} from "../services/platform-operator-service";

const operators = {
  actor: "v19_platform_owner_actor",
  ownerA: "v19_platform_owner_a",
  ownerB: "v19_platform_owner_b",
  expired: "v19_platform_owner_expired",
  revoked: "v19_platform_owner_revoked",
  future: "v19_platform_owner_future",
  merchantScoped: "v19_platform_owner_merchant_scoped",
} as const;

const allOperatorIds = Object.values(operators);
const actor = {
  operatorId: operators.actor,
  role: "owner" as const,
  organizationId: "v19_platform_owner_org",
};

let client: PoolClient;

async function cleanup(): Promise<void> {
  await client.query(`
    DELETE FROM audit.events
    WHERE actor_id = ANY($1::text[])
       OR subject_id = ANY($1::text[])
  `, [allOperatorIds]).catch(() => undefined);
  await client.query(`
    DELETE FROM app.operator_explicit_permission_grants
    WHERE operator_id = ANY($1::text[])
  `, [allOperatorIds]).catch(() => undefined);
  await client.query(`
    DELETE FROM app.operator_security_state
    WHERE operator_id = ANY($1::text[])
  `, [allOperatorIds]).catch(() => undefined);
  await client.query(`
    DELETE FROM app.operator_profiles
    WHERE operator_id = ANY($1::text[])
  `, [allOperatorIds]).catch(() => undefined);
  await client.query(`
    DELETE FROM medusa.staff_users
    WHERE operator_id = ANY($1::text[])
  `, [allOperatorIds]).catch(() => undefined);
}

async function seedOperators(): Promise<void> {
  for (const operatorId of allOperatorIds) {
    await client.query(`
      INSERT INTO medusa.staff_users (
        operator_id, password_hash, display_name, role, organization_id, is_active
      )
      VALUES ($1, 'unused', $1, 'staff', $2, true)
    `, [operatorId, actor.organizationId]);
  }
}

async function insertOwnerGrant(input: {
  operatorId: string;
  status?: "active" | "revoked";
  validFrom?: string;
  validTo?: string | null;
  scopeType?: "platform" | "merchant";
}): Promise<string> {
  const scopeType = input.scopeType || "platform";
  const result = await client.query<{ id: string }>(`
    INSERT INTO app.operator_explicit_permission_grants (
      operator_id,
      permission_id,
      scope_type,
      merchant_id,
      status,
      granted_by,
      revoked_by,
      reason,
      valid_from,
      valid_to,
      revoked_at
    )
    VALUES (
      $1,
      $2,
      $3,
      CASE WHEN $3 = 'merchant' THEN 'v19_platform_owner_wrong_scope' ELSE NULL END,
      $4,
      $5,
      CASE WHEN $4 = 'revoked' THEN $5 ELSE NULL END,
      'v1.9 concurrency fixture',
      COALESCE($6::timestamptz, now()),
      $7::timestamptz,
      CASE WHEN $4 = 'revoked' THEN now() ELSE NULL END
    )
    RETURNING id::text
  `, [
    input.operatorId,
    permissions.platformImpersonationStart,
    scopeType,
    input.status || "active",
    actor.operatorId,
    input.validFrom || null,
    input.validTo ?? null,
  ]);
  return String(result.rows[0]?.id);
}

beforeAll(async () => {
  client = await connectPlatformClient();
  await ensurePlatformSchema();
}, 30000);

beforeEach(async () => {
  await cleanup();
  await seedOperators();
});

afterAll(async () => {
  if (client) {
    await cleanup();
    client.release();
  }
  await shutdownPlatformDb().catch(() => undefined);
});

describe("platform owner grant concurrency protection", () => {
  it("serializes concurrent grants for the same operator and permission", async () => {
    const permissionId = permissions.platformMembershipWrite;
    const lockKey = `platform-operator-permission:${operators.ownerA}:${permissionId}`;
    const blocker = await connectPlatformClient();
    let blockerInTransaction = false;

    try {
      await blocker.query("BEGIN");
      blockerInTransaction = true;
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey],
      );

      let settledCount = 0;
      const grantA = grantPlatformOperatorPermission(operators.ownerA, actor, {
        permissionId,
        reason: "concurrent grant A",
      }).finally(() => {
        settledCount += 1;
      });
      const grantB = grantPlatformOperatorPermission(operators.ownerA, actor, {
        permissionId,
        reason: "concurrent grant B",
      }).finally(() => {
        settledCount += 1;
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settledCount).toBe(0);

      await blocker.query("COMMIT");
      blockerInTransaction = false;

      const results = await Promise.all([grantA, grantB]);
      expect(new Set(results.map((result) => result.data.grantId)).size).toBe(1);
      const grants = await client.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM app.operator_explicit_permission_grants
        WHERE operator_id = $1
          AND permission_id = $2
          AND scope_type = 'platform'
          AND merchant_id IS NULL
          AND store_id IS NULL
          AND status = 'active'
      `, [operators.ownerA, permissionId]);
      expect(Number(grants.rows[0]?.count || 0)).toBe(1);
    } finally {
      if (blockerInTransaction) {
        await blocker.query("ROLLBACK").catch(() => undefined);
      }
      blocker.release();
    }
  });

  it("allows exactly one of two concurrent final-owner revocations", async () => {
    const grantA = await insertOwnerGrant({ operatorId: operators.ownerA });
    const grantB = await insertOwnerGrant({ operatorId: operators.ownerB });
    const blocker = await connectPlatformClient();
    let blockerInTransaction = false;

    try {
      await blocker.query("BEGIN");
      blockerInTransaction = true;
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [PLATFORM_OWNER_GRANT_LOCK_KEY],
      );

      let settledCount = 0;
      const revokeA = revokePlatformOperatorPermission(grantA, actor, {
        reason: "concurrent owner revoke A",
      }).finally(() => {
        settledCount += 1;
      });
      const revokeB = revokePlatformOperatorPermission(grantB, actor, {
        reason: "concurrent owner revoke B",
      }).finally(() => {
        settledCount += 1;
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settledCount).toBe(0);

      await blocker.query("COMMIT");
      blockerInTransaction = false;

      const results = await Promise.allSettled([revokeA, revokeB]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: {
          code: "last_platform_owner_grant",
          statusCode: 409,
        },
      });

      const grants = await client.query<{ id: string; status: string }>(`
        SELECT id::text, status
        FROM app.operator_explicit_permission_grants
        WHERE id::text = ANY($1::text[])
        ORDER BY id::text
      `, [[grantA, grantB]]);
      expect(grants.rows.filter((grant) => grant.status === "revoked")).toHaveLength(1);
      expect(grants.rows.filter((grant) => grant.status === "active")).toHaveLength(1);

      const audit = await client.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM audit.events
        WHERE actor_id = $1
          AND action = 'platform.operator.permission_revoked'
          AND subject_id = ANY($2::text[])
      `, [actor.operatorId, [operators.ownerA, operators.ownerB]]);
      expect(Number(audit.rows[0]?.count || 0)).toBe(1);
    } finally {
      if (blockerInTransaction) {
        await blocker.query("ROLLBACK").catch(() => undefined);
      }
      blocker.release();
    }
  });

  it("does not count expired, revoked, future, or non-platform grants as effective owners", async () => {
    const effectiveGrant = await insertOwnerGrant({ operatorId: operators.ownerA });
    const expiredGrant = await insertOwnerGrant({
      operatorId: operators.expired,
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2020-01-02T00:00:00.000Z",
    });
    const revokedGrant = await insertOwnerGrant({
      operatorId: operators.revoked,
      status: "revoked",
    });
    const futureGrant = await insertOwnerGrant({
      operatorId: operators.future,
      validFrom: "2100-01-01T00:00:00.000Z",
    });
    const merchantScopedGrant = await insertOwnerGrant({
      operatorId: operators.merchantScoped,
      scopeType: "merchant",
    });

    await expect(revokePlatformOperatorPermission(effectiveGrant, actor, {
      reason: "must preserve final effective owner",
    })).rejects.toMatchObject({
      code: "last_platform_owner_grant",
      statusCode: 409,
    });

    await expect(revokePlatformOperatorPermission(expiredGrant, actor, {
      reason: "retire expired grant",
    })).resolves.toMatchObject({
      data: { grantId: expiredGrant, status: "revoked" },
    });
    await expect(revokePlatformOperatorPermission(futureGrant, actor, {
      reason: "cancel future grant",
    })).resolves.toMatchObject({
      data: { grantId: futureGrant, status: "revoked" },
    });
    await expect(revokePlatformOperatorPermission(revokedGrant, actor, {
      reason: "already revoked",
    })).rejects.toMatchObject({
      code: "resource_not_found",
      statusCode: 404,
    });
    await expect(revokePlatformOperatorPermission(merchantScopedGrant, actor, {
      reason: "retire wrong-scope grant",
    })).resolves.toMatchObject({
      data: { grantId: merchantScopedGrant, status: "revoked" },
    });

    const grants = await client.query<{ id: string; status: string }>(`
      SELECT id::text, status
      FROM app.operator_explicit_permission_grants
      WHERE id::text = ANY($1::text[])
    `, [[effectiveGrant, expiredGrant, revokedGrant, futureGrant, merchantScopedGrant]]);
    expect(grants.rows).toEqual(expect.arrayContaining([
      { id: effectiveGrant, status: "active" },
      { id: expiredGrant, status: "revoked" },
      { id: revokedGrant, status: "revoked" },
      { id: futureGrant, status: "revoked" },
      { id: merchantScopedGrant, status: "revoked" },
    ]));
  });
});
