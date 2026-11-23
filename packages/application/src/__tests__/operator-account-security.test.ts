import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  ensurePlatformSchema: vi.fn(),
}));

vi.mock("../db/schema", () => ({ ensurePlatformSchema: deps.ensurePlatformSchema }));

const queries: Array<{ sql: string; values: unknown[] }> = [];
const client = {
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes("INSERT INTO app.operator_identity_link_tokens")) {
      return { rows: [{ expires_at: new Date("2026-09-02T10:15:00.000Z") }] };
    }
    return { rows: [] };
  }),
};

vi.mock("../db/transaction", () => ({
  withConnectedTransaction: vi.fn(async (callback: (value: typeof client) => Promise<unknown>) => callback(client)),
}));
vi.mock("../repositories/audit-repository", () => ({ recordAuditEntry: vi.fn() }));

import {
  createOwnTelegramLinkToken,
  validateOperatorPassword,
} from "../services/operator-account-service";

const actor = {
  operatorId: "operator_security_owner",
  role: "owner" as const,
  displayName: "Security Owner",
  organizationId: "org_security",
  requestId: "req-operator-link-token",
};

describe("operator account security contract", () => {
  beforeEach(() => {
    queries.length = 0;
    vi.clearAllMocks();
  });

  it.each(["short", ` ${"a".repeat(8)}`, `${"a".repeat(8)} `])(
    "returns the stable password-policy error for rejected password %j",
    (password) => {
      expect(() => validateOperatorPassword(password)).toThrowError(expect.objectContaining({
        code: "password_policy_violation",
        statusCode: 400,
      }));
    },
  );

  it("serializes token replacement and expires every prior active Telegram token before insert", async () => {
    const result = await createOwnTelegramLinkToken(actor);

    const lockIndex = queries.findIndex(({ sql }) => sql.includes("pg_advisory_xact_lock"));
    const expireIndex = queries.findIndex(({ sql }) => (
      sql.includes("UPDATE app.operator_identity_link_tokens")
      && sql.includes("consumed_at IS NULL")
      && sql.includes("expires_at > now()")
    ));
    const insertIndex = queries.findIndex(({ sql }) => sql.includes("INSERT INTO app.operator_identity_link_tokens"));

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(expireIndex).toBeGreaterThan(lockIndex);
    expect(insertIndex).toBeGreaterThan(expireIndex);
    expect(queries[lockIndex]?.values).toEqual([
      `operator-identity-link-token:${actor.operatorId}:telegram`,
    ]);
    expect(queries[expireIndex]?.values).toEqual([actor.operatorId]);
    expect(result.data.token).toMatch(/^tlg_[A-Za-z0-9_-]+$/);
    expect(result.data.expiresAt).toBe("2026-09-02T10:15:00.000Z");
  });
});
