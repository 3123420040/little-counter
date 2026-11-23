import {
  CreatorSelectionV1Schema,
  OrderCursorFiltersV1Schema,
  OrderListQueryV2Schema,
  ReportScopeSchema,
  permissions,
  type CreatorSelectionV1,
  type EffectiveOrderPageV4,
  type EffectiveOrderPageV5,
  type OrderCursorFiltersV1,
  type ReportScope,
} from "@medusa-snus/contracts";
import { PlatformError } from "../errors/platform-error";
import {
  readEffectiveOrderPageV4,
  readEffectiveOrderPageV5,
  type EffectiveOrderPageSnapshotRepositoryV2,
  type EffectiveOrderPageSnapshotRepositoryV5,
} from "./effective-order-page-service";
import {
  OrderCursorError,
  validateOrderCursorKeyringV1,
  type OrderCursorKeyringV1,
} from "./order-cursor-service";

export interface EffectiveOrderPageHttpHandlerDependenciesV4 {
  repository: EffectiveOrderPageSnapshotRepositoryV2;
  keyring: OrderCursorKeyringV1;
  config?: { enabled: boolean };
}

export interface EffectiveOrderPageHttpRequestV4 {
  authorization: {
    permission: typeof permissions.ordersRead;
    scope: ReportScope;
  };
  filters: OrderCursorFiltersV1;
  creatorSelection: CreatorSelectionV1;
  limit?: number;
  cursor?: string | null;
  nowEpochSeconds: number;
}

export interface EffectiveOrderPageHttpResponseV4 {
  statusCode: 200;
  headers: Record<string, string>;
  body: EffectiveOrderPageV4;
}
export interface EffectiveOrderPageHttpHandlerDependenciesV5 extends Omit<EffectiveOrderPageHttpHandlerDependenciesV4, "repository"> {
  repository: EffectiveOrderPageSnapshotRepositoryV5;
}
export interface EffectiveOrderPageHttpResponseV5 extends Omit<EffectiveOrderPageHttpResponseV4, "body"> {
  body: EffectiveOrderPageV5;
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

export async function handleEffectiveOrderPageHttpV4(
  dependencies: EffectiveOrderPageHttpHandlerDependenciesV4,
  request: EffectiveOrderPageHttpRequestV4,
): Promise<EffectiveOrderPageHttpResponseV4> {
  return handlePage({ version: 4, dependencies }, request);
}
export function handleEffectiveOrderPageHttpV5(dependencies: EffectiveOrderPageHttpHandlerDependenciesV5,
  request: EffectiveOrderPageHttpRequestV4): Promise<EffectiveOrderPageHttpResponseV5> {
  return handlePage({ version: 5, dependencies }, request);
}
type PageHttpCommand = { version: 4; dependencies: EffectiveOrderPageHttpHandlerDependenciesV4 }
  | { version: 5; dependencies: EffectiveOrderPageHttpHandlerDependenciesV5 };
function handlePage(command: Extract<PageHttpCommand, { version: 4 }>, request: EffectiveOrderPageHttpRequestV4): Promise<EffectiveOrderPageHttpResponseV4>;
function handlePage(command: Extract<PageHttpCommand, { version: 5 }>, request: EffectiveOrderPageHttpRequestV4): Promise<EffectiveOrderPageHttpResponseV5>;
async function handlePage(command: PageHttpCommand, request: EffectiveOrderPageHttpRequestV4): Promise<Omit<EffectiveOrderPageHttpResponseV4, "body"> & { body: EffectiveOrderPageV4 | EffectiveOrderPageV5 }> {
  const dependencies = command.dependencies;
  if (request.authorization?.permission !== permissions.ordersRead) {
    throw new PlatformError("forbidden", "The orders:read permission is required", 403);
  }
  if (dependencies.config?.enabled !== true) {
    throw new PlatformError("feature_disabled", `Effective-order list v${command.version} is disabled`, 403);
  }
  const scope = authorizedScope(request.authorization.scope);
  const filters = OrderCursorFiltersV1Schema.safeParse(request.filters);
  const creatorSelection = CreatorSelectionV1Schema.safeParse(request.creatorSelection);
  if (!filters.success || !creatorSelection.success || filters.data.searchMode !== "order_or_customer_identity") {
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
  if (
    filters.data.creatorSelection
    && JSON.stringify(filters.data.creatorSelection) !== JSON.stringify(creatorSelection.data)
  ) {
    throw new PlatformError("validation_error", "Effective-order creator selection is inconsistent", 400);
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

  let body: EffectiveOrderPageV4 | EffectiveOrderPageV5;
  try {
    const input = {
      scope,
      filters: { ...filters.data, creatorSelection: creatorSelection.data },
      limit: query.data.limit,
      ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
      nowEpochSeconds: request.nowEpochSeconds,
    };
    body = command.version === 5
      ? await readEffectiveOrderPageV5(command.dependencies.repository, input, dependencies.keyring)
      : await readEffectiveOrderPageV4(command.dependencies.repository, input, dependencies.keyring);
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
      "X-Order-List-Contract": `orders.effective-page.v${command.version}`,
      "X-Order-List-As-Of": body.pagination.asOf,
      "X-Order-List-Total-Count": String(body.pagination.totalCount),
      "X-Order-List-Row-Count": String(body.data.length),
      "X-Order-List-Has-More": String(body.pagination.hasMore),
    },
    body,
  };
}
