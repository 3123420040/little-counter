import { z } from "zod";

const IdSchema = z.string().min(1);
const IsoDateTimeSchema = z.string().datetime();
const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);
const MinorUnitSchema = z.number().int().safe().nonnegative();
const SignedMinorUnitSchema = z.number().int().safe();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const SUPPORTED_CURRENCY_REGISTRY_V1 = [
  { currencyCode: "VND", minorUnitExponent: 0, writeSupported: true },
] as const;

export const CostCoverageV1Schema = z.object({
  knownLines: z.number().int().nonnegative(),
  totalLines: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.knownLines > value.totalLines) {
    ctx.addIssue({ code: "custom", message: "known cost lines exceed total lines" });
  }
});
export type CostCoverageV1 = z.infer<typeof CostCoverageV1Schema>;

export const DataQualityV1Schema = z.object({
  status: z.enum(["complete", "partial", "unavailable"]),
  costCoverage: CostCoverageV1Schema,
  warnings: z.array(z.string().min(1)),
}).strict().superRefine((value, ctx) => {
  if (
    value.status === "complete"
    && value.costCoverage.knownLines !== value.costCoverage.totalLines
  ) {
    ctx.addIssue({ code: "custom", message: "complete quality requires full cost coverage" });
  }
});
export type DataQualityV1 = z.infer<typeof DataQualityV1Schema>;

export const OrderCommercialComponentsV1Schema = z.object({
  taxMode: z.enum(["inclusive", "exclusive"]),
  merchandiseGrossMinor: MinorUnitSchema,
  discountMinor: MinorUnitSchema,
  merchandiseNetMinor: MinorUnitSchema,
  shippingMinor: MinorUnitSchema,
  merchandiseVatMinor: MinorUnitSchema,
  shippingVatMinor: MinorUnitSchema,
  vatMinor: MinorUnitSchema,
  unclassifiedMinor: MinorUnitSchema,
  totalMinor: MinorUnitSchema,
}).strict().superRefine((value, ctx) => {
  if (value.discountMinor > value.merchandiseGrossMinor) {
    ctx.addIssue({ code: "custom", message: "discount exceeds merchandise gross" });
  }
  if (value.merchandiseGrossMinor - value.discountMinor !== value.merchandiseNetMinor) {
    ctx.addIssue({ code: "custom", message: "merchandise net arithmetic mismatch" });
  }
  if (value.merchandiseVatMinor + value.shippingVatMinor !== value.vatMinor) {
    ctx.addIssue({ code: "custom", message: "VAT attribution arithmetic mismatch" });
  }
  if (
    value.taxMode === "inclusive"
    && (
      value.merchandiseVatMinor > value.merchandiseNetMinor
      || value.shippingVatMinor > value.shippingMinor
    )
  ) {
    ctx.addIssue({ code: "custom", message: "inclusive VAT exceeds its containing charge" });
  }
  if (
    value.merchandiseNetMinor
      + value.shippingMinor
      + value.unclassifiedMinor
      + (value.taxMode === "exclusive" ? value.vatMinor : 0)
    !== value.totalMinor
  ) {
    ctx.addIssue({ code: "custom", message: "commercial component arithmetic mismatch" });
  }
});
export type OrderCommercialComponentsV1 = z.infer<typeof OrderCommercialComponentsV1Schema>;

export function merchandiseRevenueExVatMinor(
  components: OrderCommercialComponentsV1,
): number {
  return components.merchandiseNetMinor
    - (components.taxMode === "inclusive" ? components.merchandiseVatMinor : 0);
}

export function shippingRevenueExVatMinor(
  components: OrderCommercialComponentsV1,
): number {
  return components.shippingMinor
    - (components.taxMode === "inclusive" ? components.shippingVatMinor : 0);
}

export function percentageOneDecimalHalfUp(
  numerator: number,
  denominator: number,
): number | null {
  if (
    !Number.isSafeInteger(numerator)
    || numerator < 0
    || !Number.isSafeInteger(denominator)
    || denominator < 0
  ) {
    throw new Error("percentage inputs must be non-negative safe integers");
  }
  if (denominator === 0) return null;
  const denominatorUnits = BigInt(denominator);
  const tenthsOfPercent = (
    (BigInt(numerator) * 1_000n)
    + (denominatorUnits / 2n)
  ) / denominatorUnits;
  return Number(tenthsOfPercent) / 10;
}

export function signedPercentageOneDecimalHalfUp(
  numerator: number,
  denominator: number,
): number | null {
  if (
    !Number.isSafeInteger(numerator)
    || !Number.isSafeInteger(denominator)
    || denominator <= 0
  ) {
    return null;
  }
  const sign = numerator < 0 ? -1 : 1;
  const absolute = BigInt(Math.abs(numerator));
  const denominatorUnits = BigInt(denominator);
  const tenthsOfPercent = (
    (absolute * 1_000n)
    + (denominatorUnits / 2n)
  ) / denominatorUnits;
  return sign * Number(tenthsOfPercent) / 10;
}

export const EffectiveOrderLineV1Schema = z.object({
  lineId: IdSchema,
  productId: IdSchema.nullable(),
  variantId: IdSchema.nullable(),
  skuSnapshot: z.string().min(1),
  titleSnapshot: z.string().min(1),
  quantity: z.number().int().safe().positive(),
  unitPriceMinor: MinorUnitSchema,
  archivedVariant: z.boolean().optional(),
}).strict();

export const EffectiveOrderV1Schema = z.object({
  schemaVersion: z.literal(1),
  orderId: IdSchema,
  currencyCode: CurrencyCodeSchema,
  minorUnitExponent: z.number().int().min(0).max(3),
  effectiveRevision: z.number().int().nonnegative(),
  commercialState: z.enum(["active", "cancelled"]),
  lines: z.array(EffectiveOrderLineV1Schema),
  components: OrderCommercialComponentsV1Schema,
  currentOrderGrossValueMinor: MinorUnitSchema,
  dataQuality: DataQualityV1Schema,
}).strict().superRefine((value, ctx) => {
  const expected = value.commercialState === "cancelled" ? 0 : value.components.totalMinor;
  if (value.currentOrderGrossValueMinor !== expected) {
    ctx.addIssue({ code: "custom", message: "current order gross value mismatch" });
  }
  let lineGrossMinor = 0;
  for (const line of value.lines) {
    const lineTotalMinor = line.quantity * line.unitPriceMinor;
    if (!Number.isSafeInteger(lineTotalMinor)) {
      ctx.addIssue({ code: "custom", message: "effective line total exceeds safe integer" });
      return;
    }
    lineGrossMinor += lineTotalMinor;
    if (!Number.isSafeInteger(lineGrossMinor)) {
      ctx.addIssue({ code: "custom", message: "effective line gross exceeds safe integer" });
      return;
    }
  }
  if (lineGrossMinor !== value.components.merchandiseGrossMinor) {
    ctx.addIssue({ code: "custom", message: "effective line/component gross mismatch" });
  }
  if (value.dataQuality.costCoverage.totalLines !== value.lines.length) {
    ctx.addIssue({ code: "custom", message: "effective cost coverage line count mismatch" });
  }
});
export type EffectiveOrderV1 = z.infer<typeof EffectiveOrderV1Schema>;

export const EffectiveOrderSurfaceLineV2Schema = EffectiveOrderLineV1Schema.extend({
  lineTotalMinor: MinorUnitSchema,
}).strict().superRefine((value, ctx) => {
  const expected = value.quantity * value.unitPriceMinor;
  if (!Number.isSafeInteger(expected) || value.lineTotalMinor !== expected) {
    ctx.addIssue({ code: "custom", message: "effective surface line arithmetic mismatch" });
  }
});

export const EffectiveOrderSurfaceV2Schema = z.object({
  schemaVersion: z.literal(2),
  surfaceKind: z.enum(["detail", "list"]),
  orderId: IdSchema,
  currencyCode: CurrencyCodeSchema,
  minorUnitExponent: z.number().int().min(0).max(3),
  effectiveRevision: z.number().int().nonnegative(),
  commercialState: z.enum(["active", "cancelled"]),
  effectiveItems: z.array(EffectiveOrderSurfaceLineV2Schema),
  components: OrderCommercialComponentsV1Schema,
  effectiveCommercialTotalMinor: MinorUnitSchema,
  currentOrderGrossValueMinor: MinorUnitSchema,
  effectiveItemQuantity: z.number().int().safe().nonnegative(),
  dataQuality: DataQualityV1Schema,
}).strict().superRefine((value, ctx) => {
  if (value.effectiveCommercialTotalMinor !== value.components.totalMinor) {
    ctx.addIssue({ code: "custom", message: "effective commercial total mismatch" });
  }
  const expectedCurrentGross = value.commercialState === "cancelled"
    ? 0
    : value.components.totalMinor;
  if (value.currentOrderGrossValueMinor !== expectedCurrentGross) {
    ctx.addIssue({ code: "custom", message: "surface current order gross mismatch" });
  }
  let lineGrossMinor = 0;
  let itemQuantity = 0;
  for (const line of value.effectiveItems) {
    lineGrossMinor += line.lineTotalMinor;
    itemQuantity += line.quantity;
    if (!Number.isSafeInteger(lineGrossMinor) || !Number.isSafeInteger(itemQuantity)) {
      ctx.addIssue({ code: "custom", message: "effective surface aggregation overflow" });
      return;
    }
  }
  if (lineGrossMinor !== value.components.merchandiseGrossMinor) {
    ctx.addIssue({ code: "custom", message: "surface line/component gross mismatch" });
  }
  const expectedQuantity = value.commercialState === "cancelled" ? 0 : itemQuantity;
  if (value.effectiveItemQuantity !== expectedQuantity) {
    ctx.addIssue({ code: "custom", message: "surface effective item quantity mismatch" });
  }
});
export type EffectiveOrderSurfaceV2 = z.infer<typeof EffectiveOrderSurfaceV2Schema>;

export const EffectiveOrderAuditIdentityV1Schema = z.object({
  orderId: IdSchema,
  orderNumber: IdSchema,
  createdAt: IsoDateTimeSchema,
  storeTimeZone: z.string().min(1).max(64),
}).strict();
export type EffectiveOrderAuditIdentityV1 = z.infer<
  typeof EffectiveOrderAuditIdentityV1Schema
>;

export const EffectiveOrderReceiptLineV1Schema = EffectiveOrderLineV1Schema.extend({
  lineTotalMinor: MinorUnitSchema,
}).strict().superRefine((value, ctx) => {
  const expected = value.quantity * value.unitPriceMinor;
  if (!Number.isSafeInteger(expected) || value.lineTotalMinor !== expected) {
    ctx.addIssue({ code: "custom", message: "effective receipt line arithmetic mismatch" });
  }
});

export const EffectiveOrderReceiptV1Schema = z.object({
  schemaVersion: z.literal(1),
  financialMeaning: z.literal("effective_order_commercial_snapshot_not_collection"),
  sourceOrder: EffectiveOrderAuditIdentityV1Schema,
  currencyCode: CurrencyCodeSchema,
  minorUnitExponent: z.number().int().min(0).max(3),
  effectiveRevision: z.number().int().nonnegative(),
  commercialState: z.enum(["active", "cancelled"]),
  effectiveItems: z.array(EffectiveOrderReceiptLineV1Schema),
  components: OrderCommercialComponentsV1Schema,
  effectiveCommercialTotalMinor: MinorUnitSchema,
  dataQuality: DataQualityV1Schema,
}).strict().superRefine((value, ctx) => {
  if (value.effectiveCommercialTotalMinor !== value.components.totalMinor) {
    ctx.addIssue({ code: "custom", message: "effective receipt commercial total mismatch" });
  }
  let merchandiseGrossMinor = 0;
  for (const line of value.effectiveItems) {
    merchandiseGrossMinor += line.lineTotalMinor;
    if (!Number.isSafeInteger(merchandiseGrossMinor)) {
      ctx.addIssue({ code: "custom", message: "effective receipt aggregation overflow" });
      return;
    }
  }
  if (merchandiseGrossMinor !== value.components.merchandiseGrossMinor) {
    ctx.addIssue({ code: "custom", message: "effective receipt line/component mismatch" });
  }
});
export type EffectiveOrderReceiptV1 = z.infer<typeof EffectiveOrderReceiptV1Schema>;

export const EffectiveOrderRecreateUnavailableReasonV1Schema = z.enum([
  "missing_variant_identity",
  "source_variant_archived",
  "variant_not_found",
  "product_identity_mismatch",
  "current_variant_archived",
  "variant_unpublished",
  "insufficient_stock",
]);

export const EffectiveOrderRecreateCatalogCandidateV1Schema = z.object({
  productId: IdSchema,
  variantId: IdSchema,
  currentTitle: z.string().min(1),
  currentSku: z.string().min(1),
  currentUnitPriceMinor: MinorUnitSchema,
  stockAvailableQuantity: z.number().int().safe().nonnegative(),
  published: z.boolean(),
  archived: z.boolean(),
}).strict();
export type EffectiveOrderRecreateCatalogCandidateV1 = z.infer<
  typeof EffectiveOrderRecreateCatalogCandidateV1Schema
>;

const EffectiveOrderRecreateAvailableMappingV1Schema = z.object({
  status: z.literal("available"),
  productId: IdSchema,
  variantId: IdSchema,
  currentTitle: z.string().min(1),
  currentSku: z.string().min(1),
  stockAvailableQuantity: z.number().int().safe().nonnegative(),
  currentUnitPriceMinor: MinorUnitSchema,
  cartUnitPriceMinor: MinorUnitSchema,
  priceChanged: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.cartUnitPriceMinor !== value.currentUnitPriceMinor) {
    ctx.addIssue({ code: "custom", message: "recreate cart price must use explicit current price" });
  }
});

const EffectiveOrderRecreateUnavailableMappingV1Schema = z.object({
  status: z.literal("unavailable"),
  reasons: z.array(EffectiveOrderRecreateUnavailableReasonV1Schema).min(1),
  currentProductId: IdSchema.nullable(),
  currentVariantId: IdSchema.nullable(),
  currentTitle: z.string().min(1).nullable(),
  currentSku: z.string().min(1).nullable(),
  currentUnitPriceMinor: MinorUnitSchema.nullable(),
  stockAvailableQuantity: z.number().int().safe().nonnegative().nullable(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.reasons).size !== value.reasons.length) {
    ctx.addIssue({ code: "custom", message: "duplicate recreate unavailability reason" });
  }
});

