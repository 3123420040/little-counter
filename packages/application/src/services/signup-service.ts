// ═══════════════════════════════════════════════════════
// Public Signup Service — request, verify, atomic provision
//
// Invariants:
//   - One signup request per normalized email (DB unique index).
//   - Verification tokens are one-time, hashed (sha256), short-lived.
//   - Provisioning is idempotent: a retry returns the same merchant.
//   - Unverified identities cannot provision or login as owner.
//   - New tenant sees no demo/legacy merchant data.
//   - Existing operatorId staff login remains unchanged.
// ═══════════════════════════════════════════════════════

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ensurePlatformSchema, shouldRunPlatformSchemaBootstrap } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import { withScopedIdempotency } from "../db/idempotency";
import type { PoolClient } from "../db/client";
import { queryOne } from "../db/query";
import { PlatformError } from "../errors/platform-error";
import { headerValue, type HeadersLike } from "../http/headers";
import { hashPassword } from "../middleware/auth";
import { id } from "../utils/id";
import type {
  TransactionalEmailProvider,
  TransactionalEmailMessage,
  DeliveryResult,
} from "../email/provider";
import {
  renderTemplate,
  type EmailTemplateKey,
} from "../email/templates";

// ── Configuration ────────────────────────────────────────

const DEFAULT_TERMS_VERSION = "1.1.2-terms-v1";

function verificationTtlMs(): number {
  const minutes = Number(process.env.SIGNUP_VERIFICATION_TTL_MINUTES || 1440);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 24 * 60 * 60_000;
}

function provisioningTtlMs(): number {
  const minutes = Number(process.env.SIGNUP_PROVISIONING_TTL_MINUTES || 30);
  return Number.isFinite(minutes) && minutes > 0 && minutes <= 120
    ? minutes * 60_000
    : 30 * 60_000;
}

function resendCooldownMs(): number {
  const seconds = Number(process.env.SIGNUP_RESEND_COOLDOWN_SECONDS || 300);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 300_000;
}

function emailRateLimitPerHour(): number {
  const v = Number(process.env.SIGNUP_EMAIL_RATE_LIMIT_PER_HOUR || 5);
  return Number.isInteger(v) && v > 0 ? v : 5;
}

function ipRateLimitPerHour(): number {
  const v = Number(process.env.SIGNUP_IP_RATE_LIMIT_PER_HOUR || 20);
  return Number.isInteger(v) && v > 0 ? v : 20;
}

function publicSignupEnabled(): boolean {
  return process.env.PUBLIC_SIGNUP_ENABLED === "true";
}

function publicAppUrl(): string {
  return (process.env.PUBLIC_APP_URL || "http://localhost:8080").replace(/\/$/, "");
}

function verificationSecret(): string {
  const v = process.env.SIGNUP_VERIFICATION_SECRET || "";
  if (!v || v.length < 32) {
    // In test/local we fall back to a deterministic non-production secret
    return process.env.NODE_ENV === "production"
      ? ""
      : "dev-signup-verification-secret-min-32-chars";
  }
  return v;
}

function requirePublicSignupEnabled(): void {
  if (!publicSignupEnabled()) {
    throw new PlatformError("public_signup_disabled", "Public signup is not enabled", 403);
  }
}

// ── Email normalization & password validation ───────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  const trimmed = (raw || "").trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) {
    throw new PlatformError("validation_error", "A valid email address is required", 400, { field: "email" });
  }
  if (trimmed.length > 254) {
    throw new PlatformError("validation_error", "Email is too long", 400, { field: "email" });
  }
  // Gmail-style canonicalization: drop dots and +tags in the local part
  const [localRaw, domain] = trimmed.split("@");
  let local = localRaw;
  if (["gmail.com", "googlemail.com"].includes(domain)) {
    local = local.replace(/\./g, "").split("+")[0];
  }
  return `${local}@${domain}`;
}

export function hashEmailForLookup(normalizedEmail: string): string {
  // Used for soft secondary uniqueness checks; not the canonical unique key
  return createHash("sha256").update(normalizedEmail).digest("hex");
}

export function validatePassword(raw: string): void {
  if (typeof raw !== "string" || raw.length < 10) {
    throw new PlatformError("validation_error", "Password must be at least 10 characters", 400, { field: "password" });
  }
  if (raw.length > 200) {
    throw new PlatformError("validation_error", "Password is too long", 400, { field: "password" });
  }
}

// ── Token generation & hashing ──────────────────────────

export interface VerificationToken {
  /** Opaque token returned to caller (or embedded in verify URL). Never stored. */
  token: string;
  /** Public request id bound to this token. */
  requestId: string;
}

export function generateVerificationToken(requestId: string): VerificationToken {
  const raw = randomBytes(32).toString("hex");
  // Token is a deterministic envelope: requestId + random secret. This lets
  // us look up the request without leaking it. The request_id is NOT a store
  // of permissions or accessible store lists — it is the public request id.
  const token = `${requestId}.${raw}`;
  return { token, requestId };
}

