import {
  DASHBOARD_SYSTEM_DEFAULT_TIME_ZONE,
  permissions,
  type EffectiveOrderAuditIdentityV1,
  EffectiveOrderRecreatePrefillV2Schema,
  EffectiveOrderRecreatePrefillV3Schema, type EffectiveOrderRecreatePrefillV3,
  type EffectiveOrderCustomerSummaryV1,
  type EffectiveOrderRecreateCatalogCandidateV1,
  type EffectiveOrderRecreatePrefillV1,
  type EffectiveOrderRecreatePrefillV2,
  type EffectiveOrderSurfaceV2,
  type EffectiveOrderSurfaceV3,
  type OperatingScope,
  type OrderCustomerAttributionV1,
  CreatorSelectionV1Schema,
  type CreatorSelectionV1,
  type OrderCursorFiltersV1,
  type ReportScope,
  CreatorSalesDashboardV2Schema, CreatorSalesDashboardV3Schema, type CreatorSalesDashboardV3,
  type CreatorSalesDashboardV2,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { withConnectedReportClient } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import {
  handleDashboardPartialFinancialHttpV1,
  type DashboardPartialFinancialHttpResponseV1,
} from "./dashboard-partial-financial-http-handler";
import {
  normalizeDashboardLocalDateRange,
  resolveDashboardStoreWindows, resolveDashboardHistoryStoreWindows,
} from "./dashboard-report-foundation";
import {
  handleEffectiveOrderCsvHttpV3,
  type EffectiveOrderCsvHttpResponseV3,
} from "./effective-order-csv-http-handler";
import {
  handleEffectiveOrderCsvHttpV5,
  handleEffectiveOrderCsvHttpV4,
  type EffectiveOrderCsvHttpResponseV4,
} from "./effective-order-csv-v4-http-handler";
import type { EffectiveOrderCsvSnapshotGrainV3 } from "./effective-order-csv-snapshot-export-service";
import {
  handleEffectiveOrderPageHttpV2,
  type EffectiveOrderPageHttpResponseV2,
} from "./effective-order-page-http-handler";
import {
  handleEffectiveOrderPageHttpV3,
  type EffectiveOrderPageHttpResponseV3,
} from "./effective-order-page-v3-http-handler";
import {
  handleEffectiveOrderPageHttpV4,
  handleEffectiveOrderPageHttpV5,
  type EffectiveOrderPageHttpResponseV4,
  type EffectiveOrderPageHttpResponseV5,
} from "./effective-order-page-v4-http-handler";
import type { OrderCursorKeyringV1 } from "./order-cursor-service";
import { PostgresOrderPageSnapshotRepositoryV1 } from "./postgres-order-page-snapshot-repository";
import {
  assertCreatorSelectionInScopeV1,
  readCreatorOptionsV1,
} from "./creator-sales-overview-service";
import { readCreatorSalesDashboardV2, readCreatorSalesDashboardV3 } from "./creator-sales-dashboard-v2-service";
import { readEffectiveOrderSurfaceV2, readEffectiveOrderSurfaceV3 } from "./effective-order-surface-service";
import { readEffectiveOrderV1, readEffectiveOrderV2 } from "./effective-order-projection-service";
import {
  buildEffectiveOrderReceiptTextV2,
  buildEffectiveOrderReceiptV2,
  buildEffectiveOrderRecreatePrefillV1,
  buildEffectiveOrderRecreatePrefillFromV2,
} from "./effective-order-receipt-recreate-service";

/**
 * Canonical order-financial route boundary. All product surfaces are selected;
 * missing final schema or cursor-key material fails closed at request time.
 */
export const ORDER_FINANCIAL_FEATURE_ROUTE_DEFAULT_CONFIG_V1 = Object.freeze({
  effectiveOrderPageEnabled: true,
  effectiveOrderDetailEnabled: true,
  effectiveOrderReceiptEnabled: true,
  effectiveOrderRecreateEnabled: true,
  effectiveOrderCsvEnabled: true,
  partialFinancialDashboardEnabled: true,
  statementTimeoutMs: 5_000,
});

export interface OrderFinancialFeatureRouteConfigV1 {
  effectiveOrderPageEnabled: boolean;
  effectiveOrderDetailEnabled: boolean;
  effectiveOrderReceiptEnabled: boolean;
  effectiveOrderRecreateEnabled: boolean;
  effectiveOrderCsvEnabled: boolean;
  partialFinancialDashboardEnabled: boolean;
  statementTimeoutMs: number;
  orderCursorKeyring?: OrderCursorKeyringV1;
}

export interface EffectiveOrderFeatureSelectionV1 {
  scope: ReportScope;
  from: string;
  to: string;
  search?: string;
  statusMode?: "all" | "completed" | "other";
}

export interface EffectiveOrderFeaturePageRequestV1 extends EffectiveOrderFeatureSelectionV1 {
  limit?: number;
  cursor?: string;
  nowEpochSeconds: number;
}

export interface EffectiveOrderFeaturePageRequestV4 extends EffectiveOrderFeaturePageRequestV1 {
  creatorOperatorIds?: readonly string[];
}

export interface EffectiveOrderFeatureDetailRequestV1 {
  scope: ReportScope;
  orderId: string;
}

export interface EffectiveOrderFeatureReceiptRequestV1 {
  scope: ReportScope;
  orderId: string;
}

export interface EffectiveOrderFeatureRecreateRequestV1 {
  scope: OperatingScope;
  orderId: string;
}

export interface EffectiveOrderFeatureCsvRequestV1 extends EffectiveOrderFeatureSelectionV1 {
  grain: EffectiveOrderCsvSnapshotGrainV3;
  batchSize?: number;
}

export interface EffectiveOrderFeatureCsvRequestV4 extends EffectiveOrderFeatureCsvRequestV1 {
  creatorOperatorIds?: readonly string[];
}

export interface PartialFinancialFeatureDashboardRequestV1 {
  scope: ReportScope;
  from: string;
  to: string;
}

export interface CreatorSalesDashboardFeatureRequestV2 {
  scope: ReportScope;
  from: string;
  to: string;
  creatorOperatorIds?: readonly string[];
  audience: "full" | "self";
  selfOperatorId?: string;
}

export async function getOrderCreatorOptionsV1(
  scope: ReportScope,
  dependencies: Pick<FeatureRouteDependenciesV1, "withClient"> = {},
) {
  return (dependencies.withClient || withConnectedReportClient)((client) =>
    readCreatorOptionsV1(client, scope));
}

async function getCreatorSalesDashboardFeature(
  request: CreatorSalesDashboardFeatureRequestV2,
  configInput?: Partial<OrderFinancialFeatureRouteConfigV1>,
  dependencies: Pick<FeatureRouteDependenciesV1, "withClient"> = {},
  version: 2 | 3 = 2,
): Promise<CreatorSalesDashboardV2 | CreatorSalesDashboardV3> {
  const config = runtimeConfig(configInput);
  const creatorSelection = canonicalCreatorSelection(request.creatorOperatorIds);
  return (dependencies.withClient || withConnectedReportClient)<CreatorSalesDashboardV2 | CreatorSalesDashboardV3>((client) =>
    (version === 3 ? readCreatorSalesDashboardV3 : readCreatorSalesDashboardV2)(client, {
      scope: request.scope,
      range: { from: request.from, to: request.to },
      creatorSelection,
      audience: request.audience,
      ...(request.selfOperatorId ? { selfOperatorId: request.selfOperatorId } : {}),
      statementTimeoutMs: config.statementTimeoutMs,
    }));
}
export async function getCreatorSalesDashboardFeatureV2(request: CreatorSalesDashboardFeatureRequestV2, config?: Partial<OrderFinancialFeatureRouteConfigV1>, dependencies: Pick<FeatureRouteDependenciesV1, "withClient"> = {}): Promise<CreatorSalesDashboardV2> {
  return CreatorSalesDashboardV2Schema.parse(await getCreatorSalesDashboardFeature(request, config, dependencies, 2));
}
export async function getCreatorSalesDashboardFeatureV3(request: CreatorSalesDashboardFeatureRequestV2, config?: Partial<OrderFinancialFeatureRouteConfigV1>, dependencies: Pick<FeatureRouteDependenciesV1, "withClient"> = {}): Promise<CreatorSalesDashboardV3> {
  return CreatorSalesDashboardV3Schema.parse(await getCreatorSalesDashboardFeature(request, config, dependencies, 3));
}


type WithClient = <T>(read: (client: PoolClient) => Promise<T>) => Promise<T>;

interface FeatureRouteDependenciesV1 {
  withClient?: WithClient;
  resolveStoreWindows?: typeof resolveDashboardStoreWindows;
  createRepository?: (
    client: PoolClient,
    statementTimeoutMs: number,
  ) => PostgresOrderPageSnapshotRepositoryV1;
  handlePage?: typeof handleEffectiveOrderPageHttpV2;
  handlePageV3?: typeof handleEffectiveOrderPageHttpV3;
  handlePageV4?: typeof handleEffectiveOrderPageHttpV4;
  handlePageV5?: typeof handleEffectiveOrderPageHttpV5;
  handleCsv?: typeof handleEffectiveOrderCsvHttpV3;
  handleCsvV4?: typeof handleEffectiveOrderCsvHttpV4;
  handleCsvV5?: typeof handleEffectiveOrderCsvHttpV5;
  handleDashboard?: typeof handleDashboardPartialFinancialHttpV1;
  readDetailIdentity?: typeof readDetailIdentity;
  readDetailSurface?: typeof readEffectiveOrderSurfaceV2;
  readDetailSurfaceV3?: typeof readEffectiveOrderSurfaceV3;
  readReceiptIdentity?: typeof readReceiptIdentity;
  readReceiptProjection?: typeof readEffectiveOrderV2;
  readProjection?: typeof readEffectiveOrderV1;
  readRecreateCandidates?: typeof readRecreateCandidates;
  assertCreatorSelection?: typeof assertCreatorSelectionInScopeV1;
}

function disabled(surface: string): never {
  throw new PlatformError(
    "feature_disabled",
    `${surface} is present but disabled in the feature-only work package`,
    403,
  );
}

function runtimeConfig(
  config?: Partial<OrderFinancialFeatureRouteConfigV1>,
): OrderFinancialFeatureRouteConfigV1 {
  const configuredCursorKey = process.env.ORDER_CURSOR_CURRENT_KEY;
  const configuredCursorKeyId = process.env.ORDER_CURSOR_CURRENT_KEY_ID;
  const environmentKeyring = configuredCursorKey && configuredCursorKeyId
    ? {
        current: {
          keyId: configuredCursorKeyId,
          keyBase64Url: configuredCursorKey,
        },
        ...(process.env.ORDER_CURSOR_PREVIOUS_KEY && process.env.ORDER_CURSOR_PREVIOUS_KEY_ID
          ? {
              previous: {
                keyId: process.env.ORDER_CURSOR_PREVIOUS_KEY_ID,
                keyBase64Url: process.env.ORDER_CURSOR_PREVIOUS_KEY,
              },
            }
          : {}),
      }
    : undefined;
  return {
    ...ORDER_FINANCIAL_FEATURE_ROUTE_DEFAULT_CONFIG_V1,
    ...(environmentKeyring ? { orderCursorKeyring: environmentKeyring } : {}),
    ...config,
  };
}

function filters(
  request: EffectiveOrderFeatureSelectionV1,
  storeWindows: Awaited<ReturnType<typeof resolveDashboardStoreWindows>>,
): OrderCursorFiltersV1 {
  return {
    searchMode: "order_identity",
    ...(request.search?.trim() ? { search: request.search.trim().toLowerCase() } : {}),
    statusMode: request.statusMode || "all",
    storeWindows: storeWindows.map(({ storeId, startInclusive, endExclusive }) => ({
      storeId,
      startInclusive,
      endExclusive,
    })),
  };
}

function customerFilters(
  request: EffectiveOrderFeatureSelectionV1,
  storeWindows: Awaited<ReturnType<typeof resolveDashboardStoreWindows>>,
): OrderCursorFiltersV1 {
  return {
    searchMode: "order_or_customer_identity",
    ...(request.search?.trim() ? { search: request.search.trim().toLowerCase().replace(/\s+/g, " ") } : {}),
    statusMode: request.statusMode || "all",
    storeWindows: storeWindows.map(({ storeId, startInclusive, endExclusive }) => ({
      storeId,
      startInclusive,
      endExclusive,
    })),
  };
}

function canonicalCreatorSelection(
  operatorIds: readonly string[] | undefined,
): CreatorSelectionV1 {
  if (operatorIds?.some((value) => typeof value !== "string" || !value.trim() || value.trim().length > 160)) {
    throw new PlatformError("validation_error", "Creator selection is invalid", 400);
  }
  const normalized = [...new Set((operatorIds || []).map((value) => value.trim()))]
    .sort();
  const candidate = normalized.length === 0
    ? { mode: "all" as const, creatorOperatorIds: [] as [] }
    : { mode: "selected" as const, creatorOperatorIds: normalized };
  const parsed = CreatorSelectionV1Schema.safeParse(candidate);
  if (!parsed.success) {
    throw new PlatformError("validation_error", "Creator selection is invalid", 400);
  }
  return parsed.data;
}

function customerFiltersV4(
  request: EffectiveOrderFeatureSelectionV1,
  storeWindows: Awaited<ReturnType<typeof resolveDashboardStoreWindows>>,
  creatorSelection: CreatorSelectionV1,
): OrderCursorFiltersV1 {
  return {
    ...customerFilters(request, storeWindows),
    creatorSelection,
  };
}

function repositoryFactory(
  client: PoolClient,
  statementTimeoutMs: number,
): PostgresOrderPageSnapshotRepositoryV1 {
  return new PostgresOrderPageSnapshotRepositoryV1(client, statementTimeoutMs, "active_or_suspended");
}

async function readDetailIdentity(
  client: PoolClient,
  request: EffectiveOrderFeatureDetailRequestV1,
): Promise<{ orderId: string; currencyCode: string; asOf: string }> {
  const result = await client.query<Record<string, unknown>>(`
    SELECT
      o.id AS order_id,
      UPPER(o.currency_code) AS currency_code,
      transaction_timestamp() AS projection_as_of
    FROM public."order" o
    WHERE o.deleted_at IS NULL
      AND o.id = $1
      AND o.merchant_id = $2
      AND o.store_id = ANY($3::text[])
    LIMIT 1
  `, [request.orderId, request.scope.merchantId, request.scope.storeIds]);
  const row = result.rows[0];
  const orderId = typeof row?.order_id === "string" ? row.order_id : "";
  const currencyCode = typeof row?.currency_code === "string" ? row.currency_code : "";
  const rawAsOf = row?.projection_as_of;
  const asOfDate = rawAsOf instanceof Date ? rawAsOf : new Date(String(rawAsOf || ""));
  if (!orderId || !currencyCode || !Number.isFinite(asOfDate.getTime())) {
    throw new PlatformError("resource_not_found", "Order not found", 404);
  }
  return { orderId, currencyCode, asOf: asOfDate.toISOString() };
}

export async function getEffectiveOrderFeatureDetailV2(
  request: EffectiveOrderFeatureDetailRequestV1,
  configInput?: Partial<OrderFinancialFeatureRouteConfigV1>,
  dependencies: FeatureRouteDependenciesV1 = {},
): Promise<EffectiveOrderSurfaceV2> {
  const config = runtimeConfig(configInput);
  if (!config.effectiveOrderDetailEnabled) disabled("Effective-order detail v2");
  const connect = dependencies.withClient || withConnectedReportClient;
  const readIdentity = dependencies.readDetailIdentity || readDetailIdentity;
  const readSurface = dependencies.readDetailSurface || readEffectiveOrderSurfaceV2;
  return connect(async (client) => {
    const identity = await readIdentity(client, request);
    return readSurface(client, {
      surfaceKind: "detail",
      scope: request.scope,
      orderId: identity.orderId,
      currencyCode: identity.currencyCode,
      asOf: identity.asOf,
    });
  });
}

export async function getEffectiveOrderFeatureDetailV3(
  request: EffectiveOrderFeatureDetailRequestV1,
  configInput?: Partial<OrderFinancialFeatureRouteConfigV1>,
  dependencies: FeatureRouteDependenciesV1 = {},
): Promise<EffectiveOrderSurfaceV3> {
  const config = runtimeConfig(configInput);
  if (!config.effectiveOrderDetailEnabled) disabled("Effective-order detail v3");
  return (dependencies.withClient || withConnectedReportClient)(async (client) => {
    const identity = await (dependencies.readDetailIdentity || readDetailIdentity)(client, request);
    return (dependencies.readDetailSurfaceV3 || readEffectiveOrderSurfaceV3)(client, {
      surfaceKind: "detail", scope: request.scope, orderId: identity.orderId,
      currencyCode: identity.currencyCode, asOf: identity.asOf,
    });
  });
}

interface ReceiptProjectionIdentityV1 {
  sourceOrder: EffectiveOrderAuditIdentityV1;
  currencyCode: string;
  asOf: string;
  storeName: string;
  customer?: EffectiveOrderCustomerSummaryV1 | null;
  customerAttribution?: OrderCustomerAttributionV1;
}

function receiptStoreTimeZone(value: unknown): string {
  const timeZone = typeof value === "string" && value.trim()
    ? value.trim()
    : DASHBOARD_SYSTEM_DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone }).format(0);
  } catch {
    throw new PlatformError("store_timezone_invalid", "Store timezone configuration is invalid", 422);
  }
  return timeZone;
}