export const EffectiveOrderRecreateLineV1Schema = z.object({
  sourceLineId: IdSchema,
  sourceProductId: IdSchema.nullable(),
  sourceVariantId: IdSchema.nullable(),
  skuSnapshot: z.string().min(1),
  titleSnapshot: z.string().min(1),
  requestedQuantity: z.number().int().safe().positive(),
  effectiveUnitPriceMinor: MinorUnitSchema,
  mapping: z.discriminatedUnion("status", [
    EffectiveOrderRecreateAvailableMappingV1Schema,
    EffectiveOrderRecreateUnavailableMappingV1Schema,
  ]),
}).strict();

export const EffectiveOrderRecreatePrefillV1Schema = z.object({
  schemaVersion: z.literal(1),
  sourceOrder: EffectiveOrderAuditIdentityV1Schema,
  sourceCommercialState: z.enum(["active", "cancelled"]),
  effectiveRevision: z.number().int().nonnegative(),
  currencyCode: CurrencyCodeSchema,
  minorUnitExponent: z.number().int().min(0).max(3),
  cartCommercialSemantics: z.literal("new_sale_current_catalog_pricing_explicit"),
  cartReadiness: z.enum(["ready", "blocked_unavailable_items"]),
  items: z.array(EffectiveOrderRecreateLineV1Schema),
  availableCount: z.number().int().safe().nonnegative(),
  unavailableCount: z.number().int().safe().nonnegative(),
  warningCount: z.number().int().safe().nonnegative(),
  dataQuality: DataQualityV1Schema,
}).strict().superRefine((value, ctx) => {
  const lineIds = value.items.map((line) => line.sourceLineId);
  if (new Set(lineIds).size !== lineIds.length) {
    ctx.addIssue({ code: "custom", message: "duplicate recreate source line" });
  }
  const availableCount = value.items.filter((line) => line.mapping.status === "available").length;
  const unavailableCount = value.items.length - availableCount;
  const warningCount = value.items.filter((line) =>
    line.mapping.status === "unavailable" || line.mapping.priceChanged).length;
  const expectedReadiness = unavailableCount === 0
    ? "ready"
    : "blocked_unavailable_items";
  if (
    value.availableCount !== availableCount
    || value.unavailableCount !== unavailableCount
    || value.warningCount !== warningCount
    || value.cartReadiness !== expectedReadiness
  ) {
    ctx.addIssue({ code: "custom", message: "recreate summary count mismatch" });
  }
});

export type EffectiveOrderRecreatePrefillV1 = z.infer<
  typeof EffectiveOrderRecreatePrefillV1Schema
>;

export const PAYMENT_EVENT_EVIDENCE_V1 = {
  cash: "cash_receipt",
  cod: "cod_order_created",
  manual_bank: "manual_verified",
  provider: "provider_webhook_success",
} as const;

export const PaymentCashEventV1Schema = z.object({
  schemaVersion: z.literal(1),
  eventId: IdSchema,
  idempotencyKey: IdSchema,
  orderId: IdSchema,
  method: z.enum(["cash", "cod", "manual_bank", "provider", "unknown"]),
  kind: z.enum([
    "charge",
    "refund",
    "reversal",
    "chargeback",
    "customer_payable_open",
    "customer_payable_clear",
  ]),
  status: z.enum(["posted", "pending"]),
  evidenceType: z.enum([
    "cash_receipt",
    "cod_order_created",
    "manual_verified",
    "owner_historical_recognition",
    "provider_webhook_success",
    "negative_collection_confirmed",
    "customer_payable_confirmed",
  ]).optional(),
  currencyCode: CurrencyCodeSchema,
  amountMinor: MinorUnitSchema,
  eventAt: IsoDateTimeSchema,
}).strict().superRefine((value, ctx) => {
  if (value.status !== "posted") return;
  const expected = value.kind === "charge"
    ? PAYMENT_EVENT_EVIDENCE_V1[value.method as keyof typeof PAYMENT_EVENT_EVIDENCE_V1]
    : value.kind === "customer_payable_open" || value.kind === "customer_payable_clear"
      ? "customer_payable_confirmed"
      : "negative_collection_confirmed";
  const historicalManualBankRecognition = value.kind === "charge"
    && value.method === "manual_bank"
    && value.evidenceType === "owner_historical_recognition";
  if (!expected || (!historicalManualBankRecognition && value.evidenceType !== expected)) {
    ctx.addIssue({ code: "custom", message: "posted event lacks exact approved evidence" });
  }
});
export type PaymentCashEventV1 = z.infer<typeof PaymentCashEventV1Schema>;

export const DASHBOARD_METRIC_TIME_BASIS_V2 = {
  recordedGrossCollectionsMinor: "payment_event_at",
  refundsMinor: "payment_event_at",
  reversalsMinor: "payment_event_at",
  chargebacksMinor: "payment_event_at",
  currentOrderGrossValueMinor: "effective_order_created_at",
  commercialOutstandingAsOfMinor: "as_of_effective_order_and_payment_events",
  customerRefundPayableAsOfMinor: "as_of_payment_events",
  revenueExcludingVatMinor: "accounting_source_occurred_at",
  vatLiabilityMinor: "accounting_source_occurred_at",
  cogsRecognizedMinor: "accounting_source_occurred_at",
} as const;

export const DashboardMetricTimeBasisV2Schema = z.object({
  recordedGrossCollectionsMinor: z.literal("payment_event_at"),
  refundsMinor: z.literal("payment_event_at"),
  reversalsMinor: z.literal("payment_event_at"),
  chargebacksMinor: z.literal("payment_event_at"),
  currentOrderGrossValueMinor: z.literal("effective_order_created_at"),
  commercialOutstandingAsOfMinor: z.literal("as_of_effective_order_and_payment_events"),
  customerRefundPayableAsOfMinor: z.literal("as_of_payment_events"),
  revenueExcludingVatMinor: z.literal("accounting_source_occurred_at"),
  vatLiabilityMinor: z.literal("accounting_source_occurred_at"),
  cogsRecognizedMinor: z.literal("accounting_source_occurred_at"),
}).strict();
export type DashboardMetricTimeBasisV2 = z.infer<typeof DashboardMetricTimeBasisV2Schema>;

export const DASHBOARD_REPORT_MAX_LOCAL_DAYS = 366 as const;
export const DASHBOARD_SYSTEM_DEFAULT_TIME_ZONE = "Asia/Ho_Chi_Minh" as const;

export const DashboardNormalizedReportScopeV1Schema = z.object({
  scopeKind: z.literal("report"),
  merchantId: IdSchema,
  storeIds: z.array(IdSchema).min(1),
}).strict().superRefine((value, ctx) => {
  const sorted = [...value.storeIds].sort();
  if (new Set(value.storeIds).size !== value.storeIds.length) {
    ctx.addIssue({ code: "custom", message: "duplicate dashboard store scope" });
  }
  if (value.storeIds.some((storeId, index) => storeId !== sorted[index])) {
    ctx.addIssue({ code: "custom", message: "dashboard store scope must be normalized" });
  }
});

export const DashboardLocalDateRangeV1Schema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  inclusiveDays: z.number().int().min(1).max(DASHBOARD_REPORT_MAX_LOCAL_DAYS),
}).strict().superRefine((value, ctx) => {
  const fromEpochMs = Date.parse(`${value.from}T00:00:00.000Z`);
  const toEpochMs = Date.parse(`${value.to}T00:00:00.000Z`);
  const expectedDays = Math.floor((toEpochMs - fromEpochMs) / 86_400_000) + 1;
  if (expectedDays < 1 || expectedDays !== value.inclusiveDays) {
    ctx.addIssue({ code: "custom", message: "dashboard local-date range arithmetic mismatch" });
  }
});

export type DashboardLocalDateRangeV1 = z.infer<typeof DashboardLocalDateRangeV1Schema>;

function refineSortedUniqueDailySeries(
  value: Array<{ localDate: string }>,
  ctx: z.RefinementCtx,
): void {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index]!.localDate <= value[index - 1]!.localDate) {
      ctx.addIssue({
        code: "custom",
        path: [index, "localDate"],
        message: "dashboard daily series labels must be unique and sorted",
      });
    }
  }
}

function safeDailySeriesSum(
  values: number[],
  ctx: z.RefinementCtx,
  message: string,
): number | null {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      ctx.addIssue({ code: "custom", message });
      return null;
    }
  }
  return total;
}

function dailySeriesLabels(value: Array<{ localDate: string }>): string[] {
  return value.map((point) => point.localDate);
}

function dailySeriesLabelsMatch(
  left: Array<{ localDate: string }>,
  right: Array<{ localDate: string }>,
): boolean {
  const leftLabels = dailySeriesLabels(left);
  const rightLabels = dailySeriesLabels(right);
  return leftLabels.length === rightLabels.length
    && leftLabels.every((label, index) => label === rightLabels[index]);
}

export const DashboardDailyActiveOrderCountPointV1Schema = z.object({
  localDate: z.string().date(),
  activeOrderCount: z.number().int().safe().nonnegative(),
}).strict();
export type DashboardDailyActiveOrderCountPointV1 = z.infer<
  typeof DashboardDailyActiveOrderCountPointV1Schema
>;

export const DashboardDailyActiveOrderCountSeriesV1Schema = z.array(
  DashboardDailyActiveOrderCountPointV1Schema,
).min(1).max(DASHBOARD_REPORT_MAX_LOCAL_DAYS).superRefine(
  refineSortedUniqueDailySeries,
);
export type DashboardDailyActiveOrderCountSeriesV1 = z.infer<
  typeof DashboardDailyActiveOrderCountSeriesV1Schema
>;

export const DashboardDailyCurrentOrderGrossValuePointV1Schema = z.object({
  localDate: z.string().date(),
  currentOrderGrossValueMinor: MinorUnitSchema,
}).strict();
export type DashboardDailyCurrentOrderGrossValuePointV1 = z.infer<
  typeof DashboardDailyCurrentOrderGrossValuePointV1Schema
>;

export const DashboardDailyCurrentOrderGrossValueSeriesV1Schema = z.array(
  DashboardDailyCurrentOrderGrossValuePointV1Schema,
).min(1).max(DASHBOARD_REPORT_MAX_LOCAL_DAYS).superRefine(
  refineSortedUniqueDailySeries,
);
export type DashboardDailyCurrentOrderGrossValueSeriesV1 = z.infer<
  typeof DashboardDailyCurrentOrderGrossValueSeriesV1Schema
>;

export const DashboardDailyRecordedGrossCollectionsPointV1Schema = z.object({
  localDate: z.string().date(),
  recordedGrossCollectionsMinor: MinorUnitSchema,
}).strict();
export type DashboardDailyRecordedGrossCollectionsPointV1 = z.infer<
  typeof DashboardDailyRecordedGrossCollectionsPointV1Schema
>;

export const DashboardDailyRecordedGrossCollectionsSeriesV1Schema = z.array(
  DashboardDailyRecordedGrossCollectionsPointV1Schema,
).min(1).max(DASHBOARD_REPORT_MAX_LOCAL_DAYS).superRefine(
  refineSortedUniqueDailySeries,
);
export type DashboardDailyRecordedGrossCollectionsSeriesV1 = z.infer<
  typeof DashboardDailyRecordedGrossCollectionsSeriesV1Schema
>;

export const DashboardStoreTimeWindowV1Schema = z.object({
  storeId: IdSchema,
  timeZone: z.string().min(1).max(64),
  startInclusive: IsoDateTimeSchema,
  endExclusive: IsoDateTimeSchema,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.startInclusive) >= Date.parse(value.endExclusive)) {
    ctx.addIssue({ code: "custom", message: "dashboard store window must be half-open and non-empty" });
  }
});

export const DashboardSnapshotFreshnessV1Schema = z.object({
  databaseSnapshot: z.object({
    status: z.literal("fresh"),
    asOf: IsoDateTimeSchema,
  }).strict(),
}).strict();

export const DashboardReportContextV1Schema = z.object({
  schemaVersion: z.literal(1),
  normalizedScope: DashboardNormalizedReportScopeV1Schema,
  localDateRange: DashboardLocalDateRangeV1Schema,
  storeTimeWindows: z.array(DashboardStoreTimeWindowV1Schema).min(1),
  reportAsOf: IsoDateTimeSchema,
  generatedAt: IsoDateTimeSchema,
  metricTimeBasis: DashboardMetricTimeBasisV2Schema,
  freshness: DashboardSnapshotFreshnessV1Schema,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.reportAsOf) > Date.parse(value.generatedAt)) {
    ctx.addIssue({ code: "custom", message: "reportAsOf cannot be after generatedAt" });
  }
  if (value.freshness.databaseSnapshot.asOf !== value.reportAsOf) {
    ctx.addIssue({ code: "custom", message: "snapshot freshness must use reportAsOf" });
  }
  const windowStoreIds = value.storeTimeWindows.map((window) => window.storeId);
  if (
    windowStoreIds.length !== value.normalizedScope.storeIds.length
    || windowStoreIds.some((storeId, index) => storeId !== value.normalizedScope.storeIds[index])
  ) {
    ctx.addIssue({ code: "custom", message: "dashboard store windows must exactly match normalized scope" });
  }
});
export type DashboardReportContextV1 = z.infer<typeof DashboardReportContextV1Schema>;
export type DashboardStoreTimeWindowV1 = z.infer<typeof DashboardStoreTimeWindowV1Schema>;

export const DashboardCommercialTopProductV1Schema = z.object({
  productId: IdSchema.nullable(),
  variantId: IdSchema.nullable(),
  skuSnapshot: z.string().min(1),
  titleSnapshot: z.string().min(1),
  archivedVariant: z.boolean(),
  quantity: z.number().int().positive(),
  grossLineSalesBeforeDiscountMinor: MinorUnitSchema,
  currentCogsMinor: MinorUnitSchema.nullable(),
  costCoverage: CostCoverageV1Schema,
}).strict().superRefine((value, ctx) => {
  const completeCost = value.costCoverage.knownLines === value.costCoverage.totalLines;
  if (completeCost !== (value.currentCogsMinor !== null)) {
    ctx.addIssue({ code: "custom", message: "top-product COGS must match cost coverage" });
  }
});
export type DashboardCommercialTopProductV1 = z.infer<
  typeof DashboardCommercialTopProductV1Schema
>;

