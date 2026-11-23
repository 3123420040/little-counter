import type {
  MerchantTargetScope,
  PackageKey,
  SubscriptionStatus,
  UsageMetricKey,
} from "@medusa-snus/contracts";
import { packageKeys, permissions } from "@medusa-snus/contracts";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import type { HeadersLike } from "../http/headers";
import { PlatformError } from "../errors/platform-error";
import type { OperatorContext } from "./auth-service";
import { resolveScopeBootstrap } from "./access-service";
import { historicalPermissionIds } from "./historical-read-scope-service";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import { recordAuditEntry } from "../repositories/audit-repository";
import { getPaymentProviderAvailability } from "./payment-provider-service";
import { getMerchantSubscriptionStatus } from "./subscription-service";
import { resolvePackageEntitlements } from "./feature-entitlement-service";
import { listCatalogEntries } from "./package-catalog-service";
import { getOrCreateUsageBucket } from "./subscription-usage-service";
import {
  initiateNewSubscription,
  initiateRenewal,
  initiateUpgrade,
} from "./subscription-billing-service";
import { ensureOperatorSecurityState } from "./operator-security-service";
import {
  describeStoreSettlementPolicyFromMetadata,
  updateStoreSettlementPolicyWithinClientV1,
} from "./store-settlement-policy-service";

export interface AddressDto {
  street?: string;
  ward?: string;
  district?: string;
  city?: string;
  country?: string;
  googleMapsUrl?: string;
}

export interface BusinessHoursDto {
  dayOfWeek: number;
  openTime?: string;
  closeTime?: string;
  closed: boolean;
}

export interface MerchantProfileDto {
  merchantId: string;
  internalName: string;
  publicName: string;
  receiptName: string;
  messageName: string;
  taxCode?: string;
  email?: string;
  phone?: string;
  website?: string;
  address?: AddressDto;
  logoUrl?: string;
}

export interface StoreProfileDto {
  storeId: string;
  merchantId: string;
  internalName: string;
  publicName: string;
  receiptName: string;
  messageName: string;
  isPrimary: boolean;
  email?: string;
  phone?: string;
  address?: AddressDto;
  businessHours?: BusinessHoursDto[];
  googleMapsUrl?: string;
  facebookUrl?: string;
  instagramUrl?: string;
  stockLocationId: string;
  bankSettlementPolicy:
    | {
        status: "ok";
        mode: "manual_confirmation" | "confirm_on_booking";
        version: number;
        source: "configured" | "default";
        updatedAt: string | null;
        updatedBy: string | null;
      }
    | { status: "invalid" };
}

export type UpdateMerchantProfileInput = Partial<Pick<
  MerchantProfileDto,
  "internalName" | "publicName" | "receiptName" | "messageName" | "email" | "phone" | "website" | "address"
>>;

export type UpdateStoreProfileInput = Partial<Pick<
  StoreProfileDto,
  "internalName" | "publicName" | "receiptName" | "messageName" | "email" | "phone" | "address" | "businessHours" | "googleMapsUrl" | "facebookUrl" | "instagramUrl"
>> & {
  /**
   * Store-scoped bank settlement policy update (2.1). Applied in the same
   * transaction with compare-and-swap versioning and its own audit entry.
   */
  bankTransferSettlement?: {
    mode: "manual_confirmation" | "confirm_on_booking";
    expectedVersion: number;
  };
};

export type TeamMembershipStatus = "active" | "disabled" | "pending" | "revoked";
export type TeamMemberEffectiveStatus = TeamMembershipStatus | "scheduled" | "expired" | "suspended";
export type TeamMemberGlobalStatus = "active" | "suspended";

export interface TeamMemberDto {
  membershipId: string;
  operatorId: string;
  displayName: string;
  role: string;
  scopeType: "merchant" | "store";
  storeId?: string;
  storeName?: string;
  membershipStatus: TeamMembershipStatus;
  status: TeamMemberEffectiveStatus;
  globalStatus: TeamMemberGlobalStatus;
  validFrom: string;
  validTo: string | null;
  email?: string | null;
  phoneE164?: string | null;
  joinedAt: string;
}

export function resolveTeamMemberEffectiveStatus(
  authority: Pick<TeamMemberDto, "membershipStatus" | "globalStatus" | "validFrom" | "validTo">,
  now = new Date(),
): TeamMemberEffectiveStatus {
  if (authority.membershipStatus === "revoked") return "revoked";
  if (authority.globalStatus === "suspended") return "suspended";
  if (authority.membershipStatus === "pending") return "pending";
  if (authority.membershipStatus === "disabled") return "disabled";

  const nowMs = now.getTime();
  const validFromMs = Date.parse(authority.validFrom);
  const validToMs = authority.validTo ? Date.parse(authority.validTo) : null;
  if (!Number.isFinite(nowMs) || !Number.isFinite(validFromMs) || (validToMs !== null && !Number.isFinite(validToMs))) {
    return "expired";
  }
  if (validFromMs > nowMs) return "scheduled";
  if (validToMs !== null && validToMs <= nowMs) return "expired";
  return "active";
}

