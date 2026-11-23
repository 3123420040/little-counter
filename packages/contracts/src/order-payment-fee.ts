import { z } from "zod";
import { EffectiveOrderRecreatePrefillV2Schema, CreatorSalesDashboardCurrencyV2Schema, CreatorSalesDashboardV2Schema, DashboardCommercialCurrencyV1Schema, DashboardCommercialSliceV1Schema, percentageOneDecimalHalfUp, type DashboardCommercialCurrencyV1, EffectiveOrderCsvOrderRecordV4Schema, EffectiveOrderCsvSnapshotV4Schema, ORDER_CSV_ORDER_V4_HEADERS, ORDER_CSV_LINE_V4_HEADERS, EffectiveOrderListRowV3Schema, EffectiveOrderPageV4Schema, EffectiveOrderPageCurrencyAggregateV4Schema, EffectiveOrderSurfaceV2Schema, EffectiveOrderReceiptV1Schema, EffectiveOrderV1Schema, OrderCommercialComponentsV1Schema } from "./order-financial-correctness";

export const PaymentFeeInputV1Schema = z.object({
  paymentFeeType: z.enum(["percent", "amount"]),
  paymentFeeValue: z.number().finite().nonnegative(),
}).strict().superRefine((value, ctx) => {
  const valid = value.paymentFeeType === "amount"
    ? Number.isSafeInteger(value.paymentFeeValue)
    : value.paymentFeeValue <= 100 && /^\d+(?:\.\d{1,2})?$/.test(String(value.paymentFeeValue));
  if (!valid) ctx.addIssue({ code: "custom", path: ["paymentFeeValue"],
    message: "payment fee requires integer VND or percent 0–100 with at most two decimals" });
});
export type PaymentFeeInputV1 = z.infer<typeof PaymentFeeInputV1Schema>;
export const PAYMENT_FEE_RESOLVED_INPUT_FIELDS_V1 = ["total", "tax", "vatRatePpm", "taxMode", "commercialCalculationVersion", "commercialAdjustmentVersion"] as const;

export function parseOptionalPaymentFeeInputV1(input: object): PaymentFeeInputV1 | undefined {
  const fields = Object.fromEntries(Object.entries(input).filter(([key, value]) => key.startsWith("paymentFee") && value !== undefined));
  if (Object.keys(fields).length === 0) return undefined;
  const parsed = PaymentFeeInputV1Schema.parse(fields);
  if (PAYMENT_FEE_RESOLVED_INPUT_FIELDS_V1.some(key => Object.hasOwn(input, key))) {
    throw new z.ZodError([{ code: "custom", path: [], message: "Payment fee input cannot supply resolved totals or calculation context" }]);
  }
  return parsed;
}

export const OrderCommercialComponentsV2Schema = z.object({
  ...OrderCommercialComponentsV1Schema.shape,
  paymentFeeMinor: z.number().int().safe().nonnegative(),
  paymentFeeVatMinor: z.number().int().safe().nonnegative(),
}).strict().superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (value.discountMinor > value.merchandiseGrossMinor) fail("discount exceeds merchandise gross");
  if (BigInt(value.merchandiseGrossMinor) - BigInt(value.discountMinor) !== BigInt(value.merchandiseNetMinor)) {
    fail("merchandise net arithmetic mismatch");
  }
  if (BigInt(value.merchandiseVatMinor) + BigInt(value.shippingVatMinor) + BigInt(value.paymentFeeVatMinor) !== BigInt(value.vatMinor)) {
    fail("VAT attribution arithmetic mismatch");
  }
  if (value.taxMode === "inclusive" && (value.merchandiseVatMinor > value.merchandiseNetMinor
    || value.shippingVatMinor > value.shippingMinor || value.paymentFeeVatMinor > value.paymentFeeMinor)) {
    fail("inclusive VAT exceeds its containing charge");
  }
  const total = BigInt(value.merchandiseNetMinor) + BigInt(value.shippingMinor) + BigInt(value.paymentFeeMinor)
    + BigInt(value.unclassifiedMinor) + (value.taxMode === "exclusive" ? BigInt(value.vatMinor) : 0n);
  if (total !== BigInt(value.totalMinor)) fail("commercial component arithmetic mismatch");
});
export type OrderCommercialComponentsV2 = z.infer<typeof OrderCommercialComponentsV2Schema>;

