// @vitest-environment jsdom
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buttonByText,
  changeValue,
  renderTestUi,
  type TestRender,
} from "../../test/reactTestHarness";
import type {
  PlatformMerchantDetailDto,
  PlatformStoreDetailDto,
} from "../../api/settings-endpoints";
import { ApiError } from "../../api/client";

const mock = vi.hoisted(() => ({
  merchant: vi.fn(),
  store: vi.fn(),
  status: vi.fn(),
  access: {
    operator: { id: "fixture-platform-reader" },
    isPlatformAdmin: true,
    canWritePlatform: false,
    canManageMerchantLifecycle: false,
  },
}));
vi.mock("../../api/settings-endpoints", () => ({
  fetchPlatformMerchantDetail: mock.merchant,
  fetchPlatformStoreDetail: mock.store,
  changePlatformEntityStatus: mock.status,
}));
vi.mock("./usePlatformAdmin", () => ({ usePlatformAdmin: () => mock.access }));
import PlatformEntityDetailScreen from "./PlatformEntityDetailScreen";

const store: PlatformStoreDetailDto = {
  storeId: "store-a",
  merchantId: "merchant-a",
  merchantName: "Merchant A",
  internalName: "Store A",
  isPrimary: true,
  stockLocationId: "stock-a",
  createdAt: "2026-10-26T00:00:00.000Z",
  status: "active",
  statusVersion: 1,
  merchantStatus: "suspended",
  effectiveStatus: "suspended",
  lifecycleAudit: { data: [], offset: 0, limit: 20, hasMore: false },
};
const merchant: PlatformMerchantDetailDto = {
  merchantId: "merchant-a",
  displayName: "Merchant A",
  packageKey: "plus",
  subscriptionStatus: "grace",
  storeCount: 1,
  ownerCount: 1,
  createdAt: store.createdAt,
  status: "suspended",
  statusVersion: 2,
  stores: [store],
  owners: [
    {
      membershipId: "membership-a",
      operatorId: "owner-a",
      displayName: "Owner A",
      scopeType: "merchant",
      storeId: null,
      validFrom: store.createdAt,
      validTo: null,
    },
  ],
  checkoutPolicy: {
    status: "ok",
    enabled: false,
    version: 1,
    source: "configured",
    updatedAt: store.createdAt,
    updatedBy: "fixture-platform-admin",
  },
  lifecycleAudit: {
    data: [
      {
        id: "audit-a",
        actorId: "fixture-platform-admin",
        action: "platform.merchant.status_changed",
        beforeStatus: "active",
        afterStatus: "suspended",
        reason: "UAT pause reason",
        createdAt: store.createdAt,
      },
    ],
    offset: 0,
    limit: 20,
    hasMore: false,
  },
};
let mounted: TestRender | undefined, client: QueryClient;
beforeEach(() => {
  mock.merchant.mockReset().mockResolvedValue({ data: merchant });
  mock.store.mockReset().mockResolvedValue({ data: store });
  mock.access.isPlatformAdmin = true;
  mock.access.canWritePlatform = false;
  mock.access.canManageMerchantLifecycle = false;
  mock.status.mockReset().mockResolvedValue({ data: { entityType: "merchant", entityId: "merchant-a", status: "active", statusVersion: 3, changed: true, statusChangedAt: store.createdAt } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  client.clear();
});
function mount(path = "/platform/merchants/merchant-a") {
  mounted = renderTestUi(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/platform/merchants/:merchantId"
            element={<PlatformEntityDetailScreen kind="merchant" />}
          />
          <Route
            path="/platform/stores/:storeId"
            element={<PlatformEntityDetailScreen kind="store" />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("platform merchant/store details", () => {
  it("shows lifecycle confirmation only with explicit server command authority and requires a reason", async () => {
    mock.access.canManageMerchantLifecycle = true;
    mount(); await settle();
    await act(async () => buttonByText(mounted!.container, "Bật hoạt động").click());
    expect(mounted!.container.querySelector('[role="dialog"]')?.textContent).toContain("Merchant A");
    expect(mounted!.container.querySelector('[role="dialog"]')?.textContent).toContain("merchant-a");
    expect(buttonByText(mounted!.container, "Xác nhận bật").disabled).toBe(true);
    changeValue(mounted!.container.querySelector("textarea")!, "  Ready for business  ");
    await act(async () => buttonByText(mounted!.container, "Xác nhận bật").click()); await settle();
    expect(mock.status).toHaveBeenCalledWith("merchant", "merchant-a", { status: "active", expectedVersion: 2, reason: "Ready for business" }, expect.any(String));
    expect(mounted!.container.querySelector('[role="dialog"]')).toBeNull();
    expect(mock.merchant.mock.calls.length).toBeGreaterThan(1);
  });
  it("keeps the same frozen request key and body when retrying an unknown network outcome", async () => {
    mock.access.canManageMerchantLifecycle = true;
    mock.status.mockRejectedValueOnce(new Error("private backend details"));
    mount(); await settle();
    await act(async () => buttonByText(mounted!.container, "Bật hoạt động").click());
    changeValue(mounted!.container.querySelector("textarea")!, "UAT retry");
    await act(async () => buttonByText(mounted!.container, "Xác nhận bật").click()); await settle();
    expect(mounted!.container.textContent).not.toContain("private backend details");
    expect((mounted!.container.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
    await act(async () => buttonByText(mounted!.container, "Thử lại yêu cầu").click()); await settle();
    expect(mock.status.mock.calls[1]).toEqual(mock.status.mock.calls[0]);
  });
  it("does not show command controls to a platform reader with generic write but without platform_admin authority", async () => {
    mock.access.canWritePlatform = true;
    mount(); await settle();
    expect(mounted!.container.textContent).not.toContain("Bật hoạt động");
    expect(mounted!.container.textContent).not.toContain("Tắt hoạt động");
  });
  it("refreshes after a 409 before allowing a new reviewed request even when the version is unchanged", async () => {
    mock.access.canManageMerchantLifecycle = true;
    mock.status.mockRejectedValueOnce(new ApiError("private response", 409, "parent_suspended"));
    mount(); await settle();
    await act(async () => buttonByText(mounted!.container, "Bật hoạt động").click());
    changeValue(mounted!.container.querySelector("textarea")!, "UAT stale view");
    await act(async () => buttonByText(mounted!.container, "Xác nhận bật").click()); await settle();
    expect(buttonByText(mounted!.container, "Thử lại yêu cầu").disabled).toBe(true);
    await act(async () => buttonByText(mounted!.container, "Tải lại chi tiết").click()); await settle();
    await act(async () => buttonByText(mounted!.container, "Bật hoạt động").click());
    changeValue(mounted!.container.querySelector("textarea")!, "Reviewed fresh state");
    expect(buttonByText(mounted!.container, "Xác nhận bật").disabled).toBe(false);
    await act(async () => buttonByText(mounted!.container, "Xác nhận bật").click()); await settle();
    expect(mock.status.mock.calls[1][3]).not.toBe(mock.status.mock.calls[0][3]);
    expect(mock.status.mock.calls[1][2]).toMatchObject({ reason: "Reviewed fresh state", expectedVersion: 2 });
  });
  it("blocks enabling beneath an inactive parent and exposes no command for closed entities", async () => {
    mock.access.canManageMerchantLifecycle = true;
    mock.store.mockResolvedValue({ data: { ...store, status: "suspended" } });
    mount("/platform/stores/store-a"); await settle();
    expect(buttonByText(mounted!.container, "Bật hoạt động").disabled).toBe(true);
    expect(mounted!.container.textContent).toContain("Cần bật merchant trước");
    mock.store.mockResolvedValue({ data: { ...store, status: "closed", effectiveStatus: "closed" } });
    await act(async () => { await client.invalidateQueries({ queryKey: ["platformEntityDetail"] }); }); await settle();
    expect(mounted!.container.textContent).toContain("Đối tượng đã đóng");
    expect(mounted!.container.textContent).not.toContain("Bật hoạt động");
    expect(mounted!.container.textContent).not.toContain("Tắt hoạt động");
  });
  it("submits once while pending and discards a late result after navigation to another entity", async () => {
    mock.access.canManageMerchantLifecycle = true;
    let finish!: (value: unknown) => void;
    mock.status.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mount(); await settle();
    await act(async () => buttonByText(mounted!.container, "Bật hoạt động").click());
    changeValue(mounted!.container.querySelector("textarea")!, "Pending UAT");
    await act(async () => buttonByText(mounted!.container, "Xác nhận bật").click());
    expect(buttonByText(mounted!.container, "Đang xử lý").disabled).toBe(true);
    await act(async () => buttonByText(mounted!.container, "Đang xử lý").click());
    expect(mock.status).toHaveBeenCalledTimes(1);
    const link = mounted!.container.querySelector('a[href="/platform/stores/store-a"]') as HTMLAnchorElement;
    await act(async () => link.click()); await settle();
    const reads = mock.store.mock.calls.length;
    await act(async () => finish({ data: {} })); await settle();
    expect(mock.store).toHaveBeenCalledTimes(reads);
    expect(mounted!.container.querySelector('[role="dialog"]')).toBeNull();
  });
  it("shows suspended merchant data to a platform reader with subscription and checkout policy distinct", async () => {
    mount();
    await settle();
    expect(mock.merchant).toHaveBeenCalledWith("merchant-a", 0);
    const text = mounted!.container.textContent!;
    for (const expected of [
      "Merchant A",
      "merchant-a",
      "Tạm ngưng",
      "grace",
      "Owner A",
      "owner-a",
      "Tìm thấy hàng khi hết tồn",
      "Tắt",
      "UAT pause reason",
    ])
      expect(text).toContain(expected);
    expect(text).not.toContain("undefined");
    expect(
      mounted!.container.querySelector('input[type="password"]'),
    ).toBeNull();
    expect(mounted!.container.querySelector("button")?.textContent).not.toMatch(
      /Bật|Tắt/,
    );
  });
  it("navigates merchant to store and back to its parent using the actual routes", async () => {
    mount();
    await settle();
    const link = mounted!.container.querySelector(
      'a[href="/platform/stores/store-a"]',
    ) as HTMLAnchorElement;
    expect(link).not.toBeNull();
    await act(async () => link.click());
    await settle();
    expect(mock.store).toHaveBeenCalledWith("store-a", 0);
    expect(mounted!.container.textContent).toContain("Trạng thái hiệu lực");
    expect(mounted!.container.textContent).toContain("stock-a");
    expect(
      mounted!.container.querySelector(
        'a[href="/platform/merchants/merchant-a"]',
      ),
    ).not.toBeNull();
  });
  it("paginates audit by the bound target and bounded offset", async () => {
    mock.merchant.mockImplementation(async (id: string, offset: number) => ({
      data: {
        ...merchant,
        lifecycleAudit: {
          ...merchant.lifecycleAudit,
          offset,
          hasMore: offset === 0,
        },
      },
    }));
    mount();
    await settle();
    expect(buttonByText(mounted!.container, "Trang trước").disabled).toBe(true);
    await act(async () =>
      buttonByText(mounted!.container, "Trang sau").click(),
    );
    await settle();
    expect(mock.merchant).toHaveBeenLastCalledWith("merchant-a", 20);
    expect(buttonByText(mounted!.container, "Trang sau").disabled).toBe(true);
    expect(mounted!.container.textContent).toContain("Trang 2");
  });
  it("does not fetch or display metadata without platform read visibility", async () => {
    mock.access.isPlatformAdmin = false;
    mount();
    await settle();
    expect(mock.merchant).not.toHaveBeenCalled();
    expect(mock.store).not.toHaveBeenCalled();
    expect(mounted!.container.textContent).toContain("Không có quyền");
    expect(mounted!.container.textContent).not.toContain("Owner A");
  });
  it("renders a safe failure and retries the same target", async () => {
    mock.merchant.mockRejectedValueOnce(new Error("private backend material"));
    mount();
    await settle();
    expect(mounted!.container.textContent).toContain("Không thể tải chi tiết");
    expect(mounted!.container.textContent).not.toContain(
      "private backend material",
    );
    await act(async () => buttonByText(mounted!.container, "Thử lại").click());
    await settle();
    expect(mock.merchant).toHaveBeenLastCalledWith("merchant-a", 0);
    expect(mounted!.container.textContent).toContain("Owner A");
  });
});
