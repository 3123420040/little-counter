import { z } from "zod";
import { PaymentFeeInputV1Schema, parseOptionalPaymentFeeInputV1 } from "./order-payment-fee";
import { CartPaymentFeePreviewInputV1Schema, CartPaymentFeeConfirmationTokenV1Schema } from "./cart-payment-fee-preview";
export * from "./platform-merchant";
export * from "./platform-entity";
export * from "./platform-mcp";

/* ═══════════════════════════════════════════════════════
   @medusa-snus/contracts — Shared Zod schemas & types
   Single source of truth for all modules
   ═══════════════════════════════════════════════════════ */

// ── Enums ──────────────────────────────────────────────

export const paymentMethods = ["cash", "bank_transfer", "cod", "sepay_va", "nowpayments"] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

export const salesChannels = ["pos_counter", "whatsapp", "zalo", "instagram", "telegram", "website", "stash_dash"] as const;
export type SalesChannel = (typeof salesChannels)[number];

/**
 * Store-scoped bank-transfer settlement policy (2.1).
 *
 * `manual_confirmation`: checkout records the bank charge as pending; a
 * separately authorized later confirmation posts it (existing flow).
 * `confirm_on_booking`: an authenticated staff checkout click is an explicit
 * receipt acknowledgment and the initial charge is posted atomically with the
 * order. Server-resolved only; never trusted from a checkout payload.
 */
export const bankTransferSettlementModes = ["manual_confirmation", "confirm_on_booking"] as const;
export type BankTransferSettlementMode = (typeof bankTransferSettlementModes)[number];

/** Version of the checkout acknowledgment marker contract. */
export const BANK_TRANSFER_SETTLEMENT_ACKNOWLEDGMENT_VERSION = 1;

/** Metadata namespace used inside app.stores.metadata for the policy value. */
export const STORE_BANK_SETTLEMENT_POLICY_METADATA_KEY = "bankTransferSettlementPolicy";

export interface StoreBankSettlementPolicyValue {
  mode: BankTransferSettlementMode;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

/** Response of the scoped POS checkout-policy read endpoint. */
export interface CheckoutBankSettlementPolicyResponse {
  foundStockCheckout?: FoundStockCheckoutPolicy;
  manualConfirmationEnabled: boolean;
  merchantId: string;
  storeId: string;
  mode: BankTransferSettlementMode;
  policyVersion: number;
  acknowledgmentVersion: number;
  source: "configured" | "default";
}

export interface FoundStockCheckoutPolicy {
  status: "ok" | "invalid";
  enabled: boolean;
  version: number;
  source: "configured" | "default";
  updatedAt: string | null;
  updatedBy: string | null;
}

export const merchantCheckoutPolicyUpdateSchema = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const actorTypes = ["staff", "manager", "accountant", "owner", "system", "ai"] as const;
export type ActorType = (typeof actorTypes)[number];

export const riskLevels = ["low", "medium", "high", "blocked"] as const;
export type RiskLevel = (typeof riskLevels)[number];

export const loyaltyTierNames = ["bronze", "silver", "gold", "platinum"] as const;
export type LoyaltyTierName = (typeof loyaltyTierNames)[number];

export const stockMovementTypes = [
  "sale", "purchase_receipt", "manual_adjustment",
  "transfer_in", "transfer_out", "return", "damage"
] as const;
export type StockMovementType = (typeof stockMovementTypes)[number];

export const purchaseOrderStatuses = [
  "draft", "sent", "partially_received", "received", "cancelled", "closed_short"
] as const;
export type PurchaseOrderStatus = (typeof purchaseOrderStatuses)[number];

export const journalEntryStatuses = ["draft", "posted", "voided"] as const;
export type JournalEntryStatus = (typeof journalEntryStatuses)[number];

export const accountTypes = ["asset", "liability", "equity", "revenue", "expense"] as const;
export type AccountType = (typeof accountTypes)[number];

export const aiActionTypes = ["reply_draft", "inventory_alert", "loyalty_recommendation"] as const;
export type AiActionType = (typeof aiActionTypes)[number];

export const aiActionStatuses = [
  "pending", "completed", "failed", "review_required",
  "approved", "rejected", "acknowledged"
] as const;
export type AiActionStatus = (typeof aiActionStatuses)[number];

// ── 1.1.2 Frozen Scope, Access, Package, Money And Provider Contracts ──

const IdSchema = z.string().min(1);
const IsoDateTimeSchema = z.string().datetime();
const DateOrDateTimeSchema = z.union([z.string().date(), IsoDateTimeSchema]);
const IntegerStringSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const DecimalStringSchema = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);

export const merchantRoleKeys = ["staff", "manager", "accountant", "owner"] as const;
export type MerchantRoleKey = (typeof merchantRoleKeys)[number];

export const membershipScopeTypes = ["platform", "merchant", "store"] as const;
export type MembershipScopeType = (typeof membershipScopeTypes)[number];

export const membershipStatuses = ["active", "disabled", "pending", "revoked"] as const;
export type MembershipStatus = (typeof membershipStatuses)[number];

export const platformRoleKeys = ["platform_admin", "platform_readonly"] as const;
export type PlatformRoleKey = (typeof platformRoleKeys)[number];

export const permissionIds = [
  "inventory:read",
  "orders:read",
  "reports:read",
  "remote_order:create",
  "order:cancel",
  "order:refund",
  "order:correct",
  "accounting:read",
  "ai:review",
  "payment_intent:create",
  "payment_intent:read",
  "payment_intent:resolve",
  "recommendation:read",
  "product_research:run",
  "product_research:read",
  "telegram_ai_order:create",
  "subscription:read",
  "subscription:bill",
  "subscription:apply",
  "integration_config:read",
  "integration_config:write",
  "platform:read",
  "catalog:write",
  "customer:write",
  "loyalty:write",
  "accounting:write",
  "order:write",
  "inventory:write",
  "catalog:read",
  "customer:read",
  "loyalty:read",
  "settings:read",
  "settings:write",
  "platform:write",
  "orders:export",
  "scan_go:redeem",
  "vision_scan:use",
  "vision_scan:read",
  "vision_catalog:write",
  "vision_debug_image:enable",
  "profile:read",
  "profile:write",
  "profile:password_write",
  "profile:telegram_write",
  "team:read",
  "team:write",
  "team:reset_password",
  "platform_operator:read",
  "platform_operator:reset_password",
  "platform_operator:suspend",
  "platform_membership:write",
  "platform_impersonation:start",
  "shift:open",
  "shift:close",
  "shift:read",
  "shift:cash_adjust",
  "shift:review",
  "shift:manage",
  "shift:report",
  "partner:manage",
  "partner:contact_read",
  "partner:logs_read",
  "partner:security_read",
  "category:read",
  "order:cancel_own",
  "dashboard:self:read",
] as const;
export type PermissionId = (typeof permissionIds)[number];

/**
 * Permission identifiers used by route and service authorization. Consumers
 * should import these constants instead of introducing new string literals.
 */