export const DashboardCommercialCurrencyV1Schema = z.object({
  currencyCode: CurrencyCodeSchema,
  minorUnitExponent: z.number().int().min(0).max(3),
  validOrderCount: z.number().int().nonnegative(),
  cancelledOrderCohortCount: z.number().int().nonnegative(),
  activeOrdersWithShippingCount: z.number().int().nonnegative(),
  currentOrderGrossValueMinor: MinorUnitSchema,
  dailyCurrentOrderGrossValueSeries:
    DashboardDailyCurrentOrderGrossValueSeriesV1Schema.optional(),
  currentMerchandiseGrossValueMinor: MinorUnitSchema,
  currentDiscountMinor: MinorUnitSchema,
  currentMerchandiseRevenueExVatMinor: MinorUnitSchema,
  currentShippingRevenueExVatMinor: MinorUnitSchema,
  currentShippingGrossValueMinor: MinorUnitSchema,
  currentShippingSharePercent: z.number().finite().min(0).max(100).nullable(),
  currentVatMinor: MinorUnitSchema,
  currentUnclassifiedMinor: MinorUnitSchema,
  effectiveItemQuantity: z.number().int().nonnegative(),
  averageCurrentOrderValueMinor: MinorUnitSchema.nullable(),
  currentCogsMinor: MinorUnitSchema.nullable(),
  currentMerchandiseGrossProfitMinor: z.number().int().safe().nullable(),
  currentContributionBeforeShippingCostMinor: z.number().int().safe().nullable(),
  costCoverage: CostCoverageV1Schema,
  dataQuality: DataQualityV1Schema,
  topProducts: z.array(DashboardCommercialTopProductV1Schema),
}).strict().superRefine((value, ctx) => {
  if (
    value.currentMerchandiseGrossValueMinor - value.currentDiscountMinor
    < value.currentMerchandiseRevenueExVatMinor
  ) {
    ctx.addIssue({ code: "custom", message: "commercial merchandise revenue exceeds payable" });
  }
  if (value.dailyCurrentOrderGrossValueSeries) {
    const dailyTotal = safeDailySeriesSum(
      value.dailyCurrentOrderGrossValueSeries.map(
        (point) => point.currentOrderGrossValueMinor,
      ),
      ctx,
      "commercial daily order gross exceeds safe integer",
    );
    if (dailyTotal !== null && dailyTotal !== value.currentOrderGrossValueMinor) {
      ctx.addIssue({ code: "custom", message: "commercial daily order gross mismatch" });
    }
  }
  if (
    value.currentMerchandiseRevenueExVatMinor
      + value.currentShippingRevenueExVatMinor
      + value.currentVatMinor
      + value.currentUnclassifiedMinor
    !== value.currentOrderGrossValueMinor
  ) {
    ctx.addIssue({ code: "custom", message: "commercial order gross arithmetic mismatch" });
  }
  if (value.activeOrdersWithShippingCount > value.validOrderCount) {
    ctx.addIssue({ code: "custom", message: "shipping order count exceeds active order count" });
  }
  if (
    (value.activeOrdersWithShippingCount === 0)
    !== (value.currentShippingGrossValueMinor === 0)
  ) {
    ctx.addIssue({ code: "custom", message: "shipping count/value presence mismatch" });
  }
  if (value.currentShippingGrossValueMinor > value.currentOrderGrossValueMinor) {
    ctx.addIssue({ code: "custom", message: "shipping gross exceeds current order gross" });
  }
  if (
    value.currentShippingSharePercent
    !== percentageOneDecimalHalfUp(
      value.currentShippingGrossValueMinor,
      value.currentOrderGrossValueMinor,
    )
  ) {
    ctx.addIssue({ code: "custom", message: "commercial shipping share mismatch" });
  }
  const expectedAverage = value.validOrderCount === 0
    ? null
    : Math.round(value.currentOrderGrossValueMinor / value.validOrderCount);
  if (value.averageCurrentOrderValueMinor !== expectedAverage) {
    ctx.addIssue({ code: "custom", message: "commercial average order value mismatch" });
  }
  if (
    value.costCoverage.knownLines !== value.dataQuality.costCoverage.knownLines
    || value.costCoverage.totalLines !== value.dataQuality.costCoverage.totalLines
  ) {
    ctx.addIssue({ code: "custom", message: "commercial cost coverage mismatch" });
  }
  const hasCompleteCost = value.costCoverage.knownLines === value.costCoverage.totalLines;
  if (hasCompleteCost !== (value.currentCogsMinor !== null)) {
    ctx.addIssue({ code: "custom", message: "commercial COGS must match cost coverage" });
  }
  if (value.currentCogsMinor === null) {
    if (
      value.currentMerchandiseGrossProfitMinor !== null
      || value.currentContributionBeforeShippingCostMinor !== null
    ) {
      ctx.addIssue({ code: "custom", message: "commercial profit requires complete COGS" });
    }
  } else {
    if (
      value.currentMerchandiseGrossProfitMinor
      !== value.currentMerchandiseRevenueExVatMinor - value.currentCogsMinor
    ) {
      ctx.addIssue({ code: "custom", message: "commercial merchandise profit mismatch" });
    }
    if (
      value.currentContributionBeforeShippingCostMinor
      !== value.currentMerchandiseRevenueExVatMinor
        + value.currentShippingRevenueExVatMinor
        - value.currentCogsMinor
    ) {
      ctx.addIssue({ code: "custom", message: "commercial contribution mismatch" });
    }
  }
});
export type DashboardCommercialCurrencyV1 = z.infer<
  typeof DashboardCommercialCurrencyV1Schema
>;

export const DashboardCommercialSliceV1Schema = z.object({
  schemaVersion: z.literal(1),
  dailyActiveOrderCountSeries: DashboardDailyActiveOrderCountSeriesV1Schema.optional(),
  currencies: z.array(DashboardCommercialCurrencyV1Schema),
}).strict().superRefine((value, ctx) => {
  const currencyCodes = value.currencies.map((currency) => currency.currencyCode);
  if (new Set(currencyCodes).size !== currencyCodes.length) {
    ctx.addIssue({ code: "custom", message: "duplicate commercial dashboard currency block" });
  }
  const sortedCodes = [...currencyCodes].sort();
  if (currencyCodes.some((currencyCode, index) => currencyCode !== sortedCodes[index])) {
    ctx.addIssue({ code: "custom", message: "commercial dashboard currency blocks must be sorted" });
  }
  if (value.dailyActiveOrderCountSeries) {
    const dailyActiveOrderCount = safeDailySeriesSum(
      value.dailyActiveOrderCountSeries.map((point) => point.activeOrderCount),
      ctx,
      "commercial daily active order count exceeds safe integer",
    );
    const validOrderCount = safeDailySeriesSum(
      value.currencies.map((currency) => currency.validOrderCount),
      ctx,
      "commercial valid order count exceeds safe integer",
    );
    if (
      dailyActiveOrderCount !== null
      && validOrderCount !== null
      && dailyActiveOrderCount !== validOrderCount
    ) {
      ctx.addIssue({ code: "custom", message: "commercial daily active order count mismatch" });
    }
    for (const [index, currency] of value.currencies.entries()) {
      if (!currency.dailyCurrentOrderGrossValueSeries) {
        ctx.addIssue({
          code: "custom",
          path: ["currencies", index, "dailyCurrentOrderGrossValueSeries"],
          message: "commercial daily series must be attached as one complete dependency",
        });
      } else if (!dailySeriesLabelsMatch(
        value.dailyActiveOrderCountSeries,
        currency.dailyCurrentOrderGrossValueSeries,
      )) {
        ctx.addIssue({
          code: "custom",
          path: ["currencies", index, "dailyCurrentOrderGrossValueSeries"],
          message: "commercial daily series labels must match",
        });
      }
    }
  } else if (value.currencies.some(
    (currency) => currency.dailyCurrentOrderGrossValueSeries !== undefined,
  )) {
    ctx.addIssue({
      code: "custom",
      message: "commercial daily series must include active-order labels",
    });
  }
});
export type DashboardCommercialSliceV1 = z.infer<typeof DashboardCommercialSliceV1Schema>;

export const DashboardOperationalInventoryIssueV1Schema = z.enum([
  "blank_selected_stock_location",
  "missing_reorder_level",
  "negative_stock",
]);
export type DashboardOperationalInventoryIssueV1 = z.infer<
  typeof DashboardOperationalInventoryIssueV1Schema
>;

export const DashboardOperationalAiIssueV1Schema = z.enum([
  "ambiguous_merchant_ai_ownership",
]);
export type DashboardOperationalAiIssueV1 = z.infer<
  typeof DashboardOperationalAiIssueV1Schema
>;

export const DashboardOperationalSnapshotV1Schema = z.object({
  schemaVersion: z.literal(1),
  reportMerchantAiReviewQueue: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("available"),
      dataQualityStatus: z.literal("complete"),
      pendingOrReviewRequiredCount: z.number().int().safe().nonnegative(),
    }).strict(),
    z.object({
      status: z.literal("unavailable"),
      dataQualityStatus: z.literal("unavailable"),
      issues: z.array(DashboardOperationalAiIssueV1Schema).min(1),
    }).strict().superRefine((value, ctx) => {
      const sorted = [...value.issues].sort();
      if (
        new Set(value.issues).size !== value.issues.length
        || value.issues.some((issue, index) => issue !== sorted[index])
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["issues"],
          message: "operational AI issues must be unique and sorted",
        });
      }
    }),
  ]).optional(),
  reportMerchantCatalog: z.object({
    status: z.literal("available"),
    dataQualityStatus: z.literal("complete"),
    publishedSkuCount: z.number().int().safe().nonnegative(),
  }).strict(),
  reportMerchantCustomerAcquisition: z.object({
    status: z.literal("available"),
    dataQualityStatus: z.literal("complete"),
    attributionScope: z.literal("report_merchant"),
    businessTimeZone: z.literal(DASHBOARD_SYSTEM_DEFAULT_TIME_ZONE),
    newCustomerCount: z.number().int().safe().nonnegative(),
  }).strict().optional(),
  selectedReportStoresInventory: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("available"),
      dataQualityStatus: z.literal("complete"),
      inventoryVariantLocationCount: z.number().int().safe().nonnegative(),
      lowStockVariantLocationCount: z.number().int().safe().nonnegative(),
      outOfStockVariantLocationCount: z.number().int().safe().nonnegative(),
    }).strict().superRefine((value, ctx) => {
      if (
        value.lowStockVariantLocationCount + value.outOfStockVariantLocationCount
        > value.inventoryVariantLocationCount
      ) {
        ctx.addIssue({
          code: "custom",
          message: "operational inventory factor counts exceed the exact grain count",
        });
      }
    }),
    z.object({
      status: z.literal("unavailable"),
      dataQualityStatus: z.literal("unavailable"),
      issues: z.array(DashboardOperationalInventoryIssueV1Schema).min(1),
    }).strict().superRefine((value, ctx) => {
      const sorted = [...value.issues].sort();
      if (
        new Set(value.issues).size !== value.issues.length
        || value.issues.some((issue, index) => issue !== sorted[index])
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["issues"],
          message: "operational inventory issues must be unique and sorted",
        });
      }
    }),
  ]),
}).strict();
export type DashboardOperationalSnapshotV1 = z.infer<
  typeof DashboardOperationalSnapshotV1Schema
>;

export const DashboardAccountingIssueV1Schema = z.enum([
  "fractional_minor_units",
  "incomplete_cost_provenance",
  "missing_source_mapping",
  "unbalanced_journal",
  "unsupported_currency",
  "unsupported_reference_type",
]);
export type DashboardAccountingIssueV1 = z.infer<
  typeof DashboardAccountingIssueV1Schema
>;

const profitCoverageCounts = {
  totalJournalCount: z.number().int().safe().nonnegative(),
  coveredJournalCount: z.number().int().safe().nonnegative(),
  excludedJournalCount: z.number().int().safe().nonnegative(),
};
const verifiedProfitNumbers = {
  verifiedSubsetRevenueExcludingVatMinor: SignedMinorUnitSchema,
  verifiedSubsetCogsRecognizedMinor: SignedMinorUnitSchema,
  verifiedSubsetGrossProfitMinor: SignedMinorUnitSchema,
};
export const DashboardAccountingProfitCoverageV1Schema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("exact"), ...profitCoverageCounts, ...verifiedProfitNumbers,
    exactGrossProfitMinor: SignedMinorUnitSchema,
    issues: z.array(DashboardAccountingIssueV1Schema).length(0),
  }).strict(),
  z.object({
    status: z.literal("partial"), ...profitCoverageCounts, ...verifiedProfitNumbers,
    exactGrossProfitMinor: z.null(),
    issues: z.tuple([z.literal("incomplete_cost_provenance")]),
  }).strict(),
  z.object({
    status: z.literal("unavailable"), ...profitCoverageCounts,
    exactGrossProfitMinor: z.null(),
    verifiedSubsetRevenueExcludingVatMinor: z.null(),
    verifiedSubsetCogsRecognizedMinor: z.null(),
    verifiedSubsetGrossProfitMinor: z.null(),
    issues: z.array(DashboardAccountingIssueV1Schema).min(1),
  }).strict(),
]).superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (value.coveredJournalCount + value.excludedJournalCount !== value.totalJournalCount) fail("profit coverage counts mismatch");
  if (new Set(value.issues).size !== value.issues.length || [...value.issues].sort().some((issue, i) => issue !== value.issues[i])) fail("profit coverage issues must be unique and sorted");
  if (value.status === "unavailable") {
    if (value.issues.every(issue => issue === "incomplete_cost_provenance") && (value.coveredJournalCount !== 0 || value.totalJournalCount === 0)) fail("missing-cost unavailable requires no covered journals in nonempty period");
    return;
  }
  const profit = value.verifiedSubsetRevenueExcludingVatMinor - value.verifiedSubsetCogsRecognizedMinor;
  if (!Number.isSafeInteger(profit) || profit !== value.verifiedSubsetGrossProfitMinor) fail("verified profit arithmetic mismatch");
  if (value.status === "partial" && !(value.coveredJournalCount > 0 && value.excludedJournalCount > 0)) fail("partial coverage must be a nonempty proper subset");
  if (value.status === "exact" && (value.excludedJournalCount !== 0 || value.exactGrossProfitMinor !== profit)) fail("exact coverage mismatch");
  if (value.totalJournalCount === 0 && (value.verifiedSubsetRevenueExcludingVatMinor !== 0 || value.verifiedSubsetCogsRecognizedMinor !== 0)) fail("empty profit must be zero");
});
export type DashboardAccountingProfitCoverageV1 = z.infer<typeof DashboardAccountingProfitCoverageV1Schema>;

