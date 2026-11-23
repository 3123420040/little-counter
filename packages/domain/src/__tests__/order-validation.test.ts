import { describe, expect, it } from "vitest";
import { validateSale } from "../index.js";

describe("Order Validation", () => {
  it("rejects order with empty cart", () => {
    const errors = validateSale({ items: [], paymentMethod: "cash" });
    expect(errors).toContain("missing_items");
  });

  it("rejects order with invalid quantity", () => {
    const errors = validateSale({
      items: [
        { productId: "prod_1", variantId: "var_1", quantity: 0, unitPrice: 100000, stockLevel: 10 },
      ],
      paymentMethod: "cash",
    });
    expect(errors).toContain("invalid_quantity");
  });

  it("rejects negative quantity", () => {
    const errors = validateSale({
      items: [
        { productId: "prod_1", variantId: "var_1", quantity: -1, unitPrice: 100000, stockLevel: 10 },
      ],
      paymentMethod: "cash",
    });
    expect(errors).toContain("invalid_quantity");
  });

  it("rejects order where quantity exceeds stock", () => {
    const errors = validateSale({
      items: [
        { productId: "prod_1", variantId: "var_1", quantity: 5, unitPrice: 100000, stockLevel: 3 },
      ],
      paymentMethod: "cash",
    });
    expect(errors).toContain("insufficient_stock");
  });

  it("rejects order with negative unit price", () => {
    const errors = validateSale({
      items: [
        { productId: "prod_1", variantId: "var_1", quantity: 2, unitPrice: -500, stockLevel: 10 },
      ],
      paymentMethod: "cash",
    });
    expect(errors).toContain("invalid_price");
  });

  it("rejects order with invalid payment method", () => {
    const errors = validateSale({
      items: [
        { productId: "prod_1", variantId: "var_1", quantity: 2, unitPrice: 100000, stockLevel: 10 },
      ],
      paymentMethod: "invalid_method",
    });
    expect(errors).toContain("invalid_payment_method");
  });

  it("accepts valid cash order", () => {
    const errors = validateSale({
      items: [
        { productId: "prod_1", variantId: "var_1", quantity: 2, unitPrice: 100000, stockLevel: 10 },
      ],
      paymentMethod: "cash",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts bank_transfer payment", () => {
    const errors = validateSale({
      items: [
        { productId: "prod_1", variantId: "var_1", quantity: 1, unitPrice: 240000, stockLevel: 10 },
      ],
      paymentMethod: "bank_transfer",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts cod payment", () => {
    const errors = validateSale({
      items: [
        { productId: "prod_1", variantId: "var_1", quantity: 1, unitPrice: 240000, stockLevel: 10 },
      ],
      paymentMethod: "cod",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts order with multiple items", () => {
    const errors = validateSale({
      items: [
        { productId: "p1", variantId: "v1", quantity: 2, unitPrice: 100000, stockLevel: 10 },
        { productId: "p2", variantId: "v2", quantity: 3, unitPrice: 50000, stockLevel: 15 },
      ],
      paymentMethod: "cash",
    });
    expect(errors).toHaveLength(0);
  });

  it("accumulates multiple validation errors for multiple items", () => {
    const errors = validateSale({
      items: [
        { productId: "p1", variantId: "v1", quantity: 20, unitPrice: 100000, stockLevel: 5 },
        { productId: "p2", variantId: "v2", quantity: -3, unitPrice: -100, stockLevel: 10 },
      ],
      paymentMethod: "cash",
    });
    expect(errors).toContain("insufficient_stock");
    expect(errors).toContain("invalid_quantity");
    expect(errors).toContain("invalid_price");
  });

  it("deduplicates repeated errors", () => {
    const errors = validateSale({
      items: [
        { productId: "p1", variantId: "v1", quantity: 0, unitPrice: 100000, stockLevel: 10 },
        { productId: "p2", variantId: "v2", quantity: 0, unitPrice: 100000, stockLevel: 5 },
      ],
      paymentMethod: "cash",
    });
    expect(errors.filter(e => e === "invalid_quantity")).toHaveLength(1);
  });
});
