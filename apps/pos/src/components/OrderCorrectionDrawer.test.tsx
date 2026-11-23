// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderTestUi, click, changeValue, buttonByText, type TestRender } from "../test/reactTestHarness";
import { ApiError } from "../api/client";
const state = vi.hoisted(() => ({ financial: true, context: vi.fn(), preview: vi.fn(), apply: vi.fn(), oldPreview: vi.fn(), oldApply: vi.fn(),
  operating: { operatorId: "manager", accessEpoch: "session-a", merchantId: "m-a", storeIds: ["s-a"], permissionIds: [], capabilityPartition: "old" } }));
vi.mock("../hooks/useProducts", () => ({ useProducts: () => ({ data: [] }), useClientOperatingScope: () => ({ operatingMerchantId: "m-a", operatingStoreId: "s-a" }) }));
vi.mock("../hooks/useAppAccessSnapshot", () => ({ useAppAccessSnapshot: () => ({ operatingSnapshot: state.operating }) }));
vi.mock("../hooks/useRuntimeCapabilities", () => ({ usePaymentFeeRuntimeBuild: () => state.financial ? {
  sourceCommit: "a".repeat(40), releaseId: "synthetic-drawer", paymentFeeCapabilities: { paymentFeeWrite: ["v1"] },
} : null }));
vi.mock("../api/client", async original => ({ ...await original<typeof import("../api/client")>(),
  getClientScopeSnapshot: () => ({ operatingMerchantId: state.operating.merchantId, operatingStoreId: state.operating.storeIds[0] }),
}));
vi.mock("../api/endpoints", async original => ({ ...await original<typeof import("../api/endpoints")>(),
  fetchOrderCorrectionFinancialContextV1: state.context, previewOrderCorrectionFinancialV1: state.preview,
  applyOrderCorrectionFinancialV1: state.apply, previewOrderCorrection: state.oldPreview, applyOrderCorrection: state.oldApply,
}));
import { OrderCorrectionDrawer } from "./OrderCorrectionDrawer";
const token = "a".repeat(64), scope = { merchantId: "m-a", storeId: "s-a" };
const snapshot = { schemaVersion: 1, calculationVersion: 2, currencyCode: "VND", minorUnitExponent: 0,
  paymentFee: { paymentFeeType: "percent", paymentFeeValue: 10, paymentFeeBasisMinor: 1200, vatRatePpm: 100000 },
  components: { taxMode: "inclusive", merchandiseGrossMinor: 1200, discountMinor: 0, merchandiseNetMinor: 1200, shippingMinor: 0,
    merchandiseVatMinor: 109, shippingVatMinor: 0, paymentFeeMinor: 120, paymentFeeVatMinor: 11, vatMinor: 120, unclassifiedMinor: 0, totalMinor: 1320 } };
const context = { schemaVersion: 1, contractVersion: "orders.payment-fee.v1", data: { ...scope, orderId: "o-a", baseRevision: 0, componentVersion: 2,
  currencyCode: "VND", minorUnitExponent: 0, commercialState: "active", components: snapshot.components, paymentFee: snapshot.paymentFee,
  items: [{ lineId: "line", variantId: "v-a", productId: "p-a", titleSnapshot: "Stored item", skuSnapshot: "SKU", quantity: 1, unitPriceMinor: 1200 }] } };
const after = { ...snapshot, paymentFee: { ...snapshot.paymentFee, paymentFeeValue: 20 },
  components: { ...snapshot.components, paymentFeeMinor: 240, paymentFeeVatMinor: 22, vatMinor: 131, totalMinor: 1440 } };
const preview = { schemaVersion: 1, contractVersion: "orders.payment-fee.v1", data: { ...scope, orderId: "o-a", baseRevision: 0, nextRevision: 1, confirmationToken: token,
  beforeTotals: { total: 1320 }, afterTotals: { total: 1440 }, totalDelta: 120, cogsDelta: 0,
  beforeFinancial: { status: "available", snapshot }, afterFinancial: { status: "available", snapshot: after },
  settlement: { direction: "collect", method: "cash", amount: 120, status: "posted" },
  items: [{ variantId: "v-a", productId: "p-a", productTitle: "Stored item", sku: "SKU", quantityBefore: 1, quantityAfter: 1, quantityDelta: 0, unitPrice: 1200, stockDelta: 0, availableStock: 5 }] } };
const order = { id: "o-a", display_id: "ORD-A", status: "completed", total: 9999, created_at: "2026-10-28T10:00:00Z", paymentMethod: "cash",
  items: [{ variantId: "v-a", productId: "p-a", name: "Cached item", quantity: 1, unitPrice: 9999, lineTotal: 9999 }] };
