// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RuntimeBuildInfoV2Schema, emptyRuntimeCapabilitySetV1, emptyPaymentFeeCapabilitySetV1 } from "@medusa-snus/contracts/runtime-capabilities";
import { renderTestUi, type TestRender } from "../test/reactTestHarness";
const state = vi.hoisted(() => ({ old: vi.fn(), next: vi.fn(), feeAware: true,
  snapshot: { operatorId: "staff-a", merchantId: "m-a", storeIds: ["s-a"], permissionIds: [], accessEpoch: "session1", capabilityPartition: "old-v3" } }));
const build = RuntimeBuildInfoV2Schema.parse({ schemaVersion: 2, service: "medusa", sourceCommit: "a".repeat(40), releaseId: "synthetic-fee-page",
  compatibilityFamily: "snus-runtime-v1", capabilities: emptyRuntimeCapabilitySetV1(),
  paymentFeeCapabilities: { ...emptyPaymentFeeCapabilitySetV1(), ordersRead: ["v5"] } });
vi.mock("../api/endpoints", () => ({ fetchEffectiveOrderFeaturePage: state.old, fetchEffectiveOrderFeaturePageV5: state.next }));
vi.mock("./useAppAccessSnapshot", () => ({ useAppAccessSnapshot: () => ({ snapshot: state.snapshot,
  runtime: { surfaces: { ordersRead: "v3" }, selected: {} } }) }));
vi.mock("./useRuntimeCapabilities", () => ({ usePaymentFeeRuntimeBuild: () => state.feeAware ? build : null }));
import { useEffectiveOrderFeaturePage } from "./useOrders";
let mounted: TestRender | undefined, cache: QueryClient;
const page = (asOf = "2026-10-27T12:00:00.000Z") => ({ schemaVersion: 5,
  creatorSelection: { mode: "all", creatorOperatorIds: [] }, data: [], currencies: [],
  pagination: { limit: 20, totalCount: 0, asOf, nextCursor: null, hasMore: false } });
function Probe() {
  const query = useEffectiveOrderFeaturePage({ from: "2026-10-26", to: "2026-10-26", status: "all", limit: 20 });
  return <p data-contract={query.contractVersion} data-error={query.isError ? "yes" : "no"}
    data-asof={query.data?.pages[0]?.pagination.asOf ?? "pending"} />;
}
const wrap = () => <QueryClientProvider client={cache}><Probe /></QueryClientProvider>;
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); }
beforeEach(() => {
  state.old.mockReset(); state.next.mockReset(); state.feeAware = true;
  state.snapshot = { ...state.snapshot, merchantId: "m-a", storeIds: ["s-a"] };
  state.next.mockResolvedValue(page());
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { mounted?.unmount(); mounted = undefined; cache.clear(); });
describe("V5 page hook", () => {
  it("selects V5 with captured report scope and a separate access cache even when old V4 is absent", async () => {
    mounted = renderTestUi(wrap()); await flush();
    expect(state.next).toHaveBeenCalledTimes(1); expect(state.old).not.toHaveBeenCalled();
    expect(state.next.mock.calls[0][1]).toEqual({ scopeKind: "report", merchantId: "m-a", storeIds: ["s-a"] });
    expect(typeof state.next.mock.calls[0][2].addEventListener).toBe("function");
    expect(cache.getQueryCache().getAll()[0]!.queryKey).toEqual(expect.arrayContaining(["ordersEffectivePageV5", "merchant:m-a"]));
    expect(mounted.container.querySelector("p")?.dataset.contract).toBe("v5");
  });
  it("keeps a V5 failure explicit without retrying the request on V4", async () => {
    state.next.mockRejectedValue(new Error("synthetic404")); mounted = renderTestUi(wrap()); await flush();
    expect(mounted.container.querySelector("p")?.dataset.error).toBe("yes"); expect(state.old).not.toHaveBeenCalled();
  });
  it("aborts the old scope and ignores a late page after switching merchants", async () => {
    let resolve!: (value: unknown) => void;
    state.next.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    mounted = renderTestUi(wrap()); await flush(); const oldSignal = state.next.mock.calls[0][2];
    state.snapshot = { ...state.snapshot, merchantId: "m-b", storeIds: ["s-b"] };
    mounted.rerender(wrap()); await flush();
    expect(oldSignal.aborted).toBe(true);
    expect(state.next.mock.calls[1][1]).toEqual({ scopeKind: "report", merchantId: "m-b", storeIds: ["s-b"] });
    await act(async () => resolve(page("2026-10-26T12:00:00.000Z"))); await flush();
    expect(mounted.container.querySelector("p")?.dataset.asof).toBe("2026-10-27T12:00:00.000Z");
  });
});
