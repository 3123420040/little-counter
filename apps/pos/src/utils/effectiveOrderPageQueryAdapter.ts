import {
  EffectiveOrderPageV3Schema,
  OrderCursorFiltersV1Schema,
  OrderListQueryV2Schema,
  ReportScopeSchema,
  type EffectiveOrderPageV3,
  type OrderCursorFiltersV1,
  type ReportScope,
} from "@medusa-snus/contracts";
import type { EffectiveOrderPageStateEventV2 } from "./effectiveOrderPageState";

export const EFFECTIVE_ORDER_PAGE_QUERY_DEFAULT_CONFIG_V2 = Object.freeze({
  enabled: false,
});

export interface EffectiveOrderPageQueryTransportRequestV2 {
  scope: ReportScope;
  filters: OrderCursorFiltersV1;
  limit: number;
  cursor?: string;
  nowEpochSeconds: number;
}

export interface EffectiveOrderPageQueryAdapterDependenciesV2 {
  transport: (request: EffectiveOrderPageQueryTransportRequestV2) => Promise<unknown>;
  config?: {
    enabled: boolean;
  };
}

export interface EffectiveOrderPageQueryInputV2 {
  requestId: string;
  mode: "first" | "next";
  scope: ReportScope;
  filters: {
    search?: string;
    statusMode: OrderCursorFiltersV1["statusMode"];
    storeWindows: OrderCursorFiltersV1["storeWindows"];
  };
  limit?: number;
  cursor?: string;
  nowEpochSeconds: number;
}

type StartedEvent = Extract<
  EffectiveOrderPageStateEventV2,
  { type: "request_started" }
>;
type SettledEvent = Exclude<
  EffectiveOrderPageStateEventV2,
  { type: "request_started" | "capability_disabled" }
>;

export type EffectiveOrderPageQueryTaskV2 =
  | {
      enabled: false;
      initialEvent: Extract<
        EffectiveOrderPageStateEventV2,
        { type: "capability_disabled" }
      >;
    }
  | {
      enabled: true;
      queryKey: string;
      initialEvent: StartedEvent;
      request: EffectiveOrderPageQueryTransportRequestV2;
      execute: () => Promise<SettledEvent>;
    };

export class EffectiveOrderPageQueryAdapterErrorV2 extends Error {
  readonly code = "effective_order_page_query_invalid";

  constructor(message: string) {
    super(message);
    this.name = "EffectiveOrderPageQueryAdapterErrorV2";
  }
}

function requiredToken(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new EffectiveOrderPageQueryAdapterErrorV2(`${field} is invalid`);
  }
  return value;
}

function normalizeScope(input: unknown): ReportScope {
  const parsed = ReportScopeSchema.safeParse(input);
  if (!parsed.success || new Set(parsed.data.storeIds).size !== parsed.data.storeIds.length) {
    throw new EffectiveOrderPageQueryAdapterErrorV2("report scope is invalid");
  }
  return {
    ...parsed.data,
    storeIds: [...parsed.data.storeIds].sort(),
  };
}

function normalizeSearch(search: unknown): string | undefined {
  if (search === undefined) return undefined;
  if (typeof search !== "string") {
    throw new EffectiveOrderPageQueryAdapterErrorV2("order search is invalid");
  }
  const normalized = search.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized || undefined;
}

function normalizeFilters(
  input: EffectiveOrderPageQueryInputV2["filters"],
  scope: ReportScope,
): OrderCursorFiltersV1 {
  const storeWindows = Array.isArray(input?.storeWindows)
    ? [...input.storeWindows].sort((left, right) => left.storeId.localeCompare(right.storeId))
    : input?.storeWindows;
  const search = normalizeSearch(input?.search);
  const parsed = OrderCursorFiltersV1Schema.safeParse({
    searchMode: "order_or_customer_identity",
    ...(search ? { search } : {}),
    statusMode: input?.statusMode,
    storeWindows,
  });
  if (!parsed.success) {
    throw new EffectiveOrderPageQueryAdapterErrorV2("order filters are invalid");
  }
  const filterStores = parsed.data.storeWindows.map((window) => window.storeId);
  if (
    filterStores.length !== scope.storeIds.length
    || scope.storeIds.some((storeId, index) => storeId !== filterStores[index])
  ) {
    throw new EffectiveOrderPageQueryAdapterErrorV2("filter scope does not match report scope");
  }
  return parsed.data;
}

export function normalizeEffectiveOrderSelectionV2(
  scopeInput: unknown,
  filtersInput: EffectiveOrderPageQueryInputV2["filters"],
): { scope: ReportScope; filters: OrderCursorFiltersV1 } {
  const scope = normalizeScope(scopeInput);
  return {
    scope,
    filters: normalizeFilters(filtersInput, scope),
  };
}

function normalizeQuery(input: EffectiveOrderPageQueryInputV2): {
  limit: number;
  cursor?: string;
} {
  const parsed = OrderListQueryV2Schema.safeParse({
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  });
  if (!parsed.success) {
    throw new EffectiveOrderPageQueryAdapterErrorV2("page query is invalid");
  }
  if (input.mode === "first" && parsed.data.cursor) {
    throw new EffectiveOrderPageQueryAdapterErrorV2("first page cannot contain a cursor");
  }
  if (input.mode === "next" && !parsed.data.cursor) {
    throw new EffectiveOrderPageQueryAdapterErrorV2("next page requires a cursor");
  }
  return parsed.data;
}

