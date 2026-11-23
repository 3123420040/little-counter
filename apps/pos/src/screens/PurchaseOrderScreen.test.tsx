// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonByText, changeValue, click, renderTestUi, type TestRender } from "../test/reactTestHarness";

const inventory = vi.hoisted(() => ({
  create: {
    isPending: false,
    mutateAsync: vi.fn(),
  },
}));

const endpoints = vi.hoisted(() => ({
  createClientIdempotencyKey: vi.fn(() => "po-create-stable-ui-intent"),
  downloadPurchaseOrderRecommendationCsv: vi.fn(),
}));

vi.mock("../hooks/useInventory", () => ({
  usePurchaseOrders: () => ({ data: { data: [] }, isLoading: false, error: null, refetch: vi.fn() }),
  useCreatePurchaseOrder: () => inventory.create,
  usePurchaseOrderCatalog: () => ({
    data: {
      data: [{
        variantId: "var_1",
        productId: "prod_1",
        productName: "Stable product",
        variantName: "Default",
        sku: "SKU-STABLE",
        barcode: "",
        categoryNames: ["Test"],
        defaultUnitCost: 100_000,
        defaultUnitCostQuality: "known",
        selected: false,
      }],
      page: { total: 1, limit: 25, offset: 0, hasPrevious: false, hasNext: false },
    },
    isLoading: false,
    error: null,
  }),
}));

vi.mock("../api/endpoints", () => endpoints);
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "po.title": "Đặt hàng",
      "po.create": "Tạo đơn",
      "po.createFirst": "Tạo đơn đầu tiên",
      "po.createTitle": "Tạo đơn đặt hàng",
      "po.emptyOrders": "Chưa có đơn",
      "po.supplier": "Nhà cung cấp",
      "state.confirm": "Xác nhận",
      "state.cancel": "Hủy",
      "state.loading": "Đang tải",
      "state.close": "Đóng",
    }[key] || key),
  }),
}));

vi.mock("../components/ExportTemplateActions", () => ({ ExportTemplateActions: () => null }));
vi.mock("../components/ImportDialog", () => ({ ImportDialog: () => null }));



vi.mock("@medusa-snus/ui", async () => {
  const actual = await vi.importActual<typeof import("@medusa-snus/ui")>("@medusa-snus/ui");
  const React = await import("react");
  return {
    PaginatedListFrame: actual.PaginatedListFrame,
    Button: ({ children, icon: _icon, ...props }: Record<string, unknown>) =>
      React.createElement("button", props, children as React.ReactNode),
    Drawer: ({ open, title, children, actions }: Record<string, unknown>) => open
      ? React.createElement("section", { role: "dialog", "aria-label": title }, children as React.ReactNode, actions as React.ReactNode)
      : null,
    InlineError: ({ message }: { message: string }) => React.createElement("div", { role: "alert" }, message),
    MutationBanner: ({ message }: { message: string }) => React.createElement("div", null, message),
    ListPagination: () => null,
    localListPaginationMeta: (total: number, page: number, pageSize: number) => ({
      page, start: total ? (page - 1) * pageSize + 1 : 0, end: Math.min(total, page * pageSize),
      hasPrevious: page > 1, hasNext: page * pageSize < total, totalKind: "exact", total, pageCount: Math.max(1, Math.ceil(total / pageSize)),
    }),
    loadedListPaginationMeta: (loadedCount: number, page: number, pageSize: number) => ({
      page, start: loadedCount ? (page - 1) * pageSize + 1 : 0, end: Math.min(loadedCount, page * pageSize),
      hasPrevious: page > 1, hasNext: page * pageSize < loadedCount, totalKind: "loaded", loadedCount, pageCount: Math.max(1, Math.ceil(loadedCount / pageSize)),
    }),
    OperationalTable: () => React.createElement("table"),
    PageHeader: ({ title, actions }: Record<string, unknown>) => React.createElement("header", null, title as string, actions as React.ReactNode),
    Panel: ({ children }: { children: React.ReactNode }) => React.createElement("section", null, children),
    StatusPill: ({ label }: { label: string }) => React.createElement("span", null, label),
    TableSkeleton: () => React.createElement("div"),
  };
});

import PurchaseOrderScreen from "./PurchaseOrderScreen";

let mounted: TestRender | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

beforeEach(() => {
  vi.clearAllMocks();
  inventory.create.isPending = false;
  inventory.create.mutateAsync
    .mockRejectedValueOnce(new Error("Response dropped after commit"))
    .mockResolvedValueOnce({ data: { id: "po_1" } });
});

describe("PurchaseOrderScreen create intent", () => {
  it("reuses one caller-owned key after a failed response and clears only after success", async () => {
    mounted = renderTestUi(<PurchaseOrderScreen />);
    click(buttonByText(mounted.container, "Tạo đơn"));

    changeValue(
      mounted.container.querySelector("#po-supplier-name") as HTMLInputElement,
      "Stable supplier",
    );
    const variant = mounted.container.querySelector("#po-variant-line_1") as HTMLSelectElement;
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    act(() => {
      selectSetter?.call(variant, "var_1");
      variant.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const confirm = buttonByText(mounted.container, "Xác nhận");
    await act(async () => {
      confirm.click();
      await Promise.resolve();
    });

    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain("Response dropped after commit");

    await act(async () => {
      buttonByText(mounted!.container, "Xác nhận").click();
      await Promise.resolve();
    });

    expect(endpoints.createClientIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(inventory.create.mutateAsync).toHaveBeenCalledTimes(2);
    expect(inventory.create.mutateAsync.mock.calls[0]?.[0].intentKey).toBe("po-create-stable-ui-intent");
    expect(inventory.create.mutateAsync.mock.calls[1]?.[0].intentKey).toBe("po-create-stable-ui-intent");
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
  });
});
