// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { click, renderTestUi, type TestRender } from "../test/reactTestHarness";
import type { CartItem } from "../hooks/useCart";
import type { CrossSellRecommendation } from "../api/endpoints";

vi.mock("react-router-dom", () => ({ useLocation: () => ({ state: null }) }));
const mocks = vi.hoisted(() => ({ bootstrap: vi.fn(), recommend: vi.fn(), accept: vi.fn(), shift: vi.fn() }));
const access = { operatorId: "operator", accessEpoch: "epoch" };
const runtime = { selected: { checkoutWrite: "v1" }, surfaces: { checkoutWrite: "enabled", paymentWrite: "enabled" } };
let operatingAccess = { ...access, merchantId: "merchant", storeIds: ["A"] };
let features: string[];
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ operator: { id: "operator" } }) }));
vi.mock("../hooks/useAppAccessSnapshot", () => ({ useAppAccessSnapshot: () => ({ snapshot: access, operatingSnapshot: operatingAccess, runtime }) }));
vi.mock("../hooks/useCheckoutPolicy", () => ({ useCheckoutPolicy: () => ({ status: "ready", mode: "confirm_on_booking", refreshPolicy: vi.fn() }) }));
vi.mock("../hooks/useProductCategories", () => ({ useProductCategories: () => ({ data: { product_categories: [] } }) }));
vi.mock("../hooks/useProducts", async (original) => ({
  ...await original<typeof import("../hooks/useProducts")>(),
  useProducts: () => ({ data: [{ id: "product", title: "Product", variants: [{ id: "variant", title: "Variant", sku: "sku", prices: [{ amount: 1000 }], inventory_quantity: 10 }] }] }),
}));
vi.mock("../api/endpoints", async (original) => ({
  ...await original<typeof import("../api/endpoints")>(),
  fetchSyncBootstrap: mocks.bootstrap,
  fetchCurrentShift: mocks.shift,
  fetchCrossSellRecommendations: mocks.recommend,
  recordCrossSellAcceptance: mocks.accept,
}));
vi.mock("../utils/offlineQueue", async (original) => ({
  ...await original<typeof import("../utils/offlineQueue")>(),
  queuedSaleSummary: async () => ({ queued: 0, needsReview: 0 }),
  listQueuedSales: async () => [],
  saveBootstrapSnapshot: async () => undefined,
}));
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../components/ProductCard", () => ({ ProductCard: ({ onSelect, variantId }: { onSelect: (id: string) => void; variantId: string }) => <button onClick={() => onSelect(variantId)}>add product</button> }));
vi.mock("../components/CartPanel", () => ({ CartPanel: ({ items, beforeFooter, mobileOptimized, onClear }: {
  items: CartItem[]; beforeFooter?: ReactNode; mobileOptimized?: boolean; onClear: () => void;
}) => <section data-testid={mobileOptimized ? "mobile-cart" : "desktop-cart"}>
  <output data-testid="cart-lines">{JSON.stringify(items.map(({ variantId, quantity }) => ({ variantId, quantity })))}</output>
  <button onClick={onClear}>clear cart</button>
  {beforeFooter}
</section> }));
vi.mock("../components/CustomerSearch", () => ({ CustomerSearch: () => null }));
vi.mock("../components/StaffScanDialog", () => ({ StaffScanDialog: () => null }));
vi.mock("../components/VisionScanDrawer", () => ({ VisionScanDrawer: () => null }));
vi.mock("../components/QuantityKeypad", () => ({ QuantityKeypad: () => null }));
import PosScreen from "./PosScreen";
import { getClientScopeSnapshot, SCOPE_CHANGED_EVENT } from "../api/client";

