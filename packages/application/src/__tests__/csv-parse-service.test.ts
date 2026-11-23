import { describe, expect, it } from "vitest";
import { PlatformError } from "../errors/platform-error";
import { parseCsvRows } from "../services/csv-parse-service";

describe("csv-parse-service", () => {
  it("parses simple comma-separated values", () => {
    const csv = `name,rank\nMint,1\nBerry,2`;
    const rows = parseCsvRows(csv, ["name", "rank"]);
    expect(rows).toEqual([
      { name: "Mint", rank: "1" },
      { name: "Berry", rank: "2" },
    ]);
  });

  it("handles quoted fields with commas and newlines", () => {
    const csv = `name,desc\nMint,"Fresh, cool mint"\nBerry,"Sweet\nand juicy"`;
    const rows = parseCsvRows(csv, ["name", "desc"]);
    expect(rows).toEqual([
      { name: "Mint", desc: "Fresh, cool mint" },
      { name: "Berry", desc: "Sweet\nand juicy" },
    ]);
  });

  it("handles escaped quotes within quoted fields", () => {
    const csv = `name,desc\nMint,"Fresh ""cool"" mint"`;
    const rows = parseCsvRows(csv, ["name", "desc"]);
    expect(rows).toEqual([
      { name: "Mint", desc: 'Fresh "cool" mint' },
    ]);
  });

  it("ignores BOM and normalizes CRLF", () => {
    const csv = `\uFEFFname,rank\r\nMint,1\r\n`;
    const rows = parseCsvRows(csv, ["name", "rank"]);
    expect(rows).toEqual([
      { name: "Mint", rank: "1" },
    ]);
  });

  it("ignores header case and matches required columns", () => {
    const csv = `NaMe,rAnK\nMint,1`;
    const rows = parseCsvRows(csv, ["name", "rank"]);
    expect(rows).toEqual([
      { name: "Mint", rank: "1" },
    ]);
  });

  it("handles empty values", () => {
    const csv = `name,rank\nMint,\n,2`;
    const rows = parseCsvRows(csv, ["name", "rank"]);
    expect(rows).toEqual([
      { name: "Mint", rank: "" },
      { name: "", rank: "2" },
    ]);
  });

  it("rejects Excel workbooks uploaded with a CSV extension", () => {
    const xlsxZipPrefix = `PK\u0003\u0004ignored [Content_Types].xml bytes`;

    expect(() => parseCsvRows(xlsxZipPrefix, ["action"])).toThrow(
      "File import đang là Excel workbook (.xlsx), không phải CSV text.",
    );
    expect(() => parseCsvRows(xlsxZipPrefix, ["action"])).toThrow(PlatformError);
    expect(captureError(() => parseCsvRows(xlsxZipPrefix, ["action"]))).toMatchObject({
      code: "validation_error",
      statusCode: 400,
    });
  });
});

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected function to throw");
}
