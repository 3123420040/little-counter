import {
  OrderCursorFiltersV1Schema,
  OrderListQueryV2Schema,
  ReportScopeSchema,
  permissions,
  type EffectiveOrderPageV3,
  type OrderCursorFiltersV1,
  type ReportScope,
} from "@medusa-snus/contracts";
import { PlatformError } from "../errors/platform-error";
import {
  readEffectiveOrderPageV3,
  type EffectiveOrderPageSnapshotRepositoryV2,
} from "./effective-order-page-service";
import {
  OrderCursorError,
  validateOrderCursorKeyringV1,
  type OrderCursorKeyringV1,
} from "./order-cursor-service";

export interface EffectiveOrderPageHttpHandlerDependenciesV3 {
  repository: EffectiveOrderPageSnapshotRepositoryV2;
  keyring: OrderCursorKeyringV1;
  config?: { enabled: boolean };
}

export interface EffectiveOrderPageHttpRequestV3 {
  authorization: {
    permission: typeof permissions.ordersRead;
    scope: ReportScope;
  };
  filters: OrderCursorFiltersV1;
  limit?: number;
  cursor?: string | null;
  nowEpochSeconds: number;
}

export interface EffectiveOrderPageHttpResponseV3 {
  statusCode: 200;
  headers: Record<string, string>;
  body: EffectiveOrderPageV3;
}

function authorizedScope(input: unknown): { merchantId: string; storeIds: string[] } {
  const parsed = ReportScopeSchema.safeParse(input);
  if (!parsed.success || new Set(parsed.data.storeIds).size !== parsed.data.storeIds.length) {
    throw new PlatformError(
      "scope_required",
      "Effective-order list requires one merchant and a unique authorized store set",
      409,
    );
  }
  return { merchantId: parsed.data.merchantId, storeIds: [...parsed.data.storeIds].sort() };
}

function cursorError(error: OrderCursorError): PlatformError {
  const statusCode = error.code === "invalid_cursor" ? 400 : error.code === "expired_cursor" ? 410 : 409;
  return new PlatformError(
    error.code,
    "Order list cursor cannot be continued; refresh from the first page",
    statusCode,
    { ...error.publicPayload },
  );
}

export async function handleEffectiveOrderPageHttpV3(
  dependencies: EffectiveOrderPageHttpHandlerDependenciesV3,
  request: EffectiveOrderPageHttpRequestV3,
): Promise<EffectiveOrderPageHttpResponseV3> {
  if (request.authorization?.permission !== permissions.ordersRead) {
    throw new PlatformError("forbidden", "The orders:read permission is required", 403);
  }
  if (dependencies.config?.enabled !== true) {
    throw new PlatformError("feature_disabled", "Effective-order list v3 is disabled", 403);
  }
  const scope = authorizedScope(request.authorization.scope);
  const filters = OrderCursorFiltersV1Schema.safeParse(request.filters);
  if (!filters.success || filters.data.searchMode !== "order_or_customer_identity") {
    throw new PlatformError("validation_error", "Effective-order list filters are invalid", 400);
  }
  const filterStoreIds = filters.data.storeWindows.map((window) => window.storeId);
  if (
    filterStoreIds.length !== scope.storeIds.length
    || scope.storeIds.some((storeId, index) => storeId !== filterStoreIds[index])
  ) {
    throw new PlatformError(
      "validation_error",
      "Effective-order list filter windows must exactly match authorized stores",
      400,
    );
  }
  const query = OrderListQueryV2Schema.safeParse({
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.cursor ? { cursor: request.cursor } : {}),
  });
  if (!query.success || !Number.isSafeInteger(request.nowEpochSeconds) || request.nowEpochSeconds < 0) {
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

  let body: EffectiveOrderPageV3;
  try {
    body = await readEffectiveOrderPageV3(dependencies.repository, {
      scope,
      filters: filters.data,
      limit: query.data.limit,
      ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
      nowEpochSeconds: request.nowEpochSeconds,
    }, dependencies.keyring);
  } catch (error) {
    if (error instanceof OrderCursorError) throw cursorError(error);
    throw error;
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Order-List-Contract": "orders.effective-page.v3",
      "X-Order-List-As-Of": body.pagination.asOf,
      "X-Order-List-Total-Count": String(body.pagination.totalCount),
      "X-Order-List-Row-Count": String(body.data.length),
      "X-Order-List-Has-More": String(body.pagination.hasMore),
    },
    body,
  };
}
