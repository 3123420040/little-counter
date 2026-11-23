/**
 * Minimal CSV parser for import flows. Handles quoted fields, embedded
 * newlines inside quotes, BOM stripping, and whitespace trimming.
 *
 * This is intentionally simple — no streaming, no external dependency.
 * Import files are expected to be small operational batches, not
 * multi-megabyte data dumps.
 */

import { PlatformError } from "../errors/platform-error";

export function parseCsvRows(csvText: string, expectedColumns: readonly string[]): Record<string, string>[] {
  const text = csvText.replace(/^\uFEFF/, "");
  assertCsvText(text);
  const lines = splitCsvLines(text);
  if (lines.length === 0) return [];

  const headerLine = lines[0];
  const rawHeaders = parseCsvLine(headerLine).map((h) => h.trim());
  const headerMap: Record<string, string> = {};

  // Validate that all expected columns are present (case-insensitive)
  for (const col of expectedColumns) {
    const foundIdx = rawHeaders.findIndex((h) => h.toLowerCase() === col.toLowerCase());
    if (foundIdx === -1) {
      throw new Error(`Missing required column: ${col}`);
    }
    headerMap[foundIdx.toString()] = col;
  }

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < rawHeaders.length; j++) {
      const mappedCol = headerMap[j.toString()];
      if (mappedCol) {
        row[mappedCol] = (values[j] || "").trim();
      }
    }
    rows.push(row);
  }
  return rows;
}

function assertCsvText(text: string): void {
  const prefix = text.slice(0, 256);
  if (prefix.startsWith("PK\u0003\u0004") || prefix.includes("[Content_Types].xml")) {
    throw new PlatformError(
      "validation_error",
      "File import đang là Excel workbook (.xlsx), không phải CSV text. Hãy mở file và Save As/Export thành CSV UTF-8 rồi import lại.",
      400,
    );
  }
}

/**
 * Split CSV text into logical lines, respecting quoted fields that may
 * contain newlines.
 */
function splitCsvLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && text[i + 1] === "\n") {
        i += 1;
      }
      lines.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

/**
 * Parse a single CSV line into field values, handling double-quote
 * escaping per RFC 4180.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}