export const permissions = {
  inventoryRead: permissionIds[0],
  ordersRead: permissionIds[1],
  reportsRead: permissionIds[2],
  remoteOrderCreate: permissionIds[3],
  orderCancel: permissionIds[4],
  orderRefund: permissionIds[5],
  orderCorrect: permissionIds[6],
  accountingRead: permissionIds[7],
  aiReview: permissionIds[8],
  paymentIntentCreate: permissionIds[9],
  paymentIntentRead: permissionIds[10],
  paymentIntentResolve: permissionIds[11],
  recommendationRead: permissionIds[12],
  productResearchRun: permissionIds[13],
  productResearchRead: permissionIds[14],
  telegramAiOrderCreate: permissionIds[15],
  subscriptionRead: permissionIds[16],
  subscriptionBill: permissionIds[17],
  subscriptionApply: permissionIds[18],
  integrationConfigRead: permissionIds[19],
  integrationConfigWrite: permissionIds[20],
  platformRead: permissionIds[21],
  catalogWrite: permissionIds[22],
  customerWrite: permissionIds[23],
  loyaltyWrite: permissionIds[24],
  accountingWrite: permissionIds[25],
  orderWrite: permissionIds[26],
  inventoryWrite: permissionIds[27],
  catalogRead: permissionIds[28],
  customerRead: permissionIds[29],
  loyaltyRead: permissionIds[30],
  settingsRead: permissionIds[31],
  settingsWrite: permissionIds[32],
  platformWrite: permissionIds[33],
  ordersExport: permissionIds[34],
  scanGoRedeem: permissionIds[35],
  visionScanUse: permissionIds[36],
  visionScanRead: permissionIds[37],
  visionCatalogWrite: permissionIds[38],
  visionDebugImageEnable: permissionIds[39],
  profileRead: permissionIds[40],
  profileWrite: permissionIds[41],
  profilePasswordWrite: permissionIds[42],
  profileTelegramWrite: permissionIds[43],
  teamRead: permissionIds[44],
  teamWrite: permissionIds[45],
  teamResetPassword: permissionIds[46],
  platformOperatorRead: permissionIds[47],
  platformOperatorResetPassword: permissionIds[48],
  platformOperatorSuspend: permissionIds[49],
  platformMembershipWrite: permissionIds[50],
  platformImpersonationStart: permissionIds[51],
  shiftOpen: "shift:open",
  shiftClose: "shift:close",
  shiftRead: "shift:read",
  shiftCashAdjust: "shift:cash_adjust",
  shiftReview: "shift:review",
  shiftManage: "shift:manage",
  shiftReport: "shift:report",
  partnerManage: "partner:manage",
  partnerContactRead: "partner:contact_read",
  partnerLogsRead: "partner:logs_read",
  partnerSecurityRead: "partner:security_read",
  categoryRead: "category:read",
  orderCancelOwn: "order:cancel_own",
  dashboardSelfRead: "dashboard:self:read",
} as const satisfies Record<string, PermissionId>;

/**
 * Compatibility defaults for the existing Basic POS roles. These are grants,
 * not role-order authorization: a route must request its own permission.
 */
export const defaultRolePermissionIds = {
  staff: [
    permissions.orderCancelOwn,
    permissions.dashboardSelfRead,
    permissions.categoryRead,
    permissions.partnerContactRead,
    permissions.inventoryRead,
    permissions.ordersRead,
    permissions.remoteOrderCreate,
    permissions.paymentIntentCreate,
    permissions.paymentIntentRead,
    permissions.recommendationRead,
    permissions.productResearchRead,
    permissions.catalogRead,
    permissions.customerRead,
    permissions.customerWrite,
    permissions.scanGoRedeem,
    permissions.visionScanUse,
    permissions.profileRead,
    permissions.profileWrite,
    permissions.profilePasswordWrite,
    permissions.profileTelegramWrite,
    permissions.shiftOpen,
    permissions.shiftClose,
    permissions.shiftRead,
    permissions.shiftCashAdjust,
  ],
  manager: [
    permissions.categoryRead,
    permissions.partnerLogsRead,
    permissions.partnerContactRead,
    permissions.inventoryRead,
    permissions.ordersRead,
    permissions.reportsRead,
    permissions.remoteOrderCreate,
    permissions.orderCancel,
    permissions.orderCorrect,
    permissions.accountingRead,
    permissions.aiReview,
    permissions.paymentIntentCreate,
    permissions.paymentIntentRead,
    permissions.paymentIntentResolve,
    permissions.recommendationRead,
    permissions.productResearchRun,
    permissions.productResearchRead,
    permissions.telegramAiOrderCreate,
    permissions.catalogWrite,
    permissions.customerWrite,
    permissions.loyaltyWrite,
    permissions.orderWrite,
    permissions.inventoryWrite,
    permissions.catalogRead,
    permissions.customerRead,
    permissions.loyaltyRead,
    permissions.ordersExport,
    permissions.scanGoRedeem,
    permissions.visionScanUse,
    permissions.visionScanRead,
    permissions.visionCatalogWrite,
    permissions.profileRead,
    permissions.profileWrite,
    permissions.profilePasswordWrite,
    permissions.profileTelegramWrite,
    permissions.teamRead,
    permissions.teamWrite,
    permissions.teamResetPassword,
    permissions.shiftOpen,
    permissions.shiftClose,
    permissions.shiftRead,
    permissions.shiftCashAdjust,
    permissions.shiftReview,
    permissions.shiftManage,
    permissions.shiftReport,
  ],
  accountant: [
    permissions.categoryRead,
    permissions.customerRead,
    permissions.customerWrite,
    permissions.accountingRead,
    permissions.accountingWrite,
    permissions.reportsRead,
    permissions.ordersExport,
    permissions.profileRead,
    permissions.profileWrite,
    permissions.profilePasswordWrite,
    permissions.profileTelegramWrite,
  ],
  owner: [
    permissions.categoryRead,
    permissions.partnerLogsRead,
    permissions.partnerSecurityRead,
    permissions.partnerContactRead,
    permissions.partnerManage,
    permissions.inventoryRead,
    permissions.ordersRead,
    permissions.reportsRead,
    permissions.remoteOrderCreate,
    permissions.orderCancel,
    permissions.orderRefund,
    permissions.orderCorrect,
    permissions.accountingRead,
    permissions.aiReview,
    permissions.paymentIntentCreate,
    permissions.paymentIntentRead,
    permissions.paymentIntentResolve,
    permissions.recommendationRead,
    permissions.productResearchRun,
    permissions.productResearchRead,
    permissions.telegramAiOrderCreate,
    permissions.catalogWrite,
    permissions.customerWrite,
    permissions.loyaltyWrite,
    permissions.accountingWrite,
    permissions.orderWrite,
    permissions.inventoryWrite,
    permissions.subscriptionRead,
    permissions.subscriptionBill,
    permissions.integrationConfigRead,
    permissions.settingsRead,
    permissions.settingsWrite,
    permissions.catalogRead,
    permissions.customerRead,
    permissions.loyaltyRead,
    permissions.ordersExport,
    permissions.scanGoRedeem,
    permissions.visionScanUse,
    permissions.visionScanRead,
    permissions.visionCatalogWrite,
    permissions.visionDebugImageEnable,
    permissions.profileRead,
    permissions.profileWrite,
    permissions.profilePasswordWrite,
    permissions.profileTelegramWrite,
    permissions.teamRead,
    permissions.teamWrite,
    permissions.teamResetPassword,
    permissions.shiftOpen,
    permissions.shiftClose,
    permissions.shiftRead,
    permissions.shiftCashAdjust,
    permissions.shiftReview,
    permissions.shiftManage,
    permissions.shiftReport,
  ],
} as const satisfies Record<MerchantRoleKey, readonly PermissionId[]>;

export const PackageKeySchema = z.enum(["basic", "plus", "ai_fan"]);
export type PackageKey = z.infer<typeof PackageKeySchema>;

export const packageKeys = PackageKeySchema.options;

export const packageFeatureKeys = [
  "partner_api",
  "pos_core",
  "accounting_core",
  "telegram_runtime",
  "sepay_qr_payment",
  "crypto_payment",
  "smart_cross_sell",
  "product_research",
  "customer_scan_go",
  "telegram_ai_ordering",
  "telegram_sales_channel",
  "vision_pos_input",
  "vision_pos_single_capture",
  "vision_pos_bulk_capture",
  "vision_debug_image_storage",
  "vision_correction_report",
] as const;
export type PackageFeatureKey = (typeof packageFeatureKeys)[number];

export const subscriptionStatuses = ["active", "grace", "expired"] as const;
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

export const billingOrderPurposes = ["new_subscription", "renewal", "upgrade", "store_addon"] as const;
export type BillingOrderPurpose = (typeof billingOrderPurposes)[number];

export const billingOrderStatuses = [
  "draft",
  "waiting_payment",
  "paid",
  "applied",
  "expired",
  "cancelled",
  "manual_review",
  "failed",
] as const;
export type BillingOrderStatus = (typeof billingOrderStatuses)[number];

export const usageMetricKeys = [
  "product_research_runs",
  "telegram_ai_drafts",
  "provider_credits",
  "llm_tokens",
] as const;
export type UsageMetricKey = (typeof usageMetricKeys)[number];

