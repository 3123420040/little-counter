// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  renderTestUi,
  buttonByText,
  changeValue,
  click,
  type TestRender,
} from "../../test/reactTestHarness";
import { setToken, ApiError, SCOPE_CHANGED_EVENT } from "../../api/client";
import type { PlatformMcpConnectionDetailV1 } from "@medusa-snus/contracts";
const calls = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  command: vi.fn(),
  merchant: vi.fn(),
  store: vi.fn(),
  mayManage: true,
  operator: {
    id: "synthetic-admin",
    role: "owner",
    displayName: "Synthetic",
    organizationId: "org-default",
  } as {
    id: string;
    role: string;
    displayName: string;
    organizationId: string;
  } | null,
}));
vi.mock("../../api/platform-mcp-endpoints", () => ({
  fetchPlatformMcpConnections: calls.list,
  fetchPlatformMcpConnection: calls.detail,
  executePlatformMcpCommand: calls.command,
}));
vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ operator: calls.operator, requiresPasswordChange: false }),
}));
vi.mock("./usePlatformAdmin", () => ({
  usePlatformAdmin: () => ({
    operator: calls.operator,
    isPlatformAdmin: true,
    canManageMerchantLifecycle: false,
    canManageMerchantMcp: calls.mayManage,
  }),
}));
vi.mock("../../api/settings-endpoints", () => ({
  fetchPlatformMerchantDetail: calls.merchant,
  fetchPlatformStoreDetail: calls.store,
  changePlatformEntityStatus: vi.fn(),
}));
import { PlatformMerchantMcpSection } from "./PlatformMerchantMcpSection";
import PlatformEntityDetailScreen from "./PlatformEntityDetailScreen";
const keyId = "a".repeat(32),
  secret = `snus_mcp_test_${keyId}.${"x".repeat(43)}`;
