import type { OrderCursorFiltersV1, ReportScope } from "@medusa-snus/contracts";
import {
  normalizeEffectiveOrderSelectionV2,
  type EffectiveOrderPageQueryInputV2,
} from "./effectiveOrderPageQueryAdapter";

export const EFFECTIVE_ORDER_CSV_EXPORT_TASK_DEFAULT_CONFIG_V3 = Object.freeze({
  enabled: false,
});

export const EFFECTIVE_ORDER_CSV_SYNC_MAX_ORDERS_V3 = 10_000;
export const EFFECTIVE_ORDER_CSV_RESPONSE_CLOCK_SKEW_SECONDS_V3 = 30;

export type EffectiveOrderCsvExportGrainV3 = "order" | "effective_line";

export interface EffectiveOrderCsvExportTransportRequestV3 {
  scope: ReportScope;
  filters: OrderCursorFiltersV1;
  grain: EffectiveOrderCsvExportGrainV3;
}

export interface EffectiveOrderCsvExportTaskDependenciesV3 {
  transport: (
    request: EffectiveOrderCsvExportTransportRequestV3,
  ) => Promise<Response>;
  config?: {
    enabled: boolean;
  };
}

export interface EffectiveOrderCsvExportTaskInputV3 {
  requestId: string;
  scope: ReportScope;
  filters: EffectiveOrderPageQueryInputV2["filters"];
  grain: EffectiveOrderCsvExportGrainV3;
  nowEpochSeconds: number;
}

export type EffectiveOrderCsvExportResultV3 =
  | {
      kind: "ready";
      requestId: string;
      filename: string;
      blob: Blob;
      contractVersion: "orders.effective-order.v3";
      grain: EffectiveOrderCsvExportGrainV3;
      asOf: string;
      revisionSha256: string;
      orderCount: number;
      rowCount: number;
    }
  | {
      kind: "async_required";
      requestId: string;
      selectedOrderCount: number;
      maximumOrderCount: typeof EFFECTIVE_ORDER_CSV_SYNC_MAX_ORDERS_V3;
    }
  | {
      kind: "failed";
      requestId: string;
      message: "Unable to export orders";
    };

export type EffectiveOrderCsvExportTaskV3 =
  | {
      enabled: false;
      status: "disabled";
    }
  | {
      enabled: true;
      requestKey: string;
      request: EffectiveOrderCsvExportTransportRequestV3;
      execute: () => Promise<EffectiveOrderCsvExportResultV3>;
    };

export class EffectiveOrderCsvExportTaskErrorV3 extends Error {
  readonly code = "effective_order_csv_export_task_invalid";

  constructor(message: string) {
    super(message);
    this.name = "EffectiveOrderCsvExportTaskErrorV3";
  }
}

interface VerifiedResponseMetadataV3 {
  filename: string;
  contractVersion: "orders.effective-order.v3";
  grain: EffectiveOrderCsvExportGrainV3;
  asOf: string;
  revisionSha256: string;
  orderCount: number;
  rowCount: number;
  entityLength: number;
}

function requiredToken(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new EffectiveOrderCsvExportTaskErrorV3(`${field} is invalid`);
  }
  return value;
}

function normalizeSelection(input: EffectiveOrderCsvExportTaskInputV3): {
  scope: ReportScope;
  filters: OrderCursorFiltersV1;
} {
  try {
    return normalizeEffectiveOrderSelectionV2(input.scope, input.filters);
  } catch {
    throw new EffectiveOrderCsvExportTaskErrorV3("export selection is invalid");
  }
}

function normalizeGrain(value: unknown): EffectiveOrderCsvExportGrainV3 {
  if (value !== "order" && value !== "effective_line") {
    throw new EffectiveOrderCsvExportTaskErrorV3("export grain is invalid");
  }
  return value;
}

function normalizeClock(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new EffectiveOrderCsvExportTaskErrorV3("export clock is invalid");
  }
  return value as number;
}

function exportRequestKey(
  request: EffectiveOrderCsvExportTransportRequestV3,
): string {
  return `orders.effective-order.v3:${JSON.stringify({
    merchantId: request.scope.merchantId,
    storeIds: request.scope.storeIds,
    filters: request.filters,
    grain: request.grain,
  })}`;
}