export interface PackageStatusDto {
  merchantId: string;
  currentPackageKey: PackageKey;
  subscriptionStatus: SubscriptionStatus;
  periodStart: string | null;
  periodEnd: string | null;
  graceEndsAt: string | null;
  renewalDate: string | null;
  annualPriceVnd: string;
  monthlyEquivalentVnd: string;
  usage: Array<{
    metricKey: UsageMetricKey;
    label: string;
    used: number;
    limit: number | null;
  }>;
}

export interface PackageCatalogEntryDto {
  packageKey: PackageKey;
  displayName: string;
  annualPriceVnd: string;
  monthlyEquivalentVnd: string;
  includedStores: number;
  features: string[];
}

export interface PackagePageDto {
  currentStatus: PackageStatusDto;
  catalog: PackageCatalogEntryDto[];
  canUpgrade: boolean;
  canRenew: boolean;
}

export interface IntegrationStatusDto {
  integrationId: string;
  providerKey: string;
  purpose: string;
  scope: "merchant" | "store";
  storeId?: string;
  storeName?: string;
  status: "active" | "inactive" | "error" | "pending_config";
  healthSummary?: string;
  callbackUrl?: string;
  requiredAction?: string;
  lastCheckedAt?: string;
}

export interface SettingsAuditEntryDto {
  id: string;
  actorId: string;
  actorType: string;
  action: string;
  subjectType: string;
  subjectId: string;
  reason?: string;
  createdAt: string;
}

type Metadata = Record<string, unknown>;
type SettingsActor = {
  operatorId: string;
  role?: string;
  organizationId?: string;
};

type MerchantRow = {
  [key: string]: unknown;
  id: string;
  display_name: string;
  legacy_organization_id: string;
  status: string;
  metadata: Metadata | string | null;
};

type StoreRow = {
  [key: string]: unknown;
  id: string;
  merchant_id: string;
  display_name: string;
  stock_location_id: string;
  is_primary: boolean;
  status: string;
  metadata: Metadata | string | null;
};

type OwnerIntegrationConfigRow = {
  id: string;
  provider_key: string;
  purpose: "platform_billing" | "merchant_retail";
  scope_type: "platform" | "merchant" | "store";
  merchant_id: string | null;
  store_id: string | null;
  store_name: string | null;
  status: "active" | "inactive" | "error";
  callback_url: string | null;
  health_summary: string | null;
  required_action: string | null;
  updated_at: Date | string;
};

