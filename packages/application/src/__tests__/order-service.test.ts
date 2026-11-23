import { describe, expect, it } from "vitest";
import { PlatformError } from "../errors/platform-error";
import {
  assertCustomerAttributionMode,
  normalizeRemoteOrderInput,
} from "../services/order-service";

describe("order service contract helpers", () => {
  it("defaults remote orders to confirmed COD without collected cash", () => {
    const input = normalizeRemoteOrderInput({
      items: [{ variantId: "var_mint_20", quantity: 2 }],
      customerId: "cus_1",
      note: "Telegram order",
    });

    expect(input).toEqual({
      items: [{ variantId: "var_mint_20", quantity: 2 }],
      customerId: "cus_1",
      paymentMethod: "cod",
      amountReceived: 0,
      discountPercent: undefined,
      shippingFee: 0,
      notes: "Telegram order",
      salesChannel: "telegram",
    });
  });

  it("rejects unsupported remote order lifecycle state", () => {
    expect(() => normalizeRemoteOrderInput({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      status: "draft" as "confirmed",
    })).toThrow(PlatformError);
  });

  it("fails closed for contradictory explicit customer attribution", () => {
    expect(() => assertCustomerAttributionMode({ customerMode: "linked" }))
      .toThrow(PlatformError);
    expect(() => assertCustomerAttributionMode({
      customerMode: "walk_in",
      customerId: "customer-a",
    })).toThrow(PlatformError);
    expect(() => assertCustomerAttributionMode({
      customerMode: "linked",
      customerId: "customer-a",
    })).not.toThrow();
    expect(() => assertCustomerAttributionMode({ customerMode: "walk_in" })).not.toThrow();
    // Rolling upgrade compatibility for queued payloads from the old POS.
    expect(() => assertCustomerAttributionMode({ customerId: "customer-a" })).not.toThrow();
    expect(() => assertCustomerAttributionMode({})).not.toThrow();
  });
});