export const EffectiveOrderV2Schema = z.object({
  ...EffectiveOrderV1Schema.shape,
  schemaVersion: z.literal(2),
  componentVersion: z.union([z.literal(1), z.literal(2)]),
  components: OrderCommercialComponentsV2Schema,
}).strict().superRefine((value, ctx) => {
  const { componentVersion, ...legacyFields } = value;
  const { paymentFeeMinor, paymentFeeVatMinor, ...components } = value.components;
  if (componentVersion === 1 && (paymentFeeMinor !== 0 || paymentFeeVatMinor !== 0)) {
    ctx.addIssue({ code: "custom", message: "Legacy components cannot contain a payment surcharge" });
  }
  if (componentVersion === 2 && (value.currencyCode !== "VND" || value.minorUnitExponent !== 0)) {
    ctx.addIssue({ code: "custom", message: "V2 payment surcharge components require integer VND" });
  }
  const feeTotal = BigInt(paymentFeeMinor) + (components.taxMode === "exclusive" ? BigInt(paymentFeeVatMinor) : 0n);
  const legacy = EffectiveOrderV1Schema.safeParse({
    ...legacyFields, schemaVersion: 1,
    components: { ...components, vatMinor: components.vatMinor - paymentFeeVatMinor,
      totalMinor: Number(BigInt(components.totalMinor) - feeTotal) },
    currentOrderGrossValueMinor: value.commercialState === "cancelled"
      ? value.currentOrderGrossValueMinor : Number(BigInt(value.currentOrderGrossValueMinor) - feeTotal),
  });
  if (!legacy.success) ctx.addIssue({ code: "custom", message: "Effective order surcharge projection is inconsistent" });
});
export type EffectiveOrderV2 = z.infer<typeof EffectiveOrderV2Schema>;

// Recreate transfers products/customer only; no source-order adjustments enter the new sale.
export const EffectiveOrderRecreatePrefillV3Schema = z.object({
  ...EffectiveOrderRecreatePrefillV2Schema.shape, schemaVersion: z.literal(3),
}).strict().superRefine((value, ctx) => {
  if (!EffectiveOrderRecreatePrefillV2Schema.safeParse({ ...value, schemaVersion: 2 }).success) {
    ctx.addIssue({ code: "custom", message: "Recreate customer attribution is inconsistent" });
  }
});
export type EffectiveOrderRecreatePrefillV3 = z.infer<typeof EffectiveOrderRecreatePrefillV3Schema>;

export const EffectiveOrderSurfaceV3Schema = z.object({
  ...EffectiveOrderSurfaceV2Schema.shape,
  schemaVersion: z.literal(3), componentVersion: z.union([z.literal(1), z.literal(2)]),
  components: OrderCommercialComponentsV2Schema,
}).strict().superRefine((value, ctx) => {
  const projection = EffectiveOrderV2Schema.safeParse({
    schemaVersion: 2, componentVersion: value.componentVersion, orderId: value.orderId,
    currencyCode: value.currencyCode, minorUnitExponent: value.minorUnitExponent,
    effectiveRevision: value.effectiveRevision, commercialState: value.commercialState,
    lines: value.effectiveItems.map(({ lineTotalMinor, ...line }) => line),
    components: value.components, currentOrderGrossValueMinor: value.currentOrderGrossValueMinor, dataQuality: value.dataQuality,
  });
  const quantity = value.effectiveItems.reduce((sum, line) => sum + BigInt(line.quantity), 0n);
  if (!projection.success || value.effectiveCommercialTotalMinor !== value.components.totalMinor
    || BigInt(value.effectiveItemQuantity) !== (value.commercialState === "cancelled" ? 0n : quantity)) {
    ctx.addIssue({ code: "custom", message: "Effective order surcharge surface is inconsistent" });
  }
});
export type EffectiveOrderSurfaceV3 = z.infer<typeof EffectiveOrderSurfaceV3Schema>;

export const EffectiveOrderReceiptV2Schema = z.object({
  ...EffectiveOrderReceiptV1Schema.shape,
  schemaVersion: z.literal(2),
  componentVersion: z.union([z.literal(1), z.literal(2)]),
  components: OrderCommercialComponentsV2Schema,
}).strict().superRefine((value, ctx) => {
  const projection = EffectiveOrderV2Schema.safeParse({
    schemaVersion: 2, componentVersion: value.componentVersion, orderId: value.sourceOrder.orderId,
    currencyCode: value.currencyCode, minorUnitExponent: value.minorUnitExponent,
    effectiveRevision: value.effectiveRevision, commercialState: value.commercialState,
    lines: value.effectiveItems.map(({ lineTotalMinor, ...line }) => line),
    components: value.components, currentOrderGrossValueMinor: value.commercialState === "cancelled" ? 0 : value.components.totalMinor,
    dataQuality: value.dataQuality,
  });
  if (!projection.success || value.effectiveCommercialTotalMinor !== value.components.totalMinor) {
    ctx.addIssue({ code: "custom", message: "Effective receipt surcharge projection is inconsistent" });
  }
});
export type EffectiveOrderReceiptV2 = z.infer<typeof EffectiveOrderReceiptV2Schema>;

