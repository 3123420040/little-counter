import {
  EffectiveOrderPageV4Schema,
  EffectiveOrderPageV5Schema,
  type EffectiveOrderPageV4,
  type EffectiveOrderPageV5,
  type EffectiveOrderListRowV3,
  type EffectiveOrderListRowV5,
} from "@medusa-snus/contracts";
import type { OrderListItem } from "../api/endpoints";

export interface EffectiveOrderLiveListPresentationV2 {
  orders: OrderListItem[];
  totalCount: number;
  loadedCount: number;
  loadedCompletedCount: number;
  hasMore: boolean;
  currencies: EffectiveOrderPageV4["currencies"];
}
export interface EffectiveOrderLiveListPresentationV3 extends Omit<EffectiveOrderLiveListPresentationV2, "currencies"> {
  currencies: EffectiveOrderPageV5["currencies"];
}

function major(minor: number, exponent: number): number {
  return minor / (10 ** exponent);
}

export function presentEffectiveOrderLivePagesV2(
  input: readonly unknown[],
): EffectiveOrderLiveListPresentationV2 {
  return presentPages(input, 4);
}
export function presentEffectiveOrderLivePagesV3(input: readonly unknown[]): EffectiveOrderLiveListPresentationV3 {
  return presentPages(input, 5);
}
function presentPages(input: readonly unknown[], version: 4): EffectiveOrderLiveListPresentationV2;
function presentPages(input: readonly unknown[], version: 5): EffectiveOrderLiveListPresentationV3;
function presentPages(input: readonly unknown[], version: 4 | 5): EffectiveOrderLiveListPresentationV2 {
  const pages = input.map((page) => version === 5 ? EffectiveOrderPageV5Schema.parse(page) : EffectiveOrderPageV4Schema.parse(page));
  if (pages.length === 0) {
    return {
      orders: [],
      totalCount: 0,
      loadedCount: 0,
      loadedCompletedCount: 0,
      hasMore: false,
      currencies: [],
    };
  }
  const first = pages[0]!;
  const currencySignature = JSON.stringify(first.currencies);
  if (pages.some((page) => (
    page.pagination.asOf !== first.pagination.asOf
    || page.pagination.totalCount !== first.pagination.totalCount
    || JSON.stringify(page.currencies) !== currencySignature
    || (version === 5 && JSON.stringify(page.creatorSelection) !== JSON.stringify(first.creatorSelection))
  ))) {
    throw new Error("Effective-order live pages do not share one snapshot and aggregate set");
  }
  const rows = pages.flatMap<EffectiveOrderListRowV3 | EffectiveOrderListRowV5>((page) => page.data);
  const ids = rows.map((row) => row.sourceOrder.orderId);
  if (new Set(ids).size !== ids.length || rows.length > first.pagination.totalCount) {
    throw new Error("Effective-order live pages contain duplicate or excess rows");
  }
  const orders: OrderListItem[] = rows.map((row) => {
    const components = row.order.components;
    const exponent = row.order.minorUnitExponent;
    return {
      id: row.sourceOrder.orderId,
      display_id: row.sourceOrder.orderNumber,
      status: row.sourceOrder.status,
      currencyCode: row.order.currencyCode,
      minorUnitExponent: exponent,
      subtotal: major(components.merchandiseGrossMinor, exponent),
      discount: major(components.discountMinor, exponent),
      tax: major(components.vatMinor, exponent),
      shippingFee: major(components.shippingMinor, exponent),
      // A cancelled order keeps its latest commercial snapshot for audit and
      // recreate, but its current order value is zero. The list's "Tổng"
      // column represents current value and must agree with its headline.
      total: major(row.order.currentOrderGrossValueMinor, exponent),
      created_at: row.createdAt,
      paymentStatus: row.recordedGrossCollectionsMinor > 0 ? "posted" : "unrecorded",
      customerAttribution: row.customerAttribution,
      customerId: row.customer?.id || null,
      customer: row.customer ? {
        id: row.customer.id,
        first_name: row.customer.firstName || undefined,
        last_name: row.customer.lastName || undefined,
        phone: row.customer.phone || undefined,
      } : undefined,
      canonicalPaymentSummary: {
        recordedGrossCollectionsMinor: row.recordedGrossCollectionsMinor,
        refundsMinor: row.refundsMinor,
        reversalsMinor: row.reversalsMinor,
        chargebacksMinor: row.chargebacksMinor,
        negativeCollectionsMinor: row.negativeCollectionsMinor,
        netCollectionsMinor: row.netCollectionsMinor,
        customerRefundPayableMinor: row.customerRefundPayableMinor,
      },
      items: row.order.lines.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        name: item.titleSnapshot,
        quantity: item.quantity,
        unitPrice: major(item.unitPriceMinor, exponent),
        lineTotal: major(item.quantity * item.unitPriceMinor, exponent),
      })),
    };
  });
  return {
    orders,
    totalCount: first.pagination.totalCount,
    loadedCount: orders.length,
    loadedCompletedCount: orders.filter((order) => order.status === "completed").length,
    hasMore: pages.at(-1)!.pagination.hasMore,
    currencies: structuredClone(first.currencies),
  };
}
