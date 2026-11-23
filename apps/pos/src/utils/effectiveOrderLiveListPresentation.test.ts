import { describe, expect, it } from "vitest";
import type { EffectiveOrderPageV4 } from "@medusa-snus/contracts";
import { presentEffectiveOrderLivePagesV2, presentEffectiveOrderLivePagesV3 } from "./effectiveOrderLiveListPresentation";

function page(): EffectiveOrderPageV4 {
  return {
    schemaVersion: 4,
    creatorSelection: { mode: "all", creatorOperatorIds: [] },
    data: [{
      sourceOrder: {
        merchantId: "merchant-a",
        storeId: "store-a",
        orderId: "order-a",
        orderNumber: "ORD-A",
        status: "completed",
      },
      customerAttribution: "linked",
      customer: {
        id: "customer-a",
        firstName: "An",
        lastName: "Nguyen",
        phone: "0900000000",
      },
      order: {
        schemaVersion: 1,
        orderId: "order-a",
        currencyCode: "VND",
        minorUnitExponent: 0,
        effectiveRevision: 2,
        commercialState: "active",
        lines: [{
          lineId: "line-a",
          productId: "product-a",
          variantId: "variant-a",
          skuSnapshot: "SKU-A",
          titleSnapshot: "Corrected item",
          archivedVariant: false,
          quantity: 2,
          unitPriceMinor: 60,
        }],
        components: {
          taxMode: "inclusive",
          merchandiseGrossMinor: 120,
          discountMinor: 10,
          merchandiseNetMinor: 110,
          shippingMinor: 5,
          merchandiseVatMinor: 10,
          shippingVatMinor: 0,
          vatMinor: 10,
          unclassifiedMinor: 2,
          totalMinor: 117,
        },
        currentOrderGrossValueMinor: 117,
        dataQuality: {
          status: "complete",
          costCoverage: { knownLines: 1, totalLines: 1 },
          warnings: [],
        },
      },
      createdAt: "2026-08-01T01:00:00.000Z",
      recordedGrossCollectionsMinor: 117,
      refundsMinor: 0,
      reversalsMinor: 0,
      chargebacksMinor: 0,
      negativeCollectionsMinor: 0,
      netCollectionsMinor: 117,
      customerRefundPayableMinor: 0,
    }],
    pagination: {
      limit: 200,
      hasMore: false,
      nextCursor: null,
      asOf: "2026-08-06T08:00:00.000Z",
      totalCount: 1,
    },
    currencies: [{
      currencyCode: "VND",
      minorUnitExponent: 0,
      orderCount: 1,
      activeOrderCount: 1,
      cancelledOrderCount: 0,
      currentOrderGrossValueMinor: 117,
      effectiveItemQuantity: 2,
      recordedGrossCollectionsMinor: 117,
      refundsMinor: 0,
      reversalsMinor: 0,
      chargebacksMinor: 0,
      negativeCollectionsMinor: 0,
      netCollectionsMinor: 117,
    }],
  };
}

it("keeps one full-cohort fee total across V5 pages and refuses mixed creator snapshots", () => {
  const old = page(), row = old.data[0]!;
  const first = { ...old, schemaVersion: 5, data: [{ ...row, order: { ...row.order, schemaVersion: 2, componentVersion: 2,
    components: { ...row.order.components, paymentFeeMinor: 10, paymentFeeVatMinor: 1,
      vatMinor: row.order.components.vatMinor + 1, totalMinor: row.order.components.totalMinor + 10 },
    currentOrderGrossValueMinor: row.order.currentOrderGrossValueMinor + 10 } }],
    pagination: { ...old.pagination, totalCount: 2, hasMore: true, nextCursor: "opaque" },
    currencies: old.currencies.map((currency) => ({ ...currency, orderCount: 2, activeOrderCount: 2,
      currentOrderGrossValueMinor: 254, effectiveItemQuantity: 4,
      paymentFeeMinor: 20, paymentFeeVatMinor: 2, paymentFeeCustomerTotalMinor: 20 })) };
  const second = { ...first, data: first.data.map((item) => ({ ...item,
    sourceOrder: { ...item.sourceOrder, orderId: "order-b" }, order: { ...item.order, orderId: "order-b" } })),
    pagination: { ...first.pagination, hasMore: false, nextCursor: null } };
  const result = presentEffectiveOrderLivePagesV3([first, second]);
  expect(result.orders.map((order) => order.total)).toEqual([127, 127]);
  expect(result.currencies).toMatchObject([{ paymentFeeCustomerTotalMinor: 20, effectiveItemQuantity: 4 }]);
  expect(() => presentEffectiveOrderLivePagesV3([old])).toThrow();
  expect(() => presentEffectiveOrderLivePagesV3([first, { ...second,
    creatorSelection: { mode: "selected", creatorOperatorIds: ["different-creator"] } }])).toThrow();
});

