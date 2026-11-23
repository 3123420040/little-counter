import { describe, expect, it } from "vitest";
import { isScanGoCartPayload, scanGoCartTokenFromPayload } from "./scanPayload";

describe("scan payload classification", () => {
  it("detects raw Scan & Go cart tokens", () => {
    expect(isScanGoCartPayload("sgt_abc123")).toBe(true);
    expect(scanGoCartTokenFromPayload(" sgt_ABC123 ")).toBe("sgt_ABC123");
  });

  it("detects Scan & Go cart tokens embedded in final QR URLs", () => {
    expect(isScanGoCartPayload("https://snus.example/s/default/main/redeem?t=sgt_deadbeef")).toBe(true);
    expect(scanGoCartTokenFromPayload("https://snus.example/redeem?token=sgt_deadbeef")).toBe("sgt_deadbeef");
  });

  it("keeps product URLs and SKU/barcodes on the product path", () => {
    expect(isScanGoCartPayload("https://snus.example/s/default/main/p/mint-medium")).toBe(false);
    expect(isScanGoCartPayload("https://snus.example/scan/mint-medium")).toBe(false);
    expect(isScanGoCartPayload("MINT-20")).toBe(false);
    expect(isScanGoCartPayload("8930001")).toBe(false);
  });

  it("does not treat unrelated URL tokens as Scan & Go cart payloads", () => {
    expect(isScanGoCartPayload("https://snus.example/s/default/main/p/mint?t=not_scan_go")).toBe(false);
  });
});
