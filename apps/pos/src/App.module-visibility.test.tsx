// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { click, renderTestUi, type TestRender } from "./test/reactTestHarness";

const mocks = vi.hoisted(() => ({ me: vi.fn(), telegram: vi.fn(), hiddenMount: vi.fn(), posMount: vi.fn() }));
vi.mock("./hooks/useAuth", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ operator: { id: "test-operator", role: "owner" }, isAuthenticated: true, logout: vi.fn() }),
}));
vi.mock("./hooks/useRuntimeCapabilities", () => ({
  RuntimeCapabilitiesProvider: ({ children }: { children: ReactNode }) => children,
  useRuntimeCapabilities: () => ({ selected: { checkoutWrite: "v1" }, surfaces: { checkoutWrite: "enabled" } }),
  usePaymentFeeRuntimeBuild: () => null,
}));
vi.mock("./api/settings-endpoints", async (original) => ({
  ...await original<typeof import("./api/settings-endpoints")>(), fetchMe: mocks.me,
}));
vi.mock("./api/endpoints", async (original) => ({
  ...await original<typeof import("./api/endpoints")>(), fetchTelegramSalesDrafts: mocks.telegram,
}));
vi.mock("./screens/PosScreen", () => ({ default: () => { mocks.posMount(); return <div>POS surface</div>; } }));
vi.mock("./screens/OrderHistoryScreen", () => ({ default: () => <div>Orders surface</div> }));
vi.mock("./screens/DashboardScreen", () => ({ default: () => <div>Dashboard surface</div> }));
vi.mock("./screens/account/AccountLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("./screens/account/AccountProfileScreen", () => ({ default: () => <div>Account surface</div> }));
vi.mock("./screens/platform/PlatformLayout", () => ({ PlatformLayout: ({ children }: { children: ReactNode }) => children }));
vi.mock("./screens/platform/PlatformMerchantsScreen", () => ({ default: () => <div>Platform surface</div> }));
vi.mock("./screens/ShiftManagementScreen", () => ({ default: () => { mocks.hiddenMount(); return null; } }));
vi.mock("./screens/TelegramSalesInboxScreen", () => ({ default: () => { mocks.hiddenMount(); return null; } }));
vi.mock("./screens/AccountingScreen", () => ({ default: () => { mocks.hiddenMount(); return null; } }));
vi.mock("./screens/AiReviewScreen", () => ({ default: () => { mocks.hiddenMount(); return null; } }));
vi.mock("./screens/PartnerOperationsScreen", () => ({ default: () => { mocks.hiddenMount(); return null; } }));

import App from "./App";

let ui: TestRender | undefined;
let queryClient: QueryClient;
const defaultMe = {
  operatorId: "test-operator", displayName: "Test owner", role: "owner", isPlatformAdmin: false,
  permissionVersion: "test-permissions",
  permissionIds: ["orders:read", "reports:read", "accounting:read", "partner:logs_read"],
  merchant: { merchantId: "merchant-a" },
  stores: [{ storeId: "store-a", merchantId: "merchant-a", displayName: "A", isPrimary: true }],
};

function Location() { return <output data-testid="location">{useLocation().pathname}</output>; }
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function mount(path = "/pos") {
  ui = renderTestUi(<MemoryRouter initialEntries={[path]}><QueryClientProvider client={queryClient}>
    <App /><Location />
  </QueryClientProvider></MemoryRouter>);
  await flush(); await flush();
}

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear();
  mocks.me.mockResolvedValue(defaultMe);
  mocks.telegram.mockResolvedValue({ count: 0, data: [] });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
});
afterEach(() => { ui?.unmount(); ui = undefined; queryClient.clear(); vi.useRealTimers(); });

