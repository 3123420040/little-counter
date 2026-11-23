import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReceiptText, requireValidReceiptEmail } from "../services/receipt-service";

describe("receipt service", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("normalizes a valid recipient and rejects malformed recipients with a stable 400", () => {
    expect(requireValidReceiptEmail("  customer@example.com  ")).toBe("customer@example.com");
    for (const recipient of [undefined, null, "", "not-an-email", `${"a".repeat(310)}@example.com`]) {
      expect(() => requireValidReceiptEmail(recipient)).toThrow(expect.objectContaining({
        code: "validation_error",
        statusCode: 400,
      }));
    }
  });

  it("uses the configured store identity on the receipt", () => {
    vi.stubEnv("STORE_NAME", "Example Store");
    vi.stubEnv("STORE_ADDRESS", "42 Sample Street");
    const text = buildReceiptText({
      orderNumber: "ORD-20260614-0001",
      createdAt: "2026-06-14T01:00:00.000Z",
      customer: { first_name: "A", last_name: "Nguyen", phone: "0900000000" },
      items: [
        { name: "Mint Medium Pouch", quantity: 2, unitPrice: 240000, lineTotal: 480000 },
      ],
      subtotal: 480000,
      discount: 0,
      tax: 43636,
      total: 480000,
      paymentMethod: "cod",
    });

    expect(text).toContain("Receipt: ORD-20260614-0001");
    expect(text).toContain("Example Store");
    expect(text).toContain("42 Sample Street");
    expect(text).toContain("- Mint Medium Pouch x2 @ 240.000 VND = 480.000 VND");
    expect(text).toContain("Total: 480.000 VND");
    expect(text).toContain("Payment: cod");
  });

  it("renders long product names without truncation", () => {
    const longName = "Snus Nicotine Pouch Mint Medium Strength 20-Pack Premium Quality Imported From Sweden";
    const text = buildReceiptText({
      orderNumber: "ORD-LONG-0001",
      createdAt: "2026-06-23T01:00:00.000Z",
      items: [
        { name: longName, quantity: 3, unitPrice: 240000, lineTotal: 720000 },
      ],
      subtotal: 720000,
      discount: 0,
      tax: 65454,
      total: 720000,
      paymentMethod: "cash",
    });

    expect(text).toContain(longName);
    expect(text).toContain("x3 @ 240.000 VND = 720.000 VND");
  });
});
