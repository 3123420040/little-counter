// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonByText, changeValue, renderTestUi, type TestRender } from "../../test/reactTestHarness";
import { ApiError } from "../../api/client";

const mock = vi.hoisted(() => ({
  create: vi.fn(), key: vi.fn(),
  access: { operator: { id: "test_admin" }, isPlatformAdmin: true, canWritePlatform: true },
}));
vi.mock("../../api/settings-endpoints", () => ({ createPlatformMerchant: mock.create }));
vi.mock("./usePlatformAdmin", () => ({ usePlatformAdmin: () => mock.access }));
vi.mock("../../api/endpoints", () => ({ createClientIdempotencyKey: mock.key }));
import { PlatformCreateMerchantPanel } from "./PlatformCreateMerchantPanel";

let mounted: TestRender | null;
let queryClient: QueryClient;
beforeEach(() => {
  sessionStorage.clear();
  mock.create.mockReset();
  mock.key.mockReset().mockReturnValue("create-merchant-test-key");
  mock.access.isPlatformAdmin = true;
  mock.access.canWritePlatform = true;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { mounted?.unmount(); mounted = null; queryClient.clear(); });
function mount() {
  mounted = renderTestUi(<QueryClientProvider client={queryClient}><PlatformCreateMerchantPanel /></QueryClientProvider>);
}
async function fillAndReview(displayName = "Merchant UI") {
  for (const [name, value] of [["displayName",displayName],["storeName","Primary UI"],["ownerOperatorId","existing_owner"]]) {
    await changeValue(mounted!.container.querySelector(`input[name="${name}"]`) as HTMLInputElement, value);
  }
  await act(async () => buttonByText(mounted!.container,"Xem lại và tạo").click());
}
async function submit() {
  await act(async () => buttonByText(mounted!.container,"Xác nhận tạo merchant").click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

describe("Platform create merchant form", () => {
  it.each([[false,true],[true,false]])("hides creation without platform visibility/write (%s,%s)", (visible,write) => {
    mock.access.isPlatformAdmin = visible; mock.access.canWritePlatform = write;
    mount();
    expect(mounted!.container.textContent).not.toContain("Tạo merchant");
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("reviews the owner before sending, then refreshes the affected lists", async () => {
    mock.create.mockResolvedValue({ data: { merchantId: "merchant_new", storeId: "store_new", ownerOperatorId: "existing_owner", packageKey: "basic" } });
    const invalidate = vi.spyOn(queryClient,"invalidateQueries");
    mount(); await fillAndReview();
    expect(mock.create).not.toHaveBeenCalled();
    expect(mounted!.container.querySelector('[role="dialog"]')?.textContent).toContain("existing_owner");
    await submit();
    expect(mock.create).toHaveBeenCalledWith({ displayName: "Merchant UI", storeName: "Primary UI", timezone: "Asia/Ho_Chi_Minh", ownerOperatorId: "existing_owner" }, "create-merchant-test-key");
    expect(mounted!.container.textContent).toContain("merchant_new");
    for (const key of ["platformMerchants","platformStores","platformMemberships","me"]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] });
    }
    expect(sessionStorage.getItem("snus_platform_merchant_create:test_admin")).toBeNull();
  });
  it("keeps an uncertain request across remount and retries the exact payload/key", async () => {
    mock.create.mockRejectedValueOnce(new TypeError("Network unavailable"));
    mount(); await fillAndReview(); await submit();
    expect((mounted!.container.querySelector('input[name="displayName"]') as HTMLInputElement).disabled).toBe(true);
    const first = mock.create.mock.calls[0];
    mounted!.unmount(); mount();
    expect((mounted!.container.querySelector('input[name="ownerOperatorId"]') as HTMLInputElement).value).toBe("existing_owner");
    mock.create.mockResolvedValueOnce({ data: { merchantId: "recovered", storeId: "store", ownerOperatorId: "existing_owner", packageKey: "basic" } });
    await act(async () => buttonByText(mounted!.container,"Thử lại yêu cầu").click());
    await submit();
    expect(mock.create.mock.calls[1]).toEqual(first);
    expect(mounted!.container.textContent).toContain("recovered");
  });
  it("keeps the completed request locked if clearing saved state fails", async () => {
    mock.create.mockResolvedValue({ data: { merchantId: "merchant_a", storeId: "store_a", ownerOperatorId: "existing_owner", packageKey: "basic" } });
    mount(); await fillAndReview();
    const storage = sessionStorage;
    const remove = vi.fn(() => { throw new Error("Storage unavailable"); });
    vi.stubGlobal("sessionStorage", {
      getItem: storage.getItem.bind(storage), setItem: storage.setItem.bind(storage), removeItem: remove,
    });
    try {
      await submit();
      expect(remove).toHaveBeenCalledWith("snus_platform_merchant_create:test_admin");
      expect((mounted!.container.querySelector('input[name="displayName"]') as HTMLInputElement).disabled).toBe(true);
      expect(mounted!.container.textContent).toContain("Không xóa được trạng thái yêu cầu");
    } finally { vi.unstubAllGlobals(); }
    await act(async () => buttonByText(mounted!.container,"Thử lại yêu cầu").click()); await submit();
    expect(sessionStorage.getItem("snus_platform_merchant_create:test_admin")).toBeNull();
    mock.key.mockReturnValue("second-request-key");
    await fillAndReview(); await submit();
    expect(mock.create.mock.calls[2][1]).toBe("second-request-key");
  });
  it("uses the same intent even for two confirmations before React renders", async () => {
    mock.create.mockRejectedValue(new TypeError("Unknown result"));
    mock.key.mockReturnValueOnce("key-one").mockReturnValue("key-two");
    mount(); await fillAndReview();
    await act(async () => {
      const confirm = buttonByText(mounted!.container,"Xác nhận tạo merchant");
      confirm.click(); confirm.click();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve,10)); });
    expect(mock.create).toHaveBeenCalledTimes(1);
    expect(new Set(mock.create.mock.calls.map((call) => call[1])).size).toBe(1);
  });
  it("unlocks a rejected owner so the request can be corrected", async () => {
    mock.create.mockRejectedValueOnce(new ApiError("Owner không tồn tại",409,"owner_not_available"));
    mount(); await fillAndReview(); await submit();
    expect((mounted!.container.querySelector('input[name="ownerOperatorId"]') as HTMLInputElement).disabled).toBe(false);
    expect(sessionStorage.getItem("snus_platform_merchant_create:test_admin")).toBeNull();
  });
  it("does not let a response from an unmounted form erase a newer merchant request", async () => {
    const result = { data: { merchantId: "merchant_a", storeId: "store_a", ownerOperatorId: "existing_owner", packageKey: "basic" } };
    let finishOld!: (value: typeof result) => void;
    mock.create.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(result).mockRejectedValueOnce(new TypeError("Unknown result for B"));
    mount(); await fillAndReview(); await submit();
    mounted!.unmount(); mount();
    await act(async () => buttonByText(mounted!.container,"Thử lại yêu cầu").click()); await submit();
    mock.key.mockReturnValue("request-b-key");
    await fillAndReview("Merchant B"); await submit();
    await act(async () => { finishOld(result); await new Promise((resolve) => setTimeout(resolve,10)); });
    const saved = JSON.parse(sessionStorage.getItem("snus_platform_merchant_create:test_admin")!);
    expect(saved).toMatchObject({ key: "request-b-key", input: { displayName: "Merchant B" } });
    expect((mounted!.container.querySelector('input[name="displayName"]') as HTMLInputElement).value).toBe("Merchant B");
    expect((mounted!.container.querySelector('input[name="displayName"]') as HTMLInputElement).disabled).toBe(true);
  });
});