export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqualHash(token: string, expectedHash: string): boolean {
  const a = Buffer.from(hashVerificationToken(token), "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requireSignupIdempotencyKey(headers: HeadersLike): string {
  const key = headerValue(headers, "idempotency-key").trim();
  if (!key) {
    throw new PlatformError("idempotency_key_required", "Idempotency-Key header is required", 400);
  }
  if (key.length > 200) {
    throw new PlatformError("validation_error", "Idempotency-Key is too long", 400);
  }
  return key;
}

function hashSignupIdempotencyKey(key: string): string {
  return createHash("sha256").update(`signup:${key}`).digest("hex");
}

function tokenRequestId(token: string): string {
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0 || dotIndex >= token.length - 1) {
    throw new PlatformError("invalid_token", "Invalid token", 400);
  }
  const requestId = token.slice(0, dotIndex);
  if (!/^sur_[A-Za-z0-9_-]+$/.test(requestId) || requestId.length > 120) {
    throw new PlatformError("invalid_token", "Invalid token", 400);
  }
  return requestId;
}

function tokenExpired(expiresAt: Date, nowMs = Date.now()): boolean {
  return expiresAt.getTime() <= nowMs;
}

// ── Rate limiting ───────────────────────────────────────

interface RateLimitState {
  attempts: number;
  limit: number;
  retryAfterSeconds: number;
}

async function consumeRateLimit(
  client: PoolClient,
  windowType: "email" | "ip",
  windowKey: string,
  limit: number,
): Promise<RateLimitState> {
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setUTCMinutes(0, 0, 0);
  const windowEnd = new Date(windowStart.getTime() + 60 * 60_000); // 1 hour window
  // Upsert on the unique (window_key, window_type, window_start). Since the
  // window_start is the current hour boundary in ms, a new hour = new row.
  const result = await queryOne<{ attempt_count: number; window_end: Date }>(client, `
    WITH upsert AS (
      INSERT INTO app.signup_rate_limit_buckets (window_key, window_type, attempt_count, window_start, window_end)
      VALUES ($1, $2, 1, $3, $4)
      ON CONFLICT (window_key, window_type, window_start)
      DO UPDATE SET attempt_count = app.signup_rate_limit_buckets.attempt_count + 1
      RETURNING attempt_count, window_end
    )
    SELECT attempt_count, window_end FROM upsert
  `, [windowKey, windowType, windowStart, windowEnd]);

  const attempts = result?.attempt_count ?? 1;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(((result?.window_end?.getTime?.() ?? windowEnd.getTime()) - Date.now()) / 1000),
  );

  if (attempts > limit) {
    throw new PlatformError(
      "rate_limited",
      `Too many signup attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`,
      429,
      { retryAfterSeconds, windowType, limit },
    );
  }

  return { attempts, limit, retryAfterSeconds };
}

// ── Delivery metadata persistence ───────────────────────

async function recordDeliveryAttempt(
  client: PoolClient,
  input: {
    provider: string;
    request_id: string | null;
    template_key: string;
    recipient_normalized_email: string;
    result: DeliveryResult;
  },
): Promise<void> {
  const status: "queued" | "sent" | "delivered" | "bounced" | "failed" | "deferred" =
    input.result.status === "sent" ? "sent" : (input.result.status as "failed" | "deferred");
  await client.query(`
    INSERT INTO app.email_delivery_attempts (
      provider, request_id, template_key, recipient_normalized_email,
      status, provider_message_id, provider_response_code,
      error_code, error_message, sent_at, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $5 = 'sent' THEN now() ELSE NULL END, '{}'::jsonb)
  `, [
    input.provider,
    input.request_id ?? null,
    input.template_key,
    input.recipient_normalized_email,
    status,
    input.result.messageId ?? null,
    input.result.responseCode ?? null,
    input.result.errorCode ?? null,
    // Truncate error message; never store full body or API key
    (input.result.errorMessage ?? "").slice(0, 500),
  ]);
}

// ── Service inputs / outputs ────────────────────────────

export interface SignupRequestInput {
  email: string;
  password: string;
  requestIp?: string;
  userAgent?: string;
  termsVersion?: string;
}

export interface SignupRequestResult {
  requestId: string;
  email: string;
  status: string;
  verificationUrl?: string;
  rateLimit: RateLimitState;
}

export interface ProvisionInput {
  token: string;
  merchantName: string;
  storeName: string;
  timezone: string;
}

export interface ProvisionResult {
  merchantId: string;
  storeId: string;
  operatorId: string;
  loginUrl: string;
  requestId: string;
}

// ── Service functions ───────────────────────────────────

