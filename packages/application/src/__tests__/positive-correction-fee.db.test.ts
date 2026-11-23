import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectPlatformClient,
  shutdownPlatformPool,
  type PoolClient,
} from "../db/client";
import {
  assertSafeTestDatabaseSentinel,
  requireSafeTestDatabaseTarget,
} from "../db/test-database-target";
import { DASHBOARD_METRIC_TIME_BASIS_V2 } from "@medusa-snus/contracts";
import { recordAuditEntry } from "../repositories/audit-repository";
import { readDashboardRecordedCollectionSliceV2 } from "../services/dashboard-recorded-collection-slice";
import { resolveDashboardStoreWindows } from "../services/dashboard-report-foundation";
import { calculateOrderTotalsV2 } from "../services/order-total-service";
import { recordOriginalOrderCommercialRevisionFromOrderCreateV2 } from "../services/original-order-commercial-revision-caller";
import { createCorrectionCommercialRevisionTaskV2 } from "../services/correction-commercial-revision-service";
import { PostgresCorrectionCommercialRevisionRepositoryV1 } from "../services/postgres-correction-commercial-revision-repository";
import { buildPositiveCorrectionChargeContractV2 } from "../services/payment-positive-correction-charge-contract";
import { recordPositiveCorrectionChargeV1 } from "../services/postgres-positive-correction-charge-repository";

let client: PoolClient;
beforeAll(async () => {
  client = await connectPlatformClient();
  await assertSafeTestDatabaseSentinel(
    client,
    requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL),
  );
});
afterAll(async () => {
  client?.release();
  await shutdownPlatformPool();
});

