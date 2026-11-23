import { afterEach, describe, expect, it } from "vitest";
import { getPackageEntitlements, hasFeature, requireFeature } from "../services/feature-entitlement-service.js";
import { getCatalogEntryInMemory } from "../services/package-catalog-service";

const originalPackage = process.env.APP_PACKAGE_KEY;
const originalFlags = process.env.FEATURE_FLAGS;

afterEach(() => {
  if (originalPackage === undefined) delete process.env.APP_PACKAGE_KEY;
  else process.env.APP_PACKAGE_KEY = originalPackage;
  if (originalFlags === undefined) delete process.env.FEATURE_FLAGS;
  else process.env.FEATURE_FLAGS = originalFlags;
});

describe("feature entitlement service", () => {
  it("keeps Basic fail-closed for paid features", () => {
    process.env.APP_PACKAGE_KEY = "basic";
    delete process.env.FEATURE_FLAGS;

    expect(hasFeature("sepay_qr_payment")).toBe(false);
    expect(() => requireFeature("sepay_qr_payment")).toThrow("Current package does not include feature");
  });

  it("maps Plus and AI Fan feature bundles", () => {
    process.env.APP_PACKAGE_KEY = "plus";
    expect(getPackageEntitlements().data.features).toEqual(expect.arrayContaining([
      "sepay_qr_payment",
      "crypto_payment",
      "smart_cross_sell",
      "product_research",
    ]));
    expect(hasFeature("telegram_ai_ordering")).toBe(false);
    expect(hasFeature("vision_pos_input")).toBe(false);

    process.env.APP_PACKAGE_KEY = "ai_fan";
    expect(hasFeature("telegram_ai_ordering")).toBe(true);
    expect(hasFeature("telegram_sales_channel")).toBe(true);
    expect(hasFeature("vision_pos_input")).toBe(true);
    expect(hasFeature("vision_pos_single_capture")).toBe(true);
    expect(hasFeature("vision_correction_report")).toBe(true);
    expect(hasFeature("vision_pos_bulk_capture")).toBe(false);
    expect(hasFeature("vision_debug_image_storage")).toBe(false);
  });

  it("keeps the in-memory AI Fan catalog aligned with Vision entitlements", () => {
    const aiFan = getCatalogEntryInMemory("ai_fan");

    expect(aiFan.featureKeys).toEqual(expect.arrayContaining([
      "telegram_sales_channel",
      "vision_pos_input",
      "vision_pos_single_capture",
      "vision_correction_report",
    ]));
    expect(aiFan.featureKeys).not.toContain("vision_pos_bulk_capture");
    expect(aiFan.featureKeys).not.toContain("vision_debug_image_storage");
  });

  it("accepts legacy feature aliases while exposing canonical keys", () => {
    process.env.APP_PACKAGE_KEY = "basic";
    process.env.FEATURE_FLAGS = "sepay_payments,crypto_payments,cross_sell";

    expect(hasFeature("sepay_qr_payment")).toBe(true);
    expect(hasFeature("crypto_payment")).toBe(true);
    expect(hasFeature("smart_cross_sell")).toBe(true);
    expect(hasFeature("sepay_payments")).toBe(true);
    expect(getPackageEntitlements().data.features).toEqual([
      "sepay_qr_payment",
      "crypto_payment",
      "smart_cross_sell",
    ]);
  });

  it("allows explicit local feature flags without changing package", () => {
    process.env.APP_PACKAGE_KEY = "basic";
    process.env.FEATURE_FLAGS = "product_research,vision_debug_image_storage";

    expect(hasFeature("product_research")).toBe(true);
    expect(hasFeature("vision_debug_image_storage")).toBe(true);
  });
});
