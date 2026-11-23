// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, click, renderTestUi, type TestRender } from "../test/reactTestHarness";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  usePrefill: vi.fn(),
}));

vi.mock("@medusa-snus/ui", async () => {
  const actual = await vi.importActual<typeof import("@medusa-snus/ui")>("@medusa-snus/ui");
  const React = await import("react");
  return {
    PaginatedListFrame: actual.PaginatedListFrame,
    Button: ({ children, variant: _variant, ...props }: Record<string, unknown>) => React.createElement("button", props, children as any),
    InlineError: ({ message }: { message: string }) => React.createElement("div", null, message),
    ListPagination: ({ label }: { label: string }) => React.createElement("div", null, label),
    localListPaginationMeta: (total: number, page: number, pageSize: number) => ({ total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), totalKind: "exact", hasPrevious: page > 1, hasNext: page * pageSize < total }),
    StatusPill: ({ label }: { label: string }) => React.createElement("span", null, label),
  };
});



// Prevent the chain import of api/client.ts which calls localStorage
vi.mock("../api/endpoints", () => ({
  fetchOrderRecreatePrefill: vi.fn(),
  cancelOrderWithConfirmation: vi.fn(),
}));

vi.mock("../hooks/useOrders", () => ({
  useOrderRecreatePrefill: mocks.usePrefill,
  useCancelOrder: vi.fn(() => ({ mutate: vi.fn(), isPending: false, error: null })),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: vi.fn(() => mocks.navigate),
  useLocation: vi.fn(() => ({ state: null })),
}));

// Now it's safe to import
import { OrderRecreateModal } from "./OrderRecreateModal";

const prefill = {
  sourceOrderId: "order_1",
  sourceOrderNumber: "ORD-001",
  customer: { id: "cus_1", phone: "090", name: "Khách thử" },
  items: [
    {
      variantId: "var_available",
      productId: "prod_available",
      productName: "Sản phẩm còn bán",
      sku: "SKU-OK",
      quantity: 2,
      unitPrice: 120000,
      stockLevel: 10,
      warning: "Giá đã đổi từ 100.000 ₫ thành 120.000 ₫.",
      priceChanged: true,
      originalPrice: 100000,
    },
    {
      variantId: "var_missing",
      productId: "prod_missing",
      productName: "Sản phẩm đã ngừng bán",
      sku: "SKU-GONE",
      quantity: 1,
      unitPrice: 50000,
      stockLevel: 0,
      unavailable: true,
      warning: "Sản phẩm đang ngừng bán.",
    },
  ],
  unavailableCount: 1,
  warningCount: 2,
};

let mounted: TestRender | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.clearAllMocks();
});

describe("OrderRecreateModal structure", () => {
  it("exports a function component", () => {
    expect(typeof OrderRecreateModal).toBe("function");
  });

  it("has a component name containing Recreate", () => {
    expect(OrderRecreateModal.name).toContain("Recreate");
  });
});

describe("OrderRecreatePrefill shape contract", () => {
  it("matches the fields expected by cart preload", () => {
    const prefill = {
      sourceOrderId: "order_1",
      sourceOrderNumber: "ORD-001",
      customer: null as { id: string; phone?: string; name?: string } | null,
      items: [
        {
          variantId: "var_1",
          productId: "prod_1",
          productName: "Test Product",
          sku: "SKU-001",
          quantity: 2,
          unitPrice: 120000,
          stockLevel: 10,
          warning: "Giá đã đổi",
          priceChanged: true,
          originalPrice: 100000,
        } as const,
      ],
      unavailableCount: 0,
      warningCount: 1,
    };
    expect(prefill.sourceOrderId).toBeTruthy();
    expect(prefill.sourceOrderNumber).toBeTruthy();
    expect(prefill.items.length).toBe(1);
    expect(typeof prefill.unavailableCount).toBe("number");
    expect(typeof prefill.warningCount).toBe("number");
    expect(prefill.items[0].variantId).toBeTruthy();
    expect(prefill.items[0].quantity).toBeGreaterThan(0);
    expect(prefill.items[0].priceChanged).toBe(true);
    expect(typeof prefill.items[0].originalPrice).toBe("number");
  });

  it("supports unavailable items", () => {
    const item = { variantId: "v", productName: "Gone", sku: "", quantity: 1, unitPrice: 0, stockLevel: 0, unavailable: true, warning: "Không còn tồn tại" };
    expect(item.unavailable).toBe(true);
    expect(item.warning).toBeTruthy();
  });

  it("supports nullable customer", () => {
    const withCust = { id: "cus_1", phone: "090", name: "A" };
    expect(withCust.id).toBeTruthy();
    const withoutCust: { id: string; phone?: string; name?: string } | null = null;
    expect(withoutCust).toBeNull();
  });
});

