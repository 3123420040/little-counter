import {
  DashboardAccountingSliceV1Schema,
  DashboardCommercialSliceV1Schema,
  DashboardOperationalSnapshotV1Schema,
  DashboardPartialFinancialModelV1Schema,
  RecordedGrossCollectionSliceV1Schema,
  type DashboardAccountingSliceV1,
  type DashboardCommercialCurrencyV1,
  type DashboardCommercialSliceV1,
  type DashboardOperationalSnapshotV1,
  type DashboardPartialFinancialCurrencyV1,
  type DashboardPartialFinancialModelV1,
  type RecordedGrossCollectionComponentsV1,
  type RecordedGrossCollectionCurrencyV1,
  type RecordedGrossCollectionSliceV1,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import {
  withDashboardReadSnapshot,
  type DashboardSnapshotRequest,
  type DashboardSnapshotResult,
} from "./dashboard-report-foundation";
import { readDashboardCommercialSliceV1 } from "./dashboard-commercial-slice";
import { readDashboardRecordedCollectionSliceV1 } from "./dashboard-recorded-collection-slice";
import {
  readDashboardPaymentFlowSliceV1,
  type DashboardPaymentFlowCurrencyV1,
} from "./dashboard-payment-flow-slice";
import { readDashboardOperationalSnapshotV1 } from "./dashboard-operational-snapshot";
import { readDashboardAccountingSliceV1 } from "./dashboard-accounting-slice";

export const DASHBOARD_PARTIAL_FINANCIAL_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: true,
});

const COMPLETE_FINANCIAL_UNAVAILABLE_METRICS_V1 = [
  "commercialOutstandingAsOfMinor",
  "revenueExcludingVatMinor",
  "vatLiabilityMinor",
  "cogsRecognizedMinor",
  "providerFeesMinor",
  "netProviderPayoutMinor",
] as const;

interface PartialCurrentOrderV1 {
  validOrderCount: number;
  currentOrderGrossValueMinor: number;
  currentVatMinor: number;
  currentUnclassifiedMinor: number;
  dataQualityStatus: "complete" | "partial" | "unavailable";
  commercialMetrics?: {
    cancelledOrderCohortCount: number;
    activeOrdersWithShippingCount: number;
    currentMerchandiseGrossValueMinor: number;
    currentDiscountMinor: number;
    currentMerchandiseRevenueExVatMinor: number;
    currentShippingRevenueExVatMinor: number;
    currentShippingGrossValueMinor: number;
    currentShippingSharePercent: number | null;
    effectiveItemQuantity: number;
    averageCurrentOrderValueMinor: number | null;
    currentCogsMinor: number | null;
    currentMerchandiseGrossProfitMinor: number | null;
    currentContributionBeforeShippingCostMinor: number | null;
    topProducts: DashboardCommercialCurrencyV1["topProducts"];
  };
}

type PartialRecordedCollectionV1 = {
  status: "none_in_selected_window";
  postedChargeEventCount: 0;
  recordedGrossCollectionsMinor: 0;
  components: null;
} | {
  status: "available";
  postedChargeEventCount: number;
  recordedGrossCollectionsMinor: number;
  components: RecordedGrossCollectionComponentsV1;
};

export type DashboardPartialFinancialComposeResultV1 =
  | { enabled: false; status: "disabled" }
  | { enabled: true; data: DashboardPartialFinancialModelV1 };

export type DashboardPartialFinancialSnapshotResultV1 =
  | { enabled: false; status: "disabled" }
  | {
      enabled: true;
      snapshot: DashboardSnapshotResult<DashboardPartialFinancialModelV1>;
    };

export class DashboardPartialFinancialModelErrorV1 extends PlatformError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("dashboard_partial_financial_invalid", message, 422, details);
    this.name = "DashboardPartialFinancialModelErrorV1";
  }
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new DashboardPartialFinancialModelErrorV1(message, details);
}

