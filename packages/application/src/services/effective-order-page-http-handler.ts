import {
  OrderCursorFiltersV1Schema,
  OrderListQueryV2Schema,
  ReportScopeSchema,
  permissions,
  type EffectiveOrderPageV2,
  type OrderCursorFiltersV1,
  type ReportScope,
} from "@medusa-snus/contracts";
import { PlatformError } from "../errors/platform-error";
import {
  readEffectiveOrderPageV2,
  type EffectiveOrderPageSnapshotRepositoryV2,
} from "./effective-order-page-service";
import {
  OrderCursorError,
  validateOrderCursorKeyringV1,
  type OrderCursorKeyringV1,
} from "./order-cursor-service";

export const EFFECTIVE_ORDER_PAGE_HTTP_DEFAULT_CONFIG_V2 = Object.freeze({
  enabled: false,
});

export interface EffectiveOrderPageHttpHandlerDependenciesV2 {
  repository: EffectiveOrderPageSnapshotRepositoryV2;
  keyring: OrderCursorKeyringV1;
  config?: {
    enabled: boolean;
  };
}

export interface EffectiveOrderPageHttpRequestV2 {
  authorization: {
    permission: typeof permissions.ordersRead;
    scope: ReportScope;
  };
  filters: OrderCursorFiltersV1;
  limit?: number;
  cursor?: string | null;
  nowEpochSeconds: number;
}

export interface EffectiveOrderPageHttpResponseV2 {
  statusCode: 200;
  headers: Record<string, string>;
  body: EffectiveOrderPageV2;
}

function normalizeAuthorizedScope(input: unknown): {
  merchantId: string;
  storeIds: string[];
} {
  const parsed = ReportScopeSchema.safeParse(input);
  if (!parsed.success || new Set(parsed.data.storeIds).size !== parsed.data.storeIds.length) {
    throw new PlatformError(
      "scope_required",
      "Effective-order list requires one merchant and a unique authorized store set",
      409,
    );
  }
  return {
    merchantId: parsed.data.merchantId,
    storeIds: [...parsed.data.storeIds].sort(),
  };
}

function normalizeFilters(input: unknown): OrderCursorFiltersV1 {
  const parsed = OrderCursorFiltersV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new PlatformError("validation_error", "Effective-order list filters are invalid", 400);
  }
  return parsed.data;
}

function assertFilterScope(
  storeIds: readonly string[],
  filters: OrderCursorFiltersV1,
): void {
  const filterStoreIds = filters.storeWindows.map((window) => window.storeId);
  if (
    filterStoreIds.length !== storeIds.length
    || storeIds.some((storeId, index) => storeId !== filterStoreIds[index])
  ) {
    throw new PlatformError(
      "validation_error",
      "Effective-order list filter windows must exactly match authorized stores",
      400,
    );
  }
}

function cursorPlatformError(error: OrderCursorError): PlatformError {
  const statusCode = error.code === "invalid_cursor"
    ? 400
    : error.code === "expired_cursor"
      ? 410
      : 409;
  return new PlatformError(
    error.code,
    "Order list cursor cannot be continued; refresh from the first page",
    statusCode,
    { ...error.publicPayload },
  );
}

export async function handleEffectiveOrderPageHttpV2(
  dependencies: EffectiveOrderPageHttpHandlerDependenciesV2,
  request: EffectiveOrderPageHttpRequestV2,
): Promise<EffectiveOrderPageHttpResponseV2> {
  if (request.authorization?.permission !== permissions.ordersRead) {
    throw new PlatformError("forbidden", "The orders:read permission is required", 403);
  }
  const scope = normalizeAuthorizedScope(request.authorization.scope);
  if (dependencies.config?.enabled !== true) {
    throw new PlatformError("feature_disabled", "Effective-order list v2 is disabled", 403);
  }
  const filters = normalizeFilters(request.filters);
  assertFilterScope(scope.storeIds, filters);
  const query = OrderListQueryV2Schema.safeParse({
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.cursor === undefined || request.cursor === null
      ? {}
      : { cursor: request.cursor }),
  });
  if (
    !query.success
    || !Number.isSafeInteger(request.nowEpochSeconds)
    || request.nowEpochSeconds < 0
  ) {
    throw new PlatformError("validation_error", "Effective-order list query is invalid", 400);
  }
  try {
    validateOrderCursorKeyringV1(dependencies.keyring);
  } catch {
    throw new PlatformError(
      "feature_unavailable",
      "Effective-order list cursor configuration is unavailable",
      503,
    );
  }

  let body: EffectiveOrderPageV2;
  try {
    body = await readEffectiveOrderPageV2(dependencies.repository, {
      scope,
      filters,
      limit: query.data.limit,
      ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
      nowEpochSeconds: request.nowEpochSeconds,
    }, dependencies.keyring);
  } catch (error) {
    if (error instanceof OrderCursorError) throw cursorPlatformError(error);
    throw error;
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Order-List-Contract": "orders.effective-page.v2",
      "X-Order-List-As-Of": body.pagination.asOf,
      "X-Order-List-Total-Count": String(body.pagination.totalCount),
      "X-Order-List-Row-Count": String(body.data.length),
      "X-Order-List-Has-More": String(body.pagination.hasMore),
    },
    body,
  };
}