export const DashboardAccountingCurrencyV1Schema = z.discriminatedUnion("status", [
  z.object({
    currencyCode: CurrencyCodeSchema,
    minorUnitExponent: z.number().int().min(0).max(3),
    status: z.literal("available"),
    dataQualityStatus: z.literal("complete"),
    postedJournalCount: z.number().int().safe().nonnegative(),
    revenueExcludingVatMinor: SignedMinorUnitSchema,
    cogsRecognizedMinor: SignedMinorUnitSchema,
    grossProfitMinor: SignedMinorUnitSchema,
    grossMarginPercent: z.number().finite().nullable(),
  }).strict().superRefine((value, ctx) => {
    if (
      value.revenueExcludingVatMinor - value.cogsRecognizedMinor
      !== value.grossProfitMinor
    ) {
      ctx.addIssue({ code: "custom", message: "accounting gross profit arithmetic mismatch" });
    }
    if (
      value.revenueExcludingVatMinor <= 0
      && value.grossMarginPercent !== null
    ) {
      ctx.addIssue({
        code: "custom",
        message: "accounting gross margin requires a positive revenue denominator",
      });
    }
    if (
      value.grossMarginPercent
      !== signedPercentageOneDecimalHalfUp(
        value.grossProfitMinor,
        value.revenueExcludingVatMinor,
      )
    ) {
      ctx.addIssue({ code: "custom", message: "accounting gross margin arithmetic mismatch" });
    }
  }),
  z.object({
    currencyCode: CurrencyCodeSchema,
    minorUnitExponent: z.number().int().min(0).max(3),
    status: z.literal("unavailable"),
    dataQualityStatus: z.literal("unavailable"),
    issues: z.array(DashboardAccountingIssueV1Schema).min(1),
  }).strict().superRefine((value, ctx) => {
    const sorted = [...value.issues].sort();
    if (
      new Set(value.issues).size !== value.issues.length
      || value.issues.some((issue, index) => issue !== sorted[index])
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["issues"],
        message: "accounting issues must be unique and sorted",
      });
    }
  }),
]);
export type DashboardAccountingCurrencyV1 = z.infer<
  typeof DashboardAccountingCurrencyV1Schema
>;

export const DashboardAccountingSliceV1Schema = z.object({
  schemaVersion: z.literal(1),
  aggregateReadSource: z.literal("accounting.journal_entries"),
  currencies: z.array(DashboardAccountingCurrencyV1Schema).min(1),
  profitCoverage: z.array(z.object({
    currencyCode: CurrencyCodeSchema,
    minorUnitExponent: z.number().int().min(0).max(3),
    coverage: DashboardAccountingProfitCoverageV1Schema,
  }).strict()).optional(),
}).strict().superRefine((value, ctx) => {
  const currencyCodes = value.currencies.map((currency) => currency.currencyCode);
  if (value.profitCoverage && (value.profitCoverage.length !== value.currencies.length || value.profitCoverage.some((entry, i) => entry.currencyCode !== value.currencies[i]?.currencyCode || entry.minorUnitExponent !== value.currencies[i]?.minorUnitExponent))) {
    ctx.addIssue({ code: "custom", message: "profit coverage currency identity mismatch" });
  }
  const sorted = [...currencyCodes].sort();
  if (
    new Set(currencyCodes).size !== currencyCodes.length
    || currencyCodes.some((currencyCode, index) => currencyCode !== sorted[index])
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["currencies"],
      message: "accounting currencies must be unique and sorted",
    });
  }
});
export type DashboardAccountingSliceV1 = z.infer<
  typeof DashboardAccountingSliceV1Schema
>;

export const RecordedGrossCollectionComponentsV1Schema = z.object({
  taxModes: z.array(z.enum(["exclusive", "inclusive"])).min(1).max(2),
  merchandiseGrossMinor: SignedMinorUnitSchema,
  discountMinor: SignedMinorUnitSchema,
  merchandiseNetMinor: SignedMinorUnitSchema,
  shippingMinor: SignedMinorUnitSchema,
  merchandiseVatMinor: SignedMinorUnitSchema,
  shippingVatMinor: SignedMinorUnitSchema,
  vatMinor: SignedMinorUnitSchema,
  vatIncludedInPriceMinor: SignedMinorUnitSchema,
  vatAddedToPriceMinor: SignedMinorUnitSchema,
  unclassifiedMinor: SignedMinorUnitSchema,
  totalMinor: MinorUnitSchema,
}).strict().superRefine((value, ctx) => {
  const sortedTaxModes = [...value.taxModes].sort();
  if (
    new Set(value.taxModes).size !== value.taxModes.length
    || value.taxModes.some((taxMode, index) => taxMode !== sortedTaxModes[index])
  ) {
    ctx.addIssue({ code: "custom", message: "collection tax modes must be unique and sorted" });
  }
  if (value.merchandiseGrossMinor - value.discountMinor !== value.merchandiseNetMinor) {
    ctx.addIssue({ code: "custom", message: "collection merchandise net mismatch" });
  }
  const attributedVat = value.merchandiseVatMinor + value.shippingVatMinor;
  const classifiedVat = value.vatIncludedInPriceMinor + value.vatAddedToPriceMinor;
  if (
    !Number.isSafeInteger(attributedVat)
    || attributedVat !== value.vatMinor
    || !Number.isSafeInteger(classifiedVat)
    || classifiedVat !== value.vatMinor
  ) {
    ctx.addIssue({ code: "custom", message: "collection VAT attribution mismatch" });
  }
  if (!value.taxModes.includes("inclusive") && value.vatIncludedInPriceMinor !== 0) {
    ctx.addIssue({ code: "custom", message: "included VAT requires inclusive collection facts" });
  }
  if (!value.taxModes.includes("exclusive") && value.vatAddedToPriceMinor !== 0) {
    ctx.addIssue({ code: "custom", message: "added VAT requires exclusive collection facts" });
  }
  const total = value.merchandiseNetMinor
    + value.shippingMinor
    + value.unclassifiedMinor
    + value.vatAddedToPriceMinor;
  if (!Number.isSafeInteger(total) || total !== value.totalMinor) {
    ctx.addIssue({ code: "custom", message: "collection component total mismatch" });
  }
});
export type RecordedGrossCollectionComponentsV1 = z.infer<
  typeof RecordedGrossCollectionComponentsV1Schema
>;

const RecordedGrossCollectionCurrencyV1Object = z.object({
  currencyCode: CurrencyCodeSchema,
  minorUnitExponent: z.number().int().min(0).max(3),
  postedChargeEventCount: z.number().int().safe().positive(),
  bundleCoverage: z.object({
    validEvents: z.number().int().safe().nonnegative(),
    totalEvents: z.number().int().safe().positive(),
  }).strict(),
  recordedGrossCollectionsMinor: MinorUnitSchema,
  dailyRecordedGrossCollectionsSeries:
    DashboardDailyRecordedGrossCollectionsSeriesV1Schema.optional(),
  components: RecordedGrossCollectionComponentsV1Schema,
}).strict();
function validateRecordedCollectionCurrency(value: z.infer<typeof RecordedGrossCollectionCurrencyV1Object>, ctx: z.RefinementCtx) {
  if (
    value.bundleCoverage.validEvents !== value.bundleCoverage.totalEvents
    || value.bundleCoverage.totalEvents !== value.postedChargeEventCount
  ) {
    ctx.addIssue({ code: "custom", message: "recorded collection bundle coverage is incomplete" });
  }
  if (value.components.totalMinor !== value.recordedGrossCollectionsMinor) {
    ctx.addIssue({ code: "custom", message: "recorded collection headline mismatch" });
  }
  if (value.dailyRecordedGrossCollectionsSeries) {
    const dailyTotal = safeDailySeriesSum(
      value.dailyRecordedGrossCollectionsSeries.map(
        (point) => point.recordedGrossCollectionsMinor,
      ),
      ctx,
      "recorded collection daily total exceeds safe integer",
    );
    if (dailyTotal !== null && dailyTotal !== value.recordedGrossCollectionsMinor) {
      ctx.addIssue({ code: "custom", message: "recorded collection daily headline mismatch" });
    }
  }
}
export const RecordedGrossCollectionCurrencyV1Schema = RecordedGrossCollectionCurrencyV1Object.superRefine(validateRecordedCollectionCurrency);
export type RecordedGrossCollectionCurrencyV1 = z.infer<
  typeof RecordedGrossCollectionCurrencyV1Schema
>;

const RecordedGrossCollectionSliceV1Object = z.object({
  schemaVersion: z.literal(1),
  aggregateReadSource: z.literal("app.payment_events"),
  currencies: z.array(RecordedGrossCollectionCurrencyV1Schema),
}).strict();
function validateRecordedCollectionSlice(value: Omit<z.infer<typeof RecordedGrossCollectionSliceV1Object>, "schemaVersion">, ctx: z.RefinementCtx) {
  const currencyCodes = value.currencies.map((currency) => currency.currencyCode);
  if (new Set(currencyCodes).size !== currencyCodes.length) {
    ctx.addIssue({ code: "custom", message: "duplicate recorded collection currency block" });
  }
  const sortedCurrencyCodes = [...currencyCodes].sort();
  if (currencyCodes.some((currencyCode, index) => currencyCode !== sortedCurrencyCodes[index])) {
    ctx.addIssue({ code: "custom", message: "recorded collection currencies must be sorted" });
  }
  const firstDailySeries = value.currencies.find(
    (currency) => currency.dailyRecordedGrossCollectionsSeries,
  )?.dailyRecordedGrossCollectionsSeries;
  if (firstDailySeries) {
    for (const [index, currency] of value.currencies.entries()) {
      if (!currency.dailyRecordedGrossCollectionsSeries) {
        ctx.addIssue({
          code: "custom",
          path: ["currencies", index, "dailyRecordedGrossCollectionsSeries"],
          message: "recorded collection daily series must be attached for every currency",
        });
      } else if (!dailySeriesLabelsMatch(
        firstDailySeries,
        currency.dailyRecordedGrossCollectionsSeries,
      )) {
        ctx.addIssue({
          code: "custom",
          path: ["currencies", index, "dailyRecordedGrossCollectionsSeries"],
          message: "recorded collection daily series labels must match",
        });
      }
    }
  }
}
export const RecordedGrossCollectionSliceV1Schema = RecordedGrossCollectionSliceV1Object.superRefine(validateRecordedCollectionSlice);
export type RecordedGrossCollectionSliceV1 = z.infer<
  typeof RecordedGrossCollectionSliceV1Schema
>;

export const RecordedGrossCollectionComponentsV2Schema = z.object({
  ...RecordedGrossCollectionComponentsV1Schema.shape,
  paymentFeeMinor: SignedMinorUnitSchema, paymentFeeVatMinor: SignedMinorUnitSchema,
  paymentFeeVatIncludedInPriceMinor: SignedMinorUnitSchema, paymentFeeVatAddedToPriceMinor: SignedMinorUnitSchema,
}).strict().superRefine((value, ctx) => {
  const fail = () => ctx.addIssue({ code: "custom", message: "Fee-aware recorded collection component arithmetic mismatch" });
  if (!Object.values(value).filter(item => typeof item === "number").every(Number.isSafeInteger)) { fail(); return; }
  if (JSON.stringify(value.taxModes) !== JSON.stringify([...new Set(value.taxModes)].sort())) fail();
  const vat = BigInt(value.vatMinor), feeVat = BigInt(value.paymentFeeVatMinor);
  if (BigInt(value.merchandiseGrossMinor) - BigInt(value.discountMinor) !== BigInt(value.merchandiseNetMinor)
    || BigInt(value.merchandiseVatMinor) + BigInt(value.shippingVatMinor) + feeVat !== vat
    || BigInt(value.vatIncludedInPriceMinor) + BigInt(value.vatAddedToPriceMinor) !== vat
    || BigInt(value.paymentFeeVatIncludedInPriceMinor) + BigInt(value.paymentFeeVatAddedToPriceMinor) !== feeVat
    || BigInt(value.merchandiseNetMinor) + BigInt(value.shippingMinor) + BigInt(value.paymentFeeMinor)
      + BigInt(value.unclassifiedMinor) + BigInt(value.vatAddedToPriceMinor) !== BigInt(value.totalMinor)) fail();
  if ((!value.taxModes.includes("inclusive") && (value.vatIncludedInPriceMinor !== 0 || value.paymentFeeVatIncludedInPriceMinor !== 0))
    || (!value.taxModes.includes("exclusive") && (value.vatAddedToPriceMinor !== 0 || value.paymentFeeVatAddedToPriceMinor !== 0))) fail();
});
export type RecordedGrossCollectionComponentsV2 = z.infer<typeof RecordedGrossCollectionComponentsV2Schema>;
export const RecordedGrossCollectionCurrencyV2Schema = z.object({
  ...RecordedGrossCollectionCurrencyV1Object.shape, components: RecordedGrossCollectionComponentsV2Schema,
}).strict().superRefine((value, ctx) => {
  validateRecordedCollectionCurrency(value, ctx);
  if ([value.components.paymentFeeMinor, value.components.paymentFeeVatMinor, value.components.paymentFeeVatIncludedInPriceMinor,
    value.components.paymentFeeVatAddedToPriceMinor].some(amount => amount !== 0) && (value.currencyCode !== "VND" || value.minorUnitExponent !== 0)) {
    ctx.addIssue({ code: "custom", message: "Payment surcharges require integer VND" });
  }
});
export type RecordedGrossCollectionCurrencyV2 = z.infer<typeof RecordedGrossCollectionCurrencyV2Schema>;
export const RecordedGrossCollectionSliceV2Schema = z.object({
  ...RecordedGrossCollectionSliceV1Object.shape, schemaVersion: z.literal(2), currencies: z.array(RecordedGrossCollectionCurrencyV2Schema),
}).strict().superRefine(validateRecordedCollectionSlice);
export type RecordedGrossCollectionSliceV2 = z.infer<typeof RecordedGrossCollectionSliceV2Schema>;


export const DASHBOARD_PARTIAL_UNAVAILABLE_METRICS_V1 = [
  "refundsMinor",
  "reversalsMinor",
  "chargebacksMinor",
  "negativeCollectionsMinor",
  "netCollectionsMinor",
  "commercialOutstandingAsOfMinor",
  "customerRefundPayableAsOfMinor",
  "revenueExcludingVatMinor",
  "vatLiabilityMinor",
  "cogsRecognizedMinor",
  "providerFeesMinor",
  "netProviderPayoutMinor",
] as const;

