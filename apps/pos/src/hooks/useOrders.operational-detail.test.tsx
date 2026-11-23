// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderTestUi, type TestRender } from "../test/reactTestHarness";
const state = vi.hoisted(() => ({ fee: true, build: "a".repeat(40), merchantId: "m-a", storeIds: ["s-a"], epoch: "session1", legacy: vi.fn(), modern: vi.fn() }));
vi.mock("../api/endpoints", () => ({ fetchOrderDetail: state.legacy, fetchOrderOperationalDetailV1: state.modern }));
vi.mock("./useAppAccessSnapshot", () => ({ useAppAccessSnapshot: () => ({ snapshot: { operatorId: "staff-a", merchantId: state.merchantId,
  storeIds: state.storeIds, permissionIds: ["orders:read"], accessEpoch: state.epoch, capabilityPartition: "detail:v3" } }) }));
vi.mock("./useProducts", () => ({ useClientOperatingScope: () => ({ operatingMerchantId: state.merchantId, operatingStoreId: state.storeIds[0] }) }));
vi.mock("./useRuntimeCapabilities", () => ({ usePaymentFeeRuntimeBuild: () => state.fee ? { sourceCommit: state.build, releaseId: "candidate", paymentFeeCapabilities: { orderDetail: ["v3"] } } : null }));
import { useOrderDetail } from "./useOrders";
let mounted: TestRender | undefined, cache: QueryClient;
function Probe() { const result = useOrderDetail("order-a");return <p>{result.isError ? "error" : result.data ? "loaded" : "pending"}</p>; }
function mount() { cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });mounted = renderTestUi(<QueryClientProvider client={cache}><Probe /></QueryClientProvider>); }
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
afterEach(() => { mounted?.unmount();mounted = undefined;cache?.clear();state.modern.mockReset();state.legacy.mockReset();state.fee = true;state.build = "a".repeat(40);state.merchantId = "m-a";state.storeIds = ["s-a"];state.epoch = "session1"; });
describe("operational detail capability and cache binding", () => {
  it("uses modern detail exclusively and surfaces its failure", async () => {
    state.modern.mockRejectedValue(new Error("read failed"));mount();await flush();await flush();
    expect(mounted!.container.textContent).toBe("error");expect(state.modern).toHaveBeenCalledWith("order-a", { merchantId: "m-a", storeIds: ["s-a"] }, expect.any(AbortSignal));expect(state.legacy).not.toHaveBeenCalled();
  });
  it("keeps the legacy transport when only legacy capabilities are negotiated", async () => {
    state.fee = false;state.legacy.mockResolvedValue({ id: "order-a" });mount();await flush();
    expect(state.legacy).toHaveBeenCalledWith("order-a");expect(state.modern).not.toHaveBeenCalled();
  });
  it.each(["build", "scope", "session"])("does not reuse operational metadata across a changed %s", async change => {
    state.modern.mockResolvedValue({ id: "order-a" });mount();await flush();
    const firstKey = cache.getQueryCache().getAll()[0]!.queryKey;
    if (change === "build") state.build = "b".repeat(40);
    if (change === "scope") { state.merchantId = "m-b";state.storeIds = ["s-b"]; }
    if (change === "session") state.epoch = "session2";
    mounted!.rerender(<QueryClientProvider client={cache}><Probe /></QueryClientProvider>);await flush();
    expect(state.modern).toHaveBeenCalledTimes(2);expect(cache.getQueryCache().getAll().at(-1)!.queryKey).not.toEqual(firstKey);
  });
});