export const integrationConfigScopes = ["platform", "merchant", "store"] as const;
export type IntegrationConfigScope = (typeof integrationConfigScopes)[number];

export const providerConfigPurposes = ["platform_billing", "merchant_retail"] as const;
export type ProviderConfigPurpose = (typeof providerConfigPurposes)[number];

export const paymentBusinessPurposes = ["platform_subscription", "retail_order"] as const;
export type PaymentBusinessPurpose = (typeof paymentBusinessPurposes)[number];

export const paymentProviderKeys = ["mock", "sepay_va", "nowpayments"] as const;
export type PaymentProviderKey = (typeof paymentProviderKeys)[number];

export const retailCryptoAssets = ["USDTTRC20", "USDCMATIC"] as const;
export type RetailCryptoAsset = (typeof retailCryptoAssets)[number];

export const subscriptionPolicyVersion = "1.1.2-annual-v1" as const;
export const packageCatalogVersion = "1.1.2-annual-v1" as const;

export const vndPackagePrices = {
  basic: "0",
  plus: "3588000",
  ai_fan: "7188000",
  extra_store: "1188000",
} as const;

export const subscriptionPolicySnapshot = {
  policyVersion: subscriptionPolicyVersion,
  billingTerm: "annual",
  graceDays: 7,
  refundPolicy: "no_refund",
  voluntaryDowngradePolicy: "not_allowed",
  roundingMode: "ceil_to_1000_vnd",
} as const;

// ── Subscription lifecycle notification contracts ─────
// These describe the notification layer that turns subscription lifecycle events
// (app.subscription_events) into owner-visible transactional notifications
// delivered through the provider-neutral email adapter. The
// notification layer NEVER owns subscription state, billing or email delivery
// internals — it only maps events to notifications and records delivery state.

export const subscriptionLifecycleNotificationTypes = [
  "renewal_reminder",
  "grace_started",
  "grace_ending",
  "expired_basic_fallback",
  "renewal_applied",
  "upgrade_applied",
] as const;
export type SubscriptionLifecycleNotificationType =
  (typeof subscriptionLifecycleNotificationTypes)[number];

export const lifecycleNotificationTemplateKeys = [
  "subscription.renewal_reminder",
  "subscription.entered_grace",
  "subscription.grace_ending",
  "subscription.expired",
  "subscription.renewal_applied",
  "subscription.upgrade_applied",
] as const;
export type LifecycleNotificationTemplateKey =
  (typeof lifecycleNotificationTemplateKeys)[number];

// Bump when a template's wording or required payload fields change. The
// template version is part of the notification idempotency key so a new
// version re-notifies once for an already-emitted event while duplicate
// scheduler runs never duplicate delivery.
export const lifecycleNotificationTemplateVersion = 1 as const;

// Canonical renewal-reminder offsets emitted by the subscription scheduler.
export const renewalReminderOffsetDays = [30, 14, 7, 1] as const;

// Idempotency key formula (also enforced by a DB unique index):
//   lifecycle:{merchantId}:{subscriptionId}:{periodEndIso}:
//   {notificationType}:{reminderOffsetDays|none}:{templateKey}:{templateVersion}
export const lifecycleNotificationIdempotencyPrefix = "lifecycle";

export const packageCatalogEntries = [
  {
    packageKey: "basic",
    catalogVersion: packageCatalogVersion,
    annualPrice: { currencyCode: "vnd", amountVnd: vndPackagePrices.basic },
    includedStores: 1,
    staffLimit: 3,
    researchRunsPerMonth: 0,
    telegramAiDraftsPerMonth: 0,
    featureKeys: ["pos_core", "accounting_core"],
  },
  {
    packageKey: "plus",
    catalogVersion: packageCatalogVersion,
    annualPrice: { currencyCode: "vnd", amountVnd: vndPackagePrices.plus },
    includedStores: 3,
    staffLimit: 10,
    researchRunsPerMonth: 100,
    telegramAiDraftsPerMonth: 0,
    featureKeys: ["pos_core", "accounting_core", "sepay_qr_payment", "crypto_payment", "smart_cross_sell", "product_research", "customer_scan_go"],
  },
  {
    packageKey: "ai_fan",
    catalogVersion: packageCatalogVersion,
    annualPrice: { currencyCode: "vnd", amountVnd: vndPackagePrices.ai_fan },
    includedStores: 5,
    staffLimit: 30,
    researchRunsPerMonth: 500,
    telegramAiDraftsPerMonth: 2000,
    featureKeys: ["pos_core", "accounting_core", "telegram_runtime", "sepay_qr_payment", "crypto_payment", "smart_cross_sell", "product_research", "customer_scan_go", "telegram_ai_ordering", "telegram_sales_channel", "vision_pos_input", "vision_pos_single_capture", "vision_correction_report"],
  },
] as const;

export const MoneyVndSchema = z.object({
  currencyCode: z.literal("vnd"),
  amountVnd: IntegerStringSchema,
});
export type MoneyVnd = z.infer<typeof MoneyVndSchema>;

export const DecimalQuantitySchema = z.object({
  value: DecimalStringSchema,
  scale: z.number().int().min(0).max(18).optional(),
});
export type DecimalQuantity = z.infer<typeof DecimalQuantitySchema>;

export const MembershipSummarySchema = z.object({
  membershipId: IdSchema,
  operatorId: IdSchema,
  scopeType: z.enum(membershipScopeTypes),
  merchantId: IdSchema.nullable(),
  storeId: IdSchema.nullable(),
  roleKey: z.enum(merchantRoleKeys).nullable(),
  platformRoleKey: z.enum(platformRoleKeys).nullable().optional(),
  status: z.enum(membershipStatuses),
  permissionIds: z.array(z.enum(permissionIds)),
});
export type MembershipSummary = z.infer<typeof MembershipSummarySchema>;

export const ExplicitPermissionGrantSchema = z.object({
  grantId: IdSchema,
  operatorId: IdSchema,
  permissionId: z.enum(permissionIds),
  scopeType: z.enum(membershipScopeTypes),
  merchantId: IdSchema.nullable(),
  storeId: IdSchema.nullable(),
  grantedBy: IdSchema,
  validFrom: IsoDateTimeSchema,
  validTo: IsoDateTimeSchema.nullable(),
});
export type ExplicitPermissionGrant = z.infer<typeof ExplicitPermissionGrantSchema>;

export const RequestAccessSchema = z.object({
  actorId: IdSchema,
  sessionId: IdSchema.optional(),
  identityVersion: z.number().int().nonnegative().optional(),
  isPlatformAdmin: z.boolean(),
  legacyOrganizationId: IdSchema.default("org_default"),
  memberships: z.array(MembershipSummarySchema),
  explicitPermissions: z.array(ExplicitPermissionGrantSchema).default([]),
  permissionIds: z.array(z.enum(permissionIds)),
});
export type RequestAccess = z.infer<typeof RequestAccessSchema>;

export const OperatingScopeSchema = z.object({
  scopeKind: z.literal("operating"),
  merchantId: IdSchema,
  storeId: IdSchema,
  stockLocationId: IdSchema,
});
export type OperatingScope = z.infer<typeof OperatingScopeSchema>;

export const ReportScopeSchema = z.object({
  scopeKind: z.literal("report"),
  merchantId: IdSchema,
  storeIds: z.array(IdSchema).min(1),
});
export type ReportScope = z.infer<typeof ReportScopeSchema>;

export const HistoricalReadScopeSchema = ReportScopeSchema.extend({
  scopeKind: z.literal("historical_read"),
}).strict();
export type HistoricalReadScope = z.infer<typeof HistoricalReadScopeSchema>;

export const PlatformReadScopeSchema = z.object({
  scopeKind: z.literal("platform_read"),
  merchantIds: z.array(IdSchema).optional(),
  storeIds: z.array(IdSchema).optional(),
});
export type PlatformReadScope = z.infer<typeof PlatformReadScopeSchema>;

