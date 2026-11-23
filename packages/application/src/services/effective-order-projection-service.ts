import {
  EffectiveOrderCsvPaymentFeeV5Schema,
  type EffectiveOrderCsvPaymentFeeV5,
  EffectiveOrderV1Schema,
  EffectiveOrderV2Schema,
  ReportScopeSchema,
  SUPPORTED_CURRENCY_REGISTRY_V1,
  type EffectiveOrderV1,
  type EffectiveOrderV2,
  type ReportScope,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { resolvePaymentFee } from "./payment-fee-calculation";

export const EFFECTIVE_ORDER_PROJECTION_MAX_BATCH = 200;

export interface EffectiveOrderProjectionBatchRequest {
  scope: ReportScope;
  orderIds: readonly string[];
  currencyCode: string;
  asOf: string;
}

export interface EffectiveOrderProjectionScalarRequest {
  scope: ReportScope;
  orderId: string;
  currencyCode: string;
  asOf: string;
}

export type EffectiveOrderProjectionIssueReason =
  | "missing_revision"
  | "missing_components"
  | "invalid_projection"
  | "query_contract_violation";

export interface EffectiveOrderProjectionIssue {
  orderId: string;
  reason: EffectiveOrderProjectionIssueReason;
  fields?: string[];
}

export class EffectiveOrderProjectionError extends PlatformError {
  constructor(issues: EffectiveOrderProjectionIssue[]) {
    super(
      "effective_order_data_quality",
      "Effective order projection is unavailable for one or more orders",
      422,
      { issues },
    );
    this.name = "EffectiveOrderProjectionError";
  }
}

interface NormalizedProjectionRequest {
  merchantId: string;
  storeIds: string[];
  orderIds: string[];
  currencyCode: string;
  minorUnitExponent: number;
  asOf: string;
}

interface ProjectionRow {
  component_version?: unknown;
  payment_fee_minor?: unknown;
  payment_fee_vat_minor?: unknown;
  requested_order_id: unknown;
  request_ordinal: unknown;
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
}

const COMPONENT_FIELDS = [
  "tax_mode",
  "merchandise_gross_minor",
  "discount_minor",
  "merchandise_net_minor",
  "shipping_minor",
  "merchandise_vat_minor",
  "shipping_vat_minor",
  "vat_minor",
  "unclassified_minor",
  "total_minor",
] as const;

const EFFECTIVE_ORDER_PROJECTION_SQL = `
  WITH requested AS (
    SELECT input.order_id, input.ordinal
    FROM unnest($4::text[]) WITH ORDINALITY AS input(order_id, ordinal)
  ), latest AS (
    SELECT DISTINCT ON (requested.ordinal)
      requested.order_id AS requested_order_id,
      requested.ordinal AS request_ordinal,
      revisions.id AS revision_id,
      revisions.revision,
      revisions.commercial_state,
      revisions.currency_code,
      revisions.minor_unit_exponent,
      revisions.data_quality,
      revisions.effective_at
    FROM requested
    LEFT JOIN app.order_commercial_revisions revisions
      ON revisions.merchant_id = $1
      AND revisions.store_id = ANY($2::text[])
      AND revisions.order_id = requested.order_id
      AND revisions.currency_code = $3
      AND revisions.effective_at <= $5::timestamptz
    ORDER BY
      requested.ordinal,
      revisions.revision DESC NULLS LAST,
      revisions.effective_at DESC NULLS LAST,
      revisions.id DESC NULLS LAST
  )
  SELECT
    latest.requested_order_id,
    latest.request_ordinal,
    latest.revision_id,
    latest.revision,
    latest.commercial_state,
    latest.currency_code,
    latest.minor_unit_exponent,
    latest.data_quality,
    latest.effective_at,
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
    COALESCE((to_jsonb(components)->>'component_version')::smallint, 1) AS component_version,
    COALESCE((to_jsonb(components)->>'payment_fee_minor')::bigint, 0) AS payment_fee_minor,
    COALESCE((to_jsonb(components)->>'payment_fee_vat_minor')::bigint, 0) AS payment_fee_vat_minor,
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
  ORDER BY latest.request_ordinal, lines.line_key, lines.id
`;

function validationError(message: string): PlatformError {
  return new PlatformError("validation_error", message, 422);
}

function normalizedId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw validationError(`${label} must be a non-empty identifier without surrounding whitespace`);
  }
  return value;
}

