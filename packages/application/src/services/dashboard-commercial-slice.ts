import {
  DASHBOARD_METRIC_TIME_BASIS_V2,
  DashboardCommercialSliceV2Schema, OrderCommercialComponentsV2Schema,
  type DashboardCommercialSliceV2, type DashboardCommercialCurrencyV2,
  DashboardCommercialSliceV1Schema,
  DashboardReportContextV1Schema,
  merchandiseRevenueExVatMinor,
  OrderCommercialComponentsV1Schema,
  percentageOneDecimalHalfUp,
  shippingRevenueExVatMinor,
  SUPPORTED_CURRENCY_REGISTRY_V1,
  type DashboardCommercialCurrencyV1,
  type DashboardCommercialSliceV1,
  CreatorSelectionV1Schema,
  type CreatorSelectionV1,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import {
  generateDashboardLocalDateLabels,
  withDashboardReadSnapshot,
  type DashboardSnapshotReadContext,
  type DashboardSnapshotRequest,
  type DashboardSnapshotResult,
} from "./dashboard-report-foundation";

export const DASHBOARD_COMMERCIAL_TOP_PRODUCT_LIMIT = 5;

export type DashboardCommercialDataQualityIssueReason =
  | "invalid_context"
  | "missing_revision"
  | "unavailable_revision"
  | "unsupported_currency"
  | "invalid_projection"
  | "query_contract_violation";

export interface DashboardCommercialDataQualityIssue {
  orderId?: string;
  reason: DashboardCommercialDataQualityIssueReason;
  fields?: string[];
}

export class DashboardCommercialDataQualityError extends PlatformError {
  constructor(issues: DashboardCommercialDataQualityIssue[]) {
    super(
      "dashboard_commercial_data_quality",
      "Commercial dashboard data is unavailable or inconsistent",
      422,
      { issues },
    );
    this.name = "DashboardCommercialDataQualityError";
  }
}

type CommercialRow = {
  component_version?: unknown; payment_fee_minor?: unknown; payment_fee_vat_minor?: unknown;
  order_id: unknown;
  store_id: unknown;
  order_created_at: unknown;
  revision_id: unknown;
  revision: unknown;
  commercial_state: unknown;
  currency_code: unknown;
  minor_unit_exponent: unknown;
  data_quality: unknown;
  effective_at: unknown;
  tax_mode: unknown;
  merchandise_gross_minor: unknown;
  discount_minor: unknown;
  merchandise_net_minor: unknown;
  shipping_minor: unknown;
  merchandise_vat_minor: unknown;
  shipping_vat_minor: unknown;
  vat_minor: unknown;
  unclassified_minor: unknown;
  total_minor: unknown;
  line_key: unknown;
  product_id: unknown;
  variant_id: unknown;
  sku_snapshot: unknown;
  title_snapshot: unknown;
  archived_variant: unknown;
  quantity: unknown;
  unit_price_minor: unknown;
  line_total_minor: unknown;
  cost_minor: unknown;
  cost_evidence_id: unknown;
};

type NormalizedContext = ReturnType<typeof normalizeContext>;

type ProductAccumulator = {
  productId: string | null;
  variantId: string | null;
  skuSnapshot: string;
  titleSnapshot: string;
  archivedVariant: boolean;
  quantity: number;
  grossLineSalesBeforeDiscountMinor: number;
  knownCostMinor: number;
  knownLines: number;
  totalLines: number;
  labelOrderCreatedAt: string;
  labelOrderId: string;
  labelLineKey: string;
};

type CurrencyAccumulator = {
  currencyCode: string;
  minorUnitExponent: number;
  validOrderCount: number;
  cancelledOrderCohortCount: number;
  activeOrdersWithShippingCount: number;
  currentOrderGrossValueMinor: number;
  currentMerchandiseGrossValueMinor: number;
  currentDiscountMinor: number;
  currentMerchandiseRevenueExVatMinor: number;
  currentShippingRevenueExVatMinor: number;
  currentShippingGrossValueMinor: number;
  currentPaymentFeeMinor: number; currentPaymentFeeVatMinor: number; currentPaymentFeeCustomerTotalMinor: number; currentPaymentFeeRevenueExVatMinor: number;
  currentVatMinor: number;
  currentUnclassifiedMinor: number;
  dailyCurrentOrderGrossValueMinor: Map<string, number>;
  effectiveItemQuantity: number;
  knownCostMinor: number;
  knownCostLines: number;
  totalCostLines: number;
  partialCommercialSnapshot: boolean;
  products: Map<string, ProductAccumulator>;
};

const DASHBOARD_COMMERCIAL_SQL = `
  WITH store_windows AS (
    SELECT windows.store_id, windows.start_inclusive, windows.end_exclusive
    FROM unnest(
      $2::text[],
      $3::timestamptz[],
      $4::timestamptz[]
    ) AS windows(store_id, start_inclusive, end_exclusive)
  ), cohort_orders AS (
    SELECT o.id AS order_id, o.store_id, o.created_at AS order_created_at
    FROM public."order" o
    INNER JOIN store_windows windows ON windows.store_id = o.store_id
    WHERE o.merchant_id = $1
      AND o.created_at >= windows.start_inclusive
      AND o.created_at < LEAST(windows.end_exclusive, $5::timestamptz)
      AND (
        $6::text = 'all'
        OR EXISTS (
          /* Selected creators must have exactly one trusted human creation
             event in the same merchant/store.  The definition matches the
             order page and own-order cancellation boundary. */
          SELECT 1
          FROM audit.events creator_event
          WHERE creator_event.subject_type = 'order'
            AND creator_event.subject_id = o.id
            AND creator_event.action IN ('order.created', 'order.remote_created', 'order.partner_created')
          GROUP BY creator_event.subject_id
          HAVING COUNT(*) = 1
             AND MAX(creator_event.actor_type) IN ('staff', 'manager', 'owner', 'accountant')
             AND MAX(creator_event.merchant_id) = o.merchant_id
             AND MAX(creator_event.store_id) = o.store_id
             AND MAX(creator_event.actor_id) = ANY($7::text[])
        )
      )
  ), latest AS (
    SELECT
      cohort.order_id,
      cohort.store_id,
      cohort.order_created_at,
      revisions.id AS revision_id,
      revisions.revision,
      revisions.commercial_state,
      revisions.currency_code,
      revisions.minor_unit_exponent,
      revisions.data_quality,
      revisions.effective_at
    FROM cohort_orders cohort
    LEFT JOIN LATERAL (
      SELECT revision.*
      FROM app.order_commercial_revisions revision
      WHERE revision.merchant_id = $1
        AND revision.store_id = cohort.store_id
        AND revision.order_id = cohort.order_id
        AND revision.effective_at <= $5::timestamptz
      ORDER BY revision.revision DESC, revision.effective_at DESC, revision.id DESC
      LIMIT 1
    ) revisions ON true
  )
  SELECT
    latest.order_id,
    latest.store_id,
    latest.order_created_at,
    latest.revision_id,
    latest.revision,
    latest.commercial_state,
    latest.currency_code,
    latest.minor_unit_exponent,
    latest.data_quality,
    latest.effective_at,
    COALESCE((to_jsonb(components)->>'component_version')::smallint, 1) AS component_version,
    COALESCE((to_jsonb(components)->>'payment_fee_minor')::bigint, 0) AS payment_fee_minor,
    COALESCE((to_jsonb(components)->>'payment_fee_vat_minor')::bigint, 0) AS payment_fee_vat_minor,
    components.tax_mode,
    components.merchandise_gross_minor,
    components.discount_minor,
    components.merchandise_net_minor,
    components.shipping_minor,
    components.merchandise_vat_minor,
    components.shipping_vat_minor,
    components.vat_minor,
    components.unclassified_minor,
    components.total_minor,
    lines.line_key,
    lines.product_id,
    lines.variant_id,
    lines.sku_snapshot,
    lines.title_snapshot,
    lines.archived_variant,
    lines.quantity,
    lines.unit_price_minor,
    lines.line_total_minor,
    lines.cost_minor,
    lines.cost_evidence_id
  FROM latest
  LEFT JOIN app.order_commercial_revision_components components
    ON components.revision_id = latest.revision_id
  LEFT JOIN app.order_commercial_revision_lines lines
    ON lines.revision_id = latest.revision_id
  ORDER BY latest.order_id, lines.line_key, lines.id
`;

function issueFields(error: unknown): string[] | undefined {
  if (!(error instanceof Error) || !error.message) return undefined;
  return [...new Set(error.message.split(",").filter(Boolean))];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(field);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value == null) return null;
  return requiredString(value, field);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(field);
  return value;
}