const DashboardPartialUnavailableMetricV1Schema = z.enum(
  DASHBOARD_PARTIAL_UNAVAILABLE_METRICS_V1,
);

const DashboardPartialCurrentOrderV1Schema = z.object({
  validOrderCount: z.number().int().safe().nonnegative(),
  currentOrderGrossValueMinor: MinorUnitSchema,
  currentVatMinor: MinorUnitSchema,
  currentUnclassifiedMinor: MinorUnitSchema,
  dataQualityStatus: z.enum(["complete", "partial", "unavailable"]),
  commercialMetrics: z.object({
    cancelledOrderCohortCount: z.number().int().safe().nonnegative(),
    activeOrdersWithShippingCount: z.number().int().safe().nonnegative(),
    currentMerchandiseGrossValueMinor: MinorUnitSchema,
    currentDiscountMinor: MinorUnitSchema,
    currentMerchandiseRevenueExVatMinor: MinorUnitSchema,
    currentShippingRevenueExVatMinor: MinorUnitSchema,
    currentShippingGrossValueMinor: MinorUnitSchema,
    currentShippingSharePercent: z.number().finite().min(0).max(100).nullable(),
    effectiveItemQuantity: z.number().int().safe().nonnegative(),
    averageCurrentOrderValueMinor: MinorUnitSchema.nullable(),
    currentCogsMinor: MinorUnitSchema.nullable(),
    currentMerchandiseGrossProfitMinor: z.number().int().safe().nullable(),
    currentContributionBeforeShippingCostMinor: z.number().int().safe().nullable(),
    topProducts: z.array(DashboardCommercialTopProductV1Schema),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  const attributed = value.currentVatMinor + value.currentUnclassifiedMinor;
  if (!Number.isSafeInteger(attributed) || attributed > value.currentOrderGrossValueMinor) {
    ctx.addIssue({ code: "custom", message: "partial current-order attribution exceeds gross" });
  }
  if (
    value.validOrderCount === 0
    && (
      value.currentOrderGrossValueMinor !== 0
      || value.currentVatMinor !== 0
      || value.currentUnclassifiedMinor !== 0
    )
  ) {
    ctx.addIssue({ code: "custom", message: "empty current-order cohort must have zero value" });
  }
  if (value.commercialMetrics) {
    const expectedAverage = value.validOrderCount === 0
      ? null
      : Math.round(value.currentOrderGrossValueMinor / value.validOrderCount);
    if (value.commercialMetrics.averageCurrentOrderValueMinor !== expectedAverage) {
      ctx.addIssue({ code: "custom", message: "partial current-order average mismatch" });
    }
    if (
      value.commercialMetrics.currentMerchandiseRevenueExVatMinor
        + value.commercialMetrics.currentShippingRevenueExVatMinor
        + value.currentVatMinor
        + value.currentUnclassifiedMinor
      !== value.currentOrderGrossValueMinor
    ) {
      ctx.addIssue({ code: "custom", message: "partial current-order component mismatch" });
    }
    if (
      value.commercialMetrics.activeOrdersWithShippingCount
      > value.validOrderCount
    ) {
      ctx.addIssue({
        code: "custom",
        message: "partial shipping order count exceeds active order count",
      });
    }
    if (
      (value.commercialMetrics.activeOrdersWithShippingCount === 0)
      !== (value.commercialMetrics.currentShippingGrossValueMinor === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "partial shipping count/value presence mismatch",
      });
    }
    if (
      value.commercialMetrics.currentShippingGrossValueMinor
      > value.currentOrderGrossValueMinor
    ) {
      ctx.addIssue({
        code: "custom",
        message: "partial shipping gross exceeds current order gross",
      });
    }
    if (
      value.commercialMetrics.currentShippingSharePercent
      !== percentageOneDecimalHalfUp(
        value.commercialMetrics.currentShippingGrossValueMinor,
        value.currentOrderGrossValueMinor,
      )
    ) {
      ctx.addIssue({ code: "custom", message: "partial shipping share mismatch" });
    }
  }
});

const DashboardPartialRecordedCollectionV1Schema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("none_in_selected_window"),
    postedChargeEventCount: z.literal(0),
    recordedGrossCollectionsMinor: z.literal(0),
    components: z.null(),
  }).strict(),
  z.object({
    status: z.literal("available"),
    postedChargeEventCount: z.number().int().safe().positive(),
    recordedGrossCollectionsMinor: MinorUnitSchema,
    components: RecordedGrossCollectionComponentsV1Schema,
  }).strict().superRefine((value, ctx) => {
    if (value.recordedGrossCollectionsMinor !== value.components.totalMinor) {
      ctx.addIssue({ code: "custom", message: "partial collection headline mismatch" });
    }
  }),
]);

const DashboardPaymentFlowV1Schema = z.object({
  postedRefundEventCount: z.number().int().safe().nonnegative(),
  postedReversalEventCount: z.number().int().safe().nonnegative(),
  postedChargebackEventCount: z.number().int().safe().nonnegative(),
  refundsMinor: MinorUnitSchema,
  reversalsMinor: MinorUnitSchema,
  chargebacksMinor: MinorUnitSchema,
  negativeCollectionsMinor: MinorUnitSchema,
  netCollectionsMinor: SignedMinorUnitSchema,
  customerRefundPayableAsOfMinor: MinorUnitSchema,
  methods: z.array(z.object({
    method: z.string().min(1),
    postedChargeOrderCount: z.number().int().safe().nonnegative(),
    postedNegativeEventCount: z.number().int().safe().nonnegative(),
    recordedGrossCollectionsMinor: MinorUnitSchema,
    recordedNegativeCollectionsMinor: MinorUnitSchema,
    recordedNetCollectionsMinor: SignedMinorUnitSchema,
  }).strict().superRefine((value, ctx) => {
    if (
      value.recordedGrossCollectionsMinor - value.recordedNegativeCollectionsMinor
      !== value.recordedNetCollectionsMinor
    ) {
      ctx.addIssue({ code: "custom", message: "dashboard method net collection mismatch" });
    }
  })).optional(),
}).strict().superRefine((value, ctx) => {
  const negative = value.refundsMinor + value.reversalsMinor + value.chargebacksMinor;
  if (!Number.isSafeInteger(negative) || negative !== value.negativeCollectionsMinor) {
    ctx.addIssue({ code: "custom", message: "dashboard negative collection mismatch" });
  }
});

export const DashboardPartialFinancialCurrencyV1Schema = z.object({
  currencyCode: CurrencyCodeSchema,
  minorUnitExponent: z.number().int().min(0).max(3),
  dailyCurrentOrderGrossValueSeries:
    DashboardDailyCurrentOrderGrossValueSeriesV1Schema.optional(),
  dailyRecordedGrossCollectionsSeries:
    DashboardDailyRecordedGrossCollectionsSeriesV1Schema.optional(),
  currentOrder: DashboardPartialCurrentOrderV1Schema,
  recordedCollection: DashboardPartialRecordedCollectionV1Schema,
  paymentFlow: DashboardPaymentFlowV1Schema.optional(),
  accounting: DashboardAccountingCurrencyV1Schema.optional(),
  accountingProfitCoverage: DashboardAccountingProfitCoverageV1Schema.optional(),
  recordedCollectionMinusCurrentOrderValueMinor: z.number().int().safe(),
  unavailableMetrics: z.array(DashboardPartialUnavailableMetricV1Schema),
}).strict().superRefine((value, ctx) => {
  const coverage = value.accountingProfitCoverage;
  if (coverage) {
    if (!value.accounting || (coverage.status === "exact" ? value.accounting.status !== "available" : value.accounting.status !== "unavailable")) {
      ctx.addIssue({ code: "custom", message: "profit coverage exact availability mismatch" });
    } else if (coverage.status === "exact" && value.accounting.status === "available" && (
      value.accounting.grossProfitMinor !== coverage.exactGrossProfitMinor
      || value.accounting.postedJournalCount !== coverage.totalJournalCount
      || value.accounting.revenueExcludingVatMinor !== coverage.verifiedSubsetRevenueExcludingVatMinor
      || value.accounting.cogsRecognizedMinor !== coverage.verifiedSubsetCogsRecognizedMinor
    )) {
      ctx.addIssue({ code: "custom", message: "profit coverage exact values mismatch" });
    } else if (value.accounting.status === "unavailable" && value.accounting.issues.join() !== coverage.issues.join()) {
      ctx.addIssue({ code: "custom", message: "profit coverage issues mismatch" });
    }
  }
  const expectedDelta = value.recordedCollection.recordedGrossCollectionsMinor
    - value.currentOrder.currentOrderGrossValueMinor;
  if (
    !Number.isSafeInteger(expectedDelta)
    || value.recordedCollectionMinusCurrentOrderValueMinor !== expectedDelta
  ) {
    ctx.addIssue({ code: "custom", message: "partial financial comparison mismatch" });
  }
  if (value.paymentFlow) {
    const expectedNet = value.recordedCollection.recordedGrossCollectionsMinor
      - value.paymentFlow.negativeCollectionsMinor;
    if (!Number.isSafeInteger(expectedNet) || value.paymentFlow.netCollectionsMinor !== expectedNet) {
      ctx.addIssue({ code: "custom", message: "dashboard net collection mismatch" });
    }
  }
  if (
    value.accounting
    && (
      value.accounting.currencyCode !== value.currencyCode
      || value.accounting.minorUnitExponent !== value.minorUnitExponent
    )
  ) {
    ctx.addIssue({ code: "custom", message: "dashboard accounting currency identity mismatch" });
  }
  if (new Set(value.unavailableMetrics).size !== value.unavailableMetrics.length) {
    ctx.addIssue({ code: "custom", message: "dashboard unavailable metrics must be unique" });
  }
  if (
    (value.dailyCurrentOrderGrossValueSeries === undefined)
    !== (value.dailyRecordedGrossCollectionsSeries === undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "partial financial daily value series must be attached together",
    });
  }
  if (
    value.dailyCurrentOrderGrossValueSeries
    && value.dailyRecordedGrossCollectionsSeries
    && !dailySeriesLabelsMatch(
      value.dailyCurrentOrderGrossValueSeries,
      value.dailyRecordedGrossCollectionsSeries,
    )
  ) {
    ctx.addIssue({ code: "custom", message: "partial financial daily labels must match" });
  }
  if (value.dailyCurrentOrderGrossValueSeries) {
    const dailyCurrentOrderGrossValue = safeDailySeriesSum(
      value.dailyCurrentOrderGrossValueSeries.map(
        (point) => point.currentOrderGrossValueMinor,
      ),
      ctx,
      "partial daily current-order gross exceeds safe integer",
    );
    if (
      dailyCurrentOrderGrossValue !== null
      && dailyCurrentOrderGrossValue !== value.currentOrder.currentOrderGrossValueMinor
    ) {
      ctx.addIssue({ code: "custom", message: "partial daily current-order headline mismatch" });
    }
  }
  if (value.dailyRecordedGrossCollectionsSeries) {
    const dailyRecordedGrossCollections = safeDailySeriesSum(
      value.dailyRecordedGrossCollectionsSeries.map(
        (point) => point.recordedGrossCollectionsMinor,
      ),
      ctx,
      "partial daily recorded collection exceeds safe integer",
    );
    if (
      dailyRecordedGrossCollections !== null
      && dailyRecordedGrossCollections
        !== value.recordedCollection.recordedGrossCollectionsMinor
    ) {
      ctx.addIssue({ code: "custom", message: "partial daily collection headline mismatch" });
    }
  }
});
export type DashboardPartialFinancialCurrencyV1 = z.infer<
  typeof DashboardPartialFinancialCurrencyV1Schema
>;

export const DashboardPartialFinancialModelV1Schema = z.object({
  schemaVersion: z.literal(1),
  completeness: z.enum(["partial_dec_01_029_blocked", "complete_payment_payable_v1"]),
  aggregateReadSource: z.literal("app.payment_events"),
  dailyActiveOrderCountSeries: DashboardDailyActiveOrderCountSeriesV1Schema.optional(),
  currencies: z.array(DashboardPartialFinancialCurrencyV1Schema),
  operationalSnapshot: DashboardOperationalSnapshotV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  if (
    value.completeness === "complete_payment_payable_v1"
    && value.currencies.some((currency) => !currency.paymentFlow)
  ) {
    ctx.addIssue({ code: "custom", message: "complete dashboard requires payment/payable flow" });
  }
  const currencyCodes = value.currencies.map((currency) => currency.currencyCode);
  if (new Set(currencyCodes).size !== currencyCodes.length) {
    ctx.addIssue({ code: "custom", message: "duplicate partial financial currency block" });
  }
  const sortedCurrencyCodes = [...currencyCodes].sort();
  if (currencyCodes.some((currencyCode, index) => currencyCode !== sortedCurrencyCodes[index])) {
    ctx.addIssue({ code: "custom", message: "partial financial currencies must be sorted" });
  }
  if (value.dailyActiveOrderCountSeries) {
    const dailyActiveOrderCount = safeDailySeriesSum(
      value.dailyActiveOrderCountSeries.map((point) => point.activeOrderCount),
      ctx,
      "partial daily active order count exceeds safe integer",
    );
    const validOrderCount = safeDailySeriesSum(
      value.currencies.map((currency) => currency.currentOrder.validOrderCount),
      ctx,
      "partial valid order count exceeds safe integer",
    );
    if (
      dailyActiveOrderCount !== null
      && validOrderCount !== null
      && dailyActiveOrderCount !== validOrderCount
    ) {
      ctx.addIssue({ code: "custom", message: "partial daily active order count mismatch" });
    }
    for (const [index, currency] of value.currencies.entries()) {
      if (
        !currency.dailyCurrentOrderGrossValueSeries
        || !currency.dailyRecordedGrossCollectionsSeries
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["currencies", index],
          message: "partial daily series must be attached as one complete dependency",
        });
        continue;
      }
      if (
        !dailySeriesLabelsMatch(
          value.dailyActiveOrderCountSeries,
          currency.dailyCurrentOrderGrossValueSeries,
        )
        || !dailySeriesLabelsMatch(
          value.dailyActiveOrderCountSeries,
          currency.dailyRecordedGrossCollectionsSeries,
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["currencies", index],
          message: "partial daily series labels must match",
        });
      }
    }
  } else if (value.currencies.some(
    (currency) => (
      currency.dailyCurrentOrderGrossValueSeries !== undefined
      || currency.dailyRecordedGrossCollectionsSeries !== undefined
    ),
  )) {
    ctx.addIssue({
      code: "custom",
      message: "partial daily series must include active-order labels",
    });
  }
});
export type DashboardPartialFinancialModelV1 = z.infer<
  typeof DashboardPartialFinancialModelV1Schema