describe("OrderRecreateModal behavior", () => {
  it("requires acknowledgement again after pricing refresh and preserves the captured store for navigation", () => {
    const sourceScope = { merchantId: "merchant-a", storeId: "store-a" };
    mocks.usePrefill.mockReturnValue({ data: { ...prefill, sourceScope }, isLoading: false, error: null, refetch: vi.fn() });
    const props = { open: true, orderId: "order_1", orderNumber: "ORD-001", onClose: vi.fn() };
    mounted = renderTestUi(<OrderRecreateModal {...props} />);
    click(mounted.container.querySelector('input[type="checkbox"]')!);
    expect(buttonByText(mounted.container, "Đưa vào giỏ hàng").disabled).toBe(false);
    mocks.usePrefill.mockReturnValue({ data: { ...prefill, sourceScope, items: prefill.items.map(item => ({ ...item, unitPrice: 140000 })) }, isLoading: false, error: null, refetch: vi.fn() });
    mounted.rerender(<OrderRecreateModal {...props} />);
    expect(buttonByText(mounted.container, "Đưa vào giỏ hàng").disabled).toBe(true);
    click(mounted.container.querySelector('input[type="checkbox"]')!);
    click(buttonByText(mounted.container, "Đưa vào giỏ hàng"));
    expect(mocks.navigate).toHaveBeenCalledWith("/pos", { state: { prefillCart: expect.objectContaining({ sourceScope,
      items: [expect.objectContaining({ variantId: "var_available", unitPrice: 140000 })] }) } });
    expect(mocks.navigate.mock.calls.at(-1)![1].state.prefillCart).not.toHaveProperty("paymentFeeMinor");
  });
  it("shows current warnings, requires acknowledgement, and skips unavailable items", () => {
    mocks.usePrefill.mockReturnValue({ data: prefill, isLoading: false, error: null, refetch: vi.fn() });
    const onClose = vi.fn();
    mounted = renderTestUi(
      <OrderRecreateModal
        open
        orderId="order_1"
        orderNumber="ORD-001"
        onClose={onClose}
      />,
    );

    expect(mounted.container.textContent).toContain("Sản phẩm còn bán");
    expect(mounted.container.textContent).toContain("Sản phẩm đã ngừng bán");
    expect(mounted.container.textContent).toContain("Giá đã đổi từ");
    expect(mounted.container.textContent).toContain("Không khả dụng — sẽ bị bỏ qua");

    const submit = buttonByText(mounted.container, "Đưa vào giỏ hàng");
    expect(submit.disabled).toBe(true);
    click(mounted.container.querySelector('input[type="checkbox"]') as HTMLInputElement);
    expect(submit.disabled).toBe(false);
    click(submit);

    expect(mocks.navigate).toHaveBeenCalledWith("/pos", {
      state: {
        prefillCart: {
          sourceOrderId: "order_1",
          sourceOrderNumber: "ORD-001",
          customer: prefill.customer,
          items: [expect.objectContaining({ variantId: "var_available", quantity: 2 })],
        },
      },
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("requires a fresh acknowledgement after close and reopen", () => {
    mocks.usePrefill.mockReturnValue({ data: prefill, isLoading: false, error: null, refetch: vi.fn() });
    const props = { orderId: "order_1", orderNumber: "ORD-001", onClose: vi.fn() };
    mounted = renderTestUi(<OrderRecreateModal open {...props} />);
    click(mounted.container.querySelector('input[type="checkbox"]') as HTMLInputElement);
    expect(buttonByText(mounted.container, "Đưa vào giỏ hàng").disabled).toBe(false);

    mounted.rerender(<OrderRecreateModal open={false} {...props} />);
    mounted.rerender(<OrderRecreateModal open {...props} />);

    expect((mounted.container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    expect(buttonByText(mounted.container, "Đưa vào giỏ hàng").disabled).toBe(true);
  });

  it("explains an invalid store timezone without exposing the backend error", () => {
    mocks.usePrefill.mockReturnValue({
      data: null,
      isLoading: false,
      error: Object.assign(new Error("Store timezone configuration is invalid"), { code: "store_timezone_invalid" }),
      refetch: vi.fn(),
    });
    mounted = renderTestUi(<OrderRecreateModal open orderId="order_1" orderNumber="ORD-001" onClose={vi.fn()} />);

    expect(mounted.container.textContent).toContain("Cấu hình múi giờ của cửa hàng không hợp lệ");
    expect(mounted.container.textContent).not.toContain("Store timezone configuration is invalid");
  });
});