const SETTINGS_KEY = "ownerSettings";
const usageLabels: Record<UsageMetricKey, string> = {
  product_research_runs: "Nghiên cứu sản phẩm",
  telegram_ai_drafts: "Bản nháp Telegram AI",
  provider_credits: "Provider credits",
  llm_tokens: "LLM tokens",
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function metadata(value: Metadata | string | null | undefined): Metadata {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Metadata : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function settingsFrom(value: Metadata | string | null | undefined): Metadata {
  const meta = metadata(value);
  const raw = meta[SETTINGS_KEY];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Metadata : {};
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function requiredString(value: unknown, fallback: string): string {
  return optionalString(value) || fallback;
}

function address(value: unknown): AddressDto | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: AddressDto = {};
  for (const key of ["street", "ward", "district", "city", "country", "googleMapsUrl"] as const) {
    const text = optionalString(source[key]);
    if (text) result[key] = text;
  }
  return Object.keys(result).length ? result : undefined;
}

function businessHours(value: unknown): BusinessHoursDto[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: BusinessHoursDto[] = [];
  for (const row of value) {
    const source = row && typeof row === "object" ? row as Record<string, unknown> : {};
    const day = Number(source.dayOfWeek);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    const normalized: BusinessHoursDto = {
      dayOfWeek: day,
      closed: Boolean(source.closed),
    };
    const openTime = optionalString(source.openTime);
    const closeTime = optionalString(source.closeTime);
    if (openTime) normalized.openTime = openTime;
    if (closeTime) normalized.closeTime = closeTime;
    rows.push(normalized);
  }
  return rows.length ? rows : undefined;
}

function mergeSettings(current: Metadata, input: Record<string, unknown>, keys: readonly string[]): Metadata {
  const next = { ...current };
  for (const key of keys) {
    if (!(key in input)) continue;
    if (key === "address") {
      const parsed = address(input[key]);
      if (parsed) next[key] = parsed;
      else delete next[key];
      continue;
    }
    if (key === "businessHours") {
      const parsed = businessHours(input[key]);
      if (parsed) next[key] = parsed;
      else delete next[key];
      continue;
    }
    const text = optionalString(input[key]);
    if (text !== undefined) next[key] = text;
    else delete next[key];
  }
  return next;
}

function applyOwnerSettings(metaValue: Metadata | string | null, settings: Metadata): Metadata {
  return {
    ...metadata(metaValue),
    [SETTINGS_KEY]: settings,
  };
}

function merchantProfile(row: MerchantRow): MerchantProfileDto {
  const settings = settingsFrom(row.metadata);
  const name = row.display_name || row.id;
  return {
    merchantId: row.id,
    internalName: name,
    publicName: requiredString(settings.publicName, name),
    receiptName: requiredString(settings.receiptName, name),
    messageName: requiredString(settings.messageName, name),
    taxCode: optionalString(settings.taxCode),
    email: optionalString(settings.email),
    phone: optionalString(settings.phone),
    website: optionalString(settings.website),
    address: address(settings.address),
    logoUrl: optionalString(settings.logoUrl),
  };
}

function storeProfile(row: StoreRow): StoreProfileDto {
  const settings = settingsFrom(row.metadata);
  const name = row.display_name || row.id;
  return {
    storeId: row.id,
    merchantId: row.merchant_id,
    internalName: name,
    publicName: requiredString(settings.publicName, name),
    receiptName: requiredString(settings.receiptName, name),
    messageName: requiredString(settings.messageName, name),
    isPrimary: Boolean(row.is_primary),
    email: optionalString(settings.email),
    phone: optionalString(settings.phone),
    address: address(settings.address),
    businessHours: businessHours(settings.businessHours),
    googleMapsUrl: optionalString(settings.googleMapsUrl),
    facebookUrl: optionalString(settings.facebookUrl),
    instagramUrl: optionalString(settings.instagramUrl),
    stockLocationId: row.stock_location_id,
    bankSettlementPolicy: describeStoreSettlementPolicyFromMetadata(row.metadata),
  };
}

async function merchantRow(client: PoolClient, merchantId: string, lock = false): Promise<MerchantRow> {
  const row = await queryOne<MerchantRow>(client, `
    SELECT id, display_name, legacy_organization_id, status, metadata
    FROM app.merchants
    WHERE id = $1 AND status = 'active'
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
  `, [merchantId]);
  if (!row) throw new PlatformError("resource_not_found", "Merchant settings target not found", 404, { merchantId });
  return row;
}

async function storeRow(client: PoolClient, storeId: string, lock = false): Promise<StoreRow> {
  const row = await queryOne<StoreRow>(client, `
    SELECT id, merchant_id, display_name, stock_location_id, is_primary, status, metadata
    FROM app.stores
    WHERE id = $1 AND status = 'active'
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
  `, [storeId]);
  if (!row) throw new PlatformError("resource_not_found", "Store settings target not found", 404, { storeId });
  return row;
}

function ensureScope(scope: MerchantTargetScope, merchantId: string): void {
  if (scope.merchantId !== merchantId) {
    throw new PlatformError("forbidden", "Merchant target is not accessible", 403, { merchantId });
  }
}

export async function getSettingsMe(operator: OperatorContext, headers: HeadersLike) {
  await ensurePlatformSchema();
  // A stale operating selection after suspension must not block account/history bootstrap.
  const bootstrap = await resolveScopeBootstrap(operator);
  const merchantMembershipIds = new Set(
    bootstrap.access.memberships
      .filter((membership) => membership.scopeType !== "platform" && membership.merchantId)
      .map((membership) => membership.merchantId as string),
  );
  const merchant = bootstrap.merchants.find((candidate) => merchantMembershipIds.has(candidate.id)) || null;
  const merchantById = new Map(bootstrap.merchants.map((candidate) => [candidate.id, candidate]));
  const [subscription, entitlements] = merchant
    ? await Promise.all([
      getMerchantSubscriptionStatus(merchant.id),
      resolvePackageEntitlements({ merchantId: merchant.id }),
    ])
    : [null, null] as const;
  const visibleStores = bootstrap.stores;
  const account = await withConnectedClient(async (client) => {
    await client.query(`
      INSERT INTO app.operator_profiles (operator_id)
      VALUES ($1)
      ON CONFLICT (operator_id) DO NOTHING
    `, [operator.operatorId]);
    const [profile, security, telegramIdentity] = await Promise.all([
      queryOne<{
        email: string | null;
        phone_e164: string | null;
        locale: string | null;
        avatar_url: string | null;
      }>(client, `
        SELECT email, phone_e164, locale, avatar_url
        FROM app.operator_profiles
        WHERE operator_id = $1
      `, [operator.operatorId]),
      ensureOperatorSecurityState(client, operator.operatorId),
      queryOne<{ provider_user_id: string }>(client, `
        SELECT provider_user_id
        FROM app.operator_identities
        WHERE operator_id = $1
          AND provider = 'telegram'
          AND is_active = true
        LIMIT 1
      `, [operator.operatorId]).catch(() => null),
    ]);
    return {
      profile,
      security,
      telegramLinked: Boolean(telegramIdentity),
    };
  });

  return {
    operatorId: operator.operatorId,
    displayName: operator.displayName,
    role: operator.role,
    isPlatformAdmin: bootstrap.access.isPlatformAdmin,
    canManageMerchantLifecycle: !operator.impersonationSessionId && !account.security.requiresPasswordChange
      && account.security.globalStatus === "active" && bootstrap.access.memberships.some(membership =>
        membership.scopeType === "platform" && membership.platformRoleKey === "platform_admin" && membership.status === "active"
        && membership.permissionIds.includes(permissions.platformWrite)),
    permissionIds: bootstrap.access.permissionIds,
    permissionVersion: bootstrap.permissionVersion,
    historicalPermissionIds: historicalPermissionIds(bootstrap),
    historicalStores: bootstrap.historicalStores.map(store => ({
      storeId: store.id, merchantId: store.merchantId, displayName: store.displayName,
      merchantDisplayName: store.merchantDisplayName, isPrimary: store.isPrimary,
      status: store.status, merchantStatus: store.merchantStatus,
    })),
    security: {
      requiresPasswordChange: account.security.requiresPasswordChange,
      passwordChangedAt: account.security.passwordChangedAt?.toISOString() ?? null,
      globalStatus: account.security.globalStatus,
      sessionVersion: account.security.sessionVersion,
      forceLogoutAfter: account.security.forceLogoutAfter?.toISOString() ?? null,
    },
    profile: {
      email: account.profile?.email ?? null,
      phoneE164: account.profile?.phone_e164 ?? null,
      locale: account.profile?.locale ?? null,
      avatarUrl: account.profile?.avatar_url ?? null,
      telegramLinked: account.telegramLinked,
    },
    impersonation: operator.impersonationSessionId ? {
      sessionId: operator.impersonationSessionId,
      mode: operator.impersonationMode || "read_only",
      actualOperatorId: operator.actualOperatorId || operator.operatorId,
      effectiveOperatorId: operator.effectiveOperatorId || operator.operatorId,
    } : undefined,
    featureEntitlements: entitlements?.features || [],
    merchant: merchant && subscription ? {
      merchantId: merchant.id,
      displayName: merchant.displayName,
      packageKey: subscription.packageKey,
      subscriptionStatus: subscription.status,
    } : null,
    stores: visibleStores.map((store) => ({
      storeId: store.id,
      merchantId: store.merchantId,
      merchantDisplayName: merchantById.get(store.merchantId)?.displayName || store.merchantId,
      displayName: store.displayName,
      isPrimary: store.isPrimary,
    })),
  };
}

export async function getMerchantSettingsProfile(merchantId: string, scope: MerchantTargetScope): Promise<{ data: MerchantProfileDto }> {
  ensureScope(scope, merchantId);
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => ({ data: merchantProfile(await merchantRow(client, merchantId)) }));
}

export async function updateMerchantSettingsProfile(
  merchantId: string,
  input: UpdateMerchantProfileInput,
  actor: SettingsActor,
  scope: MerchantTargetScope,
): Promise<{ data: MerchantProfileDto }> {
  ensureScope(scope, merchantId);
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId }, "update");
    const current = await merchantRow(client, merchantId, true);
    const before = merchantProfile(current);
    const settings = mergeSettings(settingsFrom(current.metadata), input as Record<string, unknown>, [
      "publicName", "receiptName", "messageName", "email", "phone", "website", "address",
    ]);
    const internalName = optionalString(input.internalName) || before.internalName;
    const updated = await queryOne<MerchantRow>(client, `
      UPDATE app.merchants
      SET display_name = $2,
          metadata = $3::jsonb,
          updated_at = now()
      WHERE id = $1
      RETURNING id, display_name, legacy_organization_id, status, metadata
    `, [merchantId, internalName, JSON.stringify(applyOwnerSettings(current.metadata, settings))]);
    if (!updated) throw new PlatformError("settings_update_failed", "Merchant settings update failed", 500, { merchantId });
    const after = merchantProfile(updated);
    await recordAuditEntry(client, actor, "settings.merchant.updated", "merchant_settings", merchantId, {
      before,
      after,
      merchantId,
    });
    return { data: after };
  });
}