>;

export const DashboardPartialFinancialHttpBodyV1Schema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal("dashboard.partial-financial.v1"),
  context: DashboardReportContextV1Schema,
  data: DashboardPartialFinancialModelV1Schema,
}).strict();
export type DashboardPartialFinancialHttpBodyV1 = z.infer<
  typeof DashboardPartialFinancialHttpBodyV1Schema
>;

export const DashboardCurrencyFinancialV2Schema = z.object({
  currencyCode: CurrencyCodeSchema,
  minorUnitExponent: z.number().int().min(0).max(3),
  recordedGrossCollectionsMinor: MinorUnitSchema,
  recordedGrossCollectionComponents: RecordedGrossCollectionComponentsV1Schema,
  refundsMinor: MinorUnitSchema,
  reversalsMinor: MinorUnitSchema,
  chargebacksMinor: MinorUnitSchema,
  negativeCollectionsMinor: MinorUnitSchema,
  netCollectionsMinor: z.number().int().safe(),
  currentOrderGrossValueMinor: MinorUnitSchema,
  commercialOutstandingAsOfMinor: z.number().int().safe(),
  customerRefundPayableAsOfMinor: MinorUnitSchema,
  revenueExcludingVatMinor: z.number().int().safe(),
  vatLiabilityMinor: z.number().int().safe(),
  cogsRecognizedMinor: z.number().int().safe(),
  dataQuality: DataQualityV1Schema,
}).strict().superRefine((value, ctx) => {
  if (
    value.recordedGrossCollectionComponents.totalMinor
    !== value.recordedGrossCollectionsMinor
  ) {
    ctx.addIssue({
      code: "custom",
      message: "recorded gross collection component total mismatch",
    });
  }
  const negative = value.refundsMinor + value.reversalsMinor + value.chargebacksMinor;
  if (value.negativeCollectionsMinor !== negative) {
    ctx.addIssue({ code: "custom", message: "negative collection arithmetic mismatch" });
  }
  if (value.netCollectionsMinor !== value.recordedGrossCollectionsMinor - negative) {
    ctx.addIssue({ code: "custom", message: "net collection arithmetic mismatch" });
  }
});

export const DashboardFinancialV2Schema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: IsoDateTimeSchema,
  reportAsOf: IsoDateTimeSchema,
  normalizedScope: DashboardNormalizedReportScopeV1Schema,
  localDateRange: DashboardLocalDateRangeV1Schema,
  storeTimeWindows: z.array(DashboardStoreTimeWindowV1Schema).min(1),
  metricTimeBasis: DashboardMetricTimeBasisV2Schema,
  freshness: DashboardSnapshotFreshnessV1Schema,
  currencies: z.array(DashboardCurrencyFinancialV2Schema).min(1),
}).strict().superRefine((value, ctx) => {
  const reportContext = DashboardReportContextV1Schema.safeParse({
    schemaVersion: 1,
    generatedAt: value.generatedAt,
    reportAsOf: value.reportAsOf,
    normalizedScope: value.normalizedScope,
    localDateRange: value.localDateRange,
    storeTimeWindows: value.storeTimeWindows,
    metricTimeBasis: value.metricTimeBasis,
    freshness: value.freshness,
  });
  if (!reportContext.success) {
    ctx.addIssue({ code: "custom", message: "dashboard report context is invalid" });
  }
  const codes = value.currencies.map((item) => item.currencyCode);
  if (new Set(codes).size !== codes.length) {
    ctx.addIssue({ code: "custom", message: "duplicate dashboard currency block" });
  }
});
export type DashboardFinancialV2 = z.infer<typeof DashboardFinancialV2Schema>;

export const ORDER_CURSOR_POLICY_V1 = {
  defaultLimit: 50,
  maximumLimit: 200,
  ttlSeconds: 15 * 60,
  acceptedSigningKeySlots: ["current", "previous"],
  sort: "created_at_desc_id_desc",
} as const;

export const OrderListQueryV2Schema = z.object({
  limit: z.number().int().min(1).max(ORDER_CURSOR_POLICY_V1.maximumLimit)
    .default(ORDER_CURSOR_POLICY_V1.defaultLimit),
  cursor: z.string().min(1).optional(),
}).strict();

export const OrderCursorTupleV1Schema = z.object({
  createdAt: IsoDateTimeSchema,
  id: IdSchema,
}).strict();
export type OrderCursorTupleV1 = z.infer<typeof OrderCursorTupleV1Schema>;

export const OrderCursorScopeV1Schema = z.object({
  merchantId: IdSchema,
  storeIds: z.array(IdSchema).min(1),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.storeIds).size !== value.storeIds.length) {
    ctx.addIssue({ code: "custom", message: "cursor scope contains duplicate stores" });
  }
  const sorted = [...value.storeIds].sort();
  if (sorted.some((storeId, index) => storeId !== value.storeIds[index])) {
    ctx.addIssue({ code: "custom", message: "cursor store scope must be sorted" });
  }
});
export type OrderCursorScopeV1 = z.infer<typeof OrderCursorScopeV1Schema>;

const NormalizedOrderCursorSearchV1Schema = z.string().min(1).max(200)
  .refine(
    (value) => value === value.trim().toLowerCase().replace(/\s+/g, " "),
    "cursor search must be normalized",
  );

export const OrderCursorStoreWindowV1Schema = z.object({
  storeId: IdSchema,
  startInclusive: IsoDateTimeSchema,
  endExclusive: IsoDateTimeSchema,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.startInclusive) >= Date.parse(value.endExclusive)) {
    ctx.addIssue({ code: "custom", message: "cursor store window must be non-empty" });
  }
});

/** Explicit all/selected creator selection used by the V4 order/dashboard surfaces. */
export const CreatorSelectionV1Schema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("all"),
    creatorOperatorIds: z.tuple([]),
  }).strict(),
  z.object({
    mode: z.literal("selected"),
    creatorOperatorIds: z.array(z.string().trim().min(1).max(160)).min(1).max(100),
  }).strict().superRefine((value, ctx) => {
    const sorted = [...value.creatorOperatorIds].sort();
    if (
      new Set(value.creatorOperatorIds).size !== value.creatorOperatorIds.length
      || sorted.some((id, index) => id !== value.creatorOperatorIds[index])
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["creatorOperatorIds"],
        message: "selected creator operator IDs must be unique and sorted",
      });
    }
  }),
]);
export type CreatorSelectionV1 = z.infer<typeof CreatorSelectionV1Schema>;

export const CreatorOptionV1Schema = z.object({
  operatorId: IdSchema,
  displayName: z.string().min(1).max(240),
  status: z.enum(["active", "historical"]),
}).strict();
export type CreatorOptionV1 = z.infer<typeof CreatorOptionV1Schema>;

export const OrderCursorFiltersV1Schema = z.object({
  searchMode: z.enum(["order_identity", "order_or_customer_identity"]),
  search: NormalizedOrderCursorSearchV1Schema.optional(),
  statusMode: z.enum(["all", "completed", "other"]),
  storeWindows: z.array(OrderCursorStoreWindowV1Schema).min(1),
  creatorSelection: CreatorSelectionV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  const storeIds = value.storeWindows.map((window) => window.storeId);
  if (new Set(storeIds).size !== storeIds.length) {
    ctx.addIssue({ code: "custom", message: "cursor filters contain duplicate store windows" });
  }
  const sortedStoreIds = [...storeIds].sort();
  if (sortedStoreIds.some((storeId, index) => storeId !== storeIds[index])) {
    ctx.addIssue({ code: "custom", message: "cursor store windows must be sorted" });
  }
});
export type OrderCursorFiltersV1 = z.infer<typeof OrderCursorFiltersV1Schema>;

export const EffectiveOrderCustomerSummaryV1Schema = z.object({
  id: IdSchema,
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
}).strict();
export type EffectiveOrderCustomerSummaryV1 = z.infer<
  typeof EffectiveOrderCustomerSummaryV1Schema
>;

export const OrderCustomerAttributionV1Schema = z.enum(["linked", "walk_in", "unknown"]);
export type OrderCustomerAttributionV1 = z.infer<typeof OrderCustomerAttributionV1Schema>;

function validateCustomerAttributionV1(
  value: { customerAttribution: OrderCustomerAttributionV1; customer: EffectiveOrderCustomerSummaryV1 | null },
  ctx: z.RefinementCtx,
) {
  if ((value.customerAttribution === "linked") !== Boolean(value.customer)) {
    ctx.addIssue({
      code: "custom",
      path: ["customerAttribution"],
      message: "linked attribution requires a customer; walk-in/unknown require none",
    });
  }
}

// V2 is deliberately a wrapper around the immutable commercial V1 payload.
// This keeps the existing endpoint/client contract byte-compatible while the
// new endpoint adds customer attribution for recreate-as-new-sale.
export const EffectiveOrderRecreatePrefillV2Schema = z.object({
  schemaVersion: z.literal(2),
  commercialPrefill: EffectiveOrderRecreatePrefillV1Schema,
  customerAttribution: OrderCustomerAttributionV1Schema,
  customer: EffectiveOrderCustomerSummaryV1Schema.nullable(),
}).strict().superRefine(validateCustomerAttributionV1);
export type EffectiveOrderRecreatePrefillV2 = z.infer<
  typeof EffectiveOrderRecreatePrefillV2Schema
>;

export const OrderCollectionRevisionVectorV1Schema = z.array(z.object({
  storeId: IdSchema,
  revision: z.number().int().safe().nonnegative(),
}).strict()).min(1).superRefine((value, ctx) => {
  const storeIds = value.map((item) => item.storeId);
  if (new Set(storeIds).size !== storeIds.length) {
    ctx.addIssue({ code: "custom", message: "order collection revision vector has duplicates" });
  }
  const sortedStoreIds = [...storeIds].sort();
  if (sortedStoreIds.some((storeId, index) => storeId !== storeIds[index])) {
    ctx.addIssue({ code: "custom", message: "order collection revision vector must be sorted" });
  }
});
export type OrderCollectionRevisionVectorV1 = z.infer<
  typeof OrderCollectionRevisionVectorV1Schema
>;

export const CursorClaimsV1Schema = z.object({
  schemaVersion: z.literal(1),
  audience: z.literal("order_list_v2"),
  keyId: IdSchema,
  issuedAtEpochSeconds: z.number().int().nonnegative(),
  expiresAtEpochSeconds: z.number().int().nonnegative(),
  sort: z.literal(ORDER_CURSOR_POLICY_V1.sort),
  scope: OrderCursorScopeV1Schema,
  filtersHash: Sha256Schema,
  highWatermark: OrderCursorTupleV1Schema,
  position: OrderCursorTupleV1Schema,
  storeRevisionVectorHash: Sha256Schema,
  asOf: IsoDateTimeSchema,
}).strict().superRefine((value, ctx) => {
  const ttl = value.expiresAtEpochSeconds - value.issuedAtEpochSeconds;
  if (ttl <= 0 || ttl > ORDER_CURSOR_POLICY_V1.ttlSeconds) {
    ctx.addIssue({ code: "custom", message: "cursor TTL must be between 1 and 900 seconds" });
  }
  const highWatermarkTime = Date.parse(value.highWatermark.createdAt);
  const positionTime = Date.parse(value.position.createdAt);
  if (
    positionTime > highWatermarkTime
    || (
      positionTime === highWatermarkTime
      && value.position.id > value.highWatermark.id
    )
  ) {
    ctx.addIssue({ code: "custom", message: "cursor position is newer than high-water" });
  }
});
export type CursorClaimsV1 = z.infer<typeof CursorClaimsV1Schema>;

export const CursorRefreshErrorSchema = z.object({
  code: z.enum(["invalid_cursor", "expired_cursor", "stale_cursor"]),
  refreshFromStart: z.literal(true),
}).strict();
export type CursorRefreshError = z.infer<typeof CursorRefreshErrorSchema>;

export const EffectiveOrderListRowV2Schema = z.object({
  sourceOrder: z.object({
    merchantId: IdSchema,
    storeId: IdSchema,
    orderId: IdSchema,
    orderNumber: IdSchema,
    status: IdSchema,
  }).strict(),
  order: EffectiveOrderV1Schema,
  createdAt: IsoDateTimeSchema,
  recordedGrossCollectionsMinor: MinorUnitSchema,
  refundsMinor: MinorUnitSchema,
  reversalsMinor: MinorUnitSchema,
  chargebacksMinor: MinorUnitSchema,
  negativeCollectionsMinor: MinorUnitSchema,
  netCollectionsMinor: z.number().int().safe(),
  customerRefundPayableMinor: MinorUnitSchema,
}).strict().superRefine((value, ctx) => {
  if (value.sourceOrder.orderId !== value.order.orderId) {
    ctx.addIssue({ code: "custom", message: "effective page source/order identity mismatch" });
  }
  const expectedNegative = value.refundsMinor + value.reversalsMinor + value.chargebacksMinor;
  if (!Number.isSafeInteger(expectedNegative) || expectedNegative !== value.negativeCollectionsMinor) {
    ctx.addIssue({ code: "custom", message: "effective page negative collections mismatch" });
  }
  if (
    value.netCollectionsMinor
    !== value.recordedGrossCollectionsMinor - value.negativeCollectionsMinor
  ) {
    ctx.addIssue({ code: "custom", message: "effective page net collections mismatch" });
  }
});

