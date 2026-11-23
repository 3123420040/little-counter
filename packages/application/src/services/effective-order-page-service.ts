import {
  EffectiveOrderCsvPaymentSummaryV3Schema,
  EffectiveOrderPageCurrencyAggregateV2Schema,
  EffectiveOrderPageCurrencyAggregateV4Schema,
  EffectiveOrderPageV2Schema,
  EffectiveOrderPageV3Schema,
  EffectiveOrderPageV4Schema,
  EffectiveOrderPageV5Schema,
  EffectiveOrderPageCurrencyAggregateV5Schema,
  EffectiveOrderV1Schema,
  EffectiveOrderV2Schema,
  type EffectiveOrderCsvPaymentSummaryV3,
  type EffectiveOrderPageCurrencyAggregateV2,
  type EffectiveOrderPageV4,
  type EffectiveOrderPageV2,
  type EffectiveOrderPageV3,
  type EffectiveOrderV1,
  type EffectiveOrderV2,
  type EffectiveOrderPageV5,
  type EffectiveOrderPageCurrencyAggregateV5,
  type OrderCursorFiltersV1,
  type OrderCursorScopeV1,
} from "@medusa-snus/contracts";
import type { EffectiveOrderProjectionBatchRequest } from "./effective-order-projection-service";
import type { OrderCursorKeyringV1 } from "./order-cursor-service";
import {
  readOrderPageSnapshotWithinTransactionV1,
  type OrderPageSnapshotRepositoryV1,
  type OrderPageSnapshotTransactionV1,
  type ReadOrderPageSnapshotRequestV1,
} from "./order-page-snapshot-service";

export interface EffectiveOrderPagePaymentSummaryV2 extends EffectiveOrderCsvPaymentSummaryV3 {
  orderId: string;
  customerRefundPayableMinor: number;
  /** V4 CSV keeps the stable method set; V2/V3 page payloads omit it. */
  paymentMethods?: string[];
}

export interface EffectiveOrderPagePaymentRequestV2 {
  scope: OrderCursorScopeV1;
  orderIds: readonly string[];
  asOf: string;
}

export interface EffectiveOrderPageAggregateRequestV2 {
  scope: OrderCursorScopeV1;
  filters: OrderCursorFiltersV1;
  asOf: string;
}

/** Internal additive aggregate returned by the PostgreSQL reader for V4. */
export type EffectiveOrderPageAggregateReadV4 = EffectiveOrderPageCurrencyAggregateV2 & {
  effectiveItemQuantity?: number;
};

export interface EffectiveOrderPageSnapshotTransactionV2
  extends OrderPageSnapshotTransactionV1 {
  readEffectiveOrders(input: EffectiveOrderProjectionBatchRequest): Promise<EffectiveOrderV1[]>;
  readPaymentSummaries(
    input: EffectiveOrderPagePaymentRequestV2,
  ): Promise<EffectiveOrderPagePaymentSummaryV2[]>;
  readCurrencyAggregates(
    input: EffectiveOrderPageAggregateRequestV2,
  ): Promise<EffectiveOrderPageAggregateReadV4[]>;
}

export interface EffectiveOrderPageSnapshotRepositoryV2
  extends Omit<OrderPageSnapshotRepositoryV1, "withRepeatableReadSnapshot"> {
  withRepeatableReadSnapshot<T>(
    read: (snapshot: EffectiveOrderPageSnapshotTransactionV2) => Promise<T>,
  ): Promise<T>;
}

export interface EffectiveOrderPageSnapshotTransactionV5 extends EffectiveOrderPageSnapshotTransactionV2 {
  readFeeAwareEffectiveOrders(input: EffectiveOrderProjectionBatchRequest): Promise<EffectiveOrderV2[]>;
  readFeeAwareCurrencyAggregates(input: EffectiveOrderPageAggregateRequestV2): Promise<EffectiveOrderPageCurrencyAggregateV5[]>;
}
export interface EffectiveOrderPageSnapshotRepositoryV5 extends Omit<EffectiveOrderPageSnapshotRepositoryV2, "withRepeatableReadSnapshot"> {
  withRepeatableReadSnapshot<T>(read: (snapshot: EffectiveOrderPageSnapshotTransactionV5) => Promise<T>): Promise<T>;
}

function exactMap<T extends { orderId: string }>(
  values: readonly T[],
  expectedOrderIds: readonly string[],
  label: string,
): Map<string, T> {
  const expected = new Set(expectedOrderIds);
  const byOrder = new Map<string, T>();
  for (const value of values) {
    if (!expected.has(value.orderId) || byOrder.has(value.orderId)) {
      throw new Error(`effective page ${label} identity drift`);
    }
    byOrder.set(value.orderId, value);
  }
  if (byOrder.size !== expectedOrderIds.length) {
    throw new Error(`effective page ${label} coverage is incomplete`);
  }
  return byOrder;
}

