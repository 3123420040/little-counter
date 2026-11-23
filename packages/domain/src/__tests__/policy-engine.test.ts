import { describe, expect, it } from "vitest";
import { filterBlockedClaims, DEFAULT_BLOCKED_PATTERNS } from "../index.js";

describe("Policy Engine - Blocked Claims", () => {
  it("allows normal product inquiry text", () => {
    const result = filterBlockedClaims(
      "Bên em có Mint Medium Pouch giá 250,000 VND. Anh cần số lượng bao nhiêu?",
    );
    expect(result.blocked).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  it("allows Vietnamese product info text", () => {
    const result = filterBlockedClaims(
      "Dạ bên em hiện còn hàng ạ. Giá 250k/hộp 20 pouches. A/C qua cửa hàng mua nhé.",
    );
    expect(result.blocked).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  it("blocks health claim text", () => {
    const result = filterBlockedClaims(
      "Sản phẩm này có thể giúp bạn bỏ thuốc lá (quit smoking).",
    );
    expect(result.blocked).toBe(true);
    expect(result.matches).toContain("cessation_claim");
  });

  it("blocks reduced risk claim", () => {
    const result = filterBlockedClaims(
      "This product is safer than traditional cigarettes.",
    );
    expect(result.blocked).toBe(true);
    expect(result.matches).toContain("safer_than_claim");
  });

  it("detects medical claim in mixed text", () => {
    const result = filterBlockedClaims(
      "Bên em có sản phẩm mới, có therapeutic benefits cho sức khỏe.",
    );
    expect(result.blocked).toBe(true);
    expect(result.matches).toContain("therapeutic_claim");
  });

  it("blocks health benefit pattern", () => {
    const result = filterBlockedClaims(
      "Our product provides a health benefit compared to traditional options.",
    );
    expect(result.blocked).toBe(true);
    expect(result.matches).toContain("health_benefit_claim");
  });

  it("blocks 'help you quit' phrase", () => {
    const result = filterBlockedClaims(
      "This could help you quit your old habits.",
    );
    expect(result.blocked).toBe(true);
    expect(result.matches).toContain("cessation_claim");
  });

  it("blocks 'less harmful' claim", () => {
    const result = filterBlockedClaims(
      "Scientists say it is less harmful than smoking.",
    );
    expect(result.blocked).toBe(true);
    expect(result.matches).toContain("less_harmful_claim");
  });

  it("detects multiple blocked patterns in one text", () => {
    const result = filterBlockedClaims(
      "This product has health benefit and is safer than smoking. It can help you quit and has medical properties.",
    );
    expect(result.blocked).toBe(true);
    expect(result.matches).toContain("health_benefit_claim");
    expect(result.matches).toContain("safer_than_claim");
    expect(result.matches).toContain("cessation_claim");
    expect(result.matches).toContain("medical_claim");
  });

  it("respects custom blocked patterns", () => {
    const customPatterns = [
      { pattern: /custom blocked phrase/i, label: "custom_claim" },
    ];
    const result = filterBlockedClaims(
      "This contains a custom blocked phrase.",
      customPatterns,
    );
    expect(result.blocked).toBe(true);
    expect(result.matches).toContain("custom_claim");
  });

  it("case-insensitive matching for default patterns", () => {
    const result = filterBlockedClaims(
      "QUIT SMOKING with our product.",
    );
    expect(result.blocked).toBe(true);
    expect(result.matches).toContain("cessation_claim");
  });

  it("empty text is not blocked", () => {
    const result = filterBlockedClaims("");
    expect(result.blocked).toBe(false);
    expect(result.matches).toHaveLength(0);
  });
});
