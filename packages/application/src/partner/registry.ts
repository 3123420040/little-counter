import type { PoolClient } from "pg";
import type { PartnerCatalogMode, PartnerEnvironment, PartnerScope } from "@medusa-snus/contracts/partner-api";
import { statusForClock } from "../services/subscription-service";
import { PartnerError } from "./errors";
import type { VerifiedPartnerToken } from "./token";
import type { PartnerCredential } from "../utils/business-actor";
import { verifyPartnerMcpKey } from "./mcp-key";

export interface PartnerPolicy {
  id: string; version: number; currency: "VND"; maxOrderTotal: number; maxQuantity: number;
  safetyStock: number; deliveryFee: number | null; contactRetentionDays: number;
  readPerMinute: number; quotePerMinute: number; bookPerMinute: number;
  readBurst: number; quoteBurst: number; bookBurst: number; mutationConcurrency: number;
}
export interface PartnerGrant {
  storeId: string; stockLocationId: string; assortmentId: string;
  version: number; assortmentVersion: number; mcpCatalogMode: PartnerCatalogMode; scopes: readonly PartnerScope[];
}
export type PartnerIdentity = PartnerCredential & {
  actorType: "partner"; partnerId: string; integrationId: string;
  merchantId: string; organizationId: string;
  environment: PartnerEnvironment; grantVersion: number; requestId: string; traceId: string; spanId?: string;
  policy: Readonly<PartnerPolicy>; grants: readonly PartnerGrant[];
  writesEnabled: boolean; writesDenialCode: "integration_disabled" | "merchant_capability_denied" | null;
};
export type PartnerContext = PartnerIdentity & {
  storeId: string; stockLocationId: string; assortmentId: string;
  storeGrantVersion: number; assortmentVersion: number; catalogMode: PartnerCatalogMode; scopes: readonly PartnerScope[];
};

export async function readPartnerIdentity(
  db: PoolClient, token: VerifiedPartnerToken, environment: PartnerEnvironment,
  requestId: string, traceId: string, spanId?: string,
): Promise<PartnerIdentity> {
  const client = (await db.query(`SELECT id,integration_id,subject,status,
    retire_at IS NULL OR retire_at>clock_timestamp() AS valid FROM integration.clients
    WHERE issuer=$1 AND oauth_client_id=$2`,[token.issuer,token.clientId])).rows[0];
  if (!client || client.subject !== token.subject) throw new PartnerError("invalid_token");
  if (client.status !== "active" || !client.valid) throw new PartnerError("integration_disabled");
  return readIntegrationIdentity(db, client.integration_id, token.scopes,
    {authMethod:"oauth_client",credentialId:token.clientId,clientId:token.clientId,registryClientId:client.id,keyId:null},
    environment,requestId,traceId,spanId);
}

export async function readPartnerMcpIdentity(db: PoolClient, authorization: unknown, environment: PartnerEnvironment,
  requestId: string, traceId: string, spanId?: string): Promise<PartnerIdentity> {
  const verified = await verifyPartnerMcpKey(db,authorization,environment);
  return readIntegrationIdentity(db,verified.integrationId,verified.scopes,
    {authMethod:"mcp_key",credentialId:verified.keyId,keyId:verified.keyId,clientId:null,registryClientId:null},
    environment,requestId,traceId,spanId);
}

