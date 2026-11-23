// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RuntimeBuildInfoV2Schema, emptyRuntimeCapabilitySetV1 } from "@medusa-snus/contracts/runtime-capabilities";
import { renderTestUi, type TestRender } from "../test/reactTestHarness";
const state = vi.hoisted(() => ({ send: vi.fn(), compatible: true,
  input: { items: [{ variantId: "v-a", quantity: 1 }], paymentFeeType: "percent", paymentFeeValue: 10 },
  snapshot: { operatorId: "staff-a", merchantId: "m-a", storeIds: ["s-a"], permissionIds: [], accessEpoch: "session1", capabilityPartition: "legacy" } }));
const build = RuntimeBuildInfoV2Schema.parse({ schemaVersion: 2, service: "medusa", sourceCommit: "a".repeat(40), releaseId: "synthetic-cart-preview",
  compatibilityFamily: "snus-runtime-v1", capabilities: { ...emptyRuntimeCapabilitySetV1(), checkoutWrite: ["v1"], paymentWrite: ["v1"] },
  paymentFeeCapabilities: { ordersRead: ["v5"], orderDetail: ["v3"], orderRecreate: ["v3"], csvRead: ["v5"], dashboardRead: ["v3"], paymentFeeWrite: ["v1"] } });
vi.mock("../api/endpoints", () => ({ previewCartPaymentFeeV1: state.send }));
vi.mock("./useAppAccessSnapshot", () => ({ useAppAccessSnapshot: () => ({ operatingSnapshot: state.snapshot }) }));
vi.mock("./useRuntimeCapabilities", () => ({ usePaymentFeeRuntimeBuild: () => state.compatible ? build : null }));
import { useCartPaymentFeePreview } from "./useCartPaymentFeePreview";
let mounted: TestRender | undefined, cache: QueryClient;
function Probe() {
  const query = useCartPaymentFeePreview(state.input);
  return <p data-ready={query.canConfirm ? "yes" : "no"} data-error={query.inputError ?? (query.isError ? "error" : "")}>
    {query.data?.data.financial.components.totalMinor ?? "pending"}
  </p>;
}
const wrap = () => <QueryClientProvider client={cache}><Probe /></QueryClientProvider>;
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); }
beforeEach(() => {
  state.send.mockReset(); state.compatible = true;
  state.input = { items: [{ variantId: "v-a", quantity: 1 }], paymentFeeType: "percent", paymentFeeValue: 10 };
  state.snapshot = { ...state.snapshot, storeIds: ["s-a"] };
  state.send.mockResolvedValue({ data: { confirmationToken: "a".repeat(64), financial: { components: { totalMinor: 1320 } } } });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { mounted?.unmount(); mounted = undefined; cache.clear(); });
describe("authoritative cart fee preview consumer", () => {
  it("uses captured operating scope and confirms only after a successful current server result", async () => {
    mounted = renderTestUi(wrap());
    expect(mounted.container.querySelector("p")?.dataset.ready).toBe("no"); await flush();
    expect(state.send).toHaveBeenCalledOnce(); expect(state.send.mock.calls[0][1]).toEqual({ merchantId: "m-a", storeId: "s-a" });
    expect(state.send.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
    expect(mounted.container.querySelector("p")?.dataset.ready).toBe("yes");
  });
  it.each(["cart", "scope"])("aborts an old %s preview and never confirms its late result", async kind => {
    let finish!: (value: unknown) => void;
    state.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mounted = renderTestUi(wrap()); await flush();
    const oldSignal = state.send.mock.calls[0][2] as AbortSignal;
    if (kind === "cart") state.input = { ...state.input, paymentFeeValue: 20 };
    else state.snapshot = { ...state.snapshot, storeIds: ["s-b"] };
    mounted.rerender(wrap()); await flush();
    expect(oldSignal.aborted).toBe(true);
    finish({ data: { confirmationToken: "b".repeat(64), financial: { components: { totalMinor: 9999 } } } }); await flush();
    expect(mounted.container.textContent).toBe("1320");
  });
  it("does not request or confirm new-fee checkout on an unready runtime", async () => {
    state.compatible = false; mounted = renderTestUi(wrap()); await flush();
    expect(state.send).not.toHaveBeenCalled(); expect(mounted.container.querySelector("p")?.dataset.ready).toBe("no");
  });
  it("shows invalid input without dispatch, rather than clamping it or using a local total", async () => {
    state.input = { ...state.input, paymentFeeValue: -1 }; mounted = renderTestUi(wrap()); await flush();
    expect(state.send).not.toHaveBeenCalled();
    expect(mounted.container.querySelector("p")?.dataset.error).toContain("Kiểm tra");
    expect(mounted.container.querySelector("p")?.dataset.ready).toBe("no");
  });
  it("keeps a failed preview unconfirmed with no fallback request", async () => {
    state.send.mockRejectedValueOnce(new Error("unavailable")); mounted = renderTestUi(wrap()); await flush();
    expect(state.send).toHaveBeenCalledOnce(); expect(mounted.container.querySelector("p")?.dataset.ready).toBe("no");
    expect(mounted.container.querySelector("p")?.dataset.error).toBe("error");
  });
});