function normalizeRequest(input: EffectiveOrderProjectionBatchRequest): NormalizedProjectionRequest {
  const scope = ReportScopeSchema.safeParse(input.scope);
  if (!scope.success) throw validationError("A valid report scope is required");

  const merchantId = normalizedId(scope.data.merchantId, "scope.merchantId");
  const storeIds = scope.data.storeIds.map((storeId, index) =>
    normalizedId(storeId, `scope.storeIds[${index}]`));
  if (new Set(storeIds).size !== storeIds.length) {
    throw validationError("Report scope store IDs must be unique");
  }

  if (!Array.isArray(input.orderIds) || input.orderIds.length === 0) {
    throw validationError("At least one order ID is required");
  }
  if (input.orderIds.length > EFFECTIVE_ORDER_PROJECTION_MAX_BATCH) {
    throw validationError(
      `Effective-order batches are limited to ${EFFECTIVE_ORDER_PROJECTION_MAX_BATCH} orders`,
    );
  }
  const orderIds = input.orderIds.map((orderId, index) =>
    normalizedId(orderId, `orderIds[${index}]`));
  if (new Set(orderIds).size !== orderIds.length) {
    throw validationError("Effective-order batch order IDs must be unique");
  }

  const currency = SUPPORTED_CURRENCY_REGISTRY_V1.find(
    (entry) => entry.currencyCode === input.currencyCode,
  );
  if (!currency) throw validationError("Unsupported effective-order currency");

  if (
    typeof input.asOf !== "string"
    || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.asOf)
    || !Number.isFinite(Date.parse(input.asOf))
  ) {
    throw validationError("asOf must be an ISO-8601 timestamp with an explicit timezone");
  }

  return {
    merchantId,
    storeIds: [...storeIds].sort(),
    orderIds,
    currencyCode: currency.currencyCode,
    minorUnitExponent: currency.minorUnitExponent,
    asOf: new Date(input.asOf).toISOString(),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(field);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value == null) return null;
  return requiredString(value, field);
}

function safeInteger(value: unknown, field: string, minimum = 0): number {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "bigint") {
    parsed = Number(value);
  } else if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    parsed = Number(value);
  } else {
    throw new Error(field);
  }
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(field);
  return parsed;
}

function safeAdd(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error(field);
  return result;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(field);
  return value;
}

function dataQualityStatus(value: unknown): "complete" | "partial" | "unavailable" {
  if (value === "complete" || value === "partial" || value === "unavailable") return value;
  throw new Error("data_quality");
}

function taxMode(value: unknown): "inclusive" | "exclusive" {
  if (value === "inclusive" || value === "exclusive") return value;
  throw new Error("tax_mode");
}

function projectionFields(error: unknown): string[] | undefined {
  if (!(error instanceof Error) || !error.message) return undefined;
  return [error.message];
}

