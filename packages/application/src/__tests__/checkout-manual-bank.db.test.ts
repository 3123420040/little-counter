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
import { calculateOrderTotalsV2 } from "../services/order-total-service";
import { recordOriginalOrderCommercialRevisionFromOrderCreateV2 } from "../services/original-order-commercial-revision-caller";
import { recordOrderCreatedPaymentChargeV2 } from "../services/order-created-payment-charge-caller";
import { confirmInitialManualBankPaymentWithClientV1 } from "../services/manual-bank-confirmation-service";
import type { OperatorContext } from "../services/auth-service";
import { OrderCommercialComponentsV2Schema } from "@medusa-snus/contracts";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 } from "@medusa-snus/contracts/runtime-capabilities";
import {
  completeSale,
  refundOrder,
  cancelOrder,
  quoteOrderCancellation,
  quoteSaleForClient,
  previewOrderShippingFee,
  updateOrderShippingFee,
  type SaleInput,
} from "../services/order-service";
import { createProduct } from "../services/product-management-service";
import {
  createPaymentIntent,
  settleMockPaymentIntent,
  handleProviderPaymentEvent,
  cancelPaymentIntent,
} from "../services/payment-intent-service";
import { processExactOutboxEvent } from "../services/outbox-processor-service";
import { getIncomeStatement } from "../services/accounting-service";
import type { ChannelActor } from "../services/channel-auth-service";
import { createCorrectionCommercialRevisionTaskV2 } from "../services/correction-commercial-revision-service";
import { PostgresCorrectionCommercialRevisionRepositoryV1 } from "../services/postgres-correction-commercial-revision-repository";
import { buildPositiveCorrectionChargeContractV2 } from "../services/payment-positive-correction-charge-contract";
import { recordPositiveCorrectionChargeV1 } from "../services/postgres-positive-correction-charge-repository";
import { confirmCorrectionManualBankPaymentWithClientV1 } from "../services/manual-bank-correction-confirmation-service";
import {
  previewOrderCorrection,
  applyOrderCorrection,
} from "../services/order-correction-service";

const runId = randomUUID(),
  merchantId = `merchant-fee-confirm-${runId}`,
  storeId = `store-fee-confirm-${runId}`;
const organizationId = `org-fee-confirm-${runId}`,
  operatorId = `operator-fee-confirm-${runId}`;
const scope = {
  scopeKind: "operating" as const,
  merchantId,
  storeId,
  stockLocationId: `sloc-fee-confirm-${runId}`,
};
const actor: OperatorContext = {
  operatorId,
  organizationId,
  role: "accountant",
  displayName: "Fee confirmation UAT",
};
const ownerActor: OperatorContext = {
  ...actor,
  operatorId: `${operatorId}:owner`,
  role: "owner",
};
const occurredAt = "2026-10-26T00:00:00.000Z",
  confirmedAt = "2026-10-26T00:01:00.000Z";
let client: PoolClient;
let variantId: string;
let inventoryItemId: string;

beforeAll(async () => {
  client = await connectPlatformClient();
  await assertSafeTestDatabaseSentinel(
    client,
    requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL),
  );
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
  expect(ledger.rows).toEqual([
    { checksum: createHash("sha256").update(sql).digest("hex") },
  ]);
  await client.query(
    "INSERT INTO app.merchants(id,display_name,legacy_organization_id,status) VALUES($1,'Fee confirmation UAT',$2,'active')",
    [merchantId, organizationId],
  );
  await client.query(
    "INSERT INTO public.stock_location(id,name) VALUES($1,'Fee confirmation UAT')",
    [scope.stockLocationId],
  );
  await client.query(
    "INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,is_primary,status) VALUES($1,$2,'UAT',$3,true,'active')",
    [storeId, merchantId, scope.stockLocationId],
  );
  await client.query(
    `INSERT INTO medusa.staff_users(operator_id,password_hash,display_name,role,organization_id,is_active)
    VALUES($1,'not-a-live-password-hash','Fee confirmation UAT','accountant',$2,true)`,
    [operatorId, organizationId],
  );
  await client.query(
    `INSERT INTO app.operator_memberships(operator_id,scope_type,merchant_id,role_key,status,granted_by)
    VALUES($1,'merchant',$2,'accountant','active','UAT')`,
    [operatorId, merchantId],
  );
  await client.query(
    `INSERT INTO medusa.staff_users(operator_id,password_hash,display_name,role,organization_id,is_active)
    VALUES($1,'not-a-live-password-hash','Fee cancellation UAT','owner',$2,true)`,
    [ownerActor.operatorId, organizationId],
  );
  await client.query(
    `INSERT INTO app.operator_memberships(operator_id,scope_type,merchant_id,role_key,status,granted_by)
    VALUES($1,'merchant',$2,'owner','active','UAT')`,
    [ownerActor.operatorId, merchantId],
  );
  const product = await createProduct(
    { "idempotency-key": `${runId}:product` },
    {
      title: `Fee checkout ${runId}`,
      status: "published",
      sku: `FEE-CHECKOUT-${runId}`,
      price: 240_000,
      costPrice: 50_000,
      reorderLevel: 2,
      categoryIds: [],
    },
    actor,
    { scopeKind: "merchant_target", merchantId },
    scope,
  );
  variantId = product.response.product.variants[0].id;
  inventoryItemId = (
    await client.query(
      `SELECT inventory_item_id FROM public.product_variant_inventory_item WHERE variant_id=$1 AND deleted_at IS NULL`,
      [variantId],
    )
  ).rows[0].inventory_item_id;
  await client.query(
    `UPDATE public.inventory_level SET stocked_quantity=100 WHERE inventory_item_id=$1 AND location_id=$2`,
    [inventoryItemId, scope.stockLocationId],
  );
});
afterAll(async () => {
  client?.release();
  await shutdownPlatformPool();
});

