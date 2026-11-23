import {
  ORDER_CURSOR_POLICY_V1,
  OrderCollectionRevisionVectorV1Schema,
  OrderCursorFiltersV1Schema,
  OrderCursorScopeV1Schema,
  OrderListQueryV2Schema,
  type OrderCollectionRevisionVectorV1,
  type EffectiveOrderCustomerSummaryV1,
  type OrderCustomerAttributionV1,
  type OrderCursorFiltersV1,
  type OrderCursorScopeV1,
  type OrderCursorTupleV1,
} from "@medusa-snus/contracts";
import {
  advanceOrderCursorV1,
  createOrderCursorV1,
  hashStoreRevisionVectorV1,
  verifyOrderCursorV1,
  type OrderCursorKeyringV1,
} from "./order-cursor-service";

export interface OrderPageIdentityRowV1 {
  merchantId: string;
  storeId: string;
  orderId: string;
  orderNumber: string;
  status: string;
  currencyCode: string;
  createdAt: string;
  customer?: EffectiveOrderCustomerSummaryV1 | null;
  customerAttribution?: OrderCustomerAttributionV1;
}

export interface OrderPageRowsRequestV1 {
  scope: OrderCursorScopeV1;
  filters: OrderCursorFiltersV1;
  highWatermark?: OrderCursorTupleV1;
  after?: OrderCursorTupleV1;
  limit: number;
}

export interface OrderPageCountRequestV1 {
  scope: OrderCursorScopeV1;
  filters: OrderCursorFiltersV1;
}

export interface OrderPageSnapshotTransactionV1 {
  readAsOf(): Promise<string>;
  readStoreRevisionVector(
    scope: OrderCursorScopeV1,
  ): Promise<OrderCollectionRevisionVectorV1>;
  readRows(input: OrderPageRowsRequestV1): Promise<OrderPageIdentityRowV1[]>;
  countRows(input: OrderPageCountRequestV1): Promise<number>;
}

export interface OrderPageSnapshotRepositoryV1 {
  withRepeatableReadSnapshot<T>(
    read: (snapshot: OrderPageSnapshotTransactionV1) => Promise<T>,
  ): Promise<T>;
}

export interface ReadOrderPageSnapshotRequestV1 {
  scope: OrderCursorScopeV1;
  filters: OrderCursorFiltersV1;
  limit?: number;
  cursor?: string;
  nowEpochSeconds: number;
}

export interface OrderPageSnapshotResultV1 {
  rows: OrderPageIdentityRowV1[];
  totalCount: number;
  pagination: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
    asOf: string;
  };
  snapshot: {
    highWatermark: OrderCursorTupleV1 | null;
    storeRevisionVector: OrderCollectionRevisionVectorV1;
  };
}

export function orderPageIdentityTupleV1(
  row: OrderPageIdentityRowV1,
): OrderCursorTupleV1 {
  return { createdAt: row.createdAt, id: row.orderId };
}

function tupleCompareDesc(
  left: OrderCursorTupleV1,
  right: OrderCursorTupleV1,
): number {
  const timeDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (timeDifference !== 0) return timeDifference;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

function tupleAtOrBelow(
  candidate: OrderCursorTupleV1,
  bound: OrderCursorTupleV1,
): boolean {
  return tupleCompareDesc(candidate, bound) >= 0;
}

function tupleStrictlyBelow(
  candidate: OrderCursorTupleV1,
  bound: OrderCursorTupleV1,
): boolean {
  return tupleCompareDesc(candidate, bound) > 0;
}

function requiredIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new Error(`invalid order page ${field}`);
  }
  return value;
}

function normalizedInstant(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`invalid order page ${field}`);
  }
  return new Date(value).toISOString();
}

function normalizedCustomer(
  value: EffectiveOrderCustomerSummaryV1 | null | undefined,
): EffectiveOrderCustomerSummaryV1 | null {
  if (value === null || value === undefined) return null;
  const required = requiredIdentity(value.id, "customer.id");
  const nullable = (field: "firstName" | "lastName" | "phone") => {
    const candidate = value[field];
    if (candidate === null) return null;
    if (typeof candidate !== "string") throw new Error(`invalid order page customer.${field}`);
    return candidate;
  };
  return {
    id: required,
    firstName: nullable("firstName"),
    lastName: nullable("lastName"),
    phone: nullable("phone"),
  };
}