async function readReceiptIdentity(
  client: PoolClient,
  request: EffectiveOrderFeatureReceiptRequestV1,
): Promise<ReceiptProjectionIdentityV1> {
  const result = await client.query<Record<string, unknown>>(`
    SELECT
      o.id AS order_id,
      COALESCE(o.custom_display_id, 'ORD-' || o.display_id::text) AS order_number,
      o.created_at,
      UPPER(o.currency_code) AS currency_code,
      s.display_name AS store_name,
      NULLIF(BTRIM(s.metadata->'ownerSettings'->>'timezone'), '') AS store_time_zone,
      c.id AS customer_id,
      c.first_name AS customer_first_name,
      c.last_name AS customer_last_name,
      c.phone AS customer_phone,
      CASE
        WHEN c.id IS NOT NULL THEN 'linked'
        WHEN o.metadata->>'customerAttributionMode' = 'walk_in' THEN 'walk_in'
        ELSE 'unknown'
      END AS customer_attribution,
      transaction_timestamp() AS projection_as_of
    FROM public."order" o
    JOIN app.stores s
      ON s.id = o.store_id
     AND s.merchant_id = o.merchant_id
     AND s.status = 'active'
    LEFT JOIN public.customer c
      ON c.id = o.customer_id
     AND c.merchant_id = o.merchant_id
     AND c.deleted_at IS NULL
    WHERE o.deleted_at IS NULL
      AND o.id = $1
      AND o.merchant_id = $2
      AND o.store_id = ANY($3::text[])
    LIMIT 1
  `, [request.orderId, request.scope.merchantId, request.scope.storeIds]);
  const row = result.rows[0];
  const createdAt = row?.created_at instanceof Date
    ? row.created_at
    : new Date(String(row?.created_at || ""));
  const asOf = row?.projection_as_of instanceof Date
    ? row.projection_as_of
    : new Date(String(row?.projection_as_of || ""));
  const storeTimeZone = receiptStoreTimeZone(row?.store_time_zone);
  if (
    typeof row?.order_id !== "string"
    || typeof row.order_number !== "string"
    || typeof row.currency_code !== "string"
    || typeof row.store_name !== "string"
    || !Number.isFinite(createdAt.getTime())
    || !Number.isFinite(asOf.getTime())
  ) {
    throw new PlatformError("resource_not_found", "Order receipt source is unavailable", 404);
  }
  return {
    sourceOrder: {
      orderId: row.order_id,
      orderNumber: row.order_number,
      createdAt: createdAt.toISOString(),
      storeTimeZone,
    },
    currencyCode: row.currency_code,
    asOf: asOf.toISOString(),
    storeName: row.store_name,
    customerAttribution: String(row.customer_attribution || "unknown") as OrderCustomerAttributionV1,
    customer: typeof row.customer_id === "string" ? {
      id: row.customer_id,
      firstName: typeof row.customer_first_name === "string" ? row.customer_first_name : null,
      lastName: typeof row.customer_last_name === "string" ? row.customer_last_name : null,
      phone: typeof row.customer_phone === "string" ? row.customer_phone : null,
    } : null,
  };
}

