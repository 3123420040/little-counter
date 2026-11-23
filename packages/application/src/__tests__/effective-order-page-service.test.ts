import { describe, expect, it, vi } from "vitest";
import {
  EffectiveOrderPageV2Schema,
  EffectiveOrderPageV3Schema,
  EffectiveOrderPageV4Schema,
  type EffectiveOrderPageCurrencyAggregateV2,
  type EffectiveOrderV1,
  type OrderCollectionRevisionVectorV1,
} from "@medusa-snus/contracts";
import { normalizeOrderCursorFiltersV1 } from "../services/order-cursor-service";
import {
  readEffectiveOrderPageV2,
  readEffectiveOrderPageV3,
  readEffectiveOrderPageV5,
  type EffectiveOrderPageSnapshotRepositoryV5,
  type EffectiveOrderPagePaymentSummaryV2,
  type EffectiveOrderPageSnapshotRepositoryV2,
  type EffectiveOrderPageSnapshotTransactionV2,
} from "../services/effective-order-page-service";

const scope = { merchantId: "merchant-a", storeIds: ["store-a"] };
const filters = normalizeOrderCursorFiltersV1({
  statusMode: "all",
  storeWindows: [{
    storeId: "store-a",
    startInclusive: "2026-08-01T00:00:00.000Z",
    endExclusive: "2026-08-06T00:00:00.000Z",
  }],
});
const keyring = {
  current: {
    keyId: "effective-page-current",
    keyBase64Url: Buffer.alloc(32, 21).toString("base64url"),
  },
};

it("rejects V4 quantity overflow across individually safe currency aggregates", () => {
  const aggregate = {
    currencyCode: "VND", minorUnitExponent: 0, orderCount: 1, activeOrderCount: 1,
    cancelledOrderCount: 0, currentOrderGrossValueMinor: 0, recordedGrossCollectionsMinor: 0,
    refundsMinor: 0, reversalsMinor: 0, chargebacksMinor: 0, negativeCollectionsMinor: 0, netCollectionsMinor: 0,
  };
  const page = {
    schemaVersion: 4, creatorSelection: { mode: "all", creatorOperatorIds: [] }, data: [],
    pagination: { limit: 20, hasMore: false, nextCursor: null, asOf: "2026-08-05T00:00:00.000Z", totalCount: 2 },
    currencies: [{ ...aggregate, effectiveItemQuantity: Number.MAX_SAFE_INTEGER },
      { ...aggregate, currencyCode: "USD", minorUnitExponent: 2, effectiveItemQuantity: 1 }],
  };
  expect(EffectiveOrderPageV4Schema.safeParse(page).success).toBe(false);
  page.currencies[0]!.effectiveItemQuantity = Number.MAX_SAFE_INTEGER - 1;
  expect(EffectiveOrderPageV4Schema.safeParse(page).success).toBe(true);
});

function effective(orderId: string, totalMinor: number): EffectiveOrderV1 {
  return {
    schemaVersion: 1,
    orderId,
    currencyCode: "VND",
    minorUnitExponent: 0,
    effectiveRevision: 2,
    commercialState: "active",
    lines: [{
      lineId: `${orderId}:line`,
      productId: "product-a",
      variantId: "variant-a",
      skuSnapshot: "SKU-CORRECTED",
      titleSnapshot: "Corrected item",
      quantity: 1,
      unitPriceMinor: totalMinor,
      archivedVariant: false,
    }],
    components: {
      taxMode: "exclusive",
      merchandiseGrossMinor: totalMinor,
      discountMinor: 0,
      merchandiseNetMinor: totalMinor,
      shippingMinor: 0,
      merchandiseVatMinor: 0,
      shippingVatMinor: 0,
      vatMinor: 0,
      unclassifiedMinor: 0,
      totalMinor,
    },
    currentOrderGrossValueMinor: totalMinor,
    dataQuality: {
      status: "complete",
      costCoverage: { knownLines: 1, totalLines: 1 },
      warnings: [],
    },
  };
}

