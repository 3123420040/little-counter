// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTestUi, click, type TestRender } from "../test/reactTestHarness";
import type { OrderListItem } from "../api/endpoints";
import { EffectiveOrderPageV5Schema, type EffectiveOrderPageV5, type EffectiveOrderSurfaceV3 } from "@medusa-snus/contracts";
import { RuntimeBuildInfoV2Schema, emptyRuntimeCapabilitySetV1, emptyPaymentFeeCapabilitySetV1 } from "@medusa-snus/contracts/runtime-capabilities";
const state = vi.hoisted(() => ({ surface: null as EffectiveOrderSurfaceV3 | null, page: null as EffectiveOrderPageV5 | null, feeAware: false, reviewError: false, detailUnavailable: false, detailError: false, retryDetail: vi.fn() }));
const build = RuntimeBuildInfoV2Schema.parse({ schemaVersion: 2, service: "medusa", sourceCommit: "a".repeat(40), releaseId: "synthetic-v5",
  compatibilityFamily: "snus-runtime-v1", capabilities: emptyRuntimeCapabilitySetV1(),
  paymentFeeCapabilities: { ...emptyPaymentFeeCapabilitySetV1(), ordersRead: ["v5"], orderDetail: ["v3"] } });
vi.mock("../hooks/useRuntimeCapabilities", () => ({ usePaymentFeeRuntimeBuild: () => state.feeAware ? build : null }));
const order: OrderListItem = { id: "order-fee", display_id: "ORD-FEE", status: "completed", total: 1_110,
  currencyCode: "VND", minorUnitExponent: 0, created_at: new Date().toISOString(),
  items: [], customerAttribution: "walk_in", paymentEntries: [], corrections: [], stockAdjustments: [] };
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ operator: { id: "synthetic-staff", role: "staff" } }) }));
vi.mock("../hooks/usePermissions", () => ({ usePermission: () => false }));
vi.mock("../hooks/useProducts", () => ({ useClientOperatingScope: () => ({ operatingMerchantId: "m-a", operatingStoreId: "s-a" }) }));
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (value: string) => value }) }));
vi.mock("../hooks/useAppAccessSnapshot", () => ({ useAppAccessSnapshot: () => ({ snapshot: null, runtime: {
  handshakeState: "v2_compatibility", selected: { orderDetail: "v2" }, surfaces: { ordersRead: "v2_compatibility" },
} }) }));
vi.mock("../hooks/useOrders", () => ({
  useOrders: () => ({ data: { orders: [order], totalCount: 1, completedCount: 1, totalRevenue: 1_110 }, isLoading: false }),
  useEffectiveOrderFeaturePage: () => state.page ? ({ data: { pages: [state.page] }, isLoading: false }) : ({}), useOrderCreatorOptions: () => ({ data: [] }),
  useOrderDetail: () => ({ data: state.detailUnavailable ? undefined : order, isError: state.detailError, refetch: state.retryDetail }),
  useEffectiveOrderFeatureDetail: () => ({ data: state.surface, contractVersion: "v3", isLoading: false }),
  useManualReviewPaymentIntents: () => ({ data: { data: [], count: 0 }, isError: state.reviewError, refetch: vi.fn() }),
  useUpdateOrder: () => ({}), useCancelOrder: () => ({}), useRefundOrder: () => ({}),
  useConfirmManualBankPayment: () => ({}), useOrderCancellationQuote: () => ({}),
}));
vi.mock("../components/CustomerSearch", () => ({ CustomerSearch: () => null }));
vi.mock("../components/OrderCorrectionDrawer", () => ({ OrderCorrectionDrawer: () => null }));
vi.mock("../components/OrderShippingAdjustmentPanel", () => ({ OrderShippingAdjustmentPanel: () => null }));
vi.mock("../components/OrderCancelDialog", () => ({ OrderCancelDialog: () => null }));
vi.mock("../components/OrderRefundDialog", () => ({ OrderRefundDialog: () => null }));
vi.mock("../components/OrderRecreateModal", () => ({ OrderRecreateModal: () => null }));
vi.mock("../components/ManualBankConfirmationDialog", () => ({ ManualBankConfirmationDialog: () => null }));
import OrderHistoryScreen from "./OrderHistoryScreen";
let mounted: TestRender | undefined;
afterEach(() => { mounted?.unmount(); mounted = undefined; state.page = null; state.feeAware = false; state.reviewError = false;
  state.detailUnavailable = false; state.detailError = false; state.retryDetail.mockClear(); order.customer = undefined; order.customerAttribution = "walk_in"; order.paymentEntries = []; });
