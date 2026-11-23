export type CsvCell = string | number | boolean | null | undefined;

function startsWithSpreadsheetFormula(text: string): boolean {
  let index = 0;
  while (index < text.length && text.charCodeAt(index) <= 0x20) {
    index += 1;
  }
  return text[index] === "=" || text[index] === "+" || text[index] === "-" || text[index] === "@";
}

function protectSpreadsheetCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  const text = String(value);
  return startsWithSpreadsheetFormula(text) ? `'${text}` : text;
}

function escapeCsvCell(value: CsvCell): string {
  const protectedValue = protectSpreadsheetCell(value);
  if (!/[",\r\n]/.test(protectedValue)) return protectedValue;
  return `"${protectedValue.replace(/"/g, '""')}"`;
}

export function serializeCsv(columns: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [columns.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((_, index) => escapeCsvCell(row[index])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function dateOnlyCsvValue(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString().slice(0, 10);
}
