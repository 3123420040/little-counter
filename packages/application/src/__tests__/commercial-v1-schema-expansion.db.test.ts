import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPlatformClient, shutdownPlatformPool, type PoolClient } from "../db/client";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { createOriginalOrderCommercialRevisionTaskV1, createOriginalOrderCommercialRevisionTaskV2 } from "../services/original-order-commercial-revision-service";
import { createPaymentChargeBundleTaskV1, createPaymentChargeBundleTaskV2 } from "../services/payment-charge-bundle-service";
import { PostgresOriginalOrderCommercialRevisionRepositoryV1 } from "../services/postgres-original-order-commercial-revision-repository";
import { PostgresPaymentChargeBundleRepositoryV1 } from "../services/postgres-payment-charge-bundle-repository";
import { createCorrectionCommercialRevisionTaskV2, type CorrectionCommercialRevisionInputV2 } from "../services/correction-commercial-revision-service";
import { PostgresCorrectionCommercialRevisionRepositoryV1 } from "../services/postgres-correction-commercial-revision-repository";
import { appendCancellationCommercialRevisionV1 } from "../services/cancellation-commercial-revision-service";

let client: PoolClient;
const options = { statementTimeoutMs: 10_000, lockTimeoutMs: 1_000, transactionOwnership: "caller" as const };
beforeAll(async () => {
  client = await connectPlatformClient();
  await assertSafeTestDatabaseSentinel(client, requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL));
});
afterAll(async () => { client?.release(); await shutdownPlatformPool(); });