describe("effective-order live list presentation", () => {
  it("maps corrected lines/components and VAT-inclusive totals into current list rows", () => {
    const result = presentEffectiveOrderLivePagesV2([page()]);
    expect(result).toMatchObject({
      totalCount: 1,
      loadedCount: 1,
      loadedCompletedCount: 1,
      hasMore: false,
      orders: [{
        id: "order-a",
        customerAttribution: "linked",
        customerId: "customer-a",
        customer: {
          id: "customer-a",
          first_name: "An",
          last_name: "Nguyen",
          phone: "0900000000",
        },
        currencyCode: "VND",
        minorUnitExponent: 0,
        total: 117,
        subtotal: 120,
        discount: 10,
        shippingFee: 5,
        tax: 10,
        items: [{ name: "Corrected item", quantity: 2, lineTotal: 120 }],
      }],
    });
  });

  it("retains row currency/exponent and converts minor units without VND assumptions", () => {
    const usd = structuredClone(page());
    usd.data[0]!.order.currencyCode = "USD";
    usd.data[0]!.order.minorUnitExponent = 2;
    usd.currencies[0]!.currencyCode = "USD";
    usd.currencies[0]!.minorUnitExponent = 2;

    expect(presentEffectiveOrderLivePagesV2([usd]).orders[0]).toMatchObject({
      currencyCode: "USD",
      minorUnitExponent: 2,
      subtotal: 1.2,
      discount: 0.1,
      shippingFee: 0.05,
      tax: 0.1,
      total: 1.17,
      items: [{ unitPrice: 0.6, lineTotal: 1.2 }],
    });
  });

  it("shows zero current value for cancelled rows while retaining the audit snapshot", () => {
    const cancelled = structuredClone(page());
    cancelled.data[0]!.sourceOrder.status = "canceled";
    cancelled.data[0]!.order.commercialState = "cancelled";
    cancelled.data[0]!.order.currentOrderGrossValueMinor = 0;
    cancelled.currencies[0]!.activeOrderCount = 0;
    cancelled.currencies[0]!.cancelledOrderCount = 1;
    cancelled.currencies[0]!.currentOrderGrossValueMinor = 0;

    const order = presentEffectiveOrderLivePagesV2([cancelled]).orders[0]!;
    expect(order.total).toBe(0);
    expect(order.subtotal).toBe(120);
    expect(order.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Corrected item", quantity: 2 }),
    ]));
  });

  it("rejects snapshot drift and duplicate rows across cursor pages", () => {
    const duplicate = structuredClone(page());
    duplicate.pagination.hasMore = true;
    duplicate.pagination.nextCursor = "next";
    duplicate.pagination.totalCount = 2;
    duplicate.currencies[0]!.orderCount = 2;
    duplicate.currencies[0]!.activeOrderCount = 2;
    expect(() => presentEffectiveOrderLivePagesV2([duplicate, {
      ...structuredClone(duplicate),
      pagination: { ...duplicate.pagination, hasMore: false, nextCursor: null },
    }])).toThrow(/duplicate or excess/);
    const drift = structuredClone(page());
    drift.pagination.asOf = "2026-08-06T08:00:01.000Z";
    expect(() => presentEffectiveOrderLivePagesV2([page(), drift])).toThrow(/one snapshot/);
  });
});
