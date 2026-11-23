import { createHash } from "node:crypto";
import {
  integrationConfigScopes,
  merchantRoleKeys,
  paymentProviderKeys,
  platformRoleKeys,
  providerConfigPurposes,
  type IntegrationConfigScope,
  type MembershipScopeType,
  type PackageKey,
  type PaymentProviderKey,
  type PlatformReadScope,
  type PlatformRoleKey,
  type ProviderConfigPurpose,
  type SubscriptionStatus,
  type PlatformMerchantSummaryV1,type PlatformStoreSummaryV1,type PlatformLifecycleAuditPageV1,
  type PlatformMerchantDetailV1,type PlatformStoreDetailV1,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import { recordAuditEntry } from "../repositories/audit-repository";
import { id } from "../utils/id";
import type { ScopeActor } from "./access-service";
import { describeFoundStockPolicy } from "./merchant-checkout-policy-service";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";

type Timestamp = string | Date;
export type PlatformEntityStatus = "active" | "suspended" | "closed";
export type PlatformEntityStatusFilter = PlatformEntityStatus | "all";
function statusFilter(value:string):PlatformEntityStatusFilter {
  if(!["active","suspended","closed","all"].includes(value))throw new PlatformError("validation_error","Invalid lifecycle status filter",400);
  return value as PlatformEntityStatusFilter;
}

export type PlatformMerchantSummary = PlatformMerchantSummaryV1;
export type PlatformStoreSummary = PlatformStoreSummaryV1;
export type PlatformLifecycleAuditPage = PlatformLifecycleAuditPageV1;

async function lifecycleAuditPage(client:PoolClient,type:"merchant"|"store",id:string,offset:number):Promise<PlatformLifecycleAuditPage>{
  if(!Number.isSafeInteger(offset)||offset<0||offset>100_000)throw new PlatformError("validation_error","Invalid lifecycle audit offset",400);
  const rows=await client.query<{id:string;actor_id:string;action:string;before_status:PlatformEntityStatus|null;after_status:PlatformEntityStatus|null;reason:string|null;created_at:Timestamp}>(`
    SELECT id::text,actor_id,action,
      CASE WHEN before->>'status' IN('active','suspended','closed') THEN before->>'status' END AS before_status,
      CASE WHEN after->>'status' IN('active','suspended','closed') THEN after->>'status' END AS after_status,
      reason,created_at FROM audit.events WHERE subject_type=$1 AND subject_id=$2
      AND action=ANY($3::text[]) ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET $4`,
  [type,id,[`platform.${type}.status_changed`,`platform.${type}.created`],offset]);
  return{data:rows.rows.slice(0,20).map(row=>({id:row.id,actorId:row.actor_id,action:row.action,beforeStatus:row.before_status,
    afterStatus:row.after_status,reason:row.reason,createdAt:iso(row.created_at)})),offset,limit:20,hasMore:rows.rows.length>20};
}

export type PlatformMerchantDetail=PlatformMerchantDetailV1;
export type PlatformStoreDetail=PlatformStoreDetailV1;

export type PlatformMembershipSummary = {
  membershipId: string;
  operatorId: string;
  displayName?: string;
  scopeType: MembershipScopeType;
  merchantId?: string;
  merchantName?: string;
  storeId?: string;
  storeName?: string;
  roleKey: string;
  status: PlatformMembershipStatus;
  effectiveStatus: PlatformMembershipEffectiveStatus;
  validFrom: string;
  validTo: string | null;
  grantedBy: string;
  createdAt: string;
};

export type PlatformMembershipStatus = "active" | "disabled" | "pending" | "revoked";
export type PlatformMembershipEffectiveStatus = PlatformMembershipStatus | "scheduled" | "expired";

export type CreatePlatformStoreInput = {
  merchantId?: string;
  displayName?: string;
  stockLocationName?: string;
  isPrimary?: boolean;
};

export type PlatformMembershipInput = {
  operatorId?: string;
  scopeType?: string;
  merchantId?: string;
  storeId?: string;
  roleKey?: string;
  validFrom?: string;
  validTo?: string | null;
};

export type PlatformMembershipRevokeInput = {
  reason?: string;
};

export type PlatformBillingOrder = {
  billingOrderId: string;
  merchantId: string;
  merchantName: string;
  purpose: string;
  targetPackageKey?: PackageKey;
  amountVnd: string;
  status: string;
  createdAt: string;
  appliedAt?: string;
};

export type PlatformIntegration = {
  configId: string;
  providerKey: PaymentProviderKey;
  purpose: ProviderConfigPurpose;
  scope: IntegrationConfigScope;
  merchantId?: string;
  merchantName?: string;
  storeId?: string;
  storeName?: string;
  status: "active" | "inactive" | "error";
  hasSecret: boolean;
  lastRotatedAt?: string;
  callbackUrl?: string;
  healthSummary?: string;
  requiredAction?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProviderConfigAction = "set" | "replace" | "rotate" | "disable";

export type PlatformIntegrationConfigInput = {
  action: ProviderConfigAction;
  providerKey: string;
  purpose: string;
  scope: string;
  merchantId?: string;
  storeId?: string;
  secret?: string;
};

export type PlatformPaymentException = {
  exceptionId: string;
  billingOrderId?: string;
  providerKey: string;
  providerRef: string;
  amountVnd?: string;
  issue: string;
  status: "pending_review" | "resolved" | "waived";
  createdAt: string;
  resolvedAt?: string;
};

export type SignupIdentity = {
  identityId: string;
  email: string;
  status: SignupIdentityStatus;
  merchantId?: string;
  merchantName?: string;
  createdAt: string;
  verifiedAt?: string;
  provisionedAt?: string;
  expiresAt?: string;
};

export type SignupIdentityStatus =
  | "pending_verification"
  | "verified"
  | "provisioned"
  | "expired"
  | "suspended";

export type PlatformAuditEntry = {
  id: string;
  actorId: string;
  actorType: string;
  action: string;
  subjectType: string;
  subjectId: string;
  reason?: string;
  createdAt: string;
};

function iso(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function resolvePlatformMembershipEffectiveStatus(
  membership: Pick<PlatformMembershipSummary, "status" | "validFrom" | "validTo">,
  now = new Date(),
): PlatformMembershipEffectiveStatus {
  if (membership.status !== "active") return membership.status;
  const nowMs = now.getTime();
  const validFromMs = Date.parse(membership.validFrom);
  const validToMs = membership.validTo ? Date.parse(membership.validTo) : null;
  if (!Number.isFinite(nowMs) || !Number.isFinite(validFromMs) || (validToMs !== null && !Number.isFinite(validToMs))) {
    return "expired";
  }
  if (validFromMs > nowMs) return "scheduled";
  if (validToMs !== null && validToMs <= nowMs) return "expired";
  return "active";
}

function platformMembershipStatus(value: string): PlatformMembershipStatus {
  return value === "active" || value === "disabled" || value === "pending" || value === "revoked"
    ? value
    : "revoked";
}

export function resolveSignupIdentityStatus(
  signupStatus: string,
  token: { expiresAt?: Timestamp | null; consumedAt?: Timestamp | null } = {},
  now = new Date(),
): SignupIdentityStatus {
  if (signupStatus === "provisioned") return "provisioned";
  if (signupStatus === "expired") return "expired";
  if (signupStatus === "failed") return "suspended";
  if (signupStatus !== "pending" && signupStatus !== "verified") return "suspended";

  const nowMs = now.getTime();
  const expiresAtMs = token.expiresAt ? new Date(token.expiresAt).getTime() : Number.NaN;
  const consumedAtMs = token.consumedAt ? new Date(token.consumedAt).getTime() : null;
  const current = Number.isFinite(nowMs) && Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
  if (!current) {
    return "expired";
  }
  if (signupStatus === "pending") {
    return consumedAtMs === null ? "pending_verification" : "expired";
  }
  return consumedAtMs !== null && Number.isFinite(consumedAtMs) && consumedAtMs <= nowMs
    ? "verified"
    : "expired";
}

function platformMembershipValidity(input: PlatformMembershipInput): { validFrom: Date; validTo: Date | null } {
  const validFromInput = String(input.validFrom || "").trim();
  const validToInput = String(input.validTo || "").trim();
  const validFrom = validFromInput ? new Date(validFromInput) : new Date();
  const validTo = validToInput ? new Date(validToInput) : null;
  if (!Number.isFinite(validFrom.getTime())) {
    throw new PlatformError("validation_error", "validFrom must be a valid timestamp", 400);
  }
  if (validTo && !Number.isFinite(validTo.getTime())) {
    throw new PlatformError("validation_error", "validTo must be a valid timestamp", 400);
  }
  if (validTo && validTo.getTime() <= validFrom.getTime()) {
    throw new PlatformError("validation_error", "validTo must be later than validFrom", 400);
  }
  return { validFrom, validTo };
}

function platformMembershipRevokeReason(input: PlatformMembershipRevokeInput): string {
  const reason = String(input?.reason || "").trim();
  if (reason.length < 4) {
    throw new PlatformError("validation_error", "Revoke reason must contain at least 4 characters", 400);
  }
  if (reason.length > 500) {
    throw new PlatformError("validation_error", "Revoke reason must contain at most 500 characters", 400);
  }
  return reason;
}

async function tableExists(client: PoolClient, schema: string, table: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2
    ) AS exists
  `, [schema, table]);
  return Boolean(result.rows[0]?.exists);
}

function scopeMerchantIds(scope: PlatformReadScope): string[] {
  return scope.merchantIds || [];
}

function scopeStoreIds(scope: PlatformReadScope): string[] {
  return scope.storeIds || [];
}

function requireReadableMerchant(scope: PlatformReadScope, merchantId: string): void {
  if (!scopeMerchantIds(scope).includes(merchantId)) {
    throw new PlatformError("forbidden", "Merchant target is outside the platform read scope", 403);
  }
}

function requireReadableStore(scope: PlatformReadScope, storeId: string): void {
  if (!scopeStoreIds(scope).includes(storeId)) {
    throw new PlatformError("forbidden", "Store target is outside the platform read scope", 403);
  }
}

async function platformClient<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedClient(run);
}

export async function listPlatformMerchants(scope: PlatformReadScope,status="active"): Promise<{ data: PlatformMerchantSummary[] }> {
  statusFilter(status);
  return platformClient(async (client) => {
    const merchantIds = scopeMerchantIds(scope);
    if (merchantIds.length === 0) return { data: [] };
    const hasMemberships = await tableExists(client, "app", "operator_memberships");
    const ownerCount = hasMemberships
      ? `(SELECT count(*)::int FROM app.operator_memberships om
          JOIN medusa.staff_users owners ON owners.operator_id=om.operator_id AND owners.is_active=true
          LEFT JOIN app.operator_security_state security ON security.operator_id=om.operator_id
          WHERE om.merchant_id = m.id AND om.role_key = 'owner' AND om.status = 'active'
            AND om.scope_type IN('merchant','store') AND COALESCE(security.global_status,'active')='active'
            AND om.valid_from <= now() AND (om.valid_to IS NULL OR om.valid_to > now()))`
      : "0";
    const result = await client.query<{
      merchant_id: string;
      display_name: string;
      package_key: PackageKey;
      subscription_status: SubscriptionStatus;
      store_count: number;
      owner_count: number;
      created_at: Timestamp;
      status:PlatformEntityStatus;
      status_version:string | number;
    }>(`
      SELECT m.id AS merchant_id, m.display_name,m.status,COALESCE((to_jsonb(m)->>'status_version')::bigint,1) AS status_version,
             COALESCE(ms.package_key, 'basic') AS package_key,
             COALESCE(ms.status, 'active') AS subscription_status,
             (SELECT count(*)::int FROM app.stores s WHERE s.merchant_id = m.id) AS store_count,
             ${ownerCount} AS owner_count,
             m.created_at
      FROM app.merchants m
      LEFT JOIN app.merchant_subscriptions ms ON ms.merchant_id = m.id
      WHERE m.id = ANY($1::text[]) AND ($2='all' OR m.status=$2)
      ORDER BY m.display_name, m.id
    `, [merchantIds,status]);
    return {
      data: result.rows.map((row) => ({
        merchantId: row.merchant_id,
        displayName: row.display_name,
        packageKey: row.package_key,
        subscriptionStatus: row.subscription_status,
        storeCount: Number(row.store_count),
        ownerCount: Number(row.owner_count),
        createdAt: iso(row.created_at),
        status:row.status,statusVersion:Number(row.status_version),
      })),
    };
  });
}

export async function getPlatformMerchantDetail(scope: PlatformReadScope, merchantId: string,auditOffset=0): Promise<{ data: PlatformMerchantDetail }> {
  requireReadableMerchant(scope, merchantId);
  const result = await listPlatformMerchants({ ...scope, merchantIds: [merchantId] },"all");
  const merchant = result.data[0];
  if (!merchant) throw new PlatformError("not_found", "Merchant not found", 404);
  const stores=(await listPlatformStores(scope,merchantId,"all")).data;
  return platformClient(async client=>{
    const owners=await client.query<{id:string;operator_id:string;display_name:string;scope_type:"merchant"|"store";store_id:string|null;valid_from:Timestamp;valid_to:Timestamp|null}>(`
      SELECT memberships.id::text,memberships.operator_id,users.display_name,memberships.scope_type,memberships.store_id,
        memberships.valid_from,memberships.valid_to FROM app.operator_memberships memberships
      JOIN medusa.staff_users users ON users.operator_id=memberships.operator_id AND users.is_active=true
      LEFT JOIN app.operator_security_state security ON security.operator_id=memberships.operator_id
      WHERE memberships.merchant_id=$1 AND memberships.scope_type IN('merchant','store')
        AND memberships.role_key='owner' AND memberships.status='active'
        AND COALESCE(security.global_status,'active')='active'
        AND memberships.valid_from<=now() AND(memberships.valid_to IS NULL OR memberships.valid_to>now())
      ORDER BY users.display_name,memberships.id`,[merchantId]);
    const row=await client.query<{metadata:Record<string,unknown>}>("SELECT metadata FROM app.merchants WHERE id=$1",[merchantId]);
    if(!row.rows[0])throw new PlatformError("not_found","Merchant not found",404);
    return{data:{...merchant,stores,owners:owners.rows.map(row=>({membershipId:row.id,operatorId:row.operator_id,displayName:row.display_name,
      scopeType:row.scope_type,storeId:row.store_id,validFrom:iso(row.valid_from),validTo:row.valid_to?iso(row.valid_to):null})),
      checkoutPolicy:describeFoundStockPolicy(row.rows[0].metadata),lifecycleAudit:await lifecycleAuditPage(client,"merchant",merchantId,auditOffset)}};
  });
}

export async function listPlatformStores(scope: PlatformReadScope, merchantId?: string,status="active"): Promise<{ data: PlatformStoreSummary[] }> {
  statusFilter(status);
  if (merchantId) requireReadableMerchant(scope, merchantId);
  return platformClient(async (client) => {
    const storeIds = scopeStoreIds(scope);
    if (storeIds.length === 0) return { data: [] };
    const result = await client.query<{
      store_id: string;
      merchant_id: string;
      merchant_name: string;
      internal_name: string;
      is_primary: boolean;
      stock_location_id: string;
      created_at: Timestamp;
      status:PlatformEntityStatus;
      status_version:string | number;
      merchant_status:PlatformEntityStatus;
    }>(`
      SELECT s.id AS store_id, s.merchant_id, m.display_name AS merchant_name,
             s.display_name AS internal_name, s.is_primary, s.stock_location_id, s.created_at,s.status,
             COALESCE((to_jsonb(s)->>'status_version')::bigint,1) AS status_version,m.status AS merchant_status
      FROM app.stores s
      JOIN app.merchants m ON m.id = s.merchant_id
      WHERE s.id = ANY($1::text[])
        AND ($3='all' OR CASE WHEN m.status='closed' OR s.status='closed' THEN 'closed' WHEN m.status<>'active' THEN m.status ELSE s.status END=$3)
        AND ($2::text IS NULL OR s.merchant_id = $2)
      ORDER BY m.display_name, s.is_primary DESC, s.display_name, s.id
    `, [storeIds, merchantId || null,status]);
    return {
      data: result.rows.map((row) => ({
        storeId: row.store_id,
        merchantId: row.merchant_id,
        merchantName: row.merchant_name,
        internalName: row.internal_name,
        isPrimary: row.is_primary,
        stockLocationId: row.stock_location_id,
        createdAt: iso(row.created_at),
        status:row.status,statusVersion:Number(row.status_version),merchantStatus:row.merchant_status,
        effectiveStatus:row.status==="closed"||row.merchant_status==="closed"?"closed":row.merchant_status!=="active"?"suspended":row.status,
      })),
    };
  });
}

export async function getPlatformStoreDetail(scope: PlatformReadScope, storeId: string,auditOffset=0): Promise<{ data: PlatformStoreDetail }> {
  requireReadableStore(scope, storeId);
  const result = await listPlatformStores({ ...scope, storeIds: [storeId] },undefined,"all");
  const store = result.data[0];
  if (!store) throw new PlatformError("not_found", "Store not found", 404);
  return platformClient(async client=>({data:{...store,lifecycleAudit:await lifecycleAuditPage(client,"store",storeId,auditOffset)}}));
}

export async function createPlatformStore(
  input: CreatePlatformStoreInput,
  actor: ScopeActor,
): Promise<{ data: PlatformStoreSummary }> {
  await ensurePlatformSchema();
  const merchantId = String(input.merchantId || "").trim();
  const displayName = normalizeDisplayName(input.displayName, "displayName");
  const stockLocationName = String(input.stockLocationName || displayName).trim().slice(0, 160) || displayName;
  if (!merchantId) throw new PlatformError("scope_required", "merchantId is required", 409);

  return withConnectedTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId });
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`platform-store-merchant:${merchantId}`]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`platform-store-id:${slugId(displayName)}`]);
    const merchant = await client.query<{ id: string; display_name: string }>(`
      SELECT id, display_name
      FROM app.merchants
      WHERE id = $1 AND status = 'active'
    `, [merchantId]);
    if (!merchant.rows[0]) throw new PlatformError("not_found", "Merchant not found or inactive", 404);

    const activeStoreCount = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM app.stores WHERE merchant_id = $1 AND status = 'active'",
      [merchantId],
    );
    const shouldBePrimary = input.isPrimary === true || Number(activeStoreCount.rows[0]?.count || 0) === 0;
    const storeId = await generateUniqueStoreId(client, displayName);
    const stockLocationId = await generateUniqueStockLocationId(client, storeId);

    if (shouldBePrimary) {
      await client.query(`
        UPDATE app.stores
        SET is_primary = false, updated_at = now()
        WHERE merchant_id = $1 AND is_primary = true
      `, [merchantId]);
    }

    await client.query(`
      INSERT INTO public.stock_location (id, name)
      VALUES ($1, $2)
    `, [stockLocationId, stockLocationName]);
    await client.query(`
      INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status, metadata)
      VALUES ($1, $2, $3, $4, $5, 'active', '{}'::jsonb)
    `, [storeId, merchantId, displayName, stockLocationId, shouldBePrimary]);

    await recordAuditEntry(client, actor, "platform.store.created", "store", storeId, {
      merchantId,
      storeId,
      after: {
        storeId,
        merchantId,
        displayName,
        stockLocationId,
        isPrimary: shouldBePrimary,
      },
    });

    return {
      data: {
        storeId,
        merchantId,
        merchantName: merchant.rows[0].display_name,
        internalName: displayName,
        isPrimary: shouldBePrimary,
        stockLocationId,
        createdAt: new Date().toISOString(),
        status:"active",statusVersion:1,merchantStatus:"active",effectiveStatus:"active",
      },
    };
  });
}

export async function listPlatformMemberships(scope: PlatformReadScope): Promise<{ data: PlatformMembershipSummary[] }> {
  return platformClient(async (client) => {
    const merchantIds = scopeMerchantIds(scope);
    const storeIds = scopeStoreIds(scope);
    const result = await client.query<{
      membership_id: string;
      operator_id: string;
      display_name: string | null;
      scope_type: MembershipScopeType;
      merchant_id: string | null;
      merchant_name: string | null;
      store_id: string | null;
      store_name: string | null;
      role_key: string;
      status: string;
      valid_from: Timestamp;
      valid_to: Timestamp | null;
      granted_by: string;
      created_at: Timestamp;
    }>(`
      SELECT om.id::text AS membership_id, om.operator_id,
             su.display_name,
             om.scope_type, om.merchant_id, m.display_name AS merchant_name,
             om.store_id, s.display_name AS store_name,
             om.role_key, om.status, om.valid_from, om.valid_to, om.granted_by,
             om.created_at
      FROM app.operator_memberships om
      LEFT JOIN medusa.staff_users su ON su.operator_id = om.operator_id
      LEFT JOIN app.merchants m ON m.id = om.merchant_id
      LEFT JOIN app.stores s ON s.id = om.store_id
      WHERE om.status = 'active'
        AND (
          om.scope_type = 'platform'
          OR om.merchant_id = ANY($1::text[])
          OR om.store_id = ANY($2::text[])
        )
      ORDER BY om.scope_type, m.display_name NULLS FIRST, s.display_name NULLS FIRST, om.operator_id
    `, [merchantIds, storeIds]);
    return {
      data: result.rows.map((row) => {
        const status = platformMembershipStatus(row.status);
        const validFrom = iso(row.valid_from);
        const validTo = row.valid_to ? iso(row.valid_to) : null;
        return {
          membershipId: row.membership_id,
          operatorId: row.operator_id,
          ...(row.display_name ? { displayName: row.display_name } : {}),
          scopeType: row.scope_type,
          ...(row.merchant_id ? { merchantId: row.merchant_id } : {}),
          ...(row.merchant_name ? { merchantName: row.merchant_name } : {}),
          ...(row.store_id ? { storeId: row.store_id } : {}),
          ...(row.store_name ? { storeName: row.store_name } : {}),
          roleKey: row.role_key,
          status,
          effectiveStatus: resolvePlatformMembershipEffectiveStatus({ status, validFrom, validTo }),
          validFrom,
          validTo,
          grantedBy: row.granted_by,
          createdAt: iso(row.created_at),
        };
      }),
    };
  });
}

export async function grantPlatformMembership(
  input: PlatformMembershipInput,
  actor: ScopeActor,
): Promise<{ data: PlatformMembershipSummary }> {
  await ensurePlatformSchema();
  const operatorId = String(input.operatorId || "").trim();
  const scopeType = canonicalMembershipScope(String(input.scopeType || ""));
  const roleKey = canonicalMembershipRole(scopeType, String(input.roleKey || ""));
  const merchantId = input.merchantId?.trim() || null;
  const storeId = input.storeId?.trim() || null;
  const { validFrom, validTo } = platformMembershipValidity(input);
  if (!operatorId) throw new PlatformError("validation_error", "operatorId is required", 400);

  return withConnectedTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('platform-membership-mutation', 0))");
    const operator = await client.query<{ operator_id: string; display_name: string | null }>(`
      SELECT operator_id, display_name
      FROM medusa.staff_users
      WHERE operator_id = $1
        AND is_active = true
    `, [operatorId]);
    if (!operator.rows[0]) throw new PlatformError("not_found", "Operator not found or inactive", 404);

    await validateMembershipTarget(client, scopeType, merchantId, storeId);
    const existing = await client.query<{ id: string }>(`
      SELECT id::text
      FROM app.operator_memberships
      WHERE operator_id = $1
        AND scope_type = $2
        AND merchant_id IS NOT DISTINCT FROM $3::text
        AND store_id IS NOT DISTINCT FROM $4::text
      ORDER BY created_at DESC
      LIMIT 1
    `, [operatorId, scopeType, merchantId, storeId]);

    let membershipId = existing.rows[0]?.id || "";
    if (existing.rows[0]) {
      await client.query(`
        UPDATE app.operator_memberships
        SET role_key = $2,
            status = 'active',
            valid_from = $3,
            valid_to = $4,
            granted_by = $5,
            updated_at = now()
        WHERE id = $1
      `, [membershipId, roleKey, validFrom, validTo, actor.operatorId]);
    } else {
      const inserted = await client.query<{ id: string }>(`
        INSERT INTO app.operator_memberships (
          operator_id, scope_type, merchant_id, store_id, role_key, status,
          valid_from, valid_to, granted_by
        )
        VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8)
        RETURNING id::text AS id
      `, [operatorId, scopeType, merchantId, storeId, roleKey, validFrom, validTo, actor.operatorId]);
      membershipId = inserted.rows[0]!.id;
    }

    await recordAuditEntry(client, actor, "platform.membership.granted", "operator_membership", membershipId, {
      merchantId: merchantId || undefined,
      storeId: storeId || undefined,
      after: {
        membershipId,
        operatorId,
        scopeType,
        merchantId,
        storeId,
        roleKey,
        validFrom: validFrom.toISOString(),
        validTo: validTo?.toISOString() || null,
      },
    });

    const readBack = await membershipReadModel(client, membershipId);
    if (!readBack) throw new PlatformError("internal_error", "Membership grant was not persisted", 500);
    return { data: readBack };
  });
}

async function validateMembershipTarget(
  client: PoolClient,
  scopeType: MembershipScopeType,
  merchantId: string | null,
  storeId: string | null,
): Promise<void> {
  if (scopeType === "platform") {
    if (merchantId || storeId) throw new PlatformError("validation_error", "Platform membership cannot include merchantId or storeId", 400);
    return;
  }
  if (!merchantId) throw new PlatformError("scope_required", "merchantId is required for merchant/store membership", 409);
  if (scopeType === "merchant") {
    if (storeId) throw new PlatformError("validation_error", "Merchant membership cannot include storeId", 400);
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId });
    return;
  }
  if (!storeId) throw new PlatformError("scope_required", "storeId is required for store membership", 409);
  await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId, storeId });
}

async function membershipReadModel(client: PoolClient, membershipId: string): Promise<PlatformMembershipSummary | null> {
  const row = await client.query<{
    membership_id: string;
    operator_id: string;
    display_name: string | null;
    scope_type: MembershipScopeType;
    merchant_id: string | null;
    merchant_name: string | null;
    store_id: string | null;
    store_name: string | null;
    role_key: string;
    status: string;
    valid_from: Timestamp;
    valid_to: Timestamp | null;
    granted_by: string;
    created_at: Timestamp;
  }>(`
    SELECT om.id::text AS membership_id, om.operator_id,
           su.display_name,
           om.scope_type, om.merchant_id, m.display_name AS merchant_name,
           om.store_id, s.display_name AS store_name,
           om.role_key, om.status, om.valid_from, om.valid_to, om.granted_by,
           om.created_at
    FROM app.operator_memberships om
    LEFT JOIN medusa.staff_users su ON su.operator_id = om.operator_id
    LEFT JOIN app.merchants m ON m.id = om.merchant_id
    LEFT JOIN app.stores s ON s.id = om.store_id
    WHERE om.id = $1::uuid
  `, [membershipId]);
  const item = row.rows[0];
  if (!item) return null;
  const status = platformMembershipStatus(item.status);
  const validFrom = iso(item.valid_from);
  const validTo = item.valid_to ? iso(item.valid_to) : null;
  return {
    membershipId: item.membership_id,
    operatorId: item.operator_id,
    ...(item.display_name ? { displayName: item.display_name } : {}),
    scopeType: item.scope_type,
    ...(item.merchant_id ? { merchantId: item.merchant_id } : {}),
    ...(item.merchant_name ? { merchantName: item.merchant_name } : {}),
    ...(item.store_id ? { storeId: item.store_id } : {}),
    ...(item.store_name ? { storeName: item.store_name } : {}),
    roleKey: item.role_key,
    status,
    effectiveStatus: resolvePlatformMembershipEffectiveStatus({ status, validFrom, validTo }),
    validFrom,
    validTo,
    grantedBy: item.granted_by,
    createdAt: iso(item.created_at),
  };
}

export async function revokePlatformMembership(
  membershipId: string,
  actor: ScopeActor,
  input: PlatformMembershipRevokeInput,
): Promise<{ data: { membershipId: string; status: "revoked" } }> {
  await ensurePlatformSchema();
  const idValue = String(membershipId || "").trim();
  if (!idValue) throw new PlatformError("validation_error", "membershipId is required", 400);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idValue)) {
    throw new PlatformError("validation_error", "membershipId must be a UUID", 400);
  }
  const reason = platformMembershipRevokeReason(input);

  return withConnectedTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('platform-membership-mutation', 0))");
    const target = await client.query<{
      id: string;
      scope_type: MembershipScopeType;
      role_key: string;
      merchant_id: string | null;
      store_id: string | null;
      is_effective: boolean;
    }>(`
      SELECT id::text, scope_type, role_key, merchant_id, store_id,
             (valid_from <= now() AND (valid_to IS NULL OR valid_to > now())) AS is_effective
      FROM app.operator_memberships
      WHERE id = $1::uuid
        AND status = 'active'
      FOR UPDATE
    `, [idValue]);
    const membership = target.rows[0];
    if (!membership) throw new PlatformError("not_found", "Active membership not found", 404);

    if (membership.scope_type === "platform" && membership.role_key === "platform_admin" && membership.is_effective) {
      const remaining = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM app.operator_memberships
        WHERE scope_type = 'platform'
          AND role_key = 'platform_admin'
          AND status = 'active'
          AND valid_from <= now()
          AND (valid_to IS NULL OR valid_to > now())
          AND id <> $1::uuid
      `, [idValue]);
      if (Number(remaining.rows[0]?.count || 0) === 0) {
        throw new PlatformError("last_platform_admin", "Cannot revoke the last active platform admin", 409);
      }
    }

    await client.query(`
      UPDATE app.operator_memberships
      SET status = 'revoked',
          valid_to = now(),
          updated_at = now()
      WHERE id = $1::uuid
    `, [idValue]);

    await recordAuditEntry(client, actor, "platform.membership.revoked", "operator_membership", idValue, {
      merchantId: membership.merchant_id || undefined,
      storeId: membership.store_id || undefined,
      before: membership,
      reason,
    });

    return { data: { membershipId: idValue, status: "revoked" as const } };
  });
}