function open(surface: EffectiveOrderSurfaceV3) {
  state.surface = surface;
  mounted = renderTestUi(<OrderHistoryScreen />);
  const label = Array.from(mounted.container.querySelectorAll("span")).find((node) => node.textContent === "ORD-FEE");
  expect(label).toBeTruthy(); click(label!);
  const dialog = mounted.container.querySelector('[role="dialog"]');
  expect(dialog).toBeTruthy(); return dialog!;
}
function surface(taxMode: "inclusive" | "exclusive", componentVersion: 1 | 2 = 2): EffectiveOrderSurfaceV3 {
  const fee = componentVersion === 2 ? 100 : 0, vat = taxMode === "exclusive" ? 110 : 100;
  const total = 1_000 + fee + (taxMode === "exclusive" ? vat : 0);
  return { schemaVersion: 3, componentVersion, surfaceKind: "detail", orderId: order.id,
    currencyCode: "VND", minorUnitExponent: 0, effectiveRevision: 0, commercialState: "active",
    effectiveItems: [{ lineId: "l-1", productId: null, variantId: null, skuSnapshot: "SKU", titleSnapshot: "Item", quantity: 2, unitPriceMinor: 500, lineTotalMinor: 1_000 }],
    components: { taxMode, merchandiseGrossMinor: 1_000, discountMinor: 0, merchandiseNetMinor: 1_000, shippingMinor: 0,
      merchandiseVatMinor: 100, shippingVatMinor: 0, paymentFeeMinor: fee, paymentFeeVatMinor: fee ? 10 : 0,
      vatMinor: componentVersion === 2 ? 110 : 100, totalMinor: total, unclassifiedMinor: 0 },
    effectiveCommercialTotalMinor: total, currentOrderGrossValueMinor: total, effectiveItemQuantity: 2,
    dataQuality: { status: "complete", costCoverage: { knownLines: 1, totalLines: 1 }, warnings: [] } };
}
describe("mounted order detail fee display", () => {
  it("shows a failed operational read with retry instead of an empty payment history", () => {
    state.detailUnavailable = true; state.detailError = true;
    const dialog = open(surface("inclusive"));
    expect(dialog.textContent).toContain("Không tải được thông tin thanh toán và vận hành của đơn");
    expect(dialog.textContent).not.toContain("Chưa có payment entry");
    const retry = Array.from(dialog.querySelectorAll("button")).find(node => node.textContent === "Thử lại");
    expect(retry).toBeTruthy(); click(retry!); expect(state.retryDetail).toHaveBeenCalledOnce();
  });
  it("keeps payment history loading until operational detail arrives", () => {
    state.detailUnavailable = true;
    const dialog = open(surface("inclusive"));
    expect(dialog.textContent).toContain("Đang tải lịch sử thanh toán");
    expect(dialog.textContent).not.toContain("Chưa có payment entry");
  });
  it("renders the existing payment history independently of the fee-bearing financial detail", () => {
    order.paymentEntries = [{ id: "entry-1", direction: "charge", method: "cash", amount: 1100, currencyCode: "VND", status: "posted", referenceCode: "RECEIPT-FEE" }];
    const dialog = open(surface("inclusive"));
    expect(dialog.textContent).toContain("RECEIPT-FEE"); expect(dialog.textContent).toContain("1.100");
    expect(dialog.textContent).not.toContain("Chưa có payment entry");
  });
  it.each([
    { attribution: "linked", customer: { id: "customer-linked" }, label: "Khách đã liên kết" },
    { attribution: "linked", customer: { id: "customer-linked", first_name: "An", last_name: "Nguyễn" }, label: "Nguyễn An" },
    { attribution: "walk_in", customer: undefined, label: "orders.walkIn" },
    { attribution: "unknown", customer: undefined, label: "Chưa xác định" },
  ] as const)("keeps $attribution customer label $label when operational detail is unavailable", ({ attribution, customer, label }) => {
    order.customerAttribution = attribution; order.customer = customer; state.detailUnavailable = true;
    const dialog = open(surface("inclusive"));
    const current = Array.from(dialog.querySelectorAll("p")).find(node => node.textContent?.startsWith("Hiện tại:"));
    expect(current?.textContent).toBe(`Hiện tại: ${label}`);
    if (customer) {
      const heading = Array.from(dialog.querySelectorAll("span")).find(node => node.textContent === "Khách hàng");
      expect(heading?.parentElement?.textContent).toContain(label);
    }
  });
  it("does not hide a failed payment-review read as an empty queue", () => {
    state.reviewError = true;
    mounted = renderTestUi(<OrderHistoryScreen />);
    expect(mounted.container.textContent).toContain("Không tải được danh sách thanh toán cần kiểm tra");
  });
  it("shows the V5 full-cohort fee and sold quantity without using the legacy summary", () => {
    const detail = surface("inclusive");
    state.feeAware = true;
    state.page = EffectiveOrderPageV5Schema.parse({ schemaVersion: 5, creatorSelection: { mode: "all", creatorOperatorIds: [] },
      data: [{ sourceOrder: { merchantId: "m-a", storeId: "s-a", orderId: order.id, orderNumber: order.display_id, status: "completed" },
        customerAttribution: "walk_in", customer: null, createdAt: order.created_at,
        order: { schemaVersion: 2, componentVersion: 2, orderId: order.id, currencyCode: "VND", minorUnitExponent: 0, effectiveRevision: 0,
          commercialState: "active", lines: detail.effectiveItems.map(({ lineTotalMinor, ...line }) => line),
          components: detail.components, currentOrderGrossValueMinor: 1_100, dataQuality: detail.dataQuality },
        recordedGrossCollectionsMinor: 0, refundsMinor: 0, reversalsMinor: 0, chargebacksMinor: 0, negativeCollectionsMinor: 0, netCollectionsMinor: 0, customerRefundPayableMinor: 0 }],
      pagination: { limit: 20, hasMore: false, nextCursor: null, asOf: new Date().toISOString(), totalCount: 1 },
      currencies: [{ currencyCode: "VND", minorUnitExponent: 0, orderCount: 1, activeOrderCount: 1, cancelledOrderCount: 0,
        currentOrderGrossValueMinor: 1_100, effectiveItemQuantity: 2, recordedGrossCollectionsMinor: 0,
        refundsMinor: 0, reversalsMinor: 0, chargebacksMinor: 0, negativeCollectionsMinor: 0, netCollectionsMinor: 0,
        paymentFeeMinor: 100, paymentFeeVatMinor: 10, paymentFeeCustomerTotalMinor: 100 }] });
    mounted = renderTestUi(<OrderHistoryScreen />);
    const value = (label: string) => Array.from(mounted!.container.querySelectorAll("span")).find((node) => node.textContent === label)
      ?.parentElement?.parentElement?.querySelector("strong")?.textContent;
    expect(value("Phí thanh toán trên đơn (VND)")).toBe("100 VND");
    expect(value("Số sản phẩm đã bán")).toBe("2");
    expect(value("Giá trị đơn hiện tại (VND)")).toBe("1.100 VND");
  });
  it.each(["inclusive", "exclusive"] as const)("shows a separate fee with the correct %s VAT label", (mode) => {
    const dialog = open(surface(mode));
    const fee = Array.from(dialog.querySelectorAll("span")).find((node) => node.textContent === "Phí thanh toán");
    expect(fee?.parentElement?.textContent).toContain("100 VND");
    const vatLabel = mode === "exclusive" ? "VAT" : "VAT đã gồm";
    expect(Array.from(dialog.querySelectorAll("span")).some((node) => node.textContent === vatLabel)).toBe(true);
    expect(dialog.textContent).toContain("Item");
    expect(dialog.textContent).toContain(mode === "exclusive" ? "1.210 VND" : "1.100 VND");
  });
  it("keeps a legacy component snapshot free of a misleading zero surcharge row", () => {
    const dialog = open(surface("inclusive", 1));
    expect(dialog.textContent).not.toContain("Phí thanh toán");
  });
});