export async function listStoreSettings(merchantId: string, scope: MerchantTargetScope): Promise<{ data: StoreProfileDto[] }> {
  ensureScope(scope, merchantId);
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const rows = await client.query<StoreRow>(`
      SELECT id, merchant_id, display_name, stock_location_id, is_primary, status, metadata
      FROM app.stores
      WHERE merchant_id = $1 AND status = 'active'
      ORDER BY is_primary DESC, display_name ASC
    `, [merchantId]);
    return { data: rows.rows.map(storeProfile) };
  });
}

export async function getStoreSettingsTarget(storeId: string): Promise<{ storeId: string; merchantId: string }> {
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    // Resolve identity before authorization; the mutation's locked guard checks lifecycle.
    const row = await queryOne<Pick<StoreRow, "id" | "merchant_id">>(client,
      "SELECT id, merchant_id FROM app.stores WHERE id = $1 LIMIT 1", [storeId]);
    if (!row) throw new PlatformError("resource_not_found", "Store settings target not found", 404, { storeId });
    return { storeId: row.id, merchantId: row.merchant_id };
  });
}

export async function getStoreSettingsProfile(storeId: string, scope: MerchantTargetScope): Promise<{ data: StoreProfileDto }> {
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const row = await storeRow(client, storeId);
    ensureScope(scope, row.merchant_id);
    return { data: storeProfile(row) };
  });
}

