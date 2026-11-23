/**
 * settings-endpoints.ts
 * Owner Settings & Platform Admin API contract layer.
 *
 * All money is VND integer as string (MoneyVnd contract).
 */

import { api,ApiError } from "./client";
import { PlatformMerchantDetailV1Schema,PlatformStoreDetailV1Schema,PlatformLifecycleCommandResultV1Schema, type PlatformLifecycleCommandV1 } from "@medusa-snus/contracts";
import type {
  CreatePlatformMerchantInput,
  CreatedPlatformMerchant,
  IntegrationConfigScope,
  PackageKey,
  PaymentProviderKey,
  ProviderConfigPurpose,
  SubscriptionStatus,
  UsageMetricKey,
  PlatformMerchantSummaryV1,PlatformStoreSummaryV1,PlatformLifecycleAuditPageV1,PlatformMerchantDetailV1,PlatformStoreDetailV1,
} from "@medusa-snus/contracts";

// ── Shared primitives ──────────────────────────────────────────────────────

export interface MoneyVndDto {
  currencyCode: "vnd";
  amountVnd: string; // integer as string, per contracts
}

export interface AddressDto {
  street?: string;
  ward?: string;
  district?: string;
  city?: string;
  country?: string;
  googleMapsUrl?: string;
}

export interface BusinessHoursDto {
  dayOfWeek: number; // 0=Sun..6=Sat
  openTime?: string; // "HH:MM"
  closeTime?: string;
  closed: boolean;
}

// ── /api/me ────────────────────────────────────────────────────────────────

export interface MeResponse {
  operatorId: string;
  displayName: string;
  role: string;
  isPlatformAdmin: boolean;
  canManageMerchantLifecycle?: boolean;
  permissionIds?: string[];
  permissionVersion?: string;
  historicalPermissionIds?: string[];
  historicalStores?: Array<{
    storeId: string;
    merchantId: string;
    merchantDisplayName: string;
    displayName: string;
    isPrimary: boolean;
    status: string;
    merchantStatus: string;
  }>;
  security?: {
    requiresPasswordChange: boolean;
    passwordChangedAt: string | null;
    globalStatus: "active" | "suspended";
    sessionVersion: number;
    forceLogoutAfter: string | null;
  };
  profile?: {
    email: string | null;
    phoneE164: string | null;
    locale: string | null;
    avatarUrl: string | null;
    telegramLinked: boolean;
  };
  impersonation?: {
    sessionId: string;
    mode: "read_only";
    actualOperatorId: string;
    effectiveOperatorId: string;
  };
  featureEntitlements?: string[];
  merchant: {
    merchantId: string;
    displayName: string;
    packageKey: PackageKey;
    subscriptionStatus: SubscriptionStatus;
  } | null;
  stores: Array<{
    storeId: string;
    merchantId: string;
    merchantDisplayName?: string;
    displayName: string;
    isPrimary: boolean;
  }>;
}

export async function fetchMe() {
  return api.get<MeResponse>("/api/me");
}

export interface UpdateOwnProfileInput {
  displayName?: string;
  email?: string | null;
  phoneE164?: string | null;
  locale?: string | null;
  metadata?: Record<string, unknown>;
}

export function updateOwnProfile(input: UpdateOwnProfileInput) {
  return api.patch<{ data: { operatorId: string; displayName: string; profile: MeResponse["profile"] } }>("/api/me", input);
}

export function changeOwnPassword(input: { currentPassword: string; newPassword: string }) {
  return api.post<{ data: { token: string } }>("/api/me/password/change", input);
}

export function completeRequiredPasswordChange(input: { newPassword: string }) {
  return api.post<{ data: { token: string } }>("/api/me/password/complete-required-change", input);
}

export function logoutAllSessions() {
  return api.post<{ data: { ok: true } }>("/api/me/logout-all", {});
}

export function createTelegramLinkToken() {
  return api.post<{ data: { token: string; expiresAt: string } }>("/api/me/telegram/link-token", {});
}

export function unlinkTelegramIdentity() {
  return api.post<{ data: { ok: true } }>("/api/me/telegram/unlink", {});
}

// ── /api/settings/merchant ─────────────────────────────────────────────────

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

