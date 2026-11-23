import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import { loginOperator } from "../services/auth-service";

const accountPrefix = `unknown_login_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const requestPrefix = `auth-login-db-${Date.now()}`;
const testJwtSecret = "auth-login-db-test-secret-at-least-thirty-two-characters";
const originalEnvironment = {
  jwtSecret: process.env.JWT_SECRET,
  trustProxy: process.env.RATE_LIMIT_TRUST_PROXY_HEADERS,
  delayEnabled: process.env.LOGIN_FAILURE_DELAY_ENABLED,
  failureWindow: process.env.LOGIN_FAILURE_WINDOW_SECONDS,
  threshold: process.env.LOGIN_BACKOFF_THRESHOLD,
  baseSeconds: process.env.LOGIN_BACKOFF_BASE_SECONDS,
  maxSeconds: process.env.LOGIN_BACKOFF_MAX_SECONDS,
};

let client: PoolClient;

function identityHash(kind: "account" | "ip", value: string): string {
  return createHmac("sha256", testJwtSecret).update(`${kind}:${value}`).digest("hex");
}

function requestHeaders(ip: string, suffix: string) {
  return {
    "x-real-ip": ip,
    "x-request-id": `${requestPrefix}-${suffix}`,
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function cleanup(): Promise<void> {
  await client.query(
    "DELETE FROM app.auth_login_failures WHERE account_hash = ANY($1::text[])",
    [[
      identityHash("account", accountPrefix.toLowerCase()),
      identityHash("account", "op_owner"),
    ]],
  );
  await client.query("DELETE FROM audit.events WHERE request_id LIKE $1", [`${requestPrefix}%`]);
}

beforeAll(async () => {
  process.env.JWT_SECRET = testJwtSecret;
  process.env.RATE_LIMIT_TRUST_PROXY_HEADERS = "true";
  process.env.LOGIN_FAILURE_DELAY_ENABLED = "false";
  process.env.LOGIN_FAILURE_WINDOW_SECONDS = "900";
  process.env.LOGIN_BACKOFF_THRESHOLD = "100";
  process.env.LOGIN_BACKOFF_BASE_SECONDS = "1";
  process.env.LOGIN_BACKOFF_MAX_SECONDS = "1";
  await ensurePlatformSchema();
  client = await connectPlatformClient();
});

beforeEach(async () => {
  await cleanup();
  process.env.LOGIN_BACKOFF_THRESHOLD = "100";
});

afterAll(async () => {
  if (client) {
    await cleanup().catch(() => undefined);
    client.release();
  }
  restoreEnvironment("JWT_SECRET", originalEnvironment.jwtSecret);
  restoreEnvironment("RATE_LIMIT_TRUST_PROXY_HEADERS", originalEnvironment.trustProxy);
  restoreEnvironment("LOGIN_FAILURE_DELAY_ENABLED", originalEnvironment.delayEnabled);
  restoreEnvironment("LOGIN_FAILURE_WINDOW_SECONDS", originalEnvironment.failureWindow);
  restoreEnvironment("LOGIN_BACKOFF_THRESHOLD", originalEnvironment.threshold);
  restoreEnvironment("LOGIN_BACKOFF_BASE_SECONDS", originalEnvironment.baseSeconds);
  restoreEnvironment("LOGIN_BACKOFF_MAX_SECONDS", originalEnvironment.maxSeconds);
  await shutdownPlatformDb().catch(() => undefined);
});

describe("DB-backed login hardening", () => {
  it("atomically counts concurrent failures for one canonical account/IP pair", async () => {
    const attempts = 8;
    const results = await Promise.allSettled(Array.from({ length: attempts }, (_, index) => (
      loginOperator(
        { operatorId: accountPrefix, password: `wrong-password-${index}` },
        requestHeaders("198.51.100.10", `concurrent-${index}`),
      )
    )));

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "unauthorized", statusCode: 401 });
      }
    }

    const row = await client.query<{ attempt_count: number; account_hash: string; ip_hash: string }>(`
      SELECT attempt_count, account_hash, ip_hash
      FROM app.auth_login_failures
      WHERE account_hash = $1 AND ip_hash = $2
    `, [
      identityHash("account", accountPrefix.toLowerCase()),
      identityHash("ip", "198.51.100.10"),
    ]);
    expect(row.rows[0]).toEqual({
      attempt_count: attempts,
      account_hash: identityHash("account", accountPrefix.toLowerCase()),
      ip_hash: identityHash("ip", "198.51.100.10"),
    });
    expect(JSON.stringify(row.rows[0])).not.toContain(accountPrefix);
  }, 15_000);

  it("blocks at the threshold and does not increment the durable counter while blocked", async () => {
    process.env.LOGIN_BACKOFF_THRESHOLD = "2";
    const ip = "198.51.100.11";
    await expect(loginOperator(
      { operatorId: accountPrefix, password: "wrong-password-1" },
      requestHeaders(ip, "backoff-1"),
    )).rejects.toMatchObject({ code: "unauthorized", statusCode: 401 });
    await expect(loginOperator(
      { operatorId: accountPrefix, password: "wrong-password-2" },
      requestHeaders(ip, "backoff-2"),
    )).rejects.toMatchObject({ code: "rate_limited", statusCode: 429 });
    await expect(loginOperator(
      { operatorId: accountPrefix, password: "wrong-password-3" },
      requestHeaders(ip, "backoff-3"),
    )).rejects.toMatchObject({ code: "rate_limited", statusCode: 429 });

    const failure = await client.query<{ attempt_count: number; blocked: boolean }>(`
      SELECT attempt_count, blocked_until > now() AS blocked
      FROM app.auth_login_failures
      WHERE account_hash = $1 AND ip_hash = $2
    `, [identityHash("account", accountPrefix.toLowerCase()), identityHash("ip", ip)]);
    expect(failure.rows[0]).toEqual({ attempt_count: 2, blocked: true });

    const audit = await client.query<{ action: string }>(`
      SELECT action
      FROM audit.events
      WHERE request_id LIKE $1
      ORDER BY created_at
    `, [`${requestPrefix}-backoff-%`]);
    expect(audit.rows.map((row) => row.action)).toEqual([
      "auth.login_failed",
      "auth.login_failed",
      "auth.login_blocked",
    ]);
  }, 10_000);
});
