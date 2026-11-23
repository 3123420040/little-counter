// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { buttonByText, changeValue, click, renderTestUi, type TestRender } from "../test/reactTestHarness";

vi.mock("@medusa-snus/ui", async () => {
  const React = await import("react");
  return {
    Button: ({ children, variant: _variant, ...props }: Record<string, unknown>) => React.createElement("button", props, children as any),
    InlineError: ({ message }: { message: string }) => React.createElement("div", null, message),
    StatusPill: ({ label }: { label: string }) => React.createElement("span", null, label),
  };
});

vi.mock("lucide-react", async () => {
  const React = await import("react");
  return { HandCoins: () => React.createElement("span", null, "$") };
});

import {
  OrderRefundDialog,
  validateRefundConfirmation,
  validateRefundReason,
} from "./OrderRefundDialog";

let mounted: TestRender | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("OrderRefundDialog", () => {
  it("requires a meaningful reason and the exact order number", () => {
    expect(validateRefundReason("ngắn")).toContain("8");
    expect(validateRefundReason("Đã trả tiền mặt cho khách")).toBeNull();
    expect(validateRefundConfirmation("sai", "ORD-1")).toContain("ORD-1");
    expect(validateRefundConfirmation("ORD-1", "ORD-1")).toBeNull();
  });

  it("shows the exact payable, never claims a second restock and emits evidence", () => {
    const onConfirm = vi.fn();
    mounted = renderTestUi(
      <OrderRefundDialog
        open
        orderNumber="ORD-20260806-0001"
        orderId="order_1"
        amountMinor={260_000}
        currencyCode="VND"
        minorUnitExponent={0}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    expect(mounted.container.textContent).toContain("260.000 VND");
    expect(mounted.container.textContent).toMatch(/Không hoàn tồn kho lần nữa/i);
    const submit = buttonByText(mounted.container, "Xác nhận đã hoàn tiền");
    expect(submit.disabled).toBe(true);

    changeValue(
      mounted.container.querySelector("#order-refund-reason") as HTMLTextAreaElement,
      "  Đã trả tiền mặt cho khách tại quầy  ",
    );
    changeValue(
      mounted.container.querySelector("#order-refund-confirm") as HTMLInputElement,
      "ORD-20260806-0001",
    );
    expect(submit.disabled).toBe(false);
    click(submit);
    expect(onConfirm).toHaveBeenCalledWith({
      amount: 260_000,
      method: "cash",
      reason: "Đã trả tiền mặt cho khách tại quầy",
      confirmationToken: "ORD-20260806-0001",
    }, expect.stringMatching(/^customer-refund-payout-/));
  });

  it("requires bank evidence and keeps one intent key across retry", () => {
    const onConfirm = vi.fn();
    const props = {
      open: true,
      orderNumber: "ORD-BANK-1",
      orderId: "order_bank_1",
      amountMinor: 125_000,
      currencyCode: "VND",
      minorUnitExponent: 0,
      onConfirm,
      onCancel: vi.fn(),
    };
    mounted = renderTestUi(<OrderRefundDialog {...props} />);
    const method = mounted.container.querySelector("#order-refund-method") as HTMLSelectElement;
    act(() => {
      method.value = "bank_transfer";
      method.dispatchEvent(new Event("change", { bubbles: true }));
    });
    changeValue(
      mounted.container.querySelector("#order-refund-reason") as HTMLTextAreaElement,
      "Đã hoàn tiền qua ngân hàng cho khách",
    );
    changeValue(
      mounted.container.querySelector("#order-refund-confirm") as HTMLInputElement,
      "ORD-BANK-1",
    );
    const submit = buttonByText(mounted.container, "Xác nhận đã hoàn tiền");
    expect(submit.disabled).toBe(true);
    changeValue(
      mounted.container.querySelector("#order-refund-source-reference") as HTMLInputElement,
      "VCB-REFUND-001",
    );
    changeValue(
      mounted.container.querySelector("#order-refund-paid-at") as HTMLInputElement,
      "2026-08-16T10:30",
    );
    expect(submit.disabled).toBe(false);
    click(submit);
    const firstKey = onConfirm.mock.calls[0]?.[1];
    expect(onConfirm.mock.calls[0]?.[0]).toEqual({
      amount: 125_000,
      method: "bank_transfer",
      sourceReference: "VCB-REFUND-001",
      paidAt: new Date("2026-08-16T10:30").toISOString(),
      reason: "Đã hoàn tiền qua ngân hàng cho khách",
      confirmationToken: "ORD-BANK-1",
    });
    mounted.rerender(<OrderRefundDialog {...props} errorMessage="Mất phản hồi" />);
    click(buttonByText(mounted.container, "Xác nhận đã hoàn tiền"));
    expect(onConfirm.mock.calls[1]?.[1]).toBe(firstKey);
  });

  it("fails closed when the payable is zero", () => {
    mounted = renderTestUi(
      <OrderRefundDialog
        open
        orderNumber="ORD-ZERO"
        orderId="order_zero"
        amountMinor={0}
        currencyCode="VND"
        minorUnitExponent={0}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(buttonByText(mounted.container, "Xác nhận đã hoàn tiền").disabled).toBe(true);
  });
});
