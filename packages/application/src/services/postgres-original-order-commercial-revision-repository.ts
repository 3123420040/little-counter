import type { PoolClient } from "../db/client";
import {
  OriginalOrderCommercialRevisionValidationErrorV1,
  assertNormalizedOriginalOrderCommercialRevisionV1,
  assertNormalizedOriginalOrderCommercialRevisionV2,
  type NormalizedOriginalOrderCommercialRevisionV1,
  type NormalizedOriginalOrderCommercialRevisionV2,
  type OriginalOrderCommercialRevisionRepositoryV1,
  type OriginalOrderCommercialRevisionRepositoryV2,
  type PersistedOriginalOrderCommercialRevisionV1,
} from "./original-order-commercial-revision-service";

type OriginalRevisionBundle = NormalizedOriginalOrderCommercialRevisionV1 | NormalizedOriginalOrderCommercialRevisionV2;

export const ORIGINAL_REVISION_STATEMENT_TIMEOUT_HARD_CAP_MS = 30_000;
export const ORIGINAL_REVISION_LOCK_TIMEOUT_HARD_CAP_MS = 5_000;

export interface PostgresOriginalOrderCommercialRevisionOptionsV1 {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  transactionOwnership?: "repository" | "caller";
}

type ExistingRow = {
  revision_record: unknown;
  component_record: unknown;
  line_records: unknown;
};

function integrity(message: string): OriginalOrderCommercialRevisionValidationErrorV1 {
  return new OriginalOrderCommercialRevisionValidationErrorV1(
    `persisted original revision ${message}`,
  );
}

function boundedTimeout(value: number, field: string, cap: number): number {
  if (!Number.isInteger(value) || value < 1 || value > cap) {
    throw new Error(`${field} must be between 1 and ${cap}`);
  }
  return value;
}

function parsedJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw integrity(`${field} is invalid`);
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  const parsed = parsedJson(value, field);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw integrity(`${field} is invalid`);
  }
  return parsed as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  const parsed = parsedJson(value, field);
  if (!Array.isArray(parsed)) throw integrity(`${field} is invalid`);
  return parsed;
}

function safeInteger(value: unknown, field: string): number {
  const text = typeof value === "bigint"
    ? value.toString()
    : typeof value === "number" || typeof value === "string"
      ? String(value)
      : "";
  if (!/^(0|[1-9]\d*)$/.test(text)) throw integrity(`${field} is invalid`);
  const result = Number(text);
  if (!Number.isSafeInteger(result)) throw integrity(`${field} is invalid`);
  return result;
}

function canonicalInstant(value: unknown, field: string): string {
  const parsed = value instanceof Date
    ? value
    : new Date(typeof value === "string" ? value : Number.NaN);
  if (!Number.isFinite(parsed.getTime())) throw integrity(`${field} is invalid`);
  return parsed.toISOString();
}

function assertEquivalent(actual: unknown, expected: unknown, field: string): void {
  if (typeof expected === "number") {
    if (safeInteger(actual, field) !== expected) throw integrity(`${field} drift`);
    return;
  }
  if (typeof expected === "string" && field.endsWith("effective_at")) {
    if (canonicalInstant(actual, field) !== expected) throw integrity(`${field} drift`);
    return;
  }
  if (Array.isArray(expected)) {
    const actualArray = array(actual, field);
    if (actualArray.length !== expected.length) throw integrity(`${field} count drift`);
    expected.forEach((item, index) => {
      assertEquivalent(actualArray[index], item, `${field}[${index}]`);
    });
    return;
  }
  if (expected && typeof expected === "object") {
    const actualRecord = record(actual, field);
    const expectedRecord = expected as Record<string, unknown>;
    if (
      JSON.stringify(Object.keys(actualRecord).sort())
      !== JSON.stringify(Object.keys(expectedRecord).sort())
    ) {
      throw integrity(`${field} shape drift`);
    }
    for (const key of Object.keys(expectedRecord)) {
      assertEquivalent(actualRecord[key], expectedRecord[key], `${field}.${key}`);
    }
    return;
  }
  if (actual !== expected) throw integrity(`${field} drift`);
}

