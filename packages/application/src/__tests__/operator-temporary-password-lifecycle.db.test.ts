import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectPlatformClient, type PoolClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import { hashPassword, verifyPassword } from "../middleware/auth";
import { completeRequiredOperatorPasswordChange } from "../services/operator-account-service";
import { loginOperator, type OperatorContext } from "../services/auth-service";
import { resetPlatformOperatorPassword } from "../services/platform-operator-service";

const operatorId = `uat_temp_password_${Date.now()}`;
const initialPassword = "initial-password-123";
const originalEnv = { ...process.env };
let client: PoolClient;

const owner: OperatorContext = {
  operatorId: "op_owner",
  role: "owner",
  displayName: "Owner",
  organizationId: "org_default",
};

const forcedChangeActor: OperatorContext = {
  operatorId,
  role: "staff",
  displayName: "Temporary Password Operator",
  organizationId: "org_default",
  authState: "password_change_required",
};

function accountHash(): string {
  return createHmac("sha256", process.env.JWT_SECRET || "local-login-rate-limit-secret")
    .update(`account:${operatorId.toLowerCase()}`)
    .digest("hex");
}

function loginHeaders(suffix: string) {
  return {
    "x-real-ip": "198.51.100.77",
    "x-request-id": `temporary-password-${suffix}`,
  };
}

async function cleanup(): Promise<void> {
  await client.query("DELETE FROM app.auth_login_failures WHERE account_hash = $1", [accountHash()]);
  await client.query("DELETE FROM audit.events WHERE subject_id = $1 OR actor_id = $1", [operatorId]);
  await client.query("DELETE FROM app.operator_memberships WHERE operator_id = $1", [operatorId]);
  await client.query("DELETE FROM app.operator_profiles WHERE operator_id = $1", [operatorId]);
  await client.query("DELETE FROM app.operator_security_state WHERE operator_id = $1", [operatorId]);
  await client.query("DELETE FROM medusa.staff_users WHERE operator_id = $1", [operatorId]);
}

async function seedNormalOperator(): Promise<void> {
  const passwordHash = await hashPassword(initialPassword);
  await client.query(`
    INSERT INTO medusa.staff_users (
      operator_id, password_hash, display_name, role, organization_id, is_active
    ) VALUES ($1, $2, $3, 'staff', 'org_default', true)
  `, [operatorId, passwordHash, forcedChangeActor.displayName]);
  await client.query(`
    INSERT INTO app.operator_memberships (
      operator_id, scope_type, merchant_id, store_id, role_key, status, granted_by
    ) VALUES ($1, 'store', 'merchant_default', 'store_default', 'staff', 'active', $2)
  `, [operatorId, owner.operatorId]);
  await client.query(`
    INSERT INTO app.operator_security_state (
      operator_id, requires_password_change, session_version, global_status,
      temporary_password_hash, temporary_password_expires_at
    ) VALUES ($1, false, 1, 'active', NULL, NULL)
  `, [operatorId]);
}

beforeAll(async () => {
  process.env.JWT_SECRET = "test-jwt-secret-with-at-least-thirty-two-characters";
  process.env.RATE_LIMIT_TRUST_PROXY_HEADERS = "true";
  process.env.LOGIN_BACKOFF_THRESHOLD = "100";
  process.env.TEMPORARY_PASSWORD_TTL_MINUTES = "60";
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  process.env.RUNTIME_SCHEMA_DDL_ENABLED = "false";
});

beforeEach(async () => {
  await cleanup();
  await seedNormalOperator();
});

afterAll(async () => {
  await cleanup().catch(() => undefined);
  client?.release();
  process.env = originalEnv;
  await shutdownPlatformDb().catch(() => undefined);
});

