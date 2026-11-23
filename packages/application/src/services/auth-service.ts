import { createHmac } from "node:crypto";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import { headerValue, type HeadersLike } from "../http/headers";
import { rateLimitClientIpIdentity } from "../middleware/rate-limit";
import { recordAuditEntry } from "../repositories/audit-repository";
import type { RequestAccess } from "@medusa-snus/contracts";
import { requireRole, signJwt, verifyJwt, verifyPassword, type AuthState, type Role } from "../middleware/auth";
import {
  assertTemporaryPasswordAllowsLogin,
  assertOperatorSecurityAllowsRequest,
  ensureOperatorSecurityState,
  type OperatorSecurityState,
} from "./operator-security-service";
import { resolveScopeBootstrap, type ScopeActor } from "./access-service";

const DUMMY_PASSWORD_HASH = "$2b$12$J5yaQb//g8WNn.MBwJInee65CSVUCeD3EKljpSH3ngoUZ9tNxR8o6";

type LoginFailureState = {
  attempt_count: number;
  blocked_until: Date | string | null;
};

function boundedLoginInteger(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name] || fallback);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function loginIdentityHash(kind: "account" | "ip", value: string): string {
  const secret = process.env.JWT_SECRET || "local-login-rate-limit-secret";
  return createHmac("sha256", secret).update(`${kind}:${value}`).digest("hex");
}

async function currentLoginFailureState(client: Parameters<typeof queryOne>[0], accountHash: string, ipHash: string) {
  return queryOne<LoginFailureState>(client, `
    SELECT attempt_count, blocked_until
    FROM app.auth_login_failures
    WHERE account_hash = $1 AND ip_hash = $2
  `, [accountHash, ipHash]);
}

async function recordLoginFailure(
  client: Parameters<typeof queryOne>[0],
  accountHash: string,
  ipHash: string,
  failureCode: string,
): Promise<LoginFailureState> {
  const windowSeconds = boundedLoginInteger("LOGIN_FAILURE_WINDOW_SECONDS", 900, 60, 86_400);
  const threshold = boundedLoginInteger("LOGIN_BACKOFF_THRESHOLD", 5, 2, 100);
  const baseBlockSeconds = boundedLoginInteger("LOGIN_BACKOFF_BASE_SECONDS", 2, 1, 300);
  const maxBlockSeconds = boundedLoginInteger("LOGIN_BACKOFF_MAX_SECONDS", 300, 1, 3_600);
  await client.query("DELETE FROM app.auth_login_failures WHERE last_attempt_at < now() - interval '24 hours'");
  const failure = await queryOne<LoginFailureState>(client, `
    INSERT INTO app.auth_login_failures (
      account_hash, ip_hash, attempt_count, first_attempt_at, last_attempt_at, blocked_until, last_failure_code
    )
    VALUES ($1, $2, 1, now(), now(), NULL, $3)
    ON CONFLICT (account_hash, ip_hash) DO UPDATE
    SET attempt_count = CASE
          WHEN app.auth_login_failures.first_attempt_at < now() - make_interval(secs => $4::int) THEN 1
          ELSE app.auth_login_failures.attempt_count + 1
        END,
        first_attempt_at = CASE
          WHEN app.auth_login_failures.first_attempt_at < now() - make_interval(secs => $4::int) THEN now()
          ELSE app.auth_login_failures.first_attempt_at
        END,
        last_attempt_at = now(),
        blocked_until = CASE
          WHEN app.auth_login_failures.first_attempt_at < now() - make_interval(secs => $4::int) THEN NULL
          ELSE app.auth_login_failures.blocked_until
        END,
        last_failure_code = EXCLUDED.last_failure_code
    RETURNING attempt_count, blocked_until
  `, [accountHash, ipHash, failureCode, windowSeconds]);
  if (!failure) throw new PlatformError("auth_telemetry_failed", "Authentication telemetry could not be recorded", 503);
  if (failure.attempt_count >= threshold) {
    const exponent = Math.min(10, failure.attempt_count - threshold);
    const blockSeconds = Math.min(maxBlockSeconds, baseBlockSeconds * (2 ** exponent));
    const blocked = await queryOne<LoginFailureState>(client, `
      UPDATE app.auth_login_failures
      SET blocked_until = GREATEST(COALESCE(blocked_until, now()), now() + make_interval(secs => $3::int))
      WHERE account_hash = $1 AND ip_hash = $2
      RETURNING attempt_count, blocked_until
    `, [accountHash, ipHash, blockSeconds]);
    return blocked || failure;
  }
  return failure;
}