describe("V2 positive correction persistence", () => {
  it.each(["cash", "cod", "bank_transfer"] as const)(
    "persists signed fee delta for %s and rejects a balanced forged revision",
    async (settlementMethod) => {
      await client.query("BEGIN");
      try {
        const sql = readFileSync(
          new URL(
            "../../../../db/migrations/067_payment_fee_components.sql",
            import.meta.url,
          ),
          "utf8",
        );
        const ledger = await client.query(
          "SELECT checksum FROM app.schema_migrations WHERE filename='067_payment_fee_components.sql'",
        );
        if (ledger.rows.length === 0) await client.query(sql);
        else
          expect(ledger.rows).toEqual([
            { checksum: createHash("sha256").update(sql).digest("hex") },
          ]);
        const lineageSql = readFileSync(
          new URL(
            "../../../../db/migrations/069_payment_fee_correction_delta_lineage.sql",
            import.meta.url,
          ),
          "utf8",
        );
        const lineageLedger = await client.query(
          "SELECT checksum FROM app.schema_migrations WHERE filename='069_payment_fee_correction_delta_lineage.sql'",
        );
        if (lineageLedger.rows.length === 0) await client.query(lineageSql);
        else
          expect(lineageLedger.rows).toEqual([
            { checksum: createHash("sha256").update(lineageSql).digest("hex") },
          ]);
        const orderId = `fee-correction-${randomUUID()}`,
          correctionId = `${orderId}:correction`;
        await client.query(
          `INSERT INTO public."order"(id,currency_code,merchant_id,store_id) VALUES($1,'vnd','merchant_default','store_default')`,
          [orderId],
        );
        const commercialContext = {
          taxMode: "inclusive" as const,
          vatRatePpm: 100_000,
        };
        const before = calculateOrderTotalsV2(
          240_000,
          {
            discountPercent: 10,
            paymentFeeType: "percent",
            paymentFeeValue: 2,
          },
          20_000,
          commercialContext,
        );
        const after = calculateOrderTotalsV2(
          480_000,
          { discountPercent: 10, paymentFeeType: "amount", paymentFeeValue: 0 },
          10_000,
          commercialContext,
        );
        const options = {
          transactionOwnership: "caller" as const,
          statementTimeoutMs: 5_000,
          lockTimeoutMs: 1_000,
        };
        const original =
          await recordOriginalOrderCommercialRevisionFromOrderCreateV2(
            {
              client,
              config: { enabled: true },
              transactionContext: {
                ownership: "caller",
                orderCreatedInCurrentTransaction: true,
              },
              repositoryOptions: options,
            },
            {
              merchantId: "merchant_default",
              storeId: "store_default",
              orderId,
              orderCreatedAt: "2026-10-25T00:00:00.000Z",
              currencyCode: "VND",
              minorUnitExponent: 0,
              commercialContext,
              totals: before,
              lines: [
                {
                  orderLineItemId: `${orderId}:line`,
                  productId: "fixture-product",
                  variantId: "fixture-variant",
                  skuSnapshot: "FEE-POS-CORR",
                  titleSnapshot: "Positive correction fixture",
                  quantity: 1,
                  unitPriceMinor: 240_000,
                  unitCostMinor: 50_000,
                  costEvidenceSource: "inventory.product_settings",
                  costEvidenceUpdatedAt: "2026-10-25T00:00:00.000Z",
                },
              ],
            },
          );
        if (!original.enabled)
          throw new Error("original writer must be enabled");
        const correction = createCorrectionCommercialRevisionTaskV2(
          {
            repository: new PostgresCorrectionCommercialRevisionRepositoryV1(
              client,
              options,
            ),
          },
          {
            merchantId: "merchant_default",
            storeId: "store_default",
            orderId,
            correctionId,
            revision: 1,
            sourceOccurredAt: "2026-10-26T00:00:00.000Z",
            currencyCode: "VND",
            minorUnitExponent: 0,
            taxMode: "inclusive",
            vatRatePpm: 100_000,
            beforeTotals: before,
            afterTotals: after,
            lines: [
              {
                variantId: "fixture-variant",
                productId: "fixture-product",
                skuSnapshot: "FEE-POS-CORR",
                titleSnapshot: "Positive correction fixture",
                quantity: 2,
                unitPriceMinor: 240_000,
              },
            ],
          },
        );
        const effective = await correction.execute();
        const contractInput = {
          merchantId: "merchant_default",
          storeId: "store_default",
          orderId,
          correctionId,
          baseCommercialRevisionId: original.revisionId,
          baseCommercialRevision: 0,
          effectiveCommercialRevisionId: effective.revisionId,
          effectiveCommercialRevision: 1,
          currencyCode: "VND",
          minorUnitExponent: 0,
          sourceOccurredAt: "2026-10-26T00:00:00.000Z",
          beforeComponents: correction.bundle.baseComponents,
          effectiveComponents: correction.bundle.components,
        };
        const forged = buildPositiveCorrectionChargeContractV2({
          ...contractInput,
          effectiveComponents: {
            ...contractInput.effectiveComponents,
            shippingMinor: 9_900,
            shippingVatMinor: 900,
            paymentFeeMinor: 100,
            paymentFeeVatMinor: 9,
          },
        });
        await client.query("SAVEPOINT forged_correction_sql");
        const forgedEvent = await client.query(
          `INSERT INTO app.payment_events
        (merchant_id,store_id,order_id,commercial_revision_id,kind,status,method,currency_code,minor_unit_exponent,
          amount_minor,idempotency_key,source_type,source_id,source_occurred_at)
        VALUES('merchant_default','store_default',$1,$2,'charge','pending','manual_bank','VND',0,
          201680,$3,'order_correction',$4,'2026-10-26T00:00:00.000Z') RETURNING id`,
          [
            orderId,
            effective.revisionId,
            `${orderId}:forged-sql`,
            correctionId,
          ],
        );
        const d = forged.componentDelta;
        await expect(
          client.query(
            `INSERT INTO app.payment_correction_component_deltas
        (payment_event_id,merchant_id,store_id,order_id,base_commercial_revision_id,effective_commercial_revision_id,
          currency_code,minor_unit_exponent,tax_mode,merchandise_gross_delta_minor,discount_delta_minor,
          merchandise_net_delta_minor,shipping_delta_minor,merchandise_vat_delta_minor,shipping_vat_delta_minor,
          vat_delta_minor,unclassified_delta_minor,total_delta_minor,base_snapshot_fingerprint,effective_snapshot_fingerprint,
          contract_fingerprint,component_version,payment_fee_delta_minor,payment_fee_vat_delta_minor)
        VALUES($1,'merchant_default','store_default',$2,$3,$4,'VND',0,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,2,$18,$19)`,
            [
              forgedEvent.rows[0].id,
              orderId,
              original.revisionId,
              effective.revisionId,
              d.taxMode,
              d.merchandiseGrossMinor,
              d.discountMinor,
              d.merchandiseNetMinor,
              d.shippingMinor,
              d.merchandiseVatMinor,
              d.shippingVatMinor,
              d.vatMinor,
              d.unclassifiedMinor,
              d.totalMinor,
              forged.beforeComponentsFingerprint,
              forged.effectiveComponentsFingerprint,
              forged.contractFingerprint,
              d.paymentFeeMinor,
              d.paymentFeeVatMinor,
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          message: expect.stringContaining("V2 correction delta differs"),
        });
        await client.query("ROLLBACK TO SAVEPOINT forged_correction_sql");
        await client.query("RELEASE SAVEPOINT forged_correction_sql");
        await expect(
          recordPositiveCorrectionChargeV1(client, {
            contract: forged,
            settlementMethod,
            ...options,
          }),
        ).rejects.toThrow("revision component");
        expect(
          (
            await client.query(
              `SELECT count(*)::int AS count FROM app.payment_events WHERE order_id=$1`,
              [orderId],
            )
          ).rows[0].count,
        ).toBe(0);
        const contract = buildPositiveCorrectionChargeContractV2(contractInput);
        const first = await recordPositiveCorrectionChargeV1(client, {
          contract,
          settlementMethod,
          ...options,
        });
        expect(first).toMatchObject({
          outcome: "inserted",
          amountMinor: 201_680,
          status: settlementMethod === "bank_transfer" ? "pending" : "posted",
        });
        expect(
          await recordPositiveCorrectionChargeV1(client, {
            contract,
            settlementMethod,
            ...options,
          }),
        ).toEqual({ ...first, outcome: "replayed" });
        const stored = await client.query(
          `SELECT d.component_version,d.shipping_delta_minor::text,d.payment_fee_delta_minor::text,
        d.payment_fee_vat_delta_minor::text,d.total_delta_minor::text,
        (SELECT count(*)::int FROM app.payment_event_evidence x WHERE x.payment_event_id=d.payment_event_id) AS evidence,
        (SELECT count(*)::int FROM app.payment_event_allocations x WHERE x.payment_event_id=d.payment_event_id) AS allocations
        FROM app.payment_correction_component_deltas d WHERE d.payment_event_id=$1`,
          [first.paymentEventId],
        );
        expect(stored.rows).toEqual([
          {
            component_version: 2,
            shipping_delta_minor: "-10000",
            payment_fee_delta_minor: "-4320",
            payment_fee_vat_delta_minor: "-393",
            total_delta_minor: "201680",
            evidence: settlementMethod === "bank_transfer" ? 0 : 1,
            allocations: settlementMethod === "bank_transfer" ? 0 : 1,
          },
        ]);
        const creatorId = `${orderId}:creator`;
        await recordAuditEntry(client, { operatorId: creatorId, role: "manager", organizationId: "merchant_default" }, "order.created", "order", orderId,
          { merchantId: "merchant_default", storeId: "store_default" });
        const reportScope = { scopeKind: "report" as const, merchantId: "merchant_default", storeIds: ["store_default"] };
        const range = { from: "2026-10-25", to: "2026-10-27", inclusiveDays: 3 };
        const readback = await readDashboardRecordedCollectionSliceV2(client, { normalizedScope: reportScope, localDateRange: range,
          storeTimeWindows: await resolveDashboardStoreWindows(client, reportScope, range), reportAsOf: new Date(Date.now() + 60000).toISOString(),
          metricTimeBasis: { ...DASHBOARD_METRIC_TIME_BASIS_V2 } }, { enabled: true }, { mode: "selected", creatorOperatorIds: [creatorId] });
        if (settlementMethod === "bank_transfer") expect(readback).toMatchObject({ enabled: true, data: { currencies: [] } });
        else expect(readback).toMatchObject({ enabled: true, data: { currencies: [{ postedChargeEventCount: 1, recordedGrossCollectionsMinor: 201680,
          components: { paymentFeeMinor: -4320, paymentFeeVatMinor: -393, paymentFeeVatIncludedInPriceMinor: -393,
            paymentFeeVatAddedToPriceMinor: 0, totalMinor: 201680 } }] } });
        const triggerPolicy = await client.query(`SELECT p.proname,p.proconfig,
        EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app'
          AND p.proname IN ('assert_payment_component_allocation','assert_payment_correction_component_delta') ORDER BY p.proname`);
        expect(triggerPolicy.rows).toEqual([
          {
            proname: "assert_payment_component_allocation",
            proconfig: ["search_path=pg_catalog, app"],
            public_execute: false,
          },
          {
            proname: "assert_payment_correction_component_delta",
            proconfig: ["search_path=pg_catalog, app"],
            public_execute: false,
          },
        ]);
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      } finally {
        await client.query("ROLLBACK");
      }
    },
  );
});