async function effectiveReceiptText(
  client: PoolClient,
  request: EffectiveOrderFeatureReceiptRequestV1,
  dependencies: FeatureRouteDependenciesV1,
): Promise<string> {
  const identity = await (dependencies.readReceiptIdentity || readReceiptIdentity)(client, request);
  const projection = await (dependencies.readReceiptProjection || readEffectiveOrderV2)(client, {
    scope: request.scope,
    orderId: identity.sourceOrder.orderId,
    currencyCode: identity.currencyCode,
    asOf: identity.asOf,
  });
  const receipt = buildEffectiveOrderReceiptV2(identity.sourceOrder, projection);
  return buildEffectiveOrderReceiptTextV2(receipt, {
    storeName: identity.storeName,
    storeAddress: process.env.STORE_ADDRESS?.trim() || "",
  });
}

export async function getEffectiveOrderFeatureReceiptTextV1(
  request: EffectiveOrderFeatureReceiptRequestV1,
  configInput?: Partial<OrderFinancialFeatureRouteConfigV1>,
  dependencies: FeatureRouteDependenciesV1 = {},
): Promise<string> {
  const config = runtimeConfig(configInput);
  if (!config.effectiveOrderReceiptEnabled) disabled("Effective-order receipt v1");
  return (dependencies.withClient || withConnectedReportClient)(
    (client) => effectiveReceiptText(client, request, dependencies),
  );
}