export const MerchantTargetScopeSchema = z.object({
  scopeKind: z.literal("merchant_target"),
  merchantId: IdSchema,
});
export type MerchantTargetScope = z.infer<typeof MerchantTargetScopeSchema>;

export const MutationScopeSchema = OperatingScopeSchema;
export type MutationScope = OperatingScope;

export function assertMutationScope(scope: unknown): OperatingScope {
  const parsed = MutationScopeSchema.safeParse(scope);
  if (!parsed.success) {
    throw new Error("Mutations require OperatingScope with one merchant, store and stockLocationId");
  }
  return parsed.data;
}

export const PackageCatalogVersionSnapshotSchema = z.object({
  catalogVersionId: IdSchema,
  catalogVersion: z.literal(packageCatalogVersion),
  packageKey: PackageKeySchema,
  annualPrice: MoneyVndSchema,
  includedStores: z.number().int().nonnegative(),
  staffLimit: z.number().int().nonnegative(),
  researchRunsPerMonth: z.number().int().nonnegative(),
  telegramAiDraftsPerMonth: z.number().int().nonnegative(),
  featureKeys: z.array(z.enum(packageFeatureKeys)),
  effectiveFrom: IsoDateTimeSchema,
});
export type PackageCatalogVersionSnapshot = z.infer<typeof PackageCatalogVersionSnapshotSchema>;

export const SubscriptionPolicySnapshotSchema = z.object({
  policyVersion: z.literal(subscriptionPolicyVersion),
  billingTerm: z.literal("annual"),
  graceDays: z.literal(7),
  refundPolicy: z.literal("no_refund"),
  voluntaryDowngradePolicy: z.literal("not_allowed"),
  roundingMode: z.literal("ceil_to_1000_vnd"),
});
export type SubscriptionPolicySnapshot = z.infer<typeof SubscriptionPolicySnapshotSchema>;

export const MerchantSubscriptionStatusSchema = z.object({
  subscriptionId: IdSchema,
  merchantId: IdSchema,
  packageKey: PackageKeySchema,
  catalogVersionId: IdSchema,
  status: z.enum(subscriptionStatuses),
  currentPeriodStart: IsoDateTimeSchema,
  currentPeriodEnd: IsoDateTimeSchema,
  graceEndsAt: IsoDateTimeSchema.nullable(),
  primaryStoreId: IdSchema,
  policySnapshot: SubscriptionPolicySnapshotSchema,
});
export type MerchantSubscriptionStatus = z.infer<typeof MerchantSubscriptionStatusSchema>;

export const BillingOrderSnapshotSchema = z.object({
  billingOrderId: IdSchema,
  merchantId: IdSchema,
  purpose: z.enum(billingOrderPurposes),
  status: z.enum(billingOrderStatuses),
  businessPurpose: z.literal("platform_subscription"),
  providerConfigPurpose: z.literal("platform_billing"),
  currentPackageKey: PackageKeySchema.nullable(),
  targetPackageKey: PackageKeySchema,
  amount: MoneyVndSchema,
  periodStart: IsoDateTimeSchema,
  periodEnd: IsoDateTimeSchema,
  catalogSnapshot: PackageCatalogVersionSnapshotSchema,
  policySnapshot: SubscriptionPolicySnapshotSchema,
  idempotencyKey: IdSchema,
});
export type BillingOrderSnapshot = z.infer<typeof BillingOrderSnapshotSchema>;

export const UsageMetricBucketSchema = z.object({
  merchantId: IdSchema,
  metricKey: z.enum(usageMetricKeys),
  windowStart: IsoDateTimeSchema,
  windowEnd: IsoDateTimeSchema,
  includedQuantity: z.number().int().nonnegative(),
  usedQuantity: z.number().int().nonnegative(),
  reservedQuantity: z.number().int().nonnegative(),
});
export type UsageMetricBucket = z.infer<typeof UsageMetricBucketSchema>;

export const IntegrationConfigScopeSchema = z.object({
  scopeType: z.enum(integrationConfigScopes),
  merchantId: IdSchema.nullable(),
  storeId: IdSchema.nullable(),
});
export type IntegrationConfigScopeDto = z.infer<typeof IntegrationConfigScopeSchema>;

export const ProviderConfigProvenanceSchema = z.object({
  provider: z.enum(paymentProviderKeys),
  purpose: z.enum(providerConfigPurposes),
  scope: IntegrationConfigScopeSchema,
  configId: IdSchema,
  secretRefId: IdSchema.optional(),
  liveMode: z.boolean(),
});
export type ProviderConfigProvenance = z.infer<typeof ProviderConfigProvenanceSchema>;

export const PaymentProviderIntentStatusSchema = z.enum([
  "created",
  "waiting_provider",
  "provider_paid",
  "provider_expired",
  "manual_review",
]);
export type PaymentProviderIntentStatus = z.infer<typeof PaymentProviderIntentStatusSchema>;

export const ProviderWebhookEventSchema = z.object({
  provider: z.enum(paymentProviderKeys),
  providerEventId: IdSchema,
  businessPurpose: z.enum(paymentBusinessPurposes),
  providerConfigPurpose: z.enum(providerConfigPurposes),
  providerConfigProvenance: ProviderConfigProvenanceSchema,
  status: PaymentProviderIntentStatusSchema,
  referenceCode: IdSchema.optional(),
  amount: MoneyVndSchema.optional(),
  providerAmount: DecimalQuantitySchema.optional(),
  providerCurrency: z.string().min(1).optional(),
  occurredAt: IsoDateTimeSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type ProviderWebhookEvent = z.infer<typeof ProviderWebhookEventSchema>;

export interface CryptoReceiptEvidence {
  evidenceId: string;
  businessPurpose: "retail_order";
  merchantId: string;
  storeId: string;
  paymentIntentId: string;
  providerEventId: string;
  asset: RetailCryptoAsset;
  transactionHash: string;
  destinationWalletRef: string;
  grossQuantity: string;
  providerFeeQuantity: string;
  netQuantity: string;
  grossVndValue: number;
  feeVndValue: number;
  valuationRateSource: string;
  valuationTimestamp: string;
}

export const CryptoReceiptEvidenceSchema: z.ZodType<CryptoReceiptEvidence> = z.object({
  evidenceId: IdSchema,
  businessPurpose: z.literal("retail_order"),
  merchantId: IdSchema,
  storeId: IdSchema,
  paymentIntentId: IdSchema,
  providerEventId: IdSchema,
  asset: z.enum(retailCryptoAssets),
  transactionHash: IdSchema,
  destinationWalletRef: IdSchema,
  grossQuantity: DecimalStringSchema,
  providerFeeQuantity: DecimalStringSchema,
  netQuantity: DecimalStringSchema,
  grossVndValue: z.number().int().nonnegative(),
  feeVndValue: z.number().int().nonnegative(),
  valuationRateSource: z.string().min(1),
  valuationTimestamp: IsoDateTimeSchema,
});

export interface ProviderAdapterCreateIntentInput {
  businessPurpose: PaymentBusinessPurpose;
  providerConfigPurpose: ProviderConfigPurpose;
  providerConfig: ProviderConfigProvenance;
  scope: OperatingScope | { scopeKind: "platform_billing"; merchantId: string };
  referenceCode: string;
  amount: MoneyVnd;
  expiresAt: string;
  description?: string;
}

export interface ProviderAdapterIntentResult {
  providerReference: string;
  paymentUrl: string | null;
  qrPayload: string | null;
  providerQuoteSnapshot?: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface ProviderWebhookVerificationInput {
  provider: PaymentProviderKey;
  providerConfigPurpose: ProviderConfigPurpose;
  headers: Record<string, string | string[] | undefined>;
  payload: Record<string, unknown>;
  rawBody?: string;
}

export interface PurposeBoundPaymentProviderAdapter {
  provider: PaymentProviderKey;
  configPurpose: ProviderConfigPurpose;
  businessPurpose: PaymentBusinessPurpose;
  createIntent(input: ProviderAdapterCreateIntentInput): Promise<ProviderAdapterIntentResult>;
  verifyWebhook(input: ProviderWebhookVerificationInput): Promise<ProviderWebhookEvent>;
}

export interface WebhookDispatchInput {
  routeId: string;
  provider: PaymentProviderKey;
  businessPurpose: PaymentBusinessPurpose;
  providerConfigPurpose: ProviderConfigPurpose;
  headers: Record<string, string | string[] | undefined>;
  payload: Record<string, unknown>;
  rawBody?: string;
}

export interface WebhookDispatcher {
  dispatch(input: WebhookDispatchInput): Promise<ProviderWebhookEvent>;
}

export const providerWebhookRouteSkeletons = [
  {
    routeId: "retail-sepay-webhook",
    method: "POST",
    path: "/api/webhooks/sepay",
    provider: "sepay_va",
    businessPurpose: "retail_order",
    providerConfigPurpose: "merchant_retail",
  },
  {
    routeId: "retail-crypto-webhook",
    method: "POST",
    path: "/api/webhooks/crypto/:provider",
    provider: "nowpayments",
    businessPurpose: "retail_order",
    providerConfigPurpose: "merchant_retail",
  },
  {
    routeId: "platform-nowpayments-billing-webhook",
    method: "POST",
    path: "/api/webhooks/nowpayments",
    provider: "nowpayments",
    businessPurpose: "platform_subscription",
    providerConfigPurpose: "platform_billing",
  },
] as const;

type IntegerInput = string | number | bigint;

function integerInputToBigInt(value: IntegerInput, fieldName: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${fieldName} must be non-negative`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${fieldName} must be a non-negative safe integer`);
    }
    return BigInt(value);
  }
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${fieldName} must be an integer string`);
  }
  return BigInt(value);
}

function isoInstantToMs(value: string, fieldName: string): bigint {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${fieldName} must be an ISO datetime`);
  return BigInt(ms);
}