export const EffectiveOrderPageCurrencyAggregateV2Schema = z.object({
  currencyCode: CurrencyCodeSchema,
  minorUnitExponent: z.number().int().min(0).max(3),
  orderCount: z.number().int().safe().nonnegative(),
  activeOrderCount: z.number().int().safe().nonnegative(),
  cancelledOrderCount: z.number().int().safe().nonnegative(),
  currentOrderGrossValueMinor: MinorUnitSchema,
  recordedGrossCollectionsMinor: MinorUnitSchema,
  refundsMinor: MinorUnitSchema,
  reversalsMinor: MinorUnitSchema,
  chargebacksMinor: MinorUnitSchema,
  negativeCollectionsMinor: MinorUnitSchema,
  netCollectionsMinor: z.number().int().safe(),
}).strict().superRefine((value, ctx) => {
  if (value.activeOrderCount + value.cancelledOrderCount !== value.orderCount) {
    ctx.addIssue({ code: "custom", message: "effective page aggregate order counts mismatch" });
  }
  const expectedNegative = value.refundsMinor + value.reversalsMinor + value.chargebacksMinor;
  if (!Number.isSafeInteger(expectedNegative) || expectedNegative !== value.negativeCollectionsMinor) {
    ctx.addIssue({ code: "custom", message: "effective page aggregate negatives mismatch" });
  }
  if (
    value.netCollectionsMinor
    !== value.recordedGrossCollectionsMinor - value.negativeCollectionsMinor
  ) {
    ctx.addIssue({ code: "custom", message: "effective page aggregate net mismatch" });
  }
});
export type EffectiveOrderPageCurrencyAggregateV2 = z.infer<
  typeof EffectiveOrderPageCurrencyAggregateV2Schema
>;

export const EffectiveOrderPageV2Schema = z.object({
  schemaVersion: z.literal(2),
  data: z.array(EffectiveOrderListRowV2Schema),
  pagination: z.object({
    limit: z.number().int().min(1).max(ORDER_CURSOR_POLICY_V1.maximumLimit),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).nullable(),
    asOf: IsoDateTimeSchema,
    totalCount: z.number().int().safe().nonnegative(),
  }).strict(),
  currencies: z.array(EffectiveOrderPageCurrencyAggregateV2Schema),
}).strict().superRefine((value, ctx) => {
  if (value.pagination.hasMore !== (value.pagination.nextCursor !== null)) {
    ctx.addIssue({ code: "custom", message: "effective page cursor/hasMore mismatch" });
  }
  const currencyCodes = value.currencies.map((item) => item.currencyCode);
  if (new Set(currencyCodes).size !== currencyCodes.length) {
    ctx.addIssue({ code: "custom", message: "effective page duplicate currency aggregate" });
  }
  const aggregateByCurrency = new Map(
    value.currencies.map((item) => [item.currencyCode, item]),
  );
  for (const row of value.data) {
    const aggregate = aggregateByCurrency.get(row.order.currencyCode);
    if (!aggregate || aggregate.minorUnitExponent !== row.order.minorUnitExponent) {
      ctx.addIssue({ code: "custom", message: "effective page row lacks matching currency aggregate" });
      break;
    }
  }
  const aggregateCount = value.currencies.reduce((sum, item) => sum + item.orderCount, 0);
  if (!Number.isSafeInteger(aggregateCount) || aggregateCount !== value.pagination.totalCount) {
    ctx.addIssue({ code: "custom", message: "effective page aggregate/total count mismatch" });
  }
});
export type EffectiveOrderPageV2 = z.infer<typeof EffectiveOrderPageV2Schema>;

export const EffectiveOrderListRowV3Schema = z.object({
  sourceOrder: z.object({
    merchantId: IdSchema,
    storeId: IdSchema,
    orderId: IdSchema,
    orderNumber: IdSchema,
    status: IdSchema,
  }).strict(),
  customerAttribution: OrderCustomerAttributionV1Schema,
  customer: EffectiveOrderCustomerSummaryV1Schema.nullable(),
  order: EffectiveOrderV1Schema,
  createdAt: IsoDateTimeSchema,
  recordedGrossCollectionsMinor: MinorUnitSchema,
  refundsMinor: MinorUnitSchema,
  reversalsMinor: MinorUnitSchema,
  chargebacksMinor: MinorUnitSchema,
  negativeCollectionsMinor: MinorUnitSchema,
  netCollectionsMinor: z.number().int().safe(),
  customerRefundPayableMinor: MinorUnitSchema,
}).strict().superRefine((value, ctx) => {
  validateCustomerAttributionV1(value, ctx);
  if (value.sourceOrder.orderId !== value.order.orderId) {
    ctx.addIssue({ code: "custom", message: "effective page source/order identity mismatch" });
  }
  const expectedNegative = value.refundsMinor + value.reversalsMinor + value.chargebacksMinor;
  if (!Number.isSafeInteger(expectedNegative) || expectedNegative !== value.negativeCollectionsMinor) {
    ctx.addIssue({ code: "custom", message: "effective page negative collections mismatch" });
  }
  if (
    value.netCollectionsMinor
    !== value.recordedGrossCollectionsMinor - value.negativeCollectionsMinor
  ) {
    ctx.addIssue({ code: "custom", message: "effective page net collections mismatch" });
  }
});
export type EffectiveOrderListRowV3 = z.infer<typeof EffectiveOrderListRowV3Schema>;

export const EffectiveOrderPageV3Schema = z.object({
  schemaVersion: z.literal(3),
  data: z.array(EffectiveOrderListRowV3Schema),
  pagination: z.object({
    limit: z.number().int().min(1).max(ORDER_CURSOR_POLICY_V1.maximumLimit),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).nullable(),
    asOf: IsoDateTimeSchema,
    totalCount: z.number().int().safe().nonnegative(),
  }).strict(),
  currencies: z.array(EffectiveOrderPageCurrencyAggregateV2Schema),
}).strict().superRefine((value, ctx) => {
  if (value.pagination.hasMore !== (value.pagination.nextCursor !== null)) {
    ctx.addIssue({ code: "custom", message: "effective page cursor/hasMore mismatch" });
  }
  const currencyCodes = value.currencies.map((item) => item.currencyCode);
  if (new Set(currencyCodes).size !== currencyCodes.length) {
    ctx.addIssue({ code: "custom", message: "effective page duplicate currency aggregate" });
  }
  const aggregateByCurrency = new Map(
    value.currencies.map((item) => [item.currencyCode, item]),
  );
  for (const row of value.data) {
    const aggregate = aggregateByCurrency.get(row.order.currencyCode);
    if (!aggregate || aggregate.minorUnitExponent !== row.order.minorUnitExponent) {
      ctx.addIssue({ code: "custom", message: "effective page row lacks matching currency aggregate" });
      break;
    }
  }
  const aggregateCount = value.currencies.reduce((sum, item) => sum + item.orderCount, 0);
  if (!Number.isSafeInteger(aggregateCount) || aggregateCount !== value.pagination.totalCount) {
    ctx.addIssue({ code: "custom", message: "effective page aggregate/total count mismatch" });
  }
});
export type EffectiveOrderPageV3 = z.infer<typeof EffectiveOrderPageV3Schema>;

export const ORDER_API_V2_COMPATIBILITY = {
  endpointVersion: "v2",
  legacyEndpointStatus: "unchanged_deprecated",
  legacyEndpointSupportedThroughReleaseLine: "1.8.x",
  ambiguousScalarAliases: [],
} as const;

export const ORDER_CSV_ORDER_V2_HEADERS = [
  "schema_version",
  "order_id",
  "effective_revision",
  "commercial_state",
  "currency_code",
  "minor_unit_exponent",
  "merchandise_gross_minor",
  "discount_minor",
  "merchandise_net_minor",
  "shipping_minor",
  "vat_minor",
  "unclassified_minor",
  "current_order_gross_value_minor",
  "recorded_gross_collections_minor",
  "negative_collections_minor",
  "net_collections_minor",
  "data_quality_status",
] as const;

export const ORDER_CSV_LINE_V2_HEADERS = [
  "schema_version",
  "order_id",
  "effective_revision",
  "line_id",
  "sku_snapshot",
  "title_snapshot",
  "quantity",
  "unit_price_minor",
  "effective_line_total_minor",
  "currency_code",
  "minor_unit_exponent",
] as const;

export const EffectiveOrderCsvSnapshotV3Schema = z.object({
  contractVersion: z.literal("orders.effective-order.v3"),
  merchantId: IdSchema,
  storeRevisions: z.array(z.object({
    storeId: IdSchema,
    revision: z.number().int().safe().nonnegative(),
  }).strict()).min(1),
  asOf: IsoDateTimeSchema,
}).strict().superRefine((value, ctx) => {
  const storeIds = value.storeRevisions.map((item) => item.storeId);
  if (new Set(storeIds).size !== storeIds.length) {
    ctx.addIssue({ code: "custom", message: "CSV snapshot contains duplicate store revisions" });
  }
  const sorted = [...storeIds].sort();
  if (sorted.some((storeId, index) => storeId !== storeIds[index])) {
    ctx.addIssue({ code: "custom", message: "CSV snapshot store revisions must be sorted" });
  }
});
export type EffectiveOrderCsvSnapshotV3 = z.infer<typeof EffectiveOrderCsvSnapshotV3Schema>;

export const EffectiveOrderCsvSourceOrderV3Schema = z.object({
  merchantId: IdSchema,
  storeId: IdSchema,
  orderId: IdSchema,
  orderNumber: IdSchema,
  createdAt: IsoDateTimeSchema,
}).strict();
export type EffectiveOrderCsvSourceOrderV3 = z.infer<typeof EffectiveOrderCsvSourceOrderV3Schema>;

export const EffectiveOrderCsvPaymentSummaryV3Schema = z.object({
  currencyCode: CurrencyCodeSchema,
  recordedGrossCollectionsMinor: MinorUnitSchema,
  refundsMinor: MinorUnitSchema,
  reversalsMinor: MinorUnitSchema,
  chargebacksMinor: MinorUnitSchema,
  negativeCollectionsMinor: MinorUnitSchema,
  netCollectionsMinor: z.number().int().safe(),
}).strict().superRefine((value, ctx) => {
  const expectedNegative = value.refundsMinor
    + value.reversalsMinor
    + value.chargebacksMinor;
  if (!Number.isSafeInteger(expectedNegative)) {
    ctx.addIssue({ code: "custom", message: "CSV payment negative collections exceed safe integer" });
    return;
  }
  if (value.negativeCollectionsMinor !== expectedNegative) {
    ctx.addIssue({ code: "custom", message: "CSV payment negative collections mismatch" });
  }
  if (
    value.netCollectionsMinor
    !== value.recordedGrossCollectionsMinor - value.negativeCollectionsMinor
  ) {
    ctx.addIssue({ code: "custom", message: "CSV payment net collections mismatch" });
  }
});
export type EffectiveOrderCsvPaymentSummaryV3 = z.infer<
  typeof EffectiveOrderCsvPaymentSummaryV3Schema
>;

export const EffectiveOrderCsvOrderRecordV3Schema = z.object({
  sourceOrder: EffectiveOrderCsvSourceOrderV3Schema,
  customerAttribution: OrderCustomerAttributionV1Schema,
  customer: EffectiveOrderCustomerSummaryV1Schema.nullable(),
  effectiveOrder: EffectiveOrderV1Schema,
  paymentSummary: EffectiveOrderCsvPaymentSummaryV3Schema,
}).strict().superRefine((value, ctx) => {
  validateCustomerAttributionV1(value, ctx);
  if (value.sourceOrder.orderId !== value.effectiveOrder.orderId) {
    ctx.addIssue({ code: "custom", message: "CSV source/effective order identity mismatch" });
  }
  if (value.paymentSummary.currencyCode !== value.effectiveOrder.currencyCode) {
    ctx.addIssue({ code: "custom", message: "CSV order/payment currency mismatch" });
  }
});
export type EffectiveOrderCsvOrderRecordV3 = z.infer<
  typeof EffectiveOrderCsvOrderRecordV3Schema
>;

export const ORDER_CSV_ORDER_V3_HEADERS = [
  "contract_version",
  "grain",
  "snapshot_revision",
  "as_of",
  "merchant_id",
  "store_id",
  "order_id",
  "order_number",
  "order_created_at",
  "customer_attribution",
  "customer_id",
  "customer_first_name",
  "customer_last_name",
  "customer_phone",
  "effective_revision",
  "commercial_state",
  "currency_code",
  "minor_unit_exponent",
  "tax_mode",
  "merchandise_gross_minor",
  "discount_minor",
  "merchandise_net_minor",
  "shipping_minor",
  "merchandise_vat_minor",
  "shipping_vat_minor",
  "vat_minor",
  "unclassified_minor",
  "effective_commercial_total_minor",
  "current_order_gross_value_minor",
  "effective_item_count",
  "effective_quantity",
  "effective_items_json",
  "recorded_gross_collections_minor",
  "refunds_minor",
  "reversals_minor",
  "chargebacks_minor",
  "negative_collections_minor",
  "net_collections_minor",
  "data_quality_status",
  "data_quality_warnings_json",
] as const;

export const ORDER_CSV_LINE_V3_HEADERS = [
  "contract_version",
  "grain",
  "snapshot_revision",
  "as_of",
  "merchant_id",
  "store_id",
  "order_id",
  "order_number",
  "order_created_at",
  "customer_attribution",
  "customer_id",
  "customer_first_name",
  "customer_last_name",
  "customer_phone",
  "effective_revision",
  "commercial_state",
  "line_position",
  "line_id",
  "product_id",
  "variant_id",
  "sku_snapshot",
  "title_snapshot",
  "quantity",
  "unit_price_minor",
  "effective_line_total_minor",
  "currency_code",
  "minor_unit_exponent",
  "archived_variant",
  "data_quality_status",
] as const;

export const LEGACY_ORDER_CSV_COMPATIBILITY = {
  unchangedThroughReleaseLine: "1.8.x",
  status: "deprecated",
} as const;

/** A V4 page is a new capability; V2/V3 page payloads remain unchanged. */
export const EffectiveOrderPageCurrencyAggregateV4Schema =
  EffectiveOrderPageCurrencyAggregateV2Schema.extend({
    effectiveItemQuantity: z.number().int().safe().nonnegative(),
  }).strict();
export type EffectiveOrderPageCurrencyAggregateV4 = z.infer<
  typeof EffectiveOrderPageCurrencyAggregateV4Schema
>;