export async function listPlatformBillingOrders(scope: PlatformReadScope): Promise<{ data: PlatformBillingOrder[] }> {
  return platformClient(async (client) => {
    const merchantIds = scopeMerchantIds(scope);
    if (!(await tableExists(client, "app", "billing_orders")) || merchantIds.length === 0) return { data: [] };
    const result = await client.query<{
      billing_order_id: string;
      merchant_id: string;
      merchant_name: string;
      purpose: string;
      target_package_key: PackageKey | null;
      amount_vnd: string;
      status: string;
      created_at: Timestamp;
      applied_at: Timestamp | null;
    }>(`
      SELECT bo.id AS billing_order_id, bo.merchant_id, m.display_name AS merchant_name,
             bo.purpose, bo.target_package_key, bo.amount_vnd::text, bo.status,
             bo.created_at, bo.applied_at
      FROM app.billing_orders bo
      JOIN app.merchants m ON m.id = bo.merchant_id
      WHERE bo.merchant_id = ANY($1::text[])
      ORDER BY bo.created_at DESC, bo.id DESC
      LIMIT 500
    `, [merchantIds]);
    return {
      data: result.rows.map((row) => ({
        billingOrderId: row.billing_order_id,
        merchantId: row.merchant_id,
        merchantName: row.merchant_name,
        purpose: row.purpose,
        ...(row.target_package_key ? { targetPackageKey: row.target_package_key } : {}),
        amountVnd: row.amount_vnd,
        status: row.status,
        createdAt: iso(row.created_at),
        ...(row.applied_at ? { appliedAt: iso(row.applied_at) } : {}),
      })),
    };
  });
}

