// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("react-router-dom", () => ({ useLocation: () => ({ state: mocks.navigationState }) }));
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderTestUi, click, type TestRender } from "../test/reactTestHarness";
import type { CartCommercialAdjustment } from "../utils/cartTotals";

const mocks = vi.hoisted(() => ({ navigationState: null as Record<string, unknown> | null, feeEnabled: false, feeReady: true, feeToken: "a".repeat(64), refreshFee: vi.fn(),
  bootstrap: vi.fn(), sale: vi.fn(), shift: vi.fn(), payment: vi.fn(), intent: vi.fn(), poll: vi.fn(), enqueue: vi.fn(), updateQueue: vi.fn(),
  financialIntent: vi.fn(), financialPoll: vi.fn(), financialResolve: vi.fn(), preserveIntent: vi.fn(),
  listIntentCreations: vi.fn(), removeIntentCreation: vi.fn(), recoverIntent: vi.fn() }));
vi.mock("../utils/paymentIntentCreationRecovery", () => ({ preservePaymentIntentCreation: mocks.preserveIntent,
  listPendingPaymentIntentCreations: mocks.listIntentCreations, removePendingPaymentIntentCreation: mocks.removeIntentCreation }));
vi.mock("../components/PaymentIntentCreationRecoveryPanel", () => ({ PaymentIntentCreationRecoveryPanel: ({ onRecover }: { onRecover: (...args: unknown[]) => void }) => {
  mocks.recoverIntent.mockImplementation(onRecover); return null;
} }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ operator: { id: access.operatorId } }) }));
let access = { operatorId: "operator", accessEpoch: "epoch" };
const runtime = { selected: { checkoutWrite: "v1" }, surfaces: { checkoutWrite: "enabled", paymentWrite: "enabled" } };
let operatingAccess = { ...access, merchantId: "merchant", storeIds: ["A"] };
vi.mock("../hooks/useAppAccessSnapshot", () => ({ useAppAccessSnapshot: () => ({ snapshot: access, operatingSnapshot: operatingAccess, runtime }) }));
vi.mock("../hooks/useCheckoutPolicy", () => ({ useCheckoutPolicy: () => ({ status: "ready", mode: "confirm_on_booking", refreshPolicy: vi.fn(),
  foundStockEnabled: true, refreshFoundStockPolicy: async () => true }) }));
vi.mock("../hooks/useProductCategories", () => ({ useProductCategories: () => ({ data: { product_categories: [] } }) }));
vi.mock("../hooks/useCartPaymentFeePreview", async () => {
  const { CartPaymentFeePreviewInputV1Schema } = await import("@medusa-snus/contracts");
  return { useCartPaymentFeePreview: (input: unknown, enabled: boolean) => ({ compatible: mocks.feeEnabled,
    canConfirm: mocks.feeReady && enabled && input !== null, inputError: null, isError: false, refetch: mocks.refreshFee,
    data: input ? { data: { input: CartPaymentFeePreviewInputV1Schema.parse(input), confirmationToken: mocks.feeToken,
      financial: { components: { merchandiseGrossMinor: 1000, discountMinor: 0, shippingMinor: 0, totalMinor: 1320 } } } } : undefined }) };
});
vi.mock("../hooks/useProducts", async (original) => ({
  ...await original<typeof import("../hooks/useProducts")>(),
  useProducts: () => ({ data: [{ id: "product", title: "Product", variants: [{ id: "variant", title: "Variant", sku: "sku", prices: [{ amount: 1000 }], inventory_quantity: 10 }] }] }),
}));
vi.mock("../api/endpoints", async (original) => ({
  ...await original<typeof import("../api/endpoints")>(),
  fetchSyncBootstrap: mocks.bootstrap,
  fetchCurrentShift: mocks.shift,
  completeSale: mocks.sale,
  createPaymentIntent: mocks.intent,
  fetchPaymentIntent: mocks.poll,
  createPaymentIntentFinancialV1: mocks.financialIntent,
  fetchPaymentIntentFinancialV1: mocks.financialPoll,
  resolvePaymentIntentFinancialV1: mocks.financialResolve,
}));
vi.mock("../utils/offlineQueue", async (original) => ({
  ...await original<typeof import("../utils/offlineQueue")>(),
  queuedSaleSummary: async () => ({ queued: 0, needsReview: 0 }),
  listQueuedSales: async () => [],
  saveBootstrapSnapshot: async () => undefined,
  enqueueSale: mocks.enqueue,
  updateQueuedSale: mocks.updateQueue,
}));
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../components/ProductCard", () => ({ ProductCard: ({ onSelect, variantId }: { onSelect: (id: string) => void; variantId: string }) => <button onClick={() => onSelect(variantId)}>add product</button> }));
vi.mock("../components/CartPanel", () => ({ CartPanel: ({ onCheckout, items, saleError, adjustment, onAdjustmentChange }: { onCheckout: () => void; items: unknown[]; saleError?: string; adjustment: CartCommercialAdjustment; onAdjustmentChange: (value: CartCommercialAdjustment) => void }) => <>
  <button onClick={onCheckout}>checkout {items.length}</button><p>{saleError}</p>
  <output data-testid="adjustment">{JSON.stringify(adjustment)}</output><output data-testid="items">{JSON.stringify(items)}</output>
  <button onClick={() => onAdjustmentChange({ discountType: "percent", discountValue: 50, shippingFee: 100 })}>change adjustment</button>
  <button onClick={() => onAdjustmentChange({ ...adjustment, paymentFeeType: "percent", paymentFeeValue: 10 })}>fee 10</button>
</> }));
vi.mock("../components/PaymentModal", () => ({ PaymentModal: ({ onComplete, adjustment }: { onComplete: (...args: unknown[]) => unknown; adjustment: CartCommercialAdjustment }) => {
  mocks.payment.mockImplementation(onComplete);
  return <button onClick={() => void onComplete("cash", mocks.feeEnabled ? 2000 : 1000, mocks.feeEnabled ? adjustment : { discountType: "none", discountValue: 0, shippingFee: 0 }, "", "pos_counter", "walk_in")}>pay cash</button>;
} }));
vi.mock("../components/CustomerSearch", () => ({ CustomerSearch: () => null }));
vi.mock("../components/StaffScanDialog", () => ({ StaffScanDialog: () => null }));
vi.mock("../components/VisionScanDrawer", () => ({ VisionScanDrawer: () => null }));
vi.mock("../components/QuantityKeypad", () => ({ QuantityKeypad: () => null }));
vi.mock("../components/ReceiptModal", () => ({ ReceiptModal: () => null }));
vi.mock("../components/StockShortageWarningModal", () => ({ StockShortageWarningModal: ({ onConfirm, onBack }: { onConfirm: () => void; onBack: () => void }) => <div>
  stock warning<button onClick={onConfirm}>confirm found stock</button><button onClick={onBack}>back from stock</button>
</div> }));
vi.mock("../components/PaymentIntentDialog", () => ({ PaymentIntentDialog: ({ onCancel, onRenew, onMockSettle }: { onCancel: () => void; onRenew: () => void; onMockSettle: () => void }) => <div>
  pending intent<button onClick={onCancel}>cancel intent</button><button onClick={onRenew}>renew intent</button><button onClick={onMockSettle}>settle intent</button>
</div> }));
import PosScreen from "./PosScreen";
import { getClientScopeSnapshot, SCOPE_CHANGED_EVENT } from "../api/client";
import { ApiError } from "../api/client";