async function readIntegrationIdentity(db: PoolClient, integrationId: string, scopes: readonly PartnerScope[],
  credential: PartnerCredential, environment: PartnerEnvironment, requestId: string, traceId: string, spanId?: string): Promise<PartnerIdentity> {
  const result = await db.query(`
    SELECT i.id AS integration_id,i.partner_id,i.merchant_id,i.environment,i.status AS integration_status,
      i.writes_enabled,i.grant_version,p.status AS partner_status,m.status AS merchant_status,
      m.legacy_organization_id AS organization_id,pol.*,
      sub.current_period_end,sub.grace_ends_at,cat.feature_keys
    FROM integration.integrations i
    JOIN integration.partners p ON p.id=i.partner_id
    JOIN app.merchants m ON m.id=i.merchant_id
    JOIN integration.policies pol ON pol.id=i.policy_id AND pol.version=i.policy_version AND pol.merchant_id=i.merchant_id
    LEFT JOIN app.merchant_subscriptions sub ON sub.merchant_id=i.merchant_id
    LEFT JOIN app.package_catalog_versions cat ON cat.id=sub.catalog_version_id
    WHERE i.id=$1
  `, [integrationId]);
  const row = result.rows[0];
  if (!row || row.environment !== environment) throw new PartnerError("invalid_token");
  if (row.integration_status !== "active" || row.partner_status !== "active" || row.merchant_status !== "active") {
    throw new PartnerError("integration_disabled");
  }
  if (!row.organization_id) throw new PartnerError("dependency_unavailable");
  const grantRows = await db.query(`
    SELECT g.store_id,g.stock_location_id,g.allowed_scopes,g.version,g.assortment_id,g.mcp_catalog_mode,a.version AS assortment_version
    FROM integration.store_grants g
    JOIN app.stores s ON s.id=g.store_id AND s.merchant_id=g.merchant_id AND s.stock_location_id=g.stock_location_id
    JOIN public.stock_location l ON l.id=g.stock_location_id AND l.deleted_at IS NULL
    JOIN integration.assortments a ON a.id=g.assortment_id AND a.merchant_id=g.merchant_id
    WHERE g.integration_id=$1 AND g.merchant_id=$2 AND g.status='active' AND s.status='active' AND a.status='active'
    ORDER BY g.store_id
  `, [row.integration_id, row.merchant_id]);
  const grants = grantRows.rows.map((grant) => Object.freeze({
    storeId: grant.store_id, stockLocationId: grant.stock_location_id, assortmentId: grant.assortment_id,
    version: grant.version, assortmentVersion: grant.assortment_version,
    mcpCatalogMode: grant.mcp_catalog_mode === "merchant_published" ? "merchant_published" : "explicit",
    scopes: Object.freeze(scopes.filter((scope) => grant.allowed_scopes.includes(scope))),
  }));
  const periodEnd = row.current_period_end ? new Date(row.current_period_end) : null;
  // Match the existing seven-day subscription grace policy without lazy writes.
  const graceEnd = row.grace_ends_at ? new Date(row.grace_ends_at)
    : periodEnd ? new Date(periodEnd.getTime() + 7 * 86_400_000) : null;
  const capability = periodEnd && Number.isFinite(periodEnd.getTime()) && graceEnd && Number.isFinite(graceEnd.getTime())
    && statusForClock(periodEnd, graceEnd, new Date()) !== "expired"
    && Array.isArray(row.feature_keys) && row.feature_keys.includes("partner_api");
  const policy: PartnerPolicy = {
    id: row.id, version: row.version, currency: row.currency,
    maxOrderTotal: Number(row.max_order_total), maxQuantity: row.max_quantity,
    safetyStock: row.safety_stock, deliveryFee: row.delivery_fee === null ? null : Number(row.delivery_fee),
    contactRetentionDays: row.contact_retention_days,
    readPerMinute: row.read_per_minute, quotePerMinute: row.quote_per_minute, bookPerMinute: row.book_per_minute,
    readBurst: row.read_burst, quoteBurst: row.quote_burst, bookBurst: row.book_burst, mutationConcurrency: row.mutation_concurrency,
  };
  if (policy.currency !== "VND" || !Number.isSafeInteger(policy.maxOrderTotal) || policy.maxOrderTotal <= 0) throw new PartnerError("merchant_capability_denied");
  const writesDenialCode = !row.writes_enabled ? "integration_disabled" : !capability ? "merchant_capability_denied" : null;
  return Object.freeze({ actorType: "partner", partnerId: row.partner_id, integrationId: row.integration_id,
    ...credential, merchantId: row.merchant_id,
    organizationId: row.organization_id, environment, grantVersion: row.grant_version,
    requestId, traceId, spanId, policy: Object.freeze(policy), grants: Object.freeze(grants),
    writesEnabled: writesDenialCode === null, writesDenialCode });
}
export function selectPartnerStore(identity: PartnerIdentity, storeId: string, scope: PartnerScope | readonly PartnerScope[], write = false): PartnerContext {
  const grant = identity.grants.find((g) => g.storeId === storeId);
  if (!grant) throw new PartnerError("store_not_allowed");
  const requiredScopes = typeof scope === "string" ? [scope] : scope;
  if (!requiredScopes.every((required) => grant.scopes.includes(required))) throw new PartnerError("insufficient_scope");
  if (write && identity.writesDenialCode) throw new PartnerError(identity.writesDenialCode);
  return Object.freeze({ ...identity, storeId, stockLocationId: grant.stockLocationId,
    assortmentId: grant.assortmentId, storeGrantVersion: grant.version,
    assortmentVersion: grant.assortmentVersion,
    catalogMode: identity.authMethod === "mcp_key" ? grant.mcpCatalogMode : "explicit", scopes: grant.scopes });
}
export function partnerMe(identity: PartnerIdentity) {
  if (!identity.grants.some((grant) => grant.scopes.includes("partner:read"))) throw new PartnerError("insufficient_scope");
  return {
    partner_id: identity.partnerId, integration_id: identity.integrationId, client_id: identity.clientId,
    environment: identity.environment, merchant_id: identity.merchantId,
    scopes: [...new Set(identity.grants.flatMap((grant) => grant.scopes))],
    stores: identity.grants.map((grant) => ({ store_id: grant.storeId, scopes: grant.scopes })),
    limits: { read_requests_per_minute: identity.policy.readPerMinute, quote_requests_per_minute: identity.policy.quotePerMinute,
      book_requests_per_minute: identity.policy.bookPerMinute, max_page_size: 100, max_order_lines: 50,
      max_order_total: identity.policy.maxOrderTotal, currency: "VND" },
    writes_enabled: identity.writesEnabled, writes_denial_code: identity.writesDenialCode,
  };
}
