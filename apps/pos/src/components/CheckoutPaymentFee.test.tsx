// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CartPaymentFeePreviewV1Schema } from "@medusa-snus/contracts";
import { renderTestUi, click, changeValue, buttonByText, type TestRender } from "../test/reactTestHarness";
import { CartPanel } from "./CartPanel";
import { PaymentModal } from "./PaymentModal";
import { ReceiptModal } from "./ReceiptModal";
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("./CustomerSearch", () => ({ CustomerSearch: () => null }));
const preview = CartPaymentFeePreviewV1Schema.parse({ schemaVersion: 1, contractVersion: "orders.payment-fee.v1", data: {
  merchantId: "m-a", storeId: "s-a", confirmationToken: "a".repeat(64), input: { items: [{ variantId: "v-a", quantity: 1 }], discountType: "percent", discountValue: 0, shippingFee: 0, paymentFeeType: "percent", paymentFeeValue: 10 },
  items: [{ productId: "p-a", variantId: "v-a", name: "Item", sku: "SKU", quantity: 1, unitPrice: 1200, lineTotal: 1200, stock: 5 }],
  financial: { schemaVersion: 1, calculationVersion: 2, currencyCode: "VND", minorUnitExponent: 0,
    paymentFee: { paymentFeeType: "percent", paymentFeeValue: 10, paymentFeeBasisMinor: 1200, vatRatePpm: 100000 },
    components: { taxMode: "inclusive", merchandiseGrossMinor: 1200, discountMinor: 0, merchandiseNetMinor: 1200, shippingMinor: 0,
      merchandiseVatMinor: 109, shippingVatMinor: 0, paymentFeeMinor: 120, paymentFeeVatMinor: 11, vatMinor: 120, totalMinor: 1320, unclassifiedMinor: 0 } },
} });
const adjustment = { discountType: "percent" as const, discountValue: 0, shippingFee: 0, paymentFeeType: "percent" as const, paymentFeeValue: 10 };
const props = { items: [{ productId: "p-a", variantId: "v-a", productName: "Item", sku: "SKU", quantity: 1, unitPrice: 9999, stockLevel: 5 }],
  selectedIndex: null, subtotal: 9999, itemCount: 1, adjustment, onAdjustmentChange: vi.fn(), onUpdateQty: vi.fn(), onRemove: vi.fn(),
  onSelectItem: vi.fn(), onClear: vi.fn(), onCheckout: vi.fn() };
let mounted: TestRender | undefined;
afterEach(() => { mounted?.unmount(); mounted = undefined; vi.clearAllMocks(); });
describe("checkout payment fee UI", () => {
  it.each([false, true])("shows server prices/fee/total and percent/fixed controls, mobile=%s", mobileOptimized => {
    mounted = renderTestUi(<CartPanel {...props} mobileOptimized={mobileOptimized} paymentFeePreview={{ status: "ready", preview }} />);
    expect(mounted.container.textContent).toContain("1.320 ₫"); expect(mounted.container.textContent).not.toContain("9.999");
    expect(mounted.container.textContent).toContain("+ 120 ₫"); expect(mounted.container.textContent).toContain("VAT đã gồm");
    expect(mounted.container.textContent).toContain("Tính trên tiền hàng sau giảm giá, không gồm giao hàng.");
    changeValue(mounted.container.querySelector('input[aria-label="Phí thanh toán (%)"]')!, "2.55");
    expect(props.onAdjustmentChange).toHaveBeenLastCalledWith({ ...adjustment, paymentFeeValue: 2.55 });
    click(mounted.container.querySelector('button[aria-label="Phí thanh toán theo số tiền"]')!);
    expect(props.onAdjustmentChange).toHaveBeenLastCalledWith({ ...adjustment, paymentFeeType: "amount", paymentFeeValue: 0 });
    expect(buttonByText(mounted.container, "pos.checkout").disabled).toBe(false);
  });
  it.each(["pending", "unavailable"] as const)("blocks checkout and hides an unverified total when preview is %s", status => {
    const state = status === "pending" ? { status } : { status, message: "Cần tải lại giá" };
    mounted = renderTestUi(<CartPanel {...props} paymentFeePreview={state} />);
    expect(buttonByText(mounted.container, "pos.checkout").disabled).toBe(true);
    expect(mounted.container.textContent).toContain("—"); expect(mounted.container.textContent).not.toContain("9.999 ₫");
  });
  it("hides fee controls on a legacy runtime and disables them for a locked cart", () => {
    const { paymentFeeType: _type, paymentFeeValue: _value, ...legacy } = adjustment;
    mounted = renderTestUi(<CartPanel {...props} adjustment={legacy} />);
    expect(mounted.container.querySelector('input[aria-label="Phí thanh toán (%)"]')).toBeNull();
    mounted.rerender(<CartPanel {...props} readOnly paymentFeePreview={{ status: "ready", preview }} />);
    expect((mounted.container.querySelector('input[aria-label="Phí thanh toán (%)"]') as HTMLInputElement).disabled).toBe(true);
  });
  it("uses a verified server total in the payment dialog and refuses explicit zero cash", () => {
    const complete = vi.fn();
    mounted = renderTestUi(<PaymentModal subtotal={9999} adjustment={adjustment} paymentFeePreview={{ status: "ready", preview }}
      selectedCustomer={{ id: "c-a", name: "Customer", phone: "123456" }} onComplete={complete} onClose={() => {}} />);
    expect(mounted.container.textContent).toContain("1.320 ₫"); expect(mounted.container.textContent).not.toContain("9.999");
    const amount = mounted.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    changeValue(amount, "0");
    expect(buttonByText(mounted.container, "pos.completeSale").disabled).toBe(true);
    click(buttonByText(mounted.container, "pos.completeSale")); expect(complete).not.toHaveBeenCalled();
    changeValue(amount, "2000"); click(buttonByText(mounted.container, "pos.completeSale"));
    expect(complete).toHaveBeenCalledWith("cash", 2000, adjustment, "", "pos_counter", "linked");
  });
  it("blocks payment while server totals are pending, even with a selected customer", () => {
    mounted = renderTestUi(<PaymentModal subtotal={9999} adjustment={adjustment} paymentFeePreview={{ status: "pending" }}
      selectedCustomer={{ id: "c-a", name: "Customer", phone: "123456" }} onComplete={vi.fn()} onClose={() => {}} />);
    expect(buttonByText(mounted.container, "pos.completeSale").disabled).toBe(true);
    expect(mounted.container.textContent).toContain("—");
  });
  it("prints the stored fee separately and uses the stored VAT mode", () => {
    mounted = renderTestUi(<ReceiptModal order={{ orderNumber: "ORD-A", total: 1320, subtotal: 1200, tax: 120, discount: 0,
      shippingFee: 0, change: 680, paymentMethod: "cash", createdAt: "2026-10-28T10:00:00.000Z", items: preview.data.items,
      financial: preview.data.financial }} onClose={() => {}} />);
    expect(mounted.container.textContent).toContain("Phí thanh toán"); expect(mounted.container.textContent).toContain("1.320 ₫");
    expect(mounted.container.textContent).toContain("VAT included");
  });
});
