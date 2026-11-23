import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPlatformClient, shutdownPlatformPool, type PoolClient } from "../db/client";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { calculateOrderTotalsV2 } from "../services/order-total-service";
import { recordOriginalOrderCommercialRevisionFromOrderCreateV2 } from "../services/original-order-commercial-revision-caller";
import { recordOrderCreatedPaymentChargeV2 } from "../services/order-created-payment-charge-caller";
import { recordProviderInitialPostedChargeFromLockedStateV1 } from "../services/provider-initial-posted-charge-caller";
import { OrderCommercialComponentsV2Schema } from "@medusa-snus/contracts";
import { readEffectiveOrderV1, readEffectiveOrderV2 } from "../services/effective-order-projection-service";
import { getEffectiveOrderFeatureDetailV2, getEffectiveOrderFeatureDetailV3, getEffectiveOrderFeatureReceiptTextV1, getEffectiveOrderFeatureReceiptPdfV1 } from "../services/order-financial-feature-route-service";

let client: PoolClient;
beforeAll(async () => {
  client = await connectPlatformClient();
  await assertSafeTestDatabaseSentinel(client, requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL));
});
afterAll(async () => { client?.release(); await shutdownPlatformPool(); });
async function applyFeeSchemaInFixture() {
  const sql = readFileSync(new URL("../../../../db/migrations/067_payment_fee_components.sql", import.meta.url), "utf8");
  const ledger = await client.query("SELECT checksum FROM app.schema_migrations WHERE filename='067_payment_fee_components.sql'");
  if (ledger.rows.length === 0) await client.query(sql);
  else expect(ledger.rows).toEqual([{ checksum: createHash("sha256").update(sql).digest("hex") }]);
}
const tenders = [
  { method: "cod", status: "posted", verified: false }, { method: "cash", status: "posted", verified: false },
  { method: "bank_transfer", status: "pending", verified: false }, { method: "bank_transfer", status: "posted", verified: true },
] as const;