export function makeVndAmount(value: IntegerInput): MoneyVnd {
  return { currencyCode: "vnd", amountVnd: integerInputToBigInt(value, "amountVnd").toString() };
}

export const AnnualProrationInputSchema = z.object({
  prorationKind: z.enum(["package_upgrade", "store_addon"]),
  currentAnnualPrice: MoneyVndSchema,
  targetAnnualPrice: MoneyVndSchema,
  currentPeriodStart: IsoDateTimeSchema,
  currentPeriodEnd: IsoDateTimeSchema,
  quoteCreatedAt: IsoDateTimeSchema,
  currentPackageKey: PackageKeySchema.nullable(),
  targetPackageKey: PackageKeySchema.nullable(),
  catalogSnapshot: PackageCatalogVersionSnapshotSchema,
  policySnapshot: SubscriptionPolicySnapshotSchema,
});
export type AnnualProrationInput = z.infer<typeof AnnualProrationInputSchema>;

export const AnnualProrationQuoteSchema = AnnualProrationInputSchema.extend({
  amount: MoneyVndSchema,
  rawAmountVnd: IntegerStringSchema,
  remainingMilliseconds: IntegerStringSchema,
  totalMilliseconds: IntegerStringSchema,
  roundingIncrementVnd: z.literal("1000"),
});
export type AnnualProrationQuote = z.infer<typeof AnnualProrationQuoteSchema>;

export function calculateAnnualProration(input: AnnualProrationInput): AnnualProrationQuote {
  const parsed = AnnualProrationInputSchema.parse(input);
  const current = integerInputToBigInt(parsed.currentAnnualPrice.amountVnd, "currentAnnualPrice.amountVnd");
  const target = integerInputToBigInt(parsed.targetAnnualPrice.amountVnd, "targetAnnualPrice.amountVnd");
  if (target < current) {
    throw new Error("Annual proration cannot create a refund or voluntary downgrade");
  }
  const startMs = isoInstantToMs(parsed.currentPeriodStart, "currentPeriodStart");
  const endMs = isoInstantToMs(parsed.currentPeriodEnd, "currentPeriodEnd");
  const quoteMs = isoInstantToMs(parsed.quoteCreatedAt, "quoteCreatedAt");
  const totalMs = endMs - startMs;
  if (totalMs <= 0n) throw new Error("currentPeriodEnd must be after currentPeriodStart");

  const remainingMs = quoteMs >= endMs ? 0n : endMs - (quoteMs <= startMs ? startMs : quoteMs);
  const delta = target - current;
  const rawAmount = remainingMs === 0n || delta === 0n
    ? 0n
    : (delta * remainingMs + totalMs - 1n) / totalMs;
  const roundedAmount = rawAmount === 0n ? 0n : ((rawAmount + 999n) / 1000n) * 1000n;

  return {
    ...parsed,
    amount: makeVndAmount(roundedAmount),
    rawAmountVnd: rawAmount.toString(),
    remainingMilliseconds: remainingMs.toString(),
    totalMilliseconds: totalMs.toString(),
    roundingIncrementVnd: "1000",
  };
}

export const ProrationApplicationResultSchema = z.object({
  billingOrderId: IdSchema,
  applied: z.boolean(),
  reason: z.enum(["applied", "duplicate_application"]),
  amount: MoneyVndSchema,
  appliedBillingOrderIds: z.array(IdSchema),
});
export type ProrationApplicationResult = z.infer<typeof ProrationApplicationResultSchema>;

export function applyAnnualProrationQuoteOnce(input: {
  billingOrderId: string;
  quote: AnnualProrationQuote;
  appliedBillingOrderIds: readonly string[];
}): ProrationApplicationResult {
  if (input.appliedBillingOrderIds.includes(input.billingOrderId)) {
    return {
      billingOrderId: input.billingOrderId,
      applied: false,
      reason: "duplicate_application",
      amount: makeVndAmount(0),
      appliedBillingOrderIds: [...input.appliedBillingOrderIds],
    };
  }
  return {
    billingOrderId: input.billingOrderId,
    applied: true,
    reason: "applied",
    amount: input.quote.amount,
    appliedBillingOrderIds: [...input.appliedBillingOrderIds, input.billingOrderId],
  };
}

export const sharedScopeFixtures = {
  legacyOrganizationId: "org_default",
  merchants: [
    { merchantId: "merchant_default", legacyOrganizationId: "org_default", displayName: "Default Merchant" },
    { merchantId: "merchant_second", legacyOrganizationId: "org_second", displayName: "Second Merchant" },
  ],
  stores: [
    { merchantId: "merchant_default", storeId: "store_default", stockLocationId: "sloc_default", isPrimary: true },
    { merchantId: "merchant_default", storeId: "store_annex", stockLocationId: "sloc_annex", isPrimary: false },
    { merchantId: "merchant_second", storeId: "store_second", stockLocationId: "sloc_second", isPrimary: true },
  ],
  operators: {
    platformAdmin: { operatorId: "op_platform_admin", platformRoleKey: "platform_admin" },
    owner: { operatorId: "op_owner", roleKey: "owner", merchantId: "merchant_default" },
    accountant: { operatorId: "op_accountant", roleKey: "accountant", merchantId: "merchant_default" },
    staff: { operatorId: "op_staff1", roleKey: "staff", merchantId: "merchant_default", storeId: "store_default" },
  },
  operatingScopes: {
    defaultStore: { scopeKind: "operating", merchantId: "merchant_default", storeId: "store_default", stockLocationId: "sloc_default" },
    annexStore: { scopeKind: "operating", merchantId: "merchant_default", storeId: "store_annex", stockLocationId: "sloc_annex" },
    secondMerchantStore: { scopeKind: "operating", merchantId: "merchant_second", storeId: "store_second", stockLocationId: "sloc_second" },
  },
  merchantTargetScopes: {
    defaultMerchant: { scopeKind: "merchant_target", merchantId: "merchant_default" },
    secondMerchant: { scopeKind: "merchant_target", merchantId: "merchant_second" },
  },
  reportScopes: {
    defaultMerchantAllStores: { scopeKind: "report", merchantId: "merchant_default", storeIds: ["store_default", "store_annex"] },
    secondMerchant: { scopeKind: "report", merchantId: "merchant_second", storeIds: ["store_second"] },
  },
  platformReadScopes: {
    allMerchants: { scopeKind: "platform_read", merchantIds: ["merchant_default", "merchant_second"] },
  },
  legacyRows: {
    organization: { organizationId: "org_default", mappedMerchantId: "merchant_default", mappedStoreId: "store_default" },
    stockLocation: { stockLocationId: "sloc_default", mappedStoreId: "store_default" },
  },
} as const;