function taxMode(value: unknown): "inclusive" | "exclusive" {
  if (value === "inclusive" || value === "exclusive") return value;
  throw new Error("tax_mode");
}

function safeInteger(value: unknown, field: string, minimum = 0): number {
  let parsed: number;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "bigint") parsed = Number(value);
  else if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) parsed = Number(value);
  else throw new Error(field);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(field);
  return parsed;
}

function safeAdd(left: number, right: number, field: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error(field);
  return value;
}

function safeMultiply(left: number, right: number, field: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) throw new Error(field);
  return value;
}

function isoInstant(value: unknown, field: string): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(field);
  return new Date(value).toISOString();
}

function normalizeContext(context: DashboardSnapshotReadContext) {
  const parsed = DashboardReportContextV1Schema.safeParse({
    schemaVersion: 1,
    normalizedScope: context.normalizedScope,
    localDateRange: context.localDateRange,
    storeTimeWindows: context.storeTimeWindows,
    reportAsOf: context.reportAsOf,
    generatedAt: context.reportAsOf,
    metricTimeBasis: context.metricTimeBasis,
    freshness: {
      databaseSnapshot: { status: "fresh", asOf: context.reportAsOf },
    },
  });
  if (!parsed.success) {
    throw new DashboardCommercialDataQualityError([{
      reason: "invalid_context",
      fields: parsed.error.issues.map((entry) => entry.path.join(".") || "context"),
    }]);
  }
  if (
    JSON.stringify(parsed.data.metricTimeBasis)
    !== JSON.stringify(DASHBOARD_METRIC_TIME_BASIS_V2)
  ) {
    throw new DashboardCommercialDataQualityError([{ reason: "invalid_context" }]);
  }
  return {
    merchantId: parsed.data.normalizedScope.merchantId,
    storeIds: parsed.data.storeTimeWindows.map((window) => window.storeId),
    startInclusive: parsed.data.storeTimeWindows.map((window) => window.startInclusive),
    endExclusive: parsed.data.storeTimeWindows.map((window) => window.endExclusive),
    reportAsOf: parsed.data.reportAsOf,
    localDateLabels: generateDashboardLocalDateLabels(parsed.data.localDateRange),
    windows: parsed.data.storeTimeWindows.map((window) => ({
      storeId: window.storeId,
      timeZone: window.timeZone,
      startEpochMs: Date.parse(window.startInclusive),
      endEpochMs: Math.min(Date.parse(window.endExclusive), Date.parse(parsed.data.reportAsOf)),
    })),
  };
}

