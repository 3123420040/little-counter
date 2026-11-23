import { describe, expect, it } from "vitest";
import type { ProductItem } from "../api/client";
import { productToMutationForm } from "./product-form";

describe("productToMutationForm", () => {
  it("preserves the existing image URL when opening edit", () => {
    const product: ProductItem = {
      id: "prod_1",
      title: "Tên sản phẩm dài",
      status: "published",
      imageUrl: "https://example.com/product.jpg",
      categories: [{ id: "cat_1", name: "Snus", handle: "snus" }],
      variants: [{
        id: "var_1",
        sku: "SKU-1",
        barcode: "BAR-1",
        prices: [{ amount: 120000 }],
        inventory_quantity: 3,
        cost_price: 70000,
        reorder_level: 5,
      }],
    };

    expect(productToMutationForm(product)).toMatchObject({
      title: product.title,
      imageUrl: product.imageUrl,
      categoryIds: ["cat_1"],
    });
  });
});
