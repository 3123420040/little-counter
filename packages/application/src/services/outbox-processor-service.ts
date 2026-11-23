import { calculateLoyaltyPoints, evaluateTier } from "@medusa-snus/domain";
import { OrderCommercialComponentsV2Schema } from "@medusa-snus/contracts";
import { calculateVatMinor, resolvePaymentFee } from "./payment-fee-calculation";
import type { PoolClient } from "../db/client";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedTransaction } from "../db/transaction";
import {
  buildLoyaltyRecommendations,
  syncInventoryAlertForStockChange,
  upsertAiActionForClient,
} from "./ai-service";
import { insertJournalEntryForClient } from "./accounting-service";
import { getLoyaltyTiersForClient } from "./customer-service";
import { handleRefundCreated } from "./refund-accounting-service";
import { handleTelegramNotificationRequested } from "./telegram-notification-service";
import { routeTelegramNotificationEvent } from "./telegram-notification-router-service";
import { paymentAccountForMethod } from "./payment-service";
import { zeroRefundComponentsV2 } from "./refund-component-allocation";
import { readPriorRefundReversalsForClientV2 } from "./refund-commercial-allocation-service";
import { totalsFromMetadataV2 } from "./order-total-service";
import { persistCryptoReceiptEvidenceFromSaleForClient } from "./crypto-treasury-service";
import {
  handleProductImageAutofillRequestedOnReadySchema,
  PRODUCT_IMAGE_AUTOFILL_EVENT,
} from "./product-image-autofill-service";
import { handleVisionLearningFromSale } from "./vision-learning-service";

const CUSTOMER_REFUND_PAYABLE_ACCOUNT = "CUSTOMER_REFUND_PAYABLE";
const COLLECTION_ASSET_ACCOUNTS = new Set(["1111", "1121", "1122", "1311"]);

function signedRevenueLine(
  accountCode: string,
  delta: number,
  description: string,
) {
  if (delta === 0) return [];
  return delta > 0
    ? [{ accountCode, debitAmount: 0, creditAmount: delta, description }]
    : [{ accountCode, debitAmount: Math.abs(delta), creditAmount: 0, description: `${description} reversal` }];
}

async function postCustomerRefundPayoutJournal(
  client: PoolClient,
  input: {
    paymentEventId: string;
    amount: number;
    paymentMethod: unknown;
    orderId: string;
    orderNumber?: unknown;
    operatorId?: unknown;
    merchantId?: unknown;
    storeId?: unknown;
  },
) {
  if (!input.paymentEventId || input.amount <= 0) return;
  const exists = await queryOne(client, `
    SELECT id FROM accounting.journal_entries
    WHERE reference_type = 'customer_refund_payout' AND reference_id = $1
  `, [input.paymentEventId]);
  if (exists) return;
  await insertJournalEntryForClient(client, {
    entryDate: new Date().toISOString().slice(0, 10),
    referenceType: "customer_refund_payout",
    referenceId: input.paymentEventId,
    description: `Chi hoàn tiền khách hàng - ${input.orderNumber || input.orderId}`,
    status: "posted",
    createdBy: String(input.operatorId || "system"),
    merchantId: typeof input.merchantId === "string" ? input.merchantId : null,
    storeId: typeof input.storeId === "string" ? input.storeId : null,
    lines: [
      {
        accountCode: CUSTOMER_REFUND_PAYABLE_ACCOUNT,
        debitAmount: input.amount,
        creditAmount: 0,
        description: "Clear customer refund payable",
      },
      {
        accountCode: paymentAccountForMethod(input.paymentMethod),
        debitAmount: 0,
        creditAmount: input.amount,
        description: "Customer refund payout",
      },
    ],
  });
}

export async function processOutboxEvent(event: { id: string; eventType: string; payload: Record<string, unknown> }) {
  await ensurePlatformSchema();
  return processExactOutboxEvent(event);
}

async function lockExactOutboxEvent(client: PoolClient, eventId: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`exact-outbox-handler\u001f${eventId}`],
  );
}