export async function listPlatformIntegrations(scope: PlatformReadScope): Promise<{ data: PlatformIntegration[] }> {
  return platformClient(async (client) => {
    const merchantIds = scopeMerchantIds(scope);
    const storeIds = scopeStoreIds(scope);
    const result = await client.query<{
      config_id: string;
      provider_key: PaymentProviderKey;
      purpose: ProviderConfigPurpose;
      scope_type: IntegrationConfigScope;
      merchant_id: string | null;
      merchant_name: string | null;
      store_id: string | null;
      store_name: string | null;
      status: "active" | "inactive" | "error";
      has_secret: boolean;
      last_rotated_at: Timestamp | null;
      callback_url: string | null;
      health_summary: string | null;
      required_action: string | null;
      created_at: Timestamp;
      updated_at: Timestamp;
    }>(`
      SELECT ic.id AS config_id, ic.provider_key, ic.purpose, ic.scope_type,
             ic.merchant_id, m.display_name AS merchant_name,
             ic.store_id, s.display_name AS store_name,
             ic.status, (ic.secret_digest IS NOT NULL) AS has_secret,
             ic.last_rotated_at, ic.callback_url, ic.health_summary,
             ic.required_action, ic.created_at, ic.updated_at
      FROM app.integration_configs ic
      LEFT JOIN app.merchants m ON m.id = ic.merchant_id
      LEFT JOIN app.stores s ON s.id = ic.store_id
      WHERE ic.scope_type = 'platform'
         OR (ic.merchant_id = ANY($1::text[])
             AND (ic.scope_type <> 'store' OR ic.store_id = ANY($2::text[])))
      ORDER BY ic.provider_key, ic.purpose, ic.scope_type, m.display_name NULLS FIRST, s.display_name NULLS FIRST
    `, [merchantIds, storeIds]);
    return {
      data: result.rows.map((row) => ({
        configId: row.config_id,
        providerKey: row.provider_key,
        purpose: row.purpose,
        scope: row.scope_type,
        ...(row.merchant_id ? { merchantId: row.merchant_id } : {}),
        ...(row.merchant_name ? { merchantName: row.merchant_name } : {}),
        ...(row.store_id ? { storeId: row.store_id } : {}),
        ...(row.store_name ? { storeName: row.store_name } : {}),
        status: row.status,
        hasSecret: row.has_secret,
        ...(row.last_rotated_at ? { lastRotatedAt: iso(row.last_rotated_at) } : {}),
        ...(row.callback_url ? { callbackUrl: row.callback_url } : {}),
        ...(row.health_summary ? { healthSummary: row.health_summary } : {}),
        ...(row.required_action ? { requiredAction: row.required_action } : {}),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      })),
    };
  });
}

