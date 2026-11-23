import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const orderServiceSource = readFileSync(
  fileURLToPath(new URL("../services/order-service.ts", import.meta.url)),
  "utf8",
);

describe("PAY-CREATE-01 staged order-service wiring", () => {
  it("uses only immutable default-on canonical payment caller configs", () => {
    expect(orderServiceSource).toContain(
      "ORDER_CREATED_PAYMENT_CHARGE_CALLER_DEFAULT_CONFIG_V1",
    );
    expect(orderServiceSource).toContain("recordOrderCreatedPaymentChargeV1");
    expect(orderServiceSource).toContain(
      "PROVIDER_INITIAL_POSTED_CHARGE_CALLER_DEFAULT_CONFIG_V1",
    );
    expect(orderServiceSource).toContain(
      "recordProviderInitialPostedChargeFromLockedStateV1",
    );
    expect(orderServiceSource).not.toMatch(
      /process\.env\.ORDER_CREATED_PAYMENT_CHARGE_WRITE_ENABLED/,
    );
  });

  it("awaits the payment caller after original revision and before legacy payment", () => {
    const revisionCall = orderServiceSource.indexOf(
      "await recordOriginalOrderCommercialRevisionFromOrderCreateV1",
    );
    const paymentBundleCall = orderServiceSource.indexOf(
      "await recordOrderCreatedPaymentChargeV1",
    );
    const legacyPaymentCall = orderServiceSource.indexOf(
      "await recordSaleCharge",
    );
    expect(revisionCall).toBeGreaterThan(0);
    expect(paymentBundleCall).toBeGreaterThan(revisionCall);
    expect(legacyPaymentCall).toBeGreaterThan(paymentBundleCall);
  });

  it("maps the exact original revision/components and tender context", () => {
    const start = orderServiceSource.indexOf("const initialChargeDependencies");
    const end = orderServiceSource.indexOf("INSERT INTO public.order_summary", start);
    const block = orderServiceSource.slice(start, end);
    expect(block).toContain('ownership: "caller"');
    expect(block).toContain("orderCreatedInCurrentTransaction: true");
    expect(block).toContain("originalRevisionResult.revisionId");
    expect(block).toContain("paymentMethod: input.paymentMethod");
    expect(block).toContain(
      'amountReceivedMinor: input.paymentMethod === "cash" ? input.amountReceived : 0',
    );
    expect(block).toContain("changeMinor: change");
    expect(block).toContain("totals.commercialAdjustmentVersion === 2");
    expect(block).toContain("await recordOrderCreatedPaymentChargeV2");
    for (const field of [
      "taxMode",
      "merchandiseGrossMinor",
      "discountMinor",
      "merchandiseNetMinor",
      "shippingMinor",
      "merchandiseVatMinor",
      "shippingVatMinor",
      "vatMinor",
      "unclassifiedMinor",
      "totalMinor",
    ]) expect(block).toContain(field);
  });

  it("uses the locked provider caller for real provider settlement and local evidence only for mock", () => {
    const providerCall = orderServiceSource.indexOf(
      "await recordProviderInitialPostedChargeFromLockedStateV1",
    );
    const genericCall = orderServiceSource.indexOf(
      "await recordOrderCreatedPaymentChargeV1",
    );
    const legacyPaymentCall = orderServiceSource.indexOf(
      "await recordSaleCharge",
    );
    expect(providerCall).toBeGreaterThan(0);
    expect(genericCall).toBeGreaterThan(providerCall);
    expect(legacyPaymentCall).toBeGreaterThan(genericCall);
    const providerSelection = orderServiceSource.lastIndexOf(
      "const providerChargeInput",
      providerCall,
    );
    const block = orderServiceSource.slice(providerSelection, legacyPaymentCall);
    expect(block).toContain('paymentProvider === "sepay_va"');
    expect(block).toContain('paymentProvider === "nowpayments"');
    expect(block).toContain('paymentProvider === "mock"');
    expect(block).toContain("paymentIntentId");
    expect(block).toContain("providerEventId");
  });
});