// ── Actor ──────────────────────────────────────────────

export const ActorSchema = z.object({
  type: z.enum(actorTypes),
  id: z.string().min(1)
});
export type Actor = z.infer<typeof ActorSchema>;

// ── API Envelope ───────────────────────────────────────

export const ApiMetaSchema = z.object({
  requestId: z.string().min(1),
  correlationId: z.string().min(1)
});
export type ApiMeta = z.infer<typeof ApiMetaSchema>;

export function resourceEnvelope<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: ApiMetaSchema });
}

export function listEnvelope<T extends z.ZodType>(data: T) {
  return z.object({
    data: z.array(data),
    pagination: z.object({
      limit: z.number().int().positive(),
      cursor: z.string().nullable(),
      hasMore: z.boolean()
    }),
    meta: ApiMetaSchema
  });
}

// ── POS Schemas ────────────────────────────────────────

export const shiftAttributionModes = [
  "online_open_shift",
  "offline_cached_shift",
  "legacy_time_window",
  "unassigned",
] as const;
export type ShiftAttributionMode = (typeof shiftAttributionModes)[number];

const CompleteSaleBaseSchema = z.object({
  cartConfirmationToken: CartPaymentFeeConfirmationTokenV1Schema.optional(),
  items: z.array(z.object({
    variantId: z.string().min(1),
    quantity: z.number().int().positive().max(99),
    unitPrice: z.number().nonnegative().optional(),
    vision: z.object({
      scanEventId: z.string().min(1),
      detectionId: z.string().min(1).optional(),
      correctionId: z.string().min(1).optional(),
      objectId: z.string().min(1).optional(),
      candidateSource: z.enum(["ai_candidate", "manual_search_after_scan"]),
      provider: z.string().min(1),
      providerCandidateRank: z.number().int().positive().optional(),
      providerConfidence: z.number().min(0).max(1).optional(),
      providerProductRef: z.string().optional(),
      providerImageRef: z.string().optional()
    }).optional(),
    visionContexts: z.array(z.object({
      scanEventId: z.string().min(1),
      detectionId: z.string().min(1).optional(),
      correctionId: z.string().min(1).optional(),
      objectId: z.string().min(1).optional(),
      candidateSource: z.enum(["ai_candidate", "manual_search_after_scan"]),
      provider: z.string().min(1),
      providerCandidateRank: z.number().int().positive().optional(),
      providerConfidence: z.number().min(0).max(1).optional(),
      providerProductRef: z.string().optional(),
      providerImageRef: z.string().optional()
    })).max(99).optional()
  })).min(1),
  customerId: z.string().optional(),
  // New POS clients must make customer attribution explicit. This remains
  // optional during the rolling upgrade so queued/offline payloads created by
  // the previous bundle can still be replayed safely.
  customerMode: z.enum(["linked", "walk_in"]).optional(),
  paymentMethod: z.enum(paymentMethods),
  amountReceived: z.number().nonnegative(),
  discountPercent: z.number().min(0).max(100).default(0),
  discountType: z.enum(["percent", "amount"]).optional(),
  discountValue: z.number().min(0).optional(),
  paymentFeeType: PaymentFeeInputV1Schema.shape.paymentFeeType.optional(),
  paymentFeeValue: PaymentFeeInputV1Schema.shape.paymentFeeValue.optional(),
  shippingFee: z.number().int().nonnegative().default(0),
  notes: z.string().max(1000).optional(),
  salesChannel: z.enum(salesChannels).default("pos_counter"),
  sourceOrderId: z.string().min(1).optional(),
  shiftId: z.string().min(1).optional(),
  shiftOpenedAt: IsoDateTimeSchema.optional(),
  shiftAttribution: z.enum(shiftAttributionModes).optional(),
  queuedAt: IsoDateTimeSchema.optional(),
  foundStockConfirmation: z.object({
    confirmed: z.boolean(),
    reasonCode: z.literal("found_stock").default("found_stock"),
    reasonLabel: z.literal("Tìm thấy").default("Tìm thấy"),
    acknowledgedShortages: z.array(z.object({
      variantId: z.string().min(1),
      shortageQuantity: z.number().int().positive().optional()
    })).default([])
  }).optional()
});
function withPaymentFeeInputBoundary<Schema extends z.ZodType>(schema: Schema) {
  // Check raw fee fields before object parsing can strip client-supplied resolved amounts.
  return z.preprocess((value, ctx) => {
    if (value !== null && typeof value === "object") {
      try { parseOptionalPaymentFeeInputV1(value); }
      catch {
        ctx.addIssue({ code: "custom", message: "Payment fee request accepts only a valid type and value, not resolved totals" });
        return z.NEVER;
      }
    }
    return value;
  }, schema);
}
export const CompleteSaleSchema = withPaymentFeeInputBoundary(CompleteSaleBaseSchema);
export type CompleteSaleInput = z.infer<typeof CompleteSaleSchema>;

const FinancialSaleObjectV1Schema = CompleteSaleBaseSchema.extend({
  cartConfirmationToken: CartPaymentFeeConfirmationTokenV1Schema,
  items: z.array(CompleteSaleBaseSchema.shape.items.element.omit({ unitPrice: true }).extend({
    vision: CompleteSaleBaseSchema.shape.items.element.shape.vision.unwrap().strict().optional(),
    visionContexts: z.array(CompleteSaleBaseSchema.shape.items.element.shape.visionContexts.unwrap().element.strict()).max(99).optional(),
  }).strict()).min(1),
  amountReceived: z.number().int().safe().nonnegative(), paymentMethod: z.enum(["cash", "bank_transfer", "cod"]),
  discountPercent: z.number().finite().min(0).max(100).optional(), shippingFee: z.number().int().safe().nonnegative().optional(),
  salesChannel: z.enum(salesChannels).optional(), ...PaymentFeeInputV1Schema.shape,
  idempotencyKey: z.string().min(1).optional(), sourceFlow: z.string().optional(),
  scanGoCartId: z.string().min(1).optional(), scanGoCheckoutToken: z.string().min(1).optional(),
  scanGoRedeemedAt: IsoDateTimeSchema.optional(), salesChannelLocked: z.boolean().optional(),
  customerNickname: z.string().nullable().optional(), customerContactType: z.string().nullable().optional(),
  redeemedByOperatorId: z.string().nullable().optional(), telegramSalesDraftId: z.string().min(1).optional(),
  telegramSalesOperatorNotes: z.string().nullable().optional(),
  bankTransferSettlementAcknowledgment: z.object({ policyVersion: z.number().int().safe().nonnegative(),
    acknowledgmentVersion: z.literal(BANK_TRANSFER_SETTLEMENT_ACKNOWLEDGMENT_VERSION) }).strict().optional(),
  foundStockConfirmation: z.object({ confirmed: z.literal(true), reasonCode: z.literal("found_stock"), reasonLabel: z.literal("Tìm thấy"),
    acknowledgedShortages: z.array(z.object({ variantId: z.string().min(1), shortageQuantity: z.number().int().safe().positive() }).strict()),
  }).strict().optional(),
}).strict();
function validateFinancialSaleAdjustmentsV1(value: Pick<z.infer<typeof FinancialSaleObjectV1Schema>,
  "items" | "discountType" | "discountValue" | "discountPercent" | "shippingFee" | "paymentFeeType" | "paymentFeeValue">, ctx: z.RefinementCtx) {
  if (!CartPaymentFeePreviewInputV1Schema.safeParse({ items: value.items.map(({ variantId, quantity }) => ({ variantId, quantity })),
    discountType: value.discountType, discountValue: value.discountValue, discountPercent: value.discountPercent,
    shippingFee: value.shippingFee, paymentFeeType: value.paymentFeeType, paymentFeeValue: value.paymentFeeValue,
  }).success) ctx.addIssue({ code: "custom", message: "Invalid financial sale adjustments" });
}
// Validation only at admission; dispatch/hash the original body, never these parsed defaults.
export const CompleteSaleFinancialInputV1Schema = FinancialSaleObjectV1Schema.superRefine(validateFinancialSaleAdjustmentsV1);
export const CreatePaymentIntentFinancialInputV1Schema = z.object({
  provider: z.enum(["mock", "sepay_va", "nowpayments"]),
  order: FinancialSaleObjectV1Schema.extend({ paymentMethod: z.enum([...paymentMethods, "mock"]).optional(),
    amountReceived: z.number().int().safe().nonnegative().optional(),
  }).superRefine(validateFinancialSaleAdjustmentsV1),
}).strict();

