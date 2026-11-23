import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectPlatformClient, type PoolClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import {
  createSignupRequest,
  verifySignupToken,
  provisionSignupTenant,
  TestEmailProvider,
  operatorIdFromEmail,
  merchantIdFromEmail,
  storeIdFromEmail,
  stockLocationIdFromEmail,
  normalizeEmail,
} from "../platform-db";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../db/migrations");
const migration002 = readFileSync(resolve(MIGRATIONS_DIR, "002_tenant_foundation_expand.sql"), "utf8");
const migration006 = readFileSync(resolve(MIGRATIONS_DIR, "006_signup_identity_and_verification.sql"), "utf8");
const TEST_EMAIL = "Owner.Signup+db@gmail.com";
const NORMALIZED_EMAIL = normalizeEmail(TEST_EMAIL);

let client: PoolClient;
let originalEnv: NodeJS.ProcessEnv;

function latestToken(provider: TestEmailProvider): string {
  const msg = provider.findByRecipient(NORMALIZED_EMAIL).at(-1);
  if (!msg) throw new Error("missing test email");
  const match = msg.text.match(/https?:\/\/[^\s]+/);
  if (!match) throw new Error(`missing token in ${msg.text}`);
  const url = new URL(match[0]);
  const token = new URLSearchParams(url.hash.replace(/^#/, "")).get("token") || url.searchParams.get("token");
  if (!token) throw new Error(`missing token in ${msg.text}`);
  return token;
}

function signupHeaders(key: string) {
  return { "idempotency-key": `signup-db:${key}` };
}

async function cleanup() {
  const merchantId = merchantIdFromEmail(NORMALIZED_EMAIL);
  const storeId = storeIdFromEmail(NORMALIZED_EMAIL);
  const slocId = stockLocationIdFromEmail(NORMALIZED_EMAIL);
  const operatorId = operatorIdFromEmail(NORMALIZED_EMAIL);
  await client.query("DELETE FROM app.email_delivery_attempts WHERE recipient_normalized_email = $1", [NORMALIZED_EMAIL]);
  await client.query("DELETE FROM app.signup_verification_tokens WHERE request_id IN (SELECT id FROM app.signup_requests WHERE normalized_email = $1)", [NORMALIZED_EMAIL]);
  await client.query("DELETE FROM app.signup_requests WHERE normalized_email = $1", [NORMALIZED_EMAIL]);
  await client.query("DELETE FROM audit.events WHERE subject_id = $1 OR actor_id = $2", [merchantId, operatorId]);
  await client.query("DELETE FROM app.subscription_events WHERE merchant_id = $1", [merchantId]);
  await client.query("DELETE FROM app.subscription_usage_reservations WHERE merchant_id = $1", [merchantId]);
  await client.query("DELETE FROM app.subscription_usage_buckets WHERE merchant_id = $1", [merchantId]);
  await client.query("DELETE FROM app.merchant_subscriptions WHERE merchant_id = $1", [merchantId]);
  await client.query("DELETE FROM app.operator_memberships WHERE operator_id = $1", [operatorId]);
  await client.query("DELETE FROM medusa.staff_users WHERE operator_id = $1", [operatorId]);
  await client.query("DELETE FROM app.stores WHERE id = $1", [storeId]);
  await client.query("DELETE FROM app.merchants WHERE id = $1", [merchantId]);
  await client.query("DELETE FROM public.stock_location WHERE id = $1", [slocId]);
  await client.query("DELETE FROM app.signup_rate_limit_buckets WHERE window_key LIKE '%' || $1 || '%'", [NORMALIZED_EMAIL]);
}

beforeAll(async () => {
  originalEnv = { ...process.env };
  process.env.PUBLIC_SIGNUP_ENABLED = "true";
  process.env.PUBLIC_SIGNUP_EMAIL_PROVIDER = "test";
  process.env.PUBLIC_APP_URL = "http://localhost:8080";
  process.env.SIGNUP_VERIFICATION_SECRET = randomBytes(32).toString("hex");
  process.env.PUBLIC_SIGNUP_EXPOSE_URL_IN_RESPONSE = "true";
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await client.query(migration002);
  await client.query(migration006);
}, 30000);

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup().catch(() => undefined);
  client.release();
  process.env = originalEnv;
  await shutdownPlatformDb().catch(() => undefined);
});

