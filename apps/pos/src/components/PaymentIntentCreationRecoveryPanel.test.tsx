// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonByText, click, renderTestUi, type TestRender } from "../test/reactTestHarness";
const mocks = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn(), fetch: vi.fn(), close: vi.fn(), recover: vi.fn() }));
vi.mock("../utils/paymentIntentCreationRecovery", () => ({ listPendingPaymentIntentCreations: mocks.list,
  removePendingPaymentIntentCreation: mocks.remove, PAYMENT_INTENT_CREATION_RECOVERY_CHANGED: "recovery-changed" }));
vi.mock("../api/endpoints", () => ({ fetchPaymentIntentCreationReceiptV1: mocks.fetch, closePaymentIntentCreationReceiptV1: mocks.close }));
import { PaymentIntentCreationRecoveryPanel } from "./PaymentIntentCreationRecoveryPanel";
import { paymentIntentCreationKeyPrefixV1 } from "@medusa-snus/contracts";
const scope = { operatorId: "operator-a", merchantId: "merchant-a", storeId: "store-a", accessEpoch: "epoch-a" };
const record = { schemaVersion: 1 as const, operatorId: scope.operatorId, merchantId: scope.merchantId, storeId: scope.storeId,
  idempotencyKey: paymentIntentCreationKeyPrefixV1(scope.operatorId, scope.storeId) + "private-original-key", requestHash: "a".repeat(64),
  provider: "sepay_va" as const, createdAt: "2026-10-28T00:00:00.000Z" };
const intent = { id: "intent-a", merchantId: scope.merchantId, storeId: scope.storeId, provider: "sepay_va", status: "pending",
  amount: 1320, currencyCode: "vnd", referenceCode: "A-PAYMENT-REFERENCE", financial: { status: "available" } };