export const CreateCustomerSchema = z.object({
  phone: z.string().min(5).max(15),
  name: z.string().min(1).max(200)
});
export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;

export const AdjustStockSchema = z.object({
  inventoryItemId: z.string().min(1),
  locationId: z.string().min(1),
  adjustment: z.number().int(),
  reason: z.string().min(1),
  movementType: z.enum(stockMovementTypes).default("manual_adjustment")
});
export type AdjustStockInput = z.infer<typeof AdjustStockSchema>;

export const CreatePurchaseOrderSchema = z.object({
  supplierName: z.string().min(1),
  items: z.array(z.object({
    variantId: z.string().min(1),
    quantity: z.number().int().positive(),
    unitCost: z.number().int().nonnegative()
  })).min(1),
  expectedDate: DateOrDateTimeSchema.optional()
});
export type CreatePurchaseOrderInput = z.infer<typeof CreatePurchaseOrderSchema>;

// ── Accounting Schemas ─────────────────────────────────

export const CreateAccountSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(accountTypes),
  parentId: z.string().optional(),
  description: z.string().optional()
});
export type CreateAccountInput = z.infer<typeof CreateAccountSchema>;

export const CreateJournalEntrySchema = z.object({
  entryDate: z.string().date(),
  referenceType: z.string().optional(),
  referenceId: z.string().optional(),
  description: z.string().min(1),
  lines: z.array(z.object({
    accountCode: z.string().min(1),
    debitAmount: z.number().nonnegative().default(0),
    creditAmount: z.number().nonnegative().default(0),
    description: z.string().optional()
  })).min(2)  // Double-entry requires at least 2 lines
});
export type CreateJournalEntryInput = z.infer<typeof CreateJournalEntrySchema>;

export const UpdateJournalEntrySchema = CreateJournalEntrySchema.partial().extend({
  lines: CreateJournalEntrySchema.shape.lines.optional(),
});
export type UpdateJournalEntryInput = z.infer<typeof UpdateJournalEntrySchema>;

export const AccountingReportParamsSchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  asOf: z.string().date().optional(),
});
export type AccountingReportParams = z.infer<typeof AccountingReportParamsSchema>;

export const ReceiptEmailSchema = z.object({
  email: z.string().trim().email().max(320).optional(),
});
export type ReceiptEmailInput = z.infer<typeof ReceiptEmailSchema>;

export const AuditFiltersSchema = z.object({
  actorId: z.string().optional(),
  action: z.string().optional(),
  subjectType: z.string().optional(),
  subjectId: z.string().optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
});
export type AuditFilters = z.infer<typeof AuditFiltersSchema>;

export const ReceivePurchaseOrderSchema = z.object({
  note: z.string().max(1000).optional(),
  items: z.array(z.object({
    purchaseOrderItemId: z.string().min(1),
    receivedQuantity: z.number().int().positive(),
  })).min(1),
});
export type ReceivePurchaseOrderInput = z.infer<typeof ReceivePurchaseOrderSchema>;

export const PurchaseOrderIdParamsSchema = z.object({
  id: z.string().min(1),
});
export type PurchaseOrderIdParams = z.infer<typeof PurchaseOrderIdParamsSchema>;

export const PurchaseOrderReasonSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type PurchaseOrderReasonInput = z.infer<typeof PurchaseOrderReasonSchema>;

export const SendPurchaseOrderSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});
export type SendPurchaseOrderInput = z.infer<typeof SendPurchaseOrderSchema>;

const BooleanQuerySchema = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

export const PurchaseOrderRecommendationParamsSchema = z.object({
  coverageDays: z.coerce.number().int().positive().max(180).default(30),
  includeZeroSuggestion: BooleanQuerySchema.default(false),
});
export type PurchaseOrderRecommendationParams = z.infer<typeof PurchaseOrderRecommendationParamsSchema>;

export const OfflineSyncPayloadSchema = z.object({
  sales: z.array(withPaymentFeeInputBoundary(CompleteSaleBaseSchema.extend({
    idempotencyKey: z.string().min(1),
    createdAt: z.string().datetime().optional(),
  }))).default([]),
});
export type OfflineSyncPayload = z.infer<typeof OfflineSyncPayloadSchema>;

// ── Shift Management Schemas ───────────────────────────

export const shiftStatuses = ["open", "closing", "closed", "force_closed", "voided"] as const;
export type ShiftStatus = (typeof shiftStatuses)[number];

export const shiftReviewStatuses = ["not_required", "pending", "approved", "flagged"] as const;
export type ShiftReviewStatus = (typeof shiftReviewStatuses)[number];

export const shiftCashMovementTypes = ["pay_in", "pay_out", "cash_drop", "cash_correction"] as const;
export type ShiftCashMovementType = (typeof shiftCashMovementTypes)[number];

export const shiftStockCountTypes = ["quick", "close"] as const;
export type ShiftStockCountType = (typeof shiftStockCountTypes)[number];

export const ShiftPolicySchema = z.object({
  id: IdSchema.optional(),
  merchantId: IdSchema,
  storeId: IdSchema,
  stockLocationId: IdSchema,
  enabled: z.boolean().default(false),
  enforceShiftOnPos: z.boolean().default(false),
  allowOfflineCachedShift: z.boolean().default(true),
  blindCloseCash: z.boolean().default(true),
  requireHandoverAck: z.boolean().default(false),
  quickStockCountRequired: z.boolean().default(false),
  maxOpenDurationMinutes: z.number().int().positive().default(960),
  staleAfterMinutes: z.number().int().positive().default(1080),
  cashDiscrepancyAlertThreshold: MoneyVndSchema.default(makeVndAmount(0)),
  stockDiscrepancyAlertThreshold: z.number().int().nonnegative().default(1),
  checklist: z.array(z.string().min(1).max(200)).default([]),
});
export type ShiftPolicy = z.infer<typeof ShiftPolicySchema>;

export const ShiftSummarySchema = z.object({
  id: IdSchema,
  merchantId: IdSchema,
  storeId: IdSchema,
  stockLocationId: IdSchema,
  status: z.enum(shiftStatuses),
  reviewStatus: z.enum(shiftReviewStatuses),
  zNumber: z.number().int().positive().nullable(),
  openedBy: IdSchema,
  openedAt: IsoDateTimeSchema,
  closedBy: IdSchema.nullable().optional(),
  closedAt: IsoDateTimeSchema.nullable().optional(),
  forceClosedBy: IdSchema.nullable().optional(),
  forceClosedAt: IsoDateTimeSchema.nullable().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  openingCashAmount: MoneyVndSchema,
  expectedCashAmount: MoneyVndSchema.nullable().optional(),
  blindCashCountAmount: MoneyVndSchema.nullable().optional(),
  cashVarianceAmount: MoneyVndSchema.nullable().optional(),
  outgoingHandoverNote: z.string().nullable().optional(),
});
export type ShiftSummary = z.infer<typeof ShiftSummarySchema>;

export const ShiftCashMovementSchema = z.object({
  id: IdSchema,
  shiftId: IdSchema,
  merchantId: IdSchema,
  storeId: IdSchema,
  stockLocationId: IdSchema,
  type: z.enum(shiftCashMovementTypes),
  amount: MoneyVndSchema,
  reason: z.string().min(1).max(1000),
  reasonCode: z.string().max(120).nullable().optional(),
  performedBy: IdSchema,
  occurredAt: IsoDateTimeSchema,
});
export type ShiftCashMovement = z.infer<typeof ShiftCashMovementSchema>;