export const EffectiveOrderListRowV5Schema = z.object({
  ...EffectiveOrderListRowV3Schema.shape, order: EffectiveOrderV2Schema,
}).strict().superRefine((value, ctx) => {
  if ((value.customerAttribution === "linked") !== (value.customer !== null)
    || value.sourceOrder.orderId !== value.order.orderId
    || BigInt(value.refundsMinor) + BigInt(value.reversalsMinor) + BigInt(value.chargebacksMinor) !== BigInt(value.negativeCollectionsMinor)
    || value.netCollectionsMinor !== value.recordedGrossCollectionsMinor - value.negativeCollectionsMinor) {
    ctx.addIssue({ code: "custom", message: "Fee-aware order row attribution/identity/payment mismatch" });
  }
});
export type EffectiveOrderListRowV5 = z.infer<typeof EffectiveOrderListRowV5Schema>;

export const EffectiveOrderPageCurrencyAggregateV5Schema = z.object({
  ...EffectiveOrderPageCurrencyAggregateV4Schema.shape,
  paymentFeeMinor: z.number().int().safe().nonnegative(),
  paymentFeeVatMinor: z.number().int().safe().nonnegative(),
  paymentFeeCustomerTotalMinor: z.number().int().safe().nonnegative(),
}).strict().superRefine((value, ctx) => {
  const { paymentFeeMinor, paymentFeeVatMinor, paymentFeeCustomerTotalMinor, ...legacy } = value;
  if (!EffectiveOrderPageCurrencyAggregateV4Schema.safeParse(legacy).success
    || paymentFeeCustomerTotalMinor < paymentFeeMinor || paymentFeeCustomerTotalMinor < paymentFeeVatMinor
    || BigInt(paymentFeeCustomerTotalMinor) > BigInt(paymentFeeMinor) + BigInt(paymentFeeVatMinor)
    || paymentFeeCustomerTotalMinor > value.currentOrderGrossValueMinor) {
    ctx.addIssue({ code: "custom", message: "Fee-aware order aggregate is inconsistent" });
  }
});
export type EffectiveOrderPageCurrencyAggregateV5 = z.infer<typeof EffectiveOrderPageCurrencyAggregateV5Schema>;

export const EffectiveOrderPageV5Schema = z.object({
  ...EffectiveOrderPageV4Schema.shape,
  schemaVersion: z.literal(5), data: z.array(EffectiveOrderListRowV5Schema),
  currencies: z.array(EffectiveOrderPageCurrencyAggregateV5Schema),
}).strict().superRefine((value, ctx) => {
  // V4 owns the pagination/aggregate envelope; V5 rows are validated separately above.
  const legacyEnvelope = EffectiveOrderPageV4Schema.safeParse({
    ...value, schemaVersion: 4, data: [],
    currencies: value.currencies.map(({ paymentFeeMinor, paymentFeeVatMinor, paymentFeeCustomerTotalMinor, ...legacy }) => legacy),
  });
  const currencies = new Map(value.currencies.map((currency) => [currency.currencyCode, currency]));
  if (!legacyEnvelope.success || value.data.length > value.pagination.limit || value.data.length > value.pagination.totalCount
    || new Set(value.data.map((row) => row.order.orderId)).size !== value.data.length
    || value.data.some((row) => currencies.get(row.order.currencyCode)?.minorUnitExponent !== row.order.minorUnitExponent)) {
    ctx.addIssue({ code: "custom", message: "Fee-aware order page envelope/row currency mismatch" });
  }
});
export type EffectiveOrderPageV5 = z.infer<typeof EffectiveOrderPageV5Schema>;


export const EffectiveOrderCsvSnapshotV5Schema = z.object({
  ...EffectiveOrderCsvSnapshotV4Schema.shape, contractVersion: z.literal("orders.effective-order.v5"),
}).strict().superRefine((value, ctx) => {
  if (!EffectiveOrderCsvSnapshotV4Schema.safeParse({ ...value, contractVersion: "orders.effective-order.v4" }).success) {
    ctx.addIssue({ code: "custom", message: "CSV snapshot revision vector is invalid" });
  }
});
export type EffectiveOrderCsvSnapshotV5 = z.infer<typeof EffectiveOrderCsvSnapshotV5Schema>;

