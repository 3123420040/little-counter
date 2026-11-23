import type { PoolClient } from "../db/client";
import {
  assertNormalizedCorrectionCommercialRevisionV1,
  assertNormalizedCorrectionCommercialRevisionV2,
  type CorrectionCommercialRevisionRepositoryV1,
  type CorrectionCommercialRevisionRepositoryV2,
  type NormalizedCorrectionCommercialRevisionV1,
  type NormalizedCorrectionCommercialRevisionV2,
  type PersistedCorrectionCommercialRevisionV1,
} from "./correction-commercial-revision-service";

export interface PostgresCorrectionCommercialRevisionOptionsV1 {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  transactionOwnership?: "repository" | "caller";
}

type ExistingRow = {
  id: unknown;
  revision: unknown;
  bundle_fingerprint: unknown;
};

type PreviousRow = {
  component_version?: unknown;
  payment_fee_minor?: unknown;
  payment_fee_vat_minor?: unknown;
  revision_metadata?: { bundleVersion?: unknown; vatRatePpm?: unknown; paymentFee?: unknown };
  revision: unknown;
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
};

function timeout(value: number, field: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field} must be between 1 and ${maximum}`);
  }
  return value;
}

function integer(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`persisted correction revision ${field} is invalid`);
  }
  return parsed;
}

function uuid(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  ) {
    throw new Error(`persisted correction revision ${field} is invalid`);
  }
  return value;
}

function priorComponents(row: PreviousRow, version: 1 | 2) {
  if (row.tax_mode !== "inclusive" && row.tax_mode !== "exclusive") {
    throw new Error("persisted correction revision prior tax mode is invalid");
  }
  if (version === 1 && (integer(row.component_version ?? 1, "component version") !== 1
    || integer(row.payment_fee_minor ?? 0, "prior payment fee") !== 0
    || integer(row.payment_fee_vat_minor ?? 0, "prior payment fee VAT") !== 0)) {
    throw new Error("V1 correction cannot use a V2 predecessor");
  }
  return {
    taxMode: row.tax_mode,
    merchandiseGrossMinor: integer(row.merchandise_gross_minor, "prior merchandise gross"),
    discountMinor: integer(row.discount_minor, "prior discount"),
    merchandiseNetMinor: integer(row.merchandise_net_minor, "prior merchandise net"),
    shippingMinor: integer(row.shipping_minor, "prior shipping"),
    merchandiseVatMinor: integer(row.merchandise_vat_minor, "prior merchandise VAT"),
    shippingVatMinor: integer(row.shipping_vat_minor, "prior shipping VAT"),
    vatMinor: integer(row.vat_minor, "prior VAT"),
    unclassifiedMinor: integer(row.unclassified_minor, "prior unclassified"),
    totalMinor: integer(row.total_minor, "prior total"),
    ...(version === 2 ? { paymentFeeMinor: integer(row.payment_fee_minor ?? 0, "prior payment fee"),
      paymentFeeVatMinor: integer(row.payment_fee_vat_minor ?? 0, "prior payment fee VAT") } : {}),
  };
}

export class PostgresCorrectionCommercialRevisionRepositoryV1
  implements CorrectionCommercialRevisionRepositoryV1, CorrectionCommercialRevisionRepositoryV2 {
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  readonly transactionOwnership: "repository" | "caller";

  constructor(
    private readonly client: PoolClient,
    options: PostgresCorrectionCommercialRevisionOptionsV1,
  ) {
    this.statementTimeoutMs = timeout(options.statementTimeoutMs, "statement timeout", 30_000);
    this.lockTimeoutMs = timeout(options.lockTimeoutMs, "lock timeout", 5_000);
    if (this.lockTimeoutMs > this.statementTimeoutMs) {
      throw new Error("correction revision lock timeout cannot exceed statement timeout");
    }
    this.transactionOwnership = options.transactionOwnership ?? "repository";
  }

  async appendCorrectionRevision(
    value: NormalizedCorrectionCommercialRevisionV1 | NormalizedCorrectionCommercialRevisionV2,
  ): Promise<PersistedCorrectionCommercialRevisionV1> {
    const bundle = structuredClone(value.bundleVersion === 2
      ? assertNormalizedCorrectionCommercialRevisionV2(value) : assertNormalizedCorrectionCommercialRevisionV1(value));
    let transactionStarted = false;
    try {
      if (this.transactionOwnership === "repository") {
        await this.client.query("BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED");
        transactionStarted = true;
      }
      await this.client.query("SELECT set_config('statement_timeout', $1, true)", [`${this.statementTimeoutMs}ms`]);
      await this.client.query("SELECT set_config('lock_timeout', $1, true)", [`${this.lockTimeoutMs}ms`]);
      await this.client.query(`
        /* correction_revision_lock */
        SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
      `, [`commercial-revision:${bundle.merchantId}:${bundle.storeId}:${bundle.orderId}`]);

      const existing = await this.client.query<ExistingRow>(`
        /* correction_revision_existing */
        SELECT id::text AS id, revision,
               metadata->>'bundleFingerprint' AS bundle_fingerprint
        FROM app.order_commercial_revisions
        WHERE merchant_id = $1
          AND store_id = $2
          AND order_id = $3
          AND (idempotency_key = $4 OR (source_type = 'order_correction' AND source_id = $5))
        ORDER BY id
      `, [
        bundle.merchantId,
        bundle.storeId,
        bundle.orderId,
        bundle.idempotencyKey,
        bundle.correctionId,
      ]);
      if (existing.rows.length > 1) {
        throw new Error("persisted correction revision has conflicting identities");
      }
      if (existing.rows.length === 1) {
        const row = existing.rows[0]!;
        if (row.bundle_fingerprint !== bundle.bundleFingerprint) {
          throw new Error("persisted correction revision fingerprint drift");
        }
        if (integer(row.revision, "revision") !== bundle.revision) {
          throw new Error("persisted correction revision number drift");
        }
        if (transactionStarted) await this.client.query("COMMIT");
        return {
          outcome: "replayed",
          bundleFingerprint: bundle.bundleFingerprint,
          merchantId: bundle.merchantId,
          storeId: bundle.storeId,
          orderId: bundle.orderId,
          correctionId: bundle.correctionId,
          revisionId: uuid(row.id, "id"),
          revision: bundle.revision,
          idempotencyKey: bundle.idempotencyKey,
        };
      }

      const previous = await this.client.query<PreviousRow>(`
        /* correction_revision_previous */
        SELECT revisions.revision, revisions.metadata AS revision_metadata, components.*
        FROM app.order_commercial_revisions revisions
        JOIN app.order_commercial_revision_components components
          ON components.revision_id = revisions.id
        WHERE revisions.merchant_id = $1
          AND revisions.store_id = $2
          AND revisions.order_id = $3
          AND revisions.revision = $4
        FOR UPDATE OF revisions
      `, [bundle.merchantId, bundle.storeId, bundle.orderId, bundle.revision - 1]);
      if (previous.rows.length !== 1) {
        throw new Error("correction revision predecessor is unavailable or ambiguous");
      }
      if (integer(previous.rows[0]!.revision, "prior revision") !== bundle.revision - 1) {
        throw new Error("correction revision predecessor number drift");
      }
      if (JSON.stringify(priorComponents(previous.rows[0]!, bundle.bundleVersion)) !== JSON.stringify(bundle.baseComponents)) {
        throw new Error("correction revision predecessor component drift");
      }
      if (bundle.bundleVersion === 2 && integer(previous.rows[0]!.component_version ?? 1, "component version") === 2) {
        const metadata = previous.rows[0]!.revision_metadata;
        const fee = metadata?.paymentFee as Record<string, unknown> | undefined;
        if (metadata?.bundleVersion !== 2 || metadata.vatRatePpm !== bundle.vatRatePpm
          || fee?.paymentFeeType !== bundle.basePaymentFee.paymentFeeType
          || fee?.paymentFeeValue !== bundle.basePaymentFee.paymentFeeValue
          || fee?.paymentFeeBasisMinor !== bundle.basePaymentFee.paymentFeeBasisMinor) {
          throw new Error("correction revision predecessor fee/tax context drift");
        }
      }

      const inserted = await this.client.query<{ id: unknown }>(`
        /* correction_revision_insert_revision */
        INSERT INTO app.order_commercial_revisions (
          merchant_id, store_id, order_id, revision, source_type, source_id,
          source_correction_id, commercial_state, currency_code,
          minor_unit_exponent, effective_at, idempotency_key, data_quality,
          metadata
        ) VALUES (
          $1, $2, $3, $4, 'order_correction', $5,
          $5, 'active', $6, $7, $8::timestamptz, $9, $10,
          $11::jsonb
        )
        RETURNING id::text AS id
      `, [
        bundle.merchantId,
        bundle.storeId,
        bundle.orderId,
        bundle.revision,
        bundle.correctionId,
        bundle.currencyCode,
        bundle.minorUnitExponent,
        bundle.sourceOccurredAt,
        bundle.idempotencyKey,
        bundle.dataQuality,
        JSON.stringify({
          bundleVersion: bundle.bundleVersion,
          bundleFingerprint: bundle.bundleFingerprint,
          baseComponents: bundle.baseComponents,
          ...(bundle.bundleVersion === 2 ? { commercialCalculationVersion: 2, vatRatePpm: bundle.vatRatePpm,
            basePaymentFee: bundle.basePaymentFee, paymentFee: bundle.paymentFee } : {}),
        }),
      ]);
      if (inserted.rows.length !== 1) {
        throw new Error("correction revision insert coverage drift");
      }
      const revisionId = uuid(inserted.rows[0]!.id, "id");
      const c = bundle.components;
      const componentInsert = await this.client.query(`
        /* correction_revision_insert_components */
        INSERT INTO app.order_commercial_revision_components (
          revision_id, merchant_id, store_id, order_id, revision,
          currency_code, minor_unit_exponent, tax_mode,
          merchandise_gross_minor, discount_minor, merchandise_net_minor,
          shipping_minor, merchandise_vat_minor, shipping_vat_minor, vat_minor,
          unclassified_minor, total_minor
          ${bundle.bundleVersion === 2 ? ", component_version, payment_fee_minor, payment_fee_vat_minor" : ""}
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16, $17
          ${bundle.bundleVersion === 2 ? ", 2, $18, $19" : ""}
        )
      `, [
        revisionId, bundle.merchantId, bundle.storeId, bundle.orderId,
        bundle.revision, bundle.currencyCode, bundle.minorUnitExponent, c.taxMode,
        c.merchandiseGrossMinor, c.discountMinor, c.merchandiseNetMinor,
        c.shippingMinor, c.merchandiseVatMinor, c.shippingVatMinor, c.vatMinor,
        c.unclassifiedMinor, c.totalMinor,
        ...(bundle.bundleVersion === 2 ? [bundle.components.paymentFeeMinor, bundle.components.paymentFeeVatMinor] : []),
      ]);
      if (componentInsert.rowCount !== 1) {
        throw new Error("correction revision component insert coverage drift");
      }
      for (const line of bundle.lines) {
        const insertedLine = await this.client.query(`
          /* correction_revision_insert_line */
          INSERT INTO app.order_commercial_revision_lines (
            revision_id, merchant_id, store_id, order_id, revision,
            line_key, source_line_id, product_id, variant_id, sku_snapshot,
            title_snapshot, archived_variant, quantity, unit_price_minor,
            line_total_minor, cost_minor, cost_evidence_id
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, NULL, $7, $8, $9,
            $10, false, $11, $12, $13, NULL, NULL
          )
        `, [
          revisionId, bundle.merchantId, bundle.storeId, bundle.orderId,
          bundle.revision, line.lineKey, line.productId, line.variantId,
          line.skuSnapshot, line.titleSnapshot, line.quantity,
          line.unitPriceMinor, line.lineTotalMinor,
        ]);
        if (insertedLine.rowCount !== 1) {
          throw new Error("correction revision line insert coverage drift");
        }
      }
      if (transactionStarted) await this.client.query("COMMIT");
      return {
        outcome: "inserted",
        bundleFingerprint: bundle.bundleFingerprint,
        merchantId: bundle.merchantId,
        storeId: bundle.storeId,
        orderId: bundle.orderId,
        correctionId: bundle.correctionId,
        revisionId,
        revision: bundle.revision,
        idempotencyKey: bundle.idempotencyKey,
      };
    } catch (error) {
      if (transactionStarted) await this.client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}
