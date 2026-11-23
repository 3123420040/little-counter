// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { PaymentIntentFinancialViewV1Schema } from "@medusa-snus/contracts";
import { renderTestUi, type TestRender } from "../test/reactTestHarness";
import { PaymentIntentFinancialSummary } from "./PaymentIntentFinancialSummary";
let mounted: TestRender | undefined;
afterEach(() => { mounted?.unmount(); mounted = undefined; });
const financial = PaymentIntentFinancialViewV1Schema.shape.financial.parse({ status: "available", snapshot: {
  schemaVersion: 1, calculationVersion: 2, currencyCode: "VND", minorUnitExponent: 0,
  paymentFee: { paymentFeeType: "percent", paymentFeeValue: 10, paymentFeeBasisMinor: 1200, vatRatePpm: 100_000 },
  components: { taxMode: "inclusive", merchandiseGrossMinor: 1200, discountMinor: 0, merchandiseNetMinor: 1200, shippingMinor: 0,
    merchandiseVatMinor: 109, shippingVatMinor: 0, paymentFeeMinor: 120, paymentFeeVatMinor: 11, vatMinor: 120, unclassifiedMinor: 0, totalMinor: 1320 },
} });
describe("payment-intent fee display", () => {
  it("shows the stored inclusive fee and its VAT without exposing revenue/cost", () => {
    mounted = renderTestUi(<PaymentIntentFinancialSummary financial={financial} />);
    expect(mounted.container.textContent).toContain("Phí thanh toán (10%): 120 ₫");
    expect(mounted.container.textContent).toContain("VAT của phí đã gồm: 11 ₫");
    expect(mounted.container.textContent).not.toContain("doanh thu");
  });
  it("shows exclusive fee plus VAT as the customer's fee contribution", () => {
    if (financial.status !== "available") throw new Error("fixture");
    mounted = renderTestUi(<PaymentIntentFinancialSummary financial={{ ...financial, snapshot: { ...financial.snapshot,
      components: { ...financial.snapshot.components, taxMode: "exclusive", merchandiseVatMinor: 120, paymentFeeVatMinor: 12, vatMinor: 132, totalMinor: 1452 } } }} />);
    expect(mounted.container.textContent).toContain("Phí thanh toán (10%): 132 ₫");
    expect(mounted.container.textContent).toContain("VAT của phí cộng thêm: 12 ₫");
  });
  it("shows unavailable evidence as an explicit status, never as zero", () => {
    mounted = renderTestUi(<PaymentIntentFinancialSummary financial={{ status: "unavailable", reason: "stored_quote_invalid" }} />);
    expect(mounted.container.querySelector('[role="status"]')?.textContent).toContain("Chưa xác minh");
    expect(mounted.container.textContent).not.toContain("0 ₫");
  });
  it("leaves legacy fee-free presentation unchanged", () => {
    mounted = renderTestUi(<PaymentIntentFinancialSummary financial={{ status: "legacy" }} />);
    expect(mounted.container.textContent).toBe("");
  });
});
