// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RuntimeBuildInfoV2Schema, emptyRuntimeCapabilitySetV1, emptyPaymentFeeCapabilitySetV1 } from "@medusa-snus/contracts/runtime-capabilities";
import { creatorSalesDashboardV3Fixture } from "../../../../packages/application/src/__tests__/fixtures/creator-sales-dashboard";
import { renderTestUi, type TestRender } from "../test/reactTestHarness";
const state = vi.hoisted(() => ({ old: vi.fn(), next: vi.fn(), feeAware: true,
  snapshot: { operatorId: "staff_a", merchantId: "merchant-a", storeIds: ["store-a"], permissionIds: [], accessEpoch: "session-a", capabilityPartition: "legacy" } }));
const build = RuntimeBuildInfoV2Schema.parse({ schemaVersion: 2, service: "medusa", sourceCommit: "a".repeat(40), releaseId: "synthetic-dashboard-v3",
  compatibilityFamily: "snus-runtime-v1", capabilities: emptyRuntimeCapabilitySetV1(), paymentFeeCapabilities: { ...emptyPaymentFeeCapabilitySetV1(), dashboardRead: ["v3"] } });
vi.mock("../api/endpoints", () => ({ fetchCreatorSalesDashboardV2: state.old, fetchCreatorSalesDashboardV3: state.next }));
vi.mock("./useAppAccessSnapshot", () => ({ useAppAccessSnapshot: () => ({ snapshot: state.snapshot, runtime: { selected: { dashboardRead: "v2" } } }) }));
vi.mock("./useRuntimeCapabilities", () => ({ usePaymentFeeRuntimeBuild: () => state.feeAware ? build : null }));
import { useCreatorSalesDashboard } from "./useCreatorSalesDashboard";
const fixture = creatorSalesDashboardV3Fixture();
let mounted: TestRender | undefined, cache: QueryClient;
function Probe() {
  const query = useCreatorSalesDashboard({ from: "2026-10-18", to: "2026-10-18" }, true);
  return <p data-error={query.isError ? "yes" : "no"} data-asof={query.data?.asOf ?? "pending"} />;
}
const view = () => <QueryClientProvider client={cache}><Probe /></QueryClientProvider>;
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
beforeEach(() => {
  state.old.mockReset(); state.next.mockReset(); state.feeAware = true;
  state.snapshot = { ...state.snapshot, merchantId: "merchant-a", storeIds: ["store-a"], accessEpoch: "session-a" };
  state.next.mockResolvedValue(fixture); cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { mounted?.unmount(); mounted = undefined; cache.clear(); });
describe("versioned creator Dashboard query", () => {
  it("uses trusted V3 source/release/access partition and captured scope/signal", async () => {
    mounted = renderTestUi(view()); await flush();
    expect(state.old).not.toHaveBeenCalled(); expect(state.next).toHaveBeenCalledTimes(1);
    expect(state.next.mock.calls[0]!.slice(1, 3)).toEqual([{ scopeKind: "report", merchantId: "merchant-a", storeIds: ["store-a"] }, "staff_a"]);
    expect(typeof state.next.mock.calls[0]![3].addEventListener).toBe("function");
    expect(JSON.stringify(cache.getQueryCache().getAll()[0]!.queryKey)).toContain("synthetic-dashboard-v3");
  });
  it("keeps a V3 error explicit and never retries on V2", async () => {
    state.next.mockRejectedValue(new Error("synthetic404")); mounted = renderTestUi(view()); await flush();
    expect(mounted.container.querySelector("p")?.dataset.error).toBe("yes"); expect(state.old).not.toHaveBeenCalled();
  });
  it("cancels a scope change and ignores an old successful response", async () => {
    let resolve!: (value: typeof fixture) => void;
    state.next.mockReturnValueOnce(new Promise<typeof fixture>(done => { resolve = done; })).mockResolvedValueOnce({ ...fixture, asOf: "2026-10-18T11:00:00.000Z" });
    mounted = renderTestUi(view()); await flush(); const signal = state.next.mock.calls[0]![3];
    state.snapshot = { ...state.snapshot, merchantId: "merchant-b", storeIds: ["store-b"] }; mounted.rerender(view()); await flush();
    expect(signal.aborted).toBe(true); await act(async () => { resolve(fixture); });
    expect(mounted.container.querySelector("p")?.dataset.asof).toBe("2026-10-18T11:00:00.000Z");
  });
});