let mounted: TestRender | undefined;
let client: QueryClient;
function select(store: string) {
  if (operatingAccess.storeIds[0] !== store) operatingAccess = { ...operatingAccess, storeIds: [store] };
  sessionStorage.setItem("snus_operating_merchant_id", "merchant");
  sessionStorage.setItem("snus_operating_store_id", store);
  act(() => window.dispatchEvent(new Event(SCOPE_CHANGED_EVENT)));
}
function bootstrap(store: string) {
  return { data: { activeOperatingScope: { merchantId: "merchant", storeId: store, stockLocationId: `stock-${store}` }, products: [], customers: [], loyaltyTiers: [], accessibleMerchants: [{ id: "merchant" }], accessibleStores: [{ id: "A" }, { id: "B" }], generatedAt: "2026-09-08" } };
}
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
function press(label: string) {
  const button = [...mounted!.container.querySelectorAll("button")].find((element) => element.textContent?.includes(label));
  expect(button, label).toBeTruthy();
  click(button!);
}
beforeEach(() => {
  vi.clearAllMocks();
  access = { operatorId: "operator", accessEpoch: "epoch" };
  operatingAccess = { ...access, merchantId: "merchant", storeIds: ["A"] };
  mocks.navigationState = null;
  mocks.feeEnabled = false;
  mocks.feeReady = true;
  mocks.feeToken = "a".repeat(64); mocks.refreshFee.mockResolvedValue(undefined);
  mocks.preserveIntent.mockImplementation(async (request, scope) => ({ schemaVersion: 1, operatorId: scope.operatorId,
    merchantId: scope.merchantId, storeId: scope.storeId, idempotencyKey: request.idempotencyKey,
    requestHash: "a".repeat(64), provider: request.provider, createdAt: "2026-10-28T00:00:00.000Z" }));
  mocks.listIntentCreations.mockReturnValue([]); mocks.removeIntentCreation.mockReturnValue(undefined);
  sessionStorage.clear();
  select("A");
  mocks.enqueue.mockResolvedValue({ id: "queued" });
  mocks.updateQueue.mockResolvedValue(undefined);
  mocks.intent.mockResolvedValue({ data: { id: "intent-A", status: "pending" } });
  mocks.financialIntent.mockResolvedValue({ data: { id: "intent-fee", status: "pending", financial: { schemaVersion: 1 } } });
  mocks.shift.mockImplementation(async () => ({ data: { id: `shift-${getClientScopeSnapshot().operatingStoreId}`, openedAt: "2026-09-08" } }));
  mocks.sale.mockResolvedValue({ data: { orderId: "order", orderNumber: "1", total: 1000, subtotal: 1000, change: 0, paymentMethod: "cash", items: [], createdAt: "2026-09-08" } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { mounted?.unmount(); mounted = undefined; client.clear(); });
function mount() { mounted = renderTestUi(<QueryClientProvider client={client}><PosScreen /></QueryClientProvider>); }

describe("mounted POS operating scope", () => {
  it.each(["cash", "sepay_va"])("blocks a replacement %s checkout while another saved creation has not been reconciled", async method => {
    mocks.feeEnabled = true; mocks.listIntentCreations.mockReturnValue([{ operatorId: "operator", merchantId: "merchant", storeId: "A", idempotencyKey: "saved-unknown" }]);
    mocks.bootstrap.mockResolvedValue(bootstrap("A")); mount(); await flush(); await flush(); press("add product"); press("checkout 1");
    await act(async () => { await mocks.payment(method, 2000, { discountType: "percent", discountValue: 0, shippingFee: 0, paymentFeeType: "percent", paymentFeeValue: 0 }, "", "pos_counter", "walk_in"); });
    expect(mocks.sale).not.toHaveBeenCalled(); expect(mocks.financialIntent).not.toHaveBeenCalled(); expect(mocks.intent).not.toHaveBeenCalled();
    expect(mounted!.container.textContent).toContain("Còn yêu cầu thanh toán đã lưu cần kiểm tra");
  });
  it("opens a recovered intent only after explicit cart review without recreating or renewing its unavailable original body", async () => {
    mocks.feeEnabled = true; mocks.bootstrap.mockResolvedValue(bootstrap("A")); mount(); await flush(); await flush(); press("add product");
    const record = { schemaVersion: 1, operatorId: "operator", merchantId: "merchant", storeId: "A", idempotencyKey: "saved-request", requestHash: "a".repeat(64) };
    const intent = { id: "recovered", merchantId: "merchant", storeId: "A", provider: "sepay_va", status: "cancelled", financial: { schemaVersion: 1 } };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => { mocks.recoverIntent(record, intent); });
    expect(mounted!.container.textContent).not.toContain("pending intent");
    expect(JSON.parse(mounted!.container.querySelector('[data-testid="items"]')!.textContent!)).toHaveLength(1);
    confirm.mockReturnValue(true);
    await act(async () => { mocks.recoverIntent(record, intent); }); await flush();
    expect(mounted!.container.textContent).toContain("pending intent");
    expect(JSON.parse(mounted!.container.querySelector('[data-testid="items"]')!.textContent!)).toEqual([]);
    press("renew intent"); await flush();
    expect(mocks.financialIntent).not.toHaveBeenCalled(); expect(mocks.sale).not.toHaveBeenCalled(); expect(mocks.intent).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
  it("persists original QR correlation before dispatch and preserves the exact wire body/key across a storage failure", async () => {
    mocks.feeEnabled = true; mocks.preserveIntent.mockRejectedValueOnce(new Error("Correlation storage unavailable"));
    mocks.bootstrap.mockResolvedValue(bootstrap("A")); mount(); await flush(); await flush(); press("add product"); press("fee 10"); press("checkout 1");
    const adjustment = { discountType: "percent", discountValue: 0, shippingFee: 0, paymentFeeType: "percent", paymentFeeValue: 10 };
    await act(async () => { await mocks.payment("sepay_va", 2000, adjustment, "", "pos_counter", "walk_in"); });
    expect(mocks.financialIntent).not.toHaveBeenCalled(); expect(mocks.intent).not.toHaveBeenCalled();
    expect(mounted!.container.textContent).toContain("Correlation storage unavailable");
    const original = JSON.stringify(mocks.preserveIntent.mock.calls[0]![0]);
    await act(async () => { await mocks.payment("sepay_va", 2000, adjustment, "", "pos_counter", "walk_in"); });
    expect(mocks.preserveIntent).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.preserveIntent.mock.calls[1]![0])).toBe(original);
    expect(JSON.stringify(mocks.financialIntent.mock.calls[0]![0])).toBe(original);
    expect(mocks.preserveIntent.mock.calls[0]![1]).toMatchObject({ operatorId: "operator", merchantId: "merchant", storeId: "A" });
  });
  it("never dispatches an old QR after its durable-save wait crosses a store change", async () => {
    mocks.feeEnabled = true; mocks.bootstrap.mockImplementation(async () => bootstrap(getClientScopeSnapshot().operatingStoreId));
    let saved!: () => void; mocks.preserveIntent.mockReturnValueOnce(new Promise<void>(resolve => { saved = resolve; }));
    mount(); await flush(); await flush(); press("add product"); press("checkout 1");
    let payment!: Promise<unknown>;
    await act(async () => { payment = mocks.payment("sepay_va", 2000, { discountType: "percent", discountValue: 0, shippingFee: 0, paymentFeeType: "percent", paymentFeeValue: 0 }, "", "pos_counter", "walk_in"); });
    expect(mocks.preserveIntent).toHaveBeenCalledOnce(); expect(mocks.financialIntent).not.toHaveBeenCalled();
    select("B"); await flush(); await flush(); press("add product");
    await act(async () => { saved(); await payment; });
    expect(mocks.financialIntent).not.toHaveBeenCalled();
    expect(JSON.parse(mounted!.container.querySelector('[data-testid="items"]')!.textContent!)).toHaveLength(1);
  });
  it("does not replace a newer actor's recovery receipt when an old durable-save wait finishes late", async () => {
    mocks.feeEnabled = true; mocks.bootstrap.mockResolvedValue(bootstrap("A"));
    let saved!: (value: unknown) => void; mocks.preserveIntent.mockReturnValueOnce(new Promise(resolve => { saved = resolve; }));
    mount(); await flush(); await flush(); press("add product"); press("checkout 1");
    let oldPayment!: Promise<unknown>;
    const adjustment = { discountType: "percent", discountValue: 0, shippingFee: 0, paymentFeeType: "percent", paymentFeeValue: 0 };
    await act(async () => { oldPayment = mocks.payment("sepay_va", 2000, adjustment, "", "pos_counter", "walk_in"); });
    const oldRequest = mocks.preserveIntent.mock.calls[0]![0];
    access = { operatorId: "other-operator", accessEpoch: "other-epoch" }; operatingAccess = { ...operatingAccess, ...access };
    mounted!.rerender(<QueryClientProvider client={client}><PosScreen /></QueryClientProvider>); await flush(); await flush();
    press("add product"); press("checkout 1");
    mocks.financialIntent.mockResolvedValueOnce({ data: { id: "new-actor-intent", status: "cancelled", financial: { schemaVersion: 1 } } });
    await act(async () => { await mocks.payment("sepay_va", 2000, adjustment, "", "pos_counter", "walk_in"); });
    const newRequest = mocks.preserveIntent.mock.calls[1]![0];
    await act(async () => { saved({ schemaVersion: 1, operatorId: "operator", merchantId: "merchant", storeId: "A",
      idempotencyKey: oldRequest.idempotencyKey, requestHash: "b".repeat(64), provider: "sepay_va", createdAt: "2026-10-28T00:00:00.000Z" }); await oldPayment; });
    press("renew intent"); await flush();
    expect(mocks.removeIntentCreation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      operatorId: "other-operator", idempotencyKey: newRequest.idempotencyKey }));
    expect(mocks.financialIntent).toHaveBeenCalledTimes(2);
  });
  it("keeps a new A checkout in flight when the old A response arrives after A to B to A", async () => {
    mocks.feeEnabled = true;
    mocks.bootstrap.mockImplementation(async () => bootstrap(getClientScopeSnapshot().operatingStoreId));
    let finishOld!: (value: unknown) => void, finishNew!: (value: unknown) => void;
    mocks.sale.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
    const receipt = { data: { orderId: "old", orderNumber: "1", total: 1320, subtotal: 1200, change: 680,
      paymentMethod: "cash", items: [], createdAt: "2026-10-28" } };
    mount(); await flush(); await flush(); press("add product"); press("checkout 1"); press("pay cash"); await flush();
    select("B"); await flush(); await flush(); select("A"); await flush(); await flush();
    press("add product"); press("checkout 1"); press("pay cash"); await flush();
    expect(mocks.sale).toHaveBeenCalledTimes(2);
    await act(async () => { finishOld(receipt); }); await flush();
    await act(async () => { void mocks.payment("cash", 2000, { discountType: "percent", discountValue: 0, shippingFee: 0 }, "", "pos_counter", "walk_in"); }); await flush();
    try { expect(mocks.sale).toHaveBeenCalledTimes(2); }
    finally { await act(async () => { finishNew({ data: { ...receipt.data, orderId: "new" } }); }); await flush(); }
  });
  it.each(["operator", "epoch"])("hides a pending intent and clears the old cart when %s changes inside the same store", async change => {
    mocks.feeEnabled = true; mocks.bootstrap.mockResolvedValue(bootstrap("A")); mount(); await flush(); await flush();
    press("add product"); press("fee 10"); press("checkout 1");
    await act(async () => { await mocks.payment("sepay_va", 2000, { discountType: "percent", discountValue: 0, shippingFee: 0, paymentFeeType: "percent", paymentFeeValue: 10 }, "", "pos_counter", "walk_in"); });
    expect(mounted!.container.textContent).toContain("pending intent");
    access = { operatorId: change === "operator" ? "other-operator" : "operator", accessEpoch: "other-epoch" };
    operatingAccess = { ...operatingAccess, ...access };
    mounted!.rerender(<QueryClientProvider client={client}><PosScreen /></QueryClientProvider>); await flush();
    expect(mounted!.container.textContent).not.toContain("pending intent");
    expect(JSON.parse(mounted!.container.querySelector('[data-testid="items"]')!.textContent!)).toEqual([]);
    expect(mocks.financialResolve).not.toHaveBeenCalled();
  });
  it.each(["completed", "failed"])("ignores a late %s payment response from the previous actor without changing the new actor's cart/error", async outcome => {
    mocks.feeEnabled = true; mocks.bootstrap.mockResolvedValue(bootstrap("A")); mount(); await flush(); await flush();
    press("add product"); press("checkout 1");
    await act(async () => { await mocks.payment("sepay_va", 2000, { discountType: "percent", discountValue: 0, shippingFee: 0, paymentFeeType: "percent", paymentFeeValue: 0 }, "", "pos_counter", "walk_in"); });
    let settle!: (value: unknown) => void, fail!: (error: Error) => void;
    mocks.financialResolve.mockReturnValueOnce(new Promise((resolve, reject) => { settle = resolve; fail = reject; }));
    press("settle intent"); await flush();
    access = { operatorId: "other-operator", accessEpoch: "other-epoch" }; operatingAccess = { ...operatingAccess, ...access };
    mounted!.rerender(<QueryClientProvider client={client}><PosScreen /></QueryClientProvider>); await flush(); await flush(); press("add product");
    await act(async () => {
      if (outcome === "failed") fail(new Error("old-actor-payment-error"));
      else settle({ data: { id: "intent-fee", status: "completed", financial: { schemaVersion: 1 } }, order: { orderId: "old-order" } });
    }); await flush();
    expect(JSON.parse(mounted!.container.querySelector('[data-testid="items"]')!.textContent!)).toHaveLength(1);
    expect(mounted!.container.textContent).not.toContain("pending intent");
    expect(mounted!.container.textContent).not.toContain("old-actor-payment-error");
  });
  const shortage = () => new ApiError("Stock shortage", 409, "stock_shortage_requires_confirmation", {
    shortages: [{ variantId: "variant", productName: "Product", systemStock: 0, requestedQuantity: 1, shortageQuantity: 1 }],
  });
  it.each(["store", "operator"])("preserves an uncertain found-stock acknowledgment in its original review queue after a %s change", async change => {
    mocks.feeEnabled = true; mocks.bootstrap.mockImplementation(async () => bootstrap(getClientScopeSnapshot().operatingStoreId));
    let fail!: (error: Error) => void;
    mocks.sale.mockRejectedValueOnce(shortage()).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    mount(); await flush(); await flush(); press("add product"); press("fee 10"); press("checkout 1"); press("pay cash"); await flush();
    press("confirm found stock"); await flush(); const confirmed = JSON.stringify(mocks.sale.mock.calls[1]![0]);
    if (change === "store") select("B");
    else {
      access = { operatorId: "other-operator", accessEpoch: "other-epoch" }; operatingAccess = { ...operatingAccess, ...access };
      mounted!.rerender(<QueryClientProvider client={client}><PosScreen /></QueryClientProvider>);
    }
    await flush(); await flush(); press("add product");
    await act(async () => { fail(new TypeError("Failed to fetch")); }); await flush();
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.enqueue.mock.calls[0]![0])).toBe(confirmed);
    expect(mocks.enqueue.mock.calls[0]![1]).toMatchObject({ operatorId: "operator", accessEpoch: "epoch", merchantId: "merchant", storeId: "A" });
    expect(mocks.enqueue.mock.calls[0]![0].foundStockConfirmation).toMatchObject({ confirmed: true });
    expect(mocks.updateQueue).toHaveBeenCalledWith("queued", expect.objectContaining({ status: "needs_review" }));
    expect(JSON.parse(mounted!.container.querySelector('[data-testid="items"]')!.textContent!)).toHaveLength(1);
  });
  it("allows a fresh confirmed cart after a definitive initial stock refusal", async () => {
    mocks.feeEnabled = true; mocks.sale.mockRejectedValueOnce(shortage());
    mocks.bootstrap.mockResolvedValue(bootstrap("A")); mount(); await flush(); await flush();
    press("add product"); press("checkout 1"); press("pay cash"); await flush();
    const first = mocks.sale.mock.calls[0]![0];
    press("back from stock"); press("fee 10"); press("checkout 1"); press("pay cash"); await flush();
    expect(mocks.sale).toHaveBeenCalledTimes(2);
    expect(mocks.sale.mock.calls[1]![0]).toMatchObject({ paymentFeeValue: 10 });
    expect(mocks.sale.mock.calls[1]![0].idempotencyKey).not.toBe(first.idempotencyKey);
  });
  it("keeps the exact found-stock acknowledgment/key after a lost response instead of abandoning the attempt", async () => {
    mocks.feeEnabled = true; mocks.sale.mockRejectedValueOnce(shortage()).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mocks.bootstrap.mockResolvedValue(bootstrap("A")); mount(); await flush(); await flush();
    press("add product"); press("checkout 1"); press("pay cash"); await flush();
    press("confirm found stock"); await flush(); const confirmed = JSON.stringify(mocks.sale.mock.calls[1]![0]);
    press("back from stock"); await flush();
    expect(mounted!.container.textContent).toContain("stock warning");
    press("confirm found stock"); await flush();
    expect(mocks.sale).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(mocks.sale.mock.calls[2]![0])).toBe(confirmed);
    expect(mocks.sale.mock.calls[2]![0].foundStockConfirmation).toMatchObject({ confirmed: true });
  });
  it.each([0, 10])("sends an explicit fee descriptor and captured scope, fee=%s, then resets adjustments", async fee => {
    mocks.feeEnabled = true; mocks.bootstrap.mockResolvedValue(bootstrap("A")); mount(); await flush(); await flush();
    press("add product"); if (fee) press("fee 10"); press("checkout 1"); press("pay cash"); await flush();
    expect(mocks.sale).toHaveBeenCalledWith(expect.objectContaining({ paymentFeeType: "percent", paymentFeeValue: fee,
      amountReceived: 2000, discountType: "percent", discountValue: 0, shippingFee: 0, cartConfirmationToken: "a".repeat(64) }), expect.objectContaining({ merchantId: "merchant", storeId: "A" }));
    expect(mounted!.container.querySelector('[data-testid="adjustment"]')?.textContent).toBe('{"discountType":"percent","discountValue":0,"shippingFee":0}');
    expect(mocks.intent).not.toHaveBeenCalled(); expect(mocks.financialIntent).not.toHaveBeenCalled();
  });
  it("uses the server payable in mobile cart summaries and hides it while preview is pending", async () => {
    mocks.feeEnabled = true; mocks.bootstrap.mockResolvedValue(bootstrap("A")); mount(); await flush(); await flush(); press("add product"); press("fee 10");
    expect(mounted!.container.textContent).toContain("1.320 ₫");
    expect(mounted!.container.textContent).not.toContain("1.000 ₫");
    mocks.feeReady = false; mounted!.rerender(<QueryClientProvider client={client}><PosScreen /></QueryClientProvider>);
    expect(mounted!.container.textContent).not.toContain("1.320 ₫"); expect(mounted!.container.textContent).toContain("—");
    expect([...mounted!.container.querySelectorAll("button")].find(button => button.textContent === "pos.checkout")?.disabled).toBe(true);
  });
  it("does not dispatch a fee checkout before the current server preview is ready", async () => {
    mocks.feeEnabled = true; mocks.bootstrap.mockResolvedValue(bootstrap("A")); mount(); await flush(); await flush();
    press("add product"); press("fee 10"); press("checkout 1");
    mocks.feeReady = false; mounted!.rerender(<QueryClientProvider client={client}><PosScreen /></QueryClientProvider>);
    press("pay cash"); await flush();
    expect(mocks.sale).not.toHaveBeenCalled(); expect(mocks.financialIntent).not.toHaveBeenCalled();
    expect(mounted!.container.textContent).toContain("Đợi bản tính mới");
  });
  it("uses the financial intent transport and blocks cart checkout until the intent resolves", async () => {
    mocks.feeEnabled = true; mocks.bootstrap.mockResolvedValue(bootstrap("A")); mount(); await flush(); await flush();
    press("add product"); press("fee 10"); press("checkout 1");
    await act(async () => { await mocks.payment("sepay_va", 2000, { discountType: "percent", discountValue: 0, shippingFee: 0, paymentFeeType: "percent", paymentFeeValue: 10 }, "", "pos_counter", "walk_in"); });
    expect(mocks.financialIntent).toHaveBeenCalledWith(expect.objectContaining({ provider: "sepay_va", order: expect.objectContaining({ paymentFeeValue: 10 }) }), expect.objectContaining({ merchantId: "merchant", storeId: "A" }));
    expect(mocks.intent).not.toHaveBeenCalled(); expect(mounted!.container.textContent).toContain("pending intent");
    press("pay cash"); await flush(); expect(mocks.sale).not.toHaveBeenCalled();
  });
  it("refuses to rebuild an uncertain intent with changed confirmation data and retries the original body/key", async () => {
    mocks.feeEnabled = true; mocks.financialIntent.mockRejectedValueOnce(new Error("Failed to fetch"));
    mocks.bootstrap.mockResolvedValue(bootstrap("A")); mount(); await flush(); await flush(); press("add product"); press("fee 10"); press("checkout 1");
    const adjustment = { discountType: "percent", discountValue: 0, shippingFee: 0, paymentFeeType: "percent", paymentFeeValue: 10 };
    await act(async () => { await mocks.payment("sepay_va", 2000, adjustment, "first", "pos_counter", "walk_in"); });
    const original = mocks.financialIntent.mock.calls[0]![0];
    mocks.feeToken = "b".repeat(64); mounted!.rerender(<QueryClientProvider client={client}><PosScreen /></QueryClientProvider>);
    await act(async () => { await mocks.payment("sepay_va", 2000, adjustment, "changed", "pos_counter", "walk_in"); });
    expect(mocks.financialIntent).toHaveBeenCalledTimes(1);
    expect(mounted!.container.textContent).toContain("chưa xác định kết quả");
    await act(async () => { await mocks.payment("sepay_va", 2000, adjustment, "first", "pos_counter", "walk_in"); });
    expect(mocks.financialIntent).toHaveBeenCalledTimes(2);
    expect(mocks.financialIntent.mock.calls[1]![0]).toEqual(original);
    expect(mocks.financialIntent.mock.calls[1]![0].order).toBe(original.order);
    expect(mocks.financialIntent.mock.calls[1]![0].order.cartConfirmationToken).toBe("a".repeat(64));
  });
  it.each(["cash", "sepay_va"])("refreshes a definitively changed %s quote without automatically submitting another transaction", async method => {
    mocks.feeEnabled = true; mocks.bootstrap.mockResolvedValue(bootstrap("A"));
    const transport = method === "cash" ? mocks.sale : mocks.financialIntent;
    transport.mockRejectedValueOnce(new ApiError("Cart changed", 409, "cart_quote_changed"));
    mocks.refreshFee.mockImplementationOnce(async () => { mocks.feeToken = "b".repeat(64); });
    mount(); await flush(); await flush(); press("add product"); press("fee 10"); press("checkout 1");
    const adjustment = { discountType: "percent", discountValue: 0, shippingFee: 0, paymentFeeType: "percent", paymentFeeValue: 10 };
    await act(async () => { await mocks.payment(method, 2000, adjustment, "", "pos_counter", "walk_in"); });
    expect(transport).toHaveBeenCalledTimes(1); expect(mocks.refreshFee).toHaveBeenCalledOnce();
    const first = transport.mock.calls[0]![0];
    expect(mounted!.container.textContent).toContain("xác nhận lại");
    await act(async () => { await mocks.payment(method, 2000, adjustment, "", "pos_counter", "walk_in"); });
    const second = transport.mock.calls[1]![0];
    expect(method === "cash" ? first.cartConfirmationToken : first.order.cartConfirmationToken).toBe("a".repeat(64));
    expect(method === "cash" ? second.cartConfirmationToken : second.order.cartConfirmationToken).toBe("b".repeat(64));
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });
  it("keeps cancel and renew keys stable after uncertain responses and renews the frozen order", async () => {
    mocks.feeEnabled = true; mocks.bootstrap.mockResolvedValue(bootstrap("A")); mount(); await flush(); await flush();
    press("add product"); press("fee 10"); press("checkout 1");
    await act(async () => { await mocks.payment("sepay_va", 2000, { discountType: "percent", discountValue: 0, shippingFee: 0, paymentFeeType: "percent", paymentFeeValue: 10 }, "", "pos_counter", "walk_in"); });
    const originalOrder = mocks.financialIntent.mock.calls[0]![0].order;
    mocks.financialResolve.mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce({ data: { id: "intent-fee", status: "cancelled", financial: { schemaVersion: 1 } } });
    press("cancel intent"); await flush(); press("cancel intent"); await flush();
    expect(mocks.financialResolve).toHaveBeenCalledTimes(2);
    expect(mocks.financialResolve.mock.calls[1]).toEqual(mocks.financialResolve.mock.calls[0]);
    expect(mocks.financialResolve.mock.calls[0]).toEqual(["intent-fee", "cancel", expect.any(String), expect.objectContaining({ merchantId: "merchant", storeId: "A" })]);
    mocks.financialIntent.mockRejectedValueOnce(new Error("Failed to fetch"));
    press("renew intent"); await flush(); const request = mocks.financialIntent.mock.calls[1]![0];
    press("renew intent"); await flush();
    expect(mocks.financialIntent).toHaveBeenCalledTimes(3);
    expect(mocks.financialIntent.mock.calls[2]![0]).toEqual(request);
    expect(request.order).toBe(originalOrder);
    expect(mocks.intent).not.toHaveBeenCalled();
  });
  it.each([false, true])("starts a recreated cart with current prices and resets existing adjustments, fee=%s", async feeEnabled => {
    mocks.feeEnabled = feeEnabled;
    mocks.bootstrap.mockResolvedValue(bootstrap("A")); mount(); await flush(); await flush();
    press("change adjustment");
    if (feeEnabled) press("fee 10");
    expect(mounted!.container.querySelector('[data-testid="adjustment"]')?.textContent).toContain('"discountValue":50');
    mocks.navigationState = { prefillCart: { sourceOrderId: "old", sourceOrderNumber: "OLD", sourceScope: { merchantId: "merchant", storeId: "A" },
      discountMinor: 500, shippingMinor: 100, paymentFeeMinor: 999,
      items: [{ variantId: "variant", productId: "product", productName: "Current product", sku: "SKU", quantity: 1, unitPrice: 1200, stockLevel: 5 }] } };
    mounted!.rerender(<QueryClientProvider client={client}><PosScreen /></QueryClientProvider>); await flush();
    expect(mounted!.container.querySelector('[data-testid="adjustment"]')?.textContent).toBe('{"discountType":"percent","discountValue":0,"shippingFee":0}');
    expect(mounted!.container.querySelector('[data-testid="items"]')?.textContent).toContain('"unitPrice":1200');
    expect(mounted!.container.querySelector('[data-testid="items"]')?.textContent).not.toMatch(/paymentFee|discountMinor|shippingMinor/);
    expect(mounted!.container.textContent).toContain("checkout 1");
  });
  it.each([{ merchantId: "foreign", storeId: "A" }, { merchantId: "merchant", storeId: "B" }])("refuses recreate navigation from another scope: %j", async sourceScope => {
    mocks.bootstrap.mockResolvedValue(bootstrap("A"));
    mocks.navigationState = { prefillCart: { sourceOrderId: "old", sourceOrderNumber: "OLD", sourceScope,
      items: [{ variantId: "foreign-variant", productId: "foreign-product", productName: "Foreign product", sku: "F", quantity: 1, unitPrice: 9000, stockLevel: 10 }] } };
    mount(); await flush(); await flush();
    expect(mounted!.container.textContent).toContain("Đã đổi cửa hàng. Hãy mở lại đơn gốc để tạo giỏ hàng mới.");
    expect(mounted!.container.textContent).toContain("checkout 0");
    expect(mocks.sale).not.toHaveBeenCalled();
  });
  it("resolves A to B once, clears A cart, fails closed during B bootstrap, and checks out with B shift and scope", async () => {
    let resolveB!: (value: ReturnType<typeof bootstrap>) => void;
    mocks.bootstrap.mockResolvedValueOnce(bootstrap("A")).mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
    mount(); await flush(); await flush();
    press("add product"); press("checkout 1");
    expect(mounted!.container.textContent).toContain("pay cash");
    select("B"); await flush();
    expect(mounted!.container.textContent).not.toContain("pay cash");
    expect(mounted!.container.textContent).toContain("checkout 0");
    press("add product"); press("checkout 1");
    expect(mounted!.container.textContent).not.toContain("pay cash");
    expect(mocks.sale).not.toHaveBeenCalled();
    await act(async () => resolveB(bootstrap("B"))); await flush();
    press("checkout 1"); press("pay cash"); await flush();
    expect(mocks.sale).toHaveBeenCalledWith(expect.objectContaining({ shiftId: "shift-B" }), expect.objectContaining({ merchantId: "merchant", storeId: "B" }));
    sessionStorage.setItem("snus_report_store_ids", '["A"]');
    for (let index = 0; index < 5; index++) select("B");
    await flush();
    expect(mocks.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("ignores late A bootstrap after B resolves and never restores A checkout scope", async () => {
    let resolveA!: (value: ReturnType<typeof bootstrap>) => void;
    mocks.bootstrap.mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; })).mockResolvedValueOnce(bootstrap("B"));
    mount(); select("B"); await flush(); await flush();
    await act(async () => resolveA(bootstrap("A"))); await flush();
    press("add product"); press("checkout 1"); press("pay cash"); await flush();
    expect(mocks.sale).toHaveBeenCalledWith(expect.objectContaining({ shiftId: "shift-B" }), expect.objectContaining({ merchantId: "merchant", storeId: "B" }));
    expect(mocks.bootstrap).toHaveBeenCalledTimes(2);
  });
  it("keeps an A pending intent blocked and hidden in B, then resumes its original scope", async () => {
    mocks.bootstrap.mockImplementation(async () => bootstrap(getClientScopeSnapshot().operatingStoreId));
    mount(); await flush(); await flush();
    press("add product"); press("checkout 1");
    await act(async () => { await mocks.payment("sepay_va", 1000, { discountType: "none", discountValue: 0, shippingFee: 0 }, "", "in_store", "walk_in"); });
    expect(mounted!.container.textContent).toContain("pending intent");
    select("B"); await flush(); await flush();
    expect(mounted!.container.textContent).not.toContain("pending intent");
    press("add product"); press("checkout 1");
    expect(mounted!.container.textContent).not.toContain("pay cash");
    expect(mocks.sale).not.toHaveBeenCalled();
    expect(mocks.poll).not.toHaveBeenCalled();
    select("A"); await flush();
    expect(mounted!.container.textContent).toContain("pending intent");
    expect(mocks.intent).toHaveBeenCalledTimes(1);
  });

  it("preserves uncertain A dispatch in the A review queue without clearing the new B cart", async () => {
    mocks.bootstrap.mockImplementation(async () => bootstrap(getClientScopeSnapshot().operatingStoreId));
    let rejectSale!: (reason: Error) => void;
    mocks.sale.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSale = reject; }));
    mount(); await flush(); await flush();
    press("add product"); press("checkout 1"); press("pay cash");
    select("B"); await flush(); await flush(); press("add product");
    await act(async () => rejectSale(new Error("Failed to fetch"))); await flush();
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ shiftId: "shift-A" }), expect.objectContaining({ merchantId: "merchant", storeId: "A" }));
    expect(mocks.updateQueue).toHaveBeenCalledWith("queued", expect.objectContaining({ status: "needs_review" }));
    expect(mounted!.container.textContent).toContain("checkout 1");
  });

});