class EffectiveTransaction implements EffectiveOrderPageSnapshotTransactionV2 {
  active = true;
  projections = [effective("order-b", 3_000), effective("order-a", 2_300)];
  payments: EffectiveOrderPagePaymentSummaryV2[] = [
    {
      orderId: "order-a",
      currencyCode: "VND",
      recordedGrossCollectionsMinor: 2_300,
      refundsMinor: 100,
      reversalsMinor: 0,
      chargebacksMinor: 0,
      negativeCollectionsMinor: 100,
      netCollectionsMinor: 2_200,
      customerRefundPayableMinor: 400,
    },
    {
      orderId: "order-b",
      currencyCode: "VND",
      recordedGrossCollectionsMinor: 3_000,
      refundsMinor: 0,
      reversalsMinor: 0,
      chargebacksMinor: 50,
      negativeCollectionsMinor: 50,
      netCollectionsMinor: 2_950,
      customerRefundPayableMinor: 0,
    },
  ];
  aggregates: EffectiveOrderPageCurrencyAggregateV2[] = [{
    currencyCode: "VND",
    minorUnitExponent: 0,
    orderCount: 2,
    activeOrderCount: 2,
    cancelledOrderCount: 0,
    currentOrderGrossValueMinor: 5_300,
    recordedGrossCollectionsMinor: 5_300,
    refundsMinor: 100,
    reversalsMinor: 0,
    chargebacksMinor: 50,
    negativeCollectionsMinor: 150,
    netCollectionsMinor: 5_150,
  }];

  private assertActive() {
    if (!this.active) throw new Error("hydration escaped snapshot transaction");
  }

  async readAsOf() {
    this.assertActive();
    return "2026-08-05T00:00:00.000Z";
  }

  async readStoreRevisionVector(): Promise<OrderCollectionRevisionVectorV1> {
    this.assertActive();
    return [{ storeId: "store-a", revision: 17 }];
  }

  async readRows() {
    this.assertActive();
    return [
      {
        merchantId: "merchant-a",
        storeId: "store-a",
        orderId: "order-b",
        orderNumber: "ORD-B",
        status: "completed",
        currencyCode: "VND",
        createdAt: "2026-08-04T12:00:00.000Z",
        customer: {
          id: "customer-b",
          firstName: "Binh",
          lastName: "Tran",
          phone: "0911111111",
        },
      },
      {
        merchantId: "merchant-a",
        storeId: "store-a",
        orderId: "order-a",
        orderNumber: "ORD-A",
        status: "completed",
        currencyCode: "VND",
        createdAt: "2026-08-04T11:00:00.000Z",
        customer: null,
      },
    ];
  }

  async countRows() {
    this.assertActive();
    return 2;
  }

  async readEffectiveOrders() {
    this.assertActive();
    return this.projections;
  }

  async readPaymentSummaries() {
    this.assertActive();
    return this.payments;
  }

  async readCurrencyAggregates() {
    this.assertActive();
    return this.aggregates;
  }
}

class EffectiveRepository implements EffectiveOrderPageSnapshotRepositoryV2 {
  transactionCount = 0;
  transaction = new EffectiveTransaction();

  async withRepeatableReadSnapshot<T>(
    read: (snapshot: EffectiveOrderPageSnapshotTransactionV2) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    this.transaction.active = true;
    try {
      return await read(this.transaction);
    } finally {
      this.transaction.active = false;
    }
  }
}