function retryAfterSeconds(blockedUntil: Date | string | null): number {
  if (!blockedUntil) return 0;
  return Math.max(0, Math.ceil((new Date(blockedUntil).getTime() - Date.now()) / 1_000));
}

function loginFailureDelayMs(attemptCount: number): number {
  if (process.env.LOGIN_FAILURE_DELAY_ENABLED === "false") return 0;
  return Math.min(2_000, 100 * (2 ** Math.max(0, Math.min(5, attemptCount - 1))));
}

export interface OperatorContext {
  operatorId: string;
  role: Role;
  displayName: string;
  organizationId: string;
  sessionVersion?: number;
  sessionExpiresAt?: string;
  authState?: AuthState;
  security?: OperatorSecurityState;
  actualOperatorId?: string;
  effectiveOperatorId?: string;
  impersonationSessionId?: string;
  impersonationMode?: "read_only";
  permissions?: string[];
  access?: RequestAccess;
}

export async function loginOperator(input: { operatorId?: string; password?: string }, requestHeaders: HeadersLike = {}) {
  await ensurePlatformSchema();

  const operatorId = input.operatorId?.trim();
  const password = input.password;
  if (!operatorId || !password) {
    throw new PlatformError("unauthorized", "Invalid credentials", 401);
  }

  const normalizedAccount = operatorId.toLowerCase().slice(0, 256);
  const accountHash = loginIdentityHash("account", normalizedAccount);
  const ipHash = loginIdentityHash("ip", rateLimitClientIpIdentity(requestHeaders));
  const requestId = headerValue(requestHeaders, "x-request-id") || undefined;
  const outcome = await withConnectedClient(async (client) => {
    const user = await queryOne<{
      operator_id: string;
      password_hash: string;
      display_name: string;
      role: Role;
      organization_id: string;
    }>(client, `
      SELECT operator_id, password_hash, display_name, role, organization_id
      FROM medusa.staff_users
      WHERE operator_id = $1 AND is_active = true
    `, [operatorId]);

    const priorFailure = await currentLoginFailureState(client, accountHash, ipHash);
    const passwordMatches = await verifyPassword(password, user ? String(user.password_hash) : DUMMY_PASSWORD_HASH);
    const blockedFor = retryAfterSeconds(priorFailure?.blocked_until || null);
    if (blockedFor > 0) {
      await recordAuditEntry(client, {
        operatorId: "anonymous",
        role: "anonymous",
        organizationId: user?.organization_id || "org_default",
        requestId,
      }, "auth.login_blocked", "operator_login", user?.operator_id || `account_hash:${accountHash.slice(0, 16)}`, {
        after: { outcome: "blocked", accountHash, ipHash, retryAfterSeconds: blockedFor },
        reason: "progressive_backoff",
      }).catch(() => undefined);
      return {
        kind: "failure" as const,
        delayMs: 0,
        error: new PlatformError("rate_limited", "Too many failed login attempts", 429, { retryAfterSeconds: blockedFor }),
      };
    }
    if (!user || !passwordMatches) {
      const failure = await recordLoginFailure(client, accountHash, ipHash, "invalid_credentials");
      const retryAfter = retryAfterSeconds(failure.blocked_until);
      await recordAuditEntry(client, {
        operatorId: "anonymous",
        role: "anonymous",
        organizationId: user?.organization_id || "org_default",
        requestId,
      }, "auth.login_failed", "operator_login", user?.operator_id || `account_hash:${accountHash.slice(0, 16)}`, {
        after: {
          outcome: "denied",
          accountHash,
          ipHash,
          attemptCount: failure.attempt_count,
          blockedUntil: failure.blocked_until,
        },
        reason: "invalid_credentials",
      }).catch(() => undefined);
      return {
        kind: "failure" as const,
        delayMs: loginFailureDelayMs(failure.attempt_count),
        error: retryAfter > 0
          ? new PlatformError("rate_limited", "Too many failed login attempts", 429, { retryAfterSeconds: retryAfter })
          : new PlatformError("unauthorized", "Invalid credentials", 401),
      };
    }

    const security = await ensureOperatorSecurityState(client, user.operator_id);
    if (security.globalStatus !== "active") {
      await recordAuditEntry(client, {
        operatorId: "anonymous",
        role: "anonymous",
        organizationId: user.organization_id,
        requestId,
      }, "auth.login_failed", "operator_login", user.operator_id, {
        after: { outcome: "denied", accountHash, ipHash },
        reason: "operator_suspended",
      }).catch(() => undefined);
      return {
        kind: "failure" as const,
        delayMs: loginFailureDelayMs(1),
        error: new PlatformError("unauthorized", "Invalid credentials", 401),
      };
    }
    try {
      assertTemporaryPasswordAllowsLogin(security);
    } catch (error) {
      if (!(error instanceof PlatformError) || error.code !== "temporary_password_expired") throw error;
      await recordAuditEntry(client, {
        operatorId: "anonymous",
        role: "anonymous",
        organizationId: user.organization_id,
        requestId,
      }, "auth.login_failed", "operator_login", user.operator_id, {
        after: { outcome: "denied", accountHash, ipHash },
        reason: "temporary_password_expired",
      }).catch(() => undefined);
      return {
        kind: "failure" as const,
        delayMs: loginFailureDelayMs(1),
        error: new PlatformError("unauthorized", "Invalid credentials", 401),
      };
    }

    try {
      await resolveScopeBootstrap({
        operatorId: user.operator_id,
        role: user.role,
        organizationId: user.organization_id,
      });
    } catch (error) {
      if (error instanceof PlatformError && error.code === "membership_required") {
        await recordAuditEntry(client, {
          operatorId: "anonymous",
          role: "anonymous",
          organizationId: user.organization_id,
          requestId,
        }, "auth.login_failed", "operator_login", user.operator_id, {
          after: { outcome: "denied", accountHash, ipHash },
          reason: "membership_required",
        }).catch(() => undefined);
        return {
          kind: "failure" as const,
          delayMs: loginFailureDelayMs(1),
          error: new PlatformError("unauthorized", "Invalid credentials", 401),
        };
      }
      throw error;
    }

    await client.query("DELETE FROM app.auth_login_failures WHERE account_hash = $1 AND ip_hash = $2", [accountHash, ipHash]);
    await client.query("UPDATE medusa.staff_users SET last_login_at = now() WHERE operator_id = $1", [operatorId]);
    await client.query(`
      UPDATE app.operator_security_state
      SET last_login_at = now(), updated_at = now()
      WHERE operator_id = $1
    `, [operatorId]);
    const authState: AuthState = security.requiresPasswordChange ? "password_change_required" : "authenticated";
    const token = signJwt({
      operatorId: user.operator_id,
      role: user.role,
      displayName: user.display_name,
      organizationId: user.organization_id,
      sessionVersion: security.sessionVersion,
      authState,
    });

    return { kind: "success" as const, response: {
      data: {
        token,
        authState,
        security: {
          requiresPasswordChange: security.requiresPasswordChange,
          globalStatus: security.globalStatus,
          sessionVersion: security.sessionVersion,
          forceLogoutAfter: security.forceLogoutAfter?.toISOString() ?? null,
          passwordChangedAt: security.passwordChangedAt?.toISOString() ?? null,
        },
        operator: {
          id: user.operator_id,
          role: user.role,
          displayName: user.display_name,
          organizationId: user.organization_id,
        },
      },
    } };
  });
  if (outcome.kind === "failure") {
    if (outcome.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, outcome.delayMs));
    throw outcome.error;
  }
  return outcome.response;
}