const merchant: Parameters<typeof PlatformMerchantMcpSection>[0]["merchant"] = {
  merchantId: "m-a",
  displayName: "Merchant A",
  status: "active",
  stores: [
    {
      storeId: "s-a",
      merchantId: "m-a",
      merchantName: "Merchant A",
      internalName: "Store A",
      stockLocationId: "l-a",
      isPrimary: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "active" as const,
      statusVersion: 1,
      merchantStatus: "active" as const,
      effectiveStatus: "active" as const,
    },
  ],
};
const connection: PlatformMcpConnectionDetailV1["connection"] = {
  merchantId: "m-a",
  integrationId: "i-a",
  name: "Agent A",
  environment: "sandbox",
  status: "active",
  writesEnabled: false,
  integrationVersion: 2,
  merchantStatus: "active",
  managedByPlatform: true,
  hasOauthClients: false,
};
const key: PlatformMcpConnectionDetailV1["keys"]["data"][number] = {
  id: keyId,
  version: 1,
  status: "active",
  label: "Synthetic key",
  scopes: ["partner:read", "catalog:read", "inventory:read", "orders:read"],
  expiresAt: "2099-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  revokedAt: null,
};
const detail = (): PlatformMcpConnectionDetailV1 => ({
  connection: { ...connection },
  canRevokeKeys: true,
  mcpUrl: "https://partner.example/mcp",
  authorizationSnapshotSha256: "b".repeat(64),
  authorizationWarning: null,
  maxApprovedProfile: "read",
  keys: { data: [key], nextAfter: null },
  grants: {
    data: [
      {
        storeId: "s-a",
        stockLocationId: "l-a",
        status: "active",
        scopes: key.scopes,
        catalogMode: "merchant_published",
        version: 1,
        assortmentId: "assort-a",
        storeStatus: "active",
      },
    ],
    nextAfter: null,
  },
  receipts: { data: [], nextAfter: null },
});
const first = () => ({
  data: {
    receiptId: "81de7598-a399-4bf0-af9f-4dc973533c3e",
    merchantId: "m-a",
    integrationId: "i-a",
    environment: "sandbox",
    integrationVersion: 2,
    integrationStatus: "active",
    writesEnabled: false,
    mcpUrl: "https://partner.example/mcp",
    key: {
      id: key.id,
      version: key.version,
      status: key.status,
      label: key.label,
      scopes: key.scopes,
      expiresAt: key.expiresAt,
    },
  },
  replayed: false,
  requestState: "completed",
  secretStatus: "available_once",
  revealedKey: secret,
});
let mounted: TestRender | undefined, client: QueryClient;
const wrap = (data = merchant) => (
  <QueryClientProvider client={client}>
    <PlatformMerchantMcpSection merchant={data} />
  </QueryClientProvider>
);
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}
async function openCreate() {
  click(buttonByText(mounted!.container, "Tạo kết nối MCP"));
  changeValue(
    mounted!.container.querySelector('input[aria-label="Tên kết nối MCP"]')!,
    "New agent",
  );
  click(mounted!.container.querySelector('input[type="checkbox"]')!);
}
beforeEach(() => {
  vi.clearAllMocks();
  setToken("synthetic-session-a");
  calls.mayManage = true;
  calls.operator = {
    id: "synthetic-admin",
    role: "owner",
    displayName: "Synthetic",
    organizationId: "org-default",
  };
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  calls.list.mockResolvedValue({
    data: [],
    nextAfter: null,
    canRevokeKeys: true,
    mcpUrl: "https://partner.example/mcp",
  });
  calls.detail.mockResolvedValue(detail());
  calls.command.mockResolvedValue(first());
  calls.merchant.mockResolvedValue({
    data: {
      ...merchant,
      createdAt: merchant.stores[0].createdAt,
      statusVersion: 1,
      packageKey: "basic",
      subscriptionStatus: "active",
      storeCount: 1,
      ownerCount: 0,
      owners: [],
      checkoutPolicy: {
        status: "ok",
        enabled: true,
        version: 1,
        source: "configured",
        updatedAt: null,
        updatedBy: null,
      },
      lifecycleAudit: { data: [], offset: 0, limit: 20, hasMore: false },
    },
  });
  calls.store.mockResolvedValue({
    data: {
      ...merchant.stores[0],
      lifecycleAudit: { data: [], offset: 0, limit: 20, hasMore: false },
    },
  });
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  client.clear();
  setToken(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("merchant MCP section", () => {
  it("mounts on the actual merchant detail route and leaves store detail as a merchant link", async () => {
    mounted = renderTestUi(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/platform/merchants/m-a"]}>
          <Routes>
            <Route
              path="/platform/merchants/:merchantId"
              element={<PlatformEntityDetailScreen kind="merchant" />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await flush();
    await flush();
    expect(buttonByText(mounted.container, "Tạo kết nối MCP")).toBeDefined();
    expect(calls.list).toHaveBeenCalledWith("m-a", undefined);
  });
  it("creates a default-read connection and keeps its secret outside storage/query cache, clearing it on close", async () => {
    mounted = renderTestUi(wrap());
    await flush();
    await openCreate();
    click(buttonByText(mounted.container, "Xác nhận cấp MCP"));
    await flush();
    expect(calls.command).toHaveBeenCalledTimes(1);
    expect(calls.command.mock.calls[0][0]).toBe("m-a");
    expect(calls.command.mock.calls[0][1]).toMatchObject({
      action: "create",
      input: { name: "New agent", profile: "read", storeIds: ["s-a"] },
    });
    expect(
      mounted.container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="MCP key chỉ hiển thị lần này"]',
      )?.value,
    ).toBe(secret);
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(secret);
    expect(
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ).not.toContain(secret);
    click(buttonByText(mounted.container, "Đã lưu, đóng"));
    expect(
      mounted.container.querySelector(
        'textarea[aria-label="MCP key chỉ hiển thị lần này"]',
      ),
    ).toBeNull();
  });
  it.each(["readonly", "inactive-merchant"])(
    "does not allow provisioning for %s",
    async (state) => {
      if (state === "readonly") calls.mayManage = false;
      mounted = renderTestUi(
        wrap(
          state === "inactive-merchant"
            ? { ...merchant, status: "suspended" }
            : merchant,
        ),
      );
      await flush();
      const create = Array.from(
        mounted.container.querySelectorAll("button"),
      ).find((button) => button.textContent?.includes("Tạo kết nối MCP"));
      expect(!create || create.disabled).toBe(true);
      expect(calls.command).not.toHaveBeenCalled();
    },
  );
  it("keeps one frozen request after an unknown outcome and never re-reveals replay metadata", async () => {
    let reject!: (error: unknown) => void;
    calls.command.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    mounted = renderTestUi(wrap());
    await flush();
    await openCreate();
    const confirm = buttonByText(mounted.container, "Xác nhận cấp MCP");
    click(confirm);
    click(confirm);
    expect(calls.command).toHaveBeenCalledTimes(1);
    await act(async () =>
      reject(
        new ApiError(
          "synthetic unknown outcome",
          503,
          "dependency_unavailable",
        ),
      ),
    );
    await flush();
    const { revealedKey: _discard, ...replay } = first();
    calls.command.mockResolvedValueOnce({
      ...replay,
      replayed: true,
      secretStatus: "unavailable_on_replay",
    });
    click(buttonByText(mounted.container, "Thử lại cùng yêu cầu"));
    await flush();
    expect(calls.command).toHaveBeenCalledTimes(2);
    expect(calls.command.mock.calls[1].slice(0, 3)).toEqual(
      calls.command.mock.calls[0].slice(0, 3),
    );
    expect(mounted.container.textContent).toContain(
      "key không thể hiển thị lại",
    );
    expect(
      mounted.container.querySelector(
        'textarea[aria-label="MCP key chỉ hiển thị lần này"]',
      ),
    ).toBeNull();
  });
  it("requires an explicit commerce selection and describes COD/stock impact", async () => {
    mounted = renderTestUi(wrap());
    await flush();
    await openCreate();
    expect(mounted.container.textContent).toContain("10.000.000 VND/đơn");
    expect(mounted.container.textContent).toContain("100 đơn vị");
    const select = Array.from(
      mounted.container.querySelectorAll("select"),
    ).find((node) => node.value === "read")!;
    act(() => {
      select.value = "commerce";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(mounted.container.textContent).toContain("lên đơn sẽ trừ tồn kho");
    click(buttonByText(mounted.container, "Xác nhận cấp MCP"));
    await flush();
    expect(calls.command.mock.calls[0][1]).toMatchObject({
      action: "create",
      input: { profile: "commerce" },
    });
  });
  it("defaults resume to read even when a commerce-approved connection currently writes", async () => {
    const data = detail();
    data.maxApprovedProfile = "commerce";
    data.connection.writesEnabled = true;
    calls.list.mockResolvedValue({
      data: [data.connection],
      nextAfter: null,
      canRevokeKeys: true,
      mcpUrl: data.mcpUrl,
    });
    calls.detail.mockResolvedValue(data);
    calls.command.mockResolvedValue({
      data: { ...first().data, key: null },
      replayed: false,
      requestState: "completed",
      secretStatus: "not_applicable",
    });
    mounted = renderTestUi(wrap());
    await flush();
    click(buttonByText(mounted.container, "Agent A"));
    await flush();
    click(buttonByText(mounted.container, "Chọn quyền hoạt động"));
    expect(
      Array.from(mounted.container.querySelectorAll("select")).find(
        (node) => node.value === "read",
      ),
    ).toBeDefined();
    click(buttonByText(mounted.container, "Xác nhận"));
    await flush();
    expect(calls.command.mock.calls[0][1]).toMatchObject({
      action: "status",
      input: { status: "active", profile: "read" },
    });
  });
  it("keeps revoke usable after a known readiness refusal", async () => {
    calls.list.mockResolvedValue({
      data: [connection],
      nextAfter: null,
      canRevokeKeys: true,
      mcpUrl: detail().mcpUrl,
    });
    calls.command.mockRejectedValueOnce(
      new ApiError(
        "synthetic readiness refusal",
        503,
        "mcp_readiness_unavailable",
      ),
    );
    mounted = renderTestUi(wrap());
    await flush();
    click(buttonByText(mounted.container, "Agent A"));
    await flush();
    click(buttonByText(mounted.container, "Cấp thêm key"));
    click(buttonByText(mounted.container, "Xác nhận"));
    await flush();
    expect(mounted.container.textContent).toContain(
      "Hạ tầng MCP chưa đủ điều kiện",
    );
    click(buttonByText(mounted.container, "Tải lại metadata"));
    await flush();
    click(buttonByText(mounted.container, "Thu hồi key"));
    calls.command.mockResolvedValueOnce({
      data: {
        ...first().data,
        key: { ...first().data.key, status: "revoked", version: 2 },
      },
      replayed: false,
      requestState: "completed",
      secretStatus: "not_applicable",
    });
    click(buttonByText(mounted.container, "Xác nhận"));
    await flush();
    expect(calls.command.mock.calls[1][1]).toMatchObject({
      action: "revoke",
      keyId,
      input: { expectedKeyVersion: 1 },
    });
  });
  it("bounds a stalled command and retains the exact attempt for reconciliation", async () => {
    calls.command.mockImplementationOnce(
      (_merchant, _command, _key, signal: AbortSignal) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("synthetic timeout", "AbortError")),
            { once: true },
          );
        }),
    );
    mounted = renderTestUi(wrap());
    await flush();
    await openCreate();
    vi.useFakeTimers();
    click(buttonByText(mounted.container, "Xác nhận cấp MCP"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_010);
    });
    vi.useRealTimers();
    await flush();
    expect(calls.command.mock.calls[0][3].aborted).toBe(true);
    expect(calls.command).toHaveBeenCalledTimes(1);
    expect(mounted.container.textContent).toContain(
      "Chưa xác nhận được kết quả",
    );
    expect(
      buttonByText(mounted.container, "Thử lại cùng yêu cầu").disabled,
    ).toBe(false);
  });
  it("limits shared OAuth to new read keys and hides generic status controls", async () => {
    const data = detail();
    data.connection.hasOauthClients = true;
    calls.list.mockResolvedValue({
      data: [data.connection],
      nextAfter: null,
      canRevokeKeys: true,
      mcpUrl: data.mcpUrl,
    });
    calls.detail.mockResolvedValue(data);
    mounted = renderTestUi(wrap());
    await flush();
    click(buttonByText(mounted.container, "Agent A"));
    await flush();
    expect(
      Array.from(mounted.container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Tạm dừng kết nối"),
      ),
    ).toBe(false);
    click(buttonByText(mounted.container, "Cấp thêm key"));
    expect(
      mounted.container.querySelector<HTMLOptionElement>(
        'option[value="commerce"]',
      )?.disabled,
    ).toBe(true);
  });
  it("reconciles an outcome that arrives after the command deadline", async () => {
    let resolve!: (value: unknown) => void;
    calls.command.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    mounted = renderTestUi(wrap());
    await flush();
    await openCreate();
    vi.useFakeTimers();
    click(buttonByText(mounted.container, "Xác nhận cấp MCP"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_010);
      resolve(first());
    });
    vi.useRealTimers();
    await flush();
    expect(mounted.container.textContent).toContain(
      "Chưa xác nhận được kết quả",
    );
    expect(mounted.container.textContent).not.toContain(secret);
    const original = calls.command.mock.calls[0];
    calls.command.mockResolvedValueOnce({
      data: first().data,
      replayed: true,
      requestState: "completed",
      secretStatus: "unavailable_on_replay",
    });
    click(buttonByText(mounted.container, "Thử lại cùng yêu cầu"));
    await flush();
    expect(calls.command.mock.calls[1].slice(0, 3)).toEqual(
      original.slice(0, 3),
    );
  });
  it.each([
    "merchant-roundtrip",
    "new-session",
    "permission-roundtrip",
    "logout",
    "scope-event",
    "unmount",
  ])("discards late credentials after %s", async (change) => {
    let resolve!: (value: unknown) => void;
    calls.command.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    mounted = renderTestUi(wrap());
    await flush();
    await openCreate();
    click(buttonByText(mounted.container, "Xác nhận cấp MCP"));
    if (change === "merchant-roundtrip") {
      mounted.rerender(wrap({ ...merchant, merchantId: "m-b" }));
      mounted.rerender(wrap());
    }
    if (change === "new-session") {
      setToken("synthetic-session-b");
      mounted.rerender(wrap());
    }
    if (change === "permission-roundtrip") {
      calls.mayManage = false;
      mounted.rerender(wrap());
      calls.mayManage = true;
      mounted.rerender(wrap());
    }
    if (change === "logout") {
      calls.operator = null;
      setToken(null);
      mounted.rerender(wrap());
    }
    if (change === "scope-event")
      act(() => {
        window.dispatchEvent(new Event(SCOPE_CHANGED_EVENT));
      });
    if (change === "unmount") {
      mounted.unmount();
      mounted = undefined;
    }
    await act(async () => resolve(first()));
    await flush();
    expect(
      mounted?.container.querySelector(
        'textarea[aria-label="MCP key chỉ hiển thị lần này"]',
      ) ?? null,
    ).toBeNull();
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(secret);
    expect(calls.command).toHaveBeenCalledTimes(1);
  });
  it("freezes consent CAS at dialog open rather than silently accepting a background grant change", async () => {
    calls.list.mockResolvedValue({
      data: [connection],
      nextAfter: null,
      canRevokeKeys: true,
      mcpUrl: "https://partner.example/mcp",
    });
    mounted = renderTestUi(wrap());
    await flush();
    click(buttonByText(mounted.container, "Agent A"));
    await flush();
    click(buttonByText(mounted.container, "Cấp thêm key"));
    calls.detail.mockResolvedValue({
      ...detail(),
      authorizationSnapshotSha256: "c".repeat(64),
      connection: { ...connection, integrationVersion: 3 },
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["platformMcp"] });
    });
    await flush();
    click(buttonByText(mounted.container, "Xác nhận"));
    await flush();
    expect(calls.command.mock.calls[0][1]).toMatchObject({
      action: "issue",
      input: {
        expectedIntegrationVersion: 2,
        expectedAuthorizationSnapshotSha256: "b".repeat(64),
        profile: "read",
      },
    });
  });
  it("paginates keys, stores and history independently", async () => {
    calls.list.mockResolvedValue({
      data: [connection],
      nextAfter: "i-next",
      canRevokeKeys: true,
      mcpUrl: "https://partner.example/mcp",
    });
    const data = detail();
    data.keys.nextAfter = "b".repeat(32);
    data.grants.nextAfter = "s-next";
    data.receipts.nextAfter = "81de7598-a399-4bf0-af9f-4dc973533c3e";
    calls.detail.mockResolvedValue(data);
    mounted = renderTestUi(wrap());
    await flush();
    click(buttonByText(mounted.container, "Agent A"));
    await flush();
    click(buttonByText(mounted.container, "Key: sau"));
    await flush();
    expect(calls.detail.mock.lastCall?.[2]).toMatchObject({
      keysAfter: "b".repeat(32),
      grantsAfter: undefined,
      receiptsAfter: undefined,
    });
    click(buttonByText(mounted.container, "Cửa hàng: sau"));
    await flush();
    expect(calls.detail.mock.lastCall?.[2]).toMatchObject({
      keysAfter: "b".repeat(32),
      grantsAfter: "s-next",
    });
    click(buttonByText(mounted.container, "Lịch sử: sau"));
    await flush();
    expect(calls.detail.mock.lastCall?.[2]).toMatchObject({
      receiptsAfter: data.receipts.nextAfter,
    });
  });
  it("keeps form focus stable and traps Tab within the dialog", async () => {
    mounted = renderTestUi(wrap());
    await flush();
    const trigger = buttonByText(mounted.container, "Tạo kết nối MCP");
    trigger.focus();
    click(trigger);
    const field = mounted.container.querySelector<HTMLInputElement>(
      'input[aria-label="Tên kết nối MCP"]',
    )!;
    field.focus();
    changeValue(field, "Synthetic");
    expect(document.activeElement).toBe(field);
    const dialog = mounted.container.querySelector('[role="dialog"]')!,
      closeButton = buttonByText(dialog as HTMLElement, "Đóng");
    closeButton.focus();
    act(() =>
      closeButton.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          shiftKey: true,
        }),
      ),
    );
    expect(dialog.contains(document.activeElement)).toBe(true);
    click(closeButton);
    expect(document.activeElement).toBe(trigger);
  });
  it("restores dialog focus when async submission blurred the disabled confirm button", async () => {
    let resolve!: (value: ReturnType<typeof first>) => void;
    calls.command.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    mounted = renderTestUi(wrap());
    await flush();
    await openCreate();
    const confirm = buttonByText(mounted.container, "Xác nhận cấp MCP");
    confirm.focus();
    click(confirm);
    expect(confirm.disabled).toBe(true);
    // Real Chromium drops focus to BODY when the focused submit button becomes disabled.
    act(() => {
      const previous = document.body.getAttribute("tabindex");
      document.body.tabIndex = -1;
      document.body.focus();
      if (previous === null) document.body.removeAttribute("tabindex");
      else document.body.setAttribute("tabindex", previous);
    });
    expect(document.activeElement).toBe(document.body);
    await act(async () => resolve(first()));
    await flush();
    const dialog = mounted.container.querySelector('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    const copy = buttonByText(dialog as HTMLElement, "Sao chép key");
    copy.focus();
    await flush();
    expect(document.activeElement).toBe(copy);
  });
  it("copies/downloads only on request and revokes the download URL when the secret closes", async () => {
    const copy = vi.fn().mockResolvedValue(undefined),
      createUrl = vi.fn().mockReturnValue("blob:synthetic"),
      revoke = vi.fn();
    vi.stubGlobal(
      "navigator",
      Object.assign(Object.create(navigator), {
        clipboard: { writeText: copy },
      }),
    );
    const BaseUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends BaseUrl {
        static createObjectURL = createUrl;
        static revokeObjectURL = revoke;
      },
    );
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );
    mounted = renderTestUi(wrap());
    await flush();
    await openCreate();
    click(buttonByText(mounted.container, "Xác nhận cấp MCP"));
    await flush();
    expect(copy).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
    click(buttonByText(mounted.container, "Sao chép key"));
    await flush();
    expect(copy).toHaveBeenCalledExactlyOnceWith(secret);
    click(buttonByText(mounted.container, "Tải cấu hình"));
    expect(createUrl).toHaveBeenCalledTimes(1);
    const guide = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(createUrl.mock.calls[0][0]);
    });
    expect(JSON.parse(guide)).toMatchObject({
      url: "https://partner.example/mcp",
      transport: "streamable-http",
      headers: { Authorization: `Bearer ${secret}` },
      merchantId: "m-a",
      integrationId: "i-a",
      keyId,
      scopes: key.scopes,
      expiresAt: key.expiresAt,
      writesEnabled: false,
      storeIds: ["s-a"],
      catalogMode: "merchant_published",
      policyVersion: "platform-mcp-v1",
    });
    expect(revoke).not.toHaveBeenCalled();
    click(buttonByText(mounted.container, "Đã lưu, đóng"));
    expect(revoke).toHaveBeenCalledWith("blob:synthetic");
  });
});