export interface UpdateMerchantProfileInput {
  internalName?: string;
  publicName?: string;
  receiptName?: string;
  messageName?: string;
  email?: string;
  phone?: string;
  website?: string;
  address?: AddressDto;
}

export async function fetchMerchantProfile(merchantId: string) {
  return api.get<{ data: MerchantProfileDto }>(`/api/settings/merchant/${merchantId}`);
}

export async function updateMerchantProfile(merchantId: string, input: UpdateMerchantProfileInput) {
  return api.patch<{ data: MerchantProfileDto }>(`/api/settings/merchant/${merchantId}`, input);
}

// ── /api/settings/stores ───────────────────────────────────────────────────

export type BankTransferSettlementMode = "manual_confirmation" | "confirm_on_booking";

export interface StoreBankSettlementPolicyState {
  status: "ok";
  mode: BankTransferSettlementMode;
  version: number;
  source: "configured" | "default";
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface StoreBankSettlementPolicyInvalid {
  status: "invalid";
}

export type StoreBankSettlementPolicyDescriptor = StoreBankSettlementPolicyState | StoreBankSettlementPolicyInvalid;

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
  bankSettlementPolicy: StoreBankSettlementPolicyDescriptor;
}

export interface UpdateStoreProfileInput {
  internalName?: string;
  publicName?: string;
  receiptName?: string;
  messageName?: string;
  email?: string;
  phone?: string;
  address?: AddressDto;
  businessHours?: BusinessHoursDto[];
  googleMapsUrl?: string;
  facebookUrl?: string;
  instagramUrl?: string;
  bankTransferSettlement?: {
    mode: BankTransferSettlementMode;
    expectedVersion: number;
  };
}

export async function fetchStores(merchantId: string) {
  return api.get<{ data: StoreProfileDto[] }>(`/api/settings/merchant/${merchantId}/stores`);
}

export async function fetchStoreProfile(storeId: string) {
  return api.get<{ data: StoreProfileDto }>(`/api/settings/stores/${storeId}`);
}

export async function updateStoreProfile(storeId: string, input: UpdateStoreProfileInput) {
  return api.patch<{ data: StoreProfileDto }>(`/api/settings/stores/${storeId}`, input);
}

// ── /api/settings/team ────────────────────────────────────────────────────

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

export interface CreateTeamOperatorInput {
  operatorId: string;
  displayName: string;
  role: "staff" | "manager" | "accountant";
  scopeType: "merchant" | "store";
  storeId?: string | null;
  email?: string | null;
  phoneE164?: string | null;
}

export interface UpdateTeamOperatorProfileInput {
  displayName?: string;
  email?: string | null;
  phoneE164?: string | null;
}

export interface UpdateTeamMembershipInput {
  role?: "staff" | "manager" | "accountant";
  scopeType?: "merchant" | "store";
  storeId?: string | null;
}