function currentOrder(
  commercial: DashboardCommercialCurrencyV1 | undefined,
): PartialCurrentOrderV1 {
  if (!commercial) {
    return {
      validOrderCount: 0,
      currentOrderGrossValueMinor: 0,
      currentVatMinor: 0,
      currentUnclassifiedMinor: 0,
      dataQualityStatus: "complete",
    };
  }
  return {
    validOrderCount: commercial.validOrderCount,
    currentOrderGrossValueMinor: commercial.currentOrderGrossValueMinor,
    currentVatMinor: commercial.currentVatMinor,
    currentUnclassifiedMinor: commercial.currentUnclassifiedMinor,
    dataQualityStatus: commercial.dataQuality.status,
    commercialMetrics: {
      cancelledOrderCohortCount: commercial.cancelledOrderCohortCount,
      activeOrdersWithShippingCount: commercial.activeOrdersWithShippingCount,
      currentMerchandiseGrossValueMinor: commercial.currentMerchandiseGrossValueMinor,
      currentDiscountMinor: commercial.currentDiscountMinor,
      currentMerchandiseRevenueExVatMinor: commercial.currentMerchandiseRevenueExVatMinor,
      currentShippingRevenueExVatMinor: commercial.currentShippingRevenueExVatMinor,
      currentShippingGrossValueMinor: commercial.currentShippingGrossValueMinor,
      currentShippingSharePercent: commercial.currentShippingSharePercent,
      effectiveItemQuantity: commercial.effectiveItemQuantity,
      averageCurrentOrderValueMinor: commercial.averageCurrentOrderValueMinor,
      currentCogsMinor: commercial.currentCogsMinor,
      currentMerchandiseGrossProfitMinor: commercial.currentMerchandiseGrossProfitMinor,
      currentContributionBeforeShippingCostMinor: commercial.currentContributionBeforeShippingCostMinor,
      topProducts: structuredClone(commercial.topProducts),
    },
  };
}

function recordedCollection(
  collection: RecordedGrossCollectionCurrencyV1 | undefined,
): PartialRecordedCollectionV1 {
  if (!collection) {
    return {
      status: "none_in_selected_window",
      postedChargeEventCount: 0,
      recordedGrossCollectionsMinor: 0,
      components: null,
    };
  }
  return {
    status: "available",
    postedChargeEventCount: collection.postedChargeEventCount,
    recordedGrossCollectionsMinor: collection.recordedGrossCollectionsMinor,
    components: structuredClone(collection.components),
  };
}

function labelsOf(series: Array<{ localDate: string }>): string[] {
  return series.map((point) => point.localDate);
}

function labelsMatch(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((label, index) => label === right[index]);
}

export function assertDashboardSourceAlignment(
  commercial: Pick<DashboardCommercialSliceV1, "dailyActiveOrderCountSeries"> & { currencies: ReadonlyArray<Pick<DashboardCommercialCurrencyV1, "currencyCode" | "minorUnitExponent" | "currentOrderGrossValueMinor">> },
  collections: { currencies: ReadonlyArray<Pick<RecordedGrossCollectionCurrencyV1, "currencyCode" | "minorUnitExponent" | "recordedGrossCollectionsMinor" | "dailyRecordedGrossCollectionsSeries">> },
  paymentFlows: readonly DashboardPaymentFlowCurrencyV1[],
  accounting?: DashboardAccountingSliceV1,
): void {
  const daily = commercial.dailyActiveOrderCountSeries, dailyLabels = daily ? labelsOf(daily) : null;
  if (!dailyLabels && collections.currencies.some(row => row.dailyRecordedGrossCollectionsSeries !== undefined)) {
    return invalid("dashboard daily collection labels require commercial date labels");
  }
  if (dailyLabels) for (const currency of collections.currencies) {
    if (!currency.dailyRecordedGrossCollectionsSeries || !labelsMatch(dailyLabels, labelsOf(currency.dailyRecordedGrossCollectionsSeries))) {
      return invalid("dashboard daily collection labels drift", { currencyCode: currency.currencyCode });
    }
  }
  const exponents = new Map<string, number>();
  for (const family of [commercial.currencies, collections.currencies, paymentFlows, accounting?.currencies ?? []]) {
    const seen = new Set<string>();
    for (const row of family) {
      if (seen.has(row.currencyCode) || (exponents.has(row.currencyCode) && exponents.get(row.currencyCode) !== row.minorUnitExponent)) {
        return invalid("dashboard currency exponent drift", { currencyCode: row.currencyCode });
      }
      seen.add(row.currencyCode); exponents.set(row.currencyCode, row.minorUnitExponent);
    }
  }
  for (const row of collections.currencies) {
    const gross = commercial.currencies.find(c => c.currencyCode === row.currencyCode)?.currentOrderGrossValueMinor ?? 0;
    const negative = paymentFlows.find(c => c.currencyCode === row.currencyCode)?.negativeCollectionsMinor ?? 0;
    if (!Number.isSafeInteger(row.recordedGrossCollectionsMinor - gross) || !Number.isSafeInteger(row.recordedGrossCollectionsMinor - negative)) {
      return invalid("dashboard comparison exceeds safe integer", { currencyCode: row.currencyCode });
    }
  }
}

