import type { PoolClient } from "pg";
import { PlatformMcpConnectionSummaryV1Schema, PlatformMcpConnectionDetailV1Schema,
  PlatformMcpConnectionListV1Schema, PlatformMcpListQueryV1Schema, PlatformMcpDetailQueryV1Schema } from "@medusa-snus/contracts";
import type { PartnerEnvironment } from "@medusa-snus/contracts/partner-api";
import { PlatformError } from "../errors/platform-error";
import type { PermissionActor } from "../services/permission-service";
import { withControlDatabase } from "./control-database";
import { requirePlatformMcpStaffSession, readPlatformMcpReaderRoleForClient } from "./platform-mcp-authority";
import { loadPlatformMcpAuthorizationForClient } from "./platform-mcp-authorization";
import { trustedPlatformMcpUrlForHost } from "./platform-mcp-url";

const selectConnections = `SELECT i.id AS "integrationId",i.merchant_id AS "merchantId",p.display_name AS name,i.environment,i.status,
  i.writes_enabled AS "writesEnabled",i.grant_version AS "integrationVersion",m.status AS "merchantStatus",
  i.platform_mcp_origin_receipt_id IS NOT NULL AS "managedByPlatform",
  EXISTS(SELECT 1 FROM integration.clients c WHERE c.integration_id=i.id) AS "hasOauthClients"
  FROM integration.integrations i JOIN integration.partners p ON p.id=i.partner_id JOIN app.merchants m ON m.id=i.merchant_id`;
const targetPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
async function assertFreshReadTransaction(db: PoolClient) {
  const row = (await db.query(`SELECT current_setting('transaction_read_only')='on'
    AND current_setting('transaction_isolation')='read committed' AS allowed`)).rows[0];
  if (!row?.allowed) throw new PlatformError("dependency_unavailable", "MCP metadata requires a fresh read-only transaction", 503);
}
const iso = (date: Date) => date.toISOString();

export async function listPlatformMcpConnectionsForClient(db: PoolClient, actorInput: PermissionActor, merchantId: string,
  rawQuery: unknown, environment: PartnerEnvironment) {
  const actor = requirePlatformMcpStaffSession(actorInput), query = PlatformMcpListQueryV1Schema.safeParse(rawQuery);
  if (!targetPattern.test(merchantId) || !query.success || !["sandbox", "production"].includes(environment)) {
    throw new PlatformError("validation_error", "Invalid MCP metadata target or page", 400);
  }
  await assertFreshReadTransaction(db); await readPlatformMcpReaderRoleForClient(db, actor);
  if (!(await db.query("SELECT id FROM app.merchants WHERE id=$1", [merchantId])).rowCount) {
    throw new PlatformError("resource_not_found", "Merchant not found", 404);
  }
  const { after, status, limit } = query.data;
  const rows = (await db.query(`${selectConnections} WHERE i.merchant_id=$1 AND i.environment=$2
    AND ($3::text IS NULL OR i.id>$3) AND ($4::text IS NULL OR i.status=$4) ORDER BY i.id LIMIT $5`,
  [merchantId, environment, after ?? null, status ?? null, limit + 1])).rows;
  const role = await readPlatformMcpReaderRoleForClient(db, actor);
  return PlatformMcpConnectionListV1Schema.parse({ data: rows.slice(0, limit).map(row => PlatformMcpConnectionSummaryV1Schema.parse(row)),
    nextAfter: rows.length > limit ? rows[limit - 1].integrationId : null, canRevokeKeys: role === "platform_admin", mcpUrl: trustedPlatformMcpUrlForHost(process.env.PARTNER_PUBLIC_HOST) });
}

