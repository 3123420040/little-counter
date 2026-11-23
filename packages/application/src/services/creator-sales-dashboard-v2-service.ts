import {
  CreatorSalesDashboardV3Schema, DashboardCommercialSliceV2Schema, RecordedGrossCollectionSliceV2Schema,
  type CreatorSalesDashboardV3,
  CreatorSalesDashboardV2Schema,
  CreatorSelectionV1Schema,
  ReportScopeSchema,
  type CreatorSalesDashboardV2,
  type CreatorSelectionV1,
  type ReportScope,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import {
  withDashboardReadSnapshot,
  type DashboardLocalDateRangeInput,
} from "./dashboard-report-foundation";
import { readDashboardCommercialSliceV1, readDashboardCommercialSliceV2 } from "./dashboard-commercial-slice";
import { readDashboardPaymentFlowSliceV1 } from "./dashboard-payment-flow-slice";
import { readDashboardOperationalSnapshotV1 } from "./dashboard-operational-snapshot";
import { readDashboardAccountingSliceV1 } from "./dashboard-accounting-slice";
import { readDashboardRecordedCollectionSliceV1, readDashboardRecordedCollectionSliceV2 } from "./dashboard-recorded-collection-slice";
import { assertDashboardSourceAlignment, composeDashboardPartialFinancialModelV1 } from "./dashboard-partial-financial-model";
import { assertCreatorSelectionInScopeV1 } from "./creator-sales-overview-service";

import { readDashboardFeeNegativeSliceV1 } from "./dashboard-fee-negative-slice";
import { readDashboardFeeJournalSliceV1 } from "./dashboard-fee-journal-slice";

export interface CreatorSalesDashboardReadRequestV2 {
  scope: ReportScope;
  range: DashboardLocalDateRangeInput;
  creatorSelection: CreatorSelectionV1;
  audience: "full" | "self";
  selfOperatorId?: string;
  statementTimeoutMs: number;
}

function normalizedScope(input: ReportScope): ReportScope {
  const parsed = ReportScopeSchema.safeParse(input);
  if (!parsed.success || new Set(parsed.data.storeIds).size !== parsed.data.storeIds.length) {
    throw new PlatformError(
      "scope_required",
      "Creator sales dashboard requires one merchant and a unique authorized store set",
      409,
    );
  }
  return {
    scopeKind: "report",
    merchantId: parsed.data.merchantId,
    storeIds: [...parsed.data.storeIds].sort(),
  };
}

/**
 * Self responses use an explicit sales allowlist. Only full audiences read
 * accounting; operational counts retain their merchant/selected-store scope.
 */
async function readCreatorSalesDashboard(
  client: PoolClient,
  input: CreatorSalesDashboardReadRequestV2,
  version: 2 | 3,
): Promise<CreatorSalesDashboardV2 | CreatorSalesDashboardV3> {
  const scope = normalizedScope(input.scope);
  const creatorSelection = CreatorSelectionV1Schema.parse(input.creatorSelection);
  if (input.audience === "self") {
    if (
      !input.selfOperatorId
      || creatorSelection.mode !== "selected"
      || creatorSelection.creatorOperatorIds.length !== 1
      || creatorSelection.creatorOperatorIds[0] !== input.selfOperatorId
    ) {
      throw new PlatformError(
        "forbidden",
        "Self dashboard selection must be the authenticated operator",
        403,
      );
    }
  }

  const snapshot = await withDashboardReadSnapshot(client, {
    scope,
    range: input.range,
    statementTimeoutMs: input.statementTimeoutMs,
    storeStatusPolicy: input.audience === "full" ? "active_or_suspended" : "active",
  }, async (snapshotClient, context) => {
    const creatorOptions = await assertCreatorSelectionInScopeV1(
      snapshotClient,
      context.normalizedScope,
      creatorSelection,
    );
    const commercial = await (version === 3 ? readDashboardCommercialSliceV2 : readDashboardCommercialSliceV1)(
      snapshotClient,
      context,
      creatorSelection,
    );
    // This preserves the Dashboard payment time basis: posted event date in
    // the selected store window, attributed to the original order creator.
    const paymentFlows = await readDashboardPaymentFlowSliceV1(
      snapshotClient,
      context,
      creatorSelection,
    );
    const operationalSnapshot = await readDashboardOperationalSnapshotV1(snapshotClient, context);
    const financial = input.audience === "full"
      ? await readDashboardAccountingSliceV1(snapshotClient, context, creatorSelection)
      : undefined;
    const collections = await (version === 3 ? readDashboardRecordedCollectionSliceV2 : readDashboardRecordedCollectionSliceV1)(snapshotClient, context, { enabled: true }, creatorSelection);
    if (!collections.enabled) throw new PlatformError("feature_unavailable", "Recorded collection reader is unavailable", 503);
    const feeCommercial = version === 3 ? DashboardCommercialSliceV2Schema.parse(commercial) : null;
    const feeCollections = version === 3 ? RecordedGrossCollectionSliceV2Schema.parse(collections.data) : null;
    if (feeCommercial && feeCollections) assertDashboardSourceAlignment(feeCommercial, feeCollections, paymentFlows, financial);
    else {
      if (commercial.schemaVersion !== 1 || collections.data.schemaVersion !== 1) throw new PlatformError("dashboard_response_invalid", "Legacy dashboard source version drift", 502);
      composeDashboardPartialFinancialModelV1(commercial, collections.data, { enabled: true }, paymentFlows, operationalSnapshot, financial);
    }
    const negativeFees = version === 3 && input.audience === "full"
      ? await readDashboardFeeNegativeSliceV1(snapshotClient, context, { enabled: true }, creatorSelection) : undefined;
    const feeJournals = version === 3 && input.audience === "full"
      ? await readDashboardFeeJournalSliceV1(snapshotClient, context, creatorSelection) : undefined;
    if (negativeFees?.enabled === false) throw new PlatformError("feature_unavailable", "Negative fee reader is unavailable", 503);
    if (negativeFees?.enabled) for (const negative of negativeFees.data.currencies) {
      const flow = paymentFlows.find(row => row.currencyCode === negative.currencyCode && row.minorUnitExponent === negative.minorUnitExponent);
      if (!flow || negative.coverage.totalNegativeMinor !== flow.negativeCollectionsMinor
        || BigInt(negative.coverage.totalEventCount) !== flow.methods.reduce((sum, row) => sum + BigInt(row.postedNegativeEventCount), 0n)) {
        throw new PlatformError("dashboard_response_invalid", "Negative fee and payment event coverage drift", 502);
      }
    }
    if (negativeFees?.enabled) for (const flow of paymentFlows) {
      if ((flow.negativeCollectionsMinor !== 0 || flow.methods.some(row => row.postedNegativeEventCount !== 0))
        && !negativeFees.data.currencies.some(row => row.currencyCode === flow.currencyCode && row.minorUnitExponent === flow.minorUnitExponent)) {
        throw new PlatformError("dashboard_response_invalid", "Negative fee event source is incomplete", 502);
      }
    }
    const collectionByCurrency = new Map(collections.data.currencies.map(row => [`${row.currencyCode}:${row.minorUnitExponent}`, row]));
    const paymentByCurrency = new Map(
      paymentFlows.map((currency) => [
        `${currency.currencyCode}:${currency.minorUnitExponent}`,
        currency,
      ]),
    );
    const commercialByCurrency = new Map(
      commercial.currencies.map((currency) => [
        `${currency.currencyCode}:${currency.minorUnitExponent}`,
        currency,
      ]),
    );
    const currencyKeys = [...new Set([
      ...commercialByCurrency.keys(),
      ...paymentByCurrency.keys(),
      ...collectionByCurrency.keys(),
      ...(feeJournals?.currencies ?? []).map(row => `${row.currencyCode}:${row.minorUnitExponent}`),
      ...(negativeFees?.enabled ? negativeFees.data.currencies : []).map(row => `${row.currencyCode}:${row.minorUnitExponent}`),
      ...(financial?.currencies || []).map((currency) => `${currency.currencyCode}:${currency.minorUnitExponent}`),
    ])].sort();
    const currencies = currencyKeys.map((key) => {
      const commercialCurrency = commercialByCurrency.get(key);
      const paymentCurrency = paymentByCurrency.get(key);
      const [currencyCode, exponentText] = key.split(":");
      const minorUnitExponent = commercialCurrency?.minorUnitExponent
        ?? paymentCurrency?.minorUnitExponent
        ?? Number(exponentText);
      if (!currencyCode || !Number.isSafeInteger(minorUnitExponent) || minorUnitExponent < 0) {
        throw new PlatformError("dashboard_response_invalid", "Creator sales currency is invalid", 502);
      }
      const activeOrderCount = commercialCurrency?.validOrderCount ?? 0;
      const cancelledOrderCount = commercialCurrency?.cancelledOrderCohortCount ?? 0;
      const orderCount = activeOrderCount + cancelledOrderCount;
      if (!Number.isSafeInteger(orderCount)) {
        throw new PlatformError("dashboard_response_invalid", "Creator sales order count is invalid", 502);
      }
      const fee = feeCommercial?.currencies.find(row => row.currencyCode === currencyCode && row.minorUnitExponent === minorUnitExponent);
      const collection = feeCollections?.currencies.find(row => row.currencyCode === currencyCode && row.minorUnitExponent === minorUnitExponent);
      return {
        ...(version === 3 ? {
          currentPaymentFeeMinor: fee?.currentPaymentFeeMinor ?? 0, currentPaymentFeeVatMinor: fee?.currentPaymentFeeVatMinor ?? 0,
          currentPaymentFeeCustomerTotalMinor: fee?.currentPaymentFeeCustomerTotalMinor ?? 0,
          recordedGrossCollectionsMinor: collection?.recordedGrossCollectionsMinor ?? 0,
          recordedPaymentFeeMinor: collection?.components.paymentFeeMinor ?? 0, recordedPaymentFeeVatMinor: collection?.components.paymentFeeVatMinor ?? 0,
          recordedPaymentFeeCustomerTotalMinor: collection ? collection.components.paymentFeeMinor + collection.components.paymentFeeVatAddedToPriceMinor : 0,
        } : {}),
        currencyCode,
        minorUnitExponent,
        orderCount,
        activeOrderCount,
        currentOrderGrossValueMinor: commercialCurrency?.currentOrderGrossValueMinor ?? 0,
        effectiveItemQuantity: commercialCurrency?.effectiveItemQuantity ?? 0,
        currentShippingRevenueExVatMinor: commercialCurrency?.currentShippingRevenueExVatMinor ?? 0,
        averageCurrentOrderValueMinor: commercialCurrency?.averageCurrentOrderValueMinor ?? null,
        activeOrdersWithShippingCount: commercialCurrency?.activeOrdersWithShippingCount ?? 0,
        currentShippingSharePercent: commercialCurrency?.currentShippingSharePercent ?? null,
        dailySeries: (commercial.dailyActiveOrderCountSeries || []).map((point, index) => ({
          localDate: point.localDate,
          activeOrderCount: point.activeOrderCount,
          currentOrderGrossValueMinor: commercialCurrency?.dailyCurrentOrderGrossValueSeries?.[index]?.currentOrderGrossValueMinor ?? 0,
        })),
        topProducts: (commercialCurrency?.topProducts || []).map((product) => ({
          productId: product.productId, variantId: product.variantId,
          skuSnapshot: product.skuSnapshot, titleSnapshot: product.titleSnapshot,
          archivedVariant: product.archivedVariant, quantity: product.quantity,
          grossLineSalesBeforeDiscountMinor: product.grossLineSalesBeforeDiscountMinor,
        })),
        paymentMethods: (paymentCurrency?.methods || []).map((method) => ({
          method: method.method.toLowerCase(),
          postedChargeOrderCount: method.postedChargeOrderCount,
          postedNegativeEventCount: method.postedNegativeEventCount,
          grossMinor: method.recordedGrossCollectionsMinor,
          negativeMinor: method.recordedNegativeCollectionsMinor,
          netMinor: method.recordedNetCollectionsMinor,
        })).sort((left, right) => left.method.localeCompare(right.method)),
      };
    });

    return {
      schemaVersion: version,
      ...(version === 3 && input.audience === "full" && negativeFees?.enabled && feeJournals ? { feeFinancial: {
        currencies: currencies.map(row => {
          const fee = feeCommercial?.currencies.find(c => c.currencyCode === row.currencyCode && c.minorUnitExponent === row.minorUnitExponent);
          const collected = feeCollections?.currencies.find(c => c.currencyCode === row.currencyCode && c.minorUnitExponent === row.minorUnitExponent)?.components;
          return { currencyCode: row.currencyCode, minorUnitExponent: row.minorUnitExponent,
            currentPaymentFeeRevenueExVatMinor: fee?.currentPaymentFeeRevenueExVatMinor ?? 0,
            recordedPaymentFeeRevenueExVatMinor: collected ? collected.paymentFeeMinor - collected.paymentFeeVatIncludedInPriceMinor : 0 };
        }), negatives: negativeFees.data, journals: feeJournals,
      } } : {}),
      audience: input.audience,
      creatorSelection,
      // A self response intentionally does not disclose the team selector.
      creatorOptions: input.audience === "self"
        ? creatorOptions.filter((option) => option.operatorId === input.selfOperatorId)
        : creatorOptions,
      asOf: context.reportAsOf,
      operationalSnapshot,
      ...(financial ? { financial } : {}),
      currencies,
    };
  });

  const { metricTimeBasis: _metricTimeBasis, ...context } = snapshot.context;
  return version === 3 ? CreatorSalesDashboardV3Schema.parse({ ...snapshot.data, context }) : CreatorSalesDashboardV2Schema.parse({ ...snapshot.data, context });
}

export async function readCreatorSalesDashboardV2(client: PoolClient, input: CreatorSalesDashboardReadRequestV2): Promise<CreatorSalesDashboardV2> {
  return CreatorSalesDashboardV2Schema.parse(await readCreatorSalesDashboard(client, input, 2));
}
export async function readCreatorSalesDashboardV3(client: PoolClient, input: CreatorSalesDashboardReadRequestV2): Promise<CreatorSalesDashboardV3> {
  return CreatorSalesDashboardV3Schema.parse(await readCreatorSalesDashboard(client, input, 3));
}
