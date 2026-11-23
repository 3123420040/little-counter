// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderTestUi, click, buttonByText, type TestRender } from "../test/reactTestHarness";
const state = vi.hoisted(() => ({ financial: true, context: vi.fn(), preview: vi.fn(), apply: vi.fn(), oldPreview: vi.fn(), oldApply: vi.fn(),
  operating: { operatorId: "manager", accessEpoch: "session-a", merchantId: "m-a", storeIds: ["s-a"], permissionIds: [], capabilityPartition: "old" } as {
    operatorId: string; accessEpoch: string; merchantId: string; storeIds: string[]; permissionIds: string[]; capabilityPartition: string;
  } | null }));
vi.mock("./useAppAccessSnapshot", () => ({ useAppAccessSnapshot: () => ({ operatingSnapshot: state.operating,
  snapshot: { merchantId: "report-other", storeIds: ["report-other"] } }) }));
vi.mock("./useRuntimeCapabilities", () => ({ usePaymentFeeRuntimeBuild: () => state.financial ? {
  sourceCommit: "a".repeat(40), releaseId: "synthetic-correction", paymentFeeCapabilities: { paymentFeeWrite: ["v1"] },
} : null }));
vi.mock("../api/endpoints", async original => ({ ...await original<typeof import("../api/endpoints")>(),
  fetchOrderCorrectionFinancialContextV1: state.context, previewOrderCorrectionFinancialV1: state.preview,
  applyOrderCorrectionFinancialV1: state.apply, previewOrderCorrection: state.oldPreview, applyOrderCorrection: state.oldApply,
}));
import { useOrderCorrectionFinancialContext, usePreviewOrderCorrection, useApplyOrderCorrection } from "./useOrders";
let mounted: TestRender | undefined, cache: QueryClient;
const input = { baseRevision: 0, reason: "Correct entered quantity", items: [{ variantId: "v-a", quantity: 1 }] };
const confirmation = { synthetic: true };
function Probe() {
  const context = useOrderCorrectionFinancialContext("order-a", true);
  const transport = { financial: context.financial, scope: context.scope };
  const preview = usePreviewOrderCorrection(transport), apply = useApplyOrderCorrection(transport);
  return <div><p>{context.data?.data.orderId ?? "pending"}</p>
    <button onClick={() => preview.mutate({ orderId: "order-a", input })}>preview</button>
    <button onClick={() => apply.mutate({ orderId: "order-a", input, intentKey: "same-key", confirmation })}>apply</button>
    <output>{String(preview.isError || apply.isError)}</output>
  </div>;
}
const view = () => <QueryClientProvider client={cache}><Probe /></QueryClientProvider>;
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
beforeEach(() => {
  vi.clearAllMocks(); state.financial = true;
  state.operating = { operatorId: "manager", accessEpoch: "session-a", merchantId: "m-a", storeIds: ["s-a"], permissionIds: [], capabilityPartition: "old" };
  state.context.mockResolvedValue({ data: { orderId: "A" } }); state.preview.mockResolvedValue({ data: {} }); state.apply.mockResolvedValue({ data: {} });
  state.oldPreview.mockResolvedValue({ data: {} }); state.oldApply.mockResolvedValue({ data: {} });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { mounted?.unmount(); mounted = undefined; cache.clear(); });
describe("captured correction context and mutation wiring", () => {
  it("reads and mutates in operating scope, with a captured command key and financial cache invalidation", async () => {
    const invalidate = vi.spyOn(cache, "invalidateQueries"); mounted = renderTestUi(view()); await flush();
    expect(state.context.mock.calls[0]!.slice(0, 2)).toEqual(["order-a", { merchantId: "m-a", storeId: "s-a" }]);
    expect(state.context.mock.calls[0]![2]).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(cache.getQueryCache().getAll()[0]!.queryKey)).toContain("synthetic-correction");
    click(buttonByText(mounted.container, "preview")); await flush(); click(buttonByText(mounted.container, "apply")); await flush();
    expect(state.preview).toHaveBeenCalledWith("order-a", input, { merchantId: "m-a", storeId: "s-a" });
    expect(state.apply).toHaveBeenCalledWith("order-a", input, "same-key", { merchantId: "m-a", storeId: "s-a" }, confirmation);
    expect(state.oldPreview).not.toHaveBeenCalled(); expect(state.oldApply).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["orderCorrectionContextV1"] });
  });
  it("aborts an old store query and ignores its late response", async () => {
    let resolve!: (value: unknown) => void; state.context.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValueOnce({ data: { orderId: "B" } });
    mounted = renderTestUi(view()); await flush(); const signal = state.context.mock.calls[0]![2];
    state.operating = { ...state.operating!, storeIds: ["s-b"] }; mounted.rerender(view()); await flush();
    expect(signal.aborted).toBe(true); await act(async () => resolve({ data: { orderId: "late-A" } }));
    expect(mounted.container.querySelector("p")?.textContent).toBe("B");
  });
  it("does not substitute report-only authority or fall back when operating scope is unavailable", async () => {
    state.operating = null; mounted = renderTestUi(view()); await flush();
    click(buttonByText(mounted.container, "preview")); click(buttonByText(mounted.container, "apply")); await flush();
    expect(state.context).not.toHaveBeenCalled(); expect(state.preview).not.toHaveBeenCalled(); expect(state.apply).not.toHaveBeenCalled();
    expect(state.oldPreview).not.toHaveBeenCalled(); expect(state.oldApply).not.toHaveBeenCalled(); expect(mounted.container.querySelector("output")?.textContent).toBe("true");
  });
  it("keeps the legacy mutation path when the new protocol is not advertised", async () => {
    state.financial = false; mounted = renderTestUi(view()); await flush();
    click(buttonByText(mounted.container, "preview")); await flush(); click(buttonByText(mounted.container, "apply")); await flush();
    expect(state.oldPreview).toHaveBeenCalledWith("order-a", input); expect(state.oldApply).toHaveBeenCalledWith("order-a", input);
    expect(state.context).not.toHaveBeenCalled(); expect(state.preview).not.toHaveBeenCalled(); expect(state.apply).not.toHaveBeenCalled();
  });
});
