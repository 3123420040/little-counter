// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, changeValue, click, renderTestUi, type TestRender } from "../test/reactTestHarness";

vi.mock("@medusa-snus/ui", async () => {
  const React = await import("react");
  return {
    Button: ({ children, variant: _variant, ...props }: Record<string, unknown>) =>
      React.createElement("button", props, children as any),
    InlineError: ({ message }: { message: string }) => React.createElement("div", null, message),
    StatusPill: ({ label }: { label: string }) => React.createElement("span", null, label),
  };
});

vi.mock("lucide-react", async () => {
  const React = await import("react");
  return { Landmark: () => React.createElement("span", null, "bank") };
});

import { ManualBankConfirmationDialog } from "./ManualBankConfirmationDialog";

let mounted: TestRender | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("ManualBankConfirmationDialog", () => {
  it("does not accept scope or amount and retains one intent key across a retry", () => {
    const onConfirm = vi.fn();
    const props = {
      open: true,
      orderNumber: "ORD-100",
      onConfirm,
      onCancel: vi.fn(),
    };
    mounted = renderTestUi(<ManualBankConfirmationDialog {...props} />);

    expect(mounted.container.textContent).toMatch(/không cho phép nhập lại/i);
    expect(mounted.container.querySelector("[name='merchantId']")).toBeNull();
    expect(mounted.container.querySelector("[name='amount']")).toBeNull();
    changeValue(
      mounted.container.querySelector("#manual-bank-source-reference") as HTMLInputElement,
      "  VCB-20260816-001  ",
    );
    changeValue(
      mounted.container.querySelector("#manual-bank-confirmed-at") as HTMLInputElement,
      "2026-08-16T10:30",
    );
    click(buttonByText(mounted.container, "Xác nhận đã nhận tiền"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]?.[0]).toEqual({
      sourceReference: "VCB-20260816-001",
      confirmedAt: new Date("2026-08-16T10:30").toISOString(),
    });
    const firstKey = onConfirm.mock.calls[0]?.[1];
    expect(firstKey).toMatch(/^manual-bank-confirmation-/);

    mounted.rerender(<ManualBankConfirmationDialog {...props} errorMessage="Mất phản hồi, hãy thử lại" />);
    expect((mounted.container.querySelector("#manual-bank-source-reference") as HTMLInputElement).value)
      .toBe("  VCB-20260816-001  ");
    click(buttonByText(mounted.container, "Xác nhận đã nhận tiền"));
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm.mock.calls[1]?.[1]).toBe(firstKey);
  });

  it("blocks cancellation and duplicate submit while a request is pending", () => {
    const onCancel = vi.fn();
    mounted = renderTestUi(
      <ManualBankConfirmationDialog
        open
        orderNumber="ORD-101"
        pending
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    expect(buttonByText(mounted.container, "Hủy bỏ").disabled).toBe(true);
    expect(buttonByText(mounted.container, "Đang ghi nhận...").disabled).toBe(true);
  });
});