function queryKey(
  scope: ReportScope,
  filters: OrderCursorFiltersV1,
  limit: number,
): string {
  return `orders.effective-page.v3:${JSON.stringify({
    merchantId: scope.merchantId,
    storeIds: scope.storeIds,
    filters,
    limit,
  })}`;
}

function normalizedIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function rowMatchesFilters(
  row: EffectiveOrderPageV3["data"][number],
  scope: ReportScope,
  filters: OrderCursorFiltersV1,
): boolean {
  if (
    row.sourceOrder.merchantId !== scope.merchantId
    || !scope.storeIds.includes(row.sourceOrder.storeId)
  ) return false;
  const window = filters.storeWindows.find((item) => item.storeId === row.sourceOrder.storeId);
  const createdAt = Date.parse(row.createdAt);
  if (
    !window
    || createdAt < Date.parse(window.startInclusive)
    || createdAt >= Date.parse(window.endExclusive)
  ) return false;
  if (
    (filters.statusMode === "completed" && row.sourceOrder.status !== "completed")
    || (filters.statusMode === "other" && row.sourceOrder.status === "completed")
  ) return false;
  if (filters.search) {
    const search = filters.search;
    if (
      !normalizedIdentity(row.sourceOrder.orderId).includes(search)
      && !normalizedIdentity(row.sourceOrder.orderNumber).includes(search)
      && ![
        row.customer?.id,
        row.customer?.phone,
        row.customer?.firstName,
        row.customer?.lastName,
        `${row.customer?.lastName || ""} ${row.customer?.firstName || ""}`,
        `${row.customer?.firstName || ""} ${row.customer?.lastName || ""}`,
      ].filter(Boolean).some((value) => normalizedIdentity(String(value)).includes(search))
    ) return false;
  }
  return true;
}

function validResponse(
  response: unknown,
  request: EffectiveOrderPageQueryTransportRequestV2,
): EffectiveOrderPageV3 | null {
  const parsed = EffectiveOrderPageV3Schema.safeParse(response);
  if (!parsed.success) return null;
  if (
    parsed.data.pagination.limit !== request.limit
    || Date.parse(parsed.data.pagination.asOf) > request.nowEpochSeconds * 1_000
    || parsed.data.data.some((row) => !rowMatchesFilters(row, request.scope, request.filters))
  ) return null;
  return parsed.data;
}

function refreshReason(error: unknown): "invalid_cursor" | "expired_cursor" | "stale_cursor" | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { status?: unknown; code?: unknown; details?: unknown };
  const refreshFromStart = candidate.details
    && typeof candidate.details === "object"
    && (candidate.details as { refreshFromStart?: unknown }).refreshFromStart === true;
  if (!refreshFromStart) return null;
  if (candidate.status === 400 && candidate.code === "invalid_cursor") return "invalid_cursor";
  if (candidate.status === 410 && candidate.code === "expired_cursor") return "expired_cursor";
  if (candidate.status === 409 && candidate.code === "stale_cursor") return "stale_cursor";
  return null;
}

export function createEffectiveOrderPageQueryTaskV2(
  dependencies: EffectiveOrderPageQueryAdapterDependenciesV2,
  input: EffectiveOrderPageQueryInputV2,
): EffectiveOrderPageQueryTaskV2 {
  if (dependencies.config?.enabled !== true) {
    return {
      enabled: false,
      initialEvent: { type: "capability_disabled" },
    };
  }
  if (typeof dependencies.transport !== "function") {
    throw new EffectiveOrderPageQueryAdapterErrorV2("query transport is unavailable");
  }
  const requestId = requiredToken(input.requestId, "requestId");
  if (input.mode !== "first" && input.mode !== "next") {
    throw new EffectiveOrderPageQueryAdapterErrorV2("query mode is invalid");
  }
  if (!Number.isSafeInteger(input.nowEpochSeconds) || input.nowEpochSeconds < 0) {
    throw new EffectiveOrderPageQueryAdapterErrorV2("query clock is invalid");
  }
  const { scope, filters } = normalizeEffectiveOrderSelectionV2(input.scope, input.filters);
  const query = normalizeQuery(input);
  const key = queryKey(scope, filters, query.limit);
  const request: EffectiveOrderPageQueryTransportRequestV2 = {
    scope,
    filters,
    limit: query.limit,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    nowEpochSeconds: input.nowEpochSeconds,
  };

  return {
    enabled: true,
    queryKey: key,
    initialEvent: {
      type: "request_started",
      requestId,
      queryKey: key,
      mode: input.mode,
    },
    request,
    execute: async () => {
      try {
        const response = await dependencies.transport(request);
        const valid = validResponse(response, request);
        return valid
          ? { type: "request_succeeded", requestId, page: valid }
          : { type: "request_failed", requestId, message: "Unable to load orders" };
      } catch (error) {
        const reason = refreshReason(error);
        return reason
          ? { type: "refresh_required", requestId, reason }
          : { type: "request_failed", requestId, message: "Unable to load orders" };
      }
    },
  };
}