function newCurrencyAccumulator(
  currencyCode: string,
  minorUnitExponent: number,
  localDateLabels: string[],
): CurrencyAccumulator {
  return {
    currencyCode,
    minorUnitExponent,
    validOrderCount: 0,
    cancelledOrderCohortCount: 0,
    activeOrdersWithShippingCount: 0,
    currentOrderGrossValueMinor: 0,
    currentMerchandiseGrossValueMinor: 0,
    currentDiscountMinor: 0,
    currentMerchandiseRevenueExVatMinor: 0,
    currentShippingRevenueExVatMinor: 0,
    currentShippingGrossValueMinor: 0,
    currentPaymentFeeMinor: 0, currentPaymentFeeVatMinor: 0, currentPaymentFeeCustomerTotalMinor: 0, currentPaymentFeeRevenueExVatMinor: 0,
    currentVatMinor: 0,
    currentUnclassifiedMinor: 0,
    dailyCurrentOrderGrossValueMinor: new Map(
      localDateLabels.map((localDate) => [localDate, 0]),
    ),
    effectiveItemQuantity: 0,
    knownCostMinor: 0,
    knownCostLines: 0,
    totalCostLines: 0,
    partialCommercialSnapshot: false,
    products: new Map(),
  };
}

const LOCAL_DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function owningStoreLocalDate(instant: string, timeZone: string): string {
  let formatter = LOCAL_DATE_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "iso8601",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    LOCAL_DATE_FORMATTERS.set(timeZone, formatter);
  }
  const parts = new Map(
    formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  if (!year || !month || !day) throw new Error("order_created_at_local_date");
  return `${year}-${month}-${day}`;
}

function productIdentity(input: {
  orderId: string;
  lineKey: string;
  productId: string | null;
  variantId: string | null;
  skuSnapshot: string;
}): string {
  if (input.variantId) {
    return JSON.stringify({ productId: input.productId, variantId: input.variantId });
  }
  if (input.productId) {
    return JSON.stringify({ productId: input.productId, skuSnapshot: input.skuSnapshot });
  }
  return JSON.stringify({ orderId: input.orderId, lineKey: input.lineKey });
}

function isNewerProductLabel(
  product: ProductAccumulator,
  candidate: { orderCreatedAt: string; orderId: string; lineKey: string },
): boolean {
  return candidate.orderCreatedAt > product.labelOrderCreatedAt
    || (
      candidate.orderCreatedAt === product.labelOrderCreatedAt
      && (
        candidate.orderId > product.labelOrderId
        || (
          candidate.orderId === product.labelOrderId
          && candidate.lineKey > product.labelLineKey
        )
      )
    );
}

function sortTopProducts(left: ProductAccumulator, right: ProductAccumulator): number {
  return right.grossLineSalesBeforeDiscountMinor - left.grossLineSalesBeforeDiscountMinor
    || right.quantity - left.quantity
    || (left.productId || "").localeCompare(right.productId || "")
    || (left.variantId || "").localeCompare(right.variantId || "")
    || left.skuSnapshot.localeCompare(right.skuSnapshot)
    || left.titleSnapshot.localeCompare(right.titleSnapshot);
}