function canonicalPurpose(value: string): ProviderConfigPurpose {
  if ((providerConfigPurposes as readonly string[]).includes(value)) return value as ProviderConfigPurpose;
  if (value === "platform_subscription") return "platform_billing";
  if (value === "retail_order") return "merchant_retail";
  throw new PlatformError("validation_error", "Unsupported integration config purpose", 400);
}

function canonicalProvider(value: string): PaymentProviderKey {
  if (!(paymentProviderKeys as readonly string[]).includes(value)) {
    throw new PlatformError("validation_error", "Unsupported provider key", 400);
  }
  return value as PaymentProviderKey;
}

function canonicalScope(value: string): IntegrationConfigScope {
  if (!(integrationConfigScopes as readonly string[]).includes(value)) {
    throw new PlatformError("validation_error", "Unsupported integration config scope", 400);
  }
  return value as IntegrationConfigScope;
}

function canonicalMembershipScope(value: string): MembershipScopeType {
  if (value === "platform" || value === "merchant" || value === "store") return value;
  throw new PlatformError("validation_error", "Unsupported membership scope", 400);
}

function canonicalMembershipRole(scopeType: MembershipScopeType, value: string): string {
  if (scopeType === "platform") {
    if ((platformRoleKeys as readonly string[]).includes(value)) return value as PlatformRoleKey;
    throw new PlatformError("validation_error", "Unsupported platform role", 400);
  }
  if ((merchantRoleKeys as readonly string[]).includes(value)) return value;
  throw new PlatformError("validation_error", "Unsupported merchant role", 400);
}

