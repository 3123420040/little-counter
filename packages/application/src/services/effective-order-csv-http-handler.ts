import { createHash } from "node:crypto";
import {
  OrderCursorFiltersV1Schema,
  ReportScopeSchema,
  permissions,
  type OrderCursorFiltersV1,
  type ReportScope,
} from "@medusa-snus/contracts";
import { PlatformError } from "../errors/platform-error";
import {
  exportEffectiveOrderSnapshotCsvV3,
  type EffectiveOrderCsvSnapshotGrainV3,
  type EffectiveOrderCsvSnapshotRepositoryV3,
} from "./effective-order-csv-snapshot-export-service";

export const EFFECTIVE_ORDER_CSV_HTTP_DEFAULT_CONFIG_V3 = Object.freeze({
  enabled: false,
});

export interface EffectiveOrderCsvHttpHandlerDependenciesV3 {
  repository: EffectiveOrderCsvSnapshotRepositoryV3;
  config?: {
    enabled: boolean;
  };
}

export interface EffectiveOrderCsvHttpRequestV3 {
  authorization: {
    permission: typeof permissions.ordersExport;
    scope: ReportScope;
  };
  filters: OrderCursorFiltersV1;
  grain: EffectiveOrderCsvSnapshotGrainV3;
  batchSize?: number;
}

export interface EffectiveOrderCsvHttpResponseV3 {
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

export async function handleEffectiveOrderCsvHttpV3(
  dependencies: EffectiveOrderCsvHttpHandlerDependenciesV3,
  request: EffectiveOrderCsvHttpRequestV3,
): Promise<EffectiveOrderCsvHttpResponseV3> {
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
      "Effective-order CSV v3 is disabled",
      403,
    );
  }
  const filters = normalizeFilters(request.filters);
  assertFilterScope(scope.storeIds, filters);

  const artifact = await exportEffectiveOrderSnapshotCsvV3(
    dependencies.repository,
    {
      scope,
      filters,
      grain: request.grain,
      ...(request.batchSize === undefined
        ? {}
        : { batchSize: request.batchSize }),
    },
  );
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