function buildProjection(
  request: NormalizedProjectionRequest,
  orderId: string,
  rows: ProjectionRow[],
): EffectiveOrderV1 {
  if (rows.length === 0 || rows.every((row) => row.revision_id == null)) {
    throw new EffectiveOrderProjectionError([{ orderId, reason: "missing_revision" }]);
  }
  if (rows.some((row) => row.revision_id == null)) {
    throw new EffectiveOrderProjectionError([{ orderId, reason: "invalid_projection" }]);
  }
  if (rows.some((row) => COMPONENT_FIELDS.some((field) => row[field] == null))) {
    throw new EffectiveOrderProjectionError([{ orderId, reason: "missing_components" }]);
  }

  try {
    const first = rows[0]!;
    const revisionId = requiredString(first.revision_id, "revision_id");
    const effectiveRevision = safeInteger(first.revision, "revision");
    const commercialState = first.commercial_state;
    if (commercialState !== "active" && commercialState !== "cancelled") {
      throw new Error("commercial_state");
    }
    const currencyCode = requiredString(first.currency_code, "currency_code");
    const minorUnitExponent = safeInteger(first.minor_unit_exponent, "minor_unit_exponent");
    const qualityStatus = dataQualityStatus(first.data_quality);
    if (
      currencyCode !== request.currencyCode
      || minorUnitExponent !== request.minorUnitExponent
    ) {
      throw new Error("currency_code");
    }

    const components = {
      taxMode: taxMode(first.tax_mode),
      merchandiseGrossMinor: safeInteger(
        first.merchandise_gross_minor,
        "merchandise_gross_minor",
      ),
      discountMinor: safeInteger(first.discount_minor, "discount_minor"),
      merchandiseNetMinor: safeInteger(first.merchandise_net_minor, "merchandise_net_minor"),
      shippingMinor: safeInteger(first.shipping_minor, "shipping_minor"),
      merchandiseVatMinor: safeInteger(
        first.merchandise_vat_minor,
        "merchandise_vat_minor",
      ),
      shippingVatMinor: safeInteger(first.shipping_vat_minor, "shipping_vat_minor"),
      vatMinor: safeInteger(first.vat_minor, "vat_minor"),
      unclassifiedMinor: safeInteger(first.unclassified_minor, "unclassified_minor"),
      totalMinor: safeInteger(first.total_minor, "total_minor"),
    };
    const bundleIdentity = JSON.stringify({
      revisionId,
      effectiveRevision,
      commercialState,
      currencyCode,
      minorUnitExponent,
      qualityStatus,
      components,
    });

    const lines: EffectiveOrderV1["lines"] = [];
    const lineKeys = new Set<string>();
    let knownCostLines = 0;
    let lineTotal = 0;

    for (const row of rows) {
      const rowIdentity = JSON.stringify({
        revisionId: requiredString(row.revision_id, "revision_id"),
        effectiveRevision: safeInteger(row.revision, "revision"),
        commercialState: row.commercial_state,
        currencyCode: requiredString(row.currency_code, "currency_code"),
        minorUnitExponent: safeInteger(row.minor_unit_exponent, "minor_unit_exponent"),
        qualityStatus: dataQualityStatus(row.data_quality),
        components: {
          taxMode: taxMode(row.tax_mode),
          merchandiseGrossMinor: safeInteger(
            row.merchandise_gross_minor,
            "merchandise_gross_minor",
          ),
          discountMinor: safeInteger(row.discount_minor, "discount_minor"),
          merchandiseNetMinor: safeInteger(
            row.merchandise_net_minor,
            "merchandise_net_minor",
          ),
          shippingMinor: safeInteger(row.shipping_minor, "shipping_minor"),
          merchandiseVatMinor: safeInteger(
            row.merchandise_vat_minor,
            "merchandise_vat_minor",
          ),
          shippingVatMinor: safeInteger(row.shipping_vat_minor, "shipping_vat_minor"),
          vatMinor: safeInteger(row.vat_minor, "vat_minor"),
          unclassifiedMinor: safeInteger(row.unclassified_minor, "unclassified_minor"),
          totalMinor: safeInteger(row.total_minor, "total_minor"),
        },
      });
      if (rowIdentity !== bundleIdentity) throw new Error("revision_bundle_identity");

      if (row.line_key == null) {
        if (
          row.product_id != null
          || row.variant_id != null
          || row.sku_snapshot != null
          || row.title_snapshot != null
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

      const lineId = requiredString(row.line_key, "line_key");
      if (lineKeys.has(lineId)) throw new Error("duplicate_line_key");
      lineKeys.add(lineId);
      const quantity = safeInteger(row.quantity, "quantity", 1);
      const unitPriceMinor = safeInteger(row.unit_price_minor, "unit_price_minor");
      const persistedLineTotal = safeInteger(row.line_total_minor, "line_total_minor");
      const calculatedLineTotal = quantity * unitPriceMinor;
      if (!Number.isSafeInteger(calculatedLineTotal) || calculatedLineTotal !== persistedLineTotal) {
        throw new Error("line_total_minor");
      }
      lineTotal = safeAdd(lineTotal, persistedLineTotal, "merchandise_gross_minor");

      const hasCost = row.cost_minor != null;
      const hasCostEvidence = row.cost_evidence_id != null;
      if (hasCost !== hasCostEvidence) throw new Error("cost_evidence");
      if (hasCost) {
        safeInteger(row.cost_minor, "cost_minor");
        requiredString(row.cost_evidence_id, "cost_evidence_id");
        knownCostLines += 1;
      }

      lines.push({
        lineId,
        productId: nullableString(row.product_id, "product_id"),
        variantId: nullableString(row.variant_id, "variant_id"),
        skuSnapshot: requiredString(row.sku_snapshot, "sku_snapshot"),
        titleSnapshot: requiredString(row.title_snapshot, "title_snapshot"),
        quantity,
        unitPriceMinor,
        archivedVariant: requiredBoolean(row.archived_variant, "archived_variant"),
      });
    }

    if (lineTotal !== components.merchandiseGrossMinor) {
      throw new Error("merchandise_gross_minor");
    }

    const warnings: string[] = [];
    if (qualityStatus === "partial") warnings.push("commercial_snapshot_partial");
    if (qualityStatus === "unavailable") warnings.push("commercial_snapshot_unavailable");
    if (knownCostLines !== lines.length) warnings.push("historical_cost_evidence_incomplete");

    const parsed = EffectiveOrderV1Schema.safeParse({
      schemaVersion: 1,
      orderId,
      currencyCode,
      minorUnitExponent,
      effectiveRevision,
      commercialState,
      lines,
      components,
      currentOrderGrossValueMinor: commercialState === "cancelled" ? 0 : components.totalMinor,
      dataQuality: {
        status: qualityStatus,
        costCoverage: { knownLines: knownCostLines, totalLines: lines.length },
        warnings,
      },
    });
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "projection");
      throw new Error([...new Set(fields)].join(","));
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof EffectiveOrderProjectionError) throw error;
    throw new EffectiveOrderProjectionError([{
      orderId,
      reason: "invalid_projection",
      fields: projectionFields(error),
    }]);
  }
}

