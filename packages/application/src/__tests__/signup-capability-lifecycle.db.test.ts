import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectPlatformClient, type PoolClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import {
  createSignupRequest,
  merchantIdFromEmail,
  normalizeEmail,
  operatorIdFromEmail,
  provisionSignupTenant,
  resendVerificationEmail,
  shutdownPlatformDb,
  stockLocationIdFromEmail,
  storeIdFromEmail,
  TestEmailProvider,
  verifySignupToken,
} from "../platform-db";

const TEST_EMAIL = "signup-capability-v19@example.test";
const NORMALIZED_EMAIL = normalizeEmail(TEST_EMAIL);
let client: PoolClient;
let originalEnv: NodeJS.ProcessEnv;

function headers(key: string) {
  return { "idempotency-key": `signup-capability:${key}` };
}

function latestVerificationToken(provider: TestEmailProvider): string {
  const message = provider.findByRecipient(NORMALIZED_EMAIL).at(-1);
  if (!message) throw new Error("missing signup email");
  const match = message.text.match(/https?:\/\/[^\s]+/);
  if (!match) throw new Error("missing verification URL");
  const url = new URL(match[0]);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const token = fragment.get("token") || url.searchParams.get("token");
  if (!token) throw new Error("missing verification token");
  return token;
}

async function cleanup() {
  const merchantId = merchantIdFromEmail(NORMALIZED_EMAIL);
  const storeId = storeIdFromEmail(NORMALIZED_EMAIL);
  const operatorId = operatorIdFromEmail(NORMALIZED_EMAIL);
  const stockLocationId = stockLocationIdFromEmail(NORMALIZED_EMAIL);
  await client.query("DELETE FROM app.idempotency_records WHERE tenant_id IN (SELECT id FROM app.signup_requests WHERE normalized_email = $1)", [NORMALIZED_EMAIL]);
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
  await client.query("DELETE FROM public.stock_location WHERE id = $1", [stockLocationId]);
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
}, 30_000);

beforeEach(async () => cleanup());

afterAll(async () => {
  await cleanup().catch(() => undefined);
  client?.release();
  process.env = originalEnv;
  await shutdownPlatformDb().catch(() => undefined);
});

describe("signup purpose-bound capabilities", () => {
  it("separates verification from provisioning and binds exact retries", async () => {
    const provider = new TestEmailProvider();
    await createSignupRequest({ email: TEST_EMAIL, password: "strong-password-123", requestIp: "127.0.0.31" }, provider);
    const verificationToken = latestVerificationToken(provider);
    const verified = await verifySignupToken(verificationToken, headers("verify"));
    expect(verified.provisioningToken).toBeTruthy();
    expect(verified.provisioningToken).not.toBe(verificationToken);
    await expect(verifySignupToken(verificationToken, headers("verify"))).resolves.toEqual(verified);
    await expect(verifySignupToken(verificationToken, headers("different-verify")))
      .rejects.toMatchObject({ code: "token_already_used", statusCode: 409 });

    const provisionInput = {
      token: verified.provisioningToken,
      merchantName: "Capability Merchant",
      storeName: "Capability Store",
      timezone: "Asia/Ho_Chi_Minh",
    };
    const first = await provisionSignupTenant(provisionInput, headers("provision"));
    await expect(provisionSignupTenant(provisionInput, headers("provision"))).resolves.toEqual(first);
    await expect(provisionSignupTenant(provisionInput, headers("different-provision")))
      .rejects.toMatchObject({ code: "token_already_used", statusCode: 409 });
  });

  it("supersedes an old verification token without affecting the new token", async () => {
    const provider = new TestEmailProvider();
    await createSignupRequest({ email: TEST_EMAIL, password: "strong-password-123", requestIp: "127.0.0.32" }, provider);
    const oldToken = latestVerificationToken(provider);
    await client.query("UPDATE app.signup_requests SET created_at = now() - interval '10 minutes' WHERE normalized_email = $1", [NORMALIZED_EMAIL]);
    await resendVerificationEmail(TEST_EMAIL, provider);
    const newToken = latestVerificationToken(provider);
    expect(newToken).not.toBe(oldToken);
    await expect(verifySignupToken(oldToken, headers("old")))
      .rejects.toMatchObject({ code: "token_already_used", statusCode: 409 });
    await expect(verifySignupToken(newToken, headers("new")))
      .resolves.toMatchObject({ status: "verified", provisioningToken: expect.any(String) });
  });

  it("allows only one concurrent provisioning capability consumer", async () => {
    const provider = new TestEmailProvider();
    await createSignupRequest({ email: TEST_EMAIL, password: "strong-password-123", requestIp: "127.0.0.33" }, provider);
    const verified = await verifySignupToken(latestVerificationToken(provider), headers("verify-concurrent"));
    const input = {
      token: verified.provisioningToken,
      merchantName: "Concurrent Capability Merchant",
      storeName: "Concurrent Capability Store",
      timezone: "Asia/Ho_Chi_Minh",
    };
    const results = await Promise.allSettled([
      provisionSignupTenant(input, headers("concurrent-a")),
      provisionSignupTenant(input, headers("concurrent-b")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ code: "token_already_used", statusCode: 409 });
    }
  });
});
