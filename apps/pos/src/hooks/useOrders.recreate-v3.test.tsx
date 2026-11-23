// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RuntimeBuildInfoV2Schema, emptyRuntimeCapabilitySetV1, emptyPaymentFeeCapabilitySetV1 } from "@medusa-snus/contracts/runtime-capabilities";
import { renderTestUi, type TestRender } from "../test/reactTestHarness";
import type { AppAccessSnapshotV1 } from "../utils/appAccessSnapshot";
const state = vi.hoisted(() => ({ old: vi.fn(), legacy: vi.fn(), next: vi.fn(), feeAware: true,
  operating: { operatorId: "staff-a", merchantId: "m-a", storeIds: ["s-a"], permissionIds: [], accessEpoch: "session-a", capabilityPartition: "old" } as AppAccessSnapshotV1 | null }));
const build = RuntimeBuildInfoV2Schema.parse({ schemaVersion: 2, service: "medusa", sourceCommit: "a".repeat(40), releaseId: "synthetic-recreate-v3",
  compatibilityFamily: "snus-runtime-v1", capabilities: emptyRuntimeCapabilitySetV1(), paymentFeeCapabilities: { ...emptyPaymentFeeCapabilitySetV1(), orderRecreate: ["v3"] } });
vi.mock("../api/endpoints", () => ({ fetchEffectiveOrderFeatureRecreatePrefill: state.old, fetchOrderRecreatePrefill: state.legacy, fetchEffectiveOrderFeatureRecreatePrefillV3: state.next }));
vi.mock("./useAppAccessSnapshot", () => ({ useAppAccessSnapshot: () => ({ snapshot: { merchantId: "report-merchant", storeIds: ["report-store"] },
  operatingSnapshot: state.operating, runtime: { surfaces: { orderRecreate: "enabled", orderRecreateCustomerPrefill: "enabled" } } }) }));
vi.mock("./useRuntimeCapabilities", () => ({ usePaymentFeeRuntimeBuild: () => state.feeAware ? build : null }));
import { useOrderRecreatePrefill } from "./useOrders";
let mounted: TestRender | undefined, cache: QueryClient;
function Probe() {
  const query = useOrderRecreatePrefill("order-a");
  return <p data-source={query.data?.sourceOrderNumber ?? "pending"} data-error={query.isError ? "yes" : "no"} />;
}
const view = () => <QueryClientProvider client={cache}><Probe /></QueryClientProvider>;
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
beforeEach(() => {
  state.old.mockReset(); state.next.mockReset(); state.legacy.mockReset(); state.feeAware = true;
  state.operating = { operatorId: "staff-a", merchantId: "m-a", storeIds: ["s-a"], permissionIds: [], accessEpoch: "session-a", capabilityPartition: "old" };
  state.next.mockResolvedValue({ prefill: { sourceOrderNumber: "A" } }); cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { mounted?.unmount(); mounted = undefined; cache.clear(); });
describe("fee-aware recreate query", () => {
  it("uses captured operating scope, signal, source/release/access partition independently of report scope", async () => {
    mounted = renderTestUi(view()); await flush();
    expect(state.next).toHaveBeenCalledTimes(1); expect(state.old).not.toHaveBeenCalled(); expect(state.legacy).not.toHaveBeenCalled();
    expect(state.next.mock.calls[0]!.slice(0, 2)).toEqual(["order-a", { merchantId: "m-a", storeId: "s-a" }]);
    expect(typeof state.next.mock.calls[0]![2].addEventListener).toBe("function");
    expect(JSON.stringify(cache.getQueryCache().getAll()[0]!.queryKey)).toContain("synthetic-recreate-v3");
    expect(cache.getQueryCache().getAll()[0]!.queryKey[0]).toBe("orderRecreatePrefillV3");
  });
  it("keeps a V3 error explicit without trying either legacy endpoint", async () => {
    state.next.mockRejectedValue(new Error("synthetic404")); mounted = renderTestUi(view()); await flush();
    expect(mounted.container.querySelector("p")?.dataset.error).toBe("yes"); expect(state.old).not.toHaveBeenCalled(); expect(state.legacy).not.toHaveBeenCalled();
  });
  it("cancels an old store request and ignores its late success", async () => {
    let resolve!: (value: unknown) => void;
    state.next.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValueOnce({ prefill: { sourceOrderNumber: "B" } });
    mounted = renderTestUi(view()); await flush(); const signal = state.next.mock.calls[0]![2];
    state.operating = { ...state.operating!, merchantId: "m-b", storeIds: ["s-b"] }; mounted.rerender(view()); await flush();
    expect(signal.aborted).toBe(true); await act(async () => resolve({ prefill: { sourceOrderNumber: "late-A" } }));
    expect(mounted.container.querySelector("p")?.dataset.source).toBe("B");
  });
  it("does not use report-only authority to recreate in an inactive or absent operating scope", async () => {
    state.operating = null; mounted = renderTestUi(view()); await flush();
    expect(state.next).not.toHaveBeenCalled(); expect(state.old).not.toHaveBeenCalled(); expect(state.legacy).not.toHaveBeenCalled();
  });
});