export async function processExactOutboxEvent(event: { id: string; eventType: string; payload: Record<string, unknown> }) {
  if (event.eventType === PRODUCT_IMAGE_AUTOFILL_EVENT) {
    return withConnectedTransaction(async (client) => {
      await lockExactOutboxEvent(client, event.id);
      await handleProductImageAutofillRequestedOnReadySchema(event.payload || {});
    });
  }

  return withConnectedTransaction(async (client) => {
    await lockExactOutboxEvent(client, event.id);
    const payload = event.payload || {};
    if (event.eventType === "sale.created") {
      await handleSaleCreated(client, event.id, payload);
      await routeTelegramNotificationEvent(client, event);
      await handleVisionLearningFromSale(client, payload);
    } else if (event.eventType === "sale.cancelled") {
      await handleSaleCancelled(client, event.id, payload);
      await routeTelegramNotificationEvent(client, event);
    } else if (event.eventType === "order.shipping_adjusted") {
      await handleShippingAdjusted(client, event.id, payload);
      await routeTelegramNotificationEvent(client, event);
    } else if (event.eventType === "order.corrected") {
      await handleOrderCorrected(client, event.id, payload);
      await routeTelegramNotificationEvent(client, event);
    } else if (event.eventType === "refund.created") {
      await handleRefundCreated(client, event.id, payload);
      await routeTelegramNotificationEvent(client, event);
    } else if (event.eventType === "shift.discrepancy_alert") {
      await routeTelegramNotificationEvent(client, event);
    } else if (event.eventType === "stock.changed") {
      await handleStockChanged(client, event.id, payload);
    } else if (event.eventType === "stock.found") {
      await handleStockFound(client, payload);
    } else if (event.eventType === "purchase_order.received") {
      await handlePurchaseOrderReceived(client, event.id, payload);
    } else if (event.eventType === "telegram.notification.requested") {
      await handleTelegramNotificationRequested(client, event.id, payload);
    }
  });
}