export const CreateShiftCashMovementSchema = z.object({
  type: z.enum(shiftCashMovementTypes),
  amount: MoneyVndSchema,
  reason: z.string().trim().min(1).max(1000),
  reasonCode: z.string().trim().max(120).optional(),
});
export type CreateShiftCashMovementInput = z.infer<typeof CreateShiftCashMovementSchema>;

export const ShiftStockCountSchema = z.object({
  id: IdSchema,
  shiftId: IdSchema,
  merchantId: IdSchema,
  storeId: IdSchema,
  stockLocationId: IdSchema,
  countType: z.enum(shiftStockCountTypes),
  inventoryItemId: IdSchema,
  productId: IdSchema.nullable().optional(),
  variantId: IdSchema.nullable().optional(),
  skuSnapshot: z.string().nullable().optional(),
  productTitleSnapshot: z.string().nullable().optional(),
  systemQuantity: z.number().int(),
  countedQuantity: z.number().int().nonnegative(),
  discrepancyQuantity: z.number().int(),
  reason: z.string().nullable().optional(),
  countedBy: IdSchema,
  countedAt: IsoDateTimeSchema,
});
export type ShiftStockCount = z.infer<typeof ShiftStockCountSchema>;

export const RecordShiftStockCountSchema = z.object({
  countType: z.enum(shiftStockCountTypes).default("quick"),
  items: z.array(z.object({
    inventoryItemId: IdSchema,
    countedQuantity: z.number().int().nonnegative(),
    reason: z.string().trim().max(1000).optional(),
  })).min(1),
});
export type RecordShiftStockCountInput = z.infer<typeof RecordShiftStockCountSchema>;

export const ReceiveShiftHandoverSchema = z.object({
  previousShiftId: IdSchema,
  acknowledgementNote: z.string().trim().max(1000).optional(),
  receivedOpeningCashAmount: MoneyVndSchema.optional(),
  acknowledgedItems: z.array(z.string().min(1).max(200)).default([]),
});
export type ReceiveShiftHandoverInput = z.infer<typeof ReceiveShiftHandoverSchema>;

export const StartShiftSchema = z.object({
  openingCashAmount: MoneyVndSchema,
  openingNote: z.string().trim().max(1000).optional(),
  handoverAcknowledgementId: IdSchema.optional(),
});
export type StartShiftInput = z.infer<typeof StartShiftSchema>;

export const CloseShiftPreviewSchema = z.object({
  countedCashAmount: MoneyVndSchema.optional(),
});
export type CloseShiftPreviewInput = z.infer<typeof CloseShiftPreviewSchema>;

export const CloseShiftSchema = z.object({
  countedCashAmount: MoneyVndSchema,
  discrepancyReason: z.string().trim().max(1000).optional(),
  stockCounts: RecordShiftStockCountSchema.shape.items.default([]),
  outgoingHandoverNote: z.string().trim().max(2000).optional(),
  checklist: z.array(z.object({
    label: z.string().min(1).max(200),
    checked: z.boolean(),
  })).default([]),
});
export type CloseShiftInput = z.infer<typeof CloseShiftSchema>;

export const ReviewShiftSchema = z.object({
  reviewStatus: z.enum(["approved", "flagged"]),
  reason: z.string().trim().max(1000).optional(),
});
export type ReviewShiftInput = z.infer<typeof ReviewShiftSchema>;

export const ForceCloseShiftSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  countedCashAmount: MoneyVndSchema.optional(),
  outgoingHandoverNote: z.string().trim().max(2000).optional(),
});
export type ForceCloseShiftInput = z.infer<typeof ForceCloseShiftSchema>;

export const ShiftReportSchema = z.object({
  shift: ShiftSummarySchema,
  orderIds: z.array(IdSchema),
  paymentSummary: z.record(z.string(), z.object({
    charges: MoneyVndSchema,
    refunds: MoneyVndSchema,
    net: MoneyVndSchema,
    count: z.number().int().nonnegative(),
  })),
  outstandingObligations: z.array(z.object({
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    minorUnitExponent: z.number().int().min(0).max(3),
    remainingAmountMinor: z.number().int().nonnegative(),
    obligationCount: z.number().int().nonnegative(),
  })).default([]),
  outstandingRefundPayables: z.array(z.object({
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    minorUnitExponent: z.number().int().min(0).max(3),
    remainingAmountMinor: z.number().int().nonnegative(),
    payableCount: z.number().int().nonnegative(),
  })).default([]),
  reportAsOf: z.string().optional(),
  postCloseFinancialAdjustments: z.array(z.record(z.string(), z.unknown())).default([]),
  cashExpected: MoneyVndSchema.nullable(),
  stockCounts: z.array(ShiftStockCountSchema).default([]),
  warnings: z.array(z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    severity: z.enum(["info", "warning", "danger"]).default("warning"),
  })).default([]),
  postCloseAdjustments: z.array(z.record(z.string(), z.unknown())).default([]),
});
export type ShiftReport = z.infer<typeof ShiftReportSchema>;

export const IdempotencyErrorSchema = z.object({
  error: z.object({
    code: z.enum(["idempotency_key_required", "idempotency_conflict"]),
    message: z.string(),
  }),
});
export type IdempotencyError = z.infer<typeof IdempotencyErrorSchema>;

// ── CRM / Loyalty Schemas ──────────────────────────────

export const LoyaltyTierSchema = z.object({
  name: z.enum(loyaltyTierNames),
  pointsThreshold: z.number().int().nonnegative(),
  discountPercent: z.number().min(0).max(100)
});
export type LoyaltyTier = z.infer<typeof LoyaltyTierSchema>;

// ── AI Schemas ─────────────────────────────────────────

export const ReplyDraftRequestSchema = z.object({
  customerMessage: z.string().min(1).max(5000),
  productContext: z.array(z.string()).optional(),
  operatorInstruction: z.string().max(1000).optional()
});
export type ReplyDraftRequest = z.infer<typeof ReplyDraftRequestSchema>;

export const ReplyPlanSchema = z.object({
  intent: z.string().min(1),
  riskLevel: z.enum(riskLevels),
  customerLanguage: z.string().min(2).default("vi"),
  responseText: z.string().min(1),
  nextBestAction: z.enum([
    "answer_question", "suggest_products", "ask_order_details", "handover_to_human"
  ]),
  missingInformation: z.array(z.string()),
  confidence: z.number().min(0).max(1)
});
export type ReplyPlan = z.infer<typeof ReplyPlanSchema>;

export const ApproveAiActionSchema = z.object({
  approvedText: z.string().min(1).optional()
});
export type ApproveAiActionInput = z.infer<typeof ApproveAiActionSchema>;

export const RejectAiActionSchema = z.object({
  reason: z.string().min(1).default("operator_rejected")
});
export type RejectAiActionInput = z.infer<typeof RejectAiActionSchema>;

// ── Event Schemas ──────────────────────────────────────

export const DomainEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  eventVersion: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  organizationId: z.string().min(1),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  correlationId: z.string().min(1),
  actor: ActorSchema,
  payload: z.record(z.string(), z.unknown())
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;

// ── Error Types ────────────────────────────────────────

export const ErrorCodes = {
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  RESOURCE_NOT_FOUND: "resource_not_found",
  VALIDATION_ERROR: "validation_error",
  IDEMPOTENCY_KEY_REQUIRED: "idempotency_key_required",
  IDEMPOTENCY_CONFLICT: "idempotency_conflict",
  INSUFFICIENT_STOCK: "insufficient_stock",
  INVALID_STATE_TRANSITION: "invalid_state_transition",
  POLICY_BLOCKED: "policy_blocked",
  RATE_LIMITED: "rate_limited",
  INTERNAL_ERROR: "internal_error"
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export * from "./order-financial-correctness";
export * from "./order-payment-fee";
export * from "./order-operational-detail";
export * from "./payment-intent-financial";
export * from "./cart-payment-fee-preview";
export * from "./checkout-payment-fee";
export * from "./order-correction-payment-fee";
export * from "./dashboard-metric-runtime";
export * from "./outbox-runtime";