describe("mounted POS module visibility", () => {
  it("removes all five module links from desktop and mobile More without hiding remaining pages", async () => {
    await mount();
    const more = [...ui!.container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Thêm");
    expect(more).toBeTruthy(); click(more!);
    const labels = [...ui!.container.querySelectorAll("button")].map((button) => button.textContent?.trim());
    for (const label of ["Ca làm", "Telegram", "Telegram Sales", "Kế toán", "TC", "AI Review", "Vận hành đối tác"]) {
      expect(labels).not.toContain(label);
    }
    expect(labels).toContain("Đơn hàng");
    expect(labels).toContain("Sản phẩm");
    expect(mocks.hiddenMount).not.toHaveBeenCalled();
    expect(mocks.telegram).not.toHaveBeenCalled();
  });

  it.each(["/shifts", "/telegram-sales", "/accounting", "/ai", "/partner-operations/history?view=all"])(
    "redirects %s with a notice before mounting a hidden screen",
    async (path) => {
      await mount(path);
      expect(ui!.container.querySelector('[data-testid="location"]')?.textContent).toBe("/pos");
      expect(ui!.container.querySelector('[role="status"]')?.textContent).toContain("đang được ẩn");
      expect(ui!.container.textContent).toContain("POS surface");
      expect(mocks.hiddenMount).not.toHaveBeenCalled();
      expect(mocks.telegram).not.toHaveBeenCalled();
    },
  );

  it("does not poll the Telegram badge when the module is hidden", async () => {
    await mount(); vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.telegram).not.toHaveBeenCalled();
  });

  it.each([
    { permissionIds: ["orders:read"], path: "/orders", surface: "Orders surface" },
    { permissionIds: ["reports:read"], path: "/dashboard", surface: "Dashboard surface" },
    { permissionIds: ["platform:read"], path: "/platform/merchants", surface: "Platform surface" },
    { permissionIds: [], path: "/account", surface: "Account surface" },
  ])("uses $path when POS has no operating scope", async ({ permissionIds, path, surface }) => {
    mocks.me.mockResolvedValue({ ...defaultMe, stores: [], merchant: null, permissionIds });
    await mount("/accounting");
    expect(ui!.container.querySelector('[data-testid="location"]')?.textContent).toBe(path);
    expect(ui!.container.textContent).toContain(surface);
    expect(mocks.hiddenMount).not.toHaveBeenCalled();
  });

  it.each(["/", "/pos", "/settings", "/accounting"])("keeps a history-only session on readable pages from %s", async path => {
    sessionStorage.setItem("snus_operating_store_id", "suspended-store");
    sessionStorage.setItem("snus_operating_merchant_id", "suspended-merchant");
    mocks.me.mockResolvedValue({ ...defaultMe, stores: [], merchant: null, permissionIds: [],
      historicalPermissionIds: ["orders:read", "reports:read"], historicalStores: [{
        storeId: "suspended-store", merchantId: "suspended-merchant", displayName: "Suspended store",
        merchantDisplayName: "Suspended merchant", isPrimary: true, status: "active", merchantStatus: "suspended",
      }] });
    await mount(path);
    expect(ui!.container.querySelector('[data-testid="location"]')?.textContent).toBe("/orders");
    expect(ui!.container.textContent).toContain("Orders surface");
    expect(ui!.container.textContent).not.toContain("POS surface");
    expect(sessionStorage.getItem("snus_operating_store_id")).toBeNull();
    expect(sessionStorage.getItem("snus_operating_merchant_id")).toBeNull();
    expect(sessionStorage.getItem("snus_report_merchant_id")).toBe("suspended-merchant");
    expect(JSON.parse(sessionStorage.getItem("snus_report_store_ids")!)).toEqual(["suspended-store"]);
    const more = [...ui!.container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Thêm");
    click(more!);
    const labels = [...ui!.container.querySelectorAll("button")].map(button => button.textContent?.trim());
    expect(labels).not.toContain("Sản phẩm");
    expect(labels).not.toContain("Quầy");
    expect(mocks.hiddenMount).not.toHaveBeenCalled();
    expect(mocks.posMount).not.toHaveBeenCalled();
  });

  it("waits for the current access proof before mounting the POS or changing saved scope", async () => {
    sessionStorage.setItem("snus_operating_store_id", "store-a");
    sessionStorage.setItem("snus_operating_merchant_id", "merchant-a");
    mocks.me.mockReturnValue(new Promise(() => {}));
    await mount("/pos");
    expect(mocks.posMount).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("snus_operating_store_id")).toBe("store-a");
    expect(sessionStorage.getItem("snus_operating_merchant_id")).toBe("merchant-a");
  });
});
