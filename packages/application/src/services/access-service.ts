import { createHash } from "node:crypto";
import type { ExplicitPermissionGrant, MerchantTargetScope, PermissionId, PlatformReadScope, PlatformRoleKey, ReportScope, RequestAccess, OperatingScope, MembershipSummary, MembershipScopeType, MembershipStatus } from "@medusa-snus/contracts";
import {
  defaultRolePermissionIds,
  MerchantTargetScopeSchema,
  OperatingScopeSchema,
  permissions,
  platformRoleKeys,
  PlatformReadScopeSchema,
  ReportScopeSchema,
  permissionIds,
} from "@medusa-snus/contracts";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import { headerValue, type HeadersLike } from "../http/headers";
import type { PoolClient } from "../db/client";
import type { Role } from "../middleware/auth";
import { decideScopeCoupledAuthorization } from "./coupled-authorization-policy";

export type ScopeActor = {
  operatorId: string;
  role: Role;
  organizationId: string;
  sessionVersion?: number;
  sessionExpiresAt?: string;
  permissions?: string[];
  access?: RequestAccess;
};

function actorHasExplicitPermissions(actor: ScopeActor): boolean {
  return Array.isArray(actor.permissions) && actor.permissions.length > 0;
}

export type AccessibleMerchant = {
  id: string;
  displayName: string;
  legacyOrganizationId: string;
  status: string;
};

export type AccessibleStore = {
  id: string;
  merchantId: string;
  displayName: string;
  stockLocationId: string;
  isPrimary: boolean;
  status: string;
};

export type HistoricalStore = Omit<AccessibleStore, "stockLocationId"> & {
  merchantDisplayName: string;
  merchantStatus: string;
};

export type ScopeBootstrap = {
  access: RequestAccess;
  permissionVersion: string;
  merchants: AccessibleMerchant[];
  stores: AccessibleStore[];
  activeOperatingScope: OperatingScope | null;
  reportOptions: ReportScope[];
  platformReadScope: PlatformReadScope | null;
  historicalMemberships: MembershipSummary[];
  historicalExplicitPermissions: ExplicitPermissionGrant[];
  historicalStores: HistoricalStore[];
};

const allPermissionIds = new Set<string>(permissionIds);