function buildFeeAwareProjection(
  request: NormalizedProjectionRequest,
  orderId: string,
  rows: ProjectionRow[],
): EffectiveOrderV2 {
  if (rows.length === 0 || rows.some((row) => row.revision_id == null)) {
    buildProjection(request, orderId, rows);
  }
  try {
    const first = rows[0]!;
    const componentVersion = safeInteger(first.component_version, "component_version", 1);
    const paymentFeeMinor = safeInteger(first.payment_fee_minor, "payment_fee_minor");
    const paymentFeeVatMinor = safeInteger(first.payment_fee_vat_minor, "payment_fee_vat_minor");
    const normalizedRows = rows.map((row) => {
      if (safeInteger(row.component_version, "component_version", 1) !== componentVersion
        || safeInteger(row.payment_fee_minor, "payment_fee_minor") !== paymentFeeMinor
        || safeInteger(row.payment_fee_vat_minor, "payment_fee_vat_minor") !== paymentFeeVatMinor) {
        throw new Error("revision_bundle_identity");
      }
      const feeTotal = BigInt(paymentFeeMinor) + (taxMode(row.tax_mode) === "exclusive" ? BigInt(paymentFeeVatMinor) : 0n);
      return { ...row,
        vat_minor: safeInteger(row.vat_minor, "vat_minor") - paymentFeeVatMinor,
        total_minor: Number(BigInt(safeInteger(row.total_minor, "total_minor")) - feeTotal),
      };
    });
    // Reuse the V1 line/quality checks on a validation-only fee-free view; stored rows stay unchanged.
    const legacy = buildProjection(request, orderId, normalizedRows);
    return EffectiveOrderV2Schema.parse({
      ...legacy, schemaVersion: 2, componentVersion,
      components: { ...legacy.components, paymentFeeMinor, paymentFeeVatMinor,
        vatMinor: safeInteger(first.vat_minor, "vat_minor"), totalMinor: safeInteger(first.total_minor, "total_minor") },
      currentOrderGrossValueMinor: legacy.commercialState === "cancelled" ? 0 : safeInteger(first.total_minor, "total_minor"),
    });
  } catch (error) {
    if (error instanceof EffectiveOrderProjectionError) throw error;
    throw new EffectiveOrderProjectionError([{ orderId, reason: "invalid_projection", fields: projectionFields(error) }]);
  }
}

