export const EFFECTIVE_ORDER_CSV_SYNC_MAX_ORDERS_V4 = 10_000;
export const EFFECTIVE_ORDER_CSV_RESPONSE_CLOCK_SKEW_SECONDS_V4 = 30;

export type EffectiveOrderCsvExportGrainV4 = "order" | "effective_line";

export type EffectiveOrderCsvContract = "orders.effective-order.v4" | "orders.effective-order.v5";

export type EffectiveOrderCsvExportResultV4<V extends EffectiveOrderCsvContract = "orders.effective-order.v4"> =
  | {
      kind: "ready";
      requestId: string;
      filename: string;
      blob: Blob;
      contractVersion: V;
      grain: EffectiveOrderCsvExportGrainV4;
      asOf: string;
      revisionSha256: string;
      orderCount: number;
      rowCount: number;
    }
  | {
      kind: "async_required";
      requestId: string;
      selectedOrderCount: number;
      maximumOrderCount: typeof EFFECTIVE_ORDER_CSV_SYNC_MAX_ORDERS_V4;
    }
  | {
      kind: "failed";
      requestId: string;
      message: "Unable to export orders";
    };

export class EffectiveOrderCsvExportTaskErrorV4 extends Error {
  readonly code = "effective_order_csv_export_task_invalid";

  constructor(message: string) {
    super(message);
    this.name = "EffectiveOrderCsvExportTaskErrorV4";
  }
}

interface VerifiedResponseMetadataV4<V extends EffectiveOrderCsvContract> {
  filename: string;
  contractVersion: V;
  grain: EffectiveOrderCsvExportGrainV4;
  asOf: string;
  revisionSha256: string;
  orderCount: number;
  rowCount: number;
  entityLength: number;
}

function requiredToken(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new EffectiveOrderCsvExportTaskErrorV4(`${field} is invalid`);
  }
  return value;
}

function normalizeGrain(value: unknown): EffectiveOrderCsvExportGrainV4 {
  if (value !== "order" && value !== "effective_line") {
    throw new EffectiveOrderCsvExportTaskErrorV4("export grain is invalid");
  }
  return value;
}

function normalizeClock(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new EffectiveOrderCsvExportTaskErrorV4("export clock is invalid");
  }
  return value as number;
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

function verifiedResponseMetadata<V extends EffectiveOrderCsvContract>(
  response: Response,
  grain: EffectiveOrderCsvExportGrainV4,
  nowEpochSeconds: number,
  expectedVersion: V,
): VerifiedResponseMetadataV4<V> | null {
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
    contractVersion !== expectedVersion ||
    responseGrain !== grain ||
    asOf === null ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(asOf) ||
    !Number.isFinite(Date.parse(asOf)) ||
    new Date(asOf).toISOString() !== asOf ||
    Date.parse(asOf) >
      (nowEpochSeconds + EFFECTIVE_ORDER_CSV_RESPONSE_CLOCK_SKEW_SECONDS_V4) *
        1_000 ||
    revisionSha256 === null ||
    !/^[a-f0-9]{64}$/.test(revisionSha256) ||
    filename === null ||
    orderCount === null ||
    orderCount > EFFECTIVE_ORDER_CSV_SYNC_MAX_ORDERS_V4 ||
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
    contractVersion: expectedVersion,
    grain,
    asOf,
    revisionSha256,
    orderCount,
    rowCount,
    entityLength,
  };
}

function failed<V extends EffectiveOrderCsvContract>(requestId: string): EffectiveOrderCsvExportResultV4<V> {
  return {
    kind: "failed",
    requestId,
    message: "Unable to export orders",
  };
}

async function validateCsvResponse<V extends EffectiveOrderCsvContract>(
  response: unknown,
  grain: EffectiveOrderCsvExportGrainV4,
  nowEpochSeconds: number,
  requestId: string,
  expectedVersion: V,
): Promise<EffectiveOrderCsvExportResultV4<V>> {
  const normalizedRequestId = requiredToken(requestId, "requestId");
  const normalizedGrain = normalizeGrain(grain);
  const normalizedNow = normalizeClock(nowEpochSeconds);
  if (!(response instanceof Response)) return failed(normalizedRequestId);
  const metadata = verifiedResponseMetadata(
    response,
    normalizedGrain,
    normalizedNow,
    expectedVersion,
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

export function validateEffectiveOrderCsvResponseV4(response: unknown, grain: EffectiveOrderCsvExportGrainV4, now: number, requestId: string): Promise<EffectiveOrderCsvExportResultV4> {
  return validateCsvResponse(response, grain, now, requestId, "orders.effective-order.v4");
}
export function validateEffectiveOrderCsvResponseV5(response: unknown, grain: EffectiveOrderCsvExportGrainV4, now: number, requestId: string): Promise<EffectiveOrderCsvExportResultV4<"orders.effective-order.v5">> {
  return validateCsvResponse(response, grain, now, requestId, "orders.effective-order.v5");
}