export const EffectiveOrderCsvPaymentFeeV5Schema = z.object({
  ...PaymentFeeInputV1Schema.shape, paymentFeeBasisMinor: z.number().int().safe().nonnegative(),
  vatRatePpm: z.number().int().min(0).max(1_000_000),
}).strict().superRefine((value, ctx) => {
  if (!PaymentFeeInputV1Schema.safeParse({ paymentFeeType: value.paymentFeeType, paymentFeeValue: value.paymentFeeValue }).success) {
    ctx.addIssue({ code: "custom", message: "CSV fee descriptor is invalid" });
  }
});
export type EffectiveOrderCsvPaymentFeeV5 = z.infer<typeof EffectiveOrderCsvPaymentFeeV5Schema>;

function paymentFeeMatchesComponents(fee: EffectiveOrderCsvPaymentFeeV5, components: OrderCommercialComponentsV2): boolean {
  const round = (n: bigint, d: bigint) => (2n * n + d) / (2n * d);
  const amount = fee.paymentFeeType === "amount" ? BigInt(fee.paymentFeeValue)
    : round(BigInt(fee.paymentFeeBasisMinor) * BigInt(Math.round(fee.paymentFeeValue * 100)), 10_000n);
  const vat = round(amount * BigInt(fee.vatRatePpm), 1_000_000n + (components.taxMode === "inclusive" ? BigInt(fee.vatRatePpm) : 0n));
  return fee.paymentFeeBasisMinor === components.merchandiseNetMinor && amount === BigInt(components.paymentFeeMinor)
    && vat === BigInt(components.paymentFeeVatMinor);
}

export const OrderPaymentFeeFinancialSnapshotV1Schema = z.object({
  schemaVersion: z.literal(1), calculationVersion: z.literal(2), currencyCode: z.literal("VND"), minorUnitExponent: z.literal(0),
  paymentFee: EffectiveOrderCsvPaymentFeeV5Schema,
  components: OrderCommercialComponentsV2Schema,
}).strict().superRefine((value, ctx) => {
  const { components, paymentFee: fee } = value;
  if (!EffectiveOrderCsvPaymentFeeV5Schema.safeParse(fee).success || !OrderCommercialComponentsV2Schema.safeParse(components).success) return;
  const round = (amount: number) => {
    const n = BigInt(amount) * BigInt(fee.vatRatePpm);
    const d = 1_000_000n + (components.taxMode === "inclusive" ? BigInt(fee.vatRatePpm) : 0n);
    return (2n * n + d) / (2n * d);
  };
  if (!paymentFeeMatchesComponents(fee, components) || components.unclassifiedMinor !== 0
    || round(components.merchandiseNetMinor) !== BigInt(components.merchandiseVatMinor)
    || round(components.shippingMinor) !== BigInt(components.shippingVatMinor)) {
    ctx.addIssue({ code: "custom", message: "Frozen financial descriptor/basis/VAT drift" });
  }
});
export type OrderPaymentFeeFinancialSnapshotV1 = z.infer<typeof OrderPaymentFeeFinancialSnapshotV1Schema>;

export const EffectiveOrderCsvOrderRecordV5Schema = z.object({
  ...EffectiveOrderCsvOrderRecordV4Schema.shape, effectiveOrder: EffectiveOrderV2Schema,
  paymentFee: EffectiveOrderCsvPaymentFeeV5Schema.nullable(),
}).strict().superRefine((value, ctx) => {
  const { effectiveOrder: order, paymentFee: fee } = value;
  if ((value.customerAttribution === "linked") !== (value.customer !== null)
    || value.sourceOrder.orderId !== order.orderId || value.paymentSummary.currencyCode !== order.currencyCode) {
    ctx.addIssue({ code: "custom", message: "CSV order attribution/identity/currency mismatch" });
  }
  if ((order.componentVersion === 2) !== (fee !== null)) {
    ctx.addIssue({ code: "custom", message: "CSV fee descriptor must match the stored component version" });
    return;
  }
  if (!fee || !EffectiveOrderCsvPaymentFeeV5Schema.safeParse(fee).success) return;
  if (!paymentFeeMatchesComponents(fee, order.components)) {
    ctx.addIssue({ code: "custom", message: "CSV stored fee descriptor/basis/VAT drift" });
  }
});
export type EffectiveOrderCsvOrderRecordV5 = z.infer<typeof EffectiveOrderCsvOrderRecordV5Schema>;

