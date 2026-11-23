import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import type { ReportScope } from "@medusa-snus/contracts";

export async function listAudit(
  scope: ReportScope,
  query?: { actor?: string; action?: string; subject?: string },
) {
  if (!scope?.merchantId) {
    throw new PlatformError("scope_required", "listAudit requires tenantId in ReportScope", 409);
  }
  await ensurePlatformSchema();

  return withConnectedClient(async (client) => {
    const storeFilter = scope.storeIds && scope.storeIds.length > 0
      ? ` AND (store_id IS NULL OR store_id = ANY($5::text[]))`
      : "";
    const params: unknown[] = [query?.actor || null, query?.action || null, query?.subject || null, scope.merchantId];
    if (scope.storeIds && scope.storeIds.length > 0) params.push(scope.storeIds);
    const result = await client.query(`
      SELECT
        id::text,
        actor_type AS "actorType",
        actor_id AS "actorId",
        action,
        subject_type AS "subjectType",
        subject_id AS "subjectId",
        merchant_id AS "merchantId",
        store_id AS "storeId",
        before,
        after,
        reason,
        correlation_id AS "correlationId",
        channel,
        channel_user_id AS "channelUserId",
        service_identity AS "serviceIdentity",
        request_id AS "requestId",
        actual_actor_id AS "actualActorId",
        effective_actor_id AS "effectiveActorId",
        impersonation_session_id AS "impersonationSessionId",
        actor_chain AS "actorChain",
        created_at AS "createdAt"
      FROM audit.events
      WHERE ($1::text IS NULL OR actor_id = $1)
        AND ($2::text IS NULL OR action = $2)
        AND ($3::text IS NULL OR subject_type = $3 OR subject_id = $3)
        AND merchant_id = $4${storeFilter}
      ORDER BY created_at DESC
      LIMIT 300
    `, params);
    return { data: result.rows };
  });
}