export async function getEffectiveOrderFeatureReceiptPdfV1(
  request: EffectiveOrderFeatureReceiptRequestV1,
  configInput?: Partial<OrderFinancialFeatureRouteConfigV1>,
  dependencies: FeatureRouteDependenciesV1 = {},
): Promise<Buffer> {
  const text = await getEffectiveOrderFeatureReceiptTextV1(request, configInput, dependencies);
  const { default: PDFDocument } = await import("pdfkit");
  const document = new PDFDocument({
    size: "A6",
    margin: 24,
    info: { Title: `Effective receipt ${request.orderId}` },
  });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });
  document.fontSize(10).text(text, { lineGap: 2 });
  document.end();
  return done;
}

async function readRecreateCandidates(
  client: PoolClient,
  scope: OperatingScope,
  variantIds: readonly string[],
  currencyCode: string,
): Promise<EffectiveOrderRecreateCatalogCandidateV1[]> {
  if (variantIds.length === 0) return [];
  const result = await client.query<Record<string, unknown>>(`
    SELECT
      pv.product_id,
      pv.id AS variant_id,
      COALESCE(NULLIF(p.title, ''), pv.id) AS current_title,
      COALESCE(NULLIF(pv.sku, ''), pv.id) AS current_sku,
      price.amount::text AS current_unit_price_minor,
      GREATEST(COALESCE(stock.stock_available_quantity, 0), 0)::text
        AS stock_available_quantity,
      (p.status = 'published') AS published
    FROM public.product_variant pv
    JOIN public.product p
      ON p.id = pv.product_id
     AND p.deleted_at IS NULL
     AND p.merchant_id = $3
    JOIN LATERAL (
      SELECT pr.amount
      FROM public.product_variant_price_set vps
      JOIN public.price pr
        ON pr.price_set_id = vps.price_set_id
       AND pr.deleted_at IS NULL
       AND pr.amount IS NOT NULL
       AND LOWER(pr.currency_code) = LOWER($4)
      WHERE vps.variant_id = pv.id
        AND vps.deleted_at IS NULL
      ORDER BY pr.created_at ASC, pr.id ASC
      LIMIT 1
    ) price ON true
    LEFT JOIN LATERAL (
      SELECT SUM(il.stocked_quantity)::numeric AS stock_available_quantity
      FROM public.product_variant_inventory_item pvii
      JOIN public.inventory_level il
        ON il.inventory_item_id = pvii.inventory_item_id
       AND il.location_id = $2
       AND il.deleted_at IS NULL
      WHERE pvii.variant_id = pv.id
        AND pvii.deleted_at IS NULL
    ) stock ON true
    WHERE pv.id = ANY($1::text[])
      AND pv.deleted_at IS NULL
    ORDER BY pv.id
  `, [variantIds, scope.stockLocationId, scope.merchantId, currencyCode]);
  return result.rows.map((row) => ({
    productId: String(row.product_id),
    variantId: String(row.variant_id),
    currentTitle: String(row.current_title),
    currentSku: String(row.current_sku),
    currentUnitPriceMinor: Number(row.current_unit_price_minor),
    stockAvailableQuantity: Number(row.stock_available_quantity),
    published: row.published === true,
    archived: false,
  }));
}