describe("calculator → original revision → initial charge on the same PostgreSQL transaction", () => {
  it.each((["sepay_va", "nowpayments"] as const).flatMap((provider) => [0, 2].map((feePercent) => ({ provider, feePercent }))))(
    "locked $provider settlement fee=$feePercent", async ({ provider, feePercent }) => {
      await client.query("BEGIN");
      try {
        await applyFeeSchemaInFixture();
        const orderId = `fee-provider-${randomUUID()}`, occurredAt = "2026-10-26T00:00:00.000Z";
        const intentId = `${orderId}:intent`, providerEventId = `${orderId}:provider-event`, configId = `${provider}:fixture-config`;
        await client.query(`INSERT INTO public."order"(id,currency_code,merchant_id,store_id)
          VALUES($1,'vnd','merchant_default','store_default')`, [orderId]);
        const commercialContext = { taxMode: "inclusive" as const, vatRatePpm: 100_000 };
        const totals = calculateOrderTotalsV2(240_000, { discountPercent: 10, paymentFeeType: "percent", paymentFeeValue: feePercent }, 20_000, commercialContext);
        const dependencies = { client, config: { enabled: true },
          transactionContext: { ownership: "caller" as const, orderCreatedInCurrentTransaction: true as const },
          repositoryOptions: { statementTimeoutMs: 10_000, lockTimeoutMs: 1_000 } };
        await recordOriginalOrderCommercialRevisionFromOrderCreateV2(dependencies, {
          merchantId: "merchant_default", storeId: "store_default", orderId, orderCreatedAt: occurredAt,
          currencyCode: "VND", minorUnitExponent: 0, commercialContext, totals,
          lines: [{ orderLineItemId: "provider-fixture-line", productId: "fixture-product", variantId: "fixture-variant",
            skuSnapshot: "FEE-PROVIDER", titleSnapshot: "Fee provider fixture", quantity: 1, unitPriceMinor: 240_000,
            unitCostMinor: 50_000, costEvidenceSource: "inventory.product_settings", costEvidenceUpdatedAt: occurredAt }],
        });
        const expectedTotal = feePercent === 2 ? 240_320 : 236_000;
        const crypto = provider === "nowpayments", providerAmount = crypto ? "5.000000" : String(expectedTotal);
        const providerCurrency = crypto ? "usdttrc20" : "vnd";
        await client.query(`INSERT INTO app.payment_intents
          (id,merchant_id,store_id,provider,status,amount,currency_code,order_input,reference_code,expires_at,
            metadata,created_by,business_purpose,provider_config_purpose,provider_config_id)
          VALUES($1,'merchant_default','store_default',$2,'paid',$3,'vnd','{}',$1,now()+interval '1 hour',
            $4::jsonb,'fixture-operator','retail_order','merchant_retail',$5)`,
        [intentId, provider, expectedTotal, JSON.stringify({ provider: { providerConfigPurpose: "merchant_retail", providerConfigId: configId,
          ...(crypto ? { expectedProviderAmount: providerAmount, expectedProviderCurrency: providerCurrency } : {}) } }), configId]);
        const verification = { authenticated: true, signatureAlgorithm: crypto ? "hmac-sha512" : "hmac-sha256",
          signedPayloadSha256: "a".repeat(64), rawBodyPreserved: !crypto, providerConfigPurpose: "merchant_retail", providerConfigId: configId,
          ...(crypto ? { terminal: true, paymentStatus: "finished" } : {}) };
        await client.query(`INSERT INTO app.payment_provider_events
          (merchant_id,store_id,provider,provider_event_id,payment_intent_id,event_type,amount,currency_code,status,payload)
          VALUES('merchant_default','store_default',$1,$2,$3,'fixture.provider.success',$4,$5,'received',$6::jsonb)`,
        [provider, providerEventId, intentId, providerAmount, providerCurrency, JSON.stringify({ _verification: verification, _normalized: {
          providerOccurredAt: occurredAt, direction: crypto ? null : "in", ...(crypto ? { grossQuantity: providerAmount,
            providerTransactionId: providerEventId, providerTransactionHash: "fixture-tx-hash", providerNetwork: "trc20", providerPayCurrency: providerCurrency } : {}) } })]);
        const input = { paymentIntentId: intentId, orderId, provider, providerEventId };
        const charge = await recordProviderInitialPostedChargeFromLockedStateV1(dependencies, input);
        expect(charge).toMatchObject({ kind: "recorded", outcome: "inserted", status: "posted", method: "provider", amountMinor: expectedTotal });
        expect(await recordProviderInitialPostedChargeFromLockedStateV1(dependencies, input)).toEqual({ ...charge, outcome: "replayed" });
        const stored = await client.query(`SELECT c.component_version,c.payment_fee_minor::text,c.payment_fee_vat_minor::text,e.status
          FROM app.payment_event_component_allocations c JOIN app.payment_events e ON e.id=c.payment_event_id WHERE e.order_id=$1`, [orderId]);
        expect(stored.rows).toEqual([{ component_version: 2, payment_fee_minor: feePercent === 2 ? "4320" : "0",
          payment_fee_vat_minor: feePercent === 2 ? "393" : "0", status: "posted" }]);
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      } finally { await client.query("ROLLBACK"); }
    },
  );
  it.each(tenders.flatMap((tender) => [0, 2].map((feePercent) => ({ ...tender, feePercent }))))(
    "$method $status fee=$feePercent", async ({ method, status, verified, feePercent }) => {
      await client.query("BEGIN");
      try {
        await applyFeeSchemaInFixture();
        const orderId = `fee-callers-${randomUUID()}`, occurredAt = "2026-10-26T00:00:00.000Z";
        await client.query(`INSERT INTO public."order"(id,currency_code,merchant_id,store_id)
          VALUES($1,'vnd','merchant_default','store_default')`, [orderId]);
        const commercialContext = { taxMode: "inclusive" as const, vatRatePpm: 100_000 };
        const totals = calculateOrderTotalsV2(240_000, { discountPercent: 10, paymentFeeType: "percent", paymentFeeValue: feePercent }, 20_000, commercialContext);
        const dependencies = { client, config: { enabled: true },
          transactionContext: { ownership: "caller" as const, orderCreatedInCurrentTransaction: true as const },
          repositoryOptions: { statementTimeoutMs: 10_000, lockTimeoutMs: 1_000 } };
        const originalInput = { merchantId: "merchant_default", storeId: "store_default", orderId, orderCreatedAt: occurredAt,
          currencyCode: "VND" as const, minorUnitExponent: 0 as const, commercialContext, totals,
          lines: [{ orderLineItemId: "fixture-line", productId: "fixture-product", variantId: "fixture-variant",
            skuSnapshot: "FEE-CALLER", titleSnapshot: "Fee caller fixture", quantity: 1, unitPriceMinor: 240_000,
            unitCostMinor: 50_000, costEvidenceSource: "inventory.product_settings" as const, costEvidenceUpdatedAt: occurredAt }],
        };
        const original = await recordOriginalOrderCommercialRevisionFromOrderCreateV2(dependencies, originalInput);
        if (!original.enabled) throw new Error("original writer must be enabled");
        expect(await recordOriginalOrderCommercialRevisionFromOrderCreateV2(dependencies, originalInput))
          .toEqual({ ...original, outcome: "replayed" });
        const expectedTotal = feePercent === 2 ? 240_320 : 236_000;
        const chargeInput = { merchantId: "merchant_default", storeId: "store_default", orderId, orderCreatedAt: occurredAt,
          commercialRevisionId: original.revisionId, commercialRevision: 0 as const, currencyCode: "VND" as const, minorUnitExponent: 0 as const,
          paymentMethod: method, amountReceivedMinor: method === "cash" ? 250_000 : 0, changeMinor: method === "cash" ? 250_000 - expectedTotal : 0,
          components: OrderCommercialComponentsV2Schema.parse({ taxMode: "inclusive", merchandiseGrossMinor: 240_000, discountMinor: 24_000,
            merchandiseNetMinor: 216_000, shippingMinor: 20_000, merchandiseVatMinor: 19_636, shippingVatMinor: 1_818,
            vatMinor: feePercent === 2 ? 21_847 : 21_454, unclassifiedMinor: 0, totalMinor: expectedTotal,
            paymentFeeMinor: feePercent === 2 ? 4_320 : 0, paymentFeeVatMinor: feePercent === 2 ? 393 : 0 }),
          ...(verified ? { manualBankConfirmation: { operatorId: "fixture-operator", policyVersion: 7, acknowledgmentVersion: 1 } } : {}),
        };
        const charge = await recordOrderCreatedPaymentChargeV2(dependencies, chargeInput);
        expect(charge).toMatchObject({ enabled: true, kind: "recorded", outcome: "inserted", status, amountMinor: expectedTotal });
        expect(await recordOrderCreatedPaymentChargeV2(dependencies, chargeInput)).toEqual({ ...charge, outcome: "replayed" });
        const projectionInput = { orderId, currencyCode: "VND", asOf: new Date(Date.now() + 60_000).toISOString(),
          scope: { scopeKind: "report" as const, merchantId: "merchant_default", storeIds: ["store_default"] } };
        const projection = await readEffectiveOrderV2(client, projectionInput);
        expect(projection).toMatchObject({ schemaVersion: 2, componentVersion: 2,
          components: chargeInput.components, currentOrderGrossValueMinor: expectedTotal });
        if (feePercent === 2) {
          await expect(readEffectiveOrderV1(client, projectionInput)).rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 });
        } else expect(await readEffectiveOrderV1(client, projectionInput)).toMatchObject({ schemaVersion: 1, currentOrderGrossValueMinor: expectedTotal });
        if (method === "cod") {
          const receiptRequest = { scope: projectionInput.scope, orderId };
          const receiptDependencies = { withClient: async <T>(read: (db: PoolClient) => Promise<T>) => read(client) };
          const detail = await getEffectiveOrderFeatureDetailV3(receiptRequest, undefined, receiptDependencies);
          expect(detail).toMatchObject({ schemaVersion: 3, componentVersion: 2,
            components: chargeInput.components, effectiveCommercialTotalMinor: expectedTotal,
            currentOrderGrossValueMinor: expectedTotal, effectiveItemQuantity: 1 });
          if (feePercent === 2) await expect(getEffectiveOrderFeatureDetailV2(receiptRequest, undefined, receiptDependencies))
            .rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 });
          else expect(await getEffectiveOrderFeatureDetailV2(receiptRequest, undefined, receiptDependencies))
            .toMatchObject({ schemaVersion: 2, effectiveCommercialTotalMinor: expectedTotal });
          const text = await getEffectiveOrderFeatureReceiptTextV1(receiptRequest, undefined, receiptDependencies);
          expect(text).toContain(`Payment surcharge: ${feePercent === 2 ? "4.320" : "0"} VND`);
          expect(text).toContain(`Order commercial total (VAT/fees included): ${feePercent === 2 ? "240.320" : "236.000"} VND`);
          if (feePercent === 2) expect((await getEffectiveOrderFeatureReceiptPdfV1(receiptRequest, undefined, receiptDependencies)).subarray(0, 4).toString()).toBe("%PDF");
          await expect(readEffectiveOrderV2(client, { ...projectionInput,
            scope: { ...projectionInput.scope, merchantId: "foreign-merchant" } })).rejects.toMatchObject({ code: "effective_order_data_quality" });
          await expect(readEffectiveOrderV2(client, { ...projectionInput, asOf: "2026-10-25T00:00:00.000Z" })).rejects.toMatchObject({ code: "effective_order_data_quality" });
        }
        const stored = await client.query(`SELECT e.status,e.amount_minor::text,c.component_version,c.payment_fee_minor::text,
          (SELECT count(*)::int FROM app.payment_event_evidence x WHERE x.payment_event_id=e.id) AS evidence_count,
          (SELECT count(*)::int FROM app.payment_event_allocations x WHERE x.payment_event_id=e.id) AS allocation_count
          FROM app.payment_events e JOIN app.payment_event_component_allocations c ON c.payment_event_id=e.id WHERE e.order_id=$1`, [orderId]);
        expect(stored.rows).toEqual([{ status, amount_minor: String(expectedTotal), component_version: 2,
          payment_fee_minor: feePercent === 2 ? "4320" : "0", evidence_count: status === "posted" ? 1 : 0,
          allocation_count: status === "posted" ? 1 : 0 }]);
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      } finally { await client.query("ROLLBACK"); }
    },
  );
});
