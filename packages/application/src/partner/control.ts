import type { PoolClient } from "pg";
import { withControlDatabase } from "./control-database";
import { randomUUID } from "node:crypto";
import { permissions, type MerchantTargetScope } from "@medusa-snus/contracts";
import { PartnerControlCommand, PartnerControlStatusQuery, type PartnerControlInput, type PartnerControlPolicyInput, type PartnerEnvironment } from "@medusa-snus/contracts/partner-api";
import { requireScopedActorPermission, assertNotReadOnlyImpersonation, type PermissionActor } from "../services/permission-service";
import { recordAuditEntry } from "../repositories/audit-repository";
import { PlatformError } from "../errors/platform-error";
import { mutatePartnerMcpKey, type McpKeyCommand } from "./mcp-key-control";
import { lockActivePartnerControlScopeForClient } from "../services/business-lifecycle-service";

const newId = (prefix: string) => `${prefix}_${randomUUID()}`;
const fail = (code: string, status: number): never => { throw new PlatformError(code, code.replaceAll("_", " "), status); };
/** Internal registry primitive; caller owns the transaction, authority and tenant scope. */
export async function insertPartnerPolicyForClient(db: PoolClient, merchantId: string, policyId: string, version: number, p: PartnerControlPolicyInput) {
  await db.query(`INSERT INTO integration.policies(id,version,merchant_id,currency,max_order_total,max_quantity,safety_stock,delivery_fee,
    contact_retention_days,read_per_minute,read_burst,quote_per_minute,quote_burst,book_per_minute,book_burst,mutation_concurrency)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
  [policyId, version, merchantId, p.currency, p.max_order_total, p.max_quantity, p.safety_stock, p.delivery_fee,
    p.contact_retention_days, p.read_per_minute, p.read_burst, p.quote_per_minute, p.quote_burst, p.book_per_minute, p.book_burst, p.mutation_concurrency]);
}

/** Caller owns one transaction. Staff coupled permission is enforced here too,
 * so CLI/non-route callers cannot substitute an independently resolved target. */
export async function executePartnerControlForClient(db: PoolClient, actor: PermissionActor, scope: MerchantTargetScope,
  raw: unknown, environment: PartnerEnvironment, issuer: string | undefined, requestId: string) {
  if ("channel" in actor) fail("forbidden", 403);
  await assertNotReadOnlyImpersonation(actor);
  await requireScopedActorPermission(actor, permissions.partnerManage, { scopeType: "merchant", merchantId: scope.merchantId });
  const parsed = PartnerControlCommand.safeParse(raw);
  if (!parsed.success) fail("invalid_request", 400);
  const command = parsed.data!;
  const merchant = (await db.query("SELECT id,status,legacy_organization_id FROM app.merchants WHERE id=$1", [scope.merchantId])).rows[0];
  if (!merchant || merchant.status !== "active" || !merchant.legacy_organization_id) fail("resource_not_found", 404);
  let integrationId: string;
  let before: Record<string, unknown> | undefined;
  let after: Record<string, unknown>;
  let revealedKey: string | undefined;
  if (command.action === "create") {
    if (command.environment !== environment) fail("invalid_request", 400);
    await lockActivePartnerControlScopeForClient(db, scope.merchantId);
    integrationId = newId("int");
    const partnerId = newId("ptn"); const policyId = newId("ppol");
    await db.query("INSERT INTO integration.partners(id,code,display_name,status) VALUES ($1,$1,$2,'active')", [partnerId, command.partner_name]);
    await insertPartnerPolicyForClient(db, scope.merchantId, policyId, 1, command.policy);
    await db.query(`INSERT INTO integration.integrations(id,partner_id,merchant_id,environment,installation_key,policy_id,policy_version)
      VALUES ($1,$2,$3,$4,$5,$6,1)`, [integrationId, partnerId, scope.merchantId, environment, command.installation_key, policyId]);
    after = { integration_id: integrationId, partner_id: partnerId, status: "inactive", writes_enabled: false, policy_version: 1 };
  } else {
    integrationId = command.integration_id;
    // Always lock integration before grant/client/assortment. Public mutations
    // hold SHARE on this same row; revoke ACK occurs only after control commit.
    const current = (await db.query(`SELECT * FROM integration.integrations
      WHERE id=$1 AND merchant_id=$2 AND environment=$3 FOR UPDATE`, [integrationId, scope.merchantId, environment])).rows[0];
    if (!current) fail("resource_not_found", 404);
    await lockActivePartnerControlScopeForClient(db, scope.merchantId, command.action === "set_grant" ? command.store_id : undefined);
    before = { status: current.status, writes_enabled: current.writes_enabled, grant_version: current.grant_version, policy_version: current.policy_version };
    if(command.action==="create_mcp_key"||command.action==="rotate_mcp_key"||command.action==="revoke_mcp_key"||command.action==="set_mcp_key_scopes") {
      const result=await mutatePartnerMcpKey(db,command,environment,actor.operatorId,current.status);
      after=result.audit;revealedKey=result.revealedKey;
    } else after = await mutateIntegration(db, command, current, scope.merchantId, issuer, requestId, actor.operatorId);
  }
  await recordAuditEntry(db, { ...actor, organizationId: merchant.legacy_organization_id, requestId },
    `partner.${command.action}`, "partner_integration", integrationId,
    { merchantId: scope.merchantId, before, after, reason: command.reason, correlationId: requestId });
  return { integration_id: integrationId, ...after, request_id: requestId, ...(revealedKey?{revealed_key:revealedKey}:{}) };
}

async function mutateIntegration(db: PoolClient, command: Exclude<PartnerControlInput, { action: "create" }|McpKeyCommand>,
  current: { id: string; status: string; policy_id: string; policy_version: number }, merchantId: string,
  issuer: string | undefined, requestId: string, actorId: string): Promise<Record<string, unknown>> {
  if (command.action === "set_policy") {
    const version = current.policy_version + 1;
    await insertPartnerPolicyForClient(db, merchantId, current.policy_id, version, command.policy);
    await db.query("UPDATE integration.integrations SET policy_version=$2 WHERE id=$1", [current.id, version]);
    return { policy_version: version };
  }
  if (command.action === "set_assortment") {
    const assortmentId = command.assortment_id ?? command.new_assortment_id ?? newId("pas");
    if (command.assortment_id) {
      const updated = await db.query("UPDATE integration.assortments SET status=$3 WHERE id=$1 AND merchant_id=$2 RETURNING id", [assortmentId, merchantId, command.status]);
      if (!updated.rowCount) fail("resource_not_found", 404);
    } else {
      // First deployment can bind an explicit new identity in the immutable
      // packet. A collision never becomes an update or discloses its owner.
      const created = await db.query("INSERT INTO integration.assortments(id,merchant_id,status) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING RETURNING id", [assortmentId, merchantId, command.status]);
      if (!created.rowCount) fail("assortment_identity_conflict", 409);
    }
    const valid = await db.query(`SELECT v.id FROM public.product_variant v JOIN public.product p ON p.id=v.product_id
      WHERE v.id=ANY($1::text[]) AND p.merchant_id=$2 AND v.deleted_at IS NULL AND p.deleted_at IS NULL AND p.status='published'`, [command.variant_ids, merchantId]);
    if (valid.rowCount !== command.variant_ids.length) fail("resource_not_found", 404);
    await db.query("DELETE FROM integration.assortment_items WHERE assortment_id=$1", [assortmentId]);
    await db.query("INSERT INTO integration.assortment_items(assortment_id,variant_id) SELECT $1,unnest($2::text[])", [assortmentId, command.variant_ids.slice().sort()]);
    return { assortment_id: assortmentId, variant_count: command.variant_ids.length, status: command.status };
  }
  if (command.action === "set_grant") {
    const store = (await db.query(`SELECT s.stock_location_id FROM app.stores s JOIN public.stock_location l ON l.id=s.stock_location_id
      WHERE s.id=$1 AND s.merchant_id=$2 AND s.status='active' AND l.deleted_at IS NULL`, [command.store_id, merchantId])).rows[0];
    const assortment = (await db.query("SELECT id FROM integration.assortments WHERE id=$1 AND merchant_id=$2", [command.assortment_id, merchantId])).rowCount;
    if (!store || !assortment) fail("resource_not_found", 404);
    await db.query(`INSERT INTO integration.store_grants(integration_id,merchant_id,store_id,stock_location_id,allowed_scopes,assortment_id,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (integration_id,store_id) DO UPDATE
      SET allowed_scopes=EXCLUDED.allowed_scopes,assortment_id=EXCLUDED.assortment_id,status=EXCLUDED.status`,
    [current.id, merchantId, command.store_id, store.stock_location_id, command.scopes, command.assortment_id, command.status]);
    return { store_id: command.store_id, scopes: command.scopes, status: command.status, assortment_id: command.assortment_id };
  }
  if (command.action === "set_status") {
    if (command.status !== "active" && command.writes_enabled) fail("invalid_request", 400);
    if (command.status === "active") {
      if (!command.conformance_receipt_sha256) fail("conformance_required", 409);
      const ready = (await db.query(`SELECT (EXISTS(SELECT 1 FROM integration.clients WHERE integration_id=$1 AND status='active'
          AND (retire_at IS NULL OR retire_at>clock_timestamp())) OR EXISTS(SELECT 1 FROM integration.partner_mcp_keys
          WHERE integration_id=$1 AND status='active' AND expires_at>clock_timestamp())) AND EXISTS(SELECT 1 FROM integration.store_grants g
          JOIN integration.assortments a ON a.id=g.assortment_id AND a.status='active'
          JOIN app.stores s ON s.id=g.store_id AND s.merchant_id=g.merchant_id AND s.status='active'
          WHERE g.integration_id=$1 AND g.status='active') AS ready`, [current.id])).rows[0]?.ready;
      if (!ready) fail("integration_not_ready", 409);
      const lockedReady = await db.query<{ ready: boolean }>("SELECT integration.lock_active_control_ready_store($1,$2) AS ready", [current.id, merchantId]);
      if (!lockedReady.rows[0]?.ready) fail("integration_not_ready", 409);
      if (command.writes_enabled) {
        const capable = (await db.query(`SELECT 1 FROM app.merchant_subscriptions s JOIN app.package_catalog_versions c ON c.id=s.catalog_version_id
          WHERE s.merchant_id=$1 AND GREATEST(s.current_period_end,COALESCE(s.grace_ends_at,s.current_period_end+interval '7 days'))>now()
          AND c.feature_keys ? 'partner_api'`, [merchantId])).rowCount;
        if (!capable) fail("merchant_capability_denied", 403);
      }
    }
    await db.query("UPDATE integration.integrations SET status=$2,writes_enabled=$3 WHERE id=$1", [current.id, command.status, command.writes_enabled]);
    if (command.status === "revoked") {
      await db.query(`UPDATE integration.partner_mcp_keys SET status='revoked',revoked_at=clock_timestamp(),revoked_by=$2
        WHERE integration_id=$1 AND status='active'`,[current.id,actorId]);
      const clients = await db.query("UPDATE integration.clients SET status='revoked' WHERE integration_id=$1 RETURNING id", [current.id]);
      for (const row of clients.rows) await enqueueRevoke(db, current.id, row.id, requestId, actorId);
    }
    return { status: command.status, writes_enabled: command.writes_enabled, conformance_receipt_sha256: command.conformance_receipt_sha256 ?? null };
  }
  if (command.action === "revoke_client") {
    const changed = await db.query("UPDATE integration.clients SET status='revoked' WHERE id=$1 AND integration_id=$2 RETURNING id", [command.client_id, current.id]);
    if (!changed.rowCount) fail("resource_not_found", 404);
    return { client_id: command.client_id, status: "revoked", operation_id: await enqueueRevoke(db, current.id, command.client_id, requestId, actorId) };
  }
  if (current.status === "revoked") fail("integration_disabled", 403);
  if (command.action === "set_mcp_catalog_mode") {
    const changed = await db.query(`UPDATE integration.store_grants SET mcp_catalog_mode=$4
      WHERE integration_id=$1 AND merchant_id=$2 AND store_id=$3 RETURNING mcp_catalog_mode,version`,
    [current.id, merchantId, command.store_id, command.mcp_catalog_mode]);
    if (!changed.rowCount) fail("resource_not_found", 404);
    return { store_id: command.store_id, mcp_catalog_mode: changed.rows[0].mcp_catalog_mode, version: changed.rows[0].version };
  }
  if (!issuer) fail("dependency_unavailable",503);
  if (command.action === "rotate_client") {
    const prior = await db.query("SELECT id FROM integration.clients WHERE id=$1 AND integration_id=$2 AND status='active' AND retire_at IS NULL FOR UPDATE", [command.client_id, current.id]);
    if (!prior.rowCount) fail("resource_not_found", 404);
  }
  const operationId = newId("pop"); const oauthClientId = newId("pc");
  await db.query(`INSERT INTO integration.control_operations(id,integration_id,kind,status,oauth_client_id,auth_method,credential_reference,
    prior_client_id,overlap_seconds,request_id,actor_id)
    VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10)`,
  [operationId, current.id, command.action === "rotate_client" ? "rotate" : "provision", oauthClientId,
    command.auth_method, command.credential_reference, command.action === "rotate_client" ? command.client_id : null,
    command.action === "rotate_client" ? command.overlap_seconds : null, requestId, actorId]);
  // The signed subject does not exist until AS provisioning. Registry client
  // is inserted inactive only after reading that real immutable AS identity.
  return { operation_id: operationId, status: "pending", oauth_client_id: oauthClientId, issuer };
}
async function enqueueRevoke(db: PoolClient, integrationId: string, clientId: string, requestId: string, actorId: string) {
  const operationId = newId("pop");
  await db.query(`INSERT INTO integration.control_operations(id,integration_id,client_id,kind,status,request_id,actor_id)
    VALUES ($1,$2,$3,'revoke','pending',$4,$5)`, [operationId, integrationId, clientId, requestId, actorId]);
  return operationId;
}

/** Scoped, snapshot-consistent status. No AS call, credential reference or write. */
export async function readPartnerControlForClient(db: PoolClient, actor: PermissionActor, scope: MerchantTargetScope,
  raw: unknown, environment: PartnerEnvironment) {
  if ("channel" in actor) fail("forbidden", 403);
  await requireScopedActorPermission(actor, permissions.partnerManage, { scopeType: "merchant", merchantId: scope.merchantId });
  const parsed = PartnerControlStatusQuery.safeParse(raw);
  if (!parsed.success) fail("invalid_request", 400);
  const query = parsed.data!;
  const integration = (await db.query(`SELECT i.id AS integration_id,i.partner_id,i.environment,i.status,i.writes_enabled,
    i.policy_version,i.grant_version FROM integration.integrations i JOIN app.merchants m ON m.id=i.merchant_id
    WHERE i.id=$1 AND i.merchant_id=$2 AND i.environment=$3 AND m.status='active'`,
  [query.integration_id, scope.merchantId, environment])).rows[0];
  if (!integration) fail("resource_not_found", 404);
  // Independent keyset pages avoid unbounded history/client/grant fan-out.
  const clients = (await db.query(`SELECT id AS client_id,oauth_client_id,status,retire_at::text
    FROM integration.clients WHERE integration_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT 51`,
  [query.integration_id, query.clients_after ?? null])).rows;
  const grants = (await db.query(`SELECT store_id,status,allowed_scopes AS scopes,assortment_id,mcp_catalog_mode,version
    FROM integration.store_grants WHERE integration_id=$1 AND ($2::text IS NULL OR store_id>$2) ORDER BY store_id LIMIT 51`,
  [query.integration_id, query.grants_after ?? null])).rows;
  const operations = (await db.query(`SELECT id AS operation_id,kind,status,client_id,oauth_client_id,
    attempts,next_attempt_at::text FROM integration.control_operations
    WHERE integration_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT 51`,
  [query.integration_id, query.operations_after ?? null])).rows;
  const keys=(await db.query(`SELECT id AS key_id,label,scopes,status,version,expires_at::text,created_at::text,revoked_at::text
    FROM integration.partner_mcp_keys WHERE integration_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT 51`,
  [query.integration_id,query.keys_after??null])).rows;
  return { ...integration, clients: clients.slice(0,50), grants: grants.slice(0,50), operations: operations.slice(0,50),keys:keys.slice(0,50),
    next: { clients_after: clients.length>50 ? clients[49].client_id : null,
      grants_after: grants.length>50 ? grants[49].store_id : null,
      operations_after: operations.length>50 ? operations[49].operation_id : null,
      keys_after:keys.length>50?keys[49].key_id:null } };
}

export function executePartnerControl(actor: PermissionActor, scope: MerchantTargetScope, command: unknown, requestId: string) {
  return withControlDatabase(true, (db, environment, issuer) => executePartnerControlForClient(db, actor, scope, command, environment, issuer, requestId));
}
export function readPartnerControl(actor: PermissionActor, scope: MerchantTargetScope, query: unknown) {
  return withControlDatabase(false, (db, environment) => readPartnerControlForClient(db, actor, scope, query, environment));
}