async function handleOrderCorrected(client: PoolClient, eventId: string, payload: Record<string, unknown>) {
  const correctionId = String(payload.correctionId || "");
  const orderId = String(payload.orderId || "");
  const totalDelta = Number(payload.totalDelta || 0);
  if (!correctionId || !orderId) return;

  const exists = await queryOne(client, `
    SELECT id FROM accounting.journal_entries
    WHERE reference_type = 'order_correction' AND reference_id = $1
  `, [correctionId]);
  if (!exists) {
    const before = (payload.beforeTotals || {}) as Record<string, unknown>;
    const after = (payload.afterTotals || {}) as Record<string, unknown>;
    const v2=before.commercialCalculationVersion===2||after.commercialCalculationVersion===2;
    if(v2){
      const frozenBefore=totalsFromMetadataV2(before),frozenAfter=totalsFromMetadataV2(after);
      if(frozenAfter.total-frozenBefore.total!==totalDelta)throw new Error("correction total differs from frozen fee snapshots");
    }
    const merchandiseRevenueDelta = Number(after.merchandiseRevenue || 0) - Number(before.merchandiseRevenue || 0);
    const shippingRevenueDelta = Number(after.shippingRevenue || 0) - Number(before.shippingRevenue || 0);
    const paymentFeeRevenueDelta = v2 ? Number(after.paymentFeeRevenueMinor)-Number(before.paymentFeeRevenueMinor) : 0;
    const taxDelta = Number(after.tax || 0) - Number(before.tax || 0);
    const cogsDelta = Number(payload.cogsDelta || 0);
    const accountCode = paymentAccountForMethod(payload.paymentMethod);
    const lines = [
      ...(totalDelta > 0
        ? [{ accountCode, debitAmount: totalDelta, creditAmount: 0, description: "Order correction collection" }]
        : totalDelta < 0 ? [{
            accountCode: CUSTOMER_REFUND_PAYABLE_ACCOUNT,
            debitAmount: 0,
            creditAmount: Math.abs(totalDelta),
            description: "Order correction customer refund payable",
          }] : []),
      ...signedRevenueLine("5111", merchandiseRevenueDelta, "Order correction merchandise revenue"),
      ...signedRevenueLine("5112", shippingRevenueDelta, "Order correction shipping revenue"),
      ...signedRevenueLine("5113", paymentFeeRevenueDelta, "Order correction payment fee revenue"),
      ...signedRevenueLine("3331", taxDelta, "Order correction VAT"),
      ...(cogsDelta > 0 ? [
        { accountCode: "6321", debitAmount: cogsDelta, creditAmount: 0, description: "Order correction COGS" },
        { accountCode: "1561", debitAmount: 0, creditAmount: cogsDelta, description: "Order correction inventory" },
      ] : cogsDelta < 0 ? [
        { accountCode: "1561", debitAmount: Math.abs(cogsDelta), creditAmount: 0, description: "Order correction inventory return" },
        { accountCode: "6321", debitAmount: 0, creditAmount: Math.abs(cogsDelta), description: "Order correction COGS reversal" },
      ] : []),
    ];
    if (lines.length > 0) await insertJournalEntryForClient(client, {
      entryDate: new Date().toISOString().slice(0, 10),
      referenceType: "order_correction",
      referenceId: correctionId,
      description: `Điều chỉnh đơn - ${payload.orderNumber || orderId}`,
      status: "posted",
      createdBy: String(payload.operatorId || "system"),
      merchantId: typeof payload.merchantId === "string" ? payload.merchantId : null,
      storeId: typeof payload.storeId === "string" ? payload.storeId : null,
      lines,
    });
  }

  if (totalDelta < 0) {
    await postCustomerRefundPayoutJournal(client, {
      paymentEventId: String(payload.canonicalRefundPaymentEventId || ""),
      amount: Math.abs(totalDelta),
      paymentMethod: payload.paymentMethod,
      orderId,
      orderNumber: payload.orderNumber,
      operatorId: payload.operatorId,
      merchantId: payload.merchantId,
      storeId: payload.storeId,
    });
  }

  const customerId = String(payload.customerId || "");
  const loyaltyBaseDelta = Number(payload.loyaltyBaseDelta || 0);
  if (!customerId || loyaltyBaseDelta === 0) return;
  const duplicate = await queryOne(client, "SELECT id FROM ai_module.loyalty_records WHERE source_event_id = $1::uuid", [eventId]);
  if (duplicate) return;
  const points = calculateLoyaltyPoints(Math.abs(loyaltyBaseDelta));
  const merchantId = String(payload.merchantId || "");
  if (!merchantId) throw new Error("order.corrected payload is missing merchantId");
  const tiers = await getLoyaltyTiersForClient(client, merchantId);
  const current = await getCustomerPointTotal(client, customerId, merchantId);
  const tier = evaluateTier(current + (loyaltyBaseDelta > 0 ? points : -points), tiers);
  await client.query(`
    INSERT INTO ai_module.customer_profiles (customer_id, total_spent, order_count, merchant_id)
    VALUES ($1, $2, 0, $3)
    ON CONFLICT (customer_id) DO UPDATE SET
      total_spent = GREATEST(0, ai_module.customer_profiles.total_spent + EXCLUDED.total_spent),
      updated_at = now()
    WHERE ai_module.customer_profiles.merchant_id = EXCLUDED.merchant_id
  `, [customerId, Number(payload.totalDelta || 0), merchantId]);
  await client.query(`
    INSERT INTO ai_module.loyalty_records (
      customer_id, source_event_id, order_id, points_earned, points_redeemed, tier_at_time, description, merchant_id
    ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8)
  `, [
    customerId,
    eventId,
    orderId,
    loyaltyBaseDelta > 0 ? points : 0,
    loyaltyBaseDelta < 0 ? points : 0,
    tier,
    `Order correction ${payload.correctionId || ""}`,
    merchantId,
  ]);
}

