import { describe, expect, it } from "vitest";
import { PlatformError } from "../errors/platform-error";
import { normalizeProductImageUrl } from "../services/product-image-url";

describe("product imageUrl", () => {
  describe("normalizeProductImageUrl", () => {
    it("returns null for empty or blank input", () => {
      expect(normalizeProductImageUrl("")).toBeNull();
      expect(normalizeProductImageUrl("  ")).toBeNull();
      expect(normalizeProductImageUrl(null)).toBeNull();
      expect(normalizeProductImageUrl(undefined)).toBeNull();
    });

    it("returns normalized URL for valid HTTPS input", () => {
      expect(normalizeProductImageUrl(" https://example.com/img.jpg ")).toBe("https://example.com/img.jpg");
    });

    it("rejects non-HTTPS protocol", () => {
      expect(() => normalizeProductImageUrl("http://example.com/img.jpg")).toThrow(PlatformError);
      expect(() => normalizeProductImageUrl("ftp://example.com/img.jpg")).toThrow(PlatformError);
    });

    it("rejects javascript: and data: protocol URLs as non-HTTPS", () => {
      expect(() => normalizeProductImageUrl("javascript:alert(1)")).toThrow("imageUrl must use HTTPS");
      expect(() => normalizeProductImageUrl("data:text/html,<script>alert(1)</script>")).toThrow("imageUrl must use HTTPS");
    });

    it("rejects malformed URLs", () => {
      expect(() => normalizeProductImageUrl("not-a-url")).toThrow(PlatformError);
    });

    it("rejects URLs containing embedded credentials", () => {
      expect(() => normalizeProductImageUrl("https://user:secret@example.com/img.jpg"))
        .toThrow("imageUrl must not include credentials");
    });
  });
});