function normalizeDisplayName(value: unknown, field: string): string {
  const text = String(value || "").trim();
  if (text.length < 2) {
    throw new PlatformError("validation_error", `${field} is required`, 400);
  }
  return text.slice(0, 160);
}

function slugId(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 42) || "store";
}

async function generateUniqueStoreId(client: PoolClient, displayName: string): Promise<string> {
  const base = `store_${slugId(displayName)}`;
  let candidate = base;
  let suffix = 2;
  for (;;) {
    const existing = await client.query<{ id: string }>("SELECT id FROM app.stores WHERE id = $1", [candidate]);
    if (!existing.rows[0]) return candidate;
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
}

async function generateUniqueStockLocationId(client: PoolClient, storeId: string): Promise<string> {
  const base = `sloc_${slugId(storeId)}`.slice(0, 56);
  let candidate = base;
  let suffix = 2;
  for (;;) {
    const existing = await client.query<{ id: string }>("SELECT id FROM public.stock_location WHERE id = $1", [candidate]);
    if (!existing.rows[0]) return candidate;
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
}

function canonicalAction(value: string): ProviderConfigAction {
  if (value !== "set" && value !== "replace" && value !== "rotate" && value !== "disable") {
    throw new PlatformError("validation_error", "Unsupported integration config action", 400);
  }
  return value;
}

async function validateMutationTarget(
  client: PoolClient,
  purpose: ProviderConfigPurpose,
  scope: IntegrationConfigScope,
  merchantId: string | null,
  storeId: string | null,
  action: ReturnType<typeof canonicalAction>,
): Promise<void> {
  if (purpose === "platform_billing" && scope !== "platform") {
    throw new PlatformError("validation_error", "Platform billing config requires a platform target", 400);
  }
  if (purpose === "merchant_retail" && scope === "platform") {
    throw new PlatformError("validation_error", "Merchant retail config requires a merchant or store target", 400);
  }
  if (scope === "platform") {
    if (merchantId || storeId) throw new PlatformError("validation_error", "Platform target cannot include merchantId or storeId", 400);
    return;
  }
  if (!merchantId) throw new PlatformError("scope_required", "merchantId is required for this target", 409);
  if (scope === "merchant" && storeId) throw new PlatformError("validation_error", "Merchant target cannot include storeId", 400);
  if (scope === "store" && !storeId) throw new PlatformError("scope_required", "storeId is required for a store target", 409);
  if (action !== "disable") {
    await lockActiveBusinessScopeForClient(client, scope === "merchant" ? { scopeType: "merchant", merchantId }
      : { scopeType: "store", merchantId, storeId: storeId! });
    return;
  }
  const merchant = await client.query<{ id: string }>("SELECT id FROM app.merchants WHERE id = $1", [merchantId]);
  if (!merchant.rows[0]) throw new PlatformError("forbidden", "Merchant target does not exist", 403);
  if (scope === "merchant") {
    return;
  }
  const store = await client.query<{ merchant_id: string }>(`
    SELECT merchant_id FROM app.stores WHERE id = $1
  `, [storeId]);
  if (!store.rows[0] || store.rows[0].merchant_id !== merchantId) {
    throw new PlatformError("forbidden", "Store target does not belong to the merchant target", 403);
  }
}

export async function mutatePlatformIntegrationConfig(
  input: PlatformIntegrationConfigInput,
  actor: ScopeActor,
): Promise<{ data: { configId: string; status: "active" | "inactive" } }> {
  await ensurePlatformSchema();
  const action = canonicalAction(String(input.action || ""));
  const providerKey = canonicalProvider(String(input.providerKey || ""));
  const purpose = canonicalPurpose(String(input.purpose || ""));
  const scope = canonicalScope(String(input.scope || ""));
  const merchantId = input.merchantId?.trim() || null;
  const storeId = input.storeId?.trim() || null;
  const requiresSecret = action !== "disable";
  if (requiresSecret && (typeof input.secret !== "string" || input.secret.length === 0)) {
    throw new PlatformError("validation_error", "secret is required for set, replace, and rotate", 400);
  }
  if (!requiresSecret && input.secret !== undefined) {
    throw new PlatformError("validation_error", "disable must not include a secret", 400);
  }

  return withConnectedTransaction(async (client) => {
    await validateMutationTarget(client, purpose, scope, merchantId, storeId, action);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      [providerKey, purpose, scope, merchantId || "", storeId || ""].join(":"),
    ]);
    const existing = await client.query<{ id: string }>(`
      SELECT id FROM app.integration_configs
      WHERE provider_key = $1 AND purpose = $2 AND scope_type = $3
        AND merchant_id IS NOT DISTINCT FROM $4::text
        AND store_id IS NOT DISTINCT FROM $5::text
      FOR UPDATE
    `, [providerKey, purpose, scope, merchantId, storeId]);
    const existingId = existing.rows[0]?.id;
    if (action !== "set" && !existingId) {
      throw new PlatformError("not_found", "Integration config target does not exist", 404);
    }
    const configId = existingId || id("cfg");
    const status = action === "disable" ? "inactive" as const : "active" as const;
    const secretDigest = requiresSecret ? createHash("sha256").update(input.secret!).digest("hex") : null;

    if (!existingId) {
      await client.query(`
        INSERT INTO app.integration_configs (
          id, provider_key, purpose, scope_type, merchant_id, store_id,
          status, secret_digest, secret_set_at, created_by, updated_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, now(), $8, $8)
      `, [configId, providerKey, purpose, scope, merchantId, storeId, secretDigest, actor.operatorId]);
    } else if (action === "disable") {
      await client.query(`
        UPDATE app.integration_configs
        SET status = 'inactive', secret_digest = NULL, disabled_at = now(),
            updated_by = $2, updated_at = now()
        WHERE id = $1
      `, [configId, actor.operatorId]);
    } else {
      await client.query(`
        UPDATE app.integration_configs
        SET status = 'active', secret_digest = $2, secret_set_at = now(),
            last_rotated_at = CASE WHEN $3::text IN ('replace', 'rotate') THEN now() ELSE last_rotated_at END,
            disabled_at = NULL, updated_by = $4, updated_at = now()
        WHERE id = $1
      `, [configId, secretDigest, action, actor.operatorId]);
    }

    await recordAuditEntry(client, actor, `platform.integration_config.${action}`, "integration_config", configId, {
      merchantId: merchantId || undefined,
      storeId: storeId || undefined,
      after: {
        providerKey,
        purpose,
        scope,
        merchantId,
        storeId,
        status,
        hasSecret: secretDigest !== null,
        liveMode: false,
      },
    });
    return { data: { configId, status } };
  });
}

