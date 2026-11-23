import { describe, expect, it } from "vitest";
import { normalizeVisionImageBase64 } from "../services/vision-image-validation";

const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const webpBytes = Buffer.from("RIFFxxxxWEBPVP8 ", "ascii");

describe("normalizeVisionImageBase64", () => {
  it("accepts JPEG, PNG, and WebP images", () => {
    expect(normalizeVisionImageBase64(`data:image/jpeg;base64,${jpegBytes.toString("base64")}`, { maxBytes: 1024 })).toMatchObject({
      mimeType: "image/jpeg",
      contentBase64: jpegBytes.toString("base64"),
    });
    expect(normalizeVisionImageBase64(`data:image/png;base64,${pngBytes.toString("base64")}`, { maxBytes: 1024 }).mimeType).toBe("image/png");
    expect(normalizeVisionImageBase64(webpBytes.toString("base64"), { maxBytes: 1024 }).mimeType).toBe("image/webp");
  });

  it("rejects invalid base64 and non-image bytes", () => {
    expect(() => normalizeVisionImageBase64("not-base64!", { maxBytes: 1024 })).toThrow("imageBase64 is invalid");
    expect(() => normalizeVisionImageBase64(Buffer.from("plain text").toString("base64"), { maxBytes: 1024 }))
      .toThrow("imageBase64 must be JPEG, PNG, or WebP");
  });

  it("rejects unsupported or mismatched data URL MIME types", () => {
    expect(() => normalizeVisionImageBase64(`data:text/plain;base64,${jpegBytes.toString("base64")}`, { maxBytes: 1024 }))
      .toThrow("imageBase64 must be JPEG, PNG, or WebP");
    expect(() => normalizeVisionImageBase64(`data:image/png;base64,${jpegBytes.toString("base64")}`, { maxBytes: 1024 }))
      .toThrow("imageBase64 MIME type does not match image content");
  });

  it("rejects images above the configured byte limit", () => {
    expect(() => normalizeVisionImageBase64(jpegBytes.toString("base64"), { maxBytes: 2 }))
      .toThrow("Vision scan image is too large");
  });
});