function paymentFeeRevenueFromSale(payload: Record<string, unknown>): number {
  if (payload.commercialCalculationVersion !== 2) {
    if (Object.keys(payload).some(key => key.startsWith("paymentFee"))) throw new Error("Sale payment fee version is invalid");
    return 0;
  }
  try {
    const c = OrderCommercialComponentsV2Schema.parse({ taxMode: payload.taxMode,
      merchandiseGrossMinor: payload.subtotal, discountMinor: payload.discount, merchandiseNetMinor: payload.merchandisePayable,
      shippingMinor: payload.shippingFee, merchandiseVatMinor: payload.merchandiseTax, shippingVatMinor: payload.shippingTax,
      paymentFeeMinor: payload.paymentFeeMinor, paymentFeeVatMinor: payload.paymentFeeVatMinor,
      vatMinor: payload.tax, unclassifiedMinor: 0, totalMinor: payload.total });
    const context = { taxMode: c.taxMode, vatRatePpm: payload.vatRatePpm as number };
    const fee = resolvePaymentFee(c.merchandiseNetMinor, { paymentFeeType: payload.paymentFeeType as "percent" | "amount", paymentFeeValue: payload.paymentFeeValue as number }, context);
    if (fee.paymentFeeMinor !== c.paymentFeeMinor || fee.paymentFeeVatMinor !== c.paymentFeeVatMinor
      || fee.paymentFeeBasisMinor !== payload.paymentFeeBasisMinor || fee.paymentFeeRevenueMinor !== payload.paymentFeeRevenueMinor
      || calculateVatMinor(c.merchandiseNetMinor,context) !== c.merchandiseVatMinor
      || calculateVatMinor(c.shippingMinor,context) !== c.shippingVatMinor
      || payload.merchandiseRevenue !== c.merchandiseNetMinor - (c.taxMode === "inclusive" ? c.merchandiseVatMinor : 0)
      || payload.shippingRevenue !== c.shippingMinor - (c.taxMode === "inclusive" ? c.shippingVatMinor : 0)
      || payload.loyaltyBase !== c.merchandiseNetMinor) throw new Error("snapshot drift");
    return fee.paymentFeeRevenueMinor;
  } catch {
    throw new Error("Sale payment fee snapshot is invalid");
  }
}