describe("PAGE-01D effective order/payment hydration", () => {
  it("keeps fees outside the loaded V5 page in full-cohort creator-filtered totals", async () => {
    const oldRepository = new EffectiveRepository();
    const readFeeAwareEffectiveOrders = vi.fn(async () => [{ ...effective("order-b", 3_000), schemaVersion: 2 as const,
      componentVersion: 1 as const, components: { ...effective("order-b", 3_000).components, paymentFeeMinor: 0, paymentFeeVatMinor: 0 } }]);
    const readFeeAwareCurrencyAggregates = vi.fn(async () => [{ ...oldRepository.transaction.aggregates[0]!,
      currentOrderGrossValueMinor: 5_410, effectiveItemQuantity: 2,
      paymentFeeMinor: 100, paymentFeeVatMinor: 10, paymentFeeCustomerTotalMinor: 110 }]);
    const snapshot = Object.assign(oldRepository.transaction, { readFeeAwareEffectiveOrders, readFeeAwareCurrencyAggregates,
      readPaymentSummaries: async () => oldRepository.transaction.payments.filter((payment) => payment.orderId === "order-b") });
    const repository: EffectiveOrderPageSnapshotRepositoryV5 = { withRepeatableReadSnapshot: (read) =>
      oldRepository.withRepeatableReadSnapshot(() => read(snapshot)) };
    const creatorSelection = { mode: "selected" as const, creatorOperatorIds: ["staff-a"] };
    const page = await readEffectiveOrderPageV5(repository, { scope,
      filters: { ...filters, creatorSelection, searchMode: "order_or_customer_identity" }, limit: 1, nowEpochSeconds: 1_800_000_000 }, keyring);
    expect(page).toMatchObject({ schemaVersion: 5, creatorSelection, pagination: { hasMore: true, totalCount: 2 },
      data: [{ order: { orderId: "order-b", components: { paymentFeeMinor: 0 } } }],
      currencies: [{ currentOrderGrossValueMinor: 5_410, paymentFeeCustomerTotalMinor: 110, effectiveItemQuantity: 2 }] });
    expect(oldRepository.transactionCount).toBe(1);
    expect(readFeeAwareCurrencyAggregates).toHaveBeenCalledExactlyOnceWith({ scope,
      filters: { ...filters, creatorSelection, searchMode: "order_or_customer_identity" }, asOf: "2026-08-05T00:00:00.000Z" });
  });
  it.each([readEffectiveOrderPageV2, readEffectiveOrderPageV3])("keeps legacy page contracts valid when the shared reader returns V4-only aggregate fields", async (readPage) => {
    const repository = new EffectiveRepository();
    repository.transaction.aggregates = repository.transaction.aggregates.map((aggregate) => ({ ...aggregate, effectiveItemQuantity: 4 }));
    repository.transaction.payments = repository.transaction.payments.map((payment) => ({ ...payment, paymentMethods: ["cash"] }));
    const page = await readPage(repository, {
      scope, filters: { ...filters, searchMode: "order_or_customer_identity" },
      limit: 50, nowEpochSeconds: 1_800_000_000,
    }, keyring);
    expect(page.currencies[0]).not.toHaveProperty("effectiveItemQuantity");
    expect(page.data[0]).not.toHaveProperty("paymentMethods");
  });
  it("hydrates identity, corrected orders, payment breakdown and aggregates in one snapshot", async () => {
    const repository = new EffectiveRepository();
    const page = await readEffectiveOrderPageV2(repository, {
      scope,
      filters,
      limit: 50,
      nowEpochSeconds: 1_800_000_000,
    }, keyring);

    expect(repository.transactionCount).toBe(1);
    expect(EffectiveOrderPageV2Schema.parse(page)).toEqual(page);
    expect(page).toMatchObject({
      schemaVersion: 2,
      pagination: {
        limit: 50,
        hasMore: false,
        nextCursor: null,
        totalCount: 2,
        asOf: "2026-08-05T00:00:00.000Z",
      },
      currencies: [{
        currencyCode: "VND",
        currentOrderGrossValueMinor: 5_300,
        recordedGrossCollectionsMinor: 5_300,
        negativeCollectionsMinor: 150,
        netCollectionsMinor: 5_150,
      }],
    });
    expect(page.data.map((row) => row.sourceOrder.orderId)).toEqual(["order-b", "order-a"]);
    expect(page.data[0]).toMatchObject({
      sourceOrder: { orderId: "order-b", orderNumber: "ORD-B" },
      order: { effectiveRevision: 2, currentOrderGrossValueMinor: 3_000 },
      recordedGrossCollectionsMinor: 3_000,
      chargebacksMinor: 50,
      netCollectionsMinor: 2_950,
    });
  });

  it("fails closed for missing/duplicate/mismatched hydration and forged aggregates", async () => {
    const mutations: Array<(transaction: EffectiveTransaction) => void> = [
      (transaction) => { transaction.projections = transaction.projections.slice(0, 1); },
      (transaction) => { transaction.payments = [transaction.payments[0]!, transaction.payments[0]!]; },
      (transaction) => {
        transaction.payments[0] = { ...transaction.payments[0]!, currencyCode: "USD" };
      },
      (transaction) => {
        transaction.aggregates[0] = { ...transaction.aggregates[0]!, orderCount: 3 };
      },
    ];

    for (const mutate of mutations) {
      const repository = new EffectiveRepository();
      mutate(repository.transaction);
      await expect(readEffectiveOrderPageV2(repository, {
        scope,
        filters,
        limit: 50,
        nowEpochSeconds: 1_800_000_000,
      }, keyring)).rejects.toThrow();
    }
  });

  it("hydrates tenant-scoped customer attribution only in the additive v3 contract", async () => {
    const repository = new EffectiveRepository();
    const page = await readEffectiveOrderPageV3(repository, {
      scope,
      filters: { ...filters, searchMode: "order_or_customer_identity" },
      limit: 50,
      nowEpochSeconds: 1_800_000_000,
    }, keyring);

    expect(EffectiveOrderPageV3Schema.parse(page)).toEqual(page);
    expect(page.schemaVersion).toBe(3);
    expect(page.data.map((row) => row.customer)).toEqual([{
      id: "customer-b",
      firstName: "Binh",
      lastName: "Tran",
      phone: "0911111111",
    }, null]);
  });
});
