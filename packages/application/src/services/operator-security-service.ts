import type { PoolClient } from "../db/client";
import { queryOne } from "../db/query";
import { PlatformError } from "../errors/platform-error";
import type { JwtPayload } from "../middleware/auth";

export type GlobalOperatorStatus = "active" | "suspended";

export interface OperatorSecurityState {
  operatorId: string;
  requiresPasswordChange: boolean;
  forceLogoutAfter: Date | null;
  sessionVersion: number;
  globalStatus: GlobalOperatorStatus;
  passwordChangedAt: Date | null;
  temporaryPasswordHash: string | null;
  temporaryPasswordExpiresAt: Date | null;
  lastLoginAt: Date | null;
}

const DEFAULT_TEMPORARY_PASSWORD_TTL_MINUTES = 60;

export function temporaryPasswordTtlMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.TEMPORARY_PASSWORD_TTL_MINUTES || DEFAULT_TEMPORARY_PASSWORD_TTL_MINUTES);
  if (!Number.isInteger(parsed) || parsed < 5 || parsed > 1_440) {
    throw new PlatformError(
      "invalid_temporary_password_ttl",
      "TEMPORARY_PASSWORD_TTL_MINUTES must be an integer between 5 and 1440",
      500,
    );
  }
  return parsed;
}

export function temporaryPasswordExpiry(
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Date {
  return new Date(now.getTime() + temporaryPasswordTtlMinutes(env) * 60_000);
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function assertTemporaryPasswordAllowsLogin(
  state: Pick<OperatorSecurityState, "temporaryPasswordHash" | "temporaryPasswordExpiresAt">,
  now = new Date(),
): void {
  if (!state.temporaryPasswordHash) return;
  if (!state.temporaryPasswordExpiresAt || state.temporaryPasswordExpiresAt.getTime() <= now.getTime()) {
    throw new PlatformError("temporary_password_expired", "Temporary password has expired", 401);
  }
}

export function tokenIssuedBeforeForceLogout(payload: Pick<JwtPayload, "iat">, forceLogoutAfter: Date | null): boolean {
  if (!forceLogoutAfter) return false;
  return payload.iat < Math.floor(forceLogoutAfter.getTime() / 1000);
}

export async function ensureOperatorSecurityState(
  client: PoolClient,
  operatorId: string,
): Promise<OperatorSecurityState> {
  await client.query(`
    INSERT INTO app.operator_security_state (operator_id)
    VALUES ($1)
    ON CONFLICT (operator_id) DO NOTHING
  `, [operatorId]);

  const state = await loadOperatorSecurityState(client, operatorId);
  if (!state) {
    throw new PlatformError("security_state_missing", "Operator security state is missing", 500);
  }
  return state;
}

export async function loadOperatorSecurityState(
  client: PoolClient,
  operatorId: string,
): Promise<OperatorSecurityState | null> {
  const row = await queryOne<{
    operator_id: string;
    requires_password_change: boolean;
    force_logout_after: Date | string | null;
    session_version: number;
    global_status: GlobalOperatorStatus;
    password_changed_at: Date | string | null;
    temporary_password_hash: string | null;
    temporary_password_expires_at: Date | string | null;
    last_login_at: Date | string | null;
  }>(client, `
    SELECT
      operator_id,
      requires_password_change,
      force_logout_after,
      session_version,
      global_status,
      password_changed_at,
      temporary_password_hash,
      temporary_password_expires_at,
      last_login_at
    FROM app.operator_security_state
    WHERE operator_id = $1
    LIMIT 1
  `, [operatorId]);

  if (!row) return null;
  return {
    operatorId: row.operator_id,
    requiresPasswordChange: Boolean(row.requires_password_change),
    forceLogoutAfter: toDate(row.force_logout_after),
    sessionVersion: Number(row.session_version),
    globalStatus: row.global_status,
    passwordChangedAt: toDate(row.password_changed_at),
    temporaryPasswordHash: row.temporary_password_hash,
    temporaryPasswordExpiresAt: toDate(row.temporary_password_expires_at),
    lastLoginAt: toDate(row.last_login_at),
  };
}

export function assertOperatorSecurityAllowsRequest(
  payload: JwtPayload,
  state: OperatorSecurityState,
  options: { allowPasswordChangeRequired?: boolean } = {},
): void {
  if (state.globalStatus !== "active") {
    throw new PlatformError("operator_suspended", "Operator is suspended", 403);
  }

  if (!payload.sessionVersion || payload.sessionVersion !== state.sessionVersion) {
    throw new PlatformError("session_invalidated", "Session has been invalidated", 401);
  }

  if (tokenIssuedBeforeForceLogout(payload, state.forceLogoutAfter)) {
    throw new PlatformError("session_invalidated", "Session has been invalidated", 401);
  }

  const restricted = payload.authState === "password_change_required" || state.requiresPasswordChange;
  if (restricted && !options.allowPasswordChangeRequired) {
    throw new PlatformError("password_change_required", "Password change is required", 403);
  }
}

export function assertOperatorCanUseChannel(state: OperatorSecurityState): void {
  if (state.globalStatus !== "active") {
    throw new PlatformError("operator_suspended", "Operator is suspended", 403);
  }
  if (state.requiresPasswordChange) {
    throw new PlatformError("password_change_required", "Password change is required", 403);
  }
}

export async function bumpOperatorSessionVersion(
  client: PoolClient,
  operatorId: string,
): Promise<OperatorSecurityState> {
  await ensureOperatorSecurityState(client, operatorId);
  await client.query(`
    UPDATE app.operator_security_state
    SET session_version = session_version + 1,
        updated_at = now()
    WHERE operator_id = $1
  `, [operatorId]);
  const state = await loadOperatorSecurityState(client, operatorId);
  if (!state) throw new PlatformError("security_state_missing", "Operator security state is missing", 500);
  return state;
}