async function ensureSignupSchema(client: PoolClient): Promise<void> {
  // Migration 006 is applied out-of-band; this is the compatibility ensure.
  await client.query(`
    CREATE TABLE IF NOT EXISTS app.signup_requests (
      id TEXT PRIMARY KEY,
      normalized_email TEXT NOT NULL,
      email_hash TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      request_ip TEXT,
      user_agent TEXT,
      terms_version TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      verified_at TIMESTAMPTZ,
      provisioned_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS signup_requests_normalized_email_idx
      ON app.signup_requests(normalized_email)
      WHERE status IN ('pending', 'verified', 'provisioned');
    CREATE INDEX IF NOT EXISTS signup_requests_status_created_idx
      ON app.signup_requests(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS app.signup_verification_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      purpose TEXT NOT NULL DEFAULT 'email_verification',
      attempts_remaining SMALLINT NOT NULL DEFAULT 3,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS signup_verification_tokens_request_idx
      ON app.signup_verification_tokens(request_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS app.signup_rate_limit_buckets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      window_key TEXT NOT NULL,
      window_type TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      window_start TIMESTAMPTZ NOT NULL,
      window_end TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (window_key, window_type, window_start)
    );

    CREATE TABLE IF NOT EXISTS app.email_delivery_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL,
      request_id TEXT,
      template_key TEXT NOT NULL,
      recipient_normalized_email TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_message_id TEXT,
      provider_response_code TEXT,
      error_code TEXT,
      error_message TEXT,
      sent_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS email_delivery_attempts_request_idx
      ON app.email_delivery_attempts(request_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS email_delivery_attempts_status_idx
      ON app.email_delivery_attempts(status, created_at DESC);
  `);
}

async function ensureMigration006Applied(client: PoolClient): Promise<void> {
  if (shouldRunPlatformSchemaBootstrap()) {
    // Compatibility DDL is transactional. Serialize it across concurrent
    // first requests so PostgreSQL never has to resolve competing CREATE
    // INDEX/table locks while provisioning itself is also serialized.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["signup-schema-bootstrap-v1"],
    );
    await ensureSignupSchema(client);
    return;
  }
  const readiness = await client.query<{ migration_006: boolean; migration_034: boolean; purpose_ready: boolean }>(`
    SELECT
      EXISTS (SELECT 1 FROM app.schema_migrations WHERE filename = '006_signup_identity_and_verification.sql') AS migration_006,
      EXISTS (SELECT 1 FROM app.schema_migrations WHERE filename = '034_signup_provisioning_capability.sql') AS migration_034,
      EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'app.signup_verification_tokens'::regclass
          AND conname = 'signup_verification_tokens_purpose_check'
          AND pg_get_constraintdef(oid) LIKE '%tenant_provisioning%'
      ) AS purpose_ready
  `);
  const row = readiness.rows[0];
  if (!row?.migration_006 || !row.migration_034 || !row.purpose_ready) {
    throw new Error("Signup schema is incomplete; migrations 006 and 034 are required");
  }
}

function verifyUrlFor(token: string): string {
  return `${publicAppUrl()}/signup/verify#token=${encodeURIComponent(token)}`;
}

type SignupTokenPurpose = "email_verification" | "tenant_provisioning" | "password_reset";

async function supersedeActiveSignupTokens(
  client: PoolClient,
  requestId: string,
  purpose: SignupTokenPurpose,
): Promise<void> {
  await client.query(`
    UPDATE app.signup_verification_tokens
    SET consumed_at = now(), attempts_remaining = 0
    WHERE request_id = $1
      AND purpose = $2
      AND consumed_at IS NULL
  `, [requestId, purpose]);
}

async function issueSignupToken(
  client: PoolClient,
  requestId: string,
  purpose: "email_verification" | "tenant_provisioning",
  ttlMs: number,
  attemptsRemaining: number,
  suppliedToken?: string,
): Promise<{ token: string; expiresAt: Date }> {
  await supersedeActiveSignupTokens(client, requestId, purpose);
  const token = suppliedToken ?? generateVerificationToken(requestId).token;
  const expiresAt = new Date(Date.now() + ttlMs);
  await client.query(`
    INSERT INTO app.signup_verification_tokens
      (request_id, token_hash, purpose, attempts_remaining, expires_at)
    VALUES ($1, $2, $3, $4, $5)
  `, [requestId, hashVerificationToken(token), purpose, attemptsRemaining, expiresAt]);
  return { token, expiresAt };
}

function deriveProvisioningToken(
  requestId: string,
  verificationToken: string,
  idempotencyKeyHash: string,
): string {
  const secret = verificationSecret();
  if (secret.length < 32) {
    throw new PlatformError("config_error", "SIGNUP_VERIFICATION_SECRET must be configured", 500);
  }
  const capability = createHmac("sha256", secret)
    .update(`tenant_provisioning:${requestId}:${verificationToken}:${idempotencyKeyHash}`)
    .digest("hex");
  return `${requestId}.${capability}`;
}

