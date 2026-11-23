import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProduct } from "../scan-go/productResolver";
import { ProductResolveError } from "../scan-go/types";

describe("productResolver live adapter", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("VITE_SCAN_GO_LIVE", "1");
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fetchSpy.mockRestore();
  });

  it("calls the public product resolver endpoint and validates the DTO", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json({
      data: {
        merchantSlug: "default",
        storeSlug: "main",
        qrSlug: "sample-berry",
        productId: "prod_1",
        variantId: "var_1",
        brand: "SAMPLE",
        name: "Berry Sample",
        flavor: "Berry Sample",
        formatTags: ["SLIM"],
        strengthLabel: "6mg/pouch",
        priceVnd: 250000,
        imageUrl: null,
        approvedStory: "",
        availability: "available",
      },
    }));

    const product = await resolveProduct({
      merchantSlug: "default",
      storeSlug: "main",
      qrSlug: "sample-berry",
    });

    expect(product.priceVnd).toBe(250000);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/public/scan-go/products/default/main/sample-berry",
      { headers: { accept: "application/json" } },
    );
  });

  it("fails closed when the live product response no longer matches the DTO", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json({ data: { productId: "prod_1" } }));

    await expect(resolveProduct({
      merchantSlug: "default",
      storeSlug: "main",
      qrSlug: "broken",
    })).rejects.toBeInstanceOf(ProductResolveError);
  });
});