async function handleSaleCreated(client: PoolClient, eventId: string, payload: Record<string, unknown>) {
  const paymentFeeRevenue = paymentFeeRevenueFromSale(payload);
  const orderId = String(payload.orderId || "");
  const exists = await queryOne(client, "SELECT id FROM accounting.journal_entries WHERE reference_type = 'order' AND reference_id = $1", [orderId]);
  let saleJournalEntryId = exists ? String((exists as { id?: unknown }).id || "") : "";
  if (!exists) {
    const total = Number(payload.total || 0);
    const tax = Number(payload.tax || 0);
    const shippingRevenue = Number(payload.shippingRevenue || 0);
    const merchandiseRevenue = Number(
      payload.merchandiseRevenue ?? Math.max(0, total - tax - shippingRevenue - paymentFeeRevenue),
    );
    const cogs = Number(payload.cogs || 0);
    const isVerifiedRetailCryptoSale = String(payload.paymentProvider || "") === "nowpayments"
      && ["usdttrc20", "usdcmatic"].includes(String(payload.providerPayCurrency || "").toLowerCase());
    const debitAccount = isVerifiedRetailCryptoSale ? "1122" : paymentAccountForMethod(payload.paymentMethod);
    const lines = [
      ...(total !== 0 ? [{ accountCode: debitAccount, debitAmount: total, creditAmount: 0, description: "Payment" }] : []),
      ...(merchandiseRevenue > 0 ? [
        { accountCode: "5111", debitAmount: 0, creditAmount: merchandiseRevenue, description: "Merchandise revenue" },
      ] : []),
      ...(shippingRevenue > 0 ? [
        { accountCode: "5112", debitAmount: 0, creditAmount: shippingRevenue, description: "Shipping revenue" },
      ] : []),
      ...(paymentFeeRevenue > 0 ? [
        { accountCode: "5113", debitAmount: 0, creditAmount: paymentFeeRevenue, description: "Payment fee revenue" },
      ] : []),
      ...(tax > 0 ? [{ accountCode: "3331", debitAmount: 0, creditAmount: tax, description: "Output VAT" }] : []),
      ...(cogs > 0 ? [
        { accountCode: "6321", debitAmount: cogs, creditAmount: 0, description: "COGS" },
        { accountCode: "1561", debitAmount: 0, creditAmount: cogs, description: "Inventory" },
      ] : []),
    ];
    // A zero-value order can still consume inventory with a known cost. Post
    // that cost movement, and let an entirely zero-value event complete without
    // inventing a payment or an empty accounting journal.
    if (lines.length > 0) {
      const entry = await insertJournalEntryForClient(client, {
        entryDate: new Date().toISOString().slice(0, 10),
        referenceType: "order",
        referenceId: orderId,
        description: `Bán hàng - ${payload.orderNumber || orderId}`,
        status: "posted",
        createdBy: "system",
        merchantId: typeof payload.merchantId === "string" ? payload.merchantId : null,
        storeId: typeof payload.storeId === "string" ? payload.storeId : null,
        lines,
      });
      saleJournalEntryId = String(entry.id || "");
    }
  }
  await persistCryptoReceiptEvidenceFromSaleForClient(client, payload, saleJournalEntryId || null);

  const customerId = String(payload.customerId || "");
  if (customerId) {
    const duplicateLoyalty = await queryOne(client, "SELECT id FROM ai_module.loyalty_records WHERE source_event_id = $1::uuid", [eventId]);
    if (!duplicateLoyalty) {
      const points = calculateLoyaltyPoints(Number(payload.loyaltyBase ?? payload.total ?? 0));
      const merchantId = String(payload.merchantId || "");
      if (!merchantId) throw new Error("sale.created payload is missing merchantId");
      const tiers = await getLoyaltyTiersForClient(client, merchantId);
      const current = await getCustomerPointTotal(client, customerId, merchantId);
      const tier = evaluateTier(current + points, tiers);
      await client.query(`
        INSERT INTO ai_module.customer_profiles (customer_id, total_spent, order_count, merchant_id)
        VALUES ($1, $2, 1, $3)
        ON CONFLICT (customer_id) DO UPDATE SET
          total_spent = ai_module.customer_profiles.total_spent + EXCLUDED.total_spent,
          order_count = ai_module.customer_profiles.order_count + 1,
          last_purchase_at = now(),
          updated_at = now()
        WHERE ai_module.customer_profiles.merchant_id = EXCLUDED.merchant_id
      `, [customerId, Number(payload.total || 0), merchantId]);
      await client.query(`
        INSERT INTO ai_module.loyalty_records (customer_id, source_event_id, order_id, points_earned, tier_at_time, description, merchant_id)
        VALUES ($1, $2::uuid, $3, $4, $5, $6, $7)
      `, [customerId, eventId, orderId, points, tier, `Order ${payload.orderNumber || orderId}`, merchantId]);
      await upsertAiActionForClient(client, {
        sourceEventId: eventId,
        actionType: "loyalty_recommendation",
        status: "completed",
        customerId,
        orderId,
        outputPayload: {
          recommendations: buildLoyaltyRecommendations(tier, points),
          tier,
          pointsEarned: points,
        },
        confidence: 0.84,
        riskLevel: "low",
        merchantId,
        storeId: typeof payload.storeId === "string" ? payload.storeId : undefined,
      });
    }
  }
}