// Public entry: create signup request + send verification email
export async function createSignupRequest(
  input: SignupRequestInput,
  provider: TransactionalEmailProvider,
  options: { skipFlagCheck?: boolean } = {},
): Promise<SignupRequestResult> {
  if (!options.skipFlagCheck) requirePublicSignupEnabled();

  const normalizedEmail = normalizeEmail(input.email);
  validatePassword(input.password);
  if (verificationSecret().length < 32 && process.env.NODE_ENV === "production") {
    throw new PlatformError("config_error", "SIGNUP_VERIFICATION_SECRET must be set in production", 500);
  }

  await ensurePlatformSchema();

  return withConnectedTransaction(async (client) => {
    await ensureMigration006Applied(client);

    // Rate limit by email
    const emailLimit = await consumeRateLimit(
      client,
      "email",
      normalizedEmail,
      emailRateLimitPerHour(),
    );
    // Rate limit by IP (when present)
    let ipLimit: RateLimitState | null = null;
    if (input.requestIp) {
      ipLimit = await consumeRateLimit(client, "ip", input.requestIp, ipRateLimitPerHour());
    }

    // Look up any existing active request for this email
    const existing = await queryOne<{
      id: string;
      status: string;
      normalized_email: string;
      created_at: Date;
    }>(client, `
      SELECT id, status, normalized_email, created_at
      FROM app.signup_requests
      WHERE normalized_email = $1 AND status IN ('pending', 'verified', 'provisioned')
      FOR UPDATE
    `, [normalizedEmail]);

    let requestId: string;
    let status: string;

    if (existing) {
      if (existing.status === "provisioned") {
        // Already a tenant. Do not leak existence in detail; return generic.
        throw new PlatformError(
          "email_already_registered",
          "This email is already registered. Try signing in.",
          409,
        );
      }
      if (existing.status === "verified") {
        // Allow re-request but reuse the request id; do NOT reset password unless requested
        // For simplicity here we keep the original password hash. Caller should call
        // resendVerification instead.
        throw new PlatformError(
          "verification_already_pending",
          "A verification email has already been sent. Check your inbox or wait to resend.",
          409,
          { requestId: existing.id },
        );
      }
      // pending: enforce resend cooldown
      const sinceMs = Date.now() - (existing.created_at?.getTime?.() ?? 0);
      if (sinceMs < resendCooldownMs()) {
        const retryAfterSeconds = Math.ceil((resendCooldownMs() - sinceMs) / 1000);
        throw new PlatformError(
          "resend_cooldown",
          "Please wait before requesting another verification email.",
          429,
          { retryAfterSeconds },
        );
      }
      // Replace pending request: update password hash, reset created_at
      requestId = existing.id;
      const newHash = await hashPassword(input.password);
      await client.query(`
        UPDATE app.signup_requests
        SET password_hash = $2, request_ip = $3, user_agent = $4, terms_version = $5,
            created_at = now(), updated_at = now(), status = 'pending'
        WHERE id = $1
      `, [requestId, newHash, input.requestIp ?? null, input.userAgent ?? null, input.termsVersion ?? DEFAULT_TERMS_VERSION]);
      status = "pending";
    } else {
      requestId = id("sur");
      const passwordHash = await hashPassword(input.password);
      await client.query(`
        INSERT INTO app.signup_requests (id, normalized_email, email_hash, password_hash, status, request_ip, user_agent, terms_version)
        VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
      `, [
        requestId,
        normalizedEmail,
        hashEmailForLookup(normalizedEmail),
        passwordHash,
        input.requestIp ?? null,
        input.userAgent ?? null,
        input.termsVersion ?? DEFAULT_TERMS_VERSION,
      ]);
      status = "pending";
    }

    const { token } = await issueSignupToken(
      client,
      requestId,
      "email_verification",
      verificationTtlMs(),
      3,
    );

    // Send verification email. On failure, leave the request 'pending' so the
    // caller can retry resend without re-paying rate-limit cost for the email body.
    const rendered = renderTemplate("signup.email_verification", {
      verifyUrl: verifyUrlFor(token),
      appUrl: publicAppUrl(),
    });
    const message: TransactionalEmailMessage = {
      to: normalizedEmail,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      templateKey: "signup.email_verification" satisfies EmailTemplateKey,
      requestId,
    };
    const result = await provider.send(message);

    await recordDeliveryAttempt(client, {
      provider: provider.provider,
      request_id: requestId,
      template_key: "signup.email_verification",
      recipient_normalized_email: normalizedEmail,
      result,
    });

    if (result.status === "failed") {
      // Do not throw — surface a clear retry state. Caller can call resend.
      return {
        requestId,
        email: normalizedEmail,
        status: "verification_delivery_failed",
        rateLimit: ipLimit ?? emailLimit,
      };
    }

    // In local/test only: surface the verification URL via logs / response.
    // We never do this in production.
    const exposeUrl =
      process.env.NODE_ENV !== "production" && process.env.PUBLIC_SIGNUP_EXPOSE_URL_IN_RESPONSE === "true"
        ? verifyUrlFor(token)
        : undefined;

    return {
      requestId,
      email: normalizedEmail,
      status,
      verificationUrl: exposeUrl,
      rateLimit: ipLimit ?? emailLimit,
    };
  });
}

export interface ResendResult {
  requestId: string;
  status: string;
  verificationUrl?: string;
}