export async function updateStoreSettingsProfile(
  storeId: string,
  input: UpdateStoreProfileInput,
  actor: SettingsActor,
  scope: MerchantTargetScope,
): Promise<{ data: StoreProfileDto }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId }, "update");
    const current = await storeRow(client, storeId, true);
    ensureScope(scope, current.merchant_id);
    const before = storeProfile(current);
    if (input.bankTransferSettlement) {
      await updateStoreSettlementPolicyWithinClientV1(
        client,
        current,
        input.bankTransferSettlement,
        actor,
      );
    }
    // The locked row stays current within this transaction; re-read so the
    // profile merge below never drops a policy namespace written above.
    const policyRefreshed = input.bankTransferSettlement
      ? await storeRow(client, storeId, false)
      : current;
    const settings = mergeSettings(settingsFrom(policyRefreshed.metadata), input as Record<string, unknown>, [
      "publicName", "receiptName", "messageName", "email", "phone", "address", "businessHours", "googleMapsUrl", "facebookUrl", "instagramUrl",
    ]);
    const internalName = optionalString(input.internalName) || before.internalName;
    const updated = await queryOne<StoreRow>(client, `
      UPDATE app.stores
      SET display_name = $2,
          metadata = $3::jsonb,
          updated_at = now()
      WHERE id = $1
      RETURNING id, merchant_id, display_name, stock_location_id, is_primary, status, metadata
    `, [storeId, internalName, JSON.stringify(applyOwnerSettings(policyRefreshed.metadata, settings))]);
    if (!updated) throw new PlatformError("settings_update_failed", "Store settings update failed", 500, { storeId });
    const after = storeProfile(updated);
    await recordAuditEntry(client, actor, "settings.store.updated", "store_settings", storeId, {
      before,
      after,
      merchantId: current.merchant_id,
      storeId,
    });
    return { data: after };
  });
}

export async function listTeamMembers(
  merchantId: string,
  scope: MerchantTargetScope,
  actor: OperatorContext,
): Promise<{ data: TeamMemberDto[] }> {
  ensureScope(scope, merchantId);
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const membershipTable = await queryOne<{ exists: boolean }>(client, `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'app' AND table_name = 'operator_memberships'
      ) AS exists
    `);
    if (!membershipTable?.exists) {
      if (actor.role !== "owner" && actor.role !== "manager") {
        throw new PlatformError("forbidden", "Owner or manager team authority required", 403);
      }
      const merchant = await merchantRow(client, merchantId);
      const legacyRows = await client.query<{
        operator_id: string;
        display_name: string;
        role: string;
        created_at: Date | string;
      }>(`
        SELECT operator_id, display_name, role, created_at
        FROM medusa.staff_users
        WHERE organization_id = $1 AND is_active = true
        ORDER BY display_name ASC
      `, [merchant.legacy_organization_id]);
      return {
        data: legacyRows.rows.map((row) => ({
          membershipId: `legacy:${row.operator_id}:${merchantId}`,
          operatorId: row.operator_id,
          displayName: row.display_name,
          role: row.role,
          scopeType: "merchant" as const,
          membershipStatus: "active" as const,
          status: "active" as const,
          globalStatus: "active" as const,
          validFrom: iso(row.created_at),
          validTo: null,
          joinedAt: iso(row.created_at),
        })),
      };
    }

    const authorityRows = await client.query<{ scope_type: "merchant" | "store"; store_id: string | null }>(`
      SELECT scope_type, store_id
      FROM app.operator_memberships
      WHERE operator_id = $1
        AND merchant_id = $2
        AND status = 'active'
        AND role_key IN ('owner', 'manager')
        AND scope_type IN ('merchant', 'store')
        AND valid_from <= now()
        AND (valid_to IS NULL OR valid_to > now())
    `, [actor.operatorId, merchantId]);
    if (authorityRows.rows.length === 0) {
      throw new PlatformError("forbidden", "Owner or manager team authority required", 403);
    }
    const merchantWide = authorityRows.rows.some((row) => row.scope_type === "merchant");
    const readableStoreIds = [...new Set(authorityRows.rows
      .filter((row) => row.scope_type === "store" && row.store_id)
      .map((row) => row.store_id as string))];

    const rows = await client.query<{
      membership_id: string;
      operator_id: string;
      display_name: string | null;
      email: string | null;
      phone_e164: string | null;
      role: string;
      scope_type: "merchant" | "store" | "platform";
      store_id: string | null;
      store_name: string | null;
      status: string;
      valid_from: Date | string;
      valid_to: Date | string | null;
      global_status: string;
      created_at: Date | string;
    }>(`
      SELECT om.id::text AS membership_id, om.operator_id,
             su.display_name,
             p.email,
             p.phone_e164,
             om.role_key AS role,
             om.scope_type,
             om.store_id,
             s.display_name AS store_name,
             om.status,
             om.valid_from,
             om.valid_to,
             COALESCE(sec.global_status, 'active') AS global_status,
             om.created_at
      FROM app.operator_memberships om
      LEFT JOIN medusa.staff_users su ON su.operator_id = om.operator_id
      LEFT JOIN app.operator_profiles p ON p.operator_id = om.operator_id
      LEFT JOIN app.stores s ON s.id = om.store_id
      LEFT JOIN app.operator_security_state sec ON sec.operator_id = om.operator_id
      WHERE om.merchant_id = $1
        AND om.scope_type IN ('merchant', 'store')
        AND ($2::boolean OR (om.scope_type = 'store' AND om.store_id = ANY($3::text[])))
      ORDER BY om.scope_type, COALESCE(su.display_name, om.operator_id)
    `, [merchantId, merchantWide, readableStoreIds]);

    return {
      data: rows.rows.map((row) => {
        const membershipStatus: TeamMembershipStatus = row.status === "active"
          || row.status === "disabled"
          || row.status === "pending"
          || row.status === "revoked"
          ? row.status
          : "revoked";
        const globalStatus: TeamMemberGlobalStatus = row.global_status === "active" ? "active" : "suspended";
        const validFrom = iso(row.valid_from);
        const validTo = row.valid_to ? iso(row.valid_to) : null;
        const authority = { membershipStatus, globalStatus, validFrom, validTo };
        return {
          membershipId: row.membership_id,
          operatorId: row.operator_id,
          displayName: row.display_name || row.operator_id,
          role: row.role,
          scopeType: row.scope_type === "store" ? "store" : "merchant",
          storeId: row.store_id || undefined,
          storeName: row.store_name || undefined,
          ...authority,
          status: resolveTeamMemberEffectiveStatus(authority),
          email: row.email,
          phoneE164: row.phone_e164,
          joinedAt: iso(row.created_at),
        };
      }),
    };
  });
}

