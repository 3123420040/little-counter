// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentModal } from "./PaymentModal";
import { buttonByText, click, renderTestUi, type TestRender } from "../test/reactTestHarness";

vi.mock("lucide-react", async () => {
  const React = await import("react");
  const Icon = () => React.createElement("span");
  return { X: Icon, Banknote: Icon, Building2: Icon, Truck: Icon, QrCode: Icon, Wallet: Icon };
});

vi.mock("../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("./CustomerSearch", () => ({
  CustomerSearch: () => null,
}));

let mounted: TestRender | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("PaymentModal commercial total preview", () => {
  it("requires explicit walk-in attribution and submits it with the shared preview", () => {
    const onComplete = vi.fn();
    mounted = renderTestUi(
      <PaymentModal
        subtotal={100000}
        adjustment={{ discountType: "amount", discountValue: 10000, shippingFee: 5000 }}
        onComplete={onComplete}
        onClose={vi.fn()}
      />,
    );

    expect(mounted.container.textContent).toContain("95.000 ₫");
    const complete = buttonByText(mounted.container, "pos.completeSale");
    expect(complete.disabled).toBe(true);
    click(buttonByText(mounted.container, "Khách lẻ"));
    expect(complete.disabled).toBe(false);
    click(complete);
    expect(onComplete).toHaveBeenCalledWith(
      "cash",
      95000,
      { discountType: "amount", discountValue: 10000, shippingFee: 5000 },
      "",
      "pos_counter",
      "walk_in",
    );
  });

  it("submits linked mode when a resolved customer is already selected", () => {
    const onComplete = vi.fn();
    mounted = renderTestUi(
      <PaymentModal
        subtotal={100000}
        adjustment={{ discountType: "percent", discountValue: 0, shippingFee: 0 }}
        selectedCustomer={{ id: "customer-a", phone: "0900000000", name: "Nguyen An" }}
        onComplete={onComplete}
        onClose={vi.fn()}
      />,
    );

    click(buttonByText(mounted.container, "pos.completeSale"));
    expect(onComplete).toHaveBeenCalledWith(
      "cash",
      100000,
      { discountType: "percent", discountValue: 0, shippingFee: 0 },
      "",
      "pos_counter",
      "linked",
    );
  });

  it("uses the clear received-money action and current policy acknowledgment for bank booking", () => {
    const onComplete = vi.fn();
    mounted = renderTestUi(
      <PaymentModal
        subtotal={690000}
        adjustment={{ discountType: "percent", discountValue: 0, shippingFee: 0 }}
        onComplete={onComplete}
        onClose={vi.fn()}
        bankSettlementPolicy={{
          status: "ready",
          mode: "confirm_on_booking",
          policyVersion: 7,
          acknowledgmentVersion: 1,
          manualConfirmationEnabled: false,
        }}
      />,
    );

    click(buttonByText(mounted.container, "Khách lẻ"));
    click(buttonByText(mounted.container, "pos.payTransfer"));
    expect(mounted.container.textContent).toContain("xác nhận đã nhận đủ 690.000 ₫ chuyển khoản");
    click(buttonByText(mounted.container, "Hoàn tất & xác nhận đã nhận tiền"));

    expect(onComplete).toHaveBeenCalledWith(
      "bank_transfer",
      690000,
      { discountType: "percent", discountValue: 0, shippingFee: 0 },
      "",
      "pos_counter",
      "walk_in",
      { policyVersion: 7, acknowledgmentVersion: 1 },
    );
  });
});

for (const status of ["pending", "unavailable", "ready"] as const) {
  it(`blocks bank checkout when policy is ${status} and manual confirmation unavailable`, () => {
    const onComplete = vi.fn();
    const onPolicyRefresh = vi.fn();
    mounted = renderTestUi(<PaymentModal subtotal={690000}
      adjustment={{ discountType: "amount", discountValue: 0, shippingFee: 0 }}
      selectedCustomer={{ id: "c", phone: "0900000000", name: "Customer" }}
      onComplete={onComplete} onClose={vi.fn()} onPolicyRefresh={onPolicyRefresh}
      bankSettlementPolicy={{ status, mode: "manual_confirmation", policyVersion: 0,
        acknowledgmentVersion: 1, manualConfirmationEnabled: false }} />);
    click(buttonByText(mounted.container, "pos.payTransfer"));
    expect(buttonByText(mounted.container, "pos.completeSale").disabled).toBe(true);
    expect(mounted.container.textContent).not.toContain("để xác nhận thủ công sau");
    click(buttonByText(mounted.container, "Tải lại chính sách"));
    expect(onPolicyRefresh).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
  });
}