export async function getEffectiveOrderFeatureRecreateV1(
  request: EffectiveOrderFeatureRecreateRequestV1,
  configInput?: Partial<OrderFinancialFeatureRouteConfigV1>,
  dependencies: FeatureRouteDependenciesV1 = {},
): Promise<EffectiveOrderRecreatePrefillV1> {
  const config = runtimeConfig(configInput);
  if (!config.effectiveOrderRecreateEnabled) disabled("Effective-order recreate v1");
  const reportScope: ReportScope = {
    scopeKind: "report",
    merchantId: request.scope.merchantId,
    storeIds: [request.scope.storeId],
  };
  return (dependencies.withClient || withConnectedReportClient)(async (client) => {
    const identity = await (dependencies.readReceiptIdentity || readReceiptIdentity)(client, {
      scope: reportScope,
      orderId: request.orderId,
    });
    const projection = await (dependencies.readProjection || readEffectiveOrderV1)(client, {
      scope: reportScope,
      orderId: identity.sourceOrder.orderId,
      currencyCode: identity.currencyCode,
      asOf: identity.asOf,
    });
    const variantIds = [...new Set(projection.lines.flatMap((line) =>
      line.variantId ? [line.variantId] : []))];
    const candidates = await (dependencies.readRecreateCandidates || readRecreateCandidates)(
      client,
      request.scope,
      variantIds,
      identity.currencyCode,
    );
    return buildEffectiveOrderRecreatePrefillV1(
      identity.sourceOrder,
      projection,
      candidates,
    );
  });
}

