import { publicOperationErrorMessage } from "../utils/safe-error";

export function importApplyErrorMessage(error: unknown): string {
  return publicOperationErrorMessage(error, "Row could not be applied");
}

export interface ImportPreviewRow {
  rowNumber: number;
  action: string;
  status: "valid" | "warning" | "error";
  errors: string[];
  warnings: string[];
  normalized: Record<string, unknown>;
}

export interface ImportPreviewResult {
  importId: string;
  valid: boolean;
  summary: { totalRows: number; validRows: number; errorRows: number; warningRows: number };
  rows: ImportPreviewRow[];
}

export interface ImportApplyRow {
  rowNumber: number;
  action: string;
  status: "applied" | "skipped" | "error";
  entityId?: string;
  errors: string[];
}

export interface ImportApplyResult {
  importId: string;
  appliedRows: number;
  skippedRows: number;
  errorRows: number;
  rows: ImportApplyRow[];
}
