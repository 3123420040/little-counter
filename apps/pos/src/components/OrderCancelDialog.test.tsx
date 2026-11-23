// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
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
  return { AlertTriangle: () => React.createElement("span", null, "!") };
});
import {
  validateCancelReason,
  validateCancelConfirmation,
  isCancelBlocked,
  OrderCancelDialog,
} from "./OrderCancelDialog";
import type { CancellationQuoteV1 } from "@medusa-snus/contracts";

function quote(): CancellationQuoteV1 {
  return {
    schemaVersion: 1,
    quoteId: "quote-1",
    orderId: "order_1",
    effectiveRevision: 1,
    idempotencyKey: "cancel-quote-1",
    generatedAt: "2026-08-06T00:00:00.000Z",
    expiresAt: "2026-08-06T00:05:00.000Z",
    paymentBalances: [{
      method: "cash",
      currencyCode: "VND",
      collectedMinor: 260_000,
      refundableMinor: 260_000,
      disposition: "customer_payable",
      evidenceStatus: "verified",
    }],
    stockPreview: [{ lineId: "line-1", quantity: 1, action: "restock" }],
    loyaltyPreview: { pointsToReverse: 0 },
    journalPreview: [],
    payablePreview: [{
      currencyCode: "VND",
      openMinor: 260_000,
      clearMinor: 0,
      balanceMinor: 260_000,
    }],
  };
}

let mounted: TestRender | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("OrderCancelDialog validation", () => {
  describe("validateCancelReason", () => {
    it("accepts a reason between 8 and 500 characters", () => {
      expect(validateCancelReason("Khách hàng đổi ý không mua nữa")).toBeNull();
    });

    it("rejects a reason shorter than 8 characters", () => {
      const err = validateCancelReason("ngắn");
      expect(err).not.toBeNull();
      expect(err).toContain("ít nhất 8");
    });

    it("rejects an empty reason", () => {
      const err = validateCancelReason("");
      expect(err).not.toBeNull();
    });

    it("rejects whitespace-only reason", () => {
      const err = validateCancelReason("        ");
      expect(err).not.toBeNull();
    });

    it("rejects reason longer than 500 characters", () => {
      const err = validateCancelReason("x".repeat(501));
      expect(err).not.toBeNull();
      expect(err).toContain("500");
    });

    it("trims leading/trailing whitespace before checking", () => {
      // "  Khách đổi ý muốn mua sản phẩm khác  " → 34 chars after trim, valid
      expect(validateCancelReason("  Khách đổi ý muốn mua sản phẩm khác  ")).toBeNull();
    });
  });

  describe("validateCancelConfirmation", () => {
    it("accepts exact match against order number", () => {
      expect(validateCancelConfirmation("ORD-202606", "ORD-202606", "order_1")).toBeNull();
    });

    it("accepts exact match against order id when order number is empty", () => {
      expect(validateCancelConfirmation("order_abc", "", "order_abc")).toBeNull();
    });

    it("rejects non-matching confirmation", () => {
      const err = validateCancelConfirmation("WRONG", "ORD-202606", "order_1");
      expect(err).not.toBeNull();
      expect(err).toContain("mã đơn");
    });

    it("rejects empty confirmation", () => {
      const err = validateCancelConfirmation("", "ORD-202606", "");
      expect(err).not.toBeNull();
    });
  });

  describe("isCancelBlocked", () => {
    it("blocks when status is already canceled", () => {
      expect(isCancelBlocked("canceled", false)).toContain("đã được hủy");
    });

    it("does not blanket-block a corrected order that already has a posted refund", () => {
      expect(isCancelBlocked("completed", true)).toBeNull();
    });

    it("allows completed order without refund", () => {
      expect(isCancelBlocked("completed", false)).toBeNull();
    });

    it("allows pending order without refund", () => {
      expect(isCancelBlocked("pending", false)).toBeNull();
    });
  });

  describe("component export", () => {
    it("exports a function component", () => {
      expect(typeof OrderCancelDialog).toBe("function");
    });
  });

  it("renders the safety copy and only submits after reason and exact confirmation", () => {
    const onConfirm = vi.fn();
    mounted = renderTestUi(
      <OrderCancelDialog
        open
        orderNumber="ORD-202606-0001"
        orderId="order_1"
        status="completed"
        quote={quote()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    expect(mounted.container.textContent).toMatch(/chỉ được đánh dấu đã hoàn.*thao tác hoàn tiền riêng/i);
    const submit = buttonByText(mounted.container, "Xác nhận hủy đơn");
    expect(submit.disabled).toBe(true);

    changeValue(mounted.container.querySelector("#order-cancel-reason") as HTMLTextAreaElement, "  Khách hàng đổi ý không mua nữa  ");
    changeValue(mounted.container.querySelector("#order-cancel-confirm") as HTMLInputElement, "ORD-202606-0001");
    expect(submit.disabled).toBe(false);

    click(submit);
    expect(onConfirm).toHaveBeenCalledWith("Khách hàng đổi ý không mua nữa");
  });

  it("keeps cancellation disabled for a posted-refund order", () => {
    mounted = renderTestUi(
      <OrderCancelDialog
        open
        orderNumber="ORD-REFUND"
        orderId="order_refund"
        status="completed"
        blockedReason="Đơn đã có hoàn tiền; hãy dùng quy trình hoàn tiền/đối soát."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(mounted.container.textContent).toMatch(/Đơn đã có hoàn tiền/);
    expect(buttonByText(mounted.container, "Xác nhận hủy đơn").disabled).toBe(true);
    expect((mounted.container.querySelector("#order-cancel-reason") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("clears sensitive confirmation state after close and reopen", () => {
    const props = {
      orderNumber: "ORD-RESET",
      orderId: "order_reset",
      status: "completed",
      quote: quote(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
    mounted = renderTestUi(<OrderCancelDialog open {...props} />);
    changeValue(mounted.container.querySelector("#order-cancel-reason") as HTMLTextAreaElement, "Nhập nhầm đơn hàng");
    changeValue(mounted.container.querySelector("#order-cancel-confirm") as HTMLInputElement, "ORD-RESET");
    expect(buttonByText(mounted.container, "Xác nhận hủy đơn").disabled).toBe(false);

    mounted.rerender(<OrderCancelDialog open={false} {...props} />);
    mounted.rerender(<OrderCancelDialog open {...props} />);

    expect((mounted.container.querySelector("#order-cancel-reason") as HTMLTextAreaElement).value).toBe("");
    expect((mounted.container.querySelector("#order-cancel-confirm") as HTMLInputElement).value).toBe("");
    expect(buttonByText(mounted.container, "Xác nhận hủy đơn").disabled).toBe(true);
  });
});
