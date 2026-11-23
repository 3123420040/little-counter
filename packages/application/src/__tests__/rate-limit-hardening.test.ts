import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enforceRateLimit,
  rateLimitBucketCountForTests,
  rateLimitClientIpIdentity,
  resetRateLimitStateForTests,
  trustedClientIp,
} from "../middleware/rate-limit";

const originalEnv = { ...process.env };

describe("rate-limit identity hardening", () => {
  beforeEach(() => {
    process.env.AUTH_RATE_LIMIT = "2";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    process.env.RATE_LIMIT_TRUST_PROXY_HEADERS = "true";
    process.env.AUTH_ACCOUNT_RATE_LIMIT = "2";
    process.env.AUTH_IP_RATE_LIMIT = "100";
    process.env.RATE_LIMIT_MAX_BUCKETS = "100";
    process.env.RATE_LIMIT_SWEEP_INTERVAL = "1";
    resetRateLimitStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
    resetRateLimitStateForTests();
  });

  it("does not let arbitrary Authorization rotation reset an auth budget", () => {
    const ip = "192.0.2.73";
    const subject = { kind: "account" as const, id: " owner " };
    enforceRateLimit({ authorization: "Bearer attacker-a", "x-real-ip": ip }, "auth", subject);
    enforceRateLimit({ authorization: "Bearer attacker-b", "x-real-ip": ip }, "auth", subject);

    expect(() => enforceRateLimit(
      { authorization: "Bearer attacker-c", "x-real-ip": ip },
      "auth",
      { kind: "account", id: "OWNER" },
    )).toThrowError(expect.objectContaining({ code: "rate_limited", statusCode: 429 }));
  });

  it("uses only the trusted edge-overwritten client address", () => {
    expect(rateLimitClientIpIdentity({
      "x-real-ip": "203.0.113.10",
      "x-forwarded-for": "198.51.100.200, 192.0.2.20",
    })).toBe("203.0.113.10");
  });

  it("ignores spoofed addresses outside the trusted edge", () => {
    process.env.RATE_LIMIT_TRUST_PROXY_HEADERS = "false";
    expect(rateLimitClientIpIdentity({ "x-real-ip": "203.0.113.10" })).toBe("untrusted-proxy");
    expect(trustedClientIp({ "x-real-ip": "203.0.113.10" })).toBeNull();
  });

  it("rejects malformed or chained trusted-edge address values", () => {
    expect(trustedClientIp({ "x-real-ip": "203.0.113.10, 198.51.100.20" })).toBeNull();
    expect(trustedClientIp({ "x-real-ip": "not-an-ip" })).toBeNull();
    expect(trustedClientIp({ "x-real-ip": "2001:DB8::1" })).toBe("2001:db8::1");
  });

  it("keeps the in-memory limiter cardinality bounded and evicts expired entries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T00:00:00Z"));
    for (let index = 0; index < 150; index += 1) {
      enforceRateLimit(
        { "x-real-ip": `192.0.2.${(index % 250) + 1}` },
        "default",
        { kind: "account", id: `account-${index}` },
      );
    }
    expect(rateLimitBucketCountForTests()).toBeLessThanOrEqual(100);
    vi.advanceTimersByTime(60_001);
    enforceRateLimit({ "x-real-ip": "198.51.100.1" }, "default");
    expect(rateLimitBucketCountForTests()).toBe(1);
  });
});