async function getEffectiveOrderFeatureRecreate(
  request: EffectiveOrderFeatureRecreateRequestV1,
  configInput?: Partial<OrderFinancialFeatureRouteConfigV1>,
  dependencies: FeatureRouteDependenciesV1 = {},
  version: 2 | 3 = 2,
): Promise<EffectiveOrderRecreatePrefillV2 | EffectiveOrderRecreatePrefillV3> {
  const config = runtimeConfig(configInput);
  if (!config.effectiveOrderRecreateEnabled) disabled(`Effective-order recreate v${version}`);
  const reportScope: ReportScope = {
    scopeKind: "report",
    merchantId: request.scope.merchantId,
    storeIds: [request.scope.storeId],
  };
  return (dependencies.withClient || withConnectedReportClient)(async (client) => {
    const identity = await (dependencies.readReceiptIdentity || readReceiptIdentity)(client, {
      scope: reportScope,
      orderId: request.orderId,
    });
    const readProjection = version === 3 ? dependencies.readReceiptProjection || readEffectiveOrderV2 : dependencies.readProjection || readEffectiveOrderV1;
    const projection = await readProjection(client, {
      scope: reportScope,
      orderId: identity.sourceOrder.orderId,
      currencyCode: identity.currencyCode,
      asOf: identity.asOf,
    });
    const variantIds = [...new Set(projection.lines.flatMap((line) =>
      line.variantId ? [line.variantId] : []))];
    const candidates = await (dependencies.readRecreateCandidates || readRecreateCandidates)(
      client,
      request.scope,
      variantIds,
      identity.currencyCode,
    );
    if (projection.schemaVersion !== (version === 3 ? 2 : 1)) throw new PlatformError("feature_unavailable", "Recreate projection version drift", 503);
    const reply = {
      schemaVersion: version,
      commercialPrefill: projection.schemaVersion === 2
        ? buildEffectiveOrderRecreatePrefillFromV2(identity.sourceOrder, projection, candidates)
        : buildEffectiveOrderRecreatePrefillV1(identity.sourceOrder, projection, candidates),
      customerAttribution: identity.customerAttribution
        ?? (identity.customer ? "linked" : "unknown"),
      customer: identity.customer ?? null,
    };
    return version === 3 ? EffectiveOrderRecreatePrefillV3Schema.parse(reply) : EffectiveOrderRecreatePrefillV2Schema.parse(reply);
  });
}

export async function getEffectiveOrderFeatureRecreateV2(request: EffectiveOrderFeatureRecreateRequestV1, config?: Partial<OrderFinancialFeatureRouteConfigV1>, dependencies: FeatureRouteDependenciesV1 = {}): Promise<EffectiveOrderRecreatePrefillV2> {
  return EffectiveOrderRecreatePrefillV2Schema.parse(await getEffectiveOrderFeatureRecreate(request, config, dependencies, 2));
}
export async function getEffectiveOrderFeatureRecreateV3(request: EffectiveOrderFeatureRecreateRequestV1, config?: Partial<OrderFinancialFeatureRouteConfigV1>, dependencies: FeatureRouteDependenciesV1 = {}): Promise<EffectiveOrderRecreatePrefillV3> {
  return EffectiveOrderRecreatePrefillV3Schema.parse(await getEffectiveOrderFeatureRecreate(request, config, dependencies, 3));
}

export async function getEffectiveOrderFeaturePageV2(
  request: EffectiveOrderFeaturePageRequestV1,
  configInput?: Partial<OrderFinancialFeatureRouteConfigV1>,
  dependencies: FeatureRouteDependenciesV1 = {},
): Promise<EffectiveOrderPageHttpResponseV2> {
  const config = runtimeConfig(configInput);
  if (!config.effectiveOrderPageEnabled) disabled("Effective-order page v2");
  if (!config.orderCursorKeyring) {
    throw new PlatformError(
      "feature_unavailable",
      "Effective-order page cursor keyring is not configured",
      503,
    );
  }
  const range = normalizeDashboardLocalDateRange({ from: request.from, to: request.to });
  const connect = dependencies.withClient || withConnectedReportClient;
  const resolveWindows = dependencies.resolveStoreWindows || resolveDashboardHistoryStoreWindows;
  const createRepository = dependencies.createRepository || repositoryFactory;
  const handlePage = dependencies.handlePage || handleEffectiveOrderPageHttpV2;
  return connect(async (client) => {
    const storeWindows = await resolveWindows(client, request.scope, range);
    return handlePage({
      repository: createRepository(client, config.statementTimeoutMs),
      keyring: config.orderCursorKeyring!,
      config: { enabled: true },
    }, {
      authorization: {
        permission: permissions.ordersRead,
        scope: request.scope,
      },
      filters: filters(request, storeWindows),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.cursor ? { cursor: request.cursor } : {}),
      nowEpochSeconds: request.nowEpochSeconds,
    });
  });
}