async function handleShippingAdjusted(client: PoolClient, eventId: string, payload: Record<string, unknown>) {
  const orderId = String(payload.orderId || "");
  const rawReferenceId = String(payload.paymentEntryId || payload.refundEntryId || eventId);
  const referenceId = `${orderId}:${rawReferenceId}`;
  const delta = Number(payload.delta || 0);
  if (!orderId || delta === 0) return;

  const exists = await queryOne(
    client,
    "SELECT id FROM accounting.journal_entries WHERE reference_type = 'order_shipping_adjustment' AND reference_id = $1",
    [referenceId],
  );
  if (!exists) {
    const shippingRevenueDelta = Number(payload.shippingRevenueDelta || 0);
    const shippingTaxDelta = Number(payload.shippingTaxDelta || 0);
    const accountCode = paymentAccountForMethod(payload.paymentMethod);
    const lines = delta > 0
      ? [
          { accountCode, debitAmount: Math.abs(delta), creditAmount: 0, description: "Shipping fee collected" },
          ...(shippingRevenueDelta !== 0 ? [{
            accountCode: "5112",
            debitAmount: 0,
            creditAmount: Math.abs(shippingRevenueDelta),
            description: "Shipping revenue adjustment",
          }] : []),
          ...(shippingTaxDelta !== 0 ? [{
            accountCode: "3331",
            debitAmount: 0,
            creditAmount: Math.abs(shippingTaxDelta),
            description: "Shipping VAT adjustment",
          }] : []),
        ]
      : [
          ...(shippingRevenueDelta !== 0 ? [{
            accountCode: "5112",
            debitAmount: Math.abs(shippingRevenueDelta),
            creditAmount: 0,
            description: "Shipping revenue reversal",
          }] : []),
          ...(shippingTaxDelta !== 0 ? [{
            accountCode: "3331",
            debitAmount: Math.abs(shippingTaxDelta),
            creditAmount: 0,
            description: "Shipping VAT reversal",
          }] : []),
          { accountCode, debitAmount: 0, creditAmount: Math.abs(delta), description: "Shipping refund" },
        ];
    await insertJournalEntryForClient(client, {
      entryDate: new Date().toISOString().slice(0, 10),
      referenceType: "order_shipping_adjustment",
      referenceId,
      description: `Dieu chinh phi van chuyen - ${payload.orderNumber || orderId}`,
      status: "posted",
      createdBy: String(payload.operatorId || "system"),
      merchantId: typeof payload.merchantId === "string" ? payload.merchantId : null,
      storeId: typeof payload.storeId === "string" ? payload.storeId : null,
      lines,
    });

    const customerId = String(payload.customerId || "");
    if (customerId) {
      const merchantId = String(payload.merchantId || "");
      if (!merchantId) throw new Error("order.shipping_adjusted payload is missing merchantId");
      await client.query(`
        INSERT INTO ai_module.customer_profiles (customer_id, total_spent, order_count, merchant_id)
        VALUES ($1, $2, 0, $3)
        ON CONFLICT (customer_id) DO UPDATE SET
          total_spent = GREATEST(0, ai_module.customer_profiles.total_spent + EXCLUDED.total_spent),
          updated_at = now()
        WHERE ai_module.customer_profiles.merchant_id = EXCLUDED.merchant_id
      `, [customerId, delta, merchantId]);
    }
  }
}

async function getCustomerPointTotal(client: PoolClient, customerId: string, merchantId: string): Promise<number> {
  const row = await queryOne<{ points: string }>(client, `
    SELECT COALESCE(SUM(points_earned - points_redeemed), 0)::numeric AS points
    FROM ai_module.loyalty_records
    WHERE customer_id = $1 AND merchant_id = $2
  `, [customerId, merchantId]);
  return Number(row?.points || 0);
}