export async function resendVerificationEmail(
  email: string,
  provider: TransactionalEmailProvider,
): Promise<ResendResult> {
  requirePublicSignupEnabled();
  const normalizedEmail = normalizeEmail(email);

  await ensurePlatformSchema();

  return withConnectedTransaction(async (client) => {
    await ensureMigration006Applied(client);

    await consumeRateLimit(client, "email", `resend:${normalizedEmail}`, emailRateLimitPerHour());

    const row = await queryOne<{
      id: string;
      status: string;
      password_hash: string;
      created_at: Date;
    }>(client, `
      SELECT id, status, password_hash, created_at
      FROM app.signup_requests
      WHERE normalized_email = $1
      FOR UPDATE
    `, [normalizedEmail]);

    if (!row) {
      // Do not leak existence
      throw new PlatformError("resend_failed", "If this email is registered, a new verification has been sent.", 202);
    }
    if (row.status === "provisioned") {
      throw new PlatformError("email_already_registered", "This email is already registered.", 409);
    }
    if (row.status !== "pending") {
      throw new PlatformError("verification_already_pending", "Verification is already complete.", 409);
    }

    const sinceMs = Date.now() - (row.created_at?.getTime?.() ?? 0);
    if (sinceMs < resendCooldownMs()) {
      const retryAfterSeconds = Math.ceil((resendCooldownMs() - sinceMs) / 1000);
      throw new PlatformError(
        "resend_cooldown",
        "Please wait before requesting another verification email.",
        429,
        { retryAfterSeconds },
      );
    }

    const { token } = await issueSignupToken(
      client,
      row.id,
      "email_verification",
      verificationTtlMs(),
      3,
    );
    await client.query(`UPDATE app.signup_requests SET created_at = now(), updated_at = now() WHERE id = $1`, [row.id]);

    const rendered = renderTemplate("signup.verification_resent", {
      verifyUrl: verifyUrlFor(token),
    });
    const result = await provider.send({
      to: normalizedEmail,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      templateKey: "signup.verification_resent",
      requestId: row.id,
    });

    await recordDeliveryAttempt(client, {
      provider: provider.provider,
      request_id: row.id,
      template_key: "signup.verification_resent",
      recipient_normalized_email: normalizedEmail,
      result,
    });

    const exposeUrl =
      process.env.NODE_ENV !== "production" && process.env.PUBLIC_SIGNUP_EXPOSE_URL_IN_RESPONSE === "true"
        ? verifyUrlFor(token)
        : undefined;

    return { requestId: row.id, status: "resent", verificationUrl: exposeUrl };
  });
}

export interface VerifyResult {
  requestId: string;
  email: string;
  status: "verified";
  provisioningToken: string;
  provisioningExpiresAt: string;
}