function monthlyEquivalent(annualPriceVnd: string): string {
  return (BigInt(annualPriceVnd) / 12n).toString();
}

function packageDisplayName(packageKey: PackageKey): string {
  if (packageKey === "basic") return "Basic";
  if (packageKey === "plus") return "Plus";
  return "AI Fan";
}

export async function getOwnerPackagePage(merchantId: string, scope: MerchantTargetScope): Promise<{ data: PackagePageDto }> {
  ensureScope(scope, merchantId);
  await ensurePlatformSchema();
  const subscription = await getMerchantSubscriptionStatus(merchantId);
  const catalog = await listCatalogEntries();
  const catalogEntries = [...catalog.data.entries].sort(
    (left, right) => packageKeys.indexOf(left.packageKey) - packageKeys.indexOf(right.packageKey),
  );
  const currentCatalog = catalogEntries.find((entry) => entry.packageKey === subscription.packageKey);
  const usageMetrics: UsageMetricKey[] = ["product_research_runs", "telegram_ai_drafts"];
  const usage = await Promise.all(usageMetrics.map(async (metricKey) => {
    const bucket = await getOrCreateUsageBucket(merchantId, metricKey);
    return {
      metricKey,
      label: usageLabels[metricKey],
      used: bucket.usedQuantity,
      limit: bucket.includedQuantity,
    };
  }));

  const annualPriceVnd = currentCatalog?.annualPrice.amountVnd || "0";
  const packageOrder = packageKeys;
  const currentIndex = packageOrder.indexOf(subscription.packageKey);
  const canUpgrade = currentIndex >= 0 && currentIndex < packageOrder.length - 1 && subscription.status !== "expired";
  const canRenew = subscription.packageKey !== "basic";

  return {
    data: {
      currentStatus: {
        merchantId,
        currentPackageKey: subscription.packageKey,
        subscriptionStatus: subscription.status,
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
        graceEndsAt: subscription.graceEndsAt,
        renewalDate: subscription.currentPeriodEnd,
        annualPriceVnd,
        monthlyEquivalentVnd: monthlyEquivalent(annualPriceVnd),
        usage,
      },
      catalog: catalogEntries.map((entry) => ({
        packageKey: entry.packageKey,
        displayName: packageDisplayName(entry.packageKey),
        annualPriceVnd: entry.annualPrice.amountVnd,
        monthlyEquivalentVnd: monthlyEquivalent(entry.annualPrice.amountVnd),
        includedStores: entry.includedStores,
        features: entry.featureKeys,
      })),
      canUpgrade,
      canRenew,
    },
  };
}

