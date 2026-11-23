import { afterEach, describe, expect, it } from "vitest";
import { resolveEnvEntitlementSeed, seedEnvEntitlements, shouldIncludeDemoData } from "../db/schema";
import type { PoolClient } from "../db/client";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("entitlement bootstrap compatibility", () => {
  it("never enables demo data in production, even when the seed flag is set", () => {
    process.env.NODE_ENV = "production";
    process.env.PLATFORM_DEMO_SEED = "true";

    expect(shouldIncludeDemoData({ includeDemoData: true })).toBe(false);
  });

  it("normalizes env package and legacy feature aliases for local seed only", () => {
    const seed = resolveEnvEntitlementSeed({
      APP_PACKAGE_KEY: "plus",
      FEATURE_FLAGS: "sepay_payments,crypto_payments,cross_sell,unknown_feature",
    });

    expect(seed.packageKey).toBe("plus");
    expect(seed.entitlementFeatures).toEqual([
      "sepay_qr_payment",
      "crypto_payment",
      "smart_cross_sell",
      "product_research",
      "customer_scan_go",
    ]);
  });

  it("adds AI Fan vision defaults while keeping bulk and debug image storage opt-in", () => {
    const seed = resolveEnvEntitlementSeed({
      APP_PACKAGE_KEY: "ai_fan",
      FEATURE_FLAGS: "vision_pos_bulk_capture",
    });

    expect(seed.packageKey).toBe("ai_fan");
    expect(seed.entitlementFeatures).toEqual(expect.arrayContaining([
      "vision_pos_input",
      "vision_pos_single_capture",
      "vision_correction_report",
      "vision_pos_bulk_capture",
    ]));
    expect(seed.entitlementFeatures).not.toContain("vision_debug_image_storage");
  });

  it("does not generate a feature entitlement overwrite for purchased DB state", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, values?: readonly unknown[]) {
        calls.push({ sql, values });
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pick<PoolClient, "query">;

    process.env.APP_PACKAGE_KEY = "ai_fan";
    process.env.FEATURE_FLAGS = "product_research";
    await seedEnvEntitlements(client);

    const packageSeed = calls.find((call) => call.sql.includes("INSERT INTO app.package_entitlements"));
    expect(packageSeed?.sql).toContain("WHERE NOT EXISTS");
    expect(packageSeed?.values).toEqual(["ai_fan"]);

    const featureSeeds = calls.filter((call) => call.sql.includes("INSERT INTO app.feature_entitlements"));
    expect(featureSeeds.length).toBeGreaterThan(0);
    for (const call of featureSeeds) {
      expect(call.sql).toContain("app.feature_entitlements.metadata->>'source' = 'env'");
      expect(call.sql).toContain("COALESCE(purchased.metadata->>'source', '') <> 'env'");
      expect(call.values?.[2]).toBe("ai_fan");
    }
  });
});