export async function verifySignupToken(
  token: string,
  headers: HeadersLike = {},
): Promise<VerifyResult> {
  requirePublicSignupEnabled();
  const requestId = tokenRequestId(token);
  const idempotencyKeyHash = hashSignupIdempotencyKey(requireSignupIdempotencyKey(headers));

  await ensurePlatformSchema();

  return withConnectedTransaction(async (client) => {
    await ensureMigration006Applied(client);

    const request = await queryOne<{
      id: string;
      normalized_email: string;
      status: string;
      metadata: Record<string, unknown>;
    }>(client, `
      SELECT id, normalized_email, status, metadata
      FROM app.signup_requests
      WHERE id = $1
      FOR UPDATE
    `, [requestId]);

    if (!request) {
      throw new PlatformError("invalid_token", "Invalid verification token", 400);
    }
    const tokenRow = await queryOne<{
      id: string;
      token_hash: string;
      attempts_remaining: number;
      expires_at: Date;
      consumed_at: Date | null;
    }>(client, `
      SELECT id, token_hash, attempts_remaining, expires_at, consumed_at
      FROM app.signup_verification_tokens
      WHERE request_id = $1
        AND purpose = 'email_verification'
        AND token_hash = $2
      LIMIT 1
      FOR UPDATE
    `, [requestId, hashVerificationToken(token)]);

    if (!tokenRow) {
      throw new PlatformError("invalid_token", "Invalid verification token", 400);
    }
    if (!safeEqualHash(token, tokenRow.token_hash)) {
      throw new PlatformError("invalid_token", "Invalid verification token", 400);
    }
    if (request.status === "provisioned") {
      throw new PlatformError("already_provisioned", "This signup has already been completed.", 409);
    }
    if (request.status !== "pending" && request.status !== "verified") {
      throw new PlatformError("invalid_token", "Invalid verification token", 400);
    }
    if (tokenExpired(tokenRow.expires_at)) {
      throw new PlatformError("token_expired", "This verification link has expired. Request a new one.", 410);
    }

    if (tokenRow.consumed_at) {
      const retryExpiresAt = new Date(String(request.metadata?.verificationRetryExpiresAt || ""));
      const sameRetry = request.status === "verified"
        && request.metadata?.verificationIdempotencyKeyHash === idempotencyKeyHash
        && request.metadata?.verificationTokenHash === tokenRow.token_hash
        && !Number.isNaN(retryExpiresAt.getTime())
        && retryExpiresAt.getTime() > Date.now();
      if (!sameRetry) {
        throw new PlatformError("token_already_used", "This verification link has already been used.", 409);
      }
      const provisioningToken = deriveProvisioningToken(requestId, token, idempotencyKeyHash);
      const provisioningRow = await queryOne<{ expires_at: Date; consumed_at: Date | null }>(client, `
        SELECT expires_at, consumed_at
        FROM app.signup_verification_tokens
        WHERE request_id = $1
          AND purpose = 'tenant_provisioning'
          AND token_hash = $2
        LIMIT 1
        FOR UPDATE
      `, [requestId, hashVerificationToken(provisioningToken)]);
      if (!provisioningRow || provisioningRow.consumed_at) {
        throw new PlatformError("token_already_used", "This verification retry is no longer available.", 409);
      }
      if (tokenExpired(provisioningRow.expires_at)) {
        throw new PlatformError("token_expired", "This provisioning token has expired.", 410);
      }
      return {
        requestId: request.id,
        email: request.normalized_email,
        status: "verified",
        provisioningToken,
        provisioningExpiresAt: provisioningRow.expires_at.toISOString(),
      };
    }

    await client.query(`UPDATE app.signup_verification_tokens SET consumed_at = now(), attempts_remaining = 0 WHERE id = $1`, [tokenRow.id]);
    const retryExpiresAt = new Date(Date.now() + provisioningTtlMs());
    await client.query(`
      UPDATE app.signup_requests
      SET status = 'verified',
          verified_at = COALESCE(verified_at, now()),
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'verificationIdempotencyKeyHash', $2::text,
            'verificationRetryExpiresAt', $3::text,
            'verificationTokenHash', $4::text
          ),
          updated_at = now()
      WHERE id = $1
    `, [requestId, idempotencyKeyHash, retryExpiresAt.toISOString(), tokenRow.token_hash]);

    const provisioningToken = deriveProvisioningToken(requestId, token, idempotencyKeyHash);
    const provisioning = await issueSignupToken(
      client,
      requestId,
      "tenant_provisioning",
      provisioningTtlMs(),
      1,
      provisioningToken,
    );

    return {
      requestId: request.id,
      email: request.normalized_email,
      status: "verified",
      provisioningToken,
      provisioningExpiresAt: provisioning.expiresAt.toISOString(),
    };
  });
}

// ── Atomic provisioning ─────────────────────────────────

function sanitizeText(raw: string, maxLen: number, fallback: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return fallback;
  // Strip control chars; clamp length
  return Array.from(trimmed)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("")
    .slice(0, maxLen);
}

function validateTimezone(tz: string): string {
  if (!tz) {
    throw new PlatformError("validation_error", "Timezone is required", 400, { field: "timezone" });
  }
  const trimmed = tz.trim();
  // Allow only IANA-style identifiers (letters, digits, _, /, +, -)
  if (!/^[A-Za-z0-9_+\-/]+$/.test(trimmed) || trimmed.length > 64) {
    throw new PlatformError("validation_error", "Invalid timezone", 400, { field: "timezone" });
  }
  try {
    // Syntax alone accepts values such as Mars/Olympus_Mons. Validate against
    // the runtime IANA database before persisting the store's reporting clock.
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(0);
  } catch {
    throw new PlatformError("validation_error", "Invalid timezone", 400, { field: "timezone" });
  }
  return trimmed;
}

export function operatorIdFromEmail(normalizedEmail: string): string {
  // Stable, immutable operator_id derived from email. We don't use email as
  // the foreign key, but we need determinism so retries produce the same id.
  const hash = createHash("sha256").update(`owner:${normalizedEmail}`).digest("hex").slice(0, 16);
  return `op_owner_${hash}`;
}

export function merchantIdFromEmail(normalizedEmail: string): string {
  const hash = createHash("sha256").update(`merchant:${normalizedEmail}`).digest("hex").slice(0, 16);
  return `m_${hash}`;
}

export function storeIdFromEmail(normalizedEmail: string): string {
  const hash = createHash("sha256").update(`store:${normalizedEmail}`).digest("hex").slice(0, 16);
  return `st_${hash}`;
}

export function stockLocationIdFromEmail(normalizedEmail: string): string {
  const hash = createHash("sha256").update(`sloc:${normalizedEmail}`).digest("hex").slice(0, 16);
  return `sloc_${hash}`;
}

function legacyOrganizationIdFromMerchant(merchantId: string): string {
  return `org_${merchantId}`;
}

/**
 * Provision merchant + primary store + sloc binding + owner staff_user +
 * owner membership + Basic subscription, atomically and idempotently.
 *
 * Idempotency: all primary keys are derived deterministically from the
 * verified normalized email. Re-running with the same email returns the
 * same merchant/store/operator ids without duplicating rows.
 */
