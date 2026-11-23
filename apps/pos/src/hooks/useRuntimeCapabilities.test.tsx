// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RuntimeBuildInfoV1Schema, emptyRuntimeCapabilitySetV1, emptyPaymentFeeCapabilitySetV1 } from "@medusa-snus/contracts/runtime-capabilities";
import { renderTestUi, type TestRender } from "../test/reactTestHarness";
const get = vi.hoisted(() => vi.fn());
vi.mock("../api/client", () => ({ api: { get } }));
import { RuntimeCapabilitiesProvider, useRuntimeCapabilities, usePaymentFeeRuntimeBuild } from "./useRuntimeCapabilities";
const legacy = RuntimeBuildInfoV1Schema.parse({ service: "medusa", sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  releaseId: "snus-2.3.0-candidate", compatibilityFamily: "snus-runtime-v1", capabilities: { ...emptyRuntimeCapabilitySetV1(),
    orderDetail: ["v2"], checkoutWrite: ["v1"], paymentWrite: ["v1"] } });
const fee = { ...legacy, schemaVersion: 2, paymentFeeCapabilities: { ...emptyPaymentFeeCapabilitySetV1(), orderDetail: ["v3"] } };
let mounted: TestRender | undefined, cache: QueryClient;
function Probe() {
  const old = useRuntimeCapabilities(), next = usePaymentFeeRuntimeBuild();
  return <p data-old={old.selected.orderDetail ?? "none"} data-write={old.surfaces.checkoutWrite}
    data-fee={next?.paymentFeeCapabilities.orderDetail[0] ?? "none"} />;
}
function mount() {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mounted = renderTestUi(<QueryClientProvider client={cache}><RuntimeCapabilitiesProvider><Probe /></RuntimeCapabilitiesProvider></QueryClientProvider>);
}
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); }
afterEach(() => { mounted?.unmount(); mounted = undefined; cache?.clear(); get.mockReset(); });
describe("dual runtime handshake", () => {
  it("waits for V1 identity before requesting V2 and retains legacy readiness", async () => {
    let resolve!: (value: unknown) => void;
    get.mockImplementation((path: string) => path === "/api/build-info"
      ? new Promise((done) => { resolve = done; }) : Promise.resolve(fee));
    mount(); await flush();
    expect(get).toHaveBeenCalledExactlyOnceWith("/api/build-info");
    await act(async () => resolve(legacy)); await flush(); await flush();
    expect(mounted!.container.querySelector("p")?.dataset).toMatchObject({ old: "v2", write: "enabled", fee: "v3" });
  });
  it.each(["missing", "different-image"])("keeps legacy behavior when V2 is %s", async (mode) => {
    get.mockImplementation((path: string) => path === "/api/build-info" ? Promise.resolve(legacy)
      : mode === "missing" ? Promise.reject(new Error("synthetic404")) : Promise.resolve({ ...fee, sourceCommit: "a".repeat(40) }));
    mount(); await flush(); await flush();
    expect(mounted!.container.querySelector("p")?.dataset).toMatchObject({ old: "v2", write: "enabled", fee: "none" });
    expect(get.mock.calls.filter(([path]) => path === "/api/build-info/v2")).toHaveLength(1);
  });
  it("does not request V2 when V1 identity is invalid", async () => {
    get.mockResolvedValue({}); mount(); await flush();
    expect(get).toHaveBeenCalledExactlyOnceWith("/api/build-info");
    expect(mounted!.container.querySelector("p")?.dataset).toMatchObject({ old: "none", write: "blocked", fee: "none" });
  });
});