function normalizedCustomerAttribution(
  value: unknown,
  customer: EffectiveOrderCustomerSummaryV1 | null,
): OrderCustomerAttributionV1 | undefined {
  if (value === undefined) return undefined;
  if (value !== "linked" && value !== "walk_in" && value !== "unknown") {
    throw new Error("invalid order page customerAttribution");
  }
  if ((value === "linked") !== Boolean(customer)) {
    throw new Error("order page customer attribution drift");
  }
  return value;
}

function assertExactStoreCoverage(
  scope: OrderCursorScopeV1,
  filters: OrderCursorFiltersV1,
  revisions: OrderCollectionRevisionVectorV1,
): void {
  const filterStoreIds = filters.storeWindows.map((window) => window.storeId);
  const revisionStoreIds = revisions.map((revision) => revision.storeId);
  if (
    filterStoreIds.length !== scope.storeIds.length
    || revisionStoreIds.length !== scope.storeIds.length
    || scope.storeIds.some((storeId, index) =>
      filterStoreIds[index] !== storeId || revisionStoreIds[index] !== storeId)
  ) {
    throw new Error("order page filters/revisions must cover the exact scope");
  }
}

export function validateOrderPageIdentityRowsV1(
  rowsInput: readonly OrderPageIdentityRowV1[],
  request: OrderPageRowsRequestV1,
): OrderPageIdentityRowV1[] {
  if (rowsInput.length > request.limit) {
    throw new Error("order page repository exceeded its requested limit");
  }
  const windows = new Map(request.filters.storeWindows.map((window) => [window.storeId, window]));
  const orderIds = new Set<string>();
  const rows = rowsInput.map((input) => {
    const customer = normalizedCustomer(input.customer);
    const customerAttribution = normalizedCustomerAttribution(input.customerAttribution, customer);
    const row: OrderPageIdentityRowV1 = {
      merchantId: requiredIdentity(input.merchantId, "merchantId"),
      storeId: requiredIdentity(input.storeId, "storeId"),
      orderId: requiredIdentity(input.orderId, "orderId"),
      orderNumber: requiredIdentity(input.orderNumber, "orderNumber"),
      status: requiredIdentity(input.status, "status").toLowerCase(),
      currencyCode: requiredIdentity(input.currencyCode, "currencyCode"),
      createdAt: normalizedInstant(input.createdAt, "createdAt"),
      customer,
      ...(customerAttribution === undefined ? {} : { customerAttribution }),
    };
    if (!/^[A-Z]{3}$/.test(row.currencyCode)) {
      throw new Error("invalid order page currencyCode");
    }
    if (
      row.merchantId !== request.scope.merchantId
      || !request.scope.storeIds.includes(row.storeId)
      || orderIds.has(row.orderId)
    ) {
      throw new Error("order page repository returned scope/duplicate drift");
    }
    orderIds.add(row.orderId);
    const window = windows.get(row.storeId);
    const createdAt = Date.parse(row.createdAt);
    if (
      !window
      || createdAt < Date.parse(window.startInclusive)
      || createdAt >= Date.parse(window.endExclusive)
    ) {
      throw new Error("order page repository returned date-filter drift");
    }
    if (
      (request.filters.statusMode === "completed" && row.status !== "completed")
      || (request.filters.statusMode === "other" && row.status === "completed")
    ) {
      throw new Error("order page repository returned status-filter drift");
    }
    if (request.filters.search) {
      const search = request.filters.search;
      const customerIdentity = [
        row.customer?.id,
        row.customer?.firstName,
        row.customer?.lastName,
        row.customer?.phone,
        `${row.customer?.lastName || ""} ${row.customer?.firstName || ""}`,
        `${row.customer?.firstName || ""} ${row.customer?.lastName || ""}`,
      ].filter(Boolean).map((value) => String(value).toLowerCase());
      if (
        !row.orderId.toLowerCase().includes(search)
        && !row.orderNumber.toLowerCase().includes(search)
        && (
          request.filters.searchMode !== "order_or_customer_identity"
          || !customerIdentity.some((value) => value.includes(search))
        )
      ) {
        throw new Error("order page repository returned search-filter drift");
      }
    }
    const rowTuple = orderPageIdentityTupleV1(row);
    if (request.highWatermark && !tupleAtOrBelow(rowTuple, request.highWatermark)) {
      throw new Error("order page repository exceeded the high-water tuple");
    }
    if (request.after && !tupleStrictlyBelow(rowTuple, request.after)) {
      throw new Error("order page repository repeated/exceeded the cursor position");
    }
    return row;
  });

  for (let index = 1; index < rows.length; index += 1) {
    if (
      tupleCompareDesc(
        orderPageIdentityTupleV1(rows[index - 1]!),
        orderPageIdentityTupleV1(rows[index]!),
      ) >= 0
    ) {
      throw new Error("order page repository rows are not strictly descending");
    }
  }
  return rows;
}

