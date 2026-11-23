import type { PoolClient } from "pg";
import type { PartnerEnvironment } from "@medusa-snus/contracts/partner-api";
import { PlatformError } from "../errors/platform-error";
import { PlatformMcpAuthorizationSnapshotV1Schema, hashPlatformMcpAuthorizationSnapshotV1, hashPlatformMcpPolicyV1 } from "../services/platform-mcp-authorization-snapshot";
import { platformMcpIssuancePresetV1, platformMcpProfileScopesV1 } from "../services/platform-mcp-policy";

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(value => b.includes(value));
const invalidApproval = () => new PlatformError("mcp_approval_invalid", "MCP connection no longer matches its immutable approval", 409);

/** Internal resource snapshot only. Caller owns current actor authority, transaction and mutation locks. */
export async function loadPlatformMcpAuthorizationForClient(db: PoolClient, merchantId: string, integrationId: string, environment: PartnerEnvironment) {
  const integration = (await db.query(`SELECT i.status,i.writes_enabled,i.grant_version,i.policy_id,i.policy_version,
    i.platform_mcp_origin_receipt_id, jsonb_build_object('currency',p.currency,'max_order_total',p.max_order_total,
      'max_quantity',p.max_quantity,'safety_stock',p.safety_stock,'delivery_fee',p.delivery_fee,
      'contact_retention_days',p.contact_retention_days,'read_per_minute',p.read_per_minute,'read_burst',p.read_burst,
      'quote_per_minute',p.quote_per_minute,'quote_burst',p.quote_burst,'book_per_minute',p.book_per_minute,
      'book_burst',p.book_burst,'mutation_concurrency',p.mutation_concurrency) AS policy
    FROM integration.integrations i JOIN integration.policies p ON p.id=i.policy_id AND p.version=i.policy_version AND p.merchant_id=i.merchant_id
    WHERE i.id=$1 AND i.merchant_id=$2 AND i.environment=$3`, [integrationId, merchantId, environment])).rows[0];
  if (!integration) throw new PlatformError("resource_not_found", "MCP connection not found", 404);
  // Every grant participates in CAS, independently of the public metadata page size.
  const grants = (await db.query(`SELECT g.store_id AS "storeId",g.stock_location_id AS "stockLocationId",g.status,
    g.allowed_scopes AS "allowedScopes",g.mcp_catalog_mode AS "mcpCatalogMode",g.version AS "grantVersion",
    g.assortment_id AS "assortmentId",a.status AS "assortmentStatus",a.version AS "assortmentVersion"
    FROM integration.store_grants g LEFT JOIN integration.assortments a ON a.id=g.assortment_id AND a.merchant_id=$2
    WHERE g.integration_id=$1 ORDER BY g.store_id`, [integrationId, merchantId])).rows;
  let approval = null;
  if (integration.platform_mcp_origin_receipt_id) {
    const origin = (await db.query(`SELECT workflow_version AS "workflowVersion",max_approved_profile AS "maxApprovedProfile",
      approved_scopes AS "approvedScopes",approved_store_ids AS "approvedStoreIds",preset_version AS "presetVersion",
      policy_id AS "policyId",policy_version AS "policyVersion",policy_sha256 AS "policySha256",readiness_sha256 AS "readinessSha256"
      FROM integration.control_request_receipts WHERE id=$1 AND operation='create_connection' AND result_integration_id=$2
      AND merchant_id=$3 AND environment=$4`, [integration.platform_mcp_origin_receipt_id, integrationId, merchantId, environment])).rows[0];
    if (!origin || !/^[a-f0-9]{64}$/.test(origin.readinessSha256 ?? "")) throw invalidApproval();
    const { readinessSha256: _readiness, ...durableApproval } = origin;
    approval = durableApproval;
  }
  const parsed = PlatformMcpAuthorizationSnapshotV1Schema.safeParse({ schemaVersion: 1, environment, merchantId, integrationId,
    integration: { status: integration.status, writesEnabled: integration.writes_enabled, version: integration.grant_version,
      policyId: integration.policy_id, policyVersion: integration.policy_version, policy: integration.policy }, grants, approval });
  if (!parsed.success) {
    if (integration.platform_mcp_origin_receipt_id) throw invalidApproval();
    throw new PlatformError("dependency_unavailable", "MCP authorization metadata is invalid", 503);
  }
  const snapshot = parsed.data, approved = snapshot.approval;
  if (approved && (approved.policyId !== snapshot.integration.policyId || approved.policyVersion !== snapshot.integration.policyVersion
    || approved.policySha256 !== hashPlatformMcpPolicyV1(snapshot.integration.policy)
    || approved.policySha256 !== hashPlatformMcpPolicyV1(platformMcpIssuancePresetV1.policy)
    || !sameSet(approved.approvedScopes, platformMcpProfileScopesV1[approved.maxApprovedProfile])
    || !sameSet(approved.approvedStoreIds, snapshot.grants.map(grant => grant.storeId))
    || snapshot.grants.some(grant => grant.mcpCatalogMode !== "merchant_published" || !sameSet(grant.allowedScopes, approved.approvedScopes))
    || (approved.maxApprovedProfile === "read" && snapshot.integration.writesEnabled))) throw invalidApproval();
  return { snapshot, sha256: hashPlatformMcpAuthorizationSnapshotV1(snapshot) };
}