export async function getEffectiveOrderFeaturePageV3(
  request: EffectiveOrderFeaturePageRequestV1,
  configInput?: Partial<OrderFinancialFeatureRouteConfigV1>,
  dependencies: FeatureRouteDependenciesV1 = {},
): Promise<EffectiveOrderPageHttpResponseV3> {
  const config = runtimeConfig(configInput);
  if (!config.effectiveOrderPageEnabled) disabled("Effective-order page v3");
  if (!config.orderCursorKeyring) {
    throw new PlatformError(
      "feature_unavailable",
      "Effective-order page cursor keyring is not configured",
      503,
    );
  }
  const range = normalizeDashboardLocalDateRange({ from: request.from, to: request.to });
  const connect = dependencies.withClient || withConnectedReportClient;
  const resolveWindows = dependencies.resolveStoreWindows || resolveDashboardHistoryStoreWindows;
  const createRepository = dependencies.createRepository || repositoryFactory;
  const handlePage = dependencies.handlePageV3 || handleEffectiveOrderPageHttpV3;
  return connect(async (client) => {
    const storeWindows = await resolveWindows(client, request.scope, range);
    return handlePage({
      repository: createRepository(client, config.statementTimeoutMs),
      keyring: config.orderCursorKeyring!,
      config: { enabled: true },
    }, {
      authorization: {
        permission: permissions.ordersRead,
        scope: request.scope,
      },
      filters: customerFilters(request, storeWindows),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.cursor ? { cursor: request.cursor } : {}),
      nowEpochSeconds: request.nowEpochSeconds,
    });
  });
}

export async function getEffectiveOrderFeaturePageV4(
  request: EffectiveOrderFeaturePageRequestV4,
  configInput?: Partial<OrderFinancialFeatureRouteConfigV1>,
  dependencies: FeatureRouteDependenciesV1 = {},
): Promise<EffectiveOrderPageHttpResponseV4> {
  const config = runtimeConfig(configInput);
  if (!config.effectiveOrderPageEnabled) disabled("Effective-order page v4");
  if (!config.orderCursorKeyring) {
    throw new PlatformError(
      "feature_unavailable",
      "Effective-order page cursor keyring is not configured",
      503,
    );
  }
  const range = normalizeDashboardLocalDateRange({ from: request.from, to: request.to });
  const connect = dependencies.withClient || withConnectedReportClient;
  const resolveWindows = dependencies.resolveStoreWindows || resolveDashboardHistoryStoreWindows;
  const createRepository = dependencies.createRepository || repositoryFactory;
  const handlePage = dependencies.handlePageV4 || handleEffectiveOrderPageHttpV4;
  const assertCreatorSelection = dependencies.assertCreatorSelection || assertCreatorSelectionInScopeV1;
  const creatorSelection = canonicalCreatorSelection(request.creatorOperatorIds);
  return connect(async (client) => {
    const storeWindows = await resolveWindows(client, request.scope, range);
    await assertCreatorSelection(client, request.scope, creatorSelection);
    return handlePage({
      repository: createRepository(client, config.statementTimeoutMs),
      keyring: config.orderCursorKeyring!,
      config: { enabled: true },
    }, {
      authorization: { permission: permissions.ordersRead, scope: request.scope },
      filters: customerFiltersV4(request, storeWindows, creatorSelection),
      creatorSelection,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.cursor ? { cursor: request.cursor } : {}),
      nowEpochSeconds: request.nowEpochSeconds,
    });
  });
}

export async function getEffectiveOrderFeaturePageV5(
  request: EffectiveOrderFeaturePageRequestV4,
  configInput?: Partial<OrderFinancialFeatureRouteConfigV1>,
  dependencies: FeatureRouteDependenciesV1 = {},
): Promise<EffectiveOrderPageHttpResponseV5> {
  const config = runtimeConfig(configInput);
  if (!config.effectiveOrderPageEnabled) disabled("Effective-order page v5");
  if (!config.orderCursorKeyring) throw new PlatformError("feature_unavailable", "Effective-order page cursor keyring is not configured", 503);
  const range = normalizeDashboardLocalDateRange({ from: request.from, to: request.to });
  const creatorSelection = canonicalCreatorSelection(request.creatorOperatorIds);
  return (dependencies.withClient || withConnectedReportClient)(async (client) => {
    const storeWindows = await (dependencies.resolveStoreWindows || resolveDashboardHistoryStoreWindows)(client, request.scope, range);
    await (dependencies.assertCreatorSelection || assertCreatorSelectionInScopeV1)(client, request.scope, creatorSelection);
    return (dependencies.handlePageV5 || handleEffectiveOrderPageHttpV5)({
      repository: (dependencies.createRepository || repositoryFactory)(client, config.statementTimeoutMs),
      keyring: config.orderCursorKeyring!, config: { enabled: true },
    }, {
      authorization: { permission: permissions.ordersRead, scope: request.scope },
      filters: customerFiltersV4(request, storeWindows, creatorSelection), creatorSelection,
      ...(request.limit === undefined ? {} : { limit: request.limit }), ...(request.cursor ? { cursor: request.cursor } : {}),
      nowEpochSeconds: request.nowEpochSeconds,
    });
  });
}