export async function requestOwnerPackageUpgrade(
  merchantId: string,
  targetPackageKey: PackageKey,
  actor: SettingsActor,
  scope: MerchantTargetScope,
  idempotencyKey?: string,
): Promise<{ data: { billingOrderId: string; paymentUrl?: string } }> {
  ensureScope(scope, merchantId);
  if (!packageKeys.includes(targetPackageKey)) {
    throw new PlatformError("invalid_target_package", "Unsupported package key", 400, { targetPackageKey });
  }
  const subscription = await getMerchantSubscriptionStatus(merchantId);
  const requestedBy = actor.operatorId;
  const idempotency = idempotencyKey || `settings:${merchantId}:${targetPackageKey}:${requestedBy}:${new Date().toISOString().slice(0, 10)}`;
  let order;
  if (subscription.packageKey === "basic" && targetPackageKey !== "basic") {
    order = await initiateNewSubscription({
      merchantId,
      targetPackageKey: targetPackageKey as "plus" | "ai_fan",
      requestedBy,
      idempotencyKey: idempotency,
    });
  } else if (subscription.packageKey === "plus" && targetPackageKey === "ai_fan") {
    order = await initiateUpgrade({ merchantId, requestedBy, idempotencyKey: idempotency });
  } else if (subscription.packageKey === targetPackageKey && targetPackageKey !== "basic") {
    order = await initiateRenewal({ merchantId, requestedBy, idempotencyKey: idempotency });
  } else {
    throw new PlatformError("invalid_billing_transition", "Unsupported package transition", 409, {
      currentPackageKey: subscription.packageKey,
      targetPackageKey,
    });
  }

  await ensurePlatformSchema();
  await withConnectedTransaction(async (client) => {
    await recordAuditEntry(client, actor, "settings.package.billing_requested", "merchant_settings", merchantId, {
      merchantId,
      after: {
        billingOrderId: order.data.billingOrderId,
        targetPackageKey,
        currentPackageKey: subscription.packageKey,
      },
    });
  });

  return { data: { billingOrderId: order.data.billingOrderId } };
}

function env(name: string): string {
  return process.env[name]?.trim() || "";
}

function integrationStatus(enabled: boolean, reason?: string): Pick<IntegrationStatusDto, "status" | "healthSummary" | "requiredAction"> {
  if (enabled) return { status: "active", healthSummary: "Configured" };
  if (reason === "provider_disabled") return { status: "inactive", healthSummary: reason, requiredAction: "Enable provider" };
  return { status: "pending_config", healthSummary: reason || "Missing configuration", requiredAction: "Configure provider" };
}

function integrationConfigKey(row: Pick<OwnerIntegrationConfigRow, "provider_key" | "purpose" | "scope_type">): string {
  return `${row.scope_type}:${row.provider_key}:${row.purpose}`;
}

function ownerIntegrationFromConfig(
  row: OwnerIntegrationConfigRow,
  fallback?: IntegrationStatusDto,
): IntegrationStatusDto {
  const healthSummary = row.health_summary || (
    row.status === "active"
      ? "Configured by platform admin"
      : row.status === "inactive"
        ? "Configuration inactive"
        : "Configuration error"
  );
  const requiredAction = row.required_action || (
    row.status === "inactive"
      ? "Contact platform support to enable provider"
      : row.status === "error"
        ? "Contact platform support"
        : undefined
  );
  return {
    integrationId: row.id,
    providerKey: row.provider_key,
    purpose: row.purpose,
    // Platform billing is global configuration applied to this merchant's owner view.
    scope: row.scope_type === "store" ? "store" : "merchant",
    storeId: row.store_id || undefined,
    storeName: row.store_name || undefined,
    status: row.status,
    healthSummary,
    callbackUrl: row.callback_url || fallback?.callbackUrl,
    requiredAction,
    lastCheckedAt: iso(row.updated_at),
  };
}