export async function getPlatformMcpConnectionForClient(db: PoolClient, actorInput: PermissionActor, merchantId: string,
  integrationId: string, rawQuery: unknown, environment: PartnerEnvironment) {
  const actor = requirePlatformMcpStaffSession(actorInput), query = PlatformMcpDetailQueryV1Schema.safeParse(rawQuery);
  if (!targetPattern.test(merchantId) || !targetPattern.test(integrationId) || !query.success || !["sandbox", "production"].includes(environment)) {
    throw new PlatformError("validation_error", "Invalid MCP metadata target or page", 400);
  }
  await assertFreshReadTransaction(db); await readPlatformMcpReaderRoleForClient(db, actor);
  const row = (await db.query(`${selectConnections} WHERE i.id=$1 AND i.merchant_id=$2 AND i.environment=$3`, [integrationId, merchantId, environment])).rows[0];
  if (!row) throw new PlatformError("resource_not_found", "MCP connection not found", 404);
  let authorizationSnapshotSha256: string | null = null, authorizationWarning: "mcp_approval_invalid" | null = null;
  let maxApprovedProfile: "read" | "commerce" | null = null;
  try {
    const loaded = await loadPlatformMcpAuthorizationForClient(db, merchantId, integrationId, environment);
    authorizationSnapshotSha256 = loaded.sha256; maxApprovedProfile = loaded.snapshot.approval?.maxApprovedProfile ?? null;
  } catch (error) {
    if (!(error instanceof PlatformError) || error.code !== "mcp_approval_invalid") throw error;
    authorizationWarning = "mcp_approval_invalid";
  }
  const { limit, keysAfter, grantsAfter, receiptsAfter } = query.data;
  const keys = (await db.query(`SELECT id,version,status,label,scopes,expires_at,created_at,revoked_at
    FROM integration.partner_mcp_keys WHERE integration_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT $3`, [integrationId, keysAfter ?? null, limit + 1])).rows;
  const grants = (await db.query(`SELECT g.store_id AS "storeId",g.stock_location_id AS "stockLocationId",g.status,
    g.allowed_scopes AS scopes,g.mcp_catalog_mode AS "catalogMode",g.version,g.assortment_id AS "assortmentId",s.status AS "storeStatus"
    FROM integration.store_grants g JOIN app.stores s ON s.id=g.store_id AND s.merchant_id=g.merchant_id
    WHERE g.integration_id=$1 AND ($2::text IS NULL OR g.store_id>$2) ORDER BY g.store_id LIMIT $3`, [integrationId, grantsAfter ?? null, limit + 1])).rows;
  const receipts = (await db.query(`SELECT id::text AS "receiptId",actor_id AS "actorId",operation,state,result_key_id AS "resultKeyId",created_at
    FROM integration.control_request_receipts WHERE result_integration_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`, [integrationId, receiptsAfter ?? null, limit + 1])).rows;
  const role = await readPlatformMcpReaderRoleForClient(db, actor);
  return PlatformMcpConnectionDetailV1Schema.parse({ connection: row, canRevokeKeys: role === "platform_admin", mcpUrl: trustedPlatformMcpUrlForHost(process.env.PARTNER_PUBLIC_HOST),
    authorizationSnapshotSha256, authorizationWarning, maxApprovedProfile,
    keys: { data: keys.slice(0, limit).map(({ expires_at, created_at, revoked_at, ...key }) => ({ ...key, expiresAt: iso(expires_at),
      createdAt: iso(created_at), revokedAt: revoked_at ? iso(revoked_at) : null })), nextAfter: keys.length > limit ? keys[limit - 1].id : null },
    grants: { data: grants.slice(0, limit), nextAfter: grants.length > limit ? grants[limit - 1].storeId : null },
    receipts: { data: receipts.slice(0, limit).map(({ created_at, ...receipt }) => ({ ...receipt, createdAt: iso(created_at) })),
      nextAfter: receipts.length > limit ? receipts[limit - 1].receiptId : null } });
}
export function listPlatformMcpConnections(actor: PermissionActor, merchantId: string, query: unknown) {
  requirePlatformMcpStaffSession(actor);
  return withControlDatabase("fresh-read", (db, environment) => listPlatformMcpConnectionsForClient(db, actor, merchantId, query, environment));
}
export function getPlatformMcpConnection(actor: PermissionActor, merchantId: string, integrationId: string, query: unknown) {
  requirePlatformMcpStaffSession(actor);
  return withControlDatabase("fresh-read", (db, environment) => getPlatformMcpConnectionForClient(db, actor, merchantId, integrationId, query, environment));
}