async function handleSaleCancelled(client: PoolClient, eventId: string, payload: Record<string, unknown>) {
  const orderId = String(payload.orderId || "");
  const exists = await queryOne(client, "SELECT id FROM accounting.journal_entries WHERE reference_type = 'order_cancellation' AND reference_id = $1", [orderId]);
  if (!exists) {
    const revision = await queryOne<{ component_version: number }>(client, `
      SELECT COALESCE((to_jsonb(components)->>'component_version')::int,1) AS component_version
      FROM app.order_commercial_revisions revisions
      JOIN app.order_commercial_revision_components components ON components.revision_id = revisions.id
      WHERE revisions.id::text = $1 AND revisions.order_id = $2
        AND revisions.merchant_id = $3 AND revisions.store_id = $4 AND revisions.commercial_state = 'cancelled'
    `, [String(payload.commercialRevisionId || ""), orderId, payload.merchantId, payload.storeId]);
    if(revision?.component_version===2){
      const pendingCorrection=await queryOne(client,`SELECT corrections.id FROM app.order_corrections corrections
        WHERE corrections.order_id=$1 AND corrections.status='applied'
          AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries entries WHERE entries.reference_type='order_correction'
            AND entries.reference_id=corrections.id::text AND entries.status='posted')
          AND (corrections.total_delta<>0 OR EXISTS(
            SELECT 1 FROM unnest(ARRAY['merchandiseRevenue','shippingRevenue','paymentFeeRevenueMinor','tax']) AS component(field)
            WHERE COALESCE((corrections.before_totals->>component.field)::numeric,0)
              <>COALESCE((corrections.after_totals->>component.field)::numeric,0)
          ) OR COALESCE((SELECT SUM(items.quantity_delta*items.cost_price) FROM app.order_correction_items items
            WHERE items.correction_id=corrections.id),0)<>0)
        LIMIT 1`,[orderId]);
      if(pendingCorrection)throw new Error("cancellation is waiting for correction accounting");
    }
    const previouslyReversed = revision?.component_version === 2
      ? await readPriorRefundReversalsForClientV2(client,{merchantId:String(payload.merchantId),storeId:String(payload.storeId),orderId})
      : zeroRefundComponentsV2();
    const original = await client.query(`
      SELECT a.code, jl.debit_amount, jl.credit_amount, jl.description
      FROM accounting.journal_entries je
      JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
      JOIN accounting.accounts a ON a.id = jl.account_id
      WHERE je.status = 'posted'
        AND (
          (je.reference_type = 'order' AND je.reference_id = $1)
          OR (
            je.reference_type = 'order_correction'
            AND EXISTS (
              SELECT 1 FROM app.order_corrections corrections
              WHERE corrections.id::text = je.reference_id
                AND corrections.order_id = $1
            )
          )
        )
    `, [orderId]);
    if (revision?.component_version === 2 && original.rows.length === 0) {
      throw new Error("cancellation is waiting for original accounting recognition");
    }
    if (original.rows.length) {
      const reversalAmount = Object.values(previouslyReversed).reduce((sum,value)=>sum+value,0);
      if (!Number.isSafeInteger(reversalAmount)) throw new Error("cancellation refund accounting overflow");
      const refundOffsets = reversalAmount > 0 ? [
        ...signedRevenueLine("5111",previouslyReversed.merchandiseRevenueMinor,"Already refunded merchandise"),
        ...signedRevenueLine("5112",previouslyReversed.shippingRevenueMinor,"Already refunded shipping"),
        ...signedRevenueLine("5113",previouslyReversed.paymentFeeRevenueMinor,"Already refunded payment fee"),
        ...signedRevenueLine("3331",previouslyReversed.vatMinor,"Already refunded VAT"),
        {accountCode:CUSTOMER_REFUND_PAYABLE_ACCOUNT,debitAmount:reversalAmount,creditAmount:0,description:"Exclude prior refund reversal"},
      ] : [];
      await insertJournalEntryForClient(client, {
        entryDate: new Date().toISOString().slice(0, 10),
        referenceType: "order_cancellation",
        referenceId: orderId,
        description: `Hủy đơn - ${orderId}`,
        status: "posted",
        createdBy: "system",
        merchantId: typeof payload.merchantId === "string" ? payload.merchantId : null,
        storeId: typeof payload.storeId === "string" ? payload.storeId : null,
        lines: [...original.rows.map((row) => {
          const originalDebit = Number(row.debit_amount || 0);
          if (COLLECTION_ASSET_ACCOUNTS.has(String(row.code)) && originalDebit > 0) {
            return {
              accountCode: CUSTOMER_REFUND_PAYABLE_ACCOUNT,
              debitAmount: 0,
              creditAmount: originalDebit,
              description: `Customer refund payable for ${row.description || "collection"}`,
            };
          }
          return {
            accountCode: row.code,
            debitAmount: Number(row.credit_amount || 0),
            creditAmount: originalDebit,
            description: `Reverse ${row.description || ""}`,
          };
        }), ...refundOffsets],
      });

      const customerId = String(payload.customerId || "");
      if (customerId) {
        const merchantId = String(payload.merchantId || "");
        if (!merchantId) throw new Error("sale.cancelled payload is missing merchantId");
        await client.query(`
          INSERT INTO ai_module.customer_profiles (customer_id, total_spent, order_count, merchant_id)
          VALUES ($1, 0, 0, $3)
          ON CONFLICT (customer_id) DO UPDATE SET
            total_spent = GREATEST(0, ai_module.customer_profiles.total_spent - $2),
            order_count = GREATEST(0, ai_module.customer_profiles.order_count - 1),
            updated_at = now()
          WHERE ai_module.customer_profiles.merchant_id = EXCLUDED.merchant_id
        `, [customerId, Math.max(0, Number(payload.total || 0)), merchantId]);
      }
    }
  }
  const customerId = String(payload.customerId || "");
  if (customerId) {
    const merchantId = String(payload.merchantId || "");
    if (!merchantId) throw new Error("sale.cancelled payload is missing merchantId");
    const points = await client.query(
      "SELECT COALESCE(SUM(points_earned), 0)::int AS points FROM ai_module.loyalty_records WHERE order_id = $1 AND merchant_id = $2",
      [orderId, merchantId],
    );
    const amount = Number(points.rows[0]?.points || 0);
    if (amount > 0) {
      await client.query(`
        INSERT INTO ai_module.loyalty_records (
          customer_id, source_event_id, order_id, points_earned, points_redeemed,
          tier_at_time, description, merchant_id
        )
        VALUES ($1, $2::uuid, $3, 0, $4, 'bronze', 'Order cancellation', $5)
        ON CONFLICT (source_event_id) DO NOTHING
      `, [customerId, eventId, orderId, amount, merchantId]);
    }
  }
}