// Fee columns exist only at order grain; line exports cannot multiply an order's fee.
export const ORDER_CSV_ORDER_V5_HEADERS = [...ORDER_CSV_ORDER_V4_HEADERS, "component_version", "payment_fee_type", "payment_fee_value",
  "payment_fee_basis_minor", "payment_fee_vat_rate_ppm", "payment_fee_minor", "payment_fee_vat_minor",
  "payment_fee_customer_total_minor", "payment_fee_commercial_revenue_ex_vat_minor"] as const;
export const ORDER_CSV_LINE_V5_HEADERS = [...ORDER_CSV_LINE_V4_HEADERS] as const;


type CommercialFeeFields = {
  currentPaymentFeeMinor: number; currentPaymentFeeVatMinor: number;
  currentPaymentFeeCustomerTotalMinor: number; currentPaymentFeeRevenueExVatMinor: number;
};
function commercialCurrencyV1ValidationView(value: DashboardCommercialCurrencyV1 & CommercialFeeFields) {
  const { currentPaymentFeeMinor, currentPaymentFeeVatMinor, currentPaymentFeeCustomerTotalMinor,
    currentPaymentFeeRevenueExVatMinor, dailyCurrentOrderGrossValueSeries, ...legacy } = value;
  const gross = value.currentOrderGrossValueMinor - currentPaymentFeeRevenueExVatMinor;
  if (![gross, value.currentOrderGrossValueMinor, value.currentShippingGrossValueMinor, value.validOrderCount]
    .every(number => Number.isSafeInteger(number) && number >= 0)) return undefined;
  return { ...legacy, currentOrderGrossValueMinor: gross,
    averageCurrentOrderValueMinor: value.validOrderCount === 0 ? null : Math.round(gross / value.validOrderCount),
    currentShippingSharePercent: percentageOneDecimalHalfUp(value.currentShippingGrossValueMinor, gross) };
}

export const DashboardCommercialCurrencyV2Schema = z.object({
  ...DashboardCommercialCurrencyV1Schema.shape,
  validOrderCount: z.number().int().safe().nonnegative(), cancelledOrderCohortCount: z.number().int().safe().nonnegative(),
  activeOrdersWithShippingCount: z.number().int().safe().nonnegative(), effectiveItemQuantity: z.number().int().safe().nonnegative(),
  currentPaymentFeeMinor: z.number().int().safe().nonnegative(), currentPaymentFeeVatMinor: z.number().int().safe().nonnegative(),
  currentPaymentFeeCustomerTotalMinor: z.number().int().safe().nonnegative(), currentPaymentFeeRevenueExVatMinor: z.number().int().safe().nonnegative(),
}).strict().superRefine((value, ctx) => {
  const fail = () => ctx.addIssue({ code: "custom", message: "Fee-aware commercial dashboard arithmetic/coverage mismatch" });
  const legacy = commercialCurrencyV1ValidationView(value);
  if (!legacy) { fail(); return; }
  const feeTotal = BigInt(value.currentPaymentFeeRevenueExVatMinor) + BigInt(value.currentPaymentFeeVatMinor);
  if (feeTotal !== BigInt(value.currentPaymentFeeCustomerTotalMinor)
    || value.currentPaymentFeeRevenueExVatMinor > value.currentPaymentFeeMinor || value.currentPaymentFeeMinor > value.currentPaymentFeeCustomerTotalMinor
    || value.currentPaymentFeeVatMinor > value.currentVatMinor || feeTotal > BigInt(value.currentOrderGrossValueMinor)
    || !DashboardCommercialCurrencyV1Schema.safeParse(legacy).success) fail();
  if (value.averageCurrentOrderValueMinor !== (value.validOrderCount === 0 ? null : Math.round(value.currentOrderGrossValueMinor / value.validOrderCount))
    || value.currentShippingSharePercent !== percentageOneDecimalHalfUp(value.currentShippingGrossValueMinor, value.currentOrderGrossValueMinor)) fail();
  if (value.dailyCurrentOrderGrossValueSeries
    && value.dailyCurrentOrderGrossValueSeries.reduce((sum, row) => sum + BigInt(row.currentOrderGrossValueMinor), 0n) !== BigInt(value.currentOrderGrossValueMinor)) fail();
});
export type DashboardCommercialCurrencyV2 = z.infer<typeof DashboardCommercialCurrencyV2Schema>;

