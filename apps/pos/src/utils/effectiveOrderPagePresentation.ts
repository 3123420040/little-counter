import {
  EffectiveOrderListRowV3Schema,
  EffectiveOrderPageCurrencyAggregateV2Schema,
} from "@medusa-snus/contracts";
import type { EffectiveOrderPageStateV2 } from "./effectiveOrderPageState";

type EffectiveOrderListRowV2 = EffectiveOrderPageStateV2["rows"][number];

export type EffectiveOrderPageCompletenessV2 =
  | "complete"
  | "partial"
  | "loading"
  | "unavailable";

export type EffectiveOrderPagePresentationIssueV2 =
  | "page_load_failed"
  | "invalid_cursor"
  | "expired_cursor"
  | "stale_cursor"
  | "snapshot_drift"
  | "state_invariant_violation";

export interface EffectiveOrderPageHeadlineV2 {
  currencyCode: string;
  minorUnitExponent: number;
  currentOrderValue: {
    label: "Current order value (includes VAT and charged components)";
    minor: number;
  };
  grossRecordedCollection: {
    label: "Gross recorded collection (includes VAT and charged components)";
    minor: number;
  };
  negativeCollection: {
    label: "Refunds, reversals and chargebacks";
    minor: number;
  };
  netRecordedCollection: {
    label: "Net recorded collection";
    minor: number;
  };
}

export interface EffectiveOrderPagePresentationV2 {
  status: EffectiveOrderPageStateV2["status"];
  completeness: EffectiveOrderPageCompletenessV2;
  loadedCount: number;
  totalCount: number;
  rows: EffectiveOrderListRowV2[];
  headlines: EffectiveOrderPageHeadlineV2[];
  issue: EffectiveOrderPagePresentationIssueV2 | null;
  actions: {
    canLoadNext: boolean;
    canRetryNext: boolean;
    mustRefreshFromStart: boolean;
  };
}

function unavailable(
  status: EffectiveOrderPageStateV2["status"],
  issue: EffectiveOrderPagePresentationIssueV2 | null,
  mustRefreshFromStart = false,
): EffectiveOrderPagePresentationV2 {
  return {
    status,
    completeness: "unavailable",
    loadedCount: 0,
    totalCount: 0,
    rows: [],
    headlines: [],
    issue,
    actions: {
      canLoadNext: false,
      canRetryNext: false,
      mustRefreshFromStart,
    },
  };
}

function stateIsValid(state: EffectiveOrderPageStateV2): boolean {
  if (
    !Number.isSafeInteger(state.totalCount)
    || state.totalCount < 0
    || state.rows.length > state.totalCount
    || state.hasMore !== (state.nextCursor !== null)
    || state.rows.some((row) => !EffectiveOrderListRowV3Schema.safeParse(row).success)
    || state.currencies.some(
      (currency) => !EffectiveOrderPageCurrencyAggregateV2Schema.safeParse(currency).success,
    )
  ) return false;

  const orderIds = state.rows.map((row) => row.sourceOrder.orderId);
  const currencyCodes = state.currencies.map((currency) => currency.currencyCode);
  if (
    new Set(orderIds).size !== orderIds.length
    || new Set(currencyCodes).size !== currencyCodes.length
  ) return false;
  const aggregateCount = state.currencies.reduce((sum, currency) => sum + currency.orderCount, 0);
  if (!Number.isSafeInteger(aggregateCount) || aggregateCount !== state.totalCount) return false;
  if (state.rows.some((row) => !state.currencies.some(
    (currency) => currency.currencyCode === row.order.currencyCode
      && currency.minorUnitExponent === row.order.minorUnitExponent,
  ))) return false;

  if (state.status === "disabled" || state.status === "idle") {
    return state.queryKey === null
      && state.rows.length === 0
      && state.currencies.length === 0
      && state.totalCount === 0
      && !state.hasMore
      && state.activeRequest === null
      && state.refreshReason === null
      && state.error === null;
  }
  if (state.status === "empty") {
    return state.queryKey !== null
      && state.snapshotAsOf !== null
      && state.rows.length === 0
      && state.currencies.length === 0
      && state.totalCount === 0
      && !state.hasMore
      && state.activeRequest === null
      && state.refreshReason === null
      && state.error === null;
  }
  if (state.status === "ready") {
    return state.queryKey !== null
      && state.rows.length > 0
      && state.snapshotAsOf !== null
      && state.activeRequest === null
      && state.refreshReason === null
      && state.error === null
      && (state.hasMore || state.rows.length === state.totalCount);
  }
  if (state.status === "loading") {
    if (!state.activeRequest || state.activeRequest.queryKey !== state.queryKey) return false;
    return state.activeRequest.mode === "first"
      ? state.rows.length === 0 && state.totalCount === 0 && !state.hasMore
      : state.rows.length > 0 && state.hasMore && state.snapshotAsOf !== null;
  }
  if (state.status === "error") {
    return state.activeRequest === null
      && Boolean(state.error)
      && state.refreshReason === null
      && (state.rows.length === 0 || (state.hasMore && state.snapshotAsOf !== null));
  }
  return state.status === "refresh_required"
    && state.rows.length === 0
    && state.currencies.length === 0
    && state.totalCount === 0
    && !state.hasMore
    && state.activeRequest === null
    && state.refreshReason !== null
    && state.error === null;
}

function headlines(state: EffectiveOrderPageStateV2): EffectiveOrderPageHeadlineV2[] {
  return state.currencies.map((currency) => ({
    currencyCode: currency.currencyCode,
    minorUnitExponent: currency.minorUnitExponent,
    currentOrderValue: {
      label: "Current order value (includes VAT and charged components)",
      minor: currency.currentOrderGrossValueMinor,
    },
    grossRecordedCollection: {
      label: "Gross recorded collection (includes VAT and charged components)",
      minor: currency.recordedGrossCollectionsMinor,
    },
    negativeCollection: {
      label: "Refunds, reversals and chargebacks",
      minor: currency.negativeCollectionsMinor,
    },
    netRecordedCollection: {
      label: "Net recorded collection",
      minor: currency.netCollectionsMinor,
    },
  }));
}

export function presentEffectiveOrderPageV2(
  state: EffectiveOrderPageStateV2,
): EffectiveOrderPagePresentationV2 {
  if (!stateIsValid(state)) return unavailable(state.status, "state_invariant_violation");
  if (state.status === "disabled" || state.status === "idle") {
    return unavailable(state.status, null);
  }
  if (state.status === "refresh_required") {
    return unavailable(state.status, state.refreshReason, true);
  }

  const loadedCount = state.rows.length;
  const isPartial = loadedCount > 0 && (
    state.hasMore
    || state.status === "loading"
    || state.status === "error"
  );
  const completeness: EffectiveOrderPageCompletenessV2 = state.status === "empty"
    ? "complete"
    : isPartial
      ? "partial"
      : state.status === "loading"
        ? "loading"
        : state.status === "ready"
          ? "complete"
          : "unavailable";

  return {
    status: state.status,
    completeness,
    loadedCount,
    totalCount: state.totalCount,
    rows: structuredClone(state.rows),
    headlines: headlines(state),
    issue: state.status === "error" ? "page_load_failed" : null,
    actions: {
      canLoadNext: state.status === "ready" && state.hasMore,
      canRetryNext: state.status === "error" && loadedCount > 0 && state.hasMore,
      mustRefreshFromStart: false,
    },
  };
}