export function composeDashboardPartialFinancialModelV1(
  commercialInput: DashboardCommercialSliceV1,
  collectionInput: RecordedGrossCollectionSliceV1,
  config: { enabled: boolean } = DASHBOARD_PARTIAL_FINANCIAL_DEFAULT_CONFIG_V1,
  paymentFlows: DashboardPaymentFlowCurrencyV1[] = [],
  operationalInput?: DashboardOperationalSnapshotV1,
  accountingInput?: DashboardAccountingSliceV1,
): DashboardPartialFinancialComposeResultV1 {
  if (config.enabled !== true) return { enabled: false, status: "disabled" };
  const commercial = DashboardCommercialSliceV1Schema.safeParse(commercialInput);
  const collections = RecordedGrossCollectionSliceV1Schema.safeParse(collectionInput);
  const operational = operationalInput === undefined
    ? undefined
    : DashboardOperationalSnapshotV1Schema.safeParse(operationalInput);
  const accounting = accountingInput === undefined
    ? undefined
    : DashboardAccountingSliceV1Schema.safeParse(accountingInput);
  if (
    !commercial.success
    || !collections.success
    || (operational !== undefined && !operational.success)
    || (accounting !== undefined && !accounting.success)
  ) {
    return invalid("dashboard source slice is invalid", {
      commercial: commercial.success ? [] : commercial.error.issues.map((issue) => issue.path.join(".")),
      collections: collections.success ? [] : collections.error.issues.map((issue) => issue.path.join(".")),
      operational: operational === undefined || operational.success
        ? []
        : operational.error.issues.map((issue) => issue.path.join(".")),
      accounting: accounting === undefined || accounting.success
        ? []
        : accounting.error.issues.map((issue) => issue.path.join(".")),
    });
  }
  const commercialByCurrency = new Map(
    commercial.data.currencies.map((currency) => [currency.currencyCode, currency]),
  );
  const collectionByCurrency = new Map(
    collections.data.currencies.map((currency) => [currency.currencyCode, currency]),
  );
  const flowByCurrency = new Map(
    paymentFlows.map((currency) => [currency.currencyCode, currency]),
  );
  const accountingByCurrency = new Map(
    accounting?.success
      ? accounting.data.currencies.map((currency) => [currency.currencyCode, currency])
      : [],
  );
  const dailyActiveOrderCountSeries = commercial.data.dailyActiveOrderCountSeries;
  const dailyLabels = dailyActiveOrderCountSeries ? labelsOf(dailyActiveOrderCountSeries) : null;
  assertDashboardSourceAlignment(commercial.data, collections.data, paymentFlows, accounting?.success ? accounting.data : undefined);
  const currencyCodes = [...new Set([
    ...commercialByCurrency.keys(),
    ...collectionByCurrency.keys(),
    ...flowByCurrency.keys(),
    ...accountingByCurrency.keys(),
  ])].sort();

  const currencies = currencyCodes.map((currencyCode) => {
    const commercialCurrency = commercialByCurrency.get(currencyCode);
    const collectionCurrency = collectionByCurrency.get(currencyCode);
    const flowCurrency = flowByCurrency.get(currencyCode);
    const accountingCurrency = accountingByCurrency.get(currencyCode);
    if (
      commercialCurrency
      && collectionCurrency
      && commercialCurrency.minorUnitExponent !== collectionCurrency.minorUnitExponent
    ) {
      return invalid("dashboard currency exponent drift", { currencyCode });
    }
    const minorUnitExponent = commercialCurrency?.minorUnitExponent
      ?? collectionCurrency?.minorUnitExponent
      ?? flowCurrency?.minorUnitExponent
      ?? 0;
    if (flowCurrency && flowCurrency.minorUnitExponent !== minorUnitExponent) {
      return invalid("dashboard payment flow exponent drift", { currencyCode });
    }
    if (
      accountingCurrency
      && accountingCurrency.minorUnitExponent !== minorUnitExponent
    ) {
      return invalid("dashboard accounting exponent drift", { currencyCode });
    }
    const current = currentOrder(commercialCurrency);
    const recorded = recordedCollection(collectionCurrency);
    const delta = recorded.recordedGrossCollectionsMinor
      - current.currentOrderGrossValueMinor;
    if (!Number.isSafeInteger(delta)) {
      return invalid("dashboard comparison exceeds safe integer", { currencyCode });
    }
    const flow = flowCurrency || {
      postedRefundEventCount: 0,
      postedReversalEventCount: 0,
      postedChargebackEventCount: 0,
      refundsMinor: 0,
      reversalsMinor: 0,
      chargebacksMinor: 0,
      negativeCollectionsMinor: 0,
      customerRefundPayableAsOfMinor: 0,
      methods: [],
    };
    const netCollectionsMinor = recorded.recordedGrossCollectionsMinor
      - flow.negativeCollectionsMinor;
    if (!Number.isSafeInteger(netCollectionsMinor)) {
      return invalid("dashboard net collection exceeds safe integer", { currencyCode });
    }
    const dailyCurrentOrderGrossValueSeries = dailyLabels
      ? commercialCurrency?.dailyCurrentOrderGrossValueSeries
        ? structuredClone(commercialCurrency.dailyCurrentOrderGrossValueSeries)
        : dailyLabels.map((localDate) => ({
            localDate,
            currentOrderGrossValueMinor: 0,
          }))
      : undefined;
    const dailyRecordedGrossCollectionsSeries = dailyLabels
      ? collectionCurrency?.dailyRecordedGrossCollectionsSeries
        ? structuredClone(collectionCurrency.dailyRecordedGrossCollectionsSeries)
        : dailyLabels.map((localDate) => ({
            localDate,
            recordedGrossCollectionsMinor: 0,
          }))
      : undefined;
    const accountingAvailable = accountingCurrency?.status === "available";
    return {
      currencyCode,
      minorUnitExponent,
      ...(dailyCurrentOrderGrossValueSeries && dailyRecordedGrossCollectionsSeries
        ? {
            dailyCurrentOrderGrossValueSeries,
            dailyRecordedGrossCollectionsSeries,
          }
        : {}),
      currentOrder: current,
      recordedCollection: recorded,
      paymentFlow: {
        postedRefundEventCount: flow.postedRefundEventCount,
        postedReversalEventCount: flow.postedReversalEventCount,
        postedChargebackEventCount: flow.postedChargebackEventCount,
        refundsMinor: flow.refundsMinor,
        reversalsMinor: flow.reversalsMinor,
        chargebacksMinor: flow.chargebacksMinor,
        negativeCollectionsMinor: flow.negativeCollectionsMinor,
        netCollectionsMinor,
        customerRefundPayableAsOfMinor: flow.customerRefundPayableAsOfMinor,
        methods: structuredClone(flow.methods),
      },
      ...(accountingCurrency
        ? { accounting: structuredClone(accountingCurrency),
            ...(accounting?.success && accounting.data.profitCoverage
              ? { accountingProfitCoverage: structuredClone(accounting.data.profitCoverage.find(entry => entry.currencyCode === currencyCode)!.coverage) }
              : {}),
          }
        : {}),
      recordedCollectionMinusCurrentOrderValueMinor: delta,
      unavailableMetrics: COMPLETE_FINANCIAL_UNAVAILABLE_METRICS_V1.filter(
        (metric) => (
          !accountingAvailable
          || !["revenueExcludingVatMinor", "cogsRecognizedMinor"].includes(metric)
        ),
      ),
    } satisfies DashboardPartialFinancialCurrencyV1;
  });

  const data = DashboardPartialFinancialModelV1Schema.safeParse({
    schemaVersion: 1,
    completeness: "complete_payment_payable_v1",
    aggregateReadSource: "app.payment_events",
    ...(dailyActiveOrderCountSeries
      ? { dailyActiveOrderCountSeries: structuredClone(dailyActiveOrderCountSeries) }
      : {}),
    currencies,
    ...(operational?.success
      ? { operationalSnapshot: structuredClone(operational.data) }
      : {}),
  });
  if (!data.success) {
    return invalid("partial financial output is invalid", {
      issues: data.error.issues.map((issue) => issue.path.join(".")),
    });
  }
  return {
    enabled: true,
    data: data.data,
  };
}

