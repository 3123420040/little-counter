import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResendProvider, RESEND_USER_AGENT } from "../email/resend-adapter";
import type { TransactionalEmailMessage } from "../email/provider";

type FetchCall = {
  url: string;
  init: RequestInit;
};

function okResponse(id: string): Response {
  return new Response(JSON.stringify({ id }), { status: 200 });
}

function buildMessage(overrides: Partial<TransactionalEmailMessage> = {}): TransactionalEmailMessage {
  return {
    to: "owner@example.com",
    subject: "Subscription renewal reminder",
    text: "Your subscription renews soon.",
    html: "<p>Your subscription renews soon.</p>",
    templateKey: "subscription.renewal_reminder",
    idempotencyKey: "subscription-abc",
    ...overrides,
  };
}

describe("ResendProvider adapter", () => {
  let calls: FetchCall[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv("TRANSACTIONAL_EMAIL_FROM", "Example Store <no-reply@example.test>");
    vi.stubEnv("TRANSACTIONAL_EMAIL_REPLY_TO", "support@example.test");
    calls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init || {} });
      return okResponse("msg_123");
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("forwards a stable Idempotency-Key on send", async () => {
    const provider = new ResendProvider("test-key");
    await provider.send(buildMessage());

    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("subscription-abc");
  });

  it("reuses the same key for retries of the same rendered notification", async () => {
    const provider = new ResendProvider("test-key");
    const message = buildMessage({ idempotencyKey: "subscription-renewal-key" });

    // Simulate an accepted first request whose response is lost and retried.
    await provider.send(message);
    await provider.send(message);

    expect(calls).toHaveLength(2);
    const firstKey = (calls[0].init.headers as Record<string, string>)["Idempotency-Key"];
    const secondKey = (calls[1].init.headers as Record<string, string>)["Idempotency-Key"];
    expect(firstKey).toBe("subscription-renewal-key");
    expect(secondKey).toBe(firstKey);
  });

  it("produces a different key for a different notification payload/event", async () => {
    const provider = new ResendProvider("test-key");
    await provider.send(buildMessage({ idempotencyKey: "subscription-renewal-key" }));
    await provider.send(buildMessage({ idempotencyKey: "subscription-upgrade-key" }));

    expect(calls).toHaveLength(2);
    const firstKey = (calls[0].init.headers as Record<string, string>)["Idempotency-Key"];
    const secondKey = (calls[1].init.headers as Record<string, string>)["Idempotency-Key"];
    expect(firstKey).not.toBe(secondKey);
  });

  it("sends a non-secret User-Agent header with every request", async () => {
    const provider = new ResendProvider("test-key");
    await provider.send(buildMessage());

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(RESEND_USER_AGENT);
    expect(headers["User-Agent"]).not.toContain("test-key");
  });

  it("posts to the canonical endpoint with from/reply_to and the rendered body", async () => {
    const provider = new ResendProvider("test-key");
    const result = await provider.send(buildMessage({ idempotencyKey: "subscription-key" }));

    expect(calls[0].url).toBe("https://api.resend.com/emails");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.from).toBe("Example Store <no-reply@example.test>");
    expect(body.reply_to).toBe("support@example.test");
    expect(body.to).toEqual(["owner@example.com"]);
    expect(result.status).toBe("sent");
    expect(result.messageId).toBe("msg_123");
  });

  it("omits the Idempotency-Key header when no key is supplied", async () => {
    const provider = new ResendProvider("test-key");
    await provider.send(buildMessage({ idempotencyKey: undefined }));

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("fails closed without an API key and performs no network call", async () => {
    const provider = new ResendProvider("");
    const result = await provider.send(buildMessage());

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("RESEND_NO_API_KEY");
    expect(calls).toHaveLength(0);
  });

  it("requires a configured sender before making a delivery attempt", async () => {
    vi.stubEnv("TRANSACTIONAL_EMAIL_FROM", "");
    const result = await new ResendProvider("test-key").send(buildMessage());
    expect(result.errorCode).toBe("RESEND_NO_SENDER");
    expect(calls).toHaveLength(0);
  });

  it("classifies a 5xx response as deferred (retryable, at-least-once)", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ name: "rate_limit", message: "slow down" }), { status: 503 })) as unknown as typeof globalThis.fetch;
    const provider = new ResendProvider("test-key");
    const result = await provider.send(buildMessage());

    expect(result.status).toBe("deferred");
  });

  it("keeps the secret out of request headers other than Authorization", async () => {
    const provider = new ResendProvider("secret-value");
    await provider.send(buildMessage());

    const headers = calls[0].init.headers as Record<string, string>;
    const serialized = JSON.stringify(headers) + String(calls[0].init.body);
    // The bearer token appears exactly once (Authorization); nowhere else.
    const matches = serialized.match(/secret-value/g) || [];
    expect(matches).toHaveLength(1);
  });
});