function toCurrencyResult(
  bucket: CurrencyAccumulator,
  localDateLabels: string[],
  version: 1 | 2,
): DashboardCommercialCurrencyV1 | DashboardCommercialCurrencyV2 {
  const completeCost = bucket.knownCostLines === bucket.totalCostLines;
  const currentCogsMinor = completeCost ? bucket.knownCostMinor : null;
  const warnings: string[] = [];
  if (bucket.partialCommercialSnapshot) warnings.push("commercial_snapshot_partial");
  if (!completeCost) warnings.push("historical_cost_evidence_incomplete");
  const dataQualityStatus = warnings.length === 0 ? "complete" : "partial";
  return {
    currencyCode: bucket.currencyCode,
    minorUnitExponent: bucket.minorUnitExponent,
    validOrderCount: bucket.validOrderCount,
    cancelledOrderCohortCount: bucket.cancelledOrderCohortCount,
    activeOrdersWithShippingCount: bucket.activeOrdersWithShippingCount,
    currentOrderGrossValueMinor: bucket.currentOrderGrossValueMinor,
    dailyCurrentOrderGrossValueSeries: localDateLabels.map((localDate) => ({
      localDate,
      currentOrderGrossValueMinor: bucket.dailyCurrentOrderGrossValueMinor.get(localDate) ?? 0,
    })),
    currentMerchandiseGrossValueMinor: bucket.currentMerchandiseGrossValueMinor,
    currentDiscountMinor: bucket.currentDiscountMinor,
    currentMerchandiseRevenueExVatMinor: bucket.currentMerchandiseRevenueExVatMinor,
    currentShippingRevenueExVatMinor: bucket.currentShippingRevenueExVatMinor,
    currentShippingGrossValueMinor: bucket.currentShippingGrossValueMinor,
    currentShippingSharePercent: percentageOneDecimalHalfUp(
      bucket.currentShippingGrossValueMinor,
      bucket.currentOrderGrossValueMinor,
    ),
    ...(version === 2 ? { currentPaymentFeeMinor: bucket.currentPaymentFeeMinor, currentPaymentFeeVatMinor: bucket.currentPaymentFeeVatMinor,
      currentPaymentFeeCustomerTotalMinor: bucket.currentPaymentFeeCustomerTotalMinor, currentPaymentFeeRevenueExVatMinor: bucket.currentPaymentFeeRevenueExVatMinor } : {}),
    currentVatMinor: bucket.currentVatMinor,
    currentUnclassifiedMinor: bucket.currentUnclassifiedMinor,
    effectiveItemQuantity: bucket.effectiveItemQuantity,
    averageCurrentOrderValueMinor: bucket.validOrderCount === 0
      ? null
      : Math.round(bucket.currentOrderGrossValueMinor / bucket.validOrderCount),
    currentCogsMinor,
    currentMerchandiseGrossProfitMinor: currentCogsMinor === null
      ? null
      : bucket.currentMerchandiseRevenueExVatMinor - currentCogsMinor,
    currentContributionBeforeShippingCostMinor: currentCogsMinor === null
      ? null
      : bucket.currentMerchandiseRevenueExVatMinor
        + bucket.currentShippingRevenueExVatMinor
        - currentCogsMinor,
    costCoverage: {
      knownLines: bucket.knownCostLines,
      totalLines: bucket.totalCostLines,
    },
    dataQuality: {
      status: dataQualityStatus,
      costCoverage: {
        knownLines: bucket.knownCostLines,
        totalLines: bucket.totalCostLines,
      },
      warnings,
    },
    topProducts: [...bucket.products.values()]
      .sort(sortTopProducts)
      .slice(0, DASHBOARD_COMMERCIAL_TOP_PRODUCT_LIMIT)
      .map((product) => ({
        productId: product.productId,
        variantId: product.variantId,
        skuSnapshot: product.skuSnapshot,
        titleSnapshot: product.titleSnapshot,
        archivedVariant: product.archivedVariant,
        quantity: product.quantity,
        grossLineSalesBeforeDiscountMinor: product.grossLineSalesBeforeDiscountMinor,
        currentCogsMinor: product.knownLines === product.totalLines
          ? product.knownCostMinor
          : null,
        costCoverage: {
          knownLines: product.knownLines,
          totalLines: product.totalLines,
        },
      })),
  };
}