function parseSafeCount(value: string | null): number | null {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function expectedDownloadInstant(asOf: string): string {
  return asOf.replace(/[-:]/g, "").replace(".000", "");
}

function dispositionFilename(value: string | null): string | null {
  if (value === null) return null;
  const match = /^attachment; filename="([A-Za-z0-9._-]+)"$/.exec(value);
  return match?.[1] ?? null;
}

function hasOnlyNoSniffDirectives(value: string | null): boolean {
  if (value === null) return false;
  const directives = value
    .split(",")
    .map((directive) => directive.trim().toLowerCase());
  return (
    directives.length > 0 &&
    directives.every((directive) => directive === "nosniff")
  );
}

function isUtf8CsvContentType(value: string | null): boolean {
  if (value === null) return false;
  const [mediaType, ...parameters] = value
    .split(";")
    .map((part) => part.trim().toLowerCase());
  return (
    mediaType === "text/csv" &&
    parameters.every((parameter) => parameter === "charset=utf-8")
  );
}

function verifiedResponseMetadata(
  response: Response,
  grain: EffectiveOrderCsvExportGrainV3,
  nowEpochSeconds: number,
): VerifiedResponseMetadataV3 | null {
  if (response.status !== 200) return null;
  // WebKit removes the optional UTF-8 charset parameter from a text/csv fetch
  // response. Both representations are valid for the route's UTF-8 payload;
  // all other media types and parameters still fail closed.
  if (!isUtf8CsvContentType(response.headers.get("Content-Type"))) {
    return null;
  }
  if (
    response.headers.get("Cache-Control")?.toLowerCase() !== "private, no-store"
  ) {
    return null;
  }
  // The route and the reverse proxy may both add the same security header.
  // Fetch combines repeated response headers as `nosniff, nosniff`; that is
  // equivalent to a single directive and must not make a valid export fail.
  // Any different or empty directive still fails closed.
  if (
    !hasOnlyNoSniffDirectives(response.headers.get("X-Content-Type-Options"))
  ) {
    return null;
  }
  const contractVersion = response.headers.get("X-Order-Export-Contract");
  const responseGrain = response.headers.get("X-Order-Export-Grain");
  const asOf = response.headers.get("X-Order-Export-As-Of");
  const revisionSha256 = response.headers.get("X-Order-Export-Revision-SHA256");
  const filename = dispositionFilename(
    response.headers.get("Content-Disposition"),
  );
  const orderCount = parseSafeCount(
    response.headers.get("X-Order-Export-Order-Count"),
  );
  const rowCount = parseSafeCount(
    response.headers.get("X-Order-Export-Row-Count"),
  );
  const wireLength = parseSafeCount(response.headers.get("Content-Length"));
  const contentEncoding =
    response.headers.get("Content-Encoding")?.trim() || null;
  const declaredEntityLength = parseSafeCount(
    response.headers.get("X-Order-Export-Content-Length"),
  );
  // Fetch returns a decoded Blob but preserves the encoded HTTP
  // Content-Length. Prefer the route's representation length; an identity
  // response from a pre-header server remains compatible through the wire
  // length fallback. Compressed responses without the entity contract fail
  // closed instead of comparing unlike byte counts.
  const entityLength =
    declaredEntityLength ?? (contentEncoding === null ? wireLength : null);
  if (
    contractVersion !== "orders.effective-order.v3" ||
    responseGrain !== grain ||
    asOf === null ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(asOf) ||
    new Date(asOf).toISOString() !== asOf ||
    Date.parse(asOf) >
      (nowEpochSeconds + EFFECTIVE_ORDER_CSV_RESPONSE_CLOCK_SKEW_SECONDS_V3) *
        1_000 ||
    revisionSha256 === null ||
    !/^[a-f0-9]{64}$/.test(revisionSha256) ||
    filename === null ||
    orderCount === null ||
    orderCount > EFFECTIVE_ORDER_CSV_SYNC_MAX_ORDERS_V3 ||
    rowCount === null ||
    (grain === "order" && rowCount !== orderCount) ||
    entityLength === null
  ) {
    return null;
  }
  const expectedFilename = `orders-effective-${grain}-${expectedDownloadInstant(asOf)}.csv`;
  if (filename !== expectedFilename) return null;
  return {
    filename,
    contractVersion,
    grain,
    asOf,
    revisionSha256,
    orderCount,
    rowCount,
    entityLength,
  };
}

function asyncRequiredResult(
  error: unknown,
  requestId: string,
): EffectiveOrderCsvExportResultV3 | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    details?: unknown;
  };
  if (
    candidate.status !== 413 ||
    candidate.code !== "async_export_required" ||
    !candidate.details ||
    typeof candidate.details !== "object"
  ) {
    return null;
  }
  const details = candidate.details as {
    selectedOrderCount?: unknown;
    maximumOrderCount?: unknown;
  };
  if (
    !Number.isSafeInteger(details.selectedOrderCount) ||
    !Number.isSafeInteger(details.maximumOrderCount) ||
    details.maximumOrderCount !== EFFECTIVE_ORDER_CSV_SYNC_MAX_ORDERS_V3 ||
    (details.selectedOrderCount as number) <=
      EFFECTIVE_ORDER_CSV_SYNC_MAX_ORDERS_V3
  ) {
    return null;
  }
  return {
    kind: "async_required",
    requestId,
    selectedOrderCount: details.selectedOrderCount as number,
    maximumOrderCount: EFFECTIVE_ORDER_CSV_SYNC_MAX_ORDERS_V3,
  };
}

