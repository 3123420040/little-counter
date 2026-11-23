import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensurePlatformSchema: vi.fn(),
  verifyPassword: vi.fn(),
  signJwt: vi.fn(() => "signed-token"),
  resolveScopeBootstrap: vi.fn(async () => ({ access: {} })),
  ensureOperatorSecurityState: vi.fn(async () => ({
    operatorId: "op_owner",
    requiresPasswordChange: false,
    forceLogoutAfter: null,
    sessionVersion: 1,
    globalStatus: "active",
    passwordChangedAt: null,
    temporaryPasswordHash: null,
    temporaryPasswordExpiresAt: null,
    lastLoginAt: null,
    metadata: {},
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
  })),
  assertTemporaryPasswordAllowsLogin: vi.fn(),
  recordAuditEntry: vi.fn(async () => ({
    id: "audit_test",
    createdAt: "2026-07-01T00:00:00.000Z",
    correlationId: "cor_test",
  })),
  rateLimitClientIpIdentity: vi.fn(() => "203.0.113.10"),
}));

vi.mock("../db/schema", () => ({ ensurePlatformSchema: mocks.ensurePlatformSchema }));
vi.mock("../middleware/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../middleware/auth")>(),
  verifyPassword: mocks.verifyPassword,
  signJwt: mocks.signJwt,
}));
vi.mock("../middleware/rate-limit", () => ({ rateLimitClientIpIdentity: mocks.rateLimitClientIpIdentity }));
vi.mock("../repositories/audit-repository", () => ({ recordAuditEntry: mocks.recordAuditEntry }));
vi.mock("../services/access-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/access-service")>(),
  resolveScopeBootstrap: mocks.resolveScopeBootstrap,
}));
vi.mock("../services/operator-security-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/operator-security-service")>(),
  ensureOperatorSecurityState: mocks.ensureOperatorSecurityState,
  assertTemporaryPasswordAllowsLogin: mocks.assertTemporaryPasswordAllowsLogin,
}));

type FakeState = {
  user: Record<string, unknown> | null;
  priorFailure: { attempt_count: number; blocked_until: Date | null } | null;
  nextAttemptCount: number;
};

let state: FakeState;
let queries: Array<{ sql: string; values: unknown[] }>;

const fakeClient = {
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes("FROM medusa.staff_users") && sql.includes("password_hash")) {
      return { rows: state.user ? [state.user] : [] };
    }
    if (sql.includes("FROM app.auth_login_failures")) {
      return { rows: state.priorFailure ? [state.priorFailure] : [] };
    }
    if (sql.includes("INSERT INTO app.auth_login_failures")) {
      return { rows: [{ attempt_count: state.nextAttemptCount, blocked_until: null }] };
    }
    if (sql.includes("UPDATE app.auth_login_failures") && sql.includes("blocked_until")) {
      return { rows: [{ attempt_count: state.nextAttemptCount, blocked_until: new Date(Date.now() + 2_000) }] };
    }
    return { rows: [] };
  }),
};

vi.mock("../db/transaction", () => ({
  withConnectedClient: vi.fn(async (callback: (client: typeof fakeClient) => Promise<unknown>) => callback(fakeClient)),
}));

import { PlatformError } from "../errors/platform-error";
import { loginOperator } from "../services/auth-service";

const knownUser = {
  operator_id: "op_owner",
  password_hash: "$2b$12$known-hash",
  display_name: "Owner",
  role: "owner",
  organization_id: "org_default",
};

describe("login hardening", () => {
  beforeEach(() => {
    state = { user: null, priorFailure: null, nextAttemptCount: 1 };
    queries = [];
    fakeClient.query.mockClear();
    mocks.verifyPassword.mockReset();
    mocks.signJwt.mockClear();
    mocks.resolveScopeBootstrap.mockClear();
    mocks.ensureOperatorSecurityState.mockClear();
    mocks.assertTemporaryPasswordAllowsLogin.mockClear();
    mocks.recordAuditEntry.mockClear();
    mocks.rateLimitClientIpIdentity.mockClear();
    process.env.JWT_SECRET = "test-jwt-secret-with-at-least-thirty-two-characters";
    process.env.LOGIN_FAILURE_DELAY_ENABLED = "false";
  });

  afterEach(() => {
    delete process.env.LOGIN_FAILURE_DELAY_ENABLED;
  });

  it("uses a dummy bcrypt hash and stores only a hashed unknown-account subject", async () => {
    mocks.verifyPassword.mockResolvedValue(false);

    await expect(loginOperator({ operatorId: "ghost-user", password: "wrong" }, {
      "x-real-ip": "203.0.113.10",
    })).rejects.toMatchObject({ code: "unauthorized", statusCode: 401, message: "Invalid credentials" });

    expect(String(mocks.verifyPassword.mock.calls[0]?.[1])).toMatch(/^\$2b\$12\$/);
    expect(mocks.recordAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "auth.login_failed",
      "operator_login",
      expect.stringMatching(/^account_hash:/),
      expect.anything(),
    );
    expect(JSON.stringify(mocks.recordAuditEntry.mock.calls)).not.toContain("ghost-user");
  });

  it("checks bcrypt before enforcing pair-scoped progressive backoff", async () => {
    state.user = knownUser;
    state.priorFailure = { attempt_count: 5, blocked_until: new Date(Date.now() + 30_000) };
    mocks.verifyPassword.mockResolvedValue(false);

    await expect(loginOperator({ operatorId: "op_owner", password: "wrong" }, {
      "x-real-ip": "203.0.113.10",
    })).rejects.toMatchObject({ code: "rate_limited", statusCode: 429 });

    expect(mocks.verifyPassword).toHaveBeenCalledOnce();
    expect(queries.some((query) => query.sql.includes("INSERT INTO app.auth_login_failures"))).toBe(false);
  });

  it("returns one public denial for suspended and expired-temporary operators", async () => {
    state.user = knownUser;
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.ensureOperatorSecurityState.mockResolvedValueOnce({
      ...await mocks.ensureOperatorSecurityState(),
      globalStatus: "suspended",
    });

    await expect(loginOperator({ operatorId: "op_owner", password: "correct" })).rejects.toMatchObject({
      code: "unauthorized",
      statusCode: 401,
      message: "Invalid credentials",
    });

    mocks.ensureOperatorSecurityState.mockResolvedValueOnce(await mocks.ensureOperatorSecurityState());
    mocks.assertTemporaryPasswordAllowsLogin.mockImplementationOnce(() => {
      throw new PlatformError("temporary_password_expired", "Temporary password has expired", 401);
    });
    await expect(loginOperator({ operatorId: "op_owner", password: "correct" })).rejects.toMatchObject({
      code: "unauthorized",
      statusCode: 401,
      message: "Invalid credentials",
    });
  });

  it("validates an active membership before clearing failures and issuing a JWT", async () => {
    state.user = knownUser;
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.resolveScopeBootstrap.mockRejectedValueOnce(new PlatformError("membership_required", "Membership required", 403));

    await expect(loginOperator({ operatorId: "op_owner", password: "correct" })).rejects.toMatchObject({
      code: "unauthorized",
      statusCode: 401,
    });

    expect(mocks.signJwt).not.toHaveBeenCalled();
    expect(queries.some((query) => query.sql.includes("DELETE FROM app.auth_login_failures WHERE account_hash"))).toBe(false);
  });
});
