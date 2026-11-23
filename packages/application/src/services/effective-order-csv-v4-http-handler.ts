import { createHash } from "node:crypto";
import {
  CreatorSelectionV1Schema,
  OrderCursorFiltersV1Schema,
  ReportScopeSchema,
  permissions,
  type OrderCursorFiltersV1,
  type CreatorSelectionV1,
  type ReportScope,
} from "@medusa-snus/contracts";
import { PlatformError } from "../errors/platform-error";
import {
  exportEffectiveOrderSnapshotCsvV5,
  type EffectiveOrderCsvSnapshotRepositoryV5,
  exportEffectiveOrderSnapshotCsvV4,
  type EffectiveOrderCsvSnapshotGrainV4,
  type EffectiveOrderCsvSnapshotRepositoryV4,
} from "./effective-order-csv-v4-snapshot-export-service";

export const EFFECTIVE_ORDER_CSV_HTTP_DEFAULT_CONFIG_V4 = Object.freeze({
  enabled: false,
});

export interface EffectiveOrderCsvHttpHandlerDependenciesV4 {
  repository: EffectiveOrderCsvSnapshotRepositoryV4;
  config?: {
    enabled: boolean;
  };
}

export interface EffectiveOrderCsvHttpHandlerDependenciesV5 extends Omit<EffectiveOrderCsvHttpHandlerDependenciesV4, "repository"> {
  repository: EffectiveOrderCsvSnapshotRepositoryV5;
}

export interface EffectiveOrderCsvHttpRequestV4 {
  authorization: {
    permission: typeof permissions.ordersExport;
    scope: ReportScope;
  };
  filters: OrderCursorFiltersV1;
  creatorSelection: CreatorSelectionV1;
  grain: EffectiveOrderCsvSnapshotGrainV4;
  batchSize?: number;
}

export interface EffectiveOrderCsvHttpResponseV4 {
  statusCode: 200;
  headers: Record<string, string>;
  body: string;
}

function normalizeAuthorizedScope(input: unknown): {
  merchantId: string;
  storeIds: string[];
} {
  const parsed = ReportScopeSchema.safeParse(input);
  if (
    !parsed.success ||
    new Set(parsed.data.storeIds).size !== parsed.data.storeIds.length
  ) {
    throw new PlatformError(
      "scope_required",
      "Effective-order CSV requires one merchant and a unique authorized store set",
      409,
    );
  }
  return {
    merchantId: parsed.data.merchantId,
    storeIds: [...parsed.data.storeIds].sort(),
  };
}

function normalizeFilters(input: unknown): OrderCursorFiltersV1 {
  const parsed = OrderCursorFiltersV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new PlatformError(
      "validation_error",
      "Effective-order CSV filters are invalid",
      400,
    );
  }
  return parsed.data;
}

function assertFilterScope(
  storeIds: readonly string[],
  filters: OrderCursorFiltersV1,
): void {
  const filterStoreIds = filters.storeWindows.map((window) => window.storeId);
  if (
    filterStoreIds.length !== storeIds.length ||
    storeIds.some((storeId, index) => storeId !== filterStoreIds[index])
  ) {
    throw new PlatformError(
      "validation_error",
      "Effective-order CSV filter windows must exactly match authorized stores",
      400,
    );
  }
}

function downloadInstant(asOf: string): string {
  return asOf.replace(/[-:]/g, "").replace(".000", "");
}

async function handleCsvHttp(
  command: { version: 4; dependencies: EffectiveOrderCsvHttpHandlerDependenciesV4 } | { version: 5; dependencies: EffectiveOrderCsvHttpHandlerDependenciesV5 },
  request: EffectiveOrderCsvHttpRequestV4,
): Promise<EffectiveOrderCsvHttpResponseV4> {
  const { dependencies } = command;
  if (request.authorization?.permission !== permissions.ordersExport) {
    throw new PlatformError(
      "forbidden",
      "The orders:export permission is required",
      403,
    );
  }
  const scope = normalizeAuthorizedScope(request.authorization.scope);
  if (dependencies.config?.enabled !== true) {
    throw new PlatformError(
      "feature_disabled",
      `Effective-order CSV v${command.version} is disabled`,
      403,
    );
  }
  const filters = normalizeFilters(request.filters);
  const creatorSelection = CreatorSelectionV1Schema.safeParse(request.creatorSelection);
  if (!creatorSelection.success) {
    throw new PlatformError("validation_error", "Effective-order CSV creator selection is invalid", 400);
  }
  if (
    filters.creatorSelection
    && JSON.stringify(filters.creatorSelection) !== JSON.stringify(creatorSelection.data)
  ) {
    throw new PlatformError("validation_error", "Effective-order CSV creator selection is inconsistent", 400);
  }
  assertFilterScope(scope.storeIds, filters);

  const exportRequest = {
      scope,
      filters: { ...filters, creatorSelection: creatorSelection.data },
      grain: request.grain,
      ...(request.batchSize === undefined
        ? {}
        : { batchSize: request.batchSize }),
  };
  const artifact = command.version === 5
    ? await exportEffectiveOrderSnapshotCsvV5(command.dependencies.repository, exportRequest)
    : await exportEffectiveOrderSnapshotCsvV4(command.dependencies.repository, exportRequest);
  const revisionJson = JSON.stringify(artifact.snapshot.storeRevisions);
  const revisionHash = createHash("sha256").update(revisionJson).digest("hex");
  const filename = `orders-effective-${artifact.grain}-${downloadInstant(artifact.snapshot.asOf)}.csv`;
  const entityLength = String(Buffer.byteLength(artifact.csv, "utf8"));

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": entityLength,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...(command.version === 5 ? {
        "X-Order-Export-Scope": JSON.stringify({ scopeKind: "report", ...scope }),
        "X-Order-Export-Creator-Selection": JSON.stringify(creatorSelection.data),
      } : {}),
      "X-Order-Export-Contract": artifact.snapshot.contractVersion,
      "X-Order-Export-Grain": artifact.grain,
      "X-Order-Export-As-Of": artifact.snapshot.asOf,
      "X-Order-Export-Revision-SHA256": revisionHash,
      "X-Order-Export-Order-Count": String(artifact.orderCount),
      "X-Order-Export-Row-Count": String(artifact.rowCount),
      // Content-Length becomes the compressed wire length at an encoding
      // reverse proxy. This additive header always describes the decoded CSV
      // entity that Fetch exposes as a Blob, so the browser can retain the
      // fail-closed size check through gzip/br/zstd edges.
      "X-Order-Export-Content-Length": entityLength,
    },
    body: artifact.csv,
  };
}

export function handleEffectiveOrderCsvHttpV4(dependencies: EffectiveOrderCsvHttpHandlerDependenciesV4, request: EffectiveOrderCsvHttpRequestV4): Promise<EffectiveOrderCsvHttpResponseV4> {
  return handleCsvHttp({ version: 4, dependencies }, request);
}
export function handleEffectiveOrderCsvHttpV5(dependencies: EffectiveOrderCsvHttpHandlerDependenciesV5, request: EffectiveOrderCsvHttpRequestV4): Promise<EffectiveOrderCsvHttpResponseV4> {
  return handleCsvHttp({ version: 5, dependencies }, request);
}
