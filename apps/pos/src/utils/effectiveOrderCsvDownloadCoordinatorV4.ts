import {
  EFFECTIVE_ORDER_CSV_SYNC_MAX_ORDERS_V4,
  type EffectiveOrderCsvExportResultV4, type EffectiveOrderCsvContract,
} from "./effectiveOrderCsvExportTaskV4";

export const EFFECTIVE_ORDER_CSV_DOWNLOAD_COORDINATOR_DEFAULT_CONFIG_V4 = Object.freeze({
  enabled: false,
});

export interface EffectiveOrderCsvDownloadCoordinatorDependenciesV4 {
  createObjectUrl: (blob: Blob) => string;
  triggerDownload: (input: { objectUrl: string; filename: string }) => void | Promise<void>;
  revokeObjectUrl: (objectUrl: string) => void;
  config?: {
    enabled: boolean;
  };
}

type CsvResult = EffectiveOrderCsvExportResultV4<EffectiveOrderCsvContract>;
type ExportFailure = Extract<CsvResult, { kind: "failed" }>;
type AsyncRequired = Extract<CsvResult, { kind: "async_required" }>;
type ReadyExport = Extract<CsvResult, { kind: "ready" }>;

export type EffectiveOrderCsvDownloadResultV4 =
  | ExportFailure
  | AsyncRequired
  | {
      kind: "downloaded";
      requestId: string;
      filename: string;
      grain: ReadyExport["grain"];
      asOf: string;
      revisionSha256: string;
      orderCount: number;
      rowCount: number;
    }
  | {
      kind: "failed";
      requestId: string;
      message: "Unable to download orders";
    };

export type EffectiveOrderCsvDownloadCoordinatorV4 =
  | {
      enabled: false;
      status: "disabled";
    }
  | {
      enabled: true;
      execute: () => Promise<EffectiveOrderCsvDownloadResultV4>;
    };

export class EffectiveOrderCsvDownloadCoordinatorErrorV4 extends Error {
  readonly code = "effective_order_csv_download_coordinator_invalid";

  constructor(message: string) {
    super(message);
    this.name = "EffectiveOrderCsvDownloadCoordinatorErrorV4";
  }
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && !!value && value.trim() === value;
}

function validSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validBlob(value: unknown): value is Blob {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Blob>;
  return Object.prototype.toString.call(value) === "[object Blob]"
    && Number.isSafeInteger(candidate.size)
    && (candidate.size as number) >= 0
    && typeof candidate.type === "string"
    && typeof candidate.slice === "function"
    && typeof candidate.arrayBuffer === "function"
    && typeof candidate.text === "function";
}

function exactFilename(result: ReadyExport): string {
  const instant = result.asOf.replace(/[-:]/g, "").replace(".000", "");
  return `orders-effective-${result.grain}-${instant}.csv`;
}

function validCanonicalAsOf(value: unknown): value is string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validateReady(input: unknown, version: EffectiveOrderCsvContract): ReadyExport | null {
  if (!input || typeof input !== "object") return null;
  const result = input as ReadyExport;
  if (
    result.kind !== "ready"
    || !validRequestId(result.requestId)
    || result.contractVersion !== version
    || (result.grain !== "order" && result.grain !== "effective_line")
    || !validCanonicalAsOf(result.asOf)
    || typeof result.revisionSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(result.revisionSha256)
    || !validSafeCount(result.orderCount)
    || result.orderCount > EFFECTIVE_ORDER_CSV_SYNC_MAX_ORDERS_V4
    || !validSafeCount(result.rowCount)
    || (result.grain === "order" && result.rowCount !== result.orderCount)
    || !validBlob(result.blob)
    || result.blob.size <= 0
    || !result.blob.type.toLowerCase().startsWith("text/csv")
    || result.filename !== exactFilename(result)
  ) return null;
  return {
    kind: "ready",
    requestId: result.requestId,
    filename: result.filename,
    blob: result.blob,
    contractVersion: version,
    grain: result.grain,
    asOf: result.asOf,
    revisionSha256: result.revisionSha256,
    orderCount: result.orderCount,
    rowCount: result.rowCount,
  };
}