async function createPending(feePercent: 0 | 2 = 2) {
  const orderId = `order-fee-confirm-${randomUUID()}`,
    expectedTotal = feePercent === 2 ? 240_320 : 236_000;
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO public."order"(id,status,currency_code,merchant_id,store_id) VALUES($1,'completed','vnd',$2,$3)`,
      [orderId, merchantId, storeId],
    );
    const context = { taxMode: "inclusive" as const, vatRatePpm: 100_000 };
    const totals = calculateOrderTotalsV2(
      240_000,
      {
        discountPercent: 10,
        paymentFeeType: "percent",
        paymentFeeValue: feePercent,
      },
      20_000,
      context,
    );
    const deps = {
      client,
      config: { enabled: true },
      transactionContext: {
        ownership: "caller" as const,
        orderCreatedInCurrentTransaction: true as const,
      },
      repositoryOptions: { statementTimeoutMs: 10_000, lockTimeoutMs: 1_000 },
    };
    const original =
      await recordOriginalOrderCommercialRevisionFromOrderCreateV2(deps, {
        merchantId,
        storeId,
        orderId,
        orderCreatedAt: occurredAt,
        currencyCode: "VND",
        minorUnitExponent: 0,
        commercialContext: context,
        totals,
        lines: [
          {
            orderLineItemId: `${orderId}:line`,
            productId: "fixture-product",
            variantId: "fixture-variant",
            skuSnapshot: "FEE-CONFIRM",
            titleSnapshot: "Fee confirmation",
            quantity: 1,
            unitPriceMinor: 240_000,
            unitCostMinor: 50_000,
            costEvidenceSource: "inventory.product_settings",
            costEvidenceUpdatedAt: occurredAt,
          },
        ],
      });
    if (!original.enabled) throw new Error("original writer must be enabled");
    const pending = await recordOrderCreatedPaymentChargeV2(deps, {
      merchantId,
      storeId,
      orderId,
      orderCreatedAt: occurredAt,
      commercialRevisionId: original.revisionId,
      commercialRevision: 0,
      currencyCode: "VND",
      minorUnitExponent: 0,
      paymentMethod: "bank_transfer",
      amountReceivedMinor: 0,
      changeMinor: 0,
      components: OrderCommercialComponentsV2Schema.parse({
        taxMode: "inclusive",
        merchandiseGrossMinor: 240_000,
        discountMinor: 24_000,
        merchandiseNetMinor: 216_000,
        shippingMinor: 20_000,
        merchandiseVatMinor: 19_636,
        shippingVatMinor: 1_818,
        vatMinor: feePercent === 2 ? 21_847 : 21_454,
        unclassifiedMinor: 0,
        totalMinor: expectedTotal,
        paymentFeeMinor: feePercent === 2 ? 4_320 : 0,
        paymentFeeVatMinor: feePercent === 2 ? 393 : 0,
      }),
    });
    expect(pending).toMatchObject({
      status: "pending",
      amountMinor: expectedTotal,
    });
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return {
    orderId,
    expectedTotal,
    headers: { "idempotency-key": `${orderId}:confirm` },
    body: { sourceReference: `${orderId}:bank-slip`, confirmedAt },
  };
}
async function counts(orderId: string) {
  return (
    await client.query(
      `SELECT
    (SELECT count(*)::int FROM app.payment_events WHERE order_id=$1 AND status='posted') AS posted,
    (SELECT count(*)::int FROM audit.events WHERE subject_id=$1 AND action='payment.manual_bank_confirmed') AS audits,
    (SELECT count(*)::int FROM app.payment_event_allocations a JOIN app.payment_events e ON e.id=a.payment_event_id WHERE e.order_id=$1) AS allocations`,
      [orderId],
    )
  ).rows[0];
}

describe("committed V2 manual bank confirmation", () => {
  it("does not hold lifecycle locks while waiting for a Telegram checkout advisory lock", async () => {
    const originalPackage = process.env.APP_PACKAGE_KEY, originalSepay = process.env.SEPAY_PAYMENTS_ENABLED;
    process.env.APP_PACKAGE_KEY = "plus"; process.env.SEPAY_PAYMENTS_ENABLED = "true";
    const draftId = randomUUID(), key = `telegram_sales_confirm:${draftId}`;
    const statusWriter = await connectPlatformClient();
    let settlement: Promise<unknown> | undefined;
    try {
      const intent = await createPaymentIntent({ "idempotency-key": `${runId}:telegram-lock` }, {
        provider: "sepay_va", order: { items: [{ variantId, quantity: 1 }], customerMode: "walk_in",
          paymentMethod: "sepay_va", amountReceived: 0, telegramSalesDraftId: draftId },
      }, actor, scope);
      const ownerPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
      settlement = handleProviderPaymentEvent({ provider: "sepay_va", providerEventId: `${runId}:telegram-lock-event`,
        eventType: "sepay.transaction", amount: 240_000, currencyCode: "vnd", referenceCode: intent.response.data.referenceCode,
        direction: "in", verification: { authenticated: true, signatureAlgorithm: "api-key", payloadSha256: "d".repeat(64),
          providerConfigPurpose: "merchant_retail", providerConfigId: "local_merchant_retail" } });
      const deadline = Date.now() + 2_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        waiting = (await client.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event='advisory') AS waiting", [ownerPid])).rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await statusWriter.query("BEGIN; SET LOCAL lock_timeout='250ms'");
      await statusWriter.query("UPDATE app.merchants SET status='suspended',status_version=status_version+1,status_changed_at=clock_timestamp() WHERE id=$1", [merchantId]);
      await statusWriter.query("COMMIT");
    } finally {
      await statusWriter.query("ROLLBACK"); statusWriter.release();
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
      if (settlement) await settlement;
      await client.query("UPDATE app.merchants SET status='active' WHERE id=$1", [merchantId]);
      if (originalPackage === undefined) delete process.env.APP_PACKAGE_KEY; else process.env.APP_PACKAGE_KEY = originalPackage;
      if (originalSepay === undefined) delete process.env.SEPAY_PAYMENTS_ENABLED; else process.env.SEPAY_PAYMENTS_ENABLED = originalSepay;
    }
  });

  it.each(["cancel", "mock-settle"] as const)("denies ordinary %s intent commands after suspension", async command => {
    const originalPackage = process.env.APP_PACKAGE_KEY;
    process.env.APP_PACKAGE_KEY = "plus";
    try {
      const intent = await createPaymentIntent({ "idempotency-key": `${runId}:inactive-command:${command}` }, {
        provider: "mock", order: { items: [{ variantId, quantity: 1 }], customerMode: "walk_in",
          paymentMethod: "mock", amountReceived: 0 },
      }, actor, scope);
      await client.query("UPDATE app.merchants SET status='suspended',status_version=status_version+1,status_changed_at=clock_timestamp() WHERE id=$1", [merchantId]);
      const operation = command === "cancel" ? cancelPaymentIntent : settleMockPaymentIntent;
      await expect(operation({ "idempotency-key": `${runId}:inactive-command-execute:${command}` }, intent.response.data.id, actor, scope))
        .rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
      expect((await client.query("SELECT status,completed_order_id FROM app.payment_intents WHERE id=$1", [intent.response.data.id])).rows[0])
        .toEqual({ status: "pending", completed_order_id: null });
    } finally {
      await client.query("UPDATE app.merchants SET status='active' WHERE id=$1", [merchantId]);
      if (originalPackage === undefined) delete process.env.APP_PACKAGE_KEY; else process.env.APP_PACKAGE_KEY = originalPackage;
    }
  });

  it.each([
    "merchant-null-time", "merchant-equal-time", "merchant-before-time", "merchant-closed",
    "store-null-time", "store-equal-time", "store-before-time", "store-closed",
    "unauthenticated", "wrong-config", "invalid-digest", "hmac-without-body", "quote-mismatch", "provenance-mismatch", "stock-shortage",
  ])("preserves provider evidence without commerce for %s", async scenario => {
    const originalPackage = process.env.APP_PACKAGE_KEY, originalSepay = process.env.SEPAY_PAYMENTS_ENABLED;
    process.env.APP_PACKAGE_KEY = "plus"; process.env.SEPAY_PAYMENTS_ENABLED = "true";
    const beforeStock = Number((await client.query("SELECT stocked_quantity FROM public.inventory_level WHERE inventory_item_id=$1 AND location_id=$2", [inventoryItemId, scope.stockLocationId])).rows[0].stocked_quantity);
    try {
      const intent = await createPaymentIntent({ "idempotency-key": `${runId}:invalid-provider:${scenario}` }, {
        provider: "sepay_va", order: { items: [{ variantId, quantity: 1 }], customerMode: "walk_in",
          paymentMethod: "sepay_va", amountReceived: 0, paymentFeeType: "amount", paymentFeeValue: 2_000 },
      }, actor, scope);
      const entity = scenario.startsWith("store-") ? "stores" : "merchants";
      const entityId = entity === "stores" ? storeId : merchantId;
      await client.query(`UPDATE app.${entity} SET status='suspended',status_version=status_version+1,status_changed_at=clock_timestamp() WHERE id=$1`, [entityId]);
      if (scenario.endsWith("-null-time")) await client.query(`UPDATE app.${entity} SET status_changed_at=NULL WHERE id=$1`, [entityId]);
      if (scenario.endsWith("-equal-time") || scenario.endsWith("-before-time")) {
        await client.query(`UPDATE app.${entity} SET status_changed_at=(SELECT created_at FROM app.payment_intents WHERE id=$2) - $3::interval WHERE id=$1`,
          [entityId, intent.response.data.id, scenario.endsWith("-before-time") ? "1 microsecond" : "0 microseconds"]);
      }
      if (scenario.endsWith("-closed")) await client.query(`UPDATE app.${entity} SET status='closed' WHERE id=$1`, [entityId]);
      if (scenario === "quote-mismatch") await client.query("UPDATE app.payment_intents SET metadata=jsonb_set(metadata,'{quote,totals,total}','1') WHERE id=$1", [intent.response.data.id]);
      if (scenario === "provenance-mismatch") await client.query("UPDATE app.payment_intents SET metadata=jsonb_set(metadata,'{provenance,merchantId}','\"foreign-merchant\"') WHERE id=$1", [intent.response.data.id]);
      if (scenario === "stock-shortage") await client.query("UPDATE public.inventory_level SET stocked_quantity=0 WHERE inventory_item_id=$1 AND location_id=$2", [inventoryItemId, scope.stockLocationId]);
      const verification = { authenticated: scenario !== "unauthenticated", signatureAlgorithm: scenario === "hmac-without-body" ? "hmac-sha256" : "api-key",
        payloadSha256: scenario === "invalid-digest" ? "bad" : "c".repeat(64), providerConfigPurpose: "merchant_retail",
        providerConfigId: scenario === "wrong-config" ? "foreign-config" : "local_merchant_retail" };
      const event = { provider: "sepay_va" as const, providerEventId: `${runId}:invalid-provider-event:${scenario}`,
        eventType: "sepay.transaction", amount: 242_000, currencyCode: "vnd", referenceCode: intent.response.data.referenceCode,
        direction: "in" as const, providerTransactionId: `${runId}:invalid-bank:${scenario}`, verification };
      const result = await handleProviderPaymentEvent(event);
      expect(result.data).toMatchObject({ status: "manual_review", completedOrderId: null,
        manualReviewReason: scenario === "stock-shortage" ? "stock_unavailable_after_payment"
          : scenario === "quote-mismatch" ? "payment_intent_quote_invalid" : "payment_intent_lifecycle_invalid" });
      expect((await client.query("SELECT status,error,payload FROM app.payment_provider_events WHERE provider='sepay_va' AND provider_event_id=$1", [event.providerEventId])).rows[0])
        .toMatchObject({ status: "manual_review", payload: { _verification: verification } });
      expect((await client.query("SELECT count(*)::int AS count FROM public.\"order\" WHERE metadata->>'paymentIntentId'=$1", [intent.response.data.id])).rows[0].count).toBe(0);
      expect(Number((await client.query("SELECT stocked_quantity FROM public.inventory_level WHERE inventory_item_id=$1 AND location_id=$2", [inventoryItemId, scope.stockLocationId])).rows[0].stocked_quantity))
        .toBe(scenario === "stock-shortage" ? 0 : beforeStock);
      expect((await handleProviderPaymentEvent(event)).data).toMatchObject({ status: "manual_review", completedOrderId: null });
    } finally {
      await client.query("UPDATE app.merchants SET status='active' WHERE id=$1", [merchantId]);
      await client.query("UPDATE app.stores SET status='active' WHERE id=$1", [storeId]);
      await client.query("UPDATE public.inventory_level SET stocked_quantity=$3 WHERE inventory_item_id=$1 AND location_id=$2", [inventoryItemId, scope.stockLocationId, beforeStock]);
      if (originalPackage === undefined) delete process.env.APP_PACKAGE_KEY; else process.env.APP_PACKAGE_KEY = originalPackage;
      if (originalSepay === undefined) delete process.env.SEPAY_PAYMENTS_ENABLED; else process.env.SEPAY_PAYMENTS_ENABLED = originalSepay;
    }
  });

  it.each(["merchant", "store", "both", "db-microsecond"] as const)("settles a verified fee-bearing prior intent after %s suspension exactly once", async entity => {
    const originalPackage = process.env.APP_PACKAGE_KEY, originalSepay = process.env.SEPAY_PAYMENTS_ENABLED;
    process.env.APP_PACKAGE_KEY = "plus"; process.env.SEPAY_PAYMENTS_ENABLED = "true";
    try {
      const intent = await createPaymentIntent({ "idempotency-key": `${runId}:suspended-provider:${entity}` }, {
        provider: "sepay_va", order: { items: [{ variantId, quantity: 1 }], customerMode: "walk_in",
          paymentMethod: "sepay_va", amountReceived: 0, discountPercent: 10, shippingFee: 20_000,
          paymentFeeType: "percent", paymentFeeValue: 2 },
      }, actor, scope);
      if (entity === "db-microsecond") {
        await client.query("UPDATE app.merchants SET status='suspended',status_version=status_version+1,status_changed_at=(SELECT created_at FROM app.payment_intents WHERE id=$2)+interval '1 microsecond' WHERE id=$1", [merchantId, intent.response.data.id]);
      } else {
        if (entity !== "store") await client.query("UPDATE app.merchants SET status='suspended',status_version=status_version+1,status_changed_at=clock_timestamp() WHERE id=$1", [merchantId]);
        if (entity !== "merchant") await client.query("UPDATE app.stores SET status='suspended',status_version=status_version+1,status_changed_at=clock_timestamp() WHERE id=$1", [storeId]);
      }
      const event = { provider: "sepay_va" as const, providerEventId: `${runId}:suspended-provider-event:${entity}`,
        eventType: "sepay.transaction", amount: 240_320, currencyCode: "vnd", referenceCode: intent.response.data.referenceCode,
        direction: "in" as const, providerTransactionId: `${runId}:bank:${entity}`, verification: {
          authenticated: true, signatureAlgorithm: "api-key", payloadSha256: "b".repeat(64),
          providerConfigPurpose: "merchant_retail", providerConfigId: "local_merchant_retail",
        } };
      const result = await handleProviderPaymentEvent(event);
      expect(result.data).toMatchObject({ status: "completed", amount: 240_320, completedOrderId: expect.any(String) });
      const replay = await handleProviderPaymentEvent(event);
      expect(replay.data).toMatchObject({ status: "completed", completedOrderId: result.data.completedOrderId });
      expect((await client.query("SELECT count(*)::int AS count FROM app.payment_events WHERE order_id=$1 AND kind='charge' AND status='posted'", [result.data.completedOrderId])).rows[0].count).toBe(1);
    } finally {
      await client.query("UPDATE app.merchants SET status='active' WHERE id=$1", [merchantId]);
      await client.query("UPDATE app.stores SET status='active' WHERE id=$1", [storeId]);
      if (originalPackage === undefined) delete process.env.APP_PACKAGE_KEY; else process.env.APP_PACKAGE_KEY = originalPackage;
      if (originalSepay === undefined) delete process.env.SEPAY_PAYMENTS_ENABLED; else process.env.SEPAY_PAYMENTS_ENABLED = originalSepay;
    }
  });
  it.each(["percent", "amount"] as const)(
    "shipping adjustment keeps %s fee basis and invalidates a preview after fee changes",
    async (paymentFeeType) => {
      const sale = await completeSale(
        { "idempotency-key": `${runId}:shipping-fee-sale:${paymentFeeType}` },
        {
          items: [{ variantId, quantity: 1 }],
          customerMode: "walk_in",
          paymentMethod: "cash",
          amountReceived: 250_000,
          discountPercent: 10,
          shippingFee: 20_000,
          paymentFeeType,
          paymentFeeValue: paymentFeeType === "percent" ? 2 : 4_320,
        },
        ownerActor,
        scope,
      );
      const orderId = String(sale.response.data.id);
      const body = {
        shippingFee: 10_000,
        reason: "UAT shipping fee-only decrease",
        paymentMethod: "bank_transfer",
      };
      const preview = await previewOrderShippingFee(
        orderId,
        body,
        ownerActor,
        scope,
      );
      expect(preview.data).toMatchObject({
        totalDelta: -10_000,
        before: { shippingFee: 20_000, total: 240_320 },
        after: { shippingFee: 10_000, total: 230_320 },
      });
      const changed = await updateOrderShippingFee(
        { "idempotency-key": `${runId}:shipping-fee-change:${paymentFeeType}` },
        orderId,
        { ...body, confirmationToken: preview.data.confirmationToken },
        ownerActor,
        scope,
      );
      expect(changed.response.order).toMatchObject({
        total: 230_320,
        shippingFee: 10_000,
      });
      const snapshots = await client.query(
        `SELECT component_version,payment_fee_minor::text,payment_fee_vat_minor::text,
      merchandise_net_minor::text,shipping_minor::text FROM app.order_commercial_revision_components WHERE order_id=$1 ORDER BY revision`,
        [orderId],
      );
      expect(snapshots.rows).toEqual([
        {
          component_version: 2,
          payment_fee_minor: "4320",
          payment_fee_vat_minor: "393",
          merchandise_net_minor: "216000",
          shipping_minor: "20000",
        },
        {
          component_version: 2,
          payment_fee_minor: "4320",
          payment_fee_vat_minor: "393",
          merchandise_net_minor: "216000",
          shipping_minor: "10000",
        },
      ]);
      const stale = await previewOrderShippingFee(
        orderId,
        { ...body, shippingFee: 9_000 },
        ownerActor,
        scope,
      );
      await applyOrderCorrection(
        {
          "idempotency-key": `${runId}:change-fee-after-shipping-preview:${paymentFeeType}`,
        },
        orderId,
        {
          baseRevision: 1,
          reason: "UAT change fee while shipping preview waits",
          items: [{ variantId, quantity: 1 }],
          paymentFeeType: "amount",
          paymentFeeValue: 4_420,
          settlement: { method: "cash", amountReceived: 100 },
        },
        ownerActor,
        scope,
        PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
      );
      await expect(
        updateOrderShippingFee(
          { "idempotency-key": `${runId}:stale-shipping:${paymentFeeType}` },
          orderId,
          {
            ...body,
            shippingFee: 9_000,
            confirmationToken: stale.data.confirmationToken,
          },
          ownerActor,
          scope,
        ),
      ).rejects.toMatchObject({ code: "shipping_preview_stale" });
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM app.order_commercial_revisions WHERE order_id=$1`,
            [orderId],
          )
        ).rows[0].count,
      ).toBe(3);
    },
  );

  it("waits for every monetary correction before canceling, then clears mixed payables exactly once", async () => {
    const stockBefore = String(
      (
        await client.query(
          `SELECT stocked_quantity FROM public.inventory_level WHERE inventory_item_id=$1 AND location_id=$2`,
          [inventoryItemId, scope.stockLocationId],
        )
      ).rows[0].stocked_quantity,
    );
    const sale = await completeSale(
      { "idempotency-key": `${runId}:multi-correction-sale` },
      {
        items: [{ variantId, quantity: 1 }],
        customerMode: "walk_in",
        paymentMethod: "cash",
        amountReceived: 250_000,
        discountPercent: 10,
        shippingFee: 20_000,
        paymentFeeType: "percent",
        paymentFeeValue: 2,
      },
      ownerActor,
      scope,
    );
    const orderId = String(sale.response.data.id),
      correctionIds: string[] = [];
    const drafts = [
      {
        baseRevision: 0,
        items: [{ variantId, quantity: 2 }],
        shippingFee: 10_000,
        settlement: { method: "cash", amountReceived: 210_320 },
      },
      {
        baseRevision: 1,
        items: [{ variantId, quantity: 2 }],
        shippingFee: 9_000,
        paymentFeeType: "amount" as const,
        paymentFeeValue: 9_640,
        settlement: { method: "cash", amountReceived: 0 },
      },
      {
        baseRevision: 2,
        items: [{ variantId, quantity: 2 }],
        shippingFee: 5_000,
        settlement: { method: "bank_transfer", amountReceived: 4_000 },
      },
    ];
    for (let index = 0; index < drafts.length; index++) {
      const applied = await applyOrderCorrection(
        { "idempotency-key": `${runId}:multi-correction:${index}` },
        orderId,
        {
          ...drafts[index]!,
          reason: `UAT multiple financial corrections ${index}`,
        },
        ownerActor,
        scope,
        PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
      );
      correctionIds.push(applied.response.data.correction.id);
      expect(applied.response.data.correction.totalDelta).toBe(
        [210_320, 0, -4_000][index],
      );
    }
    const events = (
      await client.query<{
        id: string;
        event_type: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT id::text,event_type,payload FROM outbox.events
      WHERE aggregate_id=$1 AND event_type IN('sale.created','order.corrected') ORDER BY aggregate_sequence`,
        [orderId],
      )
    ).rows;
    const run = (event: (typeof events)[number]) =>
      processExactOutboxEvent({
        id: event.id,
        eventType: event.event_type,
        payload: event.payload,
      });
    const original = events.find(
      (event) => event.event_type === "sale.created",
    )!;
    const first = events.find(
      (event) => event.payload.correctionId === correctionIds[0],
    )!;
    const zero = events.find(
      (event) => event.payload.correctionId === correctionIds[1],
    )!;
    const negative = events.find(
      (event) => event.payload.correctionId === correctionIds[2],
    )!;
    expect(events).toHaveLength(4);
    expect(zero.payload).toMatchObject({
      totalDelta: 0,
      beforeTotals: { paymentFeeMinor: 8_640 },
      afterTotals: { paymentFeeMinor: 9_640, paymentFeeType: "amount" },
    });
    expect(negative.payload).toMatchObject({
      afterTotals: {
        paymentFeeMinor: 9_640,
        paymentFeeBasisMinor: 432_000,
        total: 446_640,
      },
    });
    await run(original);
    await run(first);
    await run(negative);
    const { quote } = await quoteOrderCancellation(orderId, scope, ownerActor);
    const cancellation = await cancelOrder(
      { "idempotency-key": `${runId}:multi-correction-cancel` },
      orderId,
      {
        reason: "UAT cancel after several corrections",
        quoteId: quote.quoteId,
        effectiveRevision: quote.effectiveRevision,
        quoteGeneratedAt: quote.generatedAt,
      },
      ownerActor,
      scope,
    );
    expect(cancellation.response.financial.customerRefundPayableMinor).toBe(
      446_640,
    );
    const cancellationEvent = (
      await client.query<{
        id: string;
        event_type: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT id::text,event_type,payload FROM outbox.events
      WHERE aggregate_id=$1 AND event_type='sale.cancelled'`,
        [orderId],
      )
    ).rows[0]!;
    await expect(run(cancellationEvent)).rejects.toThrow(
      "waiting for correction accounting",
    );
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM accounting.journal_entries WHERE reference_type='order_cancellation' AND reference_id=$1`,
          [orderId],
        )
      ).rows[0].count,
    ).toBe(0);
    await run(zero);
    await run(cancellationEvent);
    await run(cancellationEvent);
    const payout = await refundOrder(
      { "idempotency-key": `${runId}:multi-correction-final-payout` },
      orderId,
      {
        method: "cash",
        reason: "UAT settle every outstanding customer payable",
        confirmationToken: String(sale.response.data.orderNumber),
      },
      ownerActor,
      scope,
    );
    expect(payout.response.data.amount).toBe(450_640);
    const frozen = (
      await client.query(
        `SELECT metadata FROM app.payment_events WHERE id=$1`,
        [payout.response.data.canonicalPaymentEventId],
      )
    ).rows[0].metadata.refundAllocationV2;
    expect(frozen).toMatchObject({
      settlementOnlyMinor: 450_640,
      payableAllocations: [
        { payableKind: "negative_correction", amountMinor: 4_000 },
        { payableKind: "order_cancellation", amountMinor: 446_640 },
      ],
    });
    const refund = (
      await client.query<{
        id: string;
        event_type: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT id::text,event_type,payload FROM outbox.events
      WHERE aggregate_id=$1 AND event_type='refund.created'`,
        [orderId],
      )
    ).rows[0]!;
    await run(refund);
    await run(refund);
    const balances = await client.query(
      `SELECT a.code,sum(l.debit_amount-l.credit_amount)::numeric AS net
      FROM accounting.journal_entries j JOIN accounting.journal_lines l ON l.journal_entry_id=j.id JOIN accounting.accounts a ON a.id=l.account_id
      WHERE (j.reference_type IN('order','order_cancellation') AND j.reference_id=$1)
        OR(j.reference_type='order_correction' AND j.reference_id=ANY($2::text[]))
        OR(j.reference_type='customer_refund_payout' AND j.reference_id=$3)
      GROUP BY a.code ORDER BY a.code`,
      [orderId, correctionIds, payout.response.data.canonicalPaymentEventId],
    );
    expect(
      balances.rows.map((row) => ({ code: row.code, net: Number(row.net) })),
    ).toEqual(
      [
        "1111",
        "1561",
        "3331",
        "5111",
        "5112",
        "5113",
        "6321",
        "CUSTOMER_REFUND_PAYABLE",
      ].map((code) => ({ code, net: 0 })),
    );
    expect(
      String(
        (
          await client.query(
            `SELECT stocked_quantity FROM public.inventory_level WHERE inventory_item_id=$1 AND location_id=$2`,
            [inventoryItemId, scope.stockLocationId],
          )
        ).rows[0].stocked_quantity,
      ),
    ).toBe(stockBefore);
    expect(
      (
        await client.query(
          `SELECT sum(balance_minor)::text AS balance FROM app.customer_refund_payable_balances WHERE order_id=$1`,
          [orderId],
        )
      ).rows[0].balance,
    ).toBe("0");
  });

  it("adds a fee to a V1 order only with compatible canonical VAT, keeping all original facts unchanged", async () => {
    const headers = { "idempotency-key": `${runId}:legacy-sale-before-fee` };
    const input: SaleInput = {
      items: [{ variantId, quantity: 1 }],
      customerMode: "walk_in",
      paymentMethod: "cash",
      amountReceived: 250_000,
      discountPercent: 10,
      shippingFee: 20_000,
    };
    const sale = await completeSale(headers, input, ownerActor, scope),
      orderId = String(sale.response.data.id);
    const original = (
      await client.query(
        `SELECT to_jsonb(r) AS revision,to_jsonb(c) AS components FROM app.order_commercial_revisions r
      JOIN app.order_commercial_revision_components c ON c.revision_id=r.id WHERE r.order_id=$1 AND r.revision=0`,
        [orderId],
      )
    ).rows[0];
    expect(original.components.component_version).toBe(1);
    const correction = {
      baseRevision: 0,
      reason: "UAT add payment fee to legacy order",
      items: [{ variantId, quantity: 1 }],
      paymentFeeType: "percent" as const,
      paymentFeeValue: 2,
      settlement: { method: "cash", amountReceived: 4_320 },
    };
    const correctionHeaders = {
      "idempotency-key": `${runId}:legacy-first-fee`,
    };
    const previousVat = process.env.VAT_RATE;
    try {
      process.env.VAT_RATE = "0";
      await expect(
        applyOrderCorrection(
          correctionHeaders,
          orderId,
          correction,
          ownerActor,
          scope,
          PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
        ),
      ).rejects.toMatchObject({ code: "financial_invariant_error" });
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM app.order_commercial_revisions WHERE order_id=$1`,
            [orderId],
          )
        ).rows[0].count,
      ).toBe(1);
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM app.order_corrections WHERE order_id=$1`,
            [orderId],
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      if (previousVat === undefined) delete process.env.VAT_RATE;
      else process.env.VAT_RATE = previousVat;
    }
    const preview = await previewOrderCorrection(
      orderId,
      correction,
      ownerActor,
      scope,
      PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
    );
    expect(preview.data).toMatchObject({
      totalDelta: 4_320,
      beforeFinancial: { components: { paymentFeeMinor: 0, totalMinor: 236_000 } },
      afterFinancial: { components: { paymentFeeMinor: 4320, totalMinor: 240_320 } },
      beforeTotals: {
        commercialCalculationVersion: 2,
        paymentFeeMinor: 0,
        total: 236_000,
      },
      afterTotals: {
        paymentFeeMinor: 4_320,
        paymentFeeVatMinor: 393,
        total: 240_320,
        vatRatePpm: 100_000,
      },
    });
    await applyOrderCorrection(
      correctionHeaders,
      orderId,
      correction,
      ownerActor,
      scope,
      PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
    );
    const after = (
      await client.query(
        `SELECT to_jsonb(r) AS revision,to_jsonb(c) AS components FROM app.order_commercial_revisions r
      JOIN app.order_commercial_revision_components c ON c.revision_id=r.id WHERE r.order_id=$1 AND r.revision=0`,
        [orderId],
      )
    ).rows[0];
    expect(after).toEqual(original);
    expect(
      (await completeSale(headers, input, ownerActor, scope)).response,
    ).toEqual(JSON.parse(JSON.stringify(sale.response)));
    expect(
      (
        await client.query(
          `SELECT component_version,payment_fee_minor::text FROM app.order_commercial_revision_components WHERE order_id=$1 ORDER BY revision`,
          [orderId],
        )
      ).rows,
    ).toEqual([
      { component_version: 1, payment_fee_minor: "0" },
      { component_version: 2, payment_fee_minor: "4320" },
    ]);
  });

  it("actual negative fee correction opens a payable and payout never reverses fee twice", async () => {
    const sale = await completeSale(
      { "idempotency-key": `${runId}:negative-fee-sale` },
      {
        items: [{ variantId, quantity: 1 }],
        customerMode: "walk_in",
        paymentMethod: "cash",
        amountReceived: 250_000,
        discountPercent: 10,
        shippingFee: 20_000,
        paymentFeeType: "percent",
        paymentFeeValue: 2,
      },
      ownerActor,
      scope,
    );
    const orderId = String(sale.response.data.id);
    const input = {
      baseRevision: 0,
      reason: "UAT reduce customer payment fee",
      items: [{ variantId, quantity: 1 }],
      paymentFeeType: "amount" as const,
      paymentFeeValue: 2_000,
      settlement: { method: "bank_transfer", amountReceived: 2_320 },
    };
    const preview = await previewOrderCorrection(
      orderId,
      input,
      ownerActor,
      scope,
      PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
    );
    expect(preview.data).toMatchObject({
      totalDelta: -2_320,
      afterTotals: {
        paymentFeeMinor: 2_000,
        paymentFeeVatMinor: 182,
        paymentFeeRevenueMinor: 1_818,
        total: 238_000,
      },
      settlement: { status: "pending" },
    });
    const applied = await applyOrderCorrection(
      { "idempotency-key": `${runId}:negative-fee-correction` },
      orderId,
      input,
      ownerActor,
      scope,
      PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
    );
    const payable = await client.query(
      `SELECT payable_id::text,balance_minor::text FROM app.customer_refund_payable_balances WHERE order_id=$1`,
      [orderId],
    );
    expect(payable.rows).toEqual([
      { payable_id: expect.any(String), balance_minor: "2320" },
    ]);
    const payout = await refundOrder(
      { "idempotency-key": `${runId}:negative-fee-payout` },
      orderId,
      {
        method: "cash",
        reason: "UAT settle approved negative correction",
        confirmationToken: String(sale.response.data.orderNumber),
      },
      ownerActor,
      scope,
    );
    expect(payout.response.data.amount).toBe(2_320);
    const canonical = (
      await client.query(
        `SELECT metadata FROM app.payment_events WHERE id=$1`,
        [payout.response.data.canonicalPaymentEventId],
      )
    ).rows[0];
    expect(canonical.metadata.refundAllocationV2).toMatchObject({
      settlementOnlyMinor: 2_320,
      reversalComponents: {
        merchandiseRevenueMinor: 0,
        shippingRevenueMinor: 0,
        paymentFeeRevenueMinor: 0,
        vatMinor: 0,
      },
      payableAllocations: [{ payableKind: "negative_correction" }],
    });
    const events = await client.query(
      `SELECT id::text,event_type,payload FROM outbox.events WHERE aggregate_id=$1
      AND event_type IN ('sale.created','order.corrected','refund.created') ORDER BY aggregate_sequence`,
      [orderId],
    );
    for (const event of events.rows)
      for (let replay = 0; replay < 2; replay++)
        await processExactOutboxEvent({
          id: event.id,
          eventType: event.event_type,
          payload: event.payload,
        });
    const fee = await client.query(
      `SELECT sum(l.credit_amount-l.debit_amount)::numeric AS revenue FROM accounting.journal_entries j
      JOIN accounting.journal_lines l ON l.journal_entry_id=j.id JOIN accounting.accounts a ON a.id=l.account_id
      WHERE a.code='5113' AND ((j.reference_type='order' AND j.reference_id=$1) OR(j.reference_type='order_correction' AND j.reference_id=$2))`,
      [orderId, applied.response.data.correction.id],
    );
    expect(Number(fee.rows[0].revenue)).toBe(1_818);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM accounting.journal_entries WHERE reference_type='refund' AND reference_id=$1`,
          [payout.response.data.refundEntryId],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await client.query(
          `SELECT balance_minor::text FROM app.customer_refund_payable_balances WHERE payable_id=$1`,
          [payable.rows[0].payable_id],
        )
      ).rows[0].balance_minor,
    ).toBe("0");
  });

  it("actual correction retains percent fee and frozen VAT through revision, collection and journal", async () => {
    const sale = await completeSale(
      { "idempotency-key": `${runId}:actual-correction-sale` },
      {
        items: [{ variantId, quantity: 1 }],
        customerMode: "walk_in",
        paymentMethod: "cash",
        amountReceived: 250_000,
        discountPercent: 10,
        shippingFee: 20_000,
        paymentFeeType: "percent",
        paymentFeeValue: 2,
      },
      ownerActor,
      scope,
    );
    const orderId = String(sale.response.data.id);
    const input = {
      baseRevision: 0,
      reason: "UAT actual fee percent correction",
      items: [{ variantId, quantity: 2 }],
      shippingFee: 10_000,
      settlement: { method: "cash", amountReceived: 210_320 },
    };
    const previousVat = process.env.VAT_RATE;
    try {
      process.env.VAT_RATE = "0";
      const preview = await previewOrderCorrection(
        orderId,
        input,
        ownerActor,
        scope,
        PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
      );
      expect(preview.data).toMatchObject({
        totalDelta: 210_320,
        beforeTotals: { total: 240_320, paymentFeeMinor: 4_320 },
        afterTotals: {
          commercialCalculationVersion: 2,
          paymentFeeType: "percent",
          paymentFeeValue: 2,
          paymentFeeBasisMinor: 432_000,
          paymentFeeMinor: 8_640,
          paymentFeeVatMinor: 785,
          vatRatePpm: 100_000,
          tax: 40_967,
          total: 450_640,
        },
      });
      const headers = { "idempotency-key": `${runId}:actual-correction` };
      const applied = await applyOrderCorrection(
        headers,
        orderId,
        input,
        ownerActor,
        scope,
        PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
      );
      expect(applied.response.data.correction).toMatchObject({
        totalDelta: 210_320,
        afterTotals: { paymentFeeMinor: 8_640, total: 450_640 },
      });
      expect(
        (await applyOrderCorrection(headers, orderId, input, ownerActor, scope, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1))
          .response,
      ).toEqual(JSON.parse(JSON.stringify(applied.response)));
    } finally {
      if (previousVat === undefined) delete process.env.VAT_RATE;
      else process.env.VAT_RATE = previousVat;
    }
    const fact = await client.query(
      `SELECT e.amount_minor::text,d.component_version,d.payment_fee_delta_minor::text,d.payment_fee_vat_delta_minor::text
      FROM app.payment_events e JOIN app.payment_correction_component_deltas d ON d.payment_event_id=e.id WHERE e.order_id=$1`,
      [orderId],
    );
    expect(fact.rows).toEqual([
      {
        amount_minor: "210320",
        component_version: 2,
        payment_fee_delta_minor: "4320",
        payment_fee_vat_delta_minor: "392",
      },
    ]);
    const outbox = await client.query(
      `SELECT id::text,event_type,payload FROM outbox.events WHERE aggregate_id=$1
      AND event_type IN ('sale.created','order.corrected') ORDER BY aggregate_sequence`,
      [orderId],
    );
    for (const event of outbox.rows) {
      await processExactOutboxEvent({
        id: event.id,
        eventType: event.event_type,
        payload: event.payload,
      });
      await processExactOutboxEvent({
        id: event.id,
        eventType: event.event_type,
        payload: event.payload,
      });
    }
    const journal = await client.query(
      `SELECT a.code,sum(l.debit_amount-l.credit_amount)::numeric AS net
      FROM accounting.journal_entries j JOIN accounting.journal_lines l ON l.journal_entry_id=j.id JOIN accounting.accounts a ON a.id=l.account_id
      WHERE j.reference_type='order_correction' AND j.reference_id IN(SELECT id::text FROM app.order_corrections WHERE order_id=$1)
      GROUP BY a.code ORDER BY a.code`,
      [orderId],
    );
    expect(
      journal.rows.map((row) => ({ code: row.code, net: Number(row.net) })),
    ).toEqual([
      { code: "1111", net: 210_320 },
      { code: "1561", net: -50_000 },
      { code: "3331", net: -19_120 },
      { code: "5111", net: -196_363 },
      { code: "5112", net: 9_091 },
      { code: "5113", net: -3_928 },
      { code: "6321", net: 50_000 },
    ]);
  });

  it.each([0, 2] as const)(
    "confirms a committed V2 correction with original fee=%i without losing signed fee/VAT",
    async (feePercent) => {
      const f = await createPending(feePercent);
      await confirmInitialManualBankPaymentWithClientV1(
        client,
        f.headers,
        f.orderId,
        f.body,
        actor,
        scope,
        { enabled: true },
      );
      const correctionId = `${f.orderId}:positive-correction`;
      const context = { taxMode: "inclusive" as const, vatRatePpm: 100_000 };
      const before = calculateOrderTotalsV2(
        240_000,
        {
          discountPercent: 10,
          paymentFeeType: "percent",
          paymentFeeValue: feePercent,
        },
        20_000,
        context,
      );
      const after = calculateOrderTotalsV2(
        480_000,
        { discountPercent: 10, paymentFeeType: "amount", paymentFeeValue: 0 },
        10_000,
        context,
      );
      const baseId = (
        await client.query(
          `SELECT id::text FROM app.order_commercial_revisions WHERE order_id=$1 AND revision=0`,
          [f.orderId],
        )
      ).rows[0].id;
      await client.query("BEGIN");
      try {
        const options = {
          transactionOwnership: "caller" as const,
          statementTimeoutMs: 5_000,
          lockTimeoutMs: 1_000,
        };
        const task = createCorrectionCommercialRevisionTaskV2(
          {
            repository: new PostgresCorrectionCommercialRevisionRepositoryV1(
              client,
              options,
            ),
          },
          {
            merchantId,
            storeId,
            orderId: f.orderId,
            correctionId,
            revision: 1,
            sourceOccurredAt: "2026-10-26T00:02:00.000Z",
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
                skuSnapshot: "FEE-CONFIRM",
                titleSnapshot: "Fee correction confirmation",
                quantity: 2,
                unitPriceMinor: 240_000,
              },
            ],
          },
        );
        const effective = await task.execute();
        const contract = buildPositiveCorrectionChargeContractV2({
          merchantId,
          storeId,
          orderId: f.orderId,
          correctionId,
          baseCommercialRevisionId: baseId,
          baseCommercialRevision: 0,
          effectiveCommercialRevisionId: effective.revisionId,
          effectiveCommercialRevision: 1,
          currencyCode: "VND",
          minorUnitExponent: 0,
          sourceOccurredAt: "2026-10-26T00:02:00.000Z",
          beforeComponents: task.bundle.baseComponents,
          effectiveComponents: task.bundle.components,
        });
        await recordPositiveCorrectionChargeV1(client, {
          contract,
          settlementMethod: "bank_transfer",
          ...options,
        });
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      const headers = { "idempotency-key": `${f.orderId}:correction-confirm` };
      const body = {
        sourceReference: `${f.orderId}:correction-slip`,
        confirmedAt: "2026-10-26T00:03:00.000Z",
      };
      let first: Awaited<
        ReturnType<typeof confirmCorrectionManualBankPaymentWithClientV1>
      >;
      if (feePercent === 2) {
        const other = await connectPlatformClient();
        try {
          const concurrent = await Promise.all(
            [client, other].map((connection) =>
              confirmCorrectionManualBankPaymentWithClientV1(
                connection,
                headers,
                f.orderId,
                body,
                actor,
                scope,
              ),
            ),
          );
          expect(concurrent.map((result) => result.statusCode).sort()).toEqual([
            200, 201,
          ]);
          expect(
            new Set(
              concurrent.map((result) => result.response.data.paymentEventId),
            ).size,
          ).toBe(1);
          first = concurrent.find((result) => result.statusCode === 201)!;
        } finally {
          other.release();
        }
      } else
        first = await confirmCorrectionManualBankPaymentWithClientV1(
          client,
          headers,
          f.orderId,
          body,
          actor,
          scope,
        );
      expect(first.statusCode).toBe(201);
      const replay = await confirmCorrectionManualBankPaymentWithClientV1(
        client,
        headers,
        f.orderId,
        body,
        actor,
        scope,
      );
      expect(replay).toMatchObject({
        statusCode: 200,
        response: {
          data: {
            paymentEventId: first.response.data.paymentEventId,
            outcome: "replayed",
          },
        },
      });
      const facts = await client.query(
        `SELECT d.component_version,d.payment_fee_delta_minor::text,d.payment_fee_vat_delta_minor::text,
      d.total_delta_minor::text,e.metadata,
      (SELECT count(*)::int FROM app.payment_event_evidence x WHERE x.payment_event_id=e.id) AS evidence,
      (SELECT count(*)::int FROM app.payment_event_allocations x WHERE x.payment_event_id=e.id) AS allocations
      FROM app.payment_events e JOIN app.payment_correction_component_deltas d ON d.payment_event_id=e.id WHERE e.id=$1`,
        [first.response.data.paymentEventId],
      );
      expect(facts.rows).toEqual([
        expect.objectContaining({
          component_version: 2,
          payment_fee_delta_minor: feePercent === 2 ? "-4320" : "0",
          payment_fee_vat_delta_minor: feePercent === 2 ? "-393" : "0",
          total_delta_minor: String(442_000 - f.expectedTotal),
          metadata: expect.objectContaining({ schemaVersion: 2 }),
          evidence: 1,
          allocations: 1,
        }),
      ]);
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM audit.events WHERE subject_id=$1 AND action='payment.manual_bank_correction_confirmed'`,
            [f.orderId],
          )
        ).rows[0].count,
      ).toBe(1);
      await expect(
        confirmCorrectionManualBankPaymentWithClientV1(
          client,
          headers,
          f.orderId,
          { ...body, paymentFeeMinor: 0 } as never,
          actor,
          scope,
        ),
      ).rejects.toMatchObject({ code: "manual_bank_confirmation_invalid" });
    },
  );

  it("serializes V2 refunds, caps every component and keeps Web exact-payable authority", async () => {
    const sale = await completeSale(
      { "idempotency-key": `${runId}:concurrent-refund-sale` },
      {
        items: [{ variantId, quantity: 1 }],
        customerMode: "walk_in",
        paymentMethod: "cash",
        amountReceived: 250_000,
        discountPercent: 10,
        shippingFee: 20_000,
        paymentFeeType: "percent",
        paymentFeeValue: 2,
      },
      actor,
      scope,
    );
    const orderId = String(sale.response.data.id);
    await expect(
      refundOrder(
        { "idempotency-key": `${runId}:web-arbitrary-refund` },
        orderId,
        {
          amount: 120_160,
          method: "cash",
          reason: "UAT must not grant arbitrary Web refund",
          confirmationToken: String(sale.response.data.orderNumber),
        },
        ownerActor,
        scope,
      ),
    ).rejects.toMatchObject({ code: "refund_amount_must_equal_payable" });
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM app.customer_refund_payables WHERE order_id=$1`,
          [orderId],
        )
      ).rows[0].count,
    ).toBe(0);
    const channelActor: ChannelActor = {
      ...ownerActor,
      channel: "telegram",
      channelUserId: `${runId}:concurrent-refund-operator`,
      serviceIdentity: "UAT-internal-channel-service",
      permissions: ["order:refund"],
      merchantId,
    };
    const body = {
      amount: 120_160,
      method: "cash",
      reason: "UAT concurrent partial refund",
    };
    const headers = [0, 1, 2].map((index) => ({
      "idempotency-key": `${runId}:concurrent-refund:${index}`,
    }));
    const attempts = await Promise.allSettled(
      headers.map((header) =>
        refundOrder(header, orderId, body, channelActor, scope),
      ),
    );
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(2);
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: "invalid_state_transition" },
    });
    const index = attempts.findIndex((result) => result.status === "fulfilled");
    const accepted = attempts[index]!;
    const replay = await refundOrder(
      headers[index]!,
      orderId,
      body,
      channelActor,
      scope,
    );
    if (accepted.status !== "fulfilled")
      throw new Error("expected successful refund");
    expect(replay.response).toEqual(
      JSON.parse(JSON.stringify(accepted.value.response)),
    );
    const facts = await client.query(
      `SELECT metadata FROM app.payment_events WHERE order_id=$1 AND kind='refund'`,
      [orderId],
    );
    expect(facts.rows).toHaveLength(2);
    const totals = {
      merchandiseRevenueMinor: 0,
      shippingRevenueMinor: 0,
      paymentFeeRevenueMinor: 0,
      vatMinor: 0,
    };
    for (const row of facts.rows)
      for (const key of Object.keys(totals) as Array<keyof typeof totals>)
        totals[key] += row.metadata.refundAllocationV2.reversalComponents[key];
    expect(totals).toEqual({
      merchandiseRevenueMinor: 196_364,
      shippingRevenueMinor: 18_182,
      paymentFeeRevenueMinor: 3_927,
      vatMinor: 21_847,
    });
  });

  it.each([0, 120_160])(
    "cancels and pays a fee order after a delayed manual refund of %i without reversing twice",
    async (priorRefund) => {
      const sale = await completeSale(
        { "idempotency-key": `${runId}:cancel-fee-sale:${priorRefund}` },
        {
          items: [{ variantId, quantity: 1 }],
          customerMode: "walk_in",
          paymentMethod: "cash",
          amountReceived: 250_000,
          discountPercent: 10,
          shippingFee: 20_000,
          paymentFeeType: "percent",
          paymentFeeValue: 2,
        },
        actor,
        scope,
      );
      const orderId = String(sale.response.data.id);
      async function processEvents(type: string) {
        const events = await client.query(
          `SELECT id::text,event_type,payload FROM outbox.events WHERE aggregate_id=$1 AND event_type=$2 ORDER BY created_at,id`,
          [orderId, type],
        );
        expect(events.rows.length).toBeGreaterThan(0);
        for (const event of events.rows)
          await processExactOutboxEvent({
            id: event.id,
            eventType: event.event_type,
            payload: event.payload,
          });
      }
      await processEvents("sale.created");
      if (priorRefund) {
        const channelActor: ChannelActor = {
          ...ownerActor,
          channel: "telegram",
          channelUserId: `${runId}:refund-owner`,
          serviceIdentity: "UAT-internal-channel-service",
          permissions: ["order:refund"],
          merchantId,
        };
        await refundOrder(
          { "idempotency-key": `${runId}:cancel-fee-partial` },
          orderId,
          {
            amount: priorRefund,
            method: "cash",
            reason: "UAT partial before cancel",
          },
          channelActor,
          scope,
        );
      }
      const { quote } = await quoteOrderCancellation(
        orderId,
        scope,
        ownerActor,
      );
      const cancellation = await cancelOrder(
        { "idempotency-key": `${runId}:cancel-fee:${priorRefund}` },
        orderId,
        {
          reason: "UAT cancel fee order and return stock",
          quoteId: quote.quoteId,
          effectiveRevision: quote.effectiveRevision,
          quoteGeneratedAt: quote.generatedAt,
        },
        ownerActor,
        scope,
      );
      expect(cancellation.response.financial.customerRefundPayableMinor).toBe(
        240_320 - priorRefund,
      );
      await processEvents("sale.cancelled");
      const refund = await refundOrder(
        { "idempotency-key": `${runId}:cancel-fee-payout:${priorRefund}` },
        orderId,
        {
          method: "cash",
          reason: "UAT pay remaining cancellation liability",
          confirmationToken: String(sale.response.data.orderNumber),
        },
        ownerActor,
        scope,
      );
      const canonical = (
        await client.query(
          `SELECT metadata FROM app.payment_events WHERE id=$1`,
          [refund.response.data.canonicalPaymentEventId],
        )
      ).rows[0];
      expect(canonical.metadata.refundAllocationV2).toMatchObject({
        settlementOnlyMinor: 240_320 - priorRefund,
        reversalComponents: {
          merchandiseRevenueMinor: 0,
          shippingRevenueMinor: 0,
          paymentFeeRevenueMinor: 0,
          vatMinor: 0,
        },
      });
      await processEvents("refund.created");
      await processEvents("refund.created");
      await processEvents("sale.cancelled");
      const net = await client.query(
        `SELECT a.code,sum(l.debit_amount-l.credit_amount)::numeric AS net
      FROM accounting.journal_entries j JOIN accounting.journal_lines l ON l.journal_entry_id=j.id
      JOIN accounting.accounts a ON a.id=l.account_id
      WHERE (j.reference_type IN ('order','order_cancellation') AND j.reference_id=$1)
        OR (j.reference_type='refund' AND j.reference_id IN (SELECT id::text FROM app.payment_entries WHERE order_id=$1))
        OR (j.reference_type='customer_refund_payout' AND j.reference_id IN (SELECT id::text FROM app.payment_events WHERE order_id=$1))
      GROUP BY a.code ORDER BY a.code`,
        [orderId],
      );
      expect(
        net.rows.map((row) => ({ code: row.code, net: Number(row.net) })),
      ).toEqual(
        [
          "1111",
          "1561",
          "3331",
          "5111",
          "5112",
          "5113",
          "6321",
          "CUSTOMER_REFUND_PAYABLE",
        ].map((code) => ({ code, net: 0 })),
      );
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM medusa.stock_movements WHERE reference_id=$1 AND movement_type='return'`,
            [orderId],
          )
        ).rows[0].count,
      ).toBe(1);
    },
  );

  it("freezes both O6 partial-refund splits before delayed worker execution", async () => {
    const sale = await completeSale(
      { "idempotency-key": `${runId}:refund-o6-sale` },
      {
        items: [{ variantId, quantity: 1 }],
        customerMode: "walk_in",
        paymentMethod: "cash",
        amountReceived: 250_000,
        discountPercent: 10,
        shippingFee: 20_000,
        paymentFeeType: "percent",
        paymentFeeValue: 2,
      },
      actor,
      scope,
    );
    const orderId = String(sale.response.data.id);
    const channelActor: ChannelActor = {
      ...actor,
      channel: "telegram",
      channelUserId: `${runId}:refund-operator`,
      serviceIdentity: "UAT-internal-channel-service",
      permissions: ["order:refund"],
      merchantId,
    };
    const firstHeaders = { "idempotency-key": `${runId}:refund-o6-first` };
    const body = {
      amount: 120_160,
      method: "cash",
      reason: "UAT frozen refund split",
    };
    const first = await refundOrder(
      firstHeaders,
      orderId,
      body,
      channelActor,
      scope,
    );
    const replay = await refundOrder(
      firstHeaders,
      orderId,
      body,
      channelActor,
      scope,
    );
    expect(replay.response).toEqual(JSON.parse(JSON.stringify(first.response)));
    const second = await refundOrder(
      { "idempotency-key": `${runId}:refund-o6-second` },
      orderId,
      body,
      channelActor,
      scope,
    );
    const ids = [
      first.response.data.canonicalPaymentEventId,
      second.response.data.canonicalPaymentEventId,
    ];
    const expected = [
      {
        merchandiseRevenueMinor: 98_182,
        shippingRevenueMinor: 9_091,
        paymentFeeRevenueMinor: 1_963,
        vatMinor: 10_924,
      },
      {
        merchandiseRevenueMinor: 98_182,
        shippingRevenueMinor: 9_091,
        paymentFeeRevenueMinor: 1_964,
        vatMinor: 10_923,
      },
    ];
    for (let index = 0; index < ids.length; index++) {
      const event = (
        await client.query(
          `SELECT metadata FROM app.payment_events WHERE id=$1`,
          [ids[index]],
        )
      ).rows[0];
      expect(event.metadata.refundAllocationV2).toMatchObject({
        schemaVersion: 2,
        amountMinor: 120_160,
        settlementOnlyMinor: 0,
        reversalComponents: expected[index],
      });
    }
    const refunds = await client.query(
      `SELECT id::text,event_type,payload FROM outbox.events
      WHERE aggregate_id=$1 AND event_type='refund.created' ORDER BY created_at DESC,id DESC`,
      [orderId],
    );
    const forgedEntry = `forged-refund-${randomUUID()}`;
    await expect(
      processExactOutboxEvent({
        id: randomUUID(),
        eventType: "refund.created",
        payload: { ...refunds.rows[0].payload, paymentEntryId: forgedEntry },
      }),
    ).rejects.toMatchObject({ code: "financial_invariant_error" });
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM accounting.journal_entries WHERE reference_id=$1`,
          [forgedEntry],
        )
      ).rows[0].count,
    ).toBe(0);
    const previousVat = process.env.VAT_RATE;
    try {
      process.env.VAT_RATE = "0";
      for (const event of refunds.rows) {
        await processExactOutboxEvent({
          id: event.id,
          eventType: event.event_type,
          payload: {
            ...event.payload,
            paymentMethod: "bank_transfer",
            refundAllocationV2: { amountMinor: 0 },
          },
        });
        await processExactOutboxEvent({
          id: event.id,
          eventType: event.event_type,
          payload: event.payload,
        });
      }
    } finally {
      if (previousVat === undefined) delete process.env.VAT_RATE;
      else process.env.VAT_RATE = previousVat;
    }
    for (let index = 0; index < ids.length; index++) {
      const refundEntryId =
        index === 0
          ? first.response.data.refundEntryId
          : second.response.data.refundEntryId;
      const journal = await client.query(
        `SELECT a.code,sum(l.debit_amount)::text AS debit,sum(l.credit_amount)::text AS credit
        FROM accounting.journal_entries j JOIN accounting.journal_lines l ON l.journal_entry_id=j.id
        JOIN accounting.accounts a ON a.id=l.account_id WHERE j.reference_type='refund' AND j.reference_id=$1
        GROUP BY a.code ORDER BY a.code`,
        [refundEntryId],
      );
      expect(
        journal.rows.map((row) => ({
          ...row,
          debit: Number(row.debit),
          credit: Number(row.credit),
        })),
      ).toEqual([
        { code: "3331", debit: expected[index]!.vatMinor, credit: 0 },
        { code: "5111", debit: 98_182, credit: 0 },
        { code: "5112", debit: 9_091, credit: 0 },
        {
          code: "5113",
          debit: expected[index]!.paymentFeeRevenueMinor,
          credit: 0,
        },
        { code: "CUSTOMER_REFUND_PAYABLE", debit: 0, credit: 120_160 },
      ]);
    }
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM app.payment_events WHERE order_id=$1 AND kind='refund'`,
          [orderId],
        )
      ).rows[0].count,
    ).toBe(2);
    await expect(
      refundOrder(
        { "idempotency-key": `${runId}:refund-o6-exhausted` },
        orderId,
        body,
        channelActor,
        scope,
      ),
    ).rejects.toMatchObject({ code: "invalid_state_transition" });
  });

  it("routes an inconsistent stored intent fee to manual review without creating an order", async () => {
    const previousPackage = process.env.APP_PACKAGE_KEY;
    try {
      process.env.APP_PACKAGE_KEY = "plus";
      const order: SaleInput = {
        items: [{ variantId, quantity: 1 }],
        customerMode: "walk_in",
        paymentMethod: "mock",
        amountReceived: 0,
        discountPercent: 10,
        shippingFee: 20_000,
        paymentFeeType: "percent",
        paymentFeeValue: 2,
      };
      const intent = await createPaymentIntent(
        { "idempotency-key": `${runId}:inconsistent-intent` },
        { provider: "mock", order },
        actor,
        scope,
      );
      await client.query(
        `UPDATE app.payment_intents SET order_input=jsonb_set(order_input,'{paymentFeeValue}','3'::jsonb) WHERE id=$1`,
        [intent.response.data.id],
      );
      const before = Number(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM public."order" WHERE merchant_id=$1`,
            [merchantId],
          )
        ).rows[0].count,
      );
      const stockBefore = String(
        (
          await client.query(
            `SELECT stocked_quantity FROM public.inventory_level WHERE inventory_item_id=$1 AND location_id=$2`,
            [inventoryItemId, scope.stockLocationId],
          )
        ).rows[0].stocked_quantity,
      );
      const result = await settleMockPaymentIntent(
        { "idempotency-key": `${runId}:inconsistent-settle` },
        intent.response.data.id,
        actor,
        { merchantId, storeId },
        PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
      );
      expect(result.response.data).toMatchObject({
        status: "manual_review",
        manualReviewReason: "payment_intent_quote_invalid",
        completedOrderId: null,
      });
      expect(
        Number(
          (
            await client.query(
              `SELECT count(*)::int AS count FROM public."order" WHERE merchant_id=$1`,
              [merchantId],
            )
          ).rows[0].count,
        ),
      ).toBe(before);
      expect(
        String(
          (
            await client.query(
              `SELECT stocked_quantity FROM public.inventory_level WHERE inventory_item_id=$1 AND location_id=$2`,
              [inventoryItemId, scope.stockLocationId],
            )
          ).rows[0].stocked_quantity,
        ),
      ).toBe(stockBefore);
    } finally {
      if (previousPackage === undefined) delete process.env.APP_PACKAGE_KEY;
      else process.env.APP_PACKAGE_KEY = previousPackage;
    }
  });
  it.each([
    [100_000, "0.10", "393", "21847"],
    [123, "0.000123", "1", "30"],
  ] as const)(
    "payment intent keeps ppm%i across a runtime VAT change",
    async (vatRatePpm, vatRate, feeVat, totalVat) => {
      const originalVat = process.env.VAT_RATE,
        originalTax = process.env.TAX_MODE,
        originalPackage = process.env.APP_PACKAGE_KEY;
      try {
        process.env.VAT_RATE = vatRate;
        process.env.TAX_MODE = "inclusive";
        process.env.APP_PACKAGE_KEY = "plus";
        const order: SaleInput = {
          items: [{ variantId, quantity: 1 }],
          customerMode: "walk_in",
          paymentMethod: "mock",
          amountReceived: 0,
          discountPercent: 10,
          shippingFee: 20_000,
          paymentFeeType: "percent",
          paymentFeeValue: 2,
        };
        const headers = {
          "idempotency-key": `${runId}:intent-freeze:${vatRatePpm}`,
        };
        const intent = await createPaymentIntent(
          headers,
          { provider: "mock", order },
          actor,
          scope,
        );
        expect(intent.response.data.amount).toBe(240_320);
        expect(intent.response.data).toMatchObject({ financial: { schemaVersion: 1, calculationVersion: 2,
          paymentFee: { vatRatePpm, paymentFeeType: "percent", paymentFeeValue: 2, paymentFeeBasisMinor: 216_000 },
          components: { paymentFeeMinor: 4320, paymentFeeVatMinor: Number(feeVat), totalMinor: 240_320 } } });
        expect(intent.response.data.metadata.quote).toMatchObject({
          totals: { vatRatePpm, taxMode: "inclusive", paymentFeeMinor: 4_320 },
        });
        await expect(
          createPaymentIntent(
            headers,
            { provider: "mock", order: { ...order, paymentFeeValue: 3 } },
            actor,
            scope,
          ),
        ).rejects.toMatchObject({
          code: "idempotency_conflict",
          statusCode: 409,
        });
        process.env.VAT_RATE = "0";
        process.env.TAX_MODE = "exclusive";
        const settled = await settleMockPaymentIntent(
          { "idempotency-key": `${runId}:intent-settle:${vatRatePpm}` },
          intent.response.data.id,
          actor,
          { merchantId, storeId },
          PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
        );
        expect(settled.response.data.status).toBe("completed");
        const orderId = settled.response.data.completedOrderId;
        expect(orderId).toBeTruthy();
        const snapshot = await client.query(
          `SELECT c.payment_fee_minor::text,c.payment_fee_vat_minor::text,c.vat_minor::text,
        c.total_minor::text,c.tax_mode,r.metadata FROM app.order_commercial_revision_components c
        JOIN app.order_commercial_revisions r ON r.id=c.revision_id WHERE c.order_id=$1`,
          [orderId],
        );
        expect(snapshot.rows).toHaveLength(1);
        expect(snapshot.rows[0]).toMatchObject({
          payment_fee_minor: "4320",
          payment_fee_vat_minor: feeVat,
          vat_minor: totalVat,
          total_minor: "240320",
          tax_mode: "inclusive",
          metadata: { vatRatePpm },
        });
      } finally {
        if (originalVat === undefined) delete process.env.VAT_RATE;
        else process.env.VAT_RATE = originalVat;
        if (originalTax === undefined) delete process.env.TAX_MODE;
        else process.env.TAX_MODE = originalTax;
        if (originalPackage === undefined) delete process.env.APP_PACKAGE_KEY;
        else process.env.APP_PACKAGE_KEY = originalPackage;
      }
    },
  );
  it("checkout/quote use authoritative fees and replay one stock movement and event", async () => {
    const input: SaleInput & {
      paymentFeeType: "percent";
      paymentFeeValue: number;
    } = {
      items: [{ variantId, quantity: 1 }],
      customerMode: "walk_in",
      paymentMethod: "cash",
      amountReceived: 250_000,
      discountPercent: 10,
      shippingFee: 20_000,
      paymentFeeType: "percent",
      paymentFeeValue: 2,
    };
    const before = Number(
      (
        await client.query(
          `SELECT stocked_quantity FROM public.inventory_level WHERE inventory_item_id=$1 AND location_id=$2`,
          [inventoryItemId, scope.stockLocationId],
        )
      ).rows[0].stocked_quantity,
    );
    const quote = await quoteSaleForClient(
      client,
      input,
      scope.stockLocationId,
      merchantId,
      storeId,
    );
    expect(quote.totals).toMatchObject({
      total: 240_320,
      commercialAdjustmentVersion: 2,
      paymentFeeMinor: 4_320,
      paymentFeeVatMinor: 393,
    });
    const headers = { "idempotency-key": `${runId}:checkout-fee` };
    const first = await completeSale(headers, input, actor, scope);
    expect(first.response.data).toMatchObject({
      total: 240_320,
      change: 9_680,
      financial: { components: { paymentFeeMinor: 4320, paymentFeeVatMinor: 393, totalMinor: 240_320 } },
    });
    const orderId = String(first.response.data.id);
    const replay = await completeSale(headers, input, actor, scope);
    expect(replay.statusCode).toBe(200);
    expect(replay.response).toEqual(JSON.parse(JSON.stringify(first.response)));
    await expect(
      completeSale(headers, { ...input, paymentFeeValue: 3 }, actor, scope),
    ).rejects.toMatchObject({ code: "idempotency_conflict", statusCode: 409 });
    const after = Number(
      (
        await client.query(
          `SELECT stocked_quantity FROM public.inventory_level WHERE inventory_item_id=$1 AND location_id=$2`,
          [inventoryItemId, scope.stockLocationId],
        )
      ).rows[0].stocked_quantity,
    );
    expect(after).toBe(before - 1);
    const facts = await client.query(
      `SELECT c.component_version,c.payment_fee_minor::text,c.payment_fee_vat_minor::text,r.metadata
      FROM app.order_commercial_revision_components c JOIN app.order_commercial_revisions r ON r.id=c.revision_id WHERE c.order_id=$1`,
      [orderId],
    );
    expect(facts.rows).toHaveLength(1);
    expect(facts.rows[0]).toMatchObject({
      component_version: 2,
      payment_fee_minor: "4320",
      payment_fee_vat_minor: "393",
      metadata: { bundleVersion: 2 },
    });
    const events = await client.query(
      `SELECT id::text,payload FROM outbox.events WHERE aggregate_id=$1 AND event_type='sale.created'`,
      [orderId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload).toMatchObject({
      total: 240_320,
      paymentFeeMinor: 4_320,
      paymentFeeVatMinor: 393,
      paymentFeeBasisMinor: 216_000,
      paymentFeeRevenueMinor: 3_927,
      commercialCalculationVersion: 2,
      loyaltyBase: 216_000,
      cogs: 50_000,
    });
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM medusa.stock_movements WHERE reference_id=$1`,
          [orderId],
        )
      ).rows[0].count,
    ).toBe(1);
    const event = {
      id: events.rows[0].id,
      eventType: "sale.created",
      payload: events.rows[0].payload,
    };
    const reportScope = {
      scopeKind: "report" as const,
      merchantId,
      storeIds: [storeId],
    };
    const incomeBefore = (await getIncomeStatement(reportScope)).data;
    await processExactOutboxEvent(event);
    await processExactOutboxEvent(event);
    const journal = await client.query(
      `SELECT a.code,l.debit_amount::numeric::text,l.credit_amount::numeric::text
      FROM accounting.journal_entries j JOIN accounting.journal_lines l ON l.journal_entry_id=j.id
      JOIN accounting.accounts a ON a.id=l.account_id WHERE j.reference_type='order' AND j.reference_id=$1 ORDER BY a.code`,
      [orderId],
    );
    expect(journal.rows).toEqual([
      { code: "1111", debit_amount: "240320.00", credit_amount: "0.00" },
      { code: "1561", debit_amount: "0.00", credit_amount: "50000.00" },
      { code: "3331", debit_amount: "0.00", credit_amount: "21847.00" },
      { code: "5111", debit_amount: "0.00", credit_amount: "196364.00" },
      { code: "5112", debit_amount: "0.00", credit_amount: "18182.00" },
      { code: "5113", debit_amount: "0.00", credit_amount: "3927.00" },
      { code: "6321", debit_amount: "50000.00", credit_amount: "0.00" },
    ]);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM accounting.journal_entries WHERE reference_type='order' AND reference_id=$1`,
          [orderId],
        )
      ).rows[0].count,
    ).toBe(1);
    const incomeAfter = (await getIncomeStatement(reportScope)).data;
    expect(
      Object.fromEntries(
        Object.keys(incomeBefore).map((key) => [
          key,
          Number(incomeAfter[key as keyof typeof incomeAfter]) -
            Number(incomeBefore[key as keyof typeof incomeBefore]),
        ]),
      ),
    ).toMatchObject({
      merchandiseRevenue: 196_364,
      shippingRevenue: 18_182,
      paymentFeeRevenue: 3_927,
      revenue: 218_473,
      cogs: 50_000,
      grossProfit: 146_364,
      netIncome: 168_473,
    });
  });
  it.each([0, 2] as const)(
    "collects exact fee=%i and replays without another event/audit",
    async (feePercent) => {
      const f = await createPending(feePercent);
      const first = await confirmInitialManualBankPaymentWithClientV1(
        client,
        f.headers,
        f.orderId,
        f.body,
        actor,
        scope,
        { enabled: true },
      );
      expect(first).toMatchObject({
        statusCode: 201,
        response: { data: { amountMinor: f.expectedTotal, status: "posted" } },
      });
      const retry = await confirmInitialManualBankPaymentWithClientV1(
        client,
        f.headers,
        f.orderId,
        f.body,
        actor,
        scope,
        { enabled: true },
      );
      expect(retry).toMatchObject({
        statusCode: 200,
        response: {
          data: {
            outcome: "replayed",
            paymentEventId: first.response.data.paymentEventId,
          },
        },
      });
      expect(await counts(f.orderId)).toEqual({
        posted: 1,
        audits: 1,
        allocations: 1,
      });
      const stored = await client.query(
        `SELECT c.component_version,c.payment_fee_minor::text,c.payment_fee_vat_minor::text
      FROM app.payment_event_component_allocations c JOIN app.payment_events e ON e.id=c.payment_event_id
      WHERE e.order_id=$1 AND e.status='posted'`,
        [f.orderId],
      );
      expect(stored.rows).toEqual([
        {
          component_version: 2,
          payment_fee_minor: feePercent === 2 ? "4320" : "0",
          payment_fee_vat_minor: feePercent === 2 ? "393" : "0",
        },
      ]);
      await expect(
        confirmInitialManualBankPaymentWithClientV1(
          client,
          { "idempotency-key": `${f.orderId}:changed` },
          f.orderId,
          f.body,
          actor,
          scope,
          { enabled: true },
        ),
      ).rejects.toMatchObject({
        code: "manual_bank_confirmation_conflict",
        statusCode: 409,
      });
      expect(await counts(f.orderId)).toEqual({
        posted: 1,
        audits: 1,
        allocations: 1,
      });
    },
  );
  it("serializes two separate connections confirming the same attempt", async () => {
    const f = await createPending(),
      a = await connectPlatformClient(),
      b = await connectPlatformClient();
    try {
      const results = await Promise.all(
        [a, b].map((c) =>
          confirmInitialManualBankPaymentWithClientV1(
            c,
            f.headers,
            f.orderId,
            f.body,
            actor,
            scope,
            { enabled: true },
          ),
        ),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 201]);
      expect(
        new Set(results.map((r) => r.response.data.paymentEventId)).size,
      ).toBe(1);
      expect(await counts(f.orderId)).toEqual({
        posted: 1,
        audits: 1,
        allocations: 1,
      });
    } finally {
      a.release();
      b.release();
    }
  });
  it("rejects a canceled order without collection or audit writes", async () => {
    const f = await createPending();
    await client.query(
      `UPDATE public."order" SET status='canceled' WHERE id=$1`,
      [f.orderId],
    );
    await expect(
      confirmInitialManualBankPaymentWithClientV1(
        client,
        f.headers,
        f.orderId,
        f.body,
        actor,
        scope,
        { enabled: true },
      ),
    ).rejects.toMatchObject({
      code: "invalid_state_transition",
      statusCode: 409,
    });
    expect(await counts(f.orderId)).toEqual({
      posted: 0,
      audits: 0,
      allocations: 0,
    });
  });
});
