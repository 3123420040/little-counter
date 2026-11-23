// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RuntimeBuildInfoV2Schema, emptyRuntimeCapabilitySetV1, emptyPaymentFeeCapabilitySetV1 } from "@medusa-snus/contracts/runtime-capabilities";
import { renderTestUi, type TestRender } from "../test/reactTestHarness";
const state = vi.hoisted(() => ({ old: vi.fn(), next: vi.fn(), feeAware: true,
  snapshot: { operatorId: "staff-a", merchantId: "m-a", storeIds: ["s-a"], permissionIds: [], accessEpoch: "session1", capabilityPartition: "legacy" } }));
const build = RuntimeBuildInfoV2Schema.parse({ schemaVersion: 2, service: "medusa", sourceCommit: "a".repeat(40), releaseId: "synthetic-fee-intents",
  compatibilityFamily: "snus-runtime-v1", capabilities: emptyRuntimeCapabilitySetV1(),
  paymentFeeCapabilities: { ...emptyPaymentFeeCapabilitySetV1(), ordersRead: ["v5"] } });
vi.mock("../api/endpoints", () => ({ fetchPaymentIntents: state.old, fetchPaymentIntentsFinancialV1: state.next }));
vi.mock("./useAppAccessSnapshot", () => ({ useAppAccessSnapshot: () => ({ snapshot: state.snapshot }) }));
vi.mock("./useRuntimeCapabilities", () => ({ usePaymentFeeRuntimeBuild: () => state.feeAware ? build : null }));
import { useManualReviewPaymentIntents } from "./useOrders";
let mounted: TestRender | undefined, cache: QueryClient;
function Probe() {
  const query = useManualReviewPaymentIntents(true, { limit: 20, offset: 0 });
  return <p data-error={query.isError ? "yes" : "no"}>{query.data?.count ?? "pending"}</p>;
}
const wrap = () => <QueryClientProvider client={cache}><Probe /></QueryClientProvider>;
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); }
beforeEach(() => {
  state.old.mockReset(); state.next.mockReset(); state.feeAware = true;
  state.snapshot = { ...state.snapshot, merchantId: "m-a", storeIds: ["s-a"] };
  state.next.mockResolvedValue({ data: [], count: 1, limit: 20, offset: 0 });
  state.old.mockResolvedValue({ data: [], count: 0, limit: 20, offset: 0 });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { mounted?.unmount(); mounted = undefined; cache.clear(); });
describe("manual-review payment intent financial consumer", () => {
  it("uses a captured scoped/abortable modern read even with new fee-write admission unavailable", async () => {
    mounted = renderTestUi(wrap()); await flush();
    expect(state.next).toHaveBeenCalledOnce(); expect(state.old).not.toHaveBeenCalled();
    expect(state.next.mock.calls[0][1]).toEqual({ scopeKind: "report", merchantId: "m-a", storeIds: ["s-a"] });
    expect(state.next.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
    expect(cache.getQueryCache().getAll()[0]!.queryKey).toEqual(expect.arrayContaining(["paymentIntents", "merchant:m-a"]));
    expect(mounted.container.textContent).toBe("1");
  });
  it("does not downgrade to a legacy reader after a modern error", async () => {
    state.next.mockRejectedValueOnce(new Error("unavailable")); mounted = renderTestUi(wrap()); await flush();
    expect(mounted.container.querySelector("p")?.dataset.error).toBe("yes"); expect(state.old).not.toHaveBeenCalled();
  });
  it("aborts a prior scope and keeps its late result outside the new scope cache", async () => {
    let finish!: (value: unknown) => void;
    state.next.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mounted = renderTestUi(wrap()); await flush();
    const previousSignal = state.next.mock.calls[0][2] as AbortSignal;
    state.snapshot = { ...state.snapshot, storeIds: ["s-b"] }; mounted.rerender(wrap()); await flush();
    expect(previousSignal.aborted).toBe(true);
    finish({ data: [], count: 999, limit: 20, offset: 0 }); await flush();
    expect(mounted.container.textContent).toBe("1");
    expect(state.next.mock.calls[1][1]).toMatchObject({ storeIds: ["s-b"] });
  });
  it("retains the old reader on a runtime with no compatible fee read support", async () => {
    state.feeAware = false; mounted = renderTestUi(wrap()); await flush();
    expect(state.old).toHaveBeenCalledOnce(); expect(state.next).not.toHaveBeenCalled();
    expect(mounted.container.textContent).toBe("0");
  });
});
