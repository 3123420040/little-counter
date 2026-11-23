import { describe, expect, it } from "vitest";
import { normalizeRemoteOrderInput } from "../services/order-service";

describe("remote order fee boundary", () => {
  it.each([0, 2])(
    "rejects unsupported fee=%i before the remote input is normalized",
    (paymentFeeValue) => {
      const input = {
        items: [{ variantId: "fixture", quantity: 1 }],
        paymentFeeType: "percent" as const,
        paymentFeeValue,
      };
      expect(() => normalizeRemoteOrderInput(input)).toThrow(
        "not supported by remote orders",
      );
    },
  );
  it("keeps legacy remote input without default fee fields", () => {
    const value = normalizeRemoteOrderInput({
      items: [{ variantId: "fixture", quantity: 1 }],
    });
    expect(
      Object.keys(value).filter((key) => key.startsWith("paymentFee")),
    ).toEqual([]);
  });
});