function readCommercialComponents(row: CommercialRow, version: 1 | 2) {
  const componentVersion = safeInteger(row.component_version ?? 1, "component_version", 1);
  const paymentFeeMinor = safeInteger(row.payment_fee_minor ?? 0, "payment_fee_minor");
  const paymentFeeVatMinor = safeInteger(row.payment_fee_vat_minor ?? 0, "payment_fee_vat_minor");
  if ((componentVersion !== 1 && componentVersion !== 2) || (componentVersion === 1 && (paymentFeeMinor !== 0 || paymentFeeVatMinor !== 0))
    || (componentVersion === 2 && (row.currency_code !== "VND" || safeInteger(row.minor_unit_exponent, "minor_unit_exponent") !== 0))) throw new Error("component_version");
  const base = {
    taxMode: taxMode(row.tax_mode),
    merchandiseGrossMinor: safeInteger(
      row.merchandise_gross_minor,
      "merchandise_gross_minor",
    ),
    discountMinor: safeInteger(row.discount_minor, "discount_minor"),
    merchandiseNetMinor: safeInteger(row.merchandise_net_minor, "merchandise_net_minor"),
    shippingMinor: safeInteger(row.shipping_minor, "shipping_minor"),
    merchandiseVatMinor: safeInteger(
      row.merchandise_vat_minor,
      "merchandise_vat_minor",
    ),
    shippingVatMinor: safeInteger(row.shipping_vat_minor, "shipping_vat_minor"),
    vatMinor: safeInteger(row.vat_minor, "vat_minor"),
    unclassifiedMinor: safeInteger(row.unclassified_minor, "unclassified_minor"),
    totalMinor: safeInteger(row.total_minor, "total_minor"),
  };
  return version === 2 ? OrderCommercialComponentsV2Schema.parse({ ...base, paymentFeeMinor, paymentFeeVatMinor }) : OrderCommercialComponentsV1Schema.parse(base);
}