function validateExportResult(input: unknown, version: EffectiveOrderCsvContract): CsvResult {
  if (!input || typeof input !== "object") {
    throw new EffectiveOrderCsvDownloadCoordinatorErrorV4("export result is invalid");
  }
  const candidate = input as CsvResult;
  if (candidate.kind === "ready") {
    const ready = validateReady(input, version);
    if (ready) return ready;
  } else if (
    candidate.kind === "failed"
    && validRequestId(candidate.requestId)
    && candidate.message === "Unable to export orders"
  ) {
    return {
      kind: "failed",
      requestId: candidate.requestId,
      message: "Unable to export orders",
    };
  } else if (
    candidate.kind === "async_required"
    && validRequestId(candidate.requestId)
    && validSafeCount(candidate.selectedOrderCount)
    && candidate.selectedOrderCount > EFFECTIVE_ORDER_CSV_SYNC_MAX_ORDERS_V4
    && candidate.maximumOrderCount === EFFECTIVE_ORDER_CSV_SYNC_MAX_ORDERS_V4
  ) {
    return {
      kind: "async_required",
      requestId: candidate.requestId,
      selectedOrderCount: candidate.selectedOrderCount,
      maximumOrderCount: EFFECTIVE_ORDER_CSV_SYNC_MAX_ORDERS_V4,
    };
  }
  throw new EffectiveOrderCsvDownloadCoordinatorErrorV4("export result is invalid");
}

function validateDependencies(
  dependencies: EffectiveOrderCsvDownloadCoordinatorDependenciesV4,
): void {
  if (
    typeof dependencies.createObjectUrl !== "function"
    || typeof dependencies.triggerDownload !== "function"
    || typeof dependencies.revokeObjectUrl !== "function"
  ) {
    throw new EffectiveOrderCsvDownloadCoordinatorErrorV4("download effects are unavailable");
  }
}

function downloadFailed(requestId: string): EffectiveOrderCsvDownloadResultV4 {
  return {
    kind: "failed",
    requestId,
    message: "Unable to download orders",
  };
}

async function performDownload(
  dependencies: EffectiveOrderCsvDownloadCoordinatorDependenciesV4,
  result: CsvResult,
): Promise<EffectiveOrderCsvDownloadResultV4> {
  if (result.kind !== "ready") return result;
  let objectUrl: string | undefined;
  let outcome: EffectiveOrderCsvDownloadResultV4;
  try {
    const candidate = dependencies.createObjectUrl(result.blob);
    if (typeof candidate !== "string" || !candidate.startsWith("blob:") || candidate.trim() !== candidate) {
      return downloadFailed(result.requestId);
    }
    objectUrl = candidate;
    await dependencies.triggerDownload({ objectUrl, filename: result.filename });
    outcome = {
      kind: "downloaded",
      requestId: result.requestId,
      filename: result.filename,
      grain: result.grain,
      asOf: result.asOf,
      revisionSha256: result.revisionSha256,
      orderCount: result.orderCount,
      rowCount: result.rowCount,
    };
  } catch {
    outcome = downloadFailed(result.requestId);
  }
  if (objectUrl) {
    try {
      dependencies.revokeObjectUrl(objectUrl);
    } catch {
      outcome = downloadFailed(result.requestId);
    }
  }
  return outcome;
}

function createCoordinator(
  dependencies: EffectiveOrderCsvDownloadCoordinatorDependenciesV4,
  input: CsvResult,
  version: EffectiveOrderCsvContract,
): EffectiveOrderCsvDownloadCoordinatorV4 {
  if (dependencies?.config?.enabled !== true) {
    return { enabled: false, status: "disabled" };
  }
  validateDependencies(dependencies);
  const result = validateExportResult(input, version);
  let execution: Promise<EffectiveOrderCsvDownloadResultV4> | undefined;
  return {
    enabled: true,
    execute: () => {
      execution ||= performDownload(dependencies, result);
      return execution;
    },
  };
}

export function createEffectiveOrderCsvDownloadCoordinatorV4(dependencies: EffectiveOrderCsvDownloadCoordinatorDependenciesV4, input: EffectiveOrderCsvExportResultV4): EffectiveOrderCsvDownloadCoordinatorV4 {
  return createCoordinator(dependencies, input, "orders.effective-order.v4");
}
export function createEffectiveOrderCsvDownloadCoordinatorV5(dependencies: EffectiveOrderCsvDownloadCoordinatorDependenciesV4, input: EffectiveOrderCsvExportResultV4<"orders.effective-order.v5">): EffectiveOrderCsvDownloadCoordinatorV4 {
  return createCoordinator(dependencies, input, "orders.effective-order.v5");
}