export function authenticateHeaders(headers: HeadersLike, minRole: Role = "staff"): OperatorContext {
  const auth = headerValue(headers, "authorization");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  const payload = token ? verifyJwt(token) : null;

  if (!payload) throw new PlatformError("unauthorized", "Missing or invalid token", 401);
  if (!requireRole(payload, minRole)) throw new PlatformError("forbidden", `Requires ${minRole} role`, 403);

  return {
    operatorId: payload.operatorId,
    role: payload.role as Role,
    displayName: payload.displayName,
    organizationId: payload.organizationId,
    sessionVersion: payload.sessionVersion,
    sessionExpiresAt: new Date(payload.exp * 1_000).toISOString(),
    authState: payload.authState,
    actualOperatorId: payload.actualOperatorId,
    effectiveOperatorId: payload.effectiveOperatorId,
    impersonationSessionId: payload.impersonationSessionId,
    impersonationMode: payload.impersonationSessionId ? "read_only" : undefined,
  };
}

export async function authenticateRequestActor(
  headers: HeadersLike,
  minRole: Role = "staff",
  options: { allowPasswordChangeRequired?: boolean } = {},
): Promise<OperatorContext> {
  await ensurePlatformSchema();
  const auth = headerValue(headers, "authorization");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  const payload = token ? verifyJwt(token) : null;

  if (!payload) throw new PlatformError("unauthorized", "Missing or invalid token", 401);
  if (!requireRole(payload, minRole)) throw new PlatformError("forbidden", `Requires ${minRole} role`, 403);

  return withConnectedClient(async (client) => {
    const user = await queryOne<{
      operator_id: string;
      display_name: string;
      role: Role;
      organization_id: string;
      is_active: boolean;
    }>(client, `
      SELECT operator_id, display_name, role, organization_id, is_active
      FROM medusa.staff_users
      WHERE operator_id = $1
      LIMIT 1
    `, [payload.operatorId]);

    if (!user || !user.is_active) {
      throw new PlatformError("unauthorized", "Operator is inactive", 401);
    }

    const security = await ensureOperatorSecurityState(client, user.operator_id);
    assertOperatorSecurityAllowsRequest(payload, security, options);
    if (payload.impersonationSessionId) {
      const session = await queryOne<{ id: string }>(client, `
        SELECT id::text
        FROM app.impersonation_sessions
        WHERE id::text = $1
          AND actual_operator_id = $2
          AND effective_operator_id = $3
          AND mode = 'read_only'
          AND ended_at IS NULL
          AND expires_at > now()
        LIMIT 1
      `, [payload.impersonationSessionId, payload.actualOperatorId || "", user.operator_id]);
      if (!session) throw new PlatformError("impersonation_invalid", "Impersonation session is not active", 401);
    }

    return {
      operatorId: user.operator_id,
      role: user.role,
      displayName: user.display_name,
      organizationId: user.organization_id,
      sessionVersion: security.sessionVersion,
      sessionExpiresAt: new Date(payload.exp * 1_000).toISOString(),
      authState: payload.authState ?? "authenticated",
      security,
      actualOperatorId: payload.actualOperatorId,
      effectiveOperatorId: payload.effectiveOperatorId || user.operator_id,
      impersonationSessionId: payload.impersonationSessionId,
      impersonationMode: payload.impersonationSessionId ? "read_only" : undefined,
    };
  });
}


export function toScopeActor(operator: OperatorContext): ScopeActor {
  return {
    operatorId: operator.operatorId,
    role: operator.role,
    organizationId: operator.organizationId,
    sessionVersion: operator.sessionVersion,
    sessionExpiresAt: operator.sessionExpiresAt,
    permissions: operator.permissions,
    access: operator.access,
  };
}

export async function resolveOperatorAccess(operator: OperatorContext, headers?: HeadersLike): Promise<RequestAccess> {
  const { access } = await resolveScopeBootstrap(toScopeActor(operator), headers);
  operator.access = access;
  return access;
}
