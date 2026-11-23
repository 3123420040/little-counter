import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { PlatformMcpRevokeKeyV1Schema, PlatformMcpChangeStatusV1Schema, PlatformMcpCommandMetadataV1Schema,
  PlatformMcpIssueKeyV1Schema, PlatformMcpRotateKeyV1Schema, PlatformMcpCreateConnectionV1Schema,
  type PlatformMcpIssueKeyV1, type PlatformMcpRotateKeyV1, type PlatformMcpCreateConnectionV1, type PlatformMcpRotationV1,
  type PlatformMcpRevokeKeyV1, type PlatformMcpChangeStatusV1, type PlatformMcpCommandMetadataV1 } from "@medusa-snus/contracts";
import type { PartnerEnvironment } from "@medusa-snus/contracts/partner-api";
import { PlatformError } from "../errors/platform-error";
import { headerValue, type HeadersLike } from "../http/headers";
import { recordAuditEntry } from "../repositories/audit-repository";
import type { PermissionActor } from "../services/permission-service";
import type { OperatorContext } from "../services/auth-service";
import { canonicalPartnerJson } from "./fingerprints";
import { mutatePartnerMcpKey } from "./mcp-key-control";
import { withControlDatabase } from "./control-database";
import { requirePlatformMcpStaffSession, lockPlatformMcpAdminForClient } from "./platform-mcp-authority";
import { loadPlatformMcpAuthorizationForClient } from "./platform-mcp-authorization";
import { assertPlatformMcpReadinessFreshV1, loadPlatformMcpProductionReadinessV1, type PlatformMcpReadinessProofV1 } from "./platform-mcp-readiness";
import { platformMcpProfileScopesV1, platformMcpIssuancePresetV1 } from "../services/platform-mcp-policy";
import { hashPlatformMcpPolicyV1 } from "../services/platform-mcp-authorization-snapshot";
import { insertPartnerPolicyForClient } from "./control";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
let issuanceInflight = 0;
function validateTarget(merchantId: string, integrationId: string, keyId: string, headers: HeadersLike, environment: PartnerEnvironment, creating = false) {
  const requestKey = headerValue(headers, "idempotency-key");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(merchantId)
    || (creating ? integrationId !== "" : !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(integrationId)) || (keyId !== "" && !/^[a-f0-9]{32}$/.test(keyId))
    || !["sandbox", "production"].includes(environment)) throw new PlatformError("validation_error", "Invalid MCP command target", 400);
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(requestKey)) throw new PlatformError("idempotency_key_required", "A bounded stable Idempotency-Key is required", 400);
  return requestKey;
}
type Receipt = { id: string; request_sha256: string; result_integration_id: string; result_key_id: string | null;
  state: string; expired: boolean; result_metadata: unknown };
type SecurityCommand = { operation: "revoke_key"; keyId: string; input: PlatformMcpRevokeKeyV1 }
  | { operation: "set_status"; keyId: ""; input: Extract<PlatformMcpChangeStatusV1, { status: "paused" }> };
type KeyCommand = { operation: "issue_key"; keyId: ""; input: PlatformMcpIssueKeyV1 }
  | { operation: "rotate_key"; keyId: string; input: PlatformMcpRotateKeyV1 };
type CreateCommand = { operation: "create_connection"; keyId: ""; input: PlatformMcpCreateConnectionV1 };
type ResumeCommand = { operation: "set_status"; keyId: ""; input: Extract<PlatformMcpChangeStatusV1, { status: "active" }> };
type ProvisionCommand = KeyCommand | CreateCommand | ResumeCommand;
type IntegrationRow = { id: string; grant_version: number; status: string; writes_enabled: boolean; platform_mcp_origin_receipt_id: string | null };

