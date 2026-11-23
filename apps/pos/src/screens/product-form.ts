import type { ProductItem } from "../api/client";
import type { ProductMutationInput } from "../api/endpoints";

export function emptyProductForm(): ProductMutationInput {
  return {
    title: "",
    status: "published",
    sku: "",
    barcode: "",
    price: 0,
    costPrice: 0,
    reorderLevel: 5,
    categoryIds: [],
    imageUrl: "",
  };
}

export function productToMutationForm(product: ProductItem): ProductMutationInput {
  const variant = product.variants?.[0];
  return {
    title: product.title,
    status: product.status,
    sku: variant?.sku || "",
    barcode: variant?.barcode || "",
    price: Number(variant?.prices?.[0]?.amount || 0),
    costPrice: Number(variant?.cost_price || 0),
    reorderLevel: Number(variant?.reorder_level || 5),
    categoryIds: (product.categories || []).map((category) => category.id),
    imageUrl: product.imageUrl || "",
  };
}