export async function provisionSignupTenant(
  input: ProvisionInput,
  headers: HeadersLike = {},
): Promise<ProvisionResult> {
  requirePublicSignupEnabled();
  const requestId = tokenRequestId(input.token);
  requireSignupIdempotencyKey(headers);

  await ensurePlatformSchema();

  return withConnectedTransaction(async (client) => {
    await ensureMigration006Applied(client);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`signup-provision:${requestId}`],
    );
    const idempotent = await withScopedIdempotency(
      client,
      headers,
      input,
      requestId,
      "signup-provision",
      async () => {

    const request = await queryOne<{
      id: string;
      normalized_email: string;
      password_hash: string;
      status: string;
      terms_version: string | null;
    }>(client, `
      SELECT id, normalized_email, password_hash, status, terms_version
      FROM app.signup_requests
      WHERE id = $1
      FOR UPDATE
    `, [requestId]);

    if (!request) {
      throw new PlatformError("invalid_token", "Invalid verification token", 400);
    }
    const tokenRow = await queryOne<{ id: string; token_hash: string; expires_at: Date; consumed_at: Date | null }>(client, `
      SELECT id, token_hash, expires_at, consumed_at
      FROM app.signup_verification_tokens
      WHERE request_id = $1
        AND purpose = 'tenant_provisioning'
        AND token_hash = $2
      LIMIT 1
      FOR UPDATE
    `, [requestId, hashVerificationToken(input.token)]);
    if (!tokenRow || !safeEqualHash(input.token, tokenRow.token_hash)) {
      throw new PlatformError("invalid_token", "Invalid provisioning token", 400);
    }
    if (tokenExpired(tokenRow.expires_at)) {
      throw new PlatformError("token_expired", "This provisioning token has expired.", 410);
    }
    if (tokenRow.consumed_at) {
      throw new PlatformError("token_already_used", "This provisioning token has already been used.", 409);
    }
    if (request.status !== "verified") {
      throw new PlatformError("not_verified", "Email must be verified before provisioning.", 403);
    }

    const email = request.normalized_email;
    const merchantId = merchantIdFromEmail(email);
    const storeId = storeIdFromEmail(email);
    const slocId = stockLocationIdFromEmail(email);
    const operatorId = operatorIdFromEmail(email);
    const legacyOrgId = legacyOrganizationIdFromMerchant(merchantId);

    const merchantName = sanitizeText(input.merchantName, 120, "My Merchant");
    const storeName = sanitizeText(input.storeName, 120, "Primary Store");
    const timezone = validateTimezone(input.timezone);

    // 1. Stock location (Medusa core inventory location). Idempotent.
    await client.query(`
      INSERT INTO public.stock_location (id, name)
      VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
    `, [slocId, storeName]);

    // 2. Merchant
    await client.query(`
      INSERT INTO app.merchants (id, display_name, legacy_organization_id, status)
      VALUES ($1, $2, $3, 'active')
      ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
    `, [merchantId, merchantName, legacyOrgId]);

    // 3. Primary store (1:1 with stock_location in 1.1.2)
    await client.query(`
      INSERT INTO app.stores (
        id, merchant_id, display_name, stock_location_id, is_primary, status, metadata
      )
      VALUES (
        $1, $2, $3, $4, true, 'active',
        jsonb_build_object('ownerSettings', jsonb_build_object('timezone', $5::text))
      )
      ON CONFLICT (id) DO UPDATE
      SET display_name = EXCLUDED.display_name,
          metadata = jsonb_set(
            COALESCE(app.stores.metadata, '{}'::jsonb),
            '{ownerSettings}',
            COALESCE(app.stores.metadata->'ownerSettings', '{}'::jsonb)
              || jsonb_build_object('timezone', $5::text),
            true
          ),
          updated_at = now()
    `, [storeId, merchantId, storeName, slocId, timezone]);

    // Every merchant owns an independent loyalty policy. The scoped unique
    // index from migration 015 permits the standard names per merchant.
    await client.query(`
      INSERT INTO ai_module.loyalty_tiers
        (name, points_threshold, discount_percent, description, merchant_id)
      VALUES
        ('bronze', 0, 0, 'Mặc định cho khách hàng mới', $1),
        ('silver', 100, 2, 'Tích lũy 100 điểm', $1),
        ('gold', 500, 5, 'Tích lũy 500 điểm', $1),
        ('platinum', 1000, 10, 'Tích lũy 1000 điểm', $1)
      ON CONFLICT (merchant_id, name) WHERE merchant_id IS NOT NULL DO NOTHING
    `, [merchantId]);

    // 4. Owner staff_user (operatorId login preserved). Hash reused from request.
    //    role = 'owner'. organization_id = legacy org id (compatibility).
    await client.query(`
      INSERT INTO medusa.staff_users
        (operator_id, password_hash, display_name, role, organization_id, is_active)
      VALUES ($1, $2, $3, 'owner', $4, true)
      ON CONFLICT (operator_id) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          display_name = EXCLUDED.display_name,
          role = 'owner',
          organization_id = EXCLUDED.organization_id,
          is_active = true
    `, [operatorId, request.password_hash, merchantName, legacyOrgId]);

    // 5. Owner membership
    await client.query(`
      INSERT INTO app.operator_memberships
        (operator_id, scope_type, merchant_id, store_id, role_key, status, granted_by)
      SELECT $1, 'merchant', $2, NULL, 'owner', 'active', $3
      WHERE NOT EXISTS (
        SELECT 1 FROM app.operator_memberships
        WHERE operator_id = $1
          AND scope_type = 'merchant'
          AND merchant_id = $2
          AND role_key = 'owner'
          AND status = 'active'
      )
    `, [operatorId, merchantId, operatorId]);

    // 6. Basic subscription. Reuse applySubscriptionPurchase via a
    //    direct insert that mirrors its policy snapshot. The subscription id is
    //    deterministic per merchant.
    const subscriptionId = `sub_basic_${merchantId}`;
    const catalogVersionId = "pcv_1_1_2_annual_v1_basic";
    const now = new Date();
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()));
    await client.query(`
      INSERT INTO app.merchant_subscriptions
        (id, merchant_id, package_key, catalog_version_id, status,
         current_period_start, current_period_end, grace_ends_at,
         primary_store_id, usage_anchor_day, policy_version)
      VALUES ($1, $2, 'basic', $3, 'active', now(), $4, NULL, $5, $6, '1.1.2-annual-v1')
      ON CONFLICT (merchant_id) DO UPDATE
      SET status = 'active',
          primary_store_id = EXCLUDED.primary_store_id,
          updated_at = now()
    `, [subscriptionId, merchantId, catalogVersionId, periodEnd, storeId, now.getUTCDate()]);

    // 7. Bind the request to the created tenant and consume the provisioning capability.
    await client.query(`
      UPDATE app.signup_requests
      SET status = 'provisioned',
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'merchantId', $2::text,
            'storeId', $3::text,
            'operatorId', $4::text,
            'packageKey', 'basic',
            'timezone', $5::text
          ),
          provisioned_at = now(),
          updated_at = now()
      WHERE id = $1
    `, [requestId, merchantId, storeId, operatorId, timezone]);
    await client.query(`
      UPDATE app.signup_verification_tokens
      SET consumed_at = now(), attempts_remaining = 0
      WHERE id = $1
    `, [tokenRow.id]);

    await client.query(`
      INSERT INTO audit.events
        (organization_id, actor_type, actor_id, action, subject_type, subject_id, after, correlation_id)
      VALUES ($1, 'system', $2, 'signup.provisioned', 'merchant', $3, $4::jsonb, $5)
    `, [
      legacyOrgId,
      operatorId,
      merchantId,
      JSON.stringify({
        merchantId,
        storeId,
        operatorId,
        packageKey: "basic",
        requestId,
        timezone,
        termsVersion: request.terms_version,
      }),
      id("cor"),
    ]);

    return {
      merchantId,
      storeId,
      operatorId,
      requestId,
      loginUrl: `${publicAppUrl()}/login`,
    };
      },
    );
    return idempotent.response;
  });
}