export async function readEffectiveOrderPageV2(
  repository: EffectiveOrderPageSnapshotRepositoryV2,
  request: ReadOrderPageSnapshotRequestV1,
  keyring: OrderCursorKeyringV1,
): Promise<EffectiveOrderPageV2> {
  return repository.withRepeatableReadSnapshot(async (snapshot) => {
    const identityPage = await readOrderPageSnapshotWithinTransactionV1(
      snapshot,
      request,
      keyring,
    );
    const rowsByCurrency = new Map<string, typeof identityPage.rows>();
    for (const row of identityPage.rows) {
      const rows = rowsByCurrency.get(row.currencyCode) || [];
      rows.push(row);
      rowsByCurrency.set(row.currencyCode, rows);
    }

    const projections: EffectiveOrderV1[] = [];
    for (const [currencyCode, rows] of rowsByCurrency) {
      const batch = await snapshot.readEffectiveOrders({
        scope: {
          scopeKind: "report",
          merchantId: request.scope.merchantId,
          storeIds: [...request.scope.storeIds],
        },
        orderIds: rows.map((row) => row.orderId),
        currencyCode,
        asOf: identityPage.pagination.asOf,
      });
      projections.push(...batch.map((projection) => EffectiveOrderV1Schema.parse(projection)));
    }
    const orderIds = identityPage.rows.map((row) => row.orderId);
    const projectionByOrder = exactMap(projections, orderIds, "projection");

    const paymentSummaries = orderIds.length === 0 ? [] : await snapshot.readPaymentSummaries({
      scope: request.scope,
      orderIds,
      asOf: identityPage.pagination.asOf,
    });
    const parsedPayments = paymentSummaries.map((summary) => {
      const { orderId, customerRefundPayableMinor, paymentMethods: _paymentMethods, ...paymentInput } = summary;
      return {
        orderId,
        ...EffectiveOrderCsvPaymentSummaryV3Schema.parse(paymentInput),
        customerRefundPayableMinor,
      };
    });
    const paymentByOrder = exactMap(parsedPayments, orderIds, "payment");

    const currencies = (await snapshot.readCurrencyAggregates({
      scope: request.scope,
      filters: request.filters,
      asOf: identityPage.pagination.asOf,
    })).map(({ effectiveItemQuantity: _quantity, ...aggregate }) => EffectiveOrderPageCurrencyAggregateV2Schema.parse(aggregate));

    return EffectiveOrderPageV2Schema.parse({
      schemaVersion: 2,
      data: identityPage.rows.map((identity) => {
        const order = projectionByOrder.get(identity.orderId);
        const payment = paymentByOrder.get(identity.orderId);
        if (
          !order
          || !payment
          || order.currencyCode !== identity.currencyCode
          || payment.currencyCode !== identity.currencyCode
        ) {
          throw new Error("effective page identity/currency hydration mismatch");
        }
        return {
          sourceOrder: {
            merchantId: identity.merchantId,
            storeId: identity.storeId,
            orderId: identity.orderId,
            orderNumber: identity.orderNumber,
            status: identity.status,
          },
          order,
          createdAt: identity.createdAt,
          recordedGrossCollectionsMinor: payment.recordedGrossCollectionsMinor,
          refundsMinor: payment.refundsMinor,
          reversalsMinor: payment.reversalsMinor,
          chargebacksMinor: payment.chargebacksMinor,
          negativeCollectionsMinor: payment.negativeCollectionsMinor,
          netCollectionsMinor: payment.netCollectionsMinor,
          customerRefundPayableMinor: payment.customerRefundPayableMinor,
        };
      }),
      pagination: {
        ...identityPage.pagination,
        totalCount: identityPage.totalCount,
      },
      currencies,
    });
  });
}