export const EffectiveOrderPageV4Schema = z.object({
  schemaVersion: z.literal(4),
  creatorSelection: CreatorSelectionV1Schema,
  data: z.array(EffectiveOrderListRowV3Schema),
  pagination: z.object({
    limit: z.number().int().min(1).max(ORDER_CURSOR_POLICY_V1.maximumLimit),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).nullable(),
    asOf: IsoDateTimeSchema,
    totalCount: z.number().int().safe().nonnegative(),
  }).strict(),
  currencies: z.array(EffectiveOrderPageCurrencyAggregateV4Schema),
}).strict().superRefine((value, ctx) => {
  if (value.pagination.hasMore !== (value.pagination.nextCursor !== null)) {
    ctx.addIssue({ code: "custom", message: "effective page cursor/hasMore mismatch" });
  }
  const currencyCodes = value.currencies.map((item) => item.currencyCode);
  if (new Set(currencyCodes).size !== currencyCodes.length) {
    ctx.addIssue({ code: "custom", message: "effective page duplicate currency aggregate" });
  }
  const aggregateCount = value.currencies.reduce((sum, item) => sum + item.orderCount, 0);
  if (!Number.isSafeInteger(aggregateCount) || aggregateCount !== value.pagination.totalCount) {
    ctx.addIssue({ code: "custom", message: "effective page aggregate/total count mismatch" });
  }
  if (!Number.isSafeInteger(value.currencies.reduce((sum, item) => sum + item.effectiveItemQuantity, 0))) {
    ctx.addIssue({ code: "custom", message: "effective page quantity exceeds safe integer" });
  }
});
export type EffectiveOrderPageV4 = z.infer<typeof EffectiveOrderPageV4Schema>;

const EffectiveOrderPaymentMethodV4Schema = z.string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9_:-]+$/);

export const EffectiveOrderCsvPaymentSummaryV4Schema =
  EffectiveOrderCsvPaymentSummaryV3Schema.extend({
    paymentMethods: z.array(EffectiveOrderPaymentMethodV4Schema).max(20),
  }).strict().superRefine((value, ctx) => {
    const sorted = [...value.paymentMethods].sort();
    if (
      new Set(value.paymentMethods).size !== value.paymentMethods.length
      || sorted.some((method, index) => method !== value.paymentMethods[index])
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["paymentMethods"],
        message: "payment methods must be unique and sorted",
      });
    }
  });
export type EffectiveOrderCsvPaymentSummaryV4 = z.infer<
  typeof EffectiveOrderCsvPaymentSummaryV4Schema
>;

export const EffectiveOrderCsvSnapshotV4Schema = z.object({
  contractVersion: z.literal("orders.effective-order.v4"),
  merchantId: IdSchema,
  storeRevisions: z.array(z.object({
    storeId: IdSchema,
    revision: z.number().int().safe().nonnegative(),
  }).strict()).min(1),
  asOf: IsoDateTimeSchema,
}).strict().superRefine((value, ctx) => {
  const storeIds = value.storeRevisions.map((item) => item.storeId);
  const sorted = [...storeIds].sort();
  if (new Set(storeIds).size !== storeIds.length || sorted.some((id, index) => id !== storeIds[index])) {
    ctx.addIssue({ code: "custom", message: "CSV snapshot contains duplicate or unsorted store revisions" });
  }
});
export type EffectiveOrderCsvSnapshotV4 = z.infer<typeof EffectiveOrderCsvSnapshotV4Schema>;

export const EffectiveOrderCsvOrderRecordV4Schema = z.object({
  sourceOrder: EffectiveOrderCsvSourceOrderV3Schema,
  customerAttribution: OrderCustomerAttributionV1Schema,
  customer: EffectiveOrderCustomerSummaryV1Schema.nullable(),
  effectiveOrder: EffectiveOrderV1Schema,
  paymentSummary: EffectiveOrderCsvPaymentSummaryV4Schema,
}).strict().superRefine((value, ctx) => {
  validateCustomerAttributionV1(value, ctx);
  if (value.sourceOrder.orderId !== value.effectiveOrder.orderId) {
    ctx.addIssue({ code: "custom", message: "CSV source/effective order identity mismatch" });
  }
  if (value.paymentSummary.currencyCode !== value.effectiveOrder.currencyCode) {
    ctx.addIssue({ code: "custom", message: "CSV order/payment currency mismatch" });
  }
});
export type EffectiveOrderCsvOrderRecordV4 = z.infer<
  typeof EffectiveOrderCsvOrderRecordV4Schema
>;

export const ORDER_CSV_ORDER_V4_HEADERS = [
  ...ORDER_CSV_ORDER_V3_HEADERS,
  "payment_methods",
] as const;

export const ORDER_CSV_LINE_V4_HEADERS = [
  ...ORDER_CSV_LINE_V3_HEADERS,
  "payment_methods",
] as const;

export const CreatorSalesDashboardCurrencyV2Schema = z.object({
  currencyCode: CurrencyCodeSchema,
  minorUnitExponent: z.number().int().min(0).max(3),
  orderCount: z.number().int().safe().nonnegative(),
  activeOrderCount: z.number().int().safe().nonnegative(),
  currentOrderGrossValueMinor: MinorUnitSchema,
  effectiveItemQuantity: z.number().int().safe().nonnegative(),
  currentShippingRevenueExVatMinor: MinorUnitSchema,
  averageCurrentOrderValueMinor: MinorUnitSchema.nullable(),
  activeOrdersWithShippingCount: z.number().int().safe().nonnegative(),
  currentShippingSharePercent: z.number().finite().min(0).max(100).nullable(),
  dailySeries: z.array(z.object({
    localDate: z.string(),
    activeOrderCount: z.number().int().safe().nonnegative(),
    currentOrderGrossValueMinor: MinorUnitSchema,
  }).strict()),
  topProducts: z.array(z.object({
    productId: IdSchema.nullable(), variantId: IdSchema.nullable(),
    skuSnapshot: z.string().min(1), titleSnapshot: z.string().min(1),
    archivedVariant: z.boolean(), quantity: z.number().int().safe().positive(),
    grossLineSalesBeforeDiscountMinor: MinorUnitSchema,
  }).strict()),
  paymentMethods: z.array(z.object({
    method: EffectiveOrderPaymentMethodV4Schema,
    postedChargeOrderCount: z.number().int().safe().nonnegative(),
    postedNegativeEventCount: z.number().int().safe().nonnegative(),
    grossMinor: MinorUnitSchema,
    negativeMinor: MinorUnitSchema,
    netMinor: z.number().int().safe(),
  }).strict()),
}).strict();
export type CreatorSalesDashboardCurrencyV2 = z.infer<
  typeof CreatorSalesDashboardCurrencyV2Schema
>;

export const CreatorSalesDashboardV2Schema = z.object({
  schemaVersion: z.literal(2),
  audience: z.enum(["full", "self"]),
  creatorSelection: CreatorSelectionV1Schema,
  creatorOptions: z.array(CreatorOptionV1Schema),
  asOf: IsoDateTimeSchema,
  context: z.object({
    schemaVersion: DashboardReportContextV1Schema.shape.schemaVersion,
    normalizedScope: DashboardReportContextV1Schema.shape.normalizedScope,
    localDateRange: DashboardReportContextV1Schema.shape.localDateRange,
    storeTimeWindows: DashboardReportContextV1Schema.shape.storeTimeWindows,
    reportAsOf: DashboardReportContextV1Schema.shape.reportAsOf,
    generatedAt: DashboardReportContextV1Schema.shape.generatedAt,
    freshness: DashboardReportContextV1Schema.shape.freshness,
  }).strict(),
  operationalSnapshot: DashboardOperationalSnapshotV1Schema,
  financial: DashboardAccountingSliceV1Schema.optional(),
  currencies: z.array(CreatorSalesDashboardCurrencyV2Schema),
}).strict().superRefine((value, ctx) => {
  if (value.audience === "self" && value.financial !== undefined) {
    ctx.addIssue({ code: "custom", message: "Self dashboard must not contain accounting or cost data" });
  }
  if (value.audience === "full" && value.financial === undefined) {
    ctx.addIssue({ code: "custom", message: "Full dashboard requires its accounting coverage" });
  }
  if (value.asOf !== value.context.reportAsOf
    || !Number.isSafeInteger(value.currencies.reduce((sum, currency) => sum + currency.effectiveItemQuantity, 0))) {
    ctx.addIssue({ code: "custom", message: "Dashboard snapshot or sold quantity is invalid" });
  }
});
export type CreatorSalesDashboardV2 = z.infer<typeof CreatorSalesDashboardV2Schema>;

const CancellationJournalPreviewSchema = z.object({
  kind: z.enum([
    "revenue_vat_reverse",
    "cogs_reverse",
    "customer_payable_open",
    "customer_payable_clear",
  ]),
  currencyCode: CurrencyCodeSchema,
  debitMinor: MinorUnitSchema,
  creditMinor: MinorUnitSchema,
}).strict().superRefine((value, ctx) => {
  if (value.debitMinor !== value.creditMinor) {
    ctx.addIssue({ code: "custom", message: "cancellation journal preview is unbalanced" });
  }
});

export const CancellationQuoteV1Schema = z.object({
  schemaVersion: z.literal(1),
  quoteId: IdSchema,
  orderId: IdSchema,
  effectiveRevision: z.number().int().nonnegative(),
  idempotencyKey: IdSchema,
  generatedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  paymentBalances: z.array(z.object({
    method: z.enum(["cash", "cod", "manual_bank", "provider", "unknown"]),
    currencyCode: CurrencyCodeSchema,
    collectedMinor: MinorUnitSchema,
    refundableMinor: MinorUnitSchema,
    disposition: z.enum(["external_refund", "customer_payable", "no_action"]),
    evidenceStatus: z.enum(["verified", "pending", "unavailable"]),
  }).strict()).min(1),
  stockPreview: z.array(z.object({
    lineId: IdSchema,
    quantity: z.number().int().positive(),
    action: z.enum(["restock", "no_action", "manual_review"]),
  }).strict()),
  loyaltyPreview: z.object({ pointsToReverse: z.number().int().nonnegative() }).strict(),
  journalPreview: z.array(CancellationJournalPreviewSchema),
  payablePreview: z.array(z.object({
    currencyCode: CurrencyCodeSchema,
    openMinor: MinorUnitSchema,
    clearMinor: MinorUnitSchema,
    balanceMinor: MinorUnitSchema,
  }).strict().superRefine((value, ctx) => {
    if (value.openMinor - value.clearMinor !== value.balanceMinor) {
      ctx.addIssue({ code: "custom", message: "cancellation payable preview mismatch" });
    }
  })),
}).strict().superRefine((value, ctx) => {
  const generatedAt = Date.parse(value.generatedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (expiresAt <= generatedAt) {
    ctx.addIssue({ code: "custom", message: "cancellation quote must expire after generation" });
  }
});
export type CancellationQuoteV1 = z.infer<typeof CancellationQuoteV1Schema>;

export const DASHBOARD_VISIBLE_FACTOR_IDS_V1 = [
  "active_effective_order_count",
  "ai_pending_count",
  "average_current_order_value",
  "cancellation_rate",
  "cancelled_order_cohort_count",
  "current_gross_profit",
  "current_merchandise_value",
  "current_order_value_and_recorded_collection",
  "current_shipping_value",
  "daily_active_order_count_series",
  "daily_order_value_and_collection_series",
  "dashboard_freshness_state",
  "date_range_control",
  "effective_item_quantity",
  "gross_margin_percent",
  "items_per_order",
  "low_stock_count",
  "new_customer_count",
  "orders_with_shipping_count",
  "out_of_stock_count",
  "payment_method_amount",
  "payment_method_order_count",
  "published_sku_count",
  "shipping_share_percent",
  "top_product_gross_sales",
  "top_product_narrative",
  "top_product_quantity",
] as const;

export const DashboardMetricRegistryFactorV1Schema = z.object({
  factorId: IdSchema,
  currentVisible: z.literal(true),
  currentLabelsVi: z.array(z.string().min(1)).min(1),
  targetMetricIds: z.array(IdSchema).min(1),
  unavailableTargetMetricIds: z.array(IdSchema),
  factorKind: z.enum([
    "card",
    "chart",
    "control",
    "derived",
    "list",
    "narrative",
    "operational",
    "status",
  ]),
  targetSources: z.array(z.enum([
    "accounting_journal",
    "ai_action",
    "app.payment_events",
    "customer",
    "effective_order_v1",
    "inventory_location",
    "product_catalog",
    "report_context",
  ])).min(1),
  formula: z.string().min(20),
  targetScope: z.enum(["report_merchant", "selected_report_stores"]),
  timeBasis: z.array(z.enum([
    "accounting_source_occurred_at",
    "customer_created_business_date",
    "order_business_date",
    "payment_event_at",
    "request_local_date_range",
    "snapshot_as_of",
  ])).min(1),
  currencyBehavior: z.enum([
    "independent_currency_blocks",
    "not_monetary",
    "per_currency_ratio",
  ]),
  reportAsOfRequired: z.literal(true),
  freshnessBehavior: z.string().min(20),
  dataQualityBehavior: z.string().min(20),
  implementationState: z.enum([
    "blocked_dependency",
    "local_commercial_slice_unwired",
    "local_foundation_unwired",
    "local_partial_model_unwired",
    "not_implemented",
  ]),
  activationStatus: z.literal("inactive"),
  activationDependencies: z.array(IdSchema),
  legacyFallback: z.literal("forbidden"),
}).strict().superRefine((value, ctx) => {
  for (const field of ["targetMetricIds", "unavailableTargetMetricIds", "targetSources", "timeBasis", "activationDependencies"] as const) {
    const items = value[field];
    const sorted = [...items].sort();
    if (
      new Set(items).size !== items.length
      || items.some((item, index) => item !== sorted[index])
    ) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} must be unique and sorted` });
    }
  }
  const overlap = value.targetMetricIds.filter((metricId) => (
    value.unavailableTargetMetricIds.includes(metricId)
  ));
  if (overlap.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["unavailableTargetMetricIds"],
      message: "available and unavailable dashboard target metrics must be disjoint",
    });
  }
  if (value.implementationState === "blocked_dependency" && value.activationDependencies.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["activationDependencies"],
      message: "blocked dashboard factor requires an explicit dependency",
    });
  }
});
export type DashboardMetricRegistryFactorV1 = z.infer<
  typeof DashboardMetricRegistryFactorV1Schema
>;

export const DashboardMetricRegistryV1Schema = z.object({
  schemaVersion: z.literal(1),
  registryStatus: z.literal("inactive_phase_2_specification"),
  factors: z.array(DashboardMetricRegistryFactorV1Schema).min(1),
}).strict().superRefine((value, ctx) => {
  const factorIds = value.factors.map((factor) => factor.factorId);
  const sorted = [...factorIds].sort();
  if (
    new Set(factorIds).size !== factorIds.length
    || factorIds.some((factorId, index) => factorId !== sorted[index])
  ) {
    ctx.addIssue({ code: "custom", path: ["factors"], message: "dashboard factors must be unique and sorted" });
  }
});
export type DashboardMetricRegistryV1 = z.infer<typeof DashboardMetricRegistryV1Schema>;
