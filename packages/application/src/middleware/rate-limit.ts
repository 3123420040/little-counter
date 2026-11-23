import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { PlatformError } from "../errors/platform-error";
import { headerValue, type HeadersLike } from "../http/headers";

export type RateLimitScope = "auth" | "checkout" | "ai" | "default";
export type RateLimitSubject = {
  kind: "account" | "operator" | "channel";
  id: string;
};

type RateLimitBucket = { count: number; resetAt: number; touchedAt: number };

const rateLimitBuckets = new Map<string, RateLimitBucket>();
let operationsSinceSweep = 0;

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value || fallback);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function normalizeIpCandidate(value: string): string | null {
  const candidate = value.trim();
  if (!candidate || candidate.length > 45 || candidate.includes(",")) return null;
  return isIP(candidate) ? candidate.toLowerCase() : null;
}

export function trustedClientIp(headers: HeadersLike): string | null {
  if (process.env.RATE_LIMIT_TRUST_PROXY_HEADERS !== "true") return null;
  return normalizeIpCandidate(headerValue(headers, "x-real-ip"));
}

/**
 * Stable limiter identity supplied by the trusted edge. Arbitrary forwarded
 * chains are never accepted directly from an untrusted request.
 */
export function rateLimitClientIpIdentity(headers: HeadersLike): string {
  if (process.env.RATE_LIMIT_TRUST_PROXY_HEADERS !== "true") return "untrusted-proxy";
  return trustedClientIp(headers) || "unknown";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function normalizedSubject(subject?: RateLimitSubject): string {
  if (!subject) return "public";
  const id = subject.id.trim().toLowerCase().slice(0, 256);
  return id ? `${subject.kind}:${digest(id)}` : "public";
}

function sweepBuckets(now: number, maximumBuckets: number): void {
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }
  while (rateLimitBuckets.size >= maximumBuckets) {
    let oldestKey: string | undefined;
    let oldestTouchedAt = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of rateLimitBuckets) {
      if (bucket.touchedAt < oldestTouchedAt) {
        oldestKey = key;
        oldestTouchedAt = bucket.touchedAt;
      }
    }
    if (!oldestKey) break;
    rateLimitBuckets.delete(oldestKey);
  }
}

function limitForScope(scope: RateLimitScope): number {
  if (scope === "auth") return boundedInteger(process.env.AUTH_RATE_LIMIT, 20, 1, 100_000);
  if (scope === "checkout") return boundedInteger(process.env.CHECKOUT_RATE_LIMIT, 120, 1, 100_000);
  if (scope === "ai") return boundedInteger(process.env.AI_RATE_LIMIT, 120, 1, 100_000);
  return boundedInteger(process.env.API_RATE_LIMIT, 300, 1, 100_000);
}

function consumeBucket(key: string, limit: number, now: number, windowMs: number, maximumBuckets: number): void {
  if (rateLimitBuckets.size >= maximumBuckets) sweepBuckets(now, maximumBuckets);
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs, touchedAt: now });
    return;
  }
  bucket.count += 1;
  bucket.touchedAt = now;
  if (bucket.count > limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));
    throw new PlatformError("rate_limited", "Too many requests", 429, { retryAfterSeconds });
  }
}

export function enforceRateLimit(
  headers: HeadersLike,
  scope: RateLimitScope = "default",
  subject?: RateLimitSubject,
): void {
  const windowMs = boundedInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000, 1_000, 3_600_000);
  const maximumBuckets = boundedInteger(process.env.RATE_LIMIT_MAX_BUCKETS, 10_000, 100, 1_000_000);
  const sweepInterval = boundedInteger(process.env.RATE_LIMIT_SWEEP_INTERVAL, 100, 1, 10_000);
  const now = Date.now();

  operationsSinceSweep += 1;
  if (operationsSinceSweep >= sweepInterval || rateLimitBuckets.size >= maximumBuckets) {
    sweepBuckets(now, maximumBuckets);
    operationsSinceSweep = 0;
  }

  const ipHash = digest(rateLimitClientIpIdentity(headers));
  if (scope === "auth") {
    if (subject) {
      consumeBucket(
        `auth:${normalizedSubject(subject)}`,
        boundedInteger(process.env.AUTH_ACCOUNT_RATE_LIMIT, limitForScope(scope), 1, 100_000),
        now,
        windowMs,
        maximumBuckets,
      );
    }
    consumeBucket(
      `auth:ip:${ipHash}`,
      boundedInteger(process.env.AUTH_IP_RATE_LIMIT, Math.max(100, limitForScope(scope) * 5), 1, 1_000_000),
      now,
      windowMs,
      maximumBuckets,
    );
    return;
  }
  consumeBucket(
    `${scope}:${normalizedSubject(subject)}:ip:${ipHash}`,
    limitForScope(scope),
    now,
    windowMs,
    maximumBuckets,
  );
}

export function resetRateLimitStateForTests(): void {
  rateLimitBuckets.clear();
  operationsSinceSweep = 0;
}

export function rateLimitBucketCountForTests(): number {
  return rateLimitBuckets.size;
}