let mounted: TestRender | undefined, cache: QueryClient;
let close = vi.fn<() => void>();
const view = () => <QueryClientProvider client={cache}><OrderCorrectionDrawer open order={order} onClose={close} /></QueryClientProvider>;
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
function press(label: string) { click(buttonByText(mounted!.container, label)); }
function feeInput() { return mounted!.container.querySelector('input[aria-label="Phí thanh toán (%)"]') as HTMLInputElement; }
async function review() {
  changeValue(mounted!.container.querySelector("textarea")!, "Correct entered fee"); changeValue(feeInput(), "20"); press("Xem chênh lệch"); await flush();
}
beforeEach(() => {
  vi.clearAllMocks(); state.financial = true; state.operating = { operatorId: "manager", accessEpoch: "session-a", merchantId: "m-a", storeIds: ["s-a"], permissionIds: [], capabilityPartition: "old" };
  state.context.mockResolvedValue(context); state.preview.mockResolvedValue(preview); state.apply.mockResolvedValue({ data: { correction: { id: "correction" } } });
  state.oldPreview.mockResolvedValue({ data: { orderId: "o-a", baseRevision: 0, nextRevision: 1,
    beforeTotals: { total: 9999 }, afterTotals: { total: 9999 }, totalDelta: 0, cogsDelta: 0,
    settlement: { method: "none", status: "none", amount: 0, direction: "none" }, items: [] } });
  state.oldApply.mockResolvedValue({ data: { correction: { id: "old" } } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  close = vi.fn<() => void>(); cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { mounted?.unmount(); mounted = undefined; cache.clear(); vi.unstubAllGlobals(); });
describe("mounted fee-aware correction drawer", () => {
  it("locks edit controls until the stored context is verified", async () => {
    let resolve!: (value: unknown) => void; state.context.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    mounted = renderTestUi(view()); await flush();
    expect(mounted.container.querySelector("fieldset")?.disabled).toBe(true); expect(feeInput()).toBeNull();
    await act(async () => resolve(context)); await flush();
    expect(mounted.container.querySelector("fieldset")?.disabled).toBe(false); expect(feeInput().value).toBe("10");
  });
  it("does not drop an unmapped historical line when preparing a correction", async () => {
    state.context.mockResolvedValueOnce({ ...context, data: { ...context.data, items: [{ ...context.data.items[0], variantId: null }] } });
    mounted = renderTestUi(view()); await flush();
    expect(mounted.container.textContent).toContain("Dòng hàng thiếu mapping"); expect(mounted.container.querySelector("fieldset")?.disabled).toBe(true);
    expect(state.preview).not.toHaveBeenCalled(); expect(state.apply).not.toHaveBeenCalled();
  });
  it("seeds the stored fee/prices and confirms the reviewed fee with the exact scope/token/key", async () => {
    mounted = renderTestUi(view()); await flush();
    expect(feeInput().value).toBe("10"); expect(mounted.container.textContent).toContain("Stored item"); expect(mounted.container.textContent).not.toContain("9.999 ₫");
    expect(buttonByText(mounted.container, "Xác nhận điều chỉnh").disabled).toBe(true);
    await review(); expect(mounted.container.textContent).toContain("Phụ phí sau điều chỉnh"); expect(mounted.container.textContent).toContain("240 ₫");
    expect(buttonByText(mounted.container, "Xác nhận điều chỉnh").disabled).toBe(false);
    press("Xác nhận điều chỉnh"); await flush();
    expect(state.apply).toHaveBeenCalledWith("o-a", expect.objectContaining({ paymentFeeType: "percent", paymentFeeValue: 20, confirmationToken: token,
      items: [{ variantId: "v-a", quantity: 1 }], settlement: { method: "cash", amountReceived: 120 } }), expect.stringContaining("order-correction"), scope, preview);
    expect(close).toHaveBeenCalledOnce(); expect(state.oldApply).not.toHaveBeenCalled();
  });
  it("requires another preview after editing the reviewed fee", async () => {
    mounted = renderTestUi(view()); await flush(); await review(); changeValue(feeInput(), "25");
    expect(buttonByText(mounted.container, "Xác nhận điều chỉnh").disabled).toBe(true);
    expect(mounted.container.textContent).not.toContain("Phụ phí sau điều chỉnh"); press("Xác nhận điều chỉnh"); expect(state.apply).not.toHaveBeenCalled();
  });
  it("freezes body/key and locks editing after an uncertain apply response, then retries the same command", async () => {
    state.apply.mockRejectedValueOnce(new Error("Failed to fetch")); mounted = renderTestUi(view()); await flush(); await review();
    press("Xác nhận điều chỉnh"); await flush(); const first = state.apply.mock.calls[0];
    expect(mounted.container.querySelector("fieldset")?.disabled).toBe(true); expect(feeInput().disabled).toBe(true);
    expect(mounted.container.textContent).toContain("Chưa xác định được kết quả"); press("Xác nhận điều chỉnh"); await flush();
    expect(state.apply.mock.calls[1]).toEqual(first); expect(state.apply.mock.calls[1][1]).toBe(first[1]); expect(close).toHaveBeenCalledOnce();
  });
  it("unlocks a definitively rejected stale quote and requires a new review", async () => {
    state.apply.mockRejectedValueOnce(new ApiError("Quote changed", 409, "order_correction_quote_changed"));
    mounted = renderTestUi(view()); await flush(); await review(); press("Xác nhận điều chỉnh"); await flush();
    expect(feeInput().disabled).toBe(false); expect(buttonByText(mounted.container, "Xác nhận điều chỉnh").disabled).toBe(true); expect(close).not.toHaveBeenCalled();
    press("Xem chênh lệch"); await flush(); expect(state.preview).toHaveBeenCalledTimes(2);
  });
  it.each(["store", "actor"])("ignores an old preview after changing %s", async change => {
    let resolve!: (value: unknown) => void; state.preview.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    mounted = renderTestUi(view()); await flush(); await review(); state.context.mockRejectedValueOnce(new Error("Foreign order"));
    state.operating = change === "store" ? { ...state.operating, storeIds: ["s-b"] } : { ...state.operating, operatorId: "manager-b", accessEpoch: "session-b" };
    mounted.rerender(view()); await flush();
    await act(async () => resolve(preview)); await flush();
    expect(buttonByText(mounted.container, "Xác nhận điều chỉnh").disabled).toBe(true); expect(mounted.container.textContent).not.toContain("Phụ phí sau điều chỉnh"); expect(state.apply).not.toHaveBeenCalled();
  });
  it.each(["store", "actor"])("does not close a new %s scope when an old apply succeeds late", async change => {
    let resolve!: (value: unknown) => void; state.apply.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    mounted = renderTestUi(view()); await flush(); await review(); press("Xác nhận điều chỉnh"); await flush();
    state.context.mockRejectedValueOnce(new Error("Foreign order"));
    state.operating = change === "store" ? { ...state.operating, storeIds: ["s-b"] } : { ...state.operating, operatorId: "manager-b", accessEpoch: "session-b" };
    mounted.rerender(view()); await flush();
    await act(async () => resolve({ data: { correction: { id: "old-success" } } })); await flush(); expect(close).not.toHaveBeenCalled(); expect(state.apply).toHaveBeenCalledOnce();
  });
  it("keeps a V1 descriptor absent until the user explicitly edits fee controls", async () => {
    state.context.mockResolvedValueOnce({ ...context, data: { ...context.data, componentVersion: 1, paymentFee: null,
      components: { ...snapshot.components, paymentFeeMinor: 0, paymentFeeVatMinor: 0, vatMinor: 109, totalMinor: 1200 } } });
    state.preview.mockResolvedValueOnce({ ...preview, data: { ...preview.data, beforeFinancial: { status: "legacy" }, afterFinancial: { status: "legacy" },
      beforeTotals: { total: 1200 }, afterTotals: { total: 1200 }, totalDelta: 0, settlement: { method: "none", status: "none", amount: 0, direction: "none" } } });
    mounted = renderTestUi(view()); await flush(); changeValue(mounted.container.querySelector("textarea")!, "Correct entered quantity"); press("Xem chênh lệch"); await flush();
    expect(state.preview.mock.calls[0][1]).not.toHaveProperty("paymentFeeType"); press("Xác nhận điều chỉnh"); await flush();
    expect(state.apply.mock.calls[0][1]).not.toHaveProperty("paymentFeeType"); expect(state.apply.mock.calls[0][1]).not.toHaveProperty("paymentFeeValue");
  });
  it("keeps the old UI/transport when fee write is not advertised", async () => {
    state.financial = false; mounted = renderTestUi(view()); await flush();
    expect(feeInput()).toBeNull(); expect(state.context).not.toHaveBeenCalled();
    changeValue(mounted.container.querySelector("textarea")!, "Correct entered quantity"); press("Xem chênh lệch"); await flush(); press("Xác nhận điều chỉnh"); await flush();
    expect(state.oldPreview).toHaveBeenCalledOnce(); expect(state.oldApply).toHaveBeenCalledOnce(); expect(state.apply).not.toHaveBeenCalled();
  });
});