describe("temporary password lifecycle", () => {
  it("does not impose temporary-credential rules on a normal password", async () => {
    await expect(loginOperator(
      { operatorId, password: initialPassword },
      loginHeaders("normal"),
    )).resolves.toMatchObject({
      data: { authState: "authenticated", security: { requiresPasswordChange: false } },
    });
  });

  it("invalidates an earlier reset and authenticates only the newest temporary credential", async () => {
    const first = await resetPlatformOperatorPassword(operatorId, owner, { reason: "first reset" });
    const second = await resetPlatformOperatorPassword(operatorId, owner, { reason: "second reset" });

    expect(second.data.temporaryPassword).not.toBe(first.data.temporaryPassword);
    expect(new Date(second.data.temporaryPasswordExpiresAt).getTime()).toBeGreaterThan(Date.now());
    await expect(loginOperator(
      { operatorId, password: first.data.temporaryPassword },
      loginHeaders("superseded"),
    )).rejects.toMatchObject({ code: "unauthorized", statusCode: 401 });
    await expect(loginOperator(
      { operatorId, password: second.data.temporaryPassword },
      loginHeaders("newest"),
    )).resolves.toMatchObject({
      data: { authState: "password_change_required", security: { requiresPasswordChange: true } },
    });
  });

  it("rejects an expired login and a forced-change session obtained before expiry", async () => {
    const reset = await resetPlatformOperatorPassword(operatorId, owner, { reason: "expiry proof" });
    await loginOperator(
      { operatorId, password: reset.data.temporaryPassword },
      loginHeaders("before-expiry"),
    );
    await client.query(`
      UPDATE app.operator_security_state
      SET temporary_password_expires_at = now() - interval '1 second'
      WHERE operator_id = $1
    `, [operatorId]);

    await expect(loginOperator(
      { operatorId, password: reset.data.temporaryPassword },
      loginHeaders("after-expiry"),
    )).rejects.toMatchObject({ code: "unauthorized", statusCode: 401 });
    await expect(completeRequiredOperatorPasswordChange(
      forcedChangeActor,
      { newPassword: "replacement-password-123" },
    )).rejects.toMatchObject({ code: "temporary_password_expired", statusCode: 401 });
  });

  it("consumes the temporary credential and preserves normal login with the permanent password", async () => {
    const reset = await resetPlatformOperatorPassword(operatorId, owner, { reason: "consume proof" });
    await loginOperator(
      { operatorId, password: reset.data.temporaryPassword },
      loginHeaders("consume"),
    );
    await expect(completeRequiredOperatorPasswordChange(
      forcedChangeActor,
      { newPassword: "permanent-password-123" },
    )).resolves.toMatchObject({ data: { token: expect.any(String) } });

    const state = await client.query<{
      password_hash: string;
      requires_password_change: boolean;
      temporary_password_hash: string | null;
      temporary_password_expires_at: Date | null;
    }>(`
      SELECT su.password_hash, security.requires_password_change,
        security.temporary_password_hash, security.temporary_password_expires_at
      FROM medusa.staff_users su
      JOIN app.operator_security_state security ON security.operator_id = su.operator_id
      WHERE su.operator_id = $1
    `, [operatorId]);
    expect(state.rows[0]).toMatchObject({
      requires_password_change: false,
      temporary_password_hash: null,
      temporary_password_expires_at: null,
    });
    expect(await verifyPassword("permanent-password-123", state.rows[0]!.password_hash)).toBe(true);
    await expect(loginOperator(
      { operatorId, password: reset.data.temporaryPassword },
      loginHeaders("replay"),
    )).rejects.toMatchObject({ code: "unauthorized", statusCode: 401 });
    await expect(loginOperator(
      { operatorId, password: "permanent-password-123" },
      loginHeaders("permanent"),
    )).resolves.toMatchObject({ data: { authState: "authenticated" } });
  });

  it("allows only one concurrent forced-change completion", async () => {
    const reset = await resetPlatformOperatorPassword(operatorId, owner, { reason: "concurrency proof" });
    await loginOperator(
      { operatorId, password: reset.data.temporaryPassword },
      loginHeaders("concurrent"),
    );
    const candidatePasswords = ["concurrent-password-a", "concurrent-password-b"];
    const results = await Promise.allSettled(candidatePasswords.map((newPassword) => (
      completeRequiredOperatorPasswordChange(forcedChangeActor, { newPassword })
    )));

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => (
      result.status === "rejected" && result.reason?.code === "password_change_not_required"
    ))).toHaveLength(1);
    const successfulPassword = candidatePasswords[results.findIndex(({ status }) => status === "fulfilled")];
    await expect(loginOperator(
      { operatorId, password: successfulPassword },
      loginHeaders("concurrent-final"),
    )).resolves.toMatchObject({ data: { authState: "authenticated" } });
  });
});