describe("public signup DB flow", () => {
  it("requires an explicit real IANA timezone before provisioning", async () => {
    const provider = new TestEmailProvider();
    await createSignupRequest({ email: TEST_EMAIL, password: "strong-password-123", requestIp: "127.0.0.7" }, provider);
    const token = latestToken(provider);
    const verified = await verifySignupToken(token, signupHeaders("timezone-verify"));

    await expect(provisionSignupTenant({
      token: verified.provisioningToken,
      merchantName: "Missing Time Merchant",
      storeName: "Missing Time Store",
      timezone: undefined as never,
    }, signupHeaders("timezone-missing"))).rejects.toMatchObject({
      code: "validation_error",
      statusCode: 400,
      details: { field: "timezone" },
    });
    await expect(provisionSignupTenant({
      token: verified.provisioningToken,
      merchantName: "Invalid Time Merchant",
      storeName: "Invalid Time Store",
      timezone: "Mars/Olympus_Mons",
    }, signupHeaders("timezone-invalid"))).rejects.toMatchObject({
      code: "validation_error",
      statusCode: 400,
      details: { field: "timezone" },
    });
  });

  it("requires verification before provisioning", async () => {
    const provider = new TestEmailProvider();
    const created = await createSignupRequest({ email: TEST_EMAIL, password: "strong-password-123", requestIp: "127.0.0.9" }, provider);
    const token = latestToken(provider);
    expect(created.status).toBe("pending");
    await expect(provisionSignupTenant({
      token,
      merchantName: "Blocked Merchant",
      storeName: "Blocked Store",
      timezone: "Asia/Ho_Chi_Minh",
    }, signupHeaders("not-verified"))).rejects.toMatchObject({ code: "invalid_token", statusCode: 400 });
  });

  it("rejects provisioning when the consumed verification token has expired", async () => {
    const provider = new TestEmailProvider();
    await createSignupRequest({ email: TEST_EMAIL, password: "strong-password-123", requestIp: "127.0.0.10" }, provider);
    const token = latestToken(provider);
    const verified = await verifySignupToken(token, signupHeaders("expiry-verify"));
    await client.query(`
      UPDATE app.signup_verification_tokens
      SET expires_at = now() - interval '1 second'
      WHERE request_id = (SELECT id FROM app.signup_requests WHERE normalized_email = $1)
    `, [NORMALIZED_EMAIL]);

    await expect(provisionSignupTenant({
      token: verified.provisioningToken,
      merchantName: "Expired Token Merchant",
      storeName: "Expired Token Store",
      timezone: "Asia/Ho_Chi_Minh",
    }, signupHeaders("expiry-provision"))).rejects.toMatchObject({ code: "token_expired", statusCode: 410 });

    const merchantId = merchantIdFromEmail(NORMALIZED_EMAIL);
    const counts = await client.query<{ merchants: string; users: string }>(`
      SELECT
        (SELECT count(*)::text FROM app.merchants WHERE id = $1) AS merchants,
        (SELECT count(*)::text FROM medusa.staff_users WHERE operator_id = $2) AS users
    `, [merchantId, operatorIdFromEmail(NORMALIZED_EMAIL)]);
    expect(counts.rows[0]).toEqual({ merchants: "0", users: "0" });
  });

  it("atomically provisions Basic tenant and replay returns the same rows", async () => {
    const provider = new TestEmailProvider();
    await createSignupRequest({ email: TEST_EMAIL, password: "strong-password-123", requestIp: "127.0.0.8" }, provider);
    const token = latestToken(provider);
    const verified = await verifySignupToken(token, signupHeaders("success-verify"));

    const provisionInput = { token: verified.provisioningToken, merchantName: "DB Signup Merchant", storeName: "DB Signup Store", timezone: "Asia/Ho_Chi_Minh" };
    const first = await provisionSignupTenant(provisionInput, signupHeaders("success-provision"));
    const second = await provisionSignupTenant(provisionInput, signupHeaders("success-provision"));

    expect(second).toEqual(first);
    await expect(
      provisionSignupTenant({
        token: `${first.requestId}.forged`,
        merchantName: "DB Signup Merchant",
        storeName: "DB Signup Store",
        timezone: "Asia/Ho_Chi_Minh",
      }, signupHeaders("forged")),
    ).rejects.toThrow(/Invalid provisioning token/i);
    expect(first.operatorId).toBe(operatorIdFromEmail(NORMALIZED_EMAIL));
    await ensurePlatformSchema();

    const counts = await client.query<{
      merchants: string;
      stores: string;
      users: string;
      memberships: string;
      leakedDefaultStoreMemberships: string;
      subscriptions: string;
      timeZone: string | null;
    }>(`
      SELECT
        (SELECT count(*)::text FROM app.merchants WHERE id = $1) AS merchants,
        (SELECT count(*)::text FROM app.stores WHERE id = $2 AND is_primary = true) AS stores,
        (SELECT count(*)::text FROM medusa.staff_users WHERE operator_id = $3 AND role = 'owner') AS users,
        (SELECT count(*)::text FROM app.operator_memberships WHERE operator_id = $3 AND role_key = 'owner') AS memberships,
        (SELECT count(*)::text FROM app.operator_memberships WHERE operator_id = $3 AND merchant_id = 'merchant_default') AS "leakedDefaultStoreMemberships",
        (SELECT count(*)::text FROM app.merchant_subscriptions WHERE merchant_id = $1 AND package_key = 'basic') AS subscriptions,
        (SELECT metadata->'ownerSettings'->>'timezone' FROM app.stores WHERE id = $2) AS "timeZone"
    `, [first.merchantId, first.storeId, first.operatorId]);

    expect(counts.rows[0]).toEqual({
      merchants: "1",
      stores: "1",
      users: "1",
      memberships: "1",
      leakedDefaultStoreMemberships: "0",
      subscriptions: "1",
      timeZone: "Asia/Ho_Chi_Minh",
    });
  }, 30000);
});