async function handleStockChanged(client: PoolClient, eventId: string, payload: Record<string, unknown>) {
  await syncInventoryAlertForStockChange(client, eventId, payload);
}

async function handleStockFound(client: PoolClient, payload: Record<string, unknown>) {
  const orderId = String(payload.orderId || "");
  const inventoryValue = Number(payload.inventoryValue || 0);
  if (!orderId || inventoryValue <= 0) return;

  const exists = await queryOne(client, "SELECT id FROM accounting.journal_entries WHERE reference_type = 'stock_found' AND reference_id = $1", [orderId]);
  if (!exists) {
    await insertJournalEntryForClient(client, {
      entryDate: new Date().toISOString().slice(0, 10),
      referenceType: "stock_found",
      referenceId: orderId,
      description: `Tìm thấy hàng khi bán - ${payload.orderNumber || orderId}`,
      status: "posted",
      createdBy: String(payload.operatorId || "system"),
      merchantId: typeof payload.merchantId === "string" ? payload.merchantId : null,
      storeId: typeof payload.storeId === "string" ? payload.storeId : null,
      lines: [
        { accountCode: "1561", debitAmount: inventoryValue, creditAmount: 0, description: "Found stock inventory increase" },
        { accountCode: "7111", debitAmount: 0, creditAmount: inventoryValue, description: "Inventory variance income" },
      ],
    });
  }
}

async function handlePurchaseOrderReceived(client: PoolClient, _eventId: string, payload: Record<string, unknown>) {
  const purchaseOrderId = String(payload.purchaseOrderId || "");
  const receiptId = typeof payload.receiptId === "string" && payload.receiptId.trim() ? payload.receiptId.trim() : "";
  const inventoryValue = Number(payload.inventoryValue || 0);
  if (inventoryValue <= 0) return;
  const referenceType = receiptId ? "purchase_order_receipt" : "purchase_order";
  const referenceId = receiptId || purchaseOrderId;
  const exists = await queryOne(client, "SELECT id FROM accounting.journal_entries WHERE reference_type = $1 AND reference_id = $2", [referenceType, referenceId]);
  if (!exists) {
    await insertJournalEntryForClient(client, {
      entryDate: new Date().toISOString().slice(0, 10),
      referenceType,
      referenceId,
      description: receiptId ? `Nhập hàng - ${purchaseOrderId} / ${receiptId}` : `Nhập hàng - ${purchaseOrderId}`,
      status: "posted",
      createdBy: "system",
      merchantId: typeof payload.merchantId === "string" ? payload.merchantId : null,
      storeId: typeof payload.storeId === "string" ? payload.storeId : null,
      lines: [
        { accountCode: "1561", debitAmount: inventoryValue, creditAmount: 0, description: "Inventory receipt" },
        { accountCode: "3311", debitAmount: 0, creditAmount: inventoryValue, description: "Accounts payable" },
      ],
    });
  }
}