export async function readEffectiveOrderPageV3(
  repository: EffectiveOrderPageSnapshotRepositoryV2,
  request: ReadOrderPageSnapshotRequestV1,
  keyring: OrderCursorKeyringV1,
): Promise<EffectiveOrderPageV3> {
  return repository.withRepeatableReadSnapshot(async (snapshot) => {
    const identityPage = await readOrderPageSnapshotWithinTransactionV1(
      snapshot,
      request,
      keyring,
    );
    const rowsByCurrency = new Map<string, typeof identityPage.rows>();
    for (const row of identityPage.rows) {
      const rows = rowsByCurrency.get(row.currencyCode) || [];
      rows.push(row);
      rowsByCurrency.set(row.currencyCode, rows);
    }

    const projections: EffectiveOrderV1[] = [];
    for (const [currencyCode, rows] of rowsByCurrency) {
      const batch = await snapshot.readEffectiveOrders({
        scope: {
          scopeKind: "report",
          merchantId: request.scope.merchantId,
          storeIds: [...request.scope.storeIds],
        },
        orderIds: rows.map((row) => row.orderId),
        currencyCode,
        asOf: identityPage.pagination.asOf,
      });
      projections.push(...batch.map((projection) => EffectiveOrderV1Schema.parse(projection)));
    }
    const orderIds = identityPage.rows.map((row) => row.orderId);
    const projectionByOrder = exactMap(projections, orderIds, "projection");

    const paymentSummaries = orderIds.length === 0 ? [] : await snapshot.readPaymentSummaries({
      scope: request.scope,
      orderIds,
      asOf: identityPage.pagination.asOf,
    });
    const parsedPayments = paymentSummaries.map((summary) => {
      const { orderId, customerRefundPayableMinor, paymentMethods: _paymentMethods, ...paymentInput } = summary;
      return {
        orderId,
        ...EffectiveOrderCsvPaymentSummaryV3Schema.parse(paymentInput),
        customerRefundPayableMinor,
      };
    });
    const paymentByOrder = exactMap(parsedPayments, orderIds, "payment");

    const currencies = (await snapshot.readCurrencyAggregates({
      scope: request.scope,
      filters: request.filters,
      asOf: identityPage.pagination.asOf,
    })).map(({ effectiveItemQuantity: _quantity, ...aggregate }) => EffectiveOrderPageCurrencyAggregateV2Schema.parse(aggregate));

    return EffectiveOrderPageV3Schema.parse({
      schemaVersion: 3,
      data: identityPage.rows.map((identity) => {
        const order = projectionByOrder.get(identity.orderId);
        const payment = paymentByOrder.get(identity.orderId);
        if (
          !order
          || !payment
          || order.currencyCode !== identity.currencyCode
          || payment.currencyCode !== identity.currencyCode
        ) {
          throw new Error("effective page identity/currency hydration mismatch");
        }
        return {
          sourceOrder: {
            merchantId: identity.merchantId,
            storeId: identity.storeId,
            orderId: identity.orderId,
            orderNumber: identity.orderNumber,
            status: identity.status,
          },
          customerAttribution: identity.customerAttribution
            ?? (identity.customer ? "linked" : "unknown"),
          customer: identity.customer ?? null,
          order,
          createdAt: identity.createdAt,
          recordedGrossCollectionsMinor: payment.recordedGrossCollectionsMinor,
          refundsMinor: payment.refundsMinor,
          reversalsMinor: payment.reversalsMinor,
          chargebacksMinor: payment.chargebacksMinor,
          negativeCollectionsMinor: payment.negativeCollectionsMinor,
          netCollectionsMinor: payment.netCollectionsMinor,
          customerRefundPayableMinor: payment.customerRefundPayableMinor,
        };
      }),
      pagination: {
        ...identityPage.pagination,
        totalCount: identityPage.totalCount,
      },
      currencies,
    });
  });
}

/**
 * V4 keeps V3 rows and cursor semantics but exposes a server aggregate for
 * sold quantity.  The aggregate is calculated before pagination by the same
 * filtered CTE as the rows, so the UI never derives a headline from loaded
 * pages.
 */
export async function readEffectiveOrderPageV4(
  repository: EffectiveOrderPageSnapshotRepositoryV2,
  request: ReadOrderPageSnapshotRequestV1,
  keyring: OrderCursorKeyringV1,
): Promise<EffectiveOrderPageV4> {
  return repository.withRepeatableReadSnapshot((snapshot) => readPageFromSnapshot({ version: 4, snapshot }, request, keyring));
}

export function readEffectiveOrderPageV5(repository: EffectiveOrderPageSnapshotRepositoryV5, request: ReadOrderPageSnapshotRequestV1,
  keyring: OrderCursorKeyringV1): Promise<EffectiveOrderPageV5> {
  return repository.withRepeatableReadSnapshot((snapshot) => readPageFromSnapshot({ version: 5, snapshot }, request, keyring));
}
type PageSnapshotCommand = { version: 4; snapshot: EffectiveOrderPageSnapshotTransactionV2 }
  | { version: 5; snapshot: EffectiveOrderPageSnapshotTransactionV5 };
