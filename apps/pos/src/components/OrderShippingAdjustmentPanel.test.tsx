// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, changeValue, renderTestUi, type TestRender } from "../test/reactTestHarness";

const shipping = vi.hoisted(() => ({
  previewMutate: vi.fn(),
  previewReset: vi.fn(),
  applyMutate: vi.fn(),
  applyReset: vi.fn(),
}));

vi.mock("../hooks/useOrders", () => ({
  usePreviewOrderShipping: () => ({
    mutate: shipping.previewMutate,
    reset: shipping.previewReset,
    isPending: false,
    error: null,
  }),
  useUpdateOrderShipping: () => ({
    mutate: shipping.applyMutate,
    reset: shipping.applyReset,
    isPending: false,
    error: null,
  }),
}));

vi.mock("@medusa-snus/ui", async () => {
  const React = await import("react");
  return {
    Button: ({ children, variant: _variant, size: _size, ...props }: Record<string, unknown>) =>
      React.createElement("button", props, children as React.ReactNode),
    InlineError: ({ message }: { message: string }) => React.createElement("div", { role: "alert" }, message),
  };
});

import { OrderShippingAdjustmentPanel } from "./OrderShippingAdjustmentPanel";

const previewResponse = {
  data: {
    orderId: "order_1",
    baseRevision: 2,
    before: { shippingFee: 30_000, shippingTax: 0, shippingRevenue: 30_000, total: 230_000 },
    after: { shippingFee: 50_000, shippingTax: 0, shippingRevenue: 50_000, total: 250_000 },
    shippingFeeDelta: 20_000,
    totalDelta: 20_000,
    settlement: { direction: "collect", method: "cash", amount: 20_000, amountReceived: 20_000, change: 0 },
    effects: {
      orderTotals: "update",
      paymentEntry: "charge",
      auditEvent: "append",
      outboxEvent: "append",
      accountingJournal: "after_outbox_processing",
      inventory: "none",
    },
    confirmationToken: "shipping-confirmation-token",
  },
};

let mounted: TestRender | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.clearAllMocks();
});

async function configureAndPreview() {
  const shippingInput = mounted!.container.querySelector('input[aria-label="Phí vận chuyển sau điều chỉnh"]') as HTMLInputElement;
  const reasonInput = mounted!.container.querySelector('textarea[aria-label="Lý do điều chỉnh phí vận chuyển"]') as HTMLTextAreaElement;
  await changeValue(shippingInput, "50000");
  await changeValue(reasonInput, "Bổ sung phí giao hàng theo xác nhận của khách.");
  await act(async () => buttonByText(mounted!.container, "Xem tác động").click());
}

describe("OrderShippingAdjustmentPanel", () => {
  it("requires a reviewed preview and applies the bound confirmation token", async () => {
    shipping.previewMutate.mockImplementation((_variables, options) => options.onSuccess(previewResponse));
    shipping.applyMutate.mockImplementation((_variables, options) => options.onSuccess());
    mounted = renderTestUi(
      <OrderShippingAdjustmentPanel
        orderId="order_1"
        currentShippingFee={30_000}
        currentTotal={230_000}
        paymentMethod="cash"
        onApplied={vi.fn()}
      />,
    );

    expect(buttonByText(mounted.container, "Xác nhận áp dụng").disabled).toBe(true);
    await configureAndPreview();
    expect(shipping.previewMutate).toHaveBeenCalledWith({
      orderId: "order_1",
      input: {
        shippingFee: 50_000,
        reason: "Bổ sung phí giao hàng theo xác nhận của khách.",
        paymentMethod: "cash",
      },
    }, expect.any(Object));
    expect(mounted.container.textContent).toContain("Cần thu");
    expect(mounted.container.textContent).toContain("20.000 ₫");
    expect(buttonByText(mounted.container, "Xác nhận áp dụng").disabled).toBe(false);

    await act(async () => buttonByText(mounted!.container, "Xác nhận áp dụng").click());
    expect(shipping.applyMutate).toHaveBeenCalledWith({
      orderId: "order_1",
      input: {
        shippingFee: 50_000,
        reason: "Bổ sung phí giao hàng theo xác nhận của khách.",
        paymentMethod: "cash",
        confirmationToken: "shipping-confirmation-token",
      },
    }, expect.any(Object));
  });

  it("invalidates the preview when an input changes", async () => {
    shipping.previewMutate.mockImplementation((_variables, options) => options.onSuccess(previewResponse));
    mounted = renderTestUi(
      <OrderShippingAdjustmentPanel
        orderId="order_1"
        currentShippingFee={30_000}
        currentTotal={230_000}
        paymentMethod="cash"
        onApplied={vi.fn()}
      />,
    );

    await configureAndPreview();
    expect(buttonByText(mounted.container, "Xác nhận áp dụng").disabled).toBe(false);
    const shippingInput = mounted.container.querySelector('input[aria-label="Phí vận chuyển sau điều chỉnh"]') as HTMLInputElement;
    await changeValue(shippingInput, "60000");
    expect(buttonByText(mounted.container, "Xác nhận áp dụng").disabled).toBe(true);
  });
});