export interface TeamAuditEventDto {
  id: string;
  action: string;
  actorId: string;
  reason: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface TeamPasswordResult {
  data: {
    membershipId: string;
    operatorId: string;
    temporaryPassword: string;
  };
}

export async function fetchTeamMembers(merchantId: string) {
  return api.get<{ data: TeamMemberDto[] }>(`/api/settings/merchant/${merchantId}/team`);
}

export function createTeamOperator(merchantId: string, input: CreateTeamOperatorInput) {
  return api.post<TeamPasswordResult>(`/api/settings/merchant/${merchantId}/team`, input);
}

export function resetTeamOperatorPassword(membershipId: string) {
  return api.post<TeamPasswordResult>(`/api/settings/team/${membershipId}/reset-password`, {});
}

export function disableTeamMembership(membershipId: string, input: { reason?: string }) {
  return api.post<{ data: { membershipId: string; status: "disabled" } }>(`/api/settings/team/${membershipId}/disable`, input);
}

export function enableTeamMembership(membershipId: string) {
  return api.post<{ data: { membershipId: string; status: "active" } }>(`/api/settings/team/${membershipId}/enable`, {});
}

export function updateTeamOperatorProfile(membershipId: string, input: UpdateTeamOperatorProfileInput) {
  return api.patch<{ data: { membershipId: string; operatorId: string; displayName: string; email: string | null; phoneE164: string | null } }>(
    `/api/settings/team/${membershipId}/profile`,
    input,
  );
}

export function updateTeamMembership(membershipId: string, input: UpdateTeamMembershipInput) {
  return api.patch<{ data: { membershipId: string; operatorId: string; role: string; scopeType: string; storeId: string | null } }>(
    `/api/settings/team/${membershipId}/membership`,
    input,
  );
}

export function fetchTeamOperatorAudit(membershipId: string) {
  return api.get<{ data: TeamAuditEventDto[] }>(`/api/settings/team/${membershipId}/audit`);
}

// ── /api/settings/package ─────────────────────────────────────────────────

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

export async function fetchPackagePage(merchantId: string) {
  return api.get<{ data: PackagePageDto }>(`/api/settings/merchant/${merchantId}/package`);
}

export async function requestPackageUpgrade(merchantId: string, targetPackageKey: PackageKey) {
  return api.post<{ data: { billingOrderId: string; paymentUrl?: string } }>(
    `/api/settings/merchant/${merchantId}/package/upgrade`,
    { targetPackageKey },
  );
}

// ── /api/settings/integrations ─────────────────────────────────────────────

/** Owner view — never includes secrets or masked secrets */
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

export async function fetchOwnerIntegrations(merchantId: string) {
  return api.get<{ data: IntegrationStatusDto[] }>(`/api/settings/merchant/${merchantId}/integrations`);
}

// ── /api/settings/telegram-notifications ───────────────────────────────────

export type TelegramRecipientKind = "owner" | "manager" | "sales_staff" | "ops" | "custom";
export type TelegramRecipientStatus = "active" | "disabled";

export interface TelegramNotificationRecipientDto {
  id: string;
  merchantId: string;
  storeId: string | null;
  storeName: string | null;
  telegramUserId: string;
  telegramChatId: string | null;
  telegramUsername: string | null;
  linkedOperatorId: string | null;
  displayName: string;
  recipientKind: TelegramRecipientKind;
  status: TelegramRecipientStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramNotificationRuleDto {
  id: string;
  merchantId: string;
  storeId: string | null;
  storeName: string | null;
  recipientId: string;
  recipientDisplayName: string;
  name: string;
  enabled: boolean;
  eventScope: string;
  channelFilter: string;
  eventTypes: string[];
  templateProfile: string;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramNotificationSettingsDto {
  recipients: TelegramNotificationRecipientDto[];
  rules: TelegramNotificationRuleDto[];
}

export interface CreateTelegramNotificationRecipientInput {
  storeId?: string | null;
  telegramUserId: string;
  telegramChatId?: string | null;
  telegramUsername?: string | null;
  linkedOperatorId?: string | null;
  displayName: string;
  recipientKind: TelegramRecipientKind;
  status?: TelegramRecipientStatus;
}

export type UpdateTelegramNotificationRecipientInput = Partial<CreateTelegramNotificationRecipientInput>;

export interface CreateTelegramNotificationRuleInput {
  storeId?: string | null;
  recipientId: string;
  name: string;
  enabled?: boolean;
  eventScope: string;
  channelFilter?: string;
  eventTypes?: string[];
  templateProfile?: string;
}

export type UpdateTelegramNotificationRuleInput = Partial<CreateTelegramNotificationRuleInput>;

export async function fetchTelegramNotificationSettings(merchantId: string) {
  return api.get<{ data: TelegramNotificationSettingsDto }>(`/api/settings/merchant/${merchantId}/telegram-notifications`);
}

export function createTelegramNotificationRecipient(merchantId: string, input: CreateTelegramNotificationRecipientInput) {
  return api.post<{ data: TelegramNotificationRecipientDto }>(
    `/api/settings/merchant/${merchantId}/telegram-notifications/recipients`,
    input,
  );
}

export function updateTelegramNotificationRecipient(
  merchantId: string,
  recipientId: string,
  input: UpdateTelegramNotificationRecipientInput,
) {
  return api.patch<{ data: TelegramNotificationRecipientDto }>(
    `/api/settings/merchant/${merchantId}/telegram-notifications/recipients/${recipientId}`,
    input,
  );
}

export function sendTelegramNotificationRecipientTest(merchantId: string, recipientId: string) {
  return api.post<{ data: { queued: true; recipientId: string } }>(
    `/api/settings/merchant/${merchantId}/telegram-notifications/recipients/${recipientId}/test`,
    {},
  );
}

export function createTelegramNotificationRule(merchantId: string, input: CreateTelegramNotificationRuleInput) {
  return api.post<{ data: TelegramNotificationRuleDto }>(
    `/api/settings/merchant/${merchantId}/telegram-notifications/rules`,
    input,
  );
}

export function updateTelegramNotificationRule(
  merchantId: string,
  ruleId: string,
  input: UpdateTelegramNotificationRuleInput,
) {
  return api.patch<{ data: TelegramNotificationRuleDto }>(
    `/api/settings/merchant/${merchantId}/telegram-notifications/rules/${ruleId}`,
    input,
  );
}

// ── /api/settings/audit ───────────────────────────────────────────────────

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

export async function fetchSettingsAudit(merchantId: string) {
  return api.get<{ data: SettingsAuditEntryDto[] }>(`/api/settings/merchant/${merchantId}/audit`);
}

// ── /api/platform/* (platform admin only) ─────────────────────────────────

export type PlatformMerchantSummaryDto=PlatformMerchantSummaryV1;

export type PlatformEntityStatus="active"|"suspended"|"closed";
export type PlatformEntityStatusFilter=PlatformEntityStatus|"all";
export async function fetchPlatformMerchants(status:PlatformEntityStatusFilter="active") {
  return api.get<{ data: PlatformMerchantSummaryDto[] }>(`/api/platform/admin/merchants?status=${status}`);
}

export function createPlatformMerchant(input: CreatePlatformMerchantInput, idempotencyKey: string) {
  return api.post<{ data: CreatedPlatformMerchant }>("/api/platform/admin/merchants", input, idempotencyKey);
}

export function fetchMerchantCheckoutPolicy(merchantId: string) {
  return api.get<{ data: import("@medusa-snus/contracts").FoundStockCheckoutPolicy }>(
    `/api/platform/admin/merchants/${encodeURIComponent(merchantId)}/checkout-policy`);
}

export function updateMerchantCheckoutPolicy(merchantId: string, enabled: boolean, expectedVersion: number) {
  return api.patch<{ data: import("@medusa-snus/contracts").FoundStockCheckoutPolicy }>(
    `/api/platform/admin/merchants/${encodeURIComponent(merchantId)}/checkout-policy`, { enabled, expectedVersion });
}

export type PlatformStoreSummaryDto=PlatformStoreSummaryV1;

export async function fetchPlatformStores(merchantId?: string,status:PlatformEntityStatusFilter="active") {
  const qs = `?status=${status}${merchantId?`&merchantId=${encodeURIComponent(merchantId)}`:""}`;
  return api.get<{ data: PlatformStoreSummaryDto[] }>(`/api/platform/admin/stores${qs}`);
}

export type PlatformLifecycleAuditDto=PlatformLifecycleAuditPageV1;
export type PlatformMerchantDetailDto=PlatformMerchantDetailV1;
export type PlatformStoreDetailDto=PlatformStoreDetailV1;
export async function changePlatformEntityStatus(kind:"merchant"|"store",id:string,input:PlatformLifecycleCommandV1,idempotencyKey:string){
  const response=await api.post<{data:unknown}>(`/api/platform/admin/${kind === "merchant" ? "merchants" : "stores"}/${encodeURIComponent(id)}/status`,input,idempotencyKey);
  const parsed=PlatformLifecycleCommandResultV1Schema.safeParse(response?.data);
  if(!parsed.success)throw new ApiError("Kết quả chưa tương thích; kiểm tra lại trạng thái trước khi thử tiếp.",502,"platform_lifecycle_contract_unavailable");
  return{data:parsed.data};
}
export async function fetchPlatformMerchantDetail(id:string,auditOffset=0){
  const response=await api.get<{data:unknown}>(`/api/platform/admin/merchants/${encodeURIComponent(id)}?auditOffset=${auditOffset}`);
  const parsed=PlatformMerchantDetailV1Schema.safeParse(response?.data);
  if(!parsed.success)throw new ApiError("Chi tiết merchant chưa tương thích; tải lại sau khi cập nhật hệ thống.",502,"platform_detail_contract_unavailable");
  return{data:parsed.data};
}
export async function fetchPlatformStoreDetail(id:string,auditOffset=0){
  const response=await api.get<{data:unknown}>(`/api/platform/admin/stores/${encodeURIComponent(id)}?auditOffset=${auditOffset}`);
  const parsed=PlatformStoreDetailV1Schema.safeParse(response?.data);
  if(!parsed.success)throw new ApiError("Chi tiết cửa hàng chưa tương thích; tải lại sau khi cập nhật hệ thống.",502,"platform_detail_contract_unavailable");
  return{data:parsed.data};
}

export interface CreatePlatformStoreInput {
  merchantId: string;
  displayName: string;
  stockLocationName?: string;
  isPrimary?: boolean;
}

export async function createPlatformStore(input: CreatePlatformStoreInput) {
  return api.post<{ data: PlatformStoreSummaryDto }>("/api/platform/admin/stores", input);
}

export interface PlatformMembershipDto {
  membershipId: string;
  operatorId: string;
  displayName?: string;
  scopeType: "platform" | "merchant" | "store";
  merchantId?: string;
  merchantName?: string;
  storeId?: string;
  storeName?: string;
  roleKey: string;
  status: "active" | "disabled" | "pending" | "revoked";
  effectiveStatus: "active" | "disabled" | "pending" | "revoked" | "scheduled" | "expired";
  validFrom: string;
  validTo: string | null;
  grantedBy: string;
  createdAt: string;
}

export interface PlatformMembershipInput {
  operatorId: string;
  scopeType: "platform" | "merchant" | "store";
  merchantId?: string;
  storeId?: string;
  roleKey: string;
  validFrom?: string;
  validTo?: string | null;
}

export async function fetchPlatformMemberships() {
  return api.get<{ data: PlatformMembershipDto[] }>("/api/platform/admin/memberships");
}

export async function grantPlatformMembership(input: PlatformMembershipInput) {
  return api.post<{ data: PlatformMembershipDto }>("/api/platform/admin/memberships", input);
}

export async function revokePlatformMembership(membershipId: string, input: { reason: string }) {
  return api.post<{ data: { membershipId: string; status: "revoked" } }>(
    `/api/platform/admin/memberships/${encodeURIComponent(membershipId)}/revoke`,
    input,
  );
}

export interface PlatformOperatorDto {
  operatorId: string;
  displayName: string;
  role: string;
  organizationId: string;
  isActive: boolean;
  lastLoginAt: string | null;
  email: string | null;
  phoneE164: string | null;
  requiresPasswordChange: boolean;
  globalStatus: "active" | "suspended";
  sessionVersion: number;
  memberships: Array<{
    membershipId: string;
    scopeType: "platform" | "merchant" | "store";
    merchantId: string | null;
    storeId: string | null;
    roleKey: string;
    status: string;
  }>;
  explicitGrants: Array<{
    grantId: string;
    permissionId: string;
    scopeType: "platform" | "merchant" | "store";
    merchantId: string | null;
    storeId: string | null;
    status: string;
    validFrom: string;
    validTo: string | null;
  }>;
}

export function fetchPlatformOperators() {
  return api.get<{ data: PlatformOperatorDto[] }>("/api/platform/admin/operators");
}

export function resetPlatformOperatorPassword(operatorId: string, input: { reason?: string }) {
  return api.post<{ data: { operatorId: string; temporaryPassword: string } }>(
    `/api/platform/admin/operators/${encodeURIComponent(operatorId)}/reset-password`,
    input,
  );
}

export function suspendPlatformOperator(operatorId: string, input: { reason?: string }) {
  return api.post<{ data: { operatorId: string; globalStatus: PlatformOperatorDto["globalStatus"] } }>(
    `/api/platform/admin/operators/${encodeURIComponent(operatorId)}/suspend`,
    input,
  );
}

export function unsuspendPlatformOperator(operatorId: string, input: { reason?: string }) {
  return api.post<{ data: { operatorId: string; globalStatus: PlatformOperatorDto["globalStatus"] } }>(
    `/api/platform/admin/operators/${encodeURIComponent(operatorId)}/unsuspend`,
    input,
  );
}

export function grantPlatformOperatorPermission(operatorId: string, input: { permissionId: string; reason?: string }) {
  return api.post<{ data: { grantId: string; operatorId: string; permissionId: string } }>(
    `/api/platform/admin/operators/${encodeURIComponent(operatorId)}/grants`,
    input,
  );
}

export function revokePlatformOperatorPermission(grantId: string, input: { reason?: string }) {
  return api.post<{ data: { grantId: string; operatorId: string; permissionId: string; status: "revoked" } }>(
    `/api/platform/admin/operator-grants/${encodeURIComponent(grantId)}/revoke`,
    input,
  );
}

export function startPlatformImpersonation(input: { targetOperatorId: string; reason: string; ticketRef?: string; durationMinutes?: number }) {
  return api.post<{ data: { token: string; sessionId: string; mode: "read_only"; actualOperatorId: string; effectiveOperatorId: string; reason: string; ticketRef: string | null; expiresAt: string } }>(
    "/api/platform/admin/impersonation/start",
    input,
  );
}

export function endPlatformImpersonation(input: { sessionId?: string; reason?: string } = {}) {
  return api.post<{ data: { sessionId: string; ended: true } }>("/api/platform/admin/impersonation/end", input);
}

export interface PlatformBillingOrderDto {
  billingOrderId: string;
  merchantId: string;
  merchantName: string;
  purpose: string;
  targetPackageKey?: PackageKey;
  amountVnd: string;
  status: string;
  createdAt: string;
  appliedAt?: string;
}

export async function fetchPlatformBillingOrders() {
  return api.get<{ data: PlatformBillingOrderDto[] }>("/api/platform/admin/billing-orders");
}

/** Platform provider config list — never returns raw secrets */
export interface PlatformIntegrationDto {
  configId: string;
  providerKey: PaymentProviderKey;
  purpose: ProviderConfigPurpose;
  scope: IntegrationConfigScope;
  merchantId?: string;
  merchantName?: string;
  storeId?: string;
  storeName?: string;
  status: "active" | "inactive" | "error";
  hasSecret: boolean; // only signals presence, never value
  lastRotatedAt?: string;
  callbackUrl?: string;
  healthSummary?: string;
  requiredAction?: string;
  createdAt: string;
  updatedAt: string;
}

export async function fetchPlatformIntegrations() {
  return api.get<{ data: PlatformIntegrationDto[] }>("/api/platform/admin/integrations");
}

/** Write-only provider config mutations */
export type ProviderAction = "set" | "replace" | "rotate" | "disable";

type ProviderConfigSecretCommand =
  | { action: Exclude<ProviderAction, "disable">; secret: string }
  | { action: "disable"; secret?: never };

type ProviderConfigTarget = {
  providerKey: PaymentProviderKey;
} & (
  | { purpose: "platform_billing" | "platform_subscription"; scope: "platform"; merchantId?: never; storeId?: never }
  | { purpose: "merchant_retail" | "retail_order"; scope: "merchant"; merchantId: string; storeId?: never }
  | { purpose: "merchant_retail" | "retail_order"; scope: "store"; merchantId: string; storeId: string }
);

export type SetProviderConfigInput = ProviderConfigTarget & ProviderConfigSecretCommand;

export async function mutateProviderConfig(input: SetProviderConfigInput) {
  return api.post<{ data: { configId: string; status: string } }>(
    "/api/platform/admin/integrations/config",
    input,
  );
}

export interface PlatformPaymentExceptionDto {
  exceptionId: string;
  billingOrderId?: string;
  providerKey: string;
  providerRef: string;
  amountVnd?: string;
  issue: string;
  status: "pending_review" | "resolved" | "waived";
  createdAt: string;
  resolvedAt?: string;
}

export async function fetchPaymentExceptions() {
  return api.get<{ data: PlatformPaymentExceptionDto[] }>("/api/platform/admin/payment-exceptions");
}

export interface SignupIdentityDto {
  identityId: string;
  email: string;
  status: "pending_verification" | "verified" | "suspended";
  merchantId?: string;
  merchantName?: string;
  createdAt: string;
  verifiedAt?: string;
}

export async function fetchSignupIdentities() {
  return api.get<{ data: SignupIdentityDto[] }>("/api/platform/admin/signup-identities");
}

export async function fetchPlatformAudit() {
  return api.get<{ data: SettingsAuditEntryDto[] }>("/api/platform/admin/audit");
}
