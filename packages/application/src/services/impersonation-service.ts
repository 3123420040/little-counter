import { permissions } from "@medusa-snus/contracts";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedTransaction } from "../db/transaction";
import { queryOne } from "../db/query";
import { PlatformError } from "../errors/platform-error";
import { signJwt } from "../middleware/auth";
import { recordAuditEntry } from "../repositories/audit-repository";
import type { OperatorContext } from "./auth-service";
import { ensureOperatorSecurityState } from "./operator-security-service";
import { requireActorAccessPermission } from "./access-service";

export interface StartImpersonationInput {
  targetOperatorId?: string;
  reason?: string;
  ticketRef?: string;
  durationMinutes?: number;
}

function reasonText(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 4 || text.length > 500) {
    throw new PlatformError("validation_error", "Reason is required and must be 4-500 characters", 400);
  }
  return text;
}

function duration(input: unknown): number {
  const minutes = Number(input || 30);
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 120) {
    throw new PlatformError("validation_error", "Duration must be 5-120 minutes", 400);
  }
  return Math.floor(minutes);
}

export async function startReadOnlyImpersonation(
  actor: OperatorContext,
  input: StartImpersonationInput,
) {
  await ensurePlatformSchema();
  await requireActorAccessPermission(actor, permissions.platformImpersonationStart);
  const targetOperatorId = typeof input.targetOperatorId === "string" ? input.targetOperatorId.trim() : "";
  if (!targetOperatorId) throw new PlatformError("validation_error", "Target operator is required", 400);
  if (targetOperatorId === actor.operatorId) throw new PlatformError("validation_error", "Cannot impersonate yourself", 400);
  const reason = reasonText(input.reason);
  const durationMinutes = duration(input.durationMinutes);

  return withConnectedTransaction(async (client) => {
    const target = await queryOne<{
      operator_id: string;
      display_name: string;
      role: "staff" | "manager" | "accountant" | "owner";
      organization_id: string;
      is_active: boolean;
    }>(client, `
      SELECT operator_id, display_name, role, organization_id, is_active
      FROM medusa.staff_users
      WHERE operator_id = $1
      LIMIT 1
    `, [targetOperatorId]);
    if (!target || !target.is_active) throw new PlatformError("resource_not_found", "Target operator not found", 404, { targetOperatorId });
    const security = await ensureOperatorSecurityState(client, target.operator_id);
    if (security.globalStatus !== "active") throw new PlatformError("operator_suspended", "Target operator is suspended", 409);
    if (security.requiresPasswordChange) throw new PlatformError("password_change_required", "Target operator must change password first", 409);

    const session = await queryOne<{ id: string; expires_at: Date | string }>(client, `
      INSERT INTO app.impersonation_sessions (
        actual_operator_id, effective_operator_id, mode, reason, ticket_ref, expires_at
      )
      VALUES ($1, $2, 'read_only', $3, $4, now() + ($5::int * INTERVAL '1 minute'))
      RETURNING id::text, expires_at
    `, [actor.operatorId, target.operator_id, reason, input.ticketRef || null, durationMinutes]);
    if (!session) throw new PlatformError("impersonation_start_failed", "Could not start impersonation", 500);

    const token = signJwt({
      operatorId: target.operator_id,
      role: target.role,
      displayName: target.display_name,
      organizationId: target.organization_id,
      sessionVersion: security.sessionVersion,
      authState: "authenticated",
      actualOperatorId: actor.operatorId,
      effectiveOperatorId: target.operator_id,
      impersonationSessionId: session.id,
    });

    await recordAuditEntry(client, {
      ...actor,
      actualOperatorId: actor.operatorId,
      effectiveOperatorId: target.operator_id,
      impersonationSessionId: session.id,
    }, "platform.impersonation.started", "impersonation_session", session.id, {
      reason,
      after: {
        actualOperatorId: actor.operatorId,
        effectiveOperatorId: target.operator_id,
        mode: "read_only",
        ticketRef: input.ticketRef || null,
      },
    });

    return {
      data: {
        token,
        sessionId: session.id,
        mode: "read_only" as const,
        actualOperatorId: actor.operatorId,
        effectiveOperatorId: target.operator_id,
        reason,
        ticketRef: input.ticketRef || null,
        expiresAt: new Date(session.expires_at).toISOString(),
      },
    };
  });
}

export async function endReadOnlyImpersonation(
  actor: OperatorContext,
  input?: { sessionId?: string; reason?: string },
) {
  await ensurePlatformSchema();
  const sessionId = input?.sessionId || actor.impersonationSessionId || "";
  if (!sessionId) throw new PlatformError("validation_error", "Impersonation session is required", 400);

  return withConnectedTransaction(async (client) => {
    const ended = await queryOne<{ id: string; actual_operator_id: string; effective_operator_id: string }>(client, `
      UPDATE app.impersonation_sessions
      SET ended_at = COALESCE(ended_at, now()),
          end_reason = COALESCE($3, end_reason, 'ended')
      WHERE id::text = $1
        AND ended_at IS NULL
        AND ($2::text = actual_operator_id OR $2::text = effective_operator_id)
      RETURNING id::text, actual_operator_id, effective_operator_id
    `, [sessionId, actor.actualOperatorId || actor.operatorId, input?.reason || null]);
    if (!ended) throw new PlatformError("resource_not_found", "Active impersonation session not found", 404, { sessionId });

    await recordAuditEntry(client, actor, "platform.impersonation.ended", "impersonation_session", sessionId, {
      reason: input?.reason,
      after: {
        actualOperatorId: ended.actual_operator_id,
        effectiveOperatorId: ended.effective_operator_id,
      },
    });

    return { data: { sessionId, ended: true } };
  });
}