describe("V1 financial replay across additive fee schema", () => {
  it.each(["pending", "posted"] as const)("persists and replays a V2 fee snapshot and %s charge after the canonical expansion", async (status) => {
    await client.query("BEGIN");
    try {
      await client.query(readFileSync(new URL("../../../../db/migrations/067_payment_fee_components.sql", import.meta.url), "utf8"));
      const orderId = `fee-v2-${randomUUID()}`;
      await client.query(`INSERT INTO public."order"(id,currency_code,merchant_id,store_id)
        VALUES($1,'vnd','merchant_default','store_default')`, [orderId]);
      const task = createOriginalOrderCommercialRevisionTaskV2({ config: { enabled: true },
        repository: new PostgresOriginalOrderCommercialRevisionRepositoryV1(client, options) }, {
        merchantId: "merchant_default", storeId: "store_default", orderId,
        orderCreatedInCurrentTransaction: true, currencyCode: "VND", minorUnitExponent: 0,
        sourceOccurredAt: "2026-10-25T00:00:00.000Z",
        totals: { taxMode: "inclusive", vatRatePpm: 100_000, commercialCalculationVersion: 2,
          subtotalMinor: 240_000, discountMinor: 24_000, merchandisePayableMinor: 216_000,
          shippingMinor: 20_000, merchandiseVatMinor: 19_636, shippingVatMinor: 1_818,
          vatMinor: 21_847, unclassifiedMinor: 0, totalMinor: 240_320,
          paymentFeeType: "percent", paymentFeeValue: 2, paymentFeeBasisMinor: 216_000,
          paymentFeeMinor: 4_320, paymentFeeVatMinor: 393 },
        lines: [{ lineKey: "line-1", sourceLineId: "source-1", productId: null, variantId: null,
          skuSnapshot: "FEE-V2", titleSnapshot: "V2 fixture", archivedVariant: false,
          quantity: 1, unitPriceMinor: 240_000, unitCostMinor: 50_000, costEvidenceId: "fixture-cost" }],
      });
      if (!task.enabled) throw new Error("revision task must be enabled");
      const first = await task.execute();
      expect(first.outcome).toBe("inserted");
      expect(await task.execute()).toEqual({ ...first, outcome: "replayed" });
      const stored = await client.query(`SELECT component_version,payment_fee_minor::text,payment_fee_vat_minor::text,
        r.metadata FROM app.order_commercial_revision_components c JOIN app.order_commercial_revisions r ON r.id=c.revision_id
        WHERE c.revision_id=$1`, [first.revisionId]);
      expect(stored.rows[0]).toMatchObject({ component_version: 2, payment_fee_minor: "4320", payment_fee_vat_minor: "393",
        metadata: { bundleVersion: 2, commercialCalculationVersion: 2,
          paymentFee: { paymentFeeType: "percent", paymentFeeValue: 2, paymentFeeBasisMinor: 216_000 } } });
      const forged = createPaymentChargeBundleTaskV2({ config: { enabled: true },
        repository: new PostgresPaymentChargeBundleRepositoryV1(client, options) }, {
        merchantId: "merchant_default", storeId: "store_default", orderId, commercialRevisionId: first.revisionId,
        commercialRevision: 0, currencyCode: "VND", minorUnitExponent: 0, status: "pending", method: "provider",
        components: { ...task.bundle.components, paymentFeeMinor: 5_320, shippingMinor: 19_000,
          paymentFeeVatMinor: 484, shippingVatMinor: 1_727 },
        idempotencyKey: `${orderId}:forged`, sourceType: "order_created", sourceId: `${orderId}:forged`, sourceOccurredAt: "2026-10-25T00:00:00.000Z",
      });
      if (!forged.enabled) throw new Error("charge task must be enabled");
      await expect(forged.execute()).rejects.toThrow("revision component");
      for (const table of ["payment_events", "commercial_obligations"]) {
        expect((await client.query(`SELECT count(*)::int AS count FROM app.${table} WHERE order_id=$1`, [orderId])).rows[0].count).toBe(0);
      }
      await client.query("SAVEPOINT forged_fee_sql");
      const forgedEvent = await client.query(`INSERT INTO app.payment_events
        (merchant_id,store_id,order_id,commercial_revision_id,kind,status,method,currency_code,minor_unit_exponent,
          amount_minor,idempotency_key,source_type,source_id,source_occurred_at)
        VALUES('merchant_default','store_default',$1,$2,'charge','pending','provider','VND',0,
          240320,$3,'order_created',$3,'2026-10-25T00:00:00.000Z') RETURNING id`, [orderId, first.revisionId, `${orderId}:forged-sql`]);
      await expect(client.query(`INSERT INTO app.payment_event_component_allocations
        (payment_event_id,commercial_revision_id,merchant_id,store_id,currency_code,minor_unit_exponent,tax_mode,
          merchandise_gross_minor,discount_minor,merchandise_net_minor,shipping_minor,merchandise_vat_minor,
          shipping_vat_minor,vat_minor,unclassified_minor,total_minor,component_version,payment_fee_minor,payment_fee_vat_minor)
        SELECT $1,revision_id,merchant_id,store_id,currency_code,minor_unit_exponent,tax_mode,
          merchandise_gross_minor,discount_minor,merchandise_net_minor,19000,merchandise_vat_minor,
          1727,vat_minor,unclassified_minor,total_minor,2,5320,484
        FROM app.order_commercial_revision_components WHERE revision_id=$2`, [forgedEvent.rows[0].id, first.revisionId]))
        .rejects.toThrow("revision snapshot");
      await client.query("ROLLBACK TO SAVEPOINT forged_fee_sql");
      await client.query("RELEASE SAVEPOINT forged_fee_sql");
      const charge = createPaymentChargeBundleTaskV2({ config: { enabled: true },
        repository: new PostgresPaymentChargeBundleRepositoryV1(client, options) }, {
        merchantId: "merchant_default", storeId: "store_default", orderId, commercialRevisionId: first.revisionId,
        commercialRevision: 0, currencyCode: "VND", minorUnitExponent: 0, status,
        method: status === "posted" ? "cod" : "provider", components: task.bundle.components,
        idempotencyKey: `${orderId}:charge`, sourceType: "order_created", sourceId: orderId, sourceOccurredAt: "2026-10-25T00:00:00.000Z",
        evidence: status === "posted" ? { evidenceType: "cod_order_created", evidenceFingerprint: "a".repeat(64),
          sourceSystem: "fixture", sourceReference: orderId } : undefined,
      });
      if (!charge.enabled) throw new Error("charge task must be enabled");
      const paid = await charge.execute();
      expect(paid).toMatchObject({ outcome: "inserted", amountMinor: 240_320, status });
      expect(await charge.execute()).toEqual({ ...paid, outcome: "replayed" });
      const allocation = await client.query(`SELECT component_version,payment_fee_minor::text,payment_fee_vat_minor::text
        FROM app.payment_event_component_allocations WHERE payment_event_id=$1`, [paid.paymentEventId]);
      expect(allocation.rows).toEqual([{ component_version: 2, payment_fee_minor: "4320", payment_fee_vat_minor: "393" }]);
      const correctionInput: CorrectionCommercialRevisionInputV2 = {
        merchantId: "merchant_default", storeId: "store_default", orderId, correctionId: `${orderId}:correction`, revision: 1,
        sourceOccurredAt: "2026-10-26T00:00:00.000Z", currencyCode: "VND", minorUnitExponent: 0, taxMode: "inclusive", vatRatePpm: 100_000,
        beforeTotals: { subtotal: 240_000, discount: 24_000, merchandisePayable: 216_000, shippingFee: 20_000,
          merchandiseTax: 19_636, shippingTax: 1_818, tax: 21_847, total: 240_320, paymentFeeType: "percent", paymentFeeValue: 2,
          paymentFeeBasisMinor: 216_000, paymentFeeMinor: 4_320, paymentFeeVatMinor: 393 },
        afterTotals: { subtotal: 360_000, discount: 24_000, merchandisePayable: 336_000, shippingFee: 5_000,
          merchandiseTax: 30_545, shippingTax: 455, tax: 31_611, total: 347_720, paymentFeeType: "percent", paymentFeeValue: 2,
          paymentFeeBasisMinor: 336_000, paymentFeeMinor: 6_720, paymentFeeVatMinor: 611 },
        lines: [{ variantId: "fixture-variant", productId: "fixture-product", skuSnapshot: "FEE-V2", titleSnapshot: "V2 correction fixture",
          quantity: 1, unitPriceMinor: 360_000 }],
      };
      const correctionRepository = new PostgresCorrectionCommercialRevisionRepositoryV1(client, options);
      const wrongBaseFee = createCorrectionCommercialRevisionTaskV2({ repository: correctionRepository }, { ...correctionInput,
        beforeTotals: { ...correctionInput.beforeTotals, paymentFeeType: "amount", paymentFeeValue: 4_320 } });
      await expect(wrongBaseFee.execute()).rejects.toThrow("predecessor fee/tax context drift");
      expect((await client.query(`SELECT count(*)::int AS count FROM app.order_commercial_revisions WHERE order_id=$1 AND revision=1`, [orderId])).rows[0].count).toBe(0);
      const correction = createCorrectionCommercialRevisionTaskV2({ repository: correctionRepository }, correctionInput);
      const corrected = await correction.execute();
      expect(corrected).toMatchObject({ outcome: "inserted", revision: 1 });
      expect(await correction.execute()).toEqual({ ...corrected, outcome: "replayed" });
      const correctionComponents = await client.query(`SELECT component_version,payment_fee_minor::text,payment_fee_vat_minor::text
        FROM app.order_commercial_revision_components WHERE revision_id=$1`, [corrected.revisionId]);
      expect(correctionComponents.rows).toEqual([{ component_version: 2, payment_fee_minor: "6720", payment_fee_vat_minor: "611" }]);
      const deltaEvent = await client.query(`INSERT INTO app.payment_events
        (merchant_id,store_id,order_id,commercial_revision_id,kind,status,method,currency_code,minor_unit_exponent,
          amount_minor,idempotency_key,source_type,source_id,source_occurred_at)
        VALUES('merchant_default','store_default',$1,$2,'charge','pending','provider','VND',0,
          107400,$3,'order_correction',$4,'2026-10-26T00:00:00.000Z') RETURNING id`,
      [orderId, corrected.revisionId, `${orderId}:delta-charge`, correctionInput.correctionId]);
      const insertDelta = (version: number, feeDelta: number, feeVatDelta: number) => client.query(`
        INSERT INTO app.payment_correction_component_deltas
          (payment_event_id,merchant_id,store_id,order_id,base_commercial_revision_id,effective_commercial_revision_id,
            currency_code,minor_unit_exponent,tax_mode,merchandise_gross_delta_minor,discount_delta_minor,
            merchandise_net_delta_minor,shipping_delta_minor,merchandise_vat_delta_minor,shipping_vat_delta_minor,
            vat_delta_minor,unclassified_delta_minor,total_delta_minor,base_snapshot_fingerprint,
            effective_snapshot_fingerprint,contract_fingerprint,component_version,payment_fee_delta_minor,payment_fee_vat_delta_minor)
        VALUES($1,'merchant_default','store_default',$2,$3,$4,'VND',0,'inclusive',120000,0,120000,-15000,
          10909,-1363,9764,0,107400,$5,$5,$5,$6,$7,$8)`,
      [deltaEvent.rows[0].id, orderId, first.revisionId, corrected.revisionId, "a".repeat(64), version, feeDelta, feeVatDelta]);
      for (const [version, feeDelta, feeVatDelta, constraint] of [
        [1, 2400, 218, "payment_fee_delta_version_v2_check"],
        [2, 2401, 218, "payment_fee_delta_total_v2_check"],
        [2, 2400, 219, "payment_fee_delta_vat_v2_check"],
      ] as const) {
        await client.query("SAVEPOINT invalid_fee_delta");
        await expect(insertDelta(version, feeDelta, feeVatDelta)).rejects.toMatchObject({ code: "23514", constraint });
        await client.query("ROLLBACK TO SAVEPOINT invalid_fee_delta");
        await client.query("RELEASE SAVEPOINT invalid_fee_delta");
        expect((await client.query(`SELECT count(*)::int AS count FROM app.payment_correction_component_deltas
          WHERE payment_event_id=$1`, [deltaEvent.rows[0].id])).rows[0].count).toBe(0);
      }
      expect((await insertDelta(2, 2400, 218)).rowCount).toBe(1);
      const cancellationInput = { merchantId: "merchant_default", storeId: "store_default", orderId,
        sourceId: `${orderId}:cancel`, sourceOccurredAt: "2026-10-26T00:01:00.000Z", reason: "UAT fee cancellation" };
      const cancelled = await appendCancellationCommercialRevisionV1(client, cancellationInput);
      expect(cancelled).toMatchObject({ outcome: "inserted", revision: 2, totalMinor: 347_720 });
      expect(await appendCancellationCommercialRevisionV1(client, cancellationInput)).toEqual({ ...cancelled, outcome: "replayed" });
      const cancelledSnapshot = await client.query(`SELECT c.component_version,c.payment_fee_minor::text,c.payment_fee_vat_minor::text,r.metadata
        FROM app.order_commercial_revision_components c JOIN app.order_commercial_revisions r ON r.id=c.revision_id WHERE c.revision_id=$1`, [cancelled.revisionId]);
      expect(cancelledSnapshot.rows[0]).toMatchObject({ component_version: 2, payment_fee_minor: "6720", payment_fee_vat_minor: "611",
        metadata: { bundleVersion: 2, commercialCalculationVersion: 2, vatRatePpm: 100_000,
          paymentFee: { paymentFeeType: "percent", paymentFeeValue: 2, paymentFeeBasisMinor: 336_000 } } });
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    } finally { await client.query("ROLLBACK"); }
  });
  it.each([
    ["revision", 0, false], ["payment", 0, false], ["revision", 1, false], ["payment", 1, false],
    ["revision", 0, true], ["payment", 0, true],
  ] as const)("replays %s only when added fee columns equal zero (fee=%i, canonical=%s)", async (kind, fee, canonical) => {
    await client.query("BEGIN");
    try {
      const orderId = `fee-expand-${randomUUID()}`;
      await client.query(`INSERT INTO public."order"(id,currency_code,merchant_id,store_id)
        VALUES($1,'vnd','merchant_default','store_default')`, [orderId]);
      const task = createOriginalOrderCommercialRevisionTaskV1({ config: { enabled: true },
        repository: new PostgresOriginalOrderCommercialRevisionRepositoryV1(client, options) }, {
        merchantId: "merchant_default", storeId: "store_default", orderId,
        orderCreatedInCurrentTransaction: true, currencyCode: "VND", minorUnitExponent: 0,
        sourceOccurredAt: "2026-10-25T00:00:00.000Z",
        totals: { taxMode: "inclusive", vatRatePpm: 100_000, commercialCalculationVersion: 1,
          subtotalMinor: 110_000, discountMinor: 0, merchandisePayableMinor: 110_000,
          shippingMinor: 11_000, merchandiseVatMinor: 10_000, shippingVatMinor: 1_000,
          vatMinor: 11_000, unclassifiedMinor: 0, totalMinor: 121_000 },
        lines: [{ lineKey: "line-1", sourceLineId: "source-1", productId: null, variantId: null,
          skuSnapshot: "FEE-EXPANSION", titleSnapshot: "Schema expansion fixture", archivedVariant: false,
          quantity: 1, unitPriceMinor: 110_000, unitCostMinor: 50_000, costEvidenceId: "fixture-cost" }],
      });
      if (!task.enabled) throw new Error("revision task must be enabled");
      const revision = await task.execute();
      const chargeTask = createPaymentChargeBundleTaskV1({ config: { enabled: true },
        repository: new PostgresPaymentChargeBundleRepositoryV1(client, options) }, {
        merchantId: "merchant_default", storeId: "store_default", orderId,
        commercialRevisionId: revision.revisionId, commercialRevision: 0,
        currencyCode: "VND", minorUnitExponent: 0, method: "provider", status: "pending",
        components: task.bundle.components, idempotencyKey: `${orderId}:charge`,
        sourceType: "order_created", sourceId: orderId, sourceOccurredAt: "2026-10-25T00:00:00.000Z",
      });
      if (!chargeTask.enabled) throw new Error("charge task must be enabled");
      const first = kind === "revision" ? revision : await chargeTask.execute();
      const execute = () => kind === "revision" ? task.execute() : chargeTask.execute();
      expect(await execute()).toMatchObject({ ...first, outcome: "replayed" });
      const table = kind === "revision" ? "order_commercial_revision_components" : "payment_event_component_allocations";
      if (canonical) await client.query(readFileSync(new URL("../../../../db/migrations/067_payment_fee_components.sql", import.meta.url), "utf8"));
      else await client.query(`ALTER TABLE app.${table}
        ADD COLUMN IF NOT EXISTS payment_fee_minor BIGINT NOT NULL DEFAULT ${fee},
        ADD COLUMN IF NOT EXISTS payment_fee_vat_minor BIGINT NOT NULL DEFAULT 0`);
      if (fee === 0) expect(await execute()).toMatchObject({ ...first, outcome: "replayed" });
      else await expect(execute()).rejects.toThrow("component shape drift");
      const rows = await client.query(`SELECT count(*)::int AS count FROM app.order_commercial_revisions WHERE order_id=$1`, [orderId]);
      expect(rows.rows[0].count).toBe(1);
      if (canonical && kind === "revision") {
        const base = { subtotal: 110_000, discount: 0, merchandisePayable: 110_000, shippingFee: 11_000,
          merchandiseTax: 10_000, shippingTax: 1_000, tax: 11_000, total: 121_000,
          paymentFeeType: "amount" as const, paymentFeeValue: 0, paymentFeeBasisMinor: 110_000,
          paymentFeeMinor: 0, paymentFeeVatMinor: 0 };
        const correction = createCorrectionCommercialRevisionTaskV2({
          repository: new PostgresCorrectionCommercialRevisionRepositoryV1(client, options),
        }, { merchantId: "merchant_default", storeId: "store_default", orderId, correctionId: `${orderId}:add-fee`, revision: 1,
          currencyCode: "VND", minorUnitExponent: 0, taxMode: "inclusive", vatRatePpm: 100_000,
          sourceOccurredAt: "2026-10-26T00:00:00.000Z", beforeTotals: base,
          afterTotals: { ...base, paymentFeeValue: 1_000, paymentFeeMinor: 1_000, paymentFeeVatMinor: 91, tax: 11_091, total: 122_000 },
          lines: [{ productId: "fixture-product", variantId: "fixture-variant", skuSnapshot: "FEE-V2", titleSnapshot: "V1 to V2",
            quantity: 1, unitPriceMinor: 110_000 }],
        });
        const added = await correction.execute();
        expect(added).toMatchObject({ outcome: "inserted", revision: 1 });
        expect(await correction.execute()).toEqual({ ...added, outcome: "replayed" });
        expect(await task.execute()).toEqual({ ...revision, outcome: "replayed" });
        const retained = await client.query(`SELECT component_version,payment_fee_minor::text FROM app.order_commercial_revision_components WHERE revision_id=$1`, [revision.revisionId]);
        expect(retained.rows).toEqual([{ component_version: 1, payment_fee_minor: "0" }]);
      }
      if (!canonical && fee === 0) {
        const cancellation = await appendCancellationCommercialRevisionV1(client, { merchantId: "merchant_default", storeId: "store_default",
          orderId, sourceId: `${orderId}:legacy-cancel`, sourceOccurredAt: "2026-10-26T00:00:00.000Z", reason: "Legacy cancellation" });
        expect(cancellation).toMatchObject({ outcome: "inserted", totalMinor: 121_000, revision: 1 });
        const legacy = await client.query(`SELECT r.metadata,COALESCE(to_jsonb(c)->>'payment_fee_minor','0') AS payment_fee_minor,
          to_jsonb(c) ? 'payment_fee_minor' AS has_fee_columns FROM app.order_commercial_revisions r
          JOIN app.order_commercial_revision_components c ON c.revision_id=r.id WHERE r.id=$1`, [cancellation.revisionId]);
        expect(legacy.rows).toEqual([{ metadata: { reason: "Legacy cancellation", previousRevisionId: revision.revisionId },
          payment_fee_minor: "0", has_fee_columns: kind === "revision" }]);
      }
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    } finally { await client.query("ROLLBACK"); }
  });
});