function aggregateRows(
  rows: CommercialRow[],
  context: NormalizedContext,
  version: 1 | 2,
): DashboardCommercialSliceV1 | DashboardCommercialSliceV2 {
  const dailyActiveOrderCounts = new Map(
    context.localDateLabels.map((localDate) => [localDate, 0]),
  );
  const buckets = new Map<string, CurrencyAccumulator>(
    SUPPORTED_CURRENCY_REGISTRY_V1.map((currency) => [
      currency.currencyCode,
      newCurrencyAccumulator(
        currency.currencyCode,
        currency.minorUnitExponent,
        context.localDateLabels,
      ),
    ]),
  );
  const rowsByOrder = new Map<string, CommercialRow[]>();
  const queryIssues: DashboardCommercialDataQualityIssue[] = [];
  for (const row of rows) {
    const orderId = typeof row.order_id === "string" ? row.order_id : "";
    if (!orderId) {
      queryIssues.push({ reason: "query_contract_violation", fields: ["order_id"] });
      continue;
    }
    const orderRows = rowsByOrder.get(orderId) || [];
    orderRows.push(row);
    rowsByOrder.set(orderId, orderRows);
  }
  if (queryIssues.length > 0) throw new DashboardCommercialDataQualityError(queryIssues);

  const issues: DashboardCommercialDataQualityIssue[] = [];
  for (const [orderId, orderRows] of rowsByOrder) {
    try {
      const first = orderRows[0]!;
      if (first.revision_id == null) {
        issues.push({ orderId, reason: "missing_revision" });
        continue;
      }
      const revisionId = requiredString(first.revision_id, "revision_id");
      const storeId = requiredString(first.store_id, "store_id");
      const orderCreatedAt = isoInstant(first.order_created_at, "order_created_at");
      const storeWindow = context.windows.find((window) => window.storeId === storeId);
      const orderCreatedEpochMs = Date.parse(orderCreatedAt);
      if (
        !storeWindow
        || orderCreatedEpochMs < storeWindow.startEpochMs
        || orderCreatedEpochMs >= storeWindow.endEpochMs
      ) {
        issues.push({
          orderId,
          reason: "query_contract_violation",
          fields: ["store_id", "order_created_at"],
        });
        continue;
      }
      const revision = safeInteger(first.revision, "revision");
      const commercialState = first.commercial_state;
      if (commercialState !== "active" && commercialState !== "cancelled") {
        throw new Error("commercial_state");
      }
      const currencyCode = requiredString(first.currency_code, "currency_code");
      const currency = SUPPORTED_CURRENCY_REGISTRY_V1.find(
        (entry) => entry.currencyCode === currencyCode,
      );
      if (!currency) {
        issues.push({ orderId, reason: "unsupported_currency", fields: [currencyCode] });
        continue;
      }
      const minorUnitExponent = safeInteger(first.minor_unit_exponent, "minor_unit_exponent");
      if (minorUnitExponent !== currency.minorUnitExponent) throw new Error("minor_unit_exponent");
      const quality = first.data_quality;
      if (quality === "unavailable") {
        issues.push({ orderId, reason: "unavailable_revision" });
        continue;
      }
      if (quality !== "complete" && quality !== "partial") throw new Error("data_quality");
      const effectiveAt = isoInstant(first.effective_at, "effective_at");
      const components = readCommercialComponents(first, version);
      const identity = JSON.stringify({
        orderId,
        storeId,
        orderCreatedAt,
        revisionId,
        revision,
        commercialState,
        currencyCode,
        minorUnitExponent,
        quality,
        effectiveAt,
        components, componentVersion: safeInteger(first.component_version ?? 1, "component_version"),
      });

      const lineKeys = new Set<string>();
      const parsedLines: Array<{
        lineKey: string;
        productId: string | null;
        variantId: string | null;
        skuSnapshot: string;
        titleSnapshot: string;
        archivedVariant: boolean;
        quantity: number;
        lineTotalMinor: number;
        unitCostMinor: number | null;
      }> = [];
      let lineGrossMinor = 0;
      for (const row of orderRows) {
        const rowComponents = readCommercialComponents(row, version);
        const rowIdentity = JSON.stringify({
          orderId: requiredString(row.order_id, "order_id"),
          storeId: requiredString(row.store_id, "store_id"),
          orderCreatedAt: isoInstant(row.order_created_at, "order_created_at"),
          revisionId: requiredString(row.revision_id, "revision_id"),
          revision: safeInteger(row.revision, "revision"),
          commercialState: row.commercial_state,
          currencyCode: requiredString(row.currency_code, "currency_code"),
          minorUnitExponent: safeInteger(row.minor_unit_exponent, "minor_unit_exponent"),
          quality: row.data_quality,
          effectiveAt: isoInstant(row.effective_at, "effective_at"),
          components: rowComponents, componentVersion: safeInteger(row.component_version ?? 1, "component_version"),
        });
        if (rowIdentity !== identity) throw new Error("revision_bundle_identity");

        if (row.line_key == null) {
          if (
            row.product_id != null
            || row.variant_id != null
            || row.sku_snapshot != null
            || row.title_snapshot != null
            || row.archived_variant != null
            || row.quantity != null
            || row.unit_price_minor != null
            || row.line_total_minor != null
            || row.cost_minor != null
            || row.cost_evidence_id != null
          ) {
            throw new Error("line_key");
          }
          continue;
        }

        const lineKey = requiredString(row.line_key, "line_key");
        if (lineKeys.has(lineKey)) throw new Error("duplicate_line_key");
        lineKeys.add(lineKey);
        const quantity = safeInteger(row.quantity, "quantity", 1);
        const unitPriceMinor = safeInteger(row.unit_price_minor, "unit_price_minor");
        const lineTotalMinor = safeInteger(row.line_total_minor, "line_total_minor");
        if (safeMultiply(quantity, unitPriceMinor, "line_total_minor") !== lineTotalMinor) {
          throw new Error("line_total_minor");
        }
        lineGrossMinor = safeAdd(lineGrossMinor, lineTotalMinor, "merchandise_gross_minor");
        const hasCost = row.cost_minor != null;
        const hasCostEvidence = row.cost_evidence_id != null;
        if (hasCost !== hasCostEvidence) throw new Error("cost_evidence");
        const unitCostMinor = hasCost ? safeInteger(row.cost_minor, "cost_minor") : null;
        if (hasCostEvidence) requiredString(row.cost_evidence_id, "cost_evidence_id");
        parsedLines.push({
          lineKey,
          productId: nullableString(row.product_id, "product_id"),
          variantId: nullableString(row.variant_id, "variant_id"),
          skuSnapshot: requiredString(row.sku_snapshot, "sku_snapshot"),
          titleSnapshot: requiredString(row.title_snapshot, "title_snapshot"),
          archivedVariant: requiredBoolean(row.archived_variant, "archived_variant"),
          quantity,
          lineTotalMinor,
          unitCostMinor,
        });
      }
      if (lineGrossMinor !== components.merchandiseGrossMinor) {
        throw new Error("merchandise_gross_minor");
      }

      const bucket = buckets.get(currencyCode)!;
      if (quality === "partial") bucket.partialCommercialSnapshot = true;
      if (commercialState === "cancelled") {
        bucket.cancelledOrderCohortCount = safeAdd(
          bucket.cancelledOrderCohortCount,
          1,
          "cancelledOrderCohortCount",
        );
        continue;
      }

      const localDate = owningStoreLocalDate(orderCreatedAt, storeWindow.timeZone);
      const dailyActiveOrderCount = dailyActiveOrderCounts.get(localDate);
      const dailyCurrentOrderGrossValueMinor = bucket.dailyCurrentOrderGrossValueMinor.get(
        localDate,
      );
      if (
        dailyActiveOrderCount === undefined
        || dailyCurrentOrderGrossValueMinor === undefined
      ) {
        throw new Error("order_created_at_local_date");
      }
      dailyActiveOrderCounts.set(
        localDate,
        safeAdd(dailyActiveOrderCount, 1, "dailyActiveOrderCountSeries"),
      );
      bucket.dailyCurrentOrderGrossValueMinor.set(
        localDate,
        safeAdd(
          dailyCurrentOrderGrossValueMinor,
          components.totalMinor,
          "dailyCurrentOrderGrossValueSeries",
        ),
      );
      bucket.validOrderCount = safeAdd(bucket.validOrderCount, 1, "validOrderCount");
      if (version === 2) {
        const { paymentFeeMinor: fee, paymentFeeVatMinor: vat } = OrderCommercialComponentsV2Schema.parse(components);
        bucket.currentPaymentFeeMinor = safeAdd(bucket.currentPaymentFeeMinor, fee, "currentPaymentFeeMinor");
        bucket.currentPaymentFeeVatMinor = safeAdd(bucket.currentPaymentFeeVatMinor, vat, "currentPaymentFeeVatMinor");
        bucket.currentPaymentFeeCustomerTotalMinor = safeAdd(bucket.currentPaymentFeeCustomerTotalMinor, fee + (components.taxMode === "exclusive" ? vat : 0), "currentPaymentFeeCustomerTotalMinor");
        bucket.currentPaymentFeeRevenueExVatMinor = safeAdd(bucket.currentPaymentFeeRevenueExVatMinor, fee - (components.taxMode === "inclusive" ? vat : 0), "currentPaymentFeeRevenueExVatMinor");
      }
      bucket.currentOrderGrossValueMinor = safeAdd(
        bucket.currentOrderGrossValueMinor,
        components.totalMinor,
        "currentOrderGrossValueMinor",
      );
      bucket.currentMerchandiseGrossValueMinor = safeAdd(
        bucket.currentMerchandiseGrossValueMinor,
        components.merchandiseGrossMinor,
        "currentMerchandiseGrossValueMinor",
      );
      bucket.currentDiscountMinor = safeAdd(
        bucket.currentDiscountMinor,
        components.discountMinor,
        "currentDiscountMinor",
      );
      bucket.currentMerchandiseRevenueExVatMinor = safeAdd(
        bucket.currentMerchandiseRevenueExVatMinor,
        merchandiseRevenueExVatMinor(components),
        "currentMerchandiseRevenueExVatMinor",
      );
      bucket.currentShippingRevenueExVatMinor = safeAdd(
        bucket.currentShippingRevenueExVatMinor,
        shippingRevenueExVatMinor(components),
        "currentShippingRevenueExVatMinor",
      );
      const currentShippingGrossMinor = safeAdd(
        components.shippingMinor,
        components.taxMode === "exclusive" ? components.shippingVatMinor : 0,
        "currentShippingGrossMinor",
      );
      bucket.currentShippingGrossValueMinor = safeAdd(
        bucket.currentShippingGrossValueMinor,
        currentShippingGrossMinor,
        "currentShippingGrossValueMinor",
      );
      if (currentShippingGrossMinor > 0) {
        bucket.activeOrdersWithShippingCount = safeAdd(
          bucket.activeOrdersWithShippingCount,
          1,
          "activeOrdersWithShippingCount",
        );
      }
      bucket.currentVatMinor = safeAdd(
        bucket.currentVatMinor,
        components.vatMinor,
        "currentVatMinor",
      );
      bucket.currentUnclassifiedMinor = safeAdd(
        bucket.currentUnclassifiedMinor,
        components.unclassifiedMinor,
        "currentUnclassifiedMinor",
      );

      for (const line of parsedLines) {
        bucket.effectiveItemQuantity = safeAdd(
          bucket.effectiveItemQuantity,
          line.quantity,
          "effectiveItemQuantity",
        );
        bucket.totalCostLines = safeAdd(bucket.totalCostLines, 1, "costCoverage.totalLines");
        let lineCostMinor: number | null = null;
        if (line.unitCostMinor !== null) {
          lineCostMinor = safeMultiply(line.quantity, line.unitCostMinor, "currentCogsMinor");
          bucket.knownCostLines = safeAdd(
            bucket.knownCostLines,
            1,
            "costCoverage.knownLines",
          );
          bucket.knownCostMinor = safeAdd(
            bucket.knownCostMinor,
            lineCostMinor,
            "currentCogsMinor",
          );
        }
        const key = productIdentity({ orderId, ...line });
        const product = bucket.products.get(key) || {
          productId: line.productId,
          variantId: line.variantId,
          skuSnapshot: line.skuSnapshot,
          titleSnapshot: line.titleSnapshot,
          archivedVariant: line.archivedVariant,
          quantity: 0,
          grossLineSalesBeforeDiscountMinor: 0,
          knownCostMinor: 0,
          knownLines: 0,
          totalLines: 0,
          labelOrderCreatedAt: orderCreatedAt,
          labelOrderId: orderId,
          labelLineKey: line.lineKey,
        };
        if (isNewerProductLabel(product, { orderCreatedAt, orderId, lineKey: line.lineKey })) {
          product.productId = line.productId;
          product.variantId = line.variantId;
          product.skuSnapshot = line.skuSnapshot;
          product.titleSnapshot = line.titleSnapshot;
          product.archivedVariant = line.archivedVariant;
          product.labelOrderCreatedAt = orderCreatedAt;
          product.labelOrderId = orderId;
          product.labelLineKey = line.lineKey;
        }
        product.quantity = safeAdd(product.quantity, line.quantity, "topProduct.quantity");
        product.grossLineSalesBeforeDiscountMinor = safeAdd(
          product.grossLineSalesBeforeDiscountMinor,
          line.lineTotalMinor,
          "topProduct.grossLineSalesBeforeDiscountMinor",
        );
        product.totalLines = safeAdd(product.totalLines, 1, "topProduct.costCoverage.totalLines");
        if (lineCostMinor !== null) {
          product.knownLines = safeAdd(
            product.knownLines,
            1,
            "topProduct.costCoverage.knownLines",
          );
          product.knownCostMinor = safeAdd(
            product.knownCostMinor,
            lineCostMinor,
            "topProduct.currentCogsMinor",
          );
        }
        bucket.products.set(key, product);
      }
    } catch (error) {
      issues.push({
        orderId,
        reason: "invalid_projection",
        fields: issueFields(error),
      });
    }
  }
  if (issues.length > 0) throw new DashboardCommercialDataQualityError(issues);

  const payload = {
    schemaVersion: version,
    dailyActiveOrderCountSeries: context.localDateLabels.map((localDate) => ({
      localDate,
      activeOrderCount: dailyActiveOrderCounts.get(localDate) ?? 0,
    })),
    currencies: [...buckets.values()]
      .sort((left, right) => left.currencyCode.localeCompare(right.currencyCode))
      .map((bucket) => toCurrencyResult(bucket, context.localDateLabels, version)),
  };
  const parsed = version === 2 ? DashboardCommercialSliceV2Schema.safeParse(payload) : DashboardCommercialSliceV1Schema.safeParse(payload);
  if (!parsed.success) {
    throw new DashboardCommercialDataQualityError([{
      reason: "invalid_projection",
      fields: parsed.error.issues.map((entry) => entry.path.join(".") || "commercialSlice"),
    }]);
  }
  return parsed.data;
}