async function executeCommandForClient(db: PoolClient, actor: OperatorContext, merchantId: string,
  integrationId: string, command: SecurityCommand | ProvisionCommand, headers: HeadersLike, environment: PartnerEnvironment,
  readiness?: PlatformMcpReadinessProofV1) {
  const { operation, keyId, input } = command;
  const creating = operation === "create_connection";
  const issuing = creating || operation === "issue_key" || operation === "rotate_key";
  const activating = command.operation === "set_status" && command.input.status === "active";
  const requiresReadiness = issuing || activating;
  const requestKey = validateTarget(merchantId, integrationId, keyId, headers, environment, creating);
  if (["revoke_key", "rotate_key"].includes(operation) && !keyId) throw new PlatformError("validation_error", "An MCP key identity is required", 400);
  const keyHash = digest(requestKey);
  const binding = [environment, merchantId, actor.operatorId, operation, integrationId, keyId, keyHash];
  const requestHash = digest(canonicalPartnerJson({ operation, environment, merchantId, integrationId, keyId, input }));
  await db.query("SAVEPOINT platform_mcp_transaction_guard; RELEASE SAVEPOINT platform_mcp_transaction_guard");
  // Deny before target lookup, then release identity locks to preserve integration-first order.
  await db.query("SAVEPOINT platform_mcp_preflight");
  await lockPlatformMcpAdminForClient(db, actor);
  await db.query("ROLLBACK TO SAVEPOINT platform_mcp_preflight; RELEASE SAVEPOINT platform_mcp_preflight");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [digest(canonicalPartnerJson(binding))]);
  const readReceipt = () => db.query<Receipt>(`SELECT id::text,request_sha256,result_integration_id,result_key_id,state,
      replay_until<=clock_timestamp() AS expired,result_metadata FROM integration.control_request_receipts
      WHERE environment=$1 AND merchant_id=$2 AND actor_id=$3 AND operation=$4 AND target_integration_id=$5 AND target_key_id=$6 AND idempotency_key_sha256=$7`, binding);
  let receipt = (await readReceipt()).rows[0];
  // The migration runner takes the exclusive side before DDL; acquire before entity locks.
  if (requiresReadiness && !receipt) await db.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('snus-custom-migration-runner-v2',0))");
  const receiptId = receipt?.id ?? randomUUID();
  let storeIds: string[] = [], createdPolicyId: string | undefined;
  let integration: IntegrationRow;
  if (command.operation === "create_connection" && !receipt) {
    storeIds = command.input.storeIds;
    const commerce = await lockBusinessScope(db, merchantId, storeIds);
    await lockPlatformMcpAdminForClient(db, actor);
    await verifyIssuanceReadiness(db, readiness, command.input.profile, environment);
    if (command.input.profile === "commerce" && !commerce) throw new PlatformError("merchant_capability_denied", "Merchant is not currently entitled to MCP commerce", 403);
    integrationId = `int_${randomUUID()}`;
    const partnerId = `ptn_${randomUUID()}`, policyId = `ppol_${randomUUID()}`, assortmentId = `pas_${randomUUID()}`;
    createdPolicyId = policyId;
    await db.query("INSERT INTO integration.partners(id,code,display_name,status) VALUES($1,$1,$2,'active')", [partnerId, command.input.name]);
    await insertPartnerPolicyForClient(db, merchantId, policyId, 1, platformMcpIssuancePresetV1.policy);
    integration = (await db.query<IntegrationRow>(`INSERT INTO integration.integrations(id,partner_id,merchant_id,environment,installation_key,policy_id,policy_version,platform_mcp_origin_receipt_id)
      VALUES($1,$2,$3,$4,$1,$5,1,$6) RETURNING id,grant_version,status,writes_enabled,platform_mcp_origin_receipt_id`,
    [integrationId, partnerId, merchantId, environment, policyId, receiptId])).rows[0];
    await db.query("INSERT INTO integration.assortments(id,merchant_id,status) VALUES($1,$2,'active')", [assortmentId, merchantId]);
    const grants = await db.query(`INSERT INTO integration.store_grants(integration_id,merchant_id,store_id,stock_location_id,allowed_scopes,assortment_id,status,mcp_catalog_mode)
      SELECT $1,$2,s.id,s.stock_location_id,$3,$4,'active','merchant_published' FROM app.stores s
      WHERE s.merchant_id=$2 AND s.id=ANY($5::text[]) AND s.status='active' ORDER BY s.id`,
    [integrationId, merchantId, [...platformMcpProfileScopesV1[command.input.profile]], assortmentId, storeIds]);
    if (grants.rowCount !== storeIds.length) throw new PlatformError("mcp_scope_inactive", "MCP business scope is inactive", 409);
  } else {
    if (creating) integrationId = receipt!.result_integration_id;
    integration = (await db.query<IntegrationRow>(`
    SELECT id,grant_version,status,writes_enabled,platform_mcp_origin_receipt_id FROM integration.integrations WHERE id=$1 AND merchant_id=$2 AND environment=$3 FOR UPDATE`,
    [integrationId, merchantId, environment])).rows[0];
  }
  if (!integration) throw new PlatformError("resource_not_found", "MCP connection not found", 404);
  if (requiresReadiness && !creating && !receipt) {
    const partner = await db.query(`SELECT p.id FROM integration.partners p JOIN integration.integrations i ON i.partner_id=p.id
      WHERE i.id=$1 AND p.status='active' FOR SHARE OF p`, [integrationId]);
    if (!partner.rowCount || integration.status === "revoked") throw new PlatformError("integration_disabled", "MCP connection is disabled", 409);
    storeIds = (await db.query<{ store_id: string }>(`SELECT store_id FROM integration.store_grants
      WHERE integration_id=$1 AND ($2::boolean OR status='active') ORDER BY store_id`, [integrationId, !!integration.platform_mcp_origin_receipt_id])).rows.map(row => row.store_id);
    await lockBusinessScope(db, merchantId, storeIds);
  }
  await lockPlatformMcpAdminForClient(db, actor);
  if (receipt) {
    if (receipt.request_sha256 !== requestHash) throw new PlatformError("idempotency_conflict", "Same MCP request key with different content", 409);
    await lockPlatformMcpAdminForClient(db, actor);
    receipt = (await readReceipt()).rows[0]!;
    if (receipt.state === "tombstone" || receipt.expired) return { data: { receiptId: receipt.id, integrationId: receipt.result_integration_id,
      keyId: receipt.result_key_id }, replayed: true, requestState: "expired", secretStatus: "unavailable_on_replay" };
    return { data: PlatformMcpCommandMetadataV1Schema.parse(receipt.result_metadata), replayed: true,
      requestState: "completed", secretStatus: "unavailable_on_replay" };
  }
  let keyMetadata: unknown = null;
  let revealedKey: string | undefined;
  let rotation: PlatformMcpRotationV1 | undefined;
  let issuanceProfile: "read" | "commerce" | undefined;
  const sharedOauth = (command.operation === "set_status" || command.operation === "issue_key")
    && (await db.query<{ shared: boolean }>("SELECT EXISTS(SELECT 1 FROM integration.clients WHERE integration_id=$1) AS shared", [integrationId])).rows[0].shared;
  if (command.operation === "create_connection") {
    issuanceProfile = command.input.profile;
    const mutation = await mutatePartnerMcpKey(db, { action: "create_mcp_key", integration_id: integrationId,
      scopes: [...platformMcpProfileScopesV1[issuanceProfile]], ...(command.input.label ? { label: command.input.label } : {}), reason: input.reason },
    environment, actor.operatorId, integration.status);
    revealedKey = mutation.revealedKey;
    keyMetadata = await readKeyMetadata(db, integrationId, mutation.audit.key_id);
    integration = (await db.query<IntegrationRow>(`UPDATE integration.integrations SET status='active',writes_enabled=$2 WHERE id=$1
      RETURNING id,grant_version,status,writes_enabled,platform_mcp_origin_receipt_id`, [integrationId, issuanceProfile === "commerce"])).rows[0];
    await recordAuditEntry(db, actor, "platform.mcp.connection_created", "integration", integrationId,
      { merchantId, after: { ...mutation.audit, profile: issuanceProfile, storeIds, presetVersion: platformMcpIssuancePresetV1.version,
        policyId: createdPolicyId, policySha256: hashPlatformMcpPolicyV1(platformMcpIssuancePresetV1.policy), readinessSha256: readiness!.artifactSha256 }, reason: input.reason });
  } else if (command.operation === "issue_key" || command.operation === "rotate_key") {
    let priorKey: { version: number; scopes: string[] } | undefined;
    if (command.operation === "rotate_key") {
      priorKey = (await db.query<{ version: number; scopes: string[] }>(`SELECT version,scopes FROM integration.partner_mcp_keys
        WHERE id=$1 AND integration_id=$2 FOR UPDATE`, [keyId, integrationId])).rows[0];
      if (!priorKey) throw new PlatformError("resource_not_found", "MCP key not found", 404);
      if (priorKey.version !== command.input.expectedKeyVersion) throw new PlatformError("mcp_key_version_conflict", "MCP key changed; reload metadata", 409);
      if (priorKey.version >= 2147483647) throw new PlatformError("mcp_version_exhausted", "MCP key version is exhausted", 409);
    }
    const authorization = await lockAuthorization(db, merchantId, integration, storeIds, environment, command.input);
    issuanceProfile = command.operation === "issue_key" ? command.input.profile
      : priorKey!.scopes.some(scope => scope === "orders:quote" || scope === "orders:write") ? "commerce" : "read";
    if (issuanceProfile === "commerce" && (authorization.snapshot.approval?.maxApprovedProfile === "read"
      || (command.operation === "issue_key" && (!authorization.snapshot.approval || sharedOauth)))) {
      throw new PlatformError("mcp_profile_not_approved", "This MCP connection is not approved for new commerce keys", 409);
    }
    await verifyIssuanceReadiness(db, readiness, issuanceProfile, environment);
    if (issuanceProfile === "commerce" && !await lockBusinessScope(db, merchantId, storeIds)) {
      throw new PlatformError("merchant_capability_denied", "Merchant is not currently entitled to MCP commerce", 403);
    }
    const mutation = await mutatePartnerMcpKey(db, command.operation === "issue_key"
      ? { action: "create_mcp_key", integration_id: integrationId, scopes: [...platformMcpProfileScopesV1[issuanceProfile]],
        ...(command.input.label ? { label: command.input.label } : {}), reason: input.reason }
      : { action: "rotate_mcp_key", integration_id: integrationId, key_id: keyId, reason: "credential_rotation" },
    environment, actor.operatorId, integration.status);
    revealedKey = mutation.revealedKey;
    keyMetadata = await readKeyMetadata(db, integrationId, mutation.audit.key_id);
    if (command.operation === "rotate_key") {
      const previous = await readKeyMetadata(db, integrationId, keyId);
      rotation = { previousKeyId: previous.id, previousKeyVersion: previous.version, previousKeyExpiresAt: previous.expiresAt };
    }
    await recordAuditEntry(db, actor, command.operation === "issue_key" ? "platform.mcp.key_issued" : "platform.mcp.key_rotated",
      "integration", integrationId, { merchantId, after: mutation.audit, reason: input.reason });
  } else if (command.operation === "revoke_key") {
    const before = (await db.query<{ version: number; status: string }>("SELECT version,status FROM integration.partner_mcp_keys WHERE id=$1 AND integration_id=$2 FOR UPDATE", [keyId, integrationId])).rows[0];
    if (!before) throw new PlatformError("resource_not_found", "MCP key not found", 404);
    if (before.version !== command.input.expectedKeyVersion) throw new PlatformError("mcp_key_version_conflict", "MCP key changed; reload metadata", 409);
    const mutation = await mutatePartnerMcpKey(db, { action: "revoke_mcp_key", integration_id: integrationId, key_id: keyId, reason: input.reason }, environment, actor.operatorId, integration.status);
    if (before.status !== "revoked") await recordAuditEntry(db, actor, "platform.mcp.key_revoked", "integration", integrationId,
      { merchantId, before: { keyId, version: before.version, status: before.status }, after: mutation.audit, reason: input.reason });
    const key = (await db.query<{ id: string; version: number; status: "active" | "revoked"; label: string; scopes: string[]; expires_at: Date }>(`
      SELECT id,version,status,label,scopes,expires_at FROM integration.partner_mcp_keys WHERE id=$1 AND integration_id=$2`, [keyId, integrationId])).rows[0]!;
    keyMetadata = { id: key.id, version: key.version, status: key.status, label: key.label, scopes: key.scopes, expiresAt: key.expires_at.toISOString() };
  } else {
    const origin = await db.query(`SELECT id FROM integration.control_request_receipts WHERE id=$1 AND operation='create_connection'
      AND environment=$2 AND merchant_id=$3 AND result_integration_id=$4`, [integration.platform_mcp_origin_receipt_id, environment, merchantId, integrationId]);
    if (!origin.rowCount || sharedOauth) throw new PlatformError("mcp_managed_connection_required", "Only a dedicated platform-managed MCP connection can change status here", 409);
    if (integration.status === "revoked") throw new PlatformError("mcp_connection_terminal", "A revoked connection cannot change status", 409);
    if (integration.grant_version !== command.input.expectedIntegrationVersion) throw new PlatformError("mcp_integration_version_conflict", "MCP connection changed; reload metadata", 409);
    const status = command.input.status, writes = status === "active" && command.input.profile === "commerce";
    if (command.input.status === "active") {
      const authorization = await lockAuthorization(db, merchantId, integration, storeIds, environment, command.input);
      if (!authorization.snapshot.approval || (command.input.profile === "commerce" && authorization.snapshot.approval.maxApprovedProfile !== "commerce")) {
        throw new PlatformError("mcp_profile_not_approved", "This MCP connection is not approved for commerce", 409);
      }
      issuanceProfile = command.input.profile;
      await verifyIssuanceReadiness(db, readiness, issuanceProfile, environment);
      if (writes && !await lockBusinessScope(db, merchantId, storeIds)) throw new PlatformError("merchant_capability_denied", "Merchant is not currently entitled to MCP commerce", 403);
      await requireUsableKey(db, integrationId, issuanceProfile);
    }
    if (integration.status !== status || integration.writes_enabled !== writes) {
      if (integration.grant_version >= 2147483647) throw new PlatformError("mcp_version_exhausted", "MCP connection version is exhausted", 409);
      const before = { status: integration.status, writesEnabled: integration.writes_enabled, version: integration.grant_version };
      integration = (await db.query<IntegrationRow>(`UPDATE integration.integrations SET status=$2,writes_enabled=$3 WHERE id=$1
        RETURNING id,grant_version,status,writes_enabled,platform_mcp_origin_receipt_id`, [integrationId, status, writes])).rows[0];
      await recordAuditEntry(db, actor, status === "paused" ? "platform.mcp.paused" : "platform.mcp.resumed", "integration", integrationId, { merchantId, before,
        after: { status: integration.status, writesEnabled: writes, version: integration.grant_version }, reason: input.reason });
    }
  }
  const metadata: PlatformMcpCommandMetadataV1 = PlatformMcpCommandMetadataV1Schema.parse({ receiptId, merchantId, integrationId,
    environment, integrationVersion: integration.grant_version, integrationStatus: integration.status, writesEnabled: integration.writes_enabled,
    mcpUrl: requiresReadiness ? readiness!.artifact.mcpUrl : null, key: keyMetadata });
  await db.query(`INSERT INTO integration.control_request_receipts(id,environment,merchant_id,actor_id,operation,target_integration_id,target_key_id,
    idempotency_key_sha256,request_sha256,result_integration_id,result_key_id,result_metadata,
    workflow_version,max_approved_profile,approved_scopes,approved_store_ids,preset_version,policy_id,policy_version,policy_sha256,readiness_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
  [metadata.receiptId, ...binding.slice(0, 6), keyHash, requestHash, integrationId, metadata.key?.id ?? null, JSON.stringify(metadata),
    ...(command.operation === "create_connection" ? [platformMcpIssuancePresetV1.version, command.input.profile,
      [...platformMcpProfileScopesV1[command.input.profile]], storeIds, platformMcpIssuancePresetV1.version, createdPolicyId, 1,
      hashPlatformMcpPolicyV1(platformMcpIssuancePresetV1.policy), readiness!.artifactSha256] : Array(9).fill(null))]);
  if (issuanceProfile) {
    await verifyIssuanceReadiness(db, readiness, issuanceProfile, environment);
    if (issuanceProfile === "commerce" && !await lockBusinessScope(db, merchantId, storeIds)) throw new PlatformError("merchant_capability_denied", "Merchant is not currently entitled to MCP commerce", 403);
    if (activating) await requireUsableKey(db, integrationId, issuanceProfile);
  }
  await lockPlatformMcpAdminForClient(db, actor);
  if (issuanceProfile) assertPlatformMcpReadinessFreshV1(readiness!, issuanceProfile);
  return { data: metadata, replayed: false, requestState: "completed", secretStatus: issuing ? "available_once" : "not_applicable",
    ...(revealedKey ? { revealedKey } : {}), ...(rotation ? { rotation } : {}) };
}

async function lockBusinessScope(db: PoolClient, merchantId: string, storeIds: string[]) {
  if (!storeIds.length) throw new PlatformError("mcp_scope_inactive", "MCP business scope is inactive", 409);
  try { return (await db.query<{ commerce: boolean }>("SELECT integration.lock_platform_mcp_business_scope($1,$2) AS commerce", [merchantId, storeIds])).rows[0].commerce; }
  catch (error) {
    if ((error as { code?: string }).code === "P0001") throw new PlatformError("mcp_scope_inactive", "MCP business scope is inactive", 409);
    throw error;
  }
}
async function lockAuthorization(db: PoolClient, merchantId: string, integration: IntegrationRow, storeIds: string[],
  environment: PartnerEnvironment, expected: { expectedIntegrationVersion: number; expectedAuthorizationSnapshotSha256: string }) {
  await db.query("SELECT store_id FROM integration.store_grants WHERE integration_id=$1 ORDER BY store_id FOR SHARE", [integration.id]);
  // Assortments can be shared by another integration, so its integration lock is insufficient.
  await db.query(`SELECT a.id FROM integration.assortments a WHERE a.id IN
    (SELECT assortment_id FROM integration.store_grants WHERE integration_id=$1) ORDER BY a.id FOR SHARE`, [integration.id]);
  const authorization = await loadPlatformMcpAuthorizationForClient(db, merchantId, integration.id, environment);
  if (integration.grant_version !== expected.expectedIntegrationVersion) throw new PlatformError("mcp_integration_version_conflict", "MCP connection changed; reload metadata", 409);
  if (authorization.sha256 !== expected.expectedAuthorizationSnapshotSha256) throw new PlatformError("mcp_authorization_version_conflict", "MCP authorization changed; reload metadata", 409);
  const eligible = await db.query(`SELECT g.store_id FROM integration.store_grants g
    JOIN app.stores s ON s.id=g.store_id AND s.merchant_id=g.merchant_id AND s.status='active' AND s.stock_location_id=g.stock_location_id
    JOIN public.stock_location l ON l.id=g.stock_location_id AND l.deleted_at IS NULL
    JOIN integration.assortments a ON a.id=g.assortment_id AND a.merchant_id=g.merchant_id AND a.status='active'
    WHERE g.integration_id=$1 AND g.merchant_id=$2 AND g.store_id=ANY($3::text[]) AND g.status='active'`, [integration.id, merchantId, storeIds]);
  if (eligible.rowCount !== storeIds.length) throw new PlatformError("mcp_scope_inactive", "MCP business scope is inactive", 409);
  return authorization;
}
async function verifyIssuanceReadiness(db: PoolClient, readiness: PlatformMcpReadinessProofV1 | undefined,
  profile: "read" | "commerce", environment: PartnerEnvironment) {
  assertPlatformMcpReadinessFreshV1(readiness!, profile);
  if (readiness!.artifact.environment !== environment || (await db.query<{ fingerprint: string }>(
    "SELECT integration.platform_mcp_schema_fingerprint() AS fingerprint")).rows[0].fingerprint !== readiness!.artifact.schemaFingerprintSha256) {
    throw new PlatformError("mcp_readiness_unavailable", "MCP server conformance is unavailable", 503);
  }
}
async function readKeyMetadata(db: PoolClient, integrationId: string, keyId: string) {
  const key = (await db.query(`SELECT id,version,status,label,scopes,expires_at FROM integration.partner_mcp_keys WHERE id=$1 AND integration_id=$2`, [keyId, integrationId])).rows[0];
  return { id: key.id, version: key.version, status: key.status, label: key.label, scopes: key.scopes, expiresAt: key.expires_at.toISOString() };
}
async function requireUsableKey(db: PoolClient, integrationId: string, profile: "read" | "commerce") {
  const key = await db.query(`SELECT id FROM integration.partner_mcp_keys WHERE integration_id=$1 AND status='active'
    AND expires_at>clock_timestamp() AND scopes @> $2::text[] ORDER BY id LIMIT 1 FOR SHARE`, [integrationId, [...platformMcpProfileScopesV1[profile]]]);
  if (!key.rowCount) throw new PlatformError("mcp_key_required", "An active unexpired MCP key with the requested scopes is required", 409);
}

export async function createPlatformMcpConnectionForClient(db: PoolClient, actorInput: PermissionActor, merchantId: string,
  rawInput: unknown, headers: HeadersLike, environment: PartnerEnvironment, readiness?: PlatformMcpReadinessProofV1) {
  const actor = requirePlatformMcpStaffSession(actorInput), parsed = PlatformMcpCreateConnectionV1Schema.safeParse(rawInput);
  if (!parsed.success) throw new PlatformError("validation_error", "Invalid MCP connection selection or profile", 400);
  return executeCommandForClient(db, actor, merchantId, "", { operation: "create_connection", keyId: "", input: parsed.data }, headers, environment, readiness);
}
export async function resumePlatformMcpConnectionForClient(db: PoolClient, actorInput: PermissionActor, merchantId: string,
  integrationId: string, rawInput: unknown, headers: HeadersLike, environment: PartnerEnvironment, readiness?: PlatformMcpReadinessProofV1) {
  const actor = requirePlatformMcpStaffSession(actorInput), parsed = PlatformMcpChangeStatusV1Schema.safeParse(rawInput);
  if (!parsed.success || parsed.data.status !== "active") throw new PlatformError("validation_error", "Invalid MCP resume profile or version", 400);
  return executeCommandForClient(db, actor, merchantId, integrationId, { operation: "set_status", keyId: "", input: parsed.data }, headers, environment, readiness);
}

/** Internal TX port; only the outer COMMIT-owning wrapper may reveal the returned local key. */
export async function issuePlatformMcpKeyForClient(db: PoolClient, actorInput: PermissionActor, merchantId: string,
  integrationId: string, rawInput: unknown, headers: HeadersLike, environment: PartnerEnvironment, readiness?: PlatformMcpReadinessProofV1) {
  const actor = requirePlatformMcpStaffSession(actorInput), parsed = PlatformMcpIssueKeyV1Schema.safeParse(rawInput);
  if (!parsed.success) throw new PlatformError("validation_error", "Invalid MCP issuance profile, version or reason", 400);
  return executeCommandForClient(db, actor, merchantId, integrationId, { operation: "issue_key", keyId: "", input: parsed.data }, headers, environment, readiness);
}
export async function rotatePlatformMcpKeyForClient(db: PoolClient, actorInput: PermissionActor, merchantId: string,
  integrationId: string, keyId: string, rawInput: unknown, headers: HeadersLike, environment: PartnerEnvironment, readiness?: PlatformMcpReadinessProofV1) {
  const actor = requirePlatformMcpStaffSession(actorInput), parsed = PlatformMcpRotateKeyV1Schema.safeParse(rawInput);
  if (!parsed.success) throw new PlatformError("validation_error", "Invalid MCP rotation version or reason", 400);
  return executeCommandForClient(db, actor, merchantId, integrationId, { operation: "rotate_key", keyId, input: parsed.data }, headers, environment, readiness);
}

export async function revokePlatformMcpKeyForClient(db: PoolClient, actorInput: PermissionActor, merchantId: string,
  integrationId: string, keyId: string, rawInput: unknown, headers: HeadersLike, environment: PartnerEnvironment) {
  const actor = requirePlatformMcpStaffSession(actorInput), parsed = PlatformMcpRevokeKeyV1Schema.safeParse(rawInput);
  if (!parsed.success) throw new PlatformError("validation_error", "Invalid MCP revoke version or reason", 400);
  return executeCommandForClient(db, actor, merchantId, integrationId, { operation: "revoke_key", keyId, input: parsed.data }, headers, environment);
}

export async function pausePlatformMcpConnectionForClient(db: PoolClient, actorInput: PermissionActor, merchantId: string,
  integrationId: string, rawInput: unknown, headers: HeadersLike, environment: PartnerEnvironment) {
  const actor = requirePlatformMcpStaffSession(actorInput), parsed = PlatformMcpChangeStatusV1Schema.safeParse(rawInput);
  if (!parsed.success || parsed.data.status !== "paused") throw new PlatformError("validation_error", "Invalid MCP pause version or reason", 400);
  return executeCommandForClient(db, actor, merchantId, integrationId, { operation: "set_status", keyId: "", input: parsed.data }, headers, environment);
}

export async function revokePlatformMcpKey(actor: PermissionActor, merchantId: string, integrationId: string, keyId: string, input: unknown, headers: HeadersLike) {
  requirePlatformMcpStaffSession(actor);
  return withControlDatabase(true, (db, environment) => revokePlatformMcpKeyForClient(db, actor, merchantId, integrationId, keyId, input, headers, environment));
}

async function executeProvisionCommand(actorInput: PermissionActor, merchantId: string, integrationId: string,
  command: ProvisionCommand, headersInput: HeadersLike) {
  const actor = requirePlatformMcpStaffSession(actorInput), headers = { "idempotency-key": headerValue(headersInput, "idempotency-key") };
  if (issuanceInflight >= 2) throw new PlatformError("dependency_unavailable", "MCP command capacity is busy", 503);
  issuanceInflight++;
  try {
    const preflight = await withControlDatabase(true, async (db, environment) => {
      validateTarget(merchantId, integrationId, command.keyId, headers, environment, command.operation === "create_connection");
      await lockPlatformMcpAdminForClient(db, actor);
      const target = command.operation === "create_connection" ? await db.query("SELECT id FROM app.merchants WHERE id=$1", [merchantId])
        : await db.query("SELECT id FROM integration.integrations WHERE id=$1 AND merchant_id=$2 AND environment=$3", [integrationId, merchantId, environment]);
      if (!target.rowCount) throw new PlatformError("resource_not_found", "MCP target not found", 404);
      let profile: "read" | "commerce";
      if (command.operation !== "rotate_key") profile = command.input.profile;
      else {
        const key = (await db.query<{ scopes: string[] }>("SELECT scopes FROM integration.partner_mcp_keys WHERE id=$1 AND integration_id=$2", [command.keyId, integrationId])).rows[0];
        if (!key) throw new PlatformError("resource_not_found", "MCP key not found", 404);
        profile = key.scopes.some(scope => scope === "orders:quote" || scope === "orders:write") ? "commerce" : "read";
      }
      return { environment, profile };
    });
    let readiness: PlatformMcpReadinessProofV1 | undefined;
    // A failed fresh probe must not prevent reconciliation of an already committed request.
    try { readiness = await loadPlatformMcpProductionReadinessV1(preflight.profile); } catch { readiness = undefined; }
    return await withControlDatabase(true, (db, environment) => {
      if (environment !== preflight.environment) throw new PlatformError("dependency_unavailable", "MCP deployment environment changed", 503);
      return executeCommandForClient(db, actor, merchantId, integrationId, command, headers, environment, readiness);
    });
  } finally { issuanceInflight--; }
}
export async function issuePlatformMcpKey(actor: PermissionActor, merchantId: string, integrationId: string, input: unknown, headers: HeadersLike) {
  const parsed = PlatformMcpIssueKeyV1Schema.safeParse(input);
  if (!parsed.success) throw new PlatformError("validation_error", "Invalid MCP issuance profile, version or reason", 400);
  return executeProvisionCommand(actor, merchantId, integrationId, { operation: "issue_key", keyId: "", input: parsed.data }, headers);
}
export async function rotatePlatformMcpKey(actor: PermissionActor, merchantId: string, integrationId: string, keyId: string, input: unknown, headers: HeadersLike) {
  const parsed = PlatformMcpRotateKeyV1Schema.safeParse(input);
  if (!parsed.success || !/^[a-f0-9]{32}$/.test(keyId)) throw new PlatformError("validation_error", "Invalid MCP rotation target, version or reason", 400);
  return executeProvisionCommand(actor, merchantId, integrationId, { operation: "rotate_key", keyId, input: parsed.data }, headers);
}
export async function createPlatformMcpConnection(actor: PermissionActor, merchantId: string, input: unknown, headers: HeadersLike) {
  const parsed = PlatformMcpCreateConnectionV1Schema.safeParse(input);
  if (!parsed.success) throw new PlatformError("validation_error", "Invalid MCP connection selection or profile", 400);
  return executeProvisionCommand(actor, merchantId, "", { operation: "create_connection", keyId: "", input: parsed.data }, headers);
}
export async function changePlatformMcpConnectionStatus(actorInput: PermissionActor, merchantId: string, integrationId: string, input: unknown, headers: HeadersLike) {
  const actor = requirePlatformMcpStaffSession(actorInput), parsed = PlatformMcpChangeStatusV1Schema.safeParse(input);
  if (!parsed.success) throw new PlatformError("validation_error", "Invalid MCP status, profile or version", 400);
  if (parsed.data.status === "active") return executeProvisionCommand(actor, merchantId, integrationId, { operation: "set_status", keyId: "", input: parsed.data }, headers);
  const paused = parsed.data;
  return withControlDatabase(true, (db, environment) => executeCommandForClient(db, actor, merchantId, integrationId,
    { operation: "set_status", keyId: "", input: paused }, headers, environment));
}