export async function readOrderPageSnapshotWithinTransactionV1(
  snapshot: OrderPageSnapshotTransactionV1,
  requestInput: ReadOrderPageSnapshotRequestV1,
  keyring: OrderCursorKeyringV1,
): Promise<OrderPageSnapshotResultV1> {
  const scope = OrderCursorScopeV1Schema.parse(requestInput.scope);
  const filters = OrderCursorFiltersV1Schema.parse(requestInput.filters);
  const query = OrderListQueryV2Schema.parse({
    ...(requestInput.limit === undefined ? {} : { limit: requestInput.limit }),
    ...(requestInput.cursor ? { cursor: requestInput.cursor } : {}),
  });
  if (!Number.isSafeInteger(requestInput.nowEpochSeconds) || requestInput.nowEpochSeconds < 0) {
    throw new Error("order page nowEpochSeconds must be a non-negative safe integer");
  }

  const transactionAsOf = normalizedInstant(await snapshot.readAsOf(), "asOf");
    const revisions = OrderCollectionRevisionVectorV1Schema.parse(
      await snapshot.readStoreRevisionVector(scope),
    );
    assertExactStoreCoverage(scope, filters, revisions);
    // Force the same canonical validation used by cursor issuance even for an
    // empty/terminal first page where no cursor will be emitted.
    hashStoreRevisionVectorV1(revisions);

    const cursorClaims = query.cursor
      ? verifyOrderCursorV1(query.cursor, {
        nowEpochSeconds: requestInput.nowEpochSeconds,
        scope,
        filters,
        storeRevisionVector: revisions,
      }, keyring)
      : null;
    if (cursorClaims && Date.parse(transactionAsOf) < Date.parse(cursorClaims.asOf)) {
      throw new Error("order page database clock precedes the cursor snapshot");
    }

    const rowsRequest: OrderPageRowsRequestV1 = {
      scope,
      filters,
      ...(cursorClaims ? {
        highWatermark: cursorClaims.highWatermark,
        after: cursorClaims.position,
      } : {}),
      limit: query.limit + 1,
    };
    const rows = validateOrderPageIdentityRowsV1(
      await snapshot.readRows(rowsRequest),
      rowsRequest,
    );
    const totalCount = await snapshot.countRows({ scope, filters });
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
      throw new Error("order page totalCount must be a non-negative safe integer");
    }
    if (!cursorClaims && rows.length === 0 && totalCount !== 0) {
      throw new Error("order page first-page count/rows are inconsistent");
    }
    if (!cursorClaims && rows.length <= query.limit && totalCount !== rows.length) {
      throw new Error("order page first-page count/terminal rows are inconsistent");
    }

    const hasMore = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    const highWatermark = cursorClaims?.highWatermark
      || (pageRows[0] ? orderPageIdentityTupleV1(pageRows[0]) : null);
    const chainAsOf = cursorClaims?.asOf || transactionAsOf;
    let nextCursor: string | null = null;
    if (hasMore) {
      const last = pageRows[pageRows.length - 1];
      if (!last || !highWatermark) {
        throw new Error("order page cannot issue a cursor without a returned row/high-water");
      }
      nextCursor = cursorClaims
        ? advanceOrderCursorV1(cursorClaims, orderPageIdentityTupleV1(last), keyring)
        : createOrderCursorV1({
          nowEpochSeconds: requestInput.nowEpochSeconds,
          scope,
          filters,
          highWatermark,
          position: orderPageIdentityTupleV1(last),
          storeRevisionVector: revisions,
          asOf: chainAsOf,
        }, keyring);
    }

  return {
    rows: pageRows,
    totalCount,
    pagination: {
      limit: query.limit,
      hasMore,
      nextCursor,
      asOf: chainAsOf,
    },
    snapshot: {
      highWatermark,
      storeRevisionVector: revisions,
    },
  };
}

export async function readOrderPageSnapshotV1(
  repository: OrderPageSnapshotRepositoryV1,
  requestInput: ReadOrderPageSnapshotRequestV1,
  keyring: OrderCursorKeyringV1,
): Promise<OrderPageSnapshotResultV1> {
  return repository.withRepeatableReadSnapshot((snapshot) =>
    readOrderPageSnapshotWithinTransactionV1(snapshot, requestInput, keyring));
}

export const ORDER_PAGE_SNAPSHOT_MAX_LIMIT = ORDER_CURSOR_POLICY_V1.maximumLimit;