const receipt = { schemaVersion: 1, contractVersion: "orders.payment-fee.v1", requestHash: record.requestHash, data: { status: "resolved", intent } };
let mounted: TestRender | undefined;
const view = (selected = scope, activeRequestKey?: string, canClose = true) => <PaymentIntentCreationRecoveryPanel scope={selected} activeRequestKey={activeRequestKey} canClose={canClose} onRecover={mocks.recover} />;
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
beforeEach(() => {
  vi.clearAllMocks(); mocks.list.mockReturnValue([record]); mocks.fetch.mockResolvedValue(receipt);
  mocks.close.mockResolvedValue({ ...receipt, data: { status: "closed" } });
  mocks.remove.mockImplementation(() => { mocks.list.mockReturnValue([]); window.dispatchEvent(new Event("recovery-changed")); });
});
afterEach(() => { mounted?.unmount(); mounted = undefined; vi.restoreAllMocks(); });
describe("private saved payment recovery panel", () => {
  it("does not create or inspect automatically, hides raw correlation values, and opens only after explicit owned receipt review", async () => {
    mounted = renderTestUi(view());
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mounted.container.textContent).not.toContain(record.idempotencyKey);
    expect(mounted.container.textContent).not.toContain(record.requestHash);
    click(buttonByText(mounted.container, "Kiểm tra kết quả")); await flush();
    expect(mocks.fetch).toHaveBeenCalledWith(record.requestHash, record.idempotencyKey, scope, expect.any(AbortSignal));
    expect(mocks.recover).not.toHaveBeenCalled();
    click(buttonByText(mounted.container, "Xem thanh toán đã ghi nhận"));
    expect(mocks.recover).toHaveBeenCalledExactlyOnceWith(record, intent);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("keeps an unresolved outcome and original key without silently dropping it or creating a replacement", async () => {
    mocks.fetch.mockResolvedValue({ ...receipt, data: { status: "unresolved" } }); mounted = renderTestUi(view());
    click(buttonByText(mounted.container, "Kiểm tra kết quả")); await flush();
    expect(mounted.container.textContent).toContain("Chưa xác định được kết quả");
    expect(mounted.container.textContent).not.toContain("Đã kiểm tra kết quả");
    expect(mocks.remove).not.toHaveBeenCalled(); expect(mocks.recover).not.toHaveBeenCalled();
    click(buttonByText(mounted.container, "Kiểm tra kết quả")); await flush();
    expect(mocks.fetch.mock.calls.map(([hash, key]) => [hash, key])).toEqual([[record.requestHash, record.idempotencyKey], [record.requestHash, record.idempotencyKey]]);
  });
  it("closes only after explicit confirmation and removes metadata only after an authoritative closed outcome", async () => {
    mocks.fetch.mockResolvedValue({ ...receipt, data: { status: "unresolved" } }); mounted = renderTestUi(view());
    click(buttonByText(mounted.container, "Kiểm tra kết quả")); await flush();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    click(buttonByText(mounted.container, "Kiểm tra và đóng yêu cầu chưa thực hiện")); await flush();
    expect(mocks.close).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    click(buttonByText(mounted.container, "Kiểm tra và đóng yêu cầu chưa thực hiện")); await flush();
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(record.requestHash, record.idempotencyKey, scope, expect.any(AbortSignal));
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(record); expect(mocks.recover).not.toHaveBeenCalled();
  });
  it("keeps an accepted intent if creation wins the race with closure", async () => {
    mocks.fetch.mockResolvedValue({ ...receipt, data: { status: "unresolved" } }); mocks.close.mockResolvedValue(receipt);
    vi.spyOn(window, "confirm").mockReturnValue(true); mounted = renderTestUi(view());
    click(buttonByText(mounted.container, "Kiểm tra kết quả")); await flush();
    click(buttonByText(mounted.container, "Kiểm tra và đóng yêu cầu chưa thực hiện")); await flush();
    expect(mounted.container.textContent).toContain(intent.referenceCode); expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it("does not offer negative closure to a read-only operator or an unversioned legacy key", async () => {
    mocks.fetch.mockResolvedValue({ ...receipt, data: { status: "unresolved" } }); mounted = renderTestUi(view(scope, undefined, false));
    click(buttonByText(mounted.container, "Kiểm tra kết quả")); await flush();
    expect(mounted.container.textContent).not.toContain("Kiểm tra và đóng");
    mocks.list.mockReturnValue([{ ...record, idempotencyKey: "legacy-key" }]); mounted.rerender(view({ ...scope, accessEpoch: "new-epoch" }));
    click(buttonByText(mounted.container, "Kiểm tra kết quả")); await flush();
    expect(mounted.container.textContent).not.toContain("Kiểm tra và đóng"); expect(mocks.close).not.toHaveBeenCalled();
  });
  it.each(["operator", "store", "epoch"])("aborts and ignores a late receipt after a %s change, including a reused request key", async change => {
    let finish!: (value: unknown) => void; mocks.fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    mounted = renderTestUi(view()); click(buttonByText(mounted.container, "Kiểm tra kết quả")); await flush();
    const signal = mocks.fetch.mock.calls[0]![3] as AbortSignal;
    const selected = { ...scope, operatorId: change === "operator" ? "operator-b" : scope.operatorId,
      storeId: change === "store" ? "store-b" : scope.storeId, accessEpoch: "epoch-b" };
    mocks.list.mockReturnValue([{ ...record, ...selected }]); mounted.rerender(view(selected));
    await act(async () => { finish(receipt); }); await flush();
    expect(signal.aborted).toBe(true); expect(mounted.container.textContent).not.toContain(intent.referenceCode);
    expect(mocks.recover).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("keeps corrupt metadata for inspection and never exposes another operator's row", () => {
    mocks.list.mockImplementationOnce(() => { throw new Error("corrupt"); }); mounted = renderTestUi(view());
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain("Chưa đọc được mã khôi phục");
    mounted.rerender(view({ ...scope, operatorId: "operator-b" }));
    expect(mounted.container.textContent).not.toContain("QR tự đối soát"); expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("removes only an explicitly reviewed terminal result and hides the request already shown by the active intent", async () => {
    mounted = renderTestUi(view(scope, record.idempotencyKey)); expect(mounted.container.textContent).toBe("");
    mounted.rerender(view()); mocks.fetch.mockResolvedValue({ ...receipt, data: { status: "resolved", intent: { ...intent, status: "cancelled" } } });
    click(buttonByText(mounted.container, "Kiểm tra kết quả")); await flush();
    click(buttonByText(mounted.container, "Đã kiểm tra kết quả"));
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(record); expect(mounted.container.textContent).toBe("");
    expect(mocks.recover).not.toHaveBeenCalled();
  });
});