export async function getOwnerIntegrations(merchantId: string, scope: MerchantTargetScope): Promise<{ data: IntegrationStatusDto[] }> {
  ensureScope(scope, merchantId);
  await ensurePlatformSchema();
  const availability = getPaymentProviderAvailability();
  const sepay = integrationStatus(availability.sepay_va.enabled, availability.sepay_va.reason);
  const nowpayments = integrationStatus(availability.nowpayments.enabled, availability.nowpayments.reason);
  const billingReady = Boolean(env("NOWPAYMENTS_BILLING_API_KEY") && env("NOWPAYMENTS_BILLING_IPN_CALLBACK_URL") && env("NOWPAYMENTS_BILLING_WALLET_READY").toLowerCase() === "true");
  const billing = integrationStatus(billingReady, billingReady ? undefined : "platform_billing_not_configured");

  return withConnectedClient(async (client) => {
    const configResult = await client.query<OwnerIntegrationConfigRow>(`
      SELECT ic.id, ic.provider_key, ic.purpose, ic.scope_type,
             ic.merchant_id, ic.store_id, s.display_name AS store_name,
             ic.status, ic.callback_url, ic.health_summary,
             ic.required_action, ic.updated_at
      FROM app.integration_configs ic
      LEFT JOIN app.stores s
        ON s.id = ic.store_id
       AND s.merchant_id = ic.merchant_id
      WHERE (ic.scope_type = 'platform' AND ic.purpose = 'platform_billing')
         OR (ic.scope_type = 'merchant'
             AND ic.purpose = 'merchant_retail'
             AND ic.merchant_id = $1)
         OR (ic.scope_type = 'store'
             AND ic.purpose = 'merchant_retail'
             AND ic.merchant_id = $1
             AND s.id IS NOT NULL)
      ORDER BY ic.scope_type, ic.provider_key, ic.purpose, s.display_name NULLS FIRST, ic.id
    `, [merchantId]);

    const telegramRows = await client.query<{
      id: string;
      status: string;
      default_store_id: string | null;
      store_name: string | null;
      last_heartbeat_at: Date | string | null;
    }>(`
      SELECT tbc.id, tbc.status, tbc.default_store_id, s.display_name AS store_name, tbc.last_heartbeat_at
      FROM app.telegram_bot_configs tbc
      LEFT JOIN app.stores s ON s.id = tbc.default_store_id
      WHERE tbc.merchant_id = $1
      ORDER BY tbc.created_at DESC
    `, [merchantId]).catch(() => ({ rows: [] }));

    const subscription = await getMerchantSubscriptionStatus(merchantId, { client });
    const telegramEntitled = subscription.packageKey === "ai_fan";
    const telegram: IntegrationStatusDto[] = telegramRows.rows.map((row) => ({
      integrationId: row.id,
      providerKey: "telegram",
      purpose: "telegram_runtime",
      scope: row.default_store_id ? "store" : "merchant",
      storeId: row.default_store_id || undefined,
      storeName: row.store_name || undefined,
      status: row.status === "active" ? "active" : "inactive",
      healthSummary: row.last_heartbeat_at ? "Heartbeat received" : "No heartbeat yet",
      lastCheckedAt: row.last_heartbeat_at ? iso(row.last_heartbeat_at) : undefined,
    }));
    if (telegram.length === 0) {
      telegram.push({
        integrationId: `telegram:${merchantId}`,
        providerKey: "telegram",
        purpose: "telegram_runtime",
        scope: "merchant",
        status: "pending_config",
        healthSummary: telegramEntitled ? "Runtime not configured" : "Not included in current package",
        requiredAction: telegramEntitled ? "Configure Telegram bot" : "Upgrade to AI Fan",
      });
    }

    const fallbackIntegrations: IntegrationStatusDto[] = [
      {
        integrationId: `sepay_va:${merchantId}`,
        providerKey: "sepay_va",
        purpose: "merchant_retail",
        scope: "merchant",
        callbackUrl: env("SEPAY_WEBHOOK_PUBLIC_URL") || env("SEPAY_WEBHOOK_URL") || undefined,
        ...sepay,
      },
      {
        integrationId: `nowpayments_retail:${merchantId}`,
        providerKey: "nowpayments",
        purpose: "merchant_retail",
        scope: "merchant",
        callbackUrl: env("NOWPAYMENTS_MERCHANT_RETAIL_IPN_CALLBACK_URL") || undefined,
        ...nowpayments,
      },
      {
        integrationId: `nowpayments_billing:${merchantId}`,
        providerKey: "nowpayments",
        purpose: "platform_billing",
        scope: "merchant",
        callbackUrl: env("NOWPAYMENTS_BILLING_IPN_CALLBACK_URL") || undefined,
        ...billing,
      },
    ];
    const configByKey = new Map(
      configResult.rows
        .filter((row) => row.scope_type !== "store")
        .map((row) => [integrationConfigKey(row), row] as const),
    );
    const consumedConfigIds = new Set<string>();
    const effectiveFallbacks = fallbackIntegrations.map((fallback) => {
      const targetScope = fallback.purpose === "platform_billing" ? "platform" : "merchant";
      const config = configByKey.get(`${targetScope}:${fallback.providerKey}:${fallback.purpose}`);
      if (!config) return fallback;
      consumedConfigIds.add(config.id);
      return ownerIntegrationFromConfig(config, fallback);
    });
    const additionalConfigs = configResult.rows
      .filter((row) => !consumedConfigIds.has(row.id))
      .map((row) => ownerIntegrationFromConfig(row));

    return {
      data: [
        ...effectiveFallbacks,
        ...additionalConfigs,
        ...telegram,
      ],
    };
  });
}

export async function listSettingsAudit(merchantId: string, scope: MerchantTargetScope): Promise<{ data: SettingsAuditEntryDto[] }> {
  ensureScope(scope, merchantId);
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const result = await client.query<{
      id: string;
      actor_id: string;
      actor_type: string;
      action: string;
      subject_type: string;
      subject_id: string;
      reason: string | null;
      created_at: Date | string;
    }>(`
      SELECT ae.id::text, ae.actor_id, ae.actor_type, ae.action, ae.subject_type, ae.subject_id, ae.reason, ae.created_at
      FROM audit.events ae
      LEFT JOIN app.stores s ON s.id = ae.subject_id
      WHERE ae.action LIKE 'settings.%'
        AND (
          ae.merchant_id = $1
          OR (ae.subject_type = 'merchant_settings' AND ae.subject_id = $1)
          OR s.merchant_id = $1
        )
      ORDER BY ae.created_at DESC
      LIMIT 100
    `, [merchantId]);
    return {
      data: result.rows.map((row) => ({
        id: row.id,
        actorId: row.actor_id,
        actorType: row.actor_type,
        action: row.action,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        reason: row.reason || undefined,
        createdAt: iso(row.created_at),
      })),
    };
  });
}