export async function readDashboardPartialFinancialSnapshotV1(
  client: PoolClient,
  request: DashboardSnapshotRequest,
  config: { enabled: boolean } = DASHBOARD_PARTIAL_FINANCIAL_DEFAULT_CONFIG_V1,
): Promise<DashboardPartialFinancialSnapshotResultV1> {
  if (config.enabled !== true) return { enabled: false, status: "disabled" };
  const snapshot = await withDashboardReadSnapshot(client, request, async (
    snapshotClient,
    context,
  ) => {
    const commercial = await readDashboardCommercialSliceV1(snapshotClient, context);
    const collections = await readDashboardRecordedCollectionSliceV1(
      snapshotClient,
      context,
      { enabled: true },
    );
    const paymentFlows = await readDashboardPaymentFlowSliceV1(snapshotClient, context);
    const operational = await readDashboardOperationalSnapshotV1(
      snapshotClient,
      context,
    );
    const accounting = await readDashboardAccountingSliceV1(
      snapshotClient,
      context,
    );
    if (!collections.enabled) return invalid("recorded collection reader disabled");
    const composed = composeDashboardPartialFinancialModelV1(
      commercial,
      collections.data,
      { enabled: true },
      paymentFlows,
      operational,
      accounting,
    );
    if (!composed.enabled) return invalid("partial financial composer disabled");
    return composed.data;
  });
  return { enabled: true, snapshot };
}