function failed(requestId: string): EffectiveOrderCsvExportResultV3 {
  return {
    kind: "failed",
    requestId,
    message: "Unable to export orders",
  };
}

export async function validateEffectiveOrderCsvResponseV3(
  response: unknown,
  grain: EffectiveOrderCsvExportGrainV3,
  nowEpochSeconds: number,
  requestId: string,
): Promise<EffectiveOrderCsvExportResultV3> {
  const normalizedRequestId = requiredToken(requestId, "requestId");
  const normalizedGrain = normalizeGrain(grain);
  const normalizedNow = normalizeClock(nowEpochSeconds);
  if (!(response instanceof Response)) return failed(normalizedRequestId);
  const metadata = verifiedResponseMetadata(
    response,
    normalizedGrain,
    normalizedNow,
  );
  if (!metadata) return failed(normalizedRequestId);
  const blob = await response.blob();
  if (blob.size !== metadata.entityLength) return failed(normalizedRequestId);
  return {
    kind: "ready",
    requestId: normalizedRequestId,
    filename: metadata.filename,
    blob,
    contractVersion: metadata.contractVersion,
    grain: metadata.grain,
    asOf: metadata.asOf,
    revisionSha256: metadata.revisionSha256,
    orderCount: metadata.orderCount,
    rowCount: metadata.rowCount,
  };
}

export function createEffectiveOrderCsvExportTaskV3(
  dependencies: EffectiveOrderCsvExportTaskDependenciesV3,
  input: EffectiveOrderCsvExportTaskInputV3,
): EffectiveOrderCsvExportTaskV3 {
  if (dependencies.config?.enabled !== true) {
    return { enabled: false, status: "disabled" };
  }
  if (typeof dependencies.transport !== "function") {
    throw new EffectiveOrderCsvExportTaskErrorV3(
      "export transport is unavailable",
    );
  }
  const requestId = requiredToken(input.requestId, "requestId");
  const grain = normalizeGrain(input.grain);
  const nowEpochSeconds = normalizeClock(input.nowEpochSeconds);
  const { scope, filters } = normalizeSelection(input);
  const request: EffectiveOrderCsvExportTransportRequestV3 = {
    scope,
    filters,
    grain,
  };

  return {
    enabled: true,
    requestKey: exportRequestKey(request),
    request,
    execute: async () => {
      try {
        const response = await dependencies.transport(request);
        return validateEffectiveOrderCsvResponseV3(
          response,
          grain,
          nowEpochSeconds,
          requestId,
        );
      } catch (error) {
        return asyncRequiredResult(error, requestId) ?? failed(requestId);
      }
    },
  };
}