function readPageFromSnapshot(command: Extract<PageSnapshotCommand, { version: 4 }>, request: ReadOrderPageSnapshotRequestV1, keyring: OrderCursorKeyringV1): Promise<EffectiveOrderPageV4>;
function readPageFromSnapshot(command: Extract<PageSnapshotCommand, { version: 5 }>, request: ReadOrderPageSnapshotRequestV1, keyring: OrderCursorKeyringV1): Promise<EffectiveOrderPageV5>;
async function readPageFromSnapshot(command: PageSnapshotCommand, request: ReadOrderPageSnapshotRequestV1,
  keyring: OrderCursorKeyringV1): Promise<EffectiveOrderPageV4 | EffectiveOrderPageV5> {
    const snapshot = command.snapshot;
    const identityPage = await readOrderPageSnapshotWithinTransactionV1(snapshot, request, keyring);
    const rowsByCurrency = new Map<string, typeof identityPage.rows>();
    for (const row of identityPage.rows) {
      const rows = rowsByCurrency.get(row.currencyCode) || [];
      rows.push(row);
      rowsByCurrency.set(row.currencyCode, rows);
    }
    const projections: Array<EffectiveOrderV1 | EffectiveOrderV2> = [];
    for (const [currencyCode, rows] of rowsByCurrency) {
      const projectionRequest: EffectiveOrderProjectionBatchRequest = {
        scope: { scopeKind: "report", merchantId: request.scope.merchantId, storeIds: [...request.scope.storeIds] },
        orderIds: rows.map((row) => row.orderId),
        currencyCode,
        asOf: identityPage.pagination.asOf,
      };
      const batch = command.version === 5 ? await command.snapshot.readFeeAwareEffectiveOrders(projectionRequest)
        : await snapshot.readEffectiveOrders(projectionRequest);
      projections.push(...batch.map((projection) => command.version === 5 ? EffectiveOrderV2Schema.parse(projection) : EffectiveOrderV1Schema.parse(projection)));
    }
    const orderIds = identityPage.rows.map((row) => row.orderId);
    const projectionByOrder = exactMap(projections, orderIds, "projection");
    const paymentSummaries = orderIds.length === 0 ? [] : await snapshot.readPaymentSummaries({
      scope: request.scope,
      orderIds,
      asOf: identityPage.pagination.asOf,
    });
    const parsedPayments = paymentSummaries.map((summary) => {
      const { orderId, customerRefundPayableMinor, paymentMethods: _paymentMethods, ...paymentInput } = summary;
      return {
        orderId,
        ...EffectiveOrderCsvPaymentSummaryV3Schema.parse(paymentInput),
        customerRefundPayableMinor,
      };
    });
    const paymentByOrder = exactMap(parsedPayments, orderIds, "payment");
    const aggregateRequest = {
      scope: request.scope,
      filters: request.filters,
      asOf: identityPage.pagination.asOf,
    };
    const currencies = command.version === 5
      ? (await command.snapshot.readFeeAwareCurrencyAggregates(aggregateRequest)).map((aggregate) => EffectiveOrderPageCurrencyAggregateV5Schema.parse(aggregate))
      : (await snapshot.readCurrencyAggregates(aggregateRequest)).map((aggregate) => {
      if (!Number.isSafeInteger(aggregate.effectiveItemQuantity) || aggregate.effectiveItemQuantity! < 0) {
        throw new Error("effective page V4 quantity aggregate is unavailable");
      }
      const { effectiveItemQuantity, ...v2Aggregate } = aggregate;
      return EffectiveOrderPageCurrencyAggregateV4Schema.parse({
        ...EffectiveOrderPageCurrencyAggregateV2Schema.parse(v2Aggregate),
        effectiveItemQuantity,
      });
    });
    const body = {
      schemaVersion: command.version,
      creatorSelection: request.filters.creatorSelection || { mode: "all", creatorOperatorIds: [] },
      data: identityPage.rows.map((identity) => {
        const order = projectionByOrder.get(identity.orderId);
        const payment = paymentByOrder.get(identity.orderId);
        if (!order || !payment || order.currencyCode !== identity.currencyCode || payment.currencyCode !== identity.currencyCode) {
          throw new Error("effective page identity/currency hydration mismatch");
        }
        return {
          sourceOrder: {
            merchantId: identity.merchantId,
            storeId: identity.storeId,
            orderId: identity.orderId,
            orderNumber: identity.orderNumber,
            status: identity.status,
          },
          customerAttribution: identity.customerAttribution ?? (identity.customer ? "linked" : "unknown"),
          customer: identity.customer ?? null,
          order,
          createdAt: identity.createdAt,
          recordedGrossCollectionsMinor: payment.recordedGrossCollectionsMinor,
          refundsMinor: payment.refundsMinor,
          reversalsMinor: payment.reversalsMinor,
          chargebacksMinor: payment.chargebacksMinor,
          negativeCollectionsMinor: payment.negativeCollectionsMinor,
          netCollectionsMinor: payment.netCollectionsMinor,
          customerRefundPayableMinor: payment.customerRefundPayableMinor,
        };
      }),
      pagination: { ...identityPage.pagination, totalCount: identityPage.totalCount },
      currencies,
    };
    return command.version === 5 ? EffectiveOrderPageV5Schema.parse(body) : EffectiveOrderPageV4Schema.parse(body);
}
