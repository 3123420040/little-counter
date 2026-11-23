import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const orderServiceSource = readFileSync(
  fileURLToPath(new URL("../services/order-service.ts", import.meta.url)),
  "utf8",
);

describe("PAY-COMPAT-01 staged order-service wiring", () => {
  it("captures either canonical charge owner and passes only immutable default-on config", () => {
    expect(orderServiceSource).toContain(
      "const orderCreatedChargeResult = noChargeRequired ? null : providerChargeInput",
    );
    expect(orderServiceSource).toContain("recordProviderInitialPostedChargeFromLockedStateV1");
    expect(orderServiceSource).toContain("recordOrderCreatedPaymentChargeV1");
    expect(orderServiceSource).toContain(
      "PAYMENT_ENTRY_COMPATIBILITY_DEFAULT_CONFIG_V1",
    );
    expect(orderServiceSource).not.toMatch(
      /process\.env\.PAYMENT_ENTRY_COMPATIBILITY_ENABLED/,
    );
  });

  it("correlates the legacy mirror to the exact canonical result", () => {
    const legacyCall = orderServiceSource.indexOf(
      "await recordSaleCharge",
    );
    const end = orderServiceSource.indexOf("const cogs =", legacyCall);
    const block = orderServiceSource.slice(legacyCall, end);
    expect(block).toContain('boundary: "order_created"');
    expect(block).toContain("canonicalCharge: orderCreatedChargeResult");
    expect(block).toContain("PAYMENT_ENTRY_COMPATIBILITY_DEFAULT_CONFIG_V1");
  });

  it("leaves positive-correction payment writes outside this boundary", () => {
    const occurrences = orderServiceSource.match(/boundary: "order_created"/g) || [];
    expect(occurrences).toHaveLength(1);
  });
});
