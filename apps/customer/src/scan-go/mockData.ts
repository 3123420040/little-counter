import type { ProductPublicDto } from "./types";

// Synthetic products for the stand-alone Scan & Go preview.

export const MOCK_MERCHANT_SLUG = "default";
export const MOCK_STORE_SLUG = "main";

const base = {
  merchantSlug: MOCK_MERCHANT_SLUG,
  storeSlug: MOCK_STORE_SLUG,
  imageUrl: null,
};

export const MOCK_PRODUCTS: Record<string, ProductPublicDto> = {
  // Sample available item.
  "sample-berry": {
    ...base,
    qrSlug: "sample-berry",
    productId: "prod_sample_berry",
    variantId: "variant_sample_berry",
    brand: "SAMPLE",
    name: "Berry Sample",
    flavor: "Berry Sample",
    formatTags: ["COOLING", "SLIM"],
    strengthLabel: "6mg/pouch",
    priceVnd: 250000,
    approvedStory: "Example product for the preview catalog.",
    availability: "available",
  },
  "sample-mint": {
    ...base,
    qrSlug: "sample-mint",
    productId: "prod_sample_mint",
    variantId: "variant_sample_mint",
    brand: "SAMPLE",
    name: "Mint Sample",
    flavor: "Mint Sample",
    formatTags: ["COOLING", "SLIM"],
    strengthLabel: "8mg/pouch",
    priceVnd: 180000,
    approvedStory: "Example product for the preview catalog.",
    availability: "available",
  },
  "sample-forest-berry": {
    ...base,
    qrSlug: "sample-forest-berry",
    productId: "prod_sample_forest",
    variantId: "variant_sample_forest",
    brand: "SAMPLE",
    name: "Forest Berry",
    flavor: "Forest Berry",
    formatTags: ["BERRY", "SLIM"],
    strengthLabel: "16mg/pouch",
    priceVnd: 130000,
    approvedStory: "Example product for the preview catalog.",
    availability: "available",
  },
  "sample-spearmint": {
    ...base,
    qrSlug: "sample-spearmint",
    productId: "prod_sample_spearmint",
    variantId: "variant_sample_spearmint",
    brand: "SAMPLE",
    name: "Spearmint Sample",
    flavor: "Spearmint Sample",
    formatTags: ["MINT", "MINI"],
    strengthLabel: "6mg/pouch",
    priceVnd: 90000,
    approvedStory: "Example product for the preview catalog.",
    availability: "available",
  },
  // Demonstrates the unavailable state (coarse availability only; no stock count).
  "sample-citrus-unavailable": {
    ...base,
    qrSlug: "sample-citrus-unavailable",
    productId: "prod_sample_citrus",
    variantId: "variant_sample_citrus",
    brand: "SAMPLE",
    name: "Citrus Sample",
    flavor: "Citrus Sample",
    formatTags: ["CITRUS", "SLIM"],
    strengthLabel: "30mg/pouch",
    priceVnd: 120000,
    approvedStory: "Example product for the preview catalog.",
    availability: "unavailable",
  },
};

export function mockProductBySlug(qrSlug: string): ProductPublicDto | undefined {
  return MOCK_PRODUCTS[qrSlug];
}