async function readCommercialSlice(
  client: Pick<PoolClient, "query">,
  context: DashboardSnapshotReadContext,
  creatorSelectionInput: CreatorSelectionV1 | undefined,
  version: 1 | 2,
): Promise<DashboardCommercialSliceV1 | DashboardCommercialSliceV2> {
  const normalized = normalizeContext(context);
  const creatorSelection = CreatorSelectionV1Schema.parse(
    creatorSelectionInput || { mode: "all", creatorOperatorIds: [] },
  );
  const result = await client.query<CommercialRow>(DASHBOARD_COMMERCIAL_SQL, [
    normalized.merchantId,
    normalized.storeIds,
    normalized.startInclusive,
    normalized.endExclusive,
    normalized.reportAsOf,
    creatorSelection.mode,
    creatorSelection.creatorOperatorIds,
  ]);
  if (version === 1 && result.rows.some(row => Number(row.payment_fee_minor ?? 0) !== 0 || Number(row.payment_fee_vat_minor ?? 0) !== 0)) {
    throw new PlatformError("unsupported_contract", "Update the client to read a dashboard with payment surcharges", 409);
  }
  return aggregateRows(result.rows, normalized, version);
}

export async function readDashboardCommercialSnapshotV1(
  client: PoolClient,
  request: DashboardSnapshotRequest,
): Promise<DashboardSnapshotResult<DashboardCommercialSliceV1>> {
  return withDashboardReadSnapshot(client, request, (snapshotClient, context) =>
    readDashboardCommercialSliceV1(snapshotClient, context));
}

export async function readDashboardCommercialSliceV1(client: Pick<PoolClient, "query">, context: DashboardSnapshotReadContext, creators?: CreatorSelectionV1): Promise<DashboardCommercialSliceV1> {
  return DashboardCommercialSliceV1Schema.parse(await readCommercialSlice(client, context, creators, 1));
}
export async function readDashboardCommercialSliceV2(client: Pick<PoolClient, "query">, context: DashboardSnapshotReadContext, creators?: CreatorSelectionV1): Promise<DashboardCommercialSliceV2> {
  return DashboardCommercialSliceV2Schema.parse(await readCommercialSlice(client, context, creators, 2));
}