export async function listPlatformPaymentExceptions(scope: PlatformReadScope): Promise<{ data: PlatformPaymentException[] }> {
  return platformClient(async (client) => {
    const merchantIds = scopeMerchantIds(scope);
    const data: PlatformPaymentException[] = [];
    if (merchantIds.length > 0 && await tableExists(client, "app", "billing_orders")) {
      const billing = await client.query<{
        id: string;
        provider: string;
        provider_ref: string;
        amount_vnd: string;
        issue: string;
        created_at: Timestamp;
      }>(`
        SELECT id, provider, COALESCE(provider_payment_id, id) AS provider_ref,
               amount_vnd::text, COALESCE(manual_review_reason, 'billing_manual_review') AS issue, created_at
        FROM app.billing_orders
        WHERE merchant_id = ANY($1::text[]) AND status = 'manual_review'
        ORDER BY created_at DESC
      `, [merchantIds]);
      data.push(...billing.rows.map((row) => ({
        exceptionId: `billing:${row.id}`,
        billingOrderId: row.id,
        providerKey: row.provider,
        providerRef: row.provider_ref,
        amountVnd: row.amount_vnd,
        issue: row.issue,
        status: "pending_review" as const,
        createdAt: iso(row.created_at),
      })));
    }
    if (merchantIds.length > 0 && await tableExists(client, "app", "payment_intents")) {
      const retail = await client.query<{
        id: string;
        provider: string;
        provider_ref: string;
        amount_vnd: string;
        issue: string;
        created_at: Timestamp;
      }>(`
        SELECT id, provider, COALESCE(provider_reference, reference_code, id) AS provider_ref,
               trunc(amount)::text AS amount_vnd,
               COALESCE(manual_review_reason, 'payment_manual_review') AS issue, created_at
        FROM app.payment_intents
        WHERE merchant_id = ANY($1::text[]) AND status = 'manual_review'
        ORDER BY created_at DESC
      `, [merchantIds]);
      data.push(...retail.rows.map((row) => ({
        exceptionId: `payment:${row.id}`,
        providerKey: row.provider,
        providerRef: row.provider_ref,
        amountVnd: row.amount_vnd,
        issue: row.issue,
        status: "pending_review" as const,
        createdAt: iso(row.created_at),
      })));
    }
    data.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return { data };
  });
}