// ── Status / inspection (for UI completion step) ────────

export interface SignupStatusResult {
  requestId: string;
  email: string;
  status: string;
  merchantId?: string;
  storeId?: string;
  operatorId?: string;
  loginUrl?: string;
}

export async function getSignupStatus(token: string): Promise<SignupStatusResult> {
  requirePublicSignupEnabled();
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0) throw new PlatformError("invalid_token", "Invalid token", 400);
  const requestId = token.slice(0, dotIndex);

  await ensurePlatformSchema();

  return withConnectedClient(async (client) => {
    await ensureSignupSchema(client);
    const row = await queryOne<{
      id: string;
      normalized_email: string;
      status: string;
    }>(client, `SELECT id, normalized_email, status FROM app.signup_requests WHERE id = $1`, [requestId]);
    if (!row) throw new PlatformError("not_found", "Signup request not found", 404);

    const result: SignupStatusResult = { requestId: row.id, email: row.normalized_email, status: row.status };

    if (row.status === "provisioned") {
      const email = row.normalized_email;
      const merchantId = merchantIdFromEmail(email);
      const storeId = storeIdFromEmail(email);
      const operatorId = operatorIdFromEmail(email);
      result.merchantId = merchantId;
      result.storeId = storeId;
      result.operatorId = operatorId;
      result.loginUrl = `${publicAppUrl()}/login`;
    }

    return result;
  });
}

// Re-export helpers for tests
export const __test = {
  verificationTtlMs,
  resendCooldownMs,
  emailRateLimitPerHour,
  ipRateLimitPerHour,
  generateVerificationToken,
  hashVerificationToken,
  safeEqualHash,
  normalizeEmail,
  validatePassword,
  operatorIdFromEmail,
  merchantIdFromEmail,
  storeIdFromEmail,
  stockLocationIdFromEmail,
  randomUUID,
};