const suggestion: CrossSellRecommendation = {
  productId: "extra-product", variantId: "extra-variant", sku: "EXTRA", name: "Suggested extra",
  price: 2000, stock: 10, score: 1, reason: "Khách từng mua 2 lần",
};
type Suggestions = { data: CrossSellRecommendation[] };
let mounted: TestRender | undefined;
let client: QueryClient;
function selectStore(storeId: string) {
  operatingAccess = { ...operatingAccess, storeIds: [storeId] };
  sessionStorage.setItem("snus_operating_merchant_id", "merchant");
  sessionStorage.setItem("snus_operating_store_id", storeId);
  act(() => window.dispatchEvent(new Event(SCOPE_CHANGED_EVENT)));
}
function bootstrap() {
  const storeId = getClientScopeSnapshot().operatingStoreId;
  return { data: {
    activeOperatingScope: { merchantId: "merchant", storeId, stockLocationId: `stock-${storeId}` },
    entitlements: { features }, products: [], customers: [], loyaltyTiers: [],
    accessibleMerchants: [{ id: "merchant" }], accessibleStores: [{ id: "A" }, { id: "B" }], generatedAt: "2026-10-25",
  } };
}
function desktop() { return mounted!.container.querySelector<HTMLElement>('[data-testid="desktop-cart"]')!; }
function panel(container = desktop()) { return container.querySelector<HTMLDetailsElement>('details[aria-label="Đề xuất bán kèm"]'); }
function press(text: string, container: HTMLElement = mounted!.container) {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  expect(button, text).toBeTruthy();
  click(button!);
}
async function advance(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function mount() {
  mounted = renderTestUi(<QueryClientProvider client={client}><PosScreen /></QueryClientProvider>);
  await advance(); await advance();
}
async function addAndRecommend() { press("add product"); await advance(250); }
function deferred() {
  let resolve!: (value: Suggestions) => void;
  const promise = new Promise<Suggestions>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.resetAllMocks();
  features = ["smart_cross_sell"];
  sessionStorage.clear();
  selectStore("A");
  mocks.bootstrap.mockImplementation(async () => bootstrap());
  mocks.shift.mockResolvedValue({ data: null });
  mocks.recommend.mockResolvedValue({ data: [suggestion] });
  mocks.accept.mockResolvedValue({ data: { recorded: true } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => {
  mounted?.unmount(); mounted = undefined;
  client.clear();
  vi.useRealTimers();
});

describe("mounted POS cross-sell disclosure and response boundaries", () => {
  it("UP-01/02 keeps an entitled desktop suggestion closed until the user opens it", async () => {
    await mount();
    expect(panel()).toBeNull();
    expect(mocks.recommend).not.toHaveBeenCalled();
    await addAndRecommend();
    expect(panel()).not.toBeNull();
    expect(panel()!.open).toBe(false);
    expect(panel()!.querySelector("summary")?.textContent).toContain("Gợi ý bán kèm");
    click(panel()!.querySelector("summary")!);
    expect(panel()!.open).toBe(true);
    click(panel()!.querySelector("summary")!);
    expect(panel()!.open).toBe(false);
    expect(desktop().querySelector("output")?.textContent).toBe('[{"variantId":"variant","quantity":1}]');
  });

  it("UP-04 also gives the compact mobile cart a closed disclosure", async () => {
    await mount(); await addAndRecommend();
    const button = [...mounted!.container.querySelectorAll("button")].find((candidate) => /^1 ·/.test(candidate.textContent || ""));
    expect(button).toBeTruthy(); click(button!); await advance();
    const mobile = mounted!.container.querySelector<HTMLElement>('[data-testid="mobile-cart"]');
    expect(mobile).not.toBeNull();
    expect(panel(mobile!)).not.toBeNull();
    expect(panel(mobile!)!.open).toBe(false);
    click(panel(mobile!)!.querySelector("summary")!);
    expect(panel(mobile!)!.open).toBe(true);
  });

  it("UP-06 preserves an explicitly opened current panel while recommendations refresh", async () => {
    await mount(); await addAndRecommend();
    const details = panel()!;
    act(() => { details.open = true; });
    press("add product"); await advance(250);
    expect(panel()).toBe(details);
    expect(panel()!.open).toBe(true);
    expect(mocks.recommend).toHaveBeenLastCalledWith(expect.objectContaining({ items: [{ variantId: "variant", quantity: 2 }], limit: 2 }));
  });

  it("UP-07/08 adds exactly one recommended item even if acceptance telemetry fails", async () => {
    mocks.accept.mockRejectedValue(new Error("analytics unavailable"));
    await mount(); await addAndRecommend();
    act(() => { panel()!.open = true; });
    press("Thêm", panel()!); await advance();
    expect(desktop().querySelector("output")?.textContent).toBe('[{"variantId":"variant","quantity":1},{"variantId":"extra-variant","quantity":1}]');
    expect(mocks.accept).toHaveBeenCalledTimes(1);
    expect(mocks.accept).toHaveBeenCalledWith(expect.objectContaining({ acceptedVariantId: "extra-variant", cartVariantIds: ["variant"] }));
  });

  it.each(["no entitlement", "empty response", "API failure"])("UP-09 leaves checkout cart intact with %s", async (state) => {
    if (state === "no entitlement") features = [];
    else if (state === "empty response") mocks.recommend.mockResolvedValue({ data: [] });
    else mocks.recommend.mockRejectedValue(new Error("recommendations unavailable"));
    await mount(); await addAndRecommend();
    expect(panel()).toBeNull();
    expect(desktop().querySelector("output")?.textContent).toBe('[{"variantId":"variant","quantity":1}]');
    if (state === "no entitlement") expect(mocks.recommend).not.toHaveBeenCalled();
  });

  it("UP-10 closes a fresh panel after clearing and starting another cart", async () => {
    await mount(); await addAndRecommend();
    act(() => { panel()!.open = true; });
    press("clear cart", desktop()); await advance();
    expect(panel()).toBeNull();
    await addAndRecommend();
    expect(panel()).not.toBeNull();
    expect(panel()!.open).toBe(false);
  });

  it("UP-11 ignores a response that arrives after its cart was cleared", async () => {
    const old = deferred(); mocks.recommend.mockReturnValueOnce(old.promise);
    await mount(); await addAndRecommend();
    expect(mocks.recommend).toHaveBeenCalledTimes(1);
    press("clear cart", desktop()); await advance();
    await act(async () => old.resolve({ data: [suggestion] })); await advance();
    expect(panel()).toBeNull();
    expect(desktop().querySelector("output")?.textContent).toBe("[]");
  });

  it("UP-11 ignores an old A response after A to B to A and a new cart", async () => {
    const old = deferred(); mocks.recommend.mockReturnValueOnce(old.promise);
    await mount(); await addAndRecommend();
    selectStore("B"); await advance(); await advance();
    selectStore("A"); await advance(); await advance();
    mocks.recommend.mockResolvedValue({ data: [{ ...suggestion, variantId: "fresh", name: "Fresh recommendation" }] });
    await addAndRecommend();
    expect(desktop().textContent).toContain("Fresh recommendation");
    await act(async () => old.resolve({ data: [suggestion] })); await advance();
    expect(desktop().textContent).toContain("Fresh recommendation");
    expect(desktop().textContent).not.toContain("Suggested extra");
  });

  it("UP-12 ignores an older same-scope response resolving after the latest cart request", async () => {
    const old = deferred(); const current = deferred();
    mocks.recommend.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await mount(); await addAndRecommend();
    press("add product"); await advance(250);
    expect(mocks.recommend).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve({ data: [{ ...suggestion, variantId: "fresh", name: "Fresh recommendation" }] })); await advance();
    expect(desktop().textContent).toContain("Fresh recommendation");
    await act(async () => old.resolve({ data: [suggestion] })); await advance();
    expect(desktop().textContent).toContain("Fresh recommendation");
    expect(desktop().textContent).not.toContain("Suggested extra");
  });
});