export async function listPlatformSignupIdentities(scope: PlatformReadScope): Promise<{ data: SignupIdentity[] }> {
  return platformClient(async (client) => {
    if (!(await tableExists(client, "app", "signup_requests"))) return { data: [] };
    const result = await client.query<{
      identity_id: string;
      email: string;
      signup_status: string;
      merchant_id: string | null;
      merchant_name: string | null;
      created_at: Timestamp;
      verified_at: Timestamp | null;
      provisioned_at: Timestamp | null;
      token_expires_at: Timestamp | null;
      token_consumed_at: Timestamp | null;
    }>(`
      SELECT sr.id AS identity_id, sr.normalized_email AS email, sr.status AS signup_status,
             COALESCE(NULLIF(sr.metadata->>'merchantId', ''), provision.merchant_id) AS merchant_id,
             m.display_name AS merchant_name, sr.created_at, sr.verified_at, sr.provisioned_at,
             lifecycle_token.expires_at AS token_expires_at,
             lifecycle_token.consumed_at AS token_consumed_at
      FROM app.signup_requests sr
      LEFT JOIN LATERAL (
        SELECT token.expires_at, token.consumed_at
        FROM app.signup_verification_tokens token
        WHERE token.request_id = sr.id
          AND token.purpose IN ('email_verification', 'tenant_provisioning')
        ORDER BY token.created_at DESC, token.id DESC
        LIMIT 1
      ) lifecycle_token ON true
      LEFT JOIN LATERAL (
        SELECT ae.subject_id AS merchant_id
        FROM audit.events ae
        WHERE ae.action = 'signup.provisioned' AND ae.after->>'requestId' = sr.id
        ORDER BY ae.created_at DESC
        LIMIT 1
      ) provision ON true
      LEFT JOIN app.merchants m ON m.id = COALESCE(NULLIF(sr.metadata->>'merchantId', ''), provision.merchant_id)
      WHERE COALESCE(NULLIF(sr.metadata->>'merchantId', ''), provision.merchant_id) IS NULL
         OR COALESCE(NULLIF(sr.metadata->>'merchantId', ''), provision.merchant_id) = ANY($1::text[])
      ORDER BY sr.created_at DESC, sr.id DESC
      LIMIT 500
    `, [scopeMerchantIds(scope)]);
    return {
      data: result.rows.map((row) => {
        const status = resolveSignupIdentityStatus(row.signup_status, {
          expiresAt: row.token_expires_at,
          consumedAt: row.token_consumed_at,
        });
        const provisioned = status === "provisioned";
        return {
          identityId: row.identity_id,
          email: row.email,
          status,
          ...(provisioned && row.merchant_id ? { merchantId: row.merchant_id } : {}),
          ...(provisioned && row.merchant_name ? { merchantName: row.merchant_name } : {}),
          createdAt: iso(row.created_at),
          ...(row.verified_at ? { verifiedAt: iso(row.verified_at) } : {}),
          ...(row.provisioned_at ? { provisionedAt: iso(row.provisioned_at) } : {}),
          ...(row.token_expires_at ? { expiresAt: iso(row.token_expires_at) } : {}),
        };
      }),
    };
  });
}

export async function listPlatformAudit(scope: PlatformReadScope): Promise<{ data: PlatformAuditEntry[] }> {
  return platformClient(async (client) => {
    const result = await client.query<{
      id: string;
      actor_id: string;
      actor_type: string;
      action: string;
      subject_type: string;
      subject_id: string;
      reason: string | null;
      created_at: Timestamp;
    }>(`
      SELECT id::text, actor_id, actor_type, action, subject_type, subject_id, reason, created_at
      FROM audit.events
      WHERE merchant_id = ANY($1::text[])
         OR (merchant_id IS NULL AND action LIKE 'platform.%')
      ORDER BY created_at DESC, id DESC
      LIMIT 500
    `, [scopeMerchantIds(scope)]);
    return {
      data: result.rows.map((row) => ({
        id: row.id,
        actorId: row.actor_id,
        actorType: row.actor_type,
        action: row.action,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        ...(row.reason ? { reason: row.reason } : {}),
        createdAt: iso(row.created_at),
      })),
    };
  });
}
