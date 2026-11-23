import type { RequestContext } from "../index";

/**
 * @deprecated Test-only in-memory audit helper.
 * Production routes use DB-backed audit writes from the platform service path.
 */
export interface AuditEntry {
  actorType: string;
  actorId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  correlationId: string;
  ipAddress?: string;
}

const auditLog: AuditEntry[] = [];

/**
 * @deprecated Test-only in-memory audit helper.
 * Use the DB-backed audit repository/service in production code.
 */
export function recordAudit(entry: AuditEntry): void {
  auditLog.push({
    ...entry,
    correlationId: entry.correlationId || `cor_${Date.now()}`,
  });
}

/**
 * @deprecated Test-only in-memory audit helper.
 */
export function getAuditLog(filters?: {
  dateFrom?: string; dateTo?: string; actorId?: string; action?: string;
  limit?: number;
}): AuditEntry[] {
  let result = [...auditLog];
  if (filters?.actorId) result = result.filter(e => e.actorId === filters.actorId);
  if (filters?.action) result = result.filter(e => e.action === filters.action);
  return result.slice(0, filters?.limit || 100);
}

/**
 * @deprecated Test-only in-memory audit helper.
 */
export function createAuditMiddleware() {
  return {
    logMutation(context: RequestContext, action: string, subjectType: string, subjectId: string, before?: Record<string, unknown>, after?: Record<string, unknown>): void {
      recordAudit({
        actorType: context.actor.type,
        actorId: context.actor.id,
        action,
        subjectType,
        subjectId,
        before,
        after,
        correlationId: context.correlationId,
      });
    },
  };
}
