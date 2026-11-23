import {
  CreatorOptionV1Schema,
  type CreatorOptionV1,
  type CreatorSelectionV1,
  type ReportScope,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";

function normalizedScope(scope: ReportScope): { merchantId: string; storeIds: string[] } {
  const storeIds = [...new Set(scope.storeIds)].sort();
  if (!scope.merchantId || storeIds.length === 0) {
    throw new PlatformError("scope_required", "Creator selection requires an authorized report scope", 409);
  }
  return { merchantId: scope.merchantId, storeIds };
}

/**
 * Returns only the identity needed for a creator selector. Active memberships
 * are included even before the operator creates an order; departed operators
 * are included only when a trusted creation event is available in the scope.
 */
export async function readCreatorOptionsV1(
  client: Pick<PoolClient, "query">,
  scopeInput: ReportScope,
): Promise<CreatorOptionV1[]> {
  const scope = normalizedScope(scopeInput);
  const result = await client.query<Record<string, unknown>>(`
    WITH scoped_stores AS (
      SELECT unnest($2::text[]) AS store_id
    ), active_candidates AS (
      SELECT DISTINCT om.operator_id,
        COALESCE(NULLIF(BTRIM(staff.display_name), ''), om.operator_id) AS display_name
      FROM app.operator_memberships om
      JOIN scoped_stores scoped ON (
        om.scope_type = 'merchant'
        OR (om.scope_type = 'store' AND om.store_id = scoped.store_id)
      )
      LEFT JOIN medusa.staff_users staff ON staff.operator_id = om.operator_id
      WHERE om.merchant_id = $1
        AND om.status = 'active'
        AND om.valid_from <= transaction_timestamp()
        AND (om.valid_to IS NULL OR om.valid_to > transaction_timestamp())
        AND om.scope_type IN ('merchant', 'store')
    ), trusted_historical AS (
      SELECT DISTINCT MAX(event.actor_id) AS operator_id
      FROM audit.events event
      JOIN public."order" source_order
        ON source_order.id = event.subject_id
       AND source_order.merchant_id = $1
       AND source_order.store_id = ANY($2::text[])
       AND source_order.deleted_at IS NULL
      WHERE event.subject_type = 'order'
        AND event.action IN ('order.created', 'order.remote_created', 'order.partner_created')
      GROUP BY event.subject_id
      HAVING COUNT(*) = 1
         AND MAX(event.actor_type) IN ('staff', 'manager', 'owner', 'accountant')
         AND MAX(event.merchant_id) = $1
         AND MAX(event.store_id) = MAX(source_order.store_id)
    ), candidates AS (
      SELECT operator_id, display_name, 'active'::text AS status FROM active_candidates
      UNION ALL
      SELECT historical.operator_id,
        COALESCE(NULLIF(BTRIM(staff.display_name), ''), historical.operator_id) AS display_name,
        'historical'::text AS status
      FROM trusted_historical historical
      LEFT JOIN medusa.staff_users staff ON staff.operator_id = historical.operator_id
      WHERE NOT EXISTS (
        SELECT 1 FROM active_candidates active WHERE active.operator_id = historical.operator_id
      )
    )
    SELECT operator_id, display_name, status
    FROM candidates
    ORDER BY LOWER(display_name), operator_id
  `, [scope.merchantId, scope.storeIds]);

  return result.rows.map((row) => CreatorOptionV1Schema.parse({
    operatorId: row.operator_id,
    displayName: row.display_name,
    status: row.status,
  }));
}

export async function assertCreatorSelectionInScopeV1(
  client: Pick<PoolClient, "query">,
  scope: ReportScope,
  selection: CreatorSelectionV1,
): Promise<CreatorOptionV1[]> {
  const options = await readCreatorOptionsV1(client, scope);
  if (selection.mode === "all") return options;
  const allowed = new Set(options.map((option) => option.operatorId));
  if (selection.creatorOperatorIds.some((operatorId) => !allowed.has(operatorId))) {
    throw new PlatformError(
      "forbidden",
      "A selected order creator is outside the authorized report scope",
      403,
    );
  }
  return options;
}
