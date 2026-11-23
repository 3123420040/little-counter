import {
  EffectiveOrderPageV3Schema,
  type EffectiveOrderPageV3,
} from "@medusa-snus/contracts";

export const EFFECTIVE_ORDER_PAGE_POS_DEFAULT_CONFIG_V2 = Object.freeze({
  enabled: false,
});

export type EffectiveOrderPageRefreshReasonV2 =
  | "invalid_cursor"
  | "expired_cursor"
  | "stale_cursor"
  | "snapshot_drift";

export type EffectiveOrderPageStateStatusV2 =
  | "disabled"
  | "idle"
  | "loading"
  | "ready"
  | "empty"
  | "error"
  | "refresh_required";

export interface EffectiveOrderPageStateV2 {
  status: EffectiveOrderPageStateStatusV2;
  queryKey: string | null;
  rows: EffectiveOrderPageV3["data"];
  currencies: EffectiveOrderPageV3["currencies"];
  snapshotAsOf: string | null;
  totalCount: number;
  hasMore: boolean;
  nextCursor: string | null;
  activeRequest: {
    requestId: string;
    queryKey: string;
    mode: "first" | "next";
  } | null;
  refreshReason: EffectiveOrderPageRefreshReasonV2 | null;
  error: string | null;
}

export type EffectiveOrderPageStateEventV2 =
  | {
      type: "request_started";
      requestId: string;
      queryKey: string;
      mode: "first" | "next";
    }
  | {
      type: "request_succeeded";
      requestId: string;
      page: EffectiveOrderPageV3;
    }
  | {
      type: "request_failed";
      requestId: string;
      message: string;
    }
  | {
      type: "refresh_required";
      requestId: string;
      reason: Exclude<EffectiveOrderPageRefreshReasonV2, "snapshot_drift">;
    }
  | { type: "capability_disabled" };

function baseState(enabled: boolean): EffectiveOrderPageStateV2 {
  return {
    status: enabled ? "idle" : "disabled",
    queryKey: null,
    rows: [],
    currencies: [],
    snapshotAsOf: null,
    totalCount: 0,
    hasMore: false,
    nextCursor: null,
    activeRequest: null,
    refreshReason: null,
    error: null,
  };
}

export function createEffectiveOrderPageStateV2(
  config: { enabled?: boolean } = EFFECTIVE_ORDER_PAGE_POS_DEFAULT_CONFIG_V2,
): EffectiveOrderPageStateV2 {
  return baseState(config.enabled === true);
}

function requiredToken(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new Error(`effective order page ${field} is invalid`);
  }
  return value;
}

function refreshState(
  state: EffectiveOrderPageStateV2,
  reason: EffectiveOrderPageRefreshReasonV2,
): EffectiveOrderPageStateV2 {
  return {
    ...baseState(true),
    status: "refresh_required",
    queryKey: state.queryKey,
    refreshReason: reason,
  };
}

function currencySignature(currencies: EffectiveOrderPageV3["currencies"]): string {
  return JSON.stringify(
    [...currencies].sort((left, right) => left.currencyCode.localeCompare(right.currencyCode)),
  );
}

function pageHasDuplicateOrders(
  rows: EffectiveOrderPageV3["data"],
  priorRows: EffectiveOrderPageV3["data"] = [],
): boolean {
  const orderIds = new Set(priorRows.map((row) => row.sourceOrder.orderId));
  for (const row of rows) {
    if (orderIds.has(row.sourceOrder.orderId)) return true;
    orderIds.add(row.sourceOrder.orderId);
  }
  return false;
}

function firstPageState(
  state: EffectiveOrderPageStateV2,
  page: EffectiveOrderPageV3,
): EffectiveOrderPageStateV2 {
  const inconsistent = pageHasDuplicateOrders(page.data)
    || page.data.length > page.pagination.totalCount
    || (page.pagination.totalCount > 0 && page.data.length === 0)
    || (!page.pagination.hasMore && page.data.length !== page.pagination.totalCount);
  if (inconsistent) return refreshState(state, "snapshot_drift");
  return {
    status: page.pagination.totalCount === 0 ? "empty" : "ready",
    queryKey: state.activeRequest!.queryKey,
    rows: page.data,
    currencies: page.currencies,
    snapshotAsOf: page.pagination.asOf,
    totalCount: page.pagination.totalCount,
    hasMore: page.pagination.hasMore,
    nextCursor: page.pagination.nextCursor,
    activeRequest: null,
    refreshReason: null,
    error: null,
  };
}

function nextPageState(
  state: EffectiveOrderPageStateV2,
  page: EffectiveOrderPageV3,
): EffectiveOrderPageStateV2 {
  const rows = [...state.rows, ...page.data];
  const inconsistent = state.snapshotAsOf !== page.pagination.asOf
    || state.totalCount !== page.pagination.totalCount
    || currencySignature(state.currencies) !== currencySignature(page.currencies)
    || page.data.length === 0
    || pageHasDuplicateOrders(page.data, state.rows)
    || rows.length > state.totalCount
    || (!page.pagination.hasMore && rows.length !== state.totalCount);
  if (inconsistent) return refreshState(state, "snapshot_drift");
  return {
    ...state,
    status: "ready",
    rows,
    hasMore: page.pagination.hasMore,
    nextCursor: page.pagination.nextCursor,
    activeRequest: null,
    refreshReason: null,
    error: null,
  };
}

function startRequest(
  state: EffectiveOrderPageStateV2,
  event: Extract<EffectiveOrderPageStateEventV2, { type: "request_started" }>,
): EffectiveOrderPageStateV2 {
  const requestId = requiredToken(event.requestId, "requestId");
  const queryKey = requiredToken(event.queryKey, "queryKey");
  if (event.mode === "first") {
    return {
      ...baseState(true),
      status: "loading",
      queryKey,
      activeRequest: { requestId, queryKey, mode: "first" },
    };
  }
  if (
    state.queryKey !== queryKey
    || !state.hasMore
    || !state.nextCursor
    || state.rows.length === 0
  ) {
    return refreshState(state, "snapshot_drift");
  }
  return {
    ...state,
    status: "loading",
    activeRequest: { requestId, queryKey, mode: "next" },
    error: null,
  };
}

export function reduceEffectiveOrderPageStateV2(
  state: EffectiveOrderPageStateV2,
  event: EffectiveOrderPageStateEventV2,
): EffectiveOrderPageStateV2 {
  if (event.type === "capability_disabled") return baseState(false);
  if (state.status === "disabled") return state;
  if (event.type === "request_started") return startRequest(state, event);

  if (!state.activeRequest || state.activeRequest.requestId !== event.requestId) {
    return state;
  }
  if (event.type === "refresh_required") return refreshState(state, event.reason);
  if (event.type === "request_failed") {
    const message = typeof event.message === "string" && event.message.trim()
      ? event.message.trim().slice(0, 500)
      : "Unable to load orders";
    return {
      ...state,
      status: "error",
      activeRequest: null,
      error: message,
    };
  }

  const parsed = EffectiveOrderPageV3Schema.safeParse(event.page);
  if (!parsed.success) return refreshState(state, "snapshot_drift");
  return state.activeRequest.mode === "first"
    ? firstPageState(state, parsed.data)
    : nextPageState(state, parsed.data);
}