export function permissionVersionForAccess(access: RequestAccess): string {
  const payload = {
    actorId: access.actorId,
    isPlatformAdmin: access.isPlatformAdmin,
    permissionIds: [...access.permissionIds].sort(),
    memberships: [...access.memberships as Array<MembershipSummary & {
      validFrom?: string;
      validTo?: string | null;
    }>]
      .map((membership) => ({
        membershipId: membership.membershipId,
        scopeType: membership.scopeType,
        merchantId: membership.merchantId,
        storeId: membership.storeId,
        roleKey: membership.roleKey,
        platformRoleKey: membership.platformRoleKey || null,
        status: membership.status,
        validFrom: membership.validFrom || null,
        validTo: membership.validTo || null,
        permissionIds: [...membership.permissionIds].sort(),
      }))
      .sort((left, right) => left.membershipId.localeCompare(right.membershipId)),
    explicitPermissions: [...access.explicitPermissions]
      .map((grant) => ({
        grantId: grant.grantId,
        permissionId: grant.permissionId,
        scopeType: grant.scopeType,
        merchantId: grant.merchantId,
        storeId: grant.storeId,
        validFrom: grant.validFrom,
        validTo: grant.validTo,
      }))
      .sort((left, right) => left.grantId.localeCompare(right.grantId)),
  };
  return `pv1:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

export const platformMembershipPermissionIds: PermissionId[] = [
  permissions.platformRead,
  permissions.platformWrite,
  permissions.integrationConfigRead,
  permissions.integrationConfigWrite,
];

export const platformRolePermissionIds: Record<PlatformRoleKey, PermissionId[]> = {
  platform_admin: [...platformMembershipPermissionIds],
  platform_readonly: [
    permissions.platformRead,
    permissions.integrationConfigRead,
  ],
};

export const fallbackRolePermissions: Record<Role, PermissionId[]> = {
  staff: [...defaultRolePermissionIds.staff],
  manager: [...defaultRolePermissionIds.manager],
  accountant: [...defaultRolePermissionIds.accountant],
  owner: [...defaultRolePermissionIds.owner],
};

function normalizePermissionIds(values: Iterable<string>): PermissionId[] {
  return [...new Set([...values].filter((value) => allPermissionIds.has(value)))] as PermissionId[];
}

function normalizeStatus(status: string): MembershipStatus {
  if (status === "active") return "active";
  if (status === "pending") return "pending";
  if (status === "revoked") return "revoked";
  return "disabled";
}

function normalizePlatformRoleKey(value: string): PlatformRoleKey | null {
  return platformRoleKeys.includes(value as PlatformRoleKey) ? value as PlatformRoleKey : null;
}

function normalizeMerchantRoleKey(value: string): Role | null {
  return Object.hasOwn(fallbackRolePermissions, value) ? value as Role : null;
}

function parseScopeId(headers: HeadersLike, names: string[]): string {
  for (const name of names) {
    const value = headerValue(headers, name).trim();
    if (value) return value;
  }
  return "";
}

async function tableExists(client: PoolClient, schema: string, table: string): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(client, `
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2
    ) AS exists
  `, [schema, table]);
  return Boolean(row?.exists);
}

async function rolePermissionIds(client: PoolClient, role: Role): Promise<PermissionId[]> {
  if (!(await tableExists(client, "app", "role_permissions"))) return fallbackRolePermissions[role] || [];
  const rows = await client.query<{ permission_id: string }>(`
    SELECT permission_id FROM app.role_permissions WHERE role = $1
  `, [role]);
  const fromDb = normalizePermissionIds(rows.rows.map((row) => row.permission_id));
  return normalizePermissionIds([
    ...(fromDb.length > 0 ? fromDb : fallbackRolePermissions[role] || []),
    ...(role === "staff" ? [permissions.orderCancelOwn, permissions.dashboardSelfRead] : []),
    permissions.customerRead,
    permissions.customerWrite,
    permissions.categoryRead,
  ]);
}

async function legacyAccess(client: PoolClient, actor: ScopeActor): Promise<ScopeBootstrap> {
  const permissions = normalizePermissionIds(
    actorHasExplicitPermissions(actor) ? actor.permissions! : await rolePermissionIds(client, actor.role),
  );
  const merchant = await queryOne<AccessibleMerchant>(client, `
    SELECT id, display_name AS "displayName", legacy_organization_id AS "legacyOrganizationId", status
    FROM app.merchants
    WHERE legacy_organization_id = $1 AND status = 'active'
    LIMIT 1
  `, [actor.organizationId]).catch(() => null);
  const storeRows = merchant ? await client.query<AccessibleStore>(`
    SELECT id, merchant_id AS "merchantId", display_name AS "displayName", stock_location_id AS "stockLocationId", is_primary AS "isPrimary", status
    FROM app.stores
    WHERE merchant_id = $1 AND status = 'active'
    ORDER BY is_primary DESC, display_name ASC
  `, [merchant.id]).then((result) => result.rows).catch(() => []) : [];
  const fallbackMerchant = merchant || { id: "merchant_default", displayName: "Default Merchant", legacyOrganizationId: actor.organizationId, status: "active" };
  const stores = storeRows.length ? storeRows : [{ id: "store_default", merchantId: fallbackMerchant.id, displayName: "Default Store", stockLocationId: "sloc_default", isPrimary: true, status: "active" }];
  const membership: MembershipSummary = {
    membershipId: `legacy:${actor.operatorId}:${fallbackMerchant.id}`,
    operatorId: actor.operatorId,
    scopeType: stores.length === 1 ? "store" : "merchant",
    merchantId: fallbackMerchant.id,
    storeId: stores.length === 1 ? stores[0].id : null,
    roleKey: actor.role,
    status: "active",
    permissionIds: permissions,
  };
  const access: RequestAccess = {
    actorId: actor.operatorId,
    // Legacy organization membership is never platform membership, even when
    // an internal caller supplies a platform:read permission list.
    isPlatformAdmin: false,
    legacyOrganizationId: actor.organizationId,
    memberships: [membership],
    explicitPermissions: [],
    permissionIds: permissions,
  };
  const activeOperatingScope = stores.length === 1 ? {
    scopeKind: "operating" as const,
    merchantId: stores[0].merchantId,
    storeId: stores[0].id,
    stockLocationId: stores[0].stockLocationId,
  } : null;
  return {
    access,
    permissionVersion: permissionVersionForAccess(access),
    merchants: [fallbackMerchant],
    stores,
    activeOperatingScope,
    reportOptions: [{ scopeKind: "report", merchantId: fallbackMerchant.id, storeIds: stores.map((store) => store.id) }],
    platformReadScope: null,
    historicalMemberships: [],
    historicalExplicitPermissions: [],
    historicalStores: [],
  };
}

export async function resolveRequestAccess(actor: ScopeActor): Promise<RequestAccess> {
  return (await resolveScopeBootstrap(actor)).access;
}

export async function resolveScopeBootstrap(actor: ScopeActor, headers?: HeadersLike): Promise<ScopeBootstrap> {
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    if (!(await tableExists(client, "app", "operator_memberships"))) {
      return legacyAccess(client, actor);
    }

    const membershipRows = await client.query<{
      id: string;
      scope_type: MembershipScopeType;
      merchant_id: string | null;
      store_id: string | null;
      role_key: string;
      status: string;
      merchant_status: string | null;
      store_status: string | null;
      valid_from?: Date | string;
      valid_to?: Date | string | null;
    }>(`
      SELECT om.id::text, om.scope_type, om.merchant_id, om.store_id, om.role_key,
             om.status, om.valid_from, om.valid_to,
             m.status AS merchant_status, s.status AS store_status
      FROM app.operator_memberships om
      LEFT JOIN app.merchants m ON m.id = om.merchant_id
      LEFT JOIN app.stores s ON s.id = om.store_id
      WHERE om.operator_id = $1
        AND om.status = 'active'
        AND (om.valid_to IS NULL OR om.valid_to > now())
        AND om.valid_from <= now()
        AND (
          (om.scope_type = 'platform' OR m.status = 'active')
          AND (om.scope_type <> 'store' OR s.status = 'active')
          OR om.scope_type IN ('merchant', 'store')
             AND om.role_key IN ('owner', 'manager', 'accountant')
             AND m.status IN ('active', 'suspended')
             AND (om.scope_type <> 'store' OR s.status IN ('active', 'suspended'))
        )
    `, [actor.operatorId]);

    if (membershipRows.rows.length === 0) {
      throw new PlatformError(
        "membership_required",
        "No active membership is available for this operator",
        403,
      );
    }

    const hasActivePlatformMembership = membershipRows.rows.some((row) => row.scope_type === "platform");
    const businessRoles = [...new Set(membershipRows.rows
      .filter((row) => row.scope_type !== "platform")
      .map((row) => normalizeMerchantRoleKey(row.role_key))
      .filter((role): role is Role => Boolean(role)))];
    const businessRolePermissions = new Map<Role, PermissionId[]>(await Promise.all(
      businessRoles.map(async (role) => [role, await rolePermissionIds(client, role)] as const),
    ));
    const explicitGrantRows = (await tableExists(client, "app", "operator_explicit_permission_grants"))
      ? (await client.query<{
        id: string;
        permission_id: string;
        scope_type: MembershipScopeType;
        merchant_id: string | null;
        store_id: string | null;
        granted_by: string;
        valid_from: Date | string;
        valid_to: Date | string | null;
      }>(`
        SELECT id::text, permission_id, scope_type, merchant_id, store_id, granted_by, valid_from, valid_to
        FROM app.operator_explicit_permission_grants
        WHERE operator_id = $1
          AND status = 'active'
          AND valid_from <= now()
          AND (valid_to IS NULL OR valid_to > now())
      `, [actor.operatorId])).rows
      : [];
    const explicitPermissions: ExplicitPermissionGrant[] = explicitGrantRows
      .filter((row) => allPermissionIds.has(row.permission_id))
      .map((row) => ({
        grantId: row.id,
        operatorId: actor.operatorId,
        permissionId: row.permission_id as PermissionId,
        scopeType: row.scope_type,
        merchantId: row.merchant_id,
        storeId: row.store_id,
        grantedBy: row.granted_by,
        validFrom: new Date(row.valid_from).toISOString(),
        validTo: row.valid_to ? new Date(row.valid_to).toISOString() : null,
      }));
    const permissionIdsForMembership = (row: typeof membershipRows.rows[number]): PermissionId[] => {
      if (row.scope_type === "platform") {
        const roleKey = normalizePlatformRoleKey(row.role_key);
        return roleKey ? platformRolePermissionIds[roleKey] : [];
      }
      const roleKey = normalizeMerchantRoleKey(row.role_key);
      return roleKey ? businessRolePermissions.get(roleKey) || [] : [];
    };
    const allMemberships = membershipRows.rows.map((row) => ({
      membershipId: row.id,
      operatorId: actor.operatorId,
      scopeType: row.scope_type,
      merchantId: row.merchant_id,
      storeId: row.store_id,
      roleKey: row.scope_type === "platform" ? null : normalizeMerchantRoleKey(row.role_key),
      platformRoleKey: row.scope_type === "platform" ? normalizePlatformRoleKey(row.role_key) : undefined,
      status: normalizeStatus(row.status),
      validFrom: row.valid_from ? new Date(row.valid_from).toISOString() : undefined,
      validTo: row.valid_to ? new Date(row.valid_to).toISOString() : null,
      permissionIds: permissionIdsForMembership(row),
    }));
    const operatingMembershipIds = new Set(membershipRows.rows.filter((row) =>
      row.scope_type === "platform" || (row.merchant_status === "active"
        && (row.scope_type !== "store" || row.store_status === "active"))).map((row) => row.id));
    const memberships = allMemberships.filter((row) => operatingMembershipIds.has(row.membershipId));
    const historicalMemberships = allMemberships.filter((row) => row.roleKey
      && ["owner", "manager", "accountant"].includes(row.roleKey));
    const operatingExplicitPermissions = memberships.length ? explicitPermissions : [];
    const membershipPermissionIds = normalizePermissionIds([
      ...memberships.flatMap((membership) => membership.permissionIds),
      ...operatingExplicitPermissions.map((grant) => grant.permissionId),
    ]);

    const merchantIds = [...new Set(memberships.map((membership) => membership.merchantId).filter(Boolean) as string[])];
    const merchants = hasActivePlatformMembership
      ? (await client.query<AccessibleMerchant>(`
      SELECT id, display_name AS "displayName", legacy_organization_id AS "legacyOrganizationId", status
      FROM app.merchants
      WHERE status = 'active'
      ORDER BY display_name ASC
    `)).rows
      : merchantIds.length ? (await client.query<AccessibleMerchant>(`
      SELECT id, display_name AS "displayName", legacy_organization_id AS "legacyOrganizationId", status
      FROM app.merchants
      WHERE id = ANY($1::text[]) AND status = 'active'
      ORDER BY display_name ASC
    `, [merchantIds])).rows : [];
    const accessibleMerchantIds = merchants.map((merchant) => merchant.id);
    const storeMembershipIds = memberships.filter((membership) => membership.scopeType === "store" && membership.storeId).map((membership) => membership.storeId as string);
    const merchantWideIds = memberships.filter((membership) => membership.scopeType === "merchant" && membership.merchantId).map((membership) => membership.merchantId as string);
    const stores = hasActivePlatformMembership
      ? (await client.query<AccessibleStore>(`
      SELECT id, merchant_id AS "merchantId", display_name AS "displayName", stock_location_id AS "stockLocationId", is_primary AS "isPrimary", status
      FROM app.stores
      WHERE status = 'active'
        AND merchant_id IN (SELECT id FROM app.merchants WHERE status = 'active')
      ORDER BY merchant_id, is_primary DESC, display_name ASC
    `)).rows
      : accessibleMerchantIds.length ? (await client.query<AccessibleStore>(`
      SELECT id, merchant_id AS "merchantId", display_name AS "displayName", stock_location_id AS "stockLocationId", is_primary AS "isPrimary", status
      FROM app.stores
      WHERE status = 'active'
        AND (
          merchant_id = ANY($1::text[])
          OR id = ANY($2::text[])
        )
      ORDER BY merchant_id, is_primary DESC, display_name ASC
    `, [merchantWideIds, storeMembershipIds])).rows : [];

    const access: RequestAccess = {
      actorId: actor.operatorId,
      isPlatformAdmin: hasActivePlatformMembership,
      legacyOrganizationId: actor.organizationId,
      memberships,
      explicitPermissions: operatingExplicitPermissions,
      permissionIds: membershipPermissionIds,
    };
    const historyMerchantIds = historicalMemberships.filter(row => row.scopeType === "merchant").map(row => row.merchantId);
    const historyStoreIds = historicalMemberships.filter(row => row.scopeType === "store").map(row => row.storeId);
    const historicalStores = historicalMemberships.length ? (await client.query<HistoricalStore>(`
      SELECT s.id, s.merchant_id AS "merchantId", s.display_name AS "displayName",
             s.is_primary AS "isPrimary", s.status, m.status AS "merchantStatus",
             m.display_name AS "merchantDisplayName"
      FROM app.stores s JOIN app.merchants m ON m.id=s.merchant_id
      WHERE m.status IN ('active','suspended') AND s.status IN ('active','suspended')
        AND (s.merchant_id=ANY($1::text[]) OR s.id=ANY($2::text[]))
      ORDER BY s.merchant_id, s.is_primary DESC, s.display_name, s.id
    `, [historyMerchantIds, historyStoreIds])).rows : [];
    const activeOperatingScope = selectOperatingScope(access, stores, headers);
    const reportOptions = merchants.map((merchant) => ({
      scopeKind: "report" as const,
      merchantId: merchant.id,
      storeIds: stores.filter((store) => store.merchantId === merchant.id).map((store) => store.id),
    })).filter((scope) => scope.storeIds.length > 0);
    let platformReadScope:PlatformReadScope|null=null;
    if(hasPlatformReadAccess(access)){
      const administrativeMerchants=await client.query<{id:string}>("/* administrative_entity_scope */ SELECT id FROM app.merchants ORDER BY id");
      const administrativeStores=await client.query<{id:string}>("/* administrative_entity_scope */ SELECT id FROM app.stores ORDER BY id");
      platformReadScope={scopeKind:"platform_read",merchantIds:administrativeMerchants.rows.map(row=>row.id),
        storeIds:administrativeStores.rows.map(row=>row.id)};
    }

    return {
      access,
      permissionVersion: historicalMemberships.length
        ? `pv1:${createHash("sha256").update(JSON.stringify({
          operating: permissionVersionForAccess(access), memberships: historicalMemberships,
          explicitPermissions, stores: historicalStores,
        })).digest("hex")}` : permissionVersionForAccess(access),
      merchants,
      stores,
      activeOperatingScope,
      reportOptions,
      platformReadScope,
      historicalMemberships,
      historicalExplicitPermissions: historicalMemberships.length ? explicitPermissions : [],
      historicalStores,
    };
  });
}

export function selectOperatingScope(access: RequestAccess, stores: AccessibleStore[], headers?: HeadersLike): OperatingScope | null {
  const requestedStoreId = headers ? parseScopeId(headers, ["x-store-id", "x-operating-store-id"]) : "";
  const requestedMerchantId = headers ? parseScopeId(headers, ["x-merchant-id", "x-operating-merchant-id"]) : "";
  const matchingStores = stores.filter((store) => {
    if (requestedStoreId && store.id !== requestedStoreId) return false;
    if (requestedMerchantId && store.merchantId !== requestedMerchantId) return false;
    return hasStoreAccess(access, store.merchantId, store.id);
  });
  if (requestedStoreId || requestedMerchantId) {
    const store = matchingStores[0];
    if (!store) throw new PlatformError("forbidden", "Operating scope is not accessible", 403);
    return { scopeKind: "operating", merchantId: store.merchantId, storeId: store.id, stockLocationId: store.stockLocationId };
  }
  if (stores.length === 1 && hasStoreAccess(access, stores[0].merchantId, stores[0].id)) {
    return { scopeKind: "operating", merchantId: stores[0].merchantId, storeId: stores[0].id, stockLocationId: stores[0].stockLocationId };
  }
  return null;
}

export function requireSelectedOperatingScope(access: RequestAccess, stores: AccessibleStore[], headers?: HeadersLike): OperatingScope {
  const scope = selectOperatingScope(access, stores, headers);
  if (!scope) throw new PlatformError("scope_required", "One operating store is required", 409);
  return scope;
}

function membershipIsEffective(membership: MembershipSummary, now = new Date()): boolean {
  if (membership.status !== "active") return false;
  const evidence = membership as MembershipSummary & {
    validFrom?: string;
    validTo?: string | null;
  };
  const from = evidence.validFrom ? Date.parse(evidence.validFrom) : Number.NEGATIVE_INFINITY;
  const to = evidence.validTo ? Date.parse(evidence.validTo) : Number.POSITIVE_INFINITY;
  return !Number.isNaN(from) && !Number.isNaN(to)
    && from <= now.getTime() && now.getTime() < to;
}

export function hasActivePlatformMembership(access: RequestAccess, now = new Date()): boolean {
  return access.memberships.some((membership) => (
    membership.scopeType === "platform" && membershipIsEffective(membership, now)
  ));
}

export async function requireActivePlatformMembership(actor: ScopeActor): Promise<RequestAccess> {
  const access = actor.access || await resolveRequestAccess(actor);
  if (!hasActivePlatformMembership(access)) {
    throw new PlatformError("forbidden", "Active platform membership required", 403);
  }
  return access;
}

export function hasPlatformReadAccess(access: RequestAccess): boolean {
  return decideScopeCoupledAuthorization(
    access,
    permissions.platformRead,
    { scopeType: "platform" },
  ).allowed;
}

export function hasMerchantAccess(access: RequestAccess, merchantId: string): boolean {
  if (hasPlatformReadAccess(access)) return true;
  return access.memberships.some((membership) => membershipIsEffective(membership) && membership.merchantId === merchantId && (
    membership.scopeType === "merchant" || membership.scopeType === "store"
  ));
}

export function hasStoreAccess(access: RequestAccess, merchantId: string, storeId: string): boolean {
  if (hasPlatformReadAccess(access)) return true;
  return access.memberships.some((membership) => membershipIsEffective(membership) && (
    (membership.scopeType === "merchant" && membership.merchantId === merchantId) ||
    (membership.scopeType === "store" && membership.merchantId === merchantId && membership.storeId === storeId)
  ));
}

export async function resolveOperatingScope(actor: ScopeActor, headers: HeadersLike, required = true): Promise<OperatingScope | null> {
  const bootstrap = await resolveScopeBootstrap(actor, headers);
  if (!bootstrap.activeOperatingScope) {
    if (!required) return null;
    throw new PlatformError("scope_required", "One operating store is required", 409, {
      accessibleStores: bootstrap.stores.map((store) => ({ id: store.id, merchantId: store.merchantId, displayName: store.displayName })),
    });
  }
  return OperatingScopeSchema.parse(bootstrap.activeOperatingScope);
}

export async function requireOperatingScope(actor: ScopeActor, headers: HeadersLike): Promise<OperatingScope> {
  const scope = await resolveOperatingScope(actor, headers, true);
  if (!scope) throw new PlatformError("scope_required", "One operating store is required", 409);
  return scope;
}

export function requireMerchantTargetScope(access: RequestAccess, merchantId: string): MerchantTargetScope {
  if (!merchantId.trim()) throw new PlatformError("scope_required", "A merchant target is required", 409);
  if (!hasMerchantAccess(access, merchantId)) {
    throw new PlatformError("forbidden", "Merchant target is not accessible", 403);
  }
  return MerchantTargetScopeSchema.parse({ scopeKind: "merchant_target", merchantId });
}

export async function resolveMerchantTargetScope(actor: ScopeActor, merchantId: string): Promise<MerchantTargetScope> {
  const access = await resolveRequestAccess(actor);
  return requireMerchantTargetScope(access, merchantId);
}

export async function resolveReportScope(actor: ScopeActor, headers: HeadersLike): Promise<ReportScope> {
  const bootstrap = await resolveScopeBootstrap(actor, headers);
  const merchantId = parseScopeId(headers, ["x-report-merchant-id", "x-merchant-id"]);
  const storeIdsHeader = parseScopeId(headers, ["x-report-store-ids", "x-store-ids"]);
  const requestedStoreIds = storeIdsHeader ? storeIdsHeader.split(",").map((value) => value.trim()).filter(Boolean) : [];
  const fallback = bootstrap.reportOptions[0];
  const targetMerchantId = merchantId || fallback?.merchantId;
  if (!targetMerchantId) throw new PlatformError("scope_required", "A report merchant is required", 409);
  const allowedStores = bootstrap.stores.filter((store) => store.merchantId === targetMerchantId && hasStoreAccess(bootstrap.access, store.merchantId, store.id));
  const targetStoreIds = requestedStoreIds.length ? requestedStoreIds : allowedStores.map((store) => store.id);
  if (targetStoreIds.length === 0 || targetStoreIds.some((storeId) => !allowedStores.some((store) => store.id === storeId))) {
    throw new PlatformError("forbidden", "Report scope is not accessible", 403);
  }
  return ReportScopeSchema.parse({ scopeKind: "report", merchantId: targetMerchantId, storeIds: targetStoreIds });
}

export async function resolvePlatformReadScope(actor: ScopeActor, headers: HeadersLike): Promise<PlatformReadScope> {
  const bootstrap = await resolveScopeBootstrap(actor);
  return requirePlatformReadScopeForAccess(bootstrap.access, bootstrap.platformReadScope);
}

export function requirePlatformReadScopeForAccess(access: RequestAccess, scope: PlatformReadScope | null): PlatformReadScope {
  if (!hasPlatformReadAccess(access) || !scope) {
    throw new PlatformError("forbidden", "Platform read access required", 403);
  }
  return PlatformReadScopeSchema.parse(scope);
}

export async function requireActorAccessPermission(actor: ScopeActor, permissionId: PermissionId): Promise<void> {
  const access = actor.access || await resolveRequestAccess(actor);
  if (!access.permissionIds.includes(permissionId)) {
    throw new PlatformError("forbidden", `Missing permission: ${permissionId}`, 403);
  }
}