async function readEffectiveOrders(client: PoolClient, input: EffectiveOrderProjectionBatchRequest, version: 1): Promise<EffectiveOrderV1[]>;
async function readEffectiveOrders(client: PoolClient, input: EffectiveOrderProjectionBatchRequest, version: 2): Promise<EffectiveOrderV2[]>;
async function readEffectiveOrders(
  client: PoolClient,
  input: EffectiveOrderProjectionBatchRequest,
  version: 1 | 2,
): Promise<Array<EffectiveOrderV1 | EffectiveOrderV2>> {
  const request = normalizeRequest(input);
  const result = await client.query<ProjectionRow>(EFFECTIVE_ORDER_PROJECTION_SQL, [
    request.merchantId,
    request.storeIds,
    request.currencyCode,
    request.orderIds,
    request.asOf,
  ]);

  const rowsByOrder = new Map(request.orderIds.map((orderId) => [orderId, [] as ProjectionRow[]]));
  const queryIssues: EffectiveOrderProjectionIssue[] = [];
  for (const row of result.rows) {
    const orderId = typeof row.requested_order_id === "string" ? row.requested_order_id : "";
    const rows = rowsByOrder.get(orderId);
    if (!rows) {
      queryIssues.push({ orderId: orderId || "unknown", reason: "query_contract_violation" });
      continue;
    }
    rows.push(row);
  }
  if (queryIssues.length > 0) throw new EffectiveOrderProjectionError(queryIssues);

  if (version === 1 && result.rows.some((row) =>
    Number(row.payment_fee_minor ?? 0) !== 0 || Number(row.payment_fee_vat_minor ?? 0) !== 0)) {
    throw new PlatformError("unsupported_contract", "Update the client to read orders with payment surcharges", 409);
  }
  const projections: Array<EffectiveOrderV1 | EffectiveOrderV2> = [];
  const issues: EffectiveOrderProjectionIssue[] = [];
  for (const orderId of request.orderIds) {
    try {
      projections.push(version === 1
        ? buildProjection(request, orderId, rowsByOrder.get(orderId)!)
        : buildFeeAwareProjection(request, orderId, rowsByOrder.get(orderId)!));
    } catch (error) {
      if (!(error instanceof EffectiveOrderProjectionError)) throw error;
      const errorIssues = error.details?.issues;
      if (Array.isArray(errorIssues)) {
        issues.push(...errorIssues as EffectiveOrderProjectionIssue[]);
      } else {
        issues.push({ orderId, reason: "invalid_projection" });
      }
    }
  }
  if (issues.length > 0) throw new EffectiveOrderProjectionError(issues);
  return projections;
}

export function readEffectiveOrdersV1(client: PoolClient, input: EffectiveOrderProjectionBatchRequest): Promise<EffectiveOrderV1[]> {
  return readEffectiveOrders(client, input, 1);
}

export function readEffectiveOrdersV2(client: PoolClient, input: EffectiveOrderProjectionBatchRequest): Promise<EffectiveOrderV2[]> {
  return readEffectiveOrders(client, input, 2);
}

export async function readEffectiveOrderV2(client: PoolClient, input: EffectiveOrderProjectionScalarRequest): Promise<EffectiveOrderV2> {
  const [projection] = await readEffectiveOrdersV2(client, { ...input, orderIds: [input.orderId] });
  if (!projection) throw new EffectiveOrderProjectionError([{ orderId: input.orderId, reason: "query_contract_violation" }]);
  return projection;
}