export const DashboardCommercialSliceV2Schema = z.object({
  ...DashboardCommercialSliceV1Schema.shape, schemaVersion: z.literal(2), currencies: z.array(DashboardCommercialCurrencyV2Schema),
}).strict().superRefine((value, ctx) => {
  // V1 still validates shared cost/profit/scope ordering; its fee-free view never leaves validation.
  if (!DashboardCommercialSliceV1Schema.safeParse({ schemaVersion: 1,
    currencies: value.currencies.map(commercialCurrencyV1ValidationView) }).success) {
    ctx.addIssue({ code: "custom", message: "Fee-aware commercial dashboard currency ordering/identity mismatch" });
  }
  const daily = value.dailyActiveOrderCountSeries;
  if (daily ? value.currencies.some(row => !row.dailyCurrentOrderGrossValueSeries
    || JSON.stringify(row.dailyCurrentOrderGrossValueSeries.map(point => point.localDate)) !== JSON.stringify(daily.map(point => point.localDate)))
    : value.currencies.some(row => row.dailyCurrentOrderGrossValueSeries !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Fee-aware commercial dashboard daily labels mismatch" });
  }
  if (daily && daily.reduce((sum, row) => sum + BigInt(row.activeOrderCount), 0n) !== value.currencies.reduce((sum, row) => sum + BigInt(row.validOrderCount), 0n)) {
    ctx.addIssue({ code: "custom", message: "Fee-aware commercial dashboard daily count mismatch" });
  }
});
export type DashboardCommercialSliceV2 = z.infer<typeof DashboardCommercialSliceV2Schema>;


export const DashboardFeeNegativeWarningV1Schema = z.enum(["missing_frozen_allocation", "invalid_frozen_allocation", "allocation_binding_mismatch",
  "evidence_unavailable", "ambiguous_legacy_basis"]);
export const DashboardFeeNegativeCurrencyV1Schema = z.object({
  currencyCode: DashboardCommercialCurrencyV1Schema.shape.currencyCode, minorUnitExponent: z.number().int().min(0).max(3),
  feeRevenueReversedExVatMinor: z.number().int().safe().nonnegative().nullable(),
  verifiedSubsetFeeRevenueReversedExVatMinor: z.number().int().safe().nonnegative(),
  verifiedSubsetSettlementOnlyMinor: z.number().int().safe().nonnegative(),
  coverage: z.object({ status: z.enum(["available", "partial", "unavailable"]), coveredEventCount: z.number().int().safe().nonnegative(),
    excludedEventCount: z.number().int().safe().nonnegative(), totalEventCount: z.number().int().safe().positive(),
    coveredNegativeMinor: z.number().int().safe().nonnegative(), excludedNegativeMinor: z.number().int().safe().nonnegative(), totalNegativeMinor: z.number().int().safe().nonnegative() }).strict(),
  warnings: z.array(DashboardFeeNegativeWarningV1Schema),
}).strict().superRefine((value, ctx) => {
  const c = value.coverage, complete = c.excludedEventCount === 0;
  if (BigInt(c.coveredEventCount) + BigInt(c.excludedEventCount) !== BigInt(c.totalEventCount)
    || BigInt(c.coveredNegativeMinor) + BigInt(c.excludedNegativeMinor) !== BigInt(c.totalNegativeMinor)
    || (c.coveredEventCount === 0 && c.coveredNegativeMinor !== 0) || (c.excludedEventCount === 0 && c.excludedNegativeMinor !== 0)
    || c.status !== (complete ? "available" : c.coveredEventCount === 0 ? "unavailable" : "partial")
    || value.feeRevenueReversedExVatMinor !== (complete ? value.verifiedSubsetFeeRevenueReversedExVatMinor : null)
    || BigInt(value.verifiedSubsetFeeRevenueReversedExVatMinor) + BigInt(value.verifiedSubsetSettlementOnlyMinor) > BigInt(c.coveredNegativeMinor)
    || (!c.coveredEventCount && (value.verifiedSubsetFeeRevenueReversedExVatMinor !== 0 || value.verifiedSubsetSettlementOnlyMinor !== 0))
    || (complete ? value.warnings.length !== 0 : value.warnings.length === 0)
    || JSON.stringify(value.warnings) !== JSON.stringify([...new Set(value.warnings)].sort())
    || (value.verifiedSubsetFeeRevenueReversedExVatMinor !== 0 && (value.currencyCode !== "VND" || value.minorUnitExponent !== 0))) {
    ctx.addIssue({ code: "custom", message: "Negative-event fee revenue coverage/headline is inconsistent" });
  }
});
export type DashboardFeeNegativeCurrencyV1 = z.infer<typeof DashboardFeeNegativeCurrencyV1Schema>;
export const DashboardFeeNegativeSliceV1Schema = z.object({ schemaVersion: z.literal(1), aggregateReadSource: z.literal("app.payment_events"),
  currencies: z.array(DashboardFeeNegativeCurrencyV1Schema) }).strict().superRefine((value, ctx) => {
    const codes = value.currencies.map(row => row.currencyCode);
    if (JSON.stringify(codes) !== JSON.stringify([...new Set(codes)].sort())) ctx.addIssue({ code: "custom", message: "Negative-event fee currencies must be unique and sorted" });
  });
export type DashboardFeeNegativeSliceV1 = z.infer<typeof DashboardFeeNegativeSliceV1Schema>;


export const DashboardFeeJournalWarningV1Schema = z.enum(["missing_source_mapping", "unsupported_reference_type", "unbalanced_journal",
  "fractional_minor_units", "unsafe_journal_units", "fee_lineage_mismatch", "unavailable_refund_evidence", "unsupported_currency"]);
export const DashboardFeeJournalCurrencyV1Schema = z.object({
  currencyCode: DashboardCommercialCurrencyV1Schema.shape.currencyCode, minorUnitExponent: z.number().int().min(0).max(3),
  revenueExcludingVatMinor: z.number().int().safe().nullable(), verifiedSubsetRevenueExcludingVatMinor: z.number().int().safe(),
  coverage: z.object({ status: z.enum(["available", "partial", "unavailable"]), totalJournalCount: z.number().int().safe().nonnegative(),
    coveredJournalCount: z.number().int().safe().nonnegative(), excludedJournalCount: z.number().int().safe().nonnegative() }).strict(),
  warnings: z.array(DashboardFeeJournalWarningV1Schema),
}).strict().superRefine((value, ctx) => {
  const c = value.coverage, exact = c.excludedJournalCount === 0;
  if (BigInt(c.coveredJournalCount) + BigInt(c.excludedJournalCount) !== BigInt(c.totalJournalCount)
    || c.status !== (exact ? "available" : c.coveredJournalCount === 0 ? "unavailable" : "partial")
    || value.revenueExcludingVatMinor !== (exact ? value.verifiedSubsetRevenueExcludingVatMinor : null)
    || (c.coveredJournalCount === 0 && value.verifiedSubsetRevenueExcludingVatMinor !== 0)
    || (exact ? value.warnings.length !== 0 : value.warnings.length === 0)
    || JSON.stringify(value.warnings) !== JSON.stringify([...new Set(value.warnings)].sort())) {
    ctx.addIssue({ code: "custom", message: "Fee journal exact revenue/coverage is inconsistent" });
  }
});
export type DashboardFeeJournalCurrencyV1 = z.infer<typeof DashboardFeeJournalCurrencyV1Schema>;
export const DashboardFeeJournalSliceV1Schema = z.object({ schemaVersion: z.literal(1), aggregateReadSource: z.literal("accounting.journal_entries"),
  metricTimeBasis: z.literal("accounting_source_occurred_at"), currencies: z.array(DashboardFeeJournalCurrencyV1Schema) }).strict().superRefine((value, ctx) => {
    const codes = value.currencies.map(row => row.currencyCode);
    if (JSON.stringify(codes) !== JSON.stringify([...new Set(codes)].sort())) ctx.addIssue({ code: "custom", message: "Fee journal currencies must be unique and sorted" });
  });
export type DashboardFeeJournalSliceV1 = z.infer<typeof DashboardFeeJournalSliceV1Schema>;


export const CreatorSalesDashboardCurrencyV3Schema = z.object({
  ...CreatorSalesDashboardCurrencyV2Schema.shape,
  currentPaymentFeeMinor: z.number().int().safe().nonnegative(), currentPaymentFeeVatMinor: z.number().int().safe().nonnegative(),
  currentPaymentFeeCustomerTotalMinor: z.number().int().safe().nonnegative(), recordedGrossCollectionsMinor: z.number().int().safe().nonnegative(),
  recordedPaymentFeeMinor: z.number().int().safe(), recordedPaymentFeeVatMinor: z.number().int().safe(), recordedPaymentFeeCustomerTotalMinor: z.number().int().safe(),
}).strict().superRefine((value, ctx) => {
  if (value.activeOrderCount > value.orderCount || value.activeOrdersWithShippingCount > value.activeOrderCount
    || value.currentPaymentFeeCustomerTotalMinor < value.currentPaymentFeeMinor || value.currentPaymentFeeCustomerTotalMinor < value.currentPaymentFeeVatMinor
    || BigInt(value.currentPaymentFeeCustomerTotalMinor) > BigInt(value.currentPaymentFeeMinor) + BigInt(value.currentPaymentFeeVatMinor)
    || value.currentPaymentFeeCustomerTotalMinor > value.currentOrderGrossValueMinor
    || value.averageCurrentOrderValueMinor !== (value.activeOrderCount === 0 ? null : Math.round(value.currentOrderGrossValueMinor / value.activeOrderCount))
    || value.dailySeries.reduce((sum, row) => sum + BigInt(row.currentOrderGrossValueMinor), 0n) !== BigInt(value.currentOrderGrossValueMinor)
    || value.dailySeries.reduce((sum, row) => sum + BigInt(row.activeOrderCount), 0n) !== BigInt(value.activeOrderCount)
    || new Set(value.paymentMethods.map(row => row.method)).size !== value.paymentMethods.length
    || value.paymentMethods.some(row => row.netMinor !== row.grossMinor - row.negativeMinor)
    || value.paymentMethods.reduce((sum, row) => sum + BigInt(row.grossMinor), 0n) !== BigInt(value.recordedGrossCollectionsMinor)) {
    ctx.addIssue({ code: "custom", message: "Fee-aware creator dashboard sales arithmetic mismatch" });
  }
});
export type CreatorSalesDashboardCurrencyV3 = z.infer<typeof CreatorSalesDashboardCurrencyV3Schema>;

export const CreatorSalesDashboardFeeFinancialV3Schema = z.object({
  currencies: z.array(z.object({ currencyCode: DashboardCommercialCurrencyV1Schema.shape.currencyCode, minorUnitExponent: z.number().int().min(0).max(3),
    currentPaymentFeeRevenueExVatMinor: z.number().int().safe().nonnegative(), recordedPaymentFeeRevenueExVatMinor: z.number().int().safe() }).strict()),
  negatives: DashboardFeeNegativeSliceV1Schema, journals: DashboardFeeJournalSliceV1Schema,
}).strict();
export const CreatorSalesDashboardV3Schema = z.object({
  ...CreatorSalesDashboardV2Schema.shape, schemaVersion: z.literal(3), currencies: z.array(CreatorSalesDashboardCurrencyV3Schema),
  feeFinancial: CreatorSalesDashboardFeeFinancialV3Schema.optional(),
}).strict().superRefine((value, ctx) => {
  const { feeFinancial, ...rest } = value;
  const legacy = CreatorSalesDashboardV2Schema.safeParse({ ...rest, schemaVersion: 2,
    currencies: value.currencies.map(({ currentPaymentFeeMinor, currentPaymentFeeVatMinor, currentPaymentFeeCustomerTotalMinor, recordedGrossCollectionsMinor,
      recordedPaymentFeeMinor, recordedPaymentFeeVatMinor, recordedPaymentFeeCustomerTotalMinor, ...old }) => old) });
  const codes = value.currencies.map(row => row.currencyCode), byCode = new Map(value.currencies.map(row => [row.currencyCode, row]));
  if (!legacy.success || JSON.stringify(codes) !== JSON.stringify([...new Set(codes)].sort())
    || (value.audience === "self" ? feeFinancial !== undefined || value.creatorSelection.mode !== "selected"
      || value.creatorSelection.creatorOperatorIds.length !== 1 || value.creatorOptions.some(option => option.operatorId !== value.creatorSelection.creatorOperatorIds[0])
      : feeFinancial === undefined)) {
    ctx.addIssue({ code: "custom", message: "Fee-aware creator dashboard audience/identity mismatch" });
  }
  if (feeFinancial) {
    if (JSON.stringify(feeFinancial.currencies.map(row => row.currencyCode)) !== JSON.stringify(codes)) {
      ctx.addIssue({ code: "custom", message: "Owner fee financial currency coverage mismatch" });
    }
    for (const row of feeFinancial.currencies) {
      const sales = byCode.get(row.currencyCode);
      if (!sales || sales.minorUnitExponent !== row.minorUnitExponent
        || row.currentPaymentFeeRevenueExVatMinor !== sales.currentPaymentFeeCustomerTotalMinor - sales.currentPaymentFeeVatMinor
        || row.recordedPaymentFeeRevenueExVatMinor !== sales.recordedPaymentFeeCustomerTotalMinor - sales.recordedPaymentFeeVatMinor) {
        ctx.addIssue({ code: "custom", message: "Owner fee financial basis mismatch" });
      }
    }
    for (const row of [...feeFinancial.negatives.currencies, ...feeFinancial.journals.currencies]) {
      if (byCode.get(row.currencyCode)?.minorUnitExponent !== row.minorUnitExponent) ctx.addIssue({ code: "custom", message: "Owner fee source currency drift" });
    }
  }
});
export type CreatorSalesDashboardV3 = z.infer<typeof CreatorSalesDashboardV3Schema>;