export async function getEffectiveOrderFeatureCsvV3(
  request: EffectiveOrderFeatureCsvRequestV1,
  configInput?: Partial<OrderFinancialFeatureRouteConfigV1>,
  dependencies: FeatureRouteDependenciesV1 = {},
): Promise<EffectiveOrderCsvHttpResponseV3> {
  const config = runtimeConfig(configInput);
  if (!config.effectiveOrderCsvEnabled) disabled("Effective-order CSV v3");
  const range = normalizeDashboardLocalDateRange({ from: request.from, to: request.to });
  const connect = dependencies.withClient || withConnectedReportClient;
  const resolveWindows = dependencies.resolveStoreWindows || resolveDashboardHistoryStoreWindows;
  const createRepository = dependencies.createRepository || repositoryFactory;
  const handleCsv = dependencies.handleCsv || handleEffectiveOrderCsvHttpV3;
  return connect(async (client) => {
    const storeWindows = await resolveWindows(client, request.scope, range);
    return handleCsv({
      repository: createRepository(client, config.statementTimeoutMs),
      config: { enabled: true },
    }, {
      authorization: {
        permission: permissions.ordersExport,
        scope: request.scope,
      },
      filters: filters(request, storeWindows),
      grain: request.grain,
      ...(request.batchSize === undefined ? {} : { batchSize: request.batchSize }),
    });
  });
}

async function getFeatureCsv(
  request: EffectiveOrderFeatureCsvRequestV4,
  configInput?: Partial<OrderFinancialFeatureRouteConfigV1>,
  dependencies: FeatureRouteDependenciesV1 = {},
  version: 4 | 5 = 4,
): Promise<EffectiveOrderCsvHttpResponseV4> {
  const config = runtimeConfig(configInput);
  if (!config.effectiveOrderCsvEnabled) disabled(`Effective-order CSV v${version}`);
  const range = normalizeDashboardLocalDateRange({ from: request.from, to: request.to });
  const connect = dependencies.withClient || withConnectedReportClient;
  const resolveWindows = dependencies.resolveStoreWindows || resolveDashboardHistoryStoreWindows;
  const createRepository = dependencies.createRepository || repositoryFactory;
  const handleCsv = version === 5 ? (dependencies.handleCsvV5 || handleEffectiveOrderCsvHttpV5) : (dependencies.handleCsvV4 || handleEffectiveOrderCsvHttpV4);
  const creatorSelection = canonicalCreatorSelection(request.creatorOperatorIds);
  const assertCreatorSelection = dependencies.assertCreatorSelection || assertCreatorSelectionInScopeV1;
  return connect(async (client) => {
    const storeWindows = await resolveWindows(client, request.scope, range);
    await assertCreatorSelection(client, request.scope, creatorSelection);
    return handleCsv({
      repository: createRepository(client, config.statementTimeoutMs),
      config: { enabled: true },
    }, {
      authorization: { permission: permissions.ordersExport, scope: request.scope },
      // V4 intentionally uses the same customer search semantics as the
      // list; V3's identity-only CSV divergence is retained for compatibility.
      filters: customerFiltersV4(request, storeWindows, creatorSelection),
      creatorSelection,
      grain: request.grain,
      ...(request.batchSize === undefined ? {} : { batchSize: request.batchSize }),
    });
  });
}

export async function getPartialFinancialFeatureDashboardV1(
  request: PartialFinancialFeatureDashboardRequestV1,
  configInput?: Partial<OrderFinancialFeatureRouteConfigV1>,
  dependencies: FeatureRouteDependenciesV1 = {},
): Promise<DashboardPartialFinancialHttpResponseV1> {
  const config = runtimeConfig(configInput);
  if (!config.partialFinancialDashboardEnabled) {
    disabled("Partial financial dashboard v1");
  }
  const connect = dependencies.withClient || withConnectedReportClient;
  const handleDashboard = dependencies.handleDashboard
    || handleDashboardPartialFinancialHttpV1;
  return connect((client) => handleDashboard({
    client,
    config: {
      enabled: true,
      statementTimeoutMs: config.statementTimeoutMs,
    },
  }, {
    authorization: {
      permission: permissions.reportsRead,
      scope: request.scope,
    },
    range: { from: request.from, to: request.to },
  }));
}

export function getEffectiveOrderFeatureCsvV4(request: EffectiveOrderFeatureCsvRequestV4, config?: Partial<OrderFinancialFeatureRouteConfigV1>, dependencies: FeatureRouteDependenciesV1 = {}): Promise<EffectiveOrderCsvHttpResponseV4> {
  return getFeatureCsv(request, config, dependencies, 4);
}
export function getEffectiveOrderFeatureCsvV5(request: EffectiveOrderFeatureCsvRequestV4, config?: Partial<OrderFinancialFeatureRouteConfigV1>, dependencies: FeatureRouteDependenciesV1 = {}): Promise<EffectiveOrderCsvHttpResponseV4> {
  return getFeatureCsv(request, config, dependencies, 5);
}