export async function readEffectiveOrderV1(
  client: PoolClient,
  input: EffectiveOrderProjectionScalarRequest,
): Promise<EffectiveOrderV1> {
  const [projection] = await readEffectiveOrdersV1(client, {
    scope: input.scope,
    orderIds: [input.orderId],
    currencyCode: input.currencyCode,
    asOf: input.asOf,
  });
  if (!projection) {
    throw new EffectiveOrderProjectionError([{
      orderId: input.orderId,
      reason: "query_contract_violation",
    }]);
  }
  return projection;
}


export interface EffectiveOrderCsvProjectionV5 {
  effectiveOrder: EffectiveOrderV2;
  paymentFee: EffectiveOrderCsvPaymentFeeV5 | null;
}

export async function readEffectiveOrderCsvProjectionsV5(client: PoolClient, input: EffectiveOrderProjectionBatchRequest): Promise<EffectiveOrderCsvProjectionV5[]> {
  const request = normalizeRequest(input);
  const projections = await readEffectiveOrdersV2(client, input);
  const result = await client.query<{ order_id: string; revision: number; metadata: Record<string, unknown> }>(`
    /* effective_order_csv_fee_descriptors_v5 */
    SELECT DISTINCT ON (order_id) order_id, revision, metadata
    FROM app.order_commercial_revisions
    WHERE merchant_id = $1 AND store_id = ANY($2::text[]) AND currency_code = $3
      AND order_id = ANY($4::text[]) AND effective_at <= $5::timestamptz
    ORDER BY order_id, revision DESC, effective_at DESC, id DESC
  `, [request.merchantId, request.storeIds, request.currencyCode, request.orderIds, request.asOf]);
  const byId = new Map(result.rows.map(row => [row.order_id, row]));
  if (byId.size !== projections.length || result.rows.length !== byId.size) {
    throw new EffectiveOrderProjectionError(request.orderIds.map(orderId => ({ orderId, reason: "query_contract_violation" })));
  }
  return projections.map(effectiveOrder => {
    const row = byId.get(effectiveOrder.orderId);
    if (!row || safeInteger(row.revision, "revision") !== effectiveOrder.effectiveRevision) {
      throw new EffectiveOrderProjectionError([{ orderId: effectiveOrder.orderId, reason: "query_contract_violation" }]);
    }
    if (effectiveOrder.componentVersion === 1) return { effectiveOrder, paymentFee: null };
    const metadata = row.metadata;
    const descriptor = metadata?.paymentFee;
    const parsed = EffectiveOrderCsvPaymentFeeV5Schema.safeParse({
      ...(descriptor && typeof descriptor === "object" && !Array.isArray(descriptor) ? descriptor : {}),
      vatRatePpm: metadata?.vatRatePpm,
    });
    if (metadata?.bundleVersion !== 2 || !parsed.success) {
      throw new EffectiveOrderProjectionError([{ orderId: effectiveOrder.orderId, reason: "invalid_projection", fields: ["paymentFee"] }]);
    }
    const fee = resolvePaymentFee(effectiveOrder.components.merchandiseNetMinor, {
      paymentFeeType: parsed.data.paymentFeeType, paymentFeeValue: parsed.data.paymentFeeValue,
    }, { taxMode: effectiveOrder.components.taxMode, vatRatePpm: parsed.data.vatRatePpm });
    if (fee.paymentFeeBasisMinor !== parsed.data.paymentFeeBasisMinor || fee.paymentFeeMinor !== effectiveOrder.components.paymentFeeMinor
      || fee.paymentFeeVatMinor !== effectiveOrder.components.paymentFeeVatMinor) {
      throw new EffectiveOrderProjectionError([{ orderId: effectiveOrder.orderId, reason: "invalid_projection", fields: ["paymentFee"] }]);
    }
    return { effectiveOrder, paymentFee: parsed.data };
  });
}