function revisionMetadata(bundle: OriginalRevisionBundle) {
  return {
    bundleVersion: bundle.bundleVersion,
    bundleFingerprint: bundle.bundleFingerprint,
    componentContract: bundle.bundleVersion === 1 ? "order-commercial-components.v1-tax-attributed" : "order-commercial-components.v2-payment-fee",
    vatRatePpm: bundle.vatRatePpm,
    commercialCalculationVersion: bundle.commercialCalculationVersion,
    roundingPolicy: bundle.roundingPolicy,
    ...(bundle.bundleVersion === 2 ? { paymentFee: bundle.paymentFee } : {}),
  };
}

function expectedReplay(
  bundle: OriginalRevisionBundle,
  revisionId: string,
) {
  return {
    revision: {
      id: revisionId,
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      order_id: bundle.orderId,
      revision: bundle.revision,
      source_type: bundle.sourceType,
      source_id: bundle.sourceId,
      source_correction_id: null,
      commercial_state: bundle.commercialState,
      currency_code: bundle.currencyCode,
      minor_unit_exponent: bundle.minorUnitExponent,
      effective_at: bundle.sourceOccurredAt,
      idempotency_key: bundle.idempotencyKey,
      data_quality: bundle.dataQuality,
      metadata: revisionMetadata(bundle),
    },
    component: {
      revision_id: revisionId,
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      order_id: bundle.orderId,
      revision: bundle.revision,
      currency_code: bundle.currencyCode,
      minor_unit_exponent: bundle.minorUnitExponent,
      tax_mode: bundle.components.taxMode,
      merchandise_gross_minor: bundle.components.merchandiseGrossMinor,
      discount_minor: bundle.components.discountMinor,
      merchandise_net_minor: bundle.components.merchandiseNetMinor,
      shipping_minor: bundle.components.shippingMinor,
      merchandise_vat_minor: bundle.components.merchandiseVatMinor,
      shipping_vat_minor: bundle.components.shippingVatMinor,
      vat_minor: bundle.components.vatMinor,
      unclassified_minor: bundle.components.unclassifiedMinor,
      total_minor: bundle.components.totalMinor,
      ...(bundle.bundleVersion === 2 ? { component_version: 2,
        payment_fee_minor: bundle.components.paymentFeeMinor, payment_fee_vat_minor: bundle.components.paymentFeeVatMinor } : {}),
    },
    lines: bundle.lines.map((line) => ({
      revision_id: revisionId,
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      order_id: bundle.orderId,
      revision: bundle.revision,
      line_key: line.lineKey,
      source_line_id: line.sourceLineId,
      product_id: line.productId,
      variant_id: line.variantId,
      sku_snapshot: line.skuSnapshot,
      title_snapshot: line.titleSnapshot,
      archived_variant: line.archivedVariant,
      quantity: line.quantity,
      unit_price_minor: line.unitPriceMinor,
      line_total_minor: line.lineTotalMinor,
      cost_minor: line.unitCostMinor,
      cost_evidence_id: line.costEvidenceId,
    })),
  };
}

function uuid(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  ) {
    throw integrity("revision id is invalid");
  }
  return value;
}

function replay(
  rows: ExistingRow[],
  bundle: OriginalRevisionBundle,
): PersistedOriginalOrderCommercialRevisionV1 | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw integrity("has conflicting identities");
  const revisionRecord = record(rows[0]!.revision_record, "revision_record");
  const revisionId = uuid(revisionRecord.id);
  const expected = expectedReplay(bundle, revisionId);
  assertEquivalent(revisionRecord, expected.revision, "revision");
  assertEquivalent(rows[0]!.component_record, expected.component, "component");
  assertEquivalent(rows[0]!.line_records, expected.lines, "lines");
  return {
    outcome: "replayed",
    bundleFingerprint: bundle.bundleFingerprint,
    merchantId: bundle.merchantId,
    storeId: bundle.storeId,
    orderId: bundle.orderId,
    revisionId,
    revision: 0,
    idempotencyKey: bundle.idempotencyKey,
  };
}

async function insertedId(
  client: PoolClient,
  sql: string,
  params: unknown[],
  field: string,
): Promise<string> {
  const result = await client.query<{ id: unknown }>(sql, params);
  if (result.rows.length !== 1) throw integrity(`${field} insert coverage drift`);
  return uuid(result.rows[0]!.id);
}

export class PostgresOriginalOrderCommercialRevisionRepositoryV1
  implements OriginalOrderCommercialRevisionRepositoryV1, OriginalOrderCommercialRevisionRepositoryV2 {
  readonly transactionOwnership: "repository" | "caller";
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly client: PoolClient,
    options: PostgresOriginalOrderCommercialRevisionOptionsV1,
  ) {
    this.statementTimeoutMs = boundedTimeout(
      options.statementTimeoutMs,
      "original revision statement timeout",
      ORIGINAL_REVISION_STATEMENT_TIMEOUT_HARD_CAP_MS,
    );
    this.lockTimeoutMs = boundedTimeout(
      options.lockTimeoutMs,
      "original revision lock timeout",
      ORIGINAL_REVISION_LOCK_TIMEOUT_HARD_CAP_MS,
    );
    if (this.lockTimeoutMs > this.statementTimeoutMs) {
      throw new Error("original revision lock timeout cannot exceed statement timeout");
    }
    this.transactionOwnership = options.transactionOwnership ?? "repository";
    if (this.transactionOwnership !== "repository" && this.transactionOwnership !== "caller") {
      throw new Error("original revision transaction ownership is invalid");
    }
  }

  async appendOriginalRevision(
    value: OriginalRevisionBundle,
  ): Promise<PersistedOriginalOrderCommercialRevisionV1> {
    const bundle = value.bundleVersion === 2
      ? assertNormalizedOriginalOrderCommercialRevisionV2(value) : assertNormalizedOriginalOrderCommercialRevisionV1(value);
    let transactionStarted = false;
    try {
      if (this.transactionOwnership === "repository") {
        await this.client.query("BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED");
        transactionStarted = true;
      }
      await this.client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${this.statementTimeoutMs}ms`,
      ]);
      await this.client.query("SELECT set_config('lock_timeout', $1, true)", [
        `${this.lockTimeoutMs}ms`,
      ]);
      await this.client.query(`
        /* original_order_commercial_revision_lock */
        SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
      `, [`original-revision:${bundle.merchantId}:${bundle.storeId}:${bundle.orderId}`]);

      const existing = await this.client.query<ExistingRow>(`
        /* original_order_commercial_revision_existing */
        SELECT
          to_jsonb(revisions) - 'recorded_at' AS revision_record,
          -- Freeze the V1 shape across additive migrations; never hide a fee-bearing row.
          CASE WHEN $5::int = 2 OR (
                 COALESCE((to_jsonb(components)->>'component_version')::int, 1) = 1
                 AND COALESCE((to_jsonb(components)->>'payment_fee_minor')::numeric, 0) = 0
                 AND COALESCE((to_jsonb(components)->>'payment_fee_vat_minor')::numeric, 0) = 0)
          THEN jsonb_build_object(
            'revision_id', components.revision_id,
            'merchant_id', components.merchant_id, 'store_id', components.store_id,
            'order_id', components.order_id, 'revision', components.revision,
            'currency_code', components.currency_code, 'minor_unit_exponent', components.minor_unit_exponent,
            'tax_mode', components.tax_mode,
            'merchandise_gross_minor', components.merchandise_gross_minor,
            'discount_minor', components.discount_minor,
            'merchandise_net_minor', components.merchandise_net_minor,
            'shipping_minor', components.shipping_minor,
            'merchandise_vat_minor', components.merchandise_vat_minor,
            'shipping_vat_minor', components.shipping_vat_minor,
            'vat_minor', components.vat_minor, 'unclassified_minor', components.unclassified_minor,
            'total_minor', components.total_minor
          ) || CASE WHEN $5::int = 2 THEN jsonb_build_object(
            'component_version', to_jsonb(components)->'component_version',
            'payment_fee_minor', to_jsonb(components)->'payment_fee_minor',
            'payment_fee_vat_minor', to_jsonb(components)->'payment_fee_vat_minor'
          ) ELSE '{}'::jsonb END
          ELSE to_jsonb(components) - 'recorded_at' END AS component_record,
          COALESCE(lines.records, '[]'::jsonb) AS line_records
        FROM app.order_commercial_revisions revisions
        LEFT JOIN app.order_commercial_revision_components components
          ON components.revision_id = revisions.id
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            to_jsonb(revision_lines) - 'id' - 'recorded_at'
            ORDER BY revision_lines.line_key
          ) AS records
          FROM app.order_commercial_revision_lines revision_lines
          WHERE revision_lines.revision_id = revisions.id
        ) lines ON true
        WHERE revisions.merchant_id = $1
          AND revisions.store_id = $2
          AND revisions.order_id = $3
          AND (
            revisions.idempotency_key = $4
            OR (revisions.source_type = 'original_order' AND revisions.source_id = $3)
            OR revisions.revision = 0
          )
        ORDER BY revisions.id
      `, [bundle.merchantId, bundle.storeId, bundle.orderId, bundle.idempotencyKey, bundle.bundleVersion]);
      const prior = replay(existing.rows, bundle);
      if (prior) {
        if (this.transactionOwnership === "repository") await this.client.query("COMMIT");
        return prior;
      }

      const revisionId = await insertedId(this.client, `
        /* original_order_commercial_revision_insert_revision */
        INSERT INTO app.order_commercial_revisions (
          merchant_id, store_id, order_id, revision, source_type, source_id,
          source_correction_id, commercial_state, currency_code,
          minor_unit_exponent, effective_at, idempotency_key, data_quality, metadata
        ) VALUES (
          $1, $2, $3, 0, 'original_order', $3,
          NULL, 'active', 'VND', 0, $4::timestamptz, $5, $6, $7::jsonb
        )
        RETURNING id::text AS id
      `, [
        bundle.merchantId,
        bundle.storeId,
        bundle.orderId,
        bundle.sourceOccurredAt,
        bundle.idempotencyKey,
        bundle.dataQuality,
        JSON.stringify(revisionMetadata(bundle)),
      ], "revision");

      await insertedId(this.client, `
        /* original_order_commercial_revision_insert_components */
        INSERT INTO app.order_commercial_revision_components (
          revision_id, merchant_id, store_id, order_id, revision,
          currency_code, minor_unit_exponent, tax_mode,
          merchandise_gross_minor, discount_minor, merchandise_net_minor,
          shipping_minor, merchandise_vat_minor, shipping_vat_minor, vat_minor,
          unclassified_minor, total_minor
          ${bundle.bundleVersion === 2 ? ", component_version, payment_fee_minor, payment_fee_vat_minor" : ""}
        ) VALUES (
          $1, $2, $3, $4, 0, 'VND', 0, $5,
          $6, $7, $8, $9, $10, $11, $12, $13, $14
          ${bundle.bundleVersion === 2 ? ", 2, $15, $16" : ""}
        )
        RETURNING revision_id::text AS id
      `, [
        revisionId,
        bundle.merchantId,
        bundle.storeId,
        bundle.orderId,
        bundle.components.taxMode,
        bundle.components.merchandiseGrossMinor,
        bundle.components.discountMinor,
        bundle.components.merchandiseNetMinor,
        bundle.components.shippingMinor,
        bundle.components.merchandiseVatMinor,
        bundle.components.shippingVatMinor,
        bundle.components.vatMinor,
        bundle.components.unclassifiedMinor,
        bundle.components.totalMinor,
        ...(bundle.bundleVersion === 2 ? [bundle.components.paymentFeeMinor, bundle.components.paymentFeeVatMinor] : []),
      ], "components");

      for (const line of bundle.lines) {
        await insertedId(this.client, `
          /* original_order_commercial_revision_insert_line */
          INSERT INTO app.order_commercial_revision_lines (
            revision_id, merchant_id, store_id, order_id, revision,
            line_key, source_line_id, product_id, variant_id, sku_snapshot,
            title_snapshot, archived_variant, quantity, unit_price_minor,
            line_total_minor, cost_minor, cost_evidence_id
          ) VALUES (
            $1, $2, $3, $4, 0, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15, $16
          )
          RETURNING id::text AS id
        `, [
          revisionId,
          bundle.merchantId,
          bundle.storeId,
          bundle.orderId,
          line.lineKey,
          line.sourceLineId,
          line.productId,
          line.variantId,
          line.skuSnapshot,
          line.titleSnapshot,
          line.archivedVariant,
          line.quantity,
          line.unitPriceMinor,
          line.lineTotalMinor,
          line.unitCostMinor,
          line.costEvidenceId,
        ], "line");
      }

      if (this.transactionOwnership === "repository") await this.client.query("COMMIT");
      return {
        outcome: "inserted",
        bundleFingerprint: bundle.bundleFingerprint,
        merchantId: bundle.merchantId,
        storeId: bundle.storeId,
        orderId: bundle.orderId,
        revisionId,
        revision: 0,
        idempotencyKey: bundle.idempotencyKey,
      };
    } catch (error) {
      if (transactionStarted) await this.client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}
