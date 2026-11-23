import type { PoolClient } from "../db/client";
import { queryOne } from "../db/query";
import { insertJournalEntryForClient } from "./accounting-service";
import { paymentAccountForMethod } from "./payment-service";
import { PlatformError } from "../errors/platform-error";
import { readFrozenRefundAllocationV2 } from "./refund-component-allocation";

function invalidLineage(): never {
  throw new PlatformError(
    "financial_invariant_error",
    "Canonical refund accounting lineage does not match its payout",
    409,
  );
}

function splitRefundAmount(amount: number, metadata: Record<string, unknown>) {
  const orderTotal = Number(metadata.total || 0);
  const orderTax = Number(metadata.tax || 0);
  const tax =
    orderTotal > 0 && orderTax > 0
      ? Math.min(amount, Math.round(amount * (orderTax / orderTotal)))
      : 0;
  const postTax = amount - tax;
  const merchandiseRevenueBase = Number(
    metadata.merchandiseRevenue ||
      Math.max(
        0,
        Number(metadata.subtotal || 0) -
          Number(metadata.discount || 0) -
          Number(metadata.merchandiseTax || 0),
      ),
  );
  const shippingRevenueBase = Number(metadata.shippingRevenue || 0);
  const revenueBase = merchandiseRevenueBase + shippingRevenueBase;
  const shippingRevenue =
    revenueBase > 0
      ? Math.min(
          postTax,
          Math.round(postTax * (shippingRevenueBase / revenueBase)),
        )
      : 0;
  const merchandiseRevenue = postTax - shippingRevenue;
  return {
    tax,
    merchandiseRevenue,
    shippingRevenue,
  };
}

export async function handleRefundCreated(
  client: PoolClient,
  eventId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const orderId = String(payload.orderId || "");
  const paymentEntryId = String(payload.paymentEntryId || eventId);
  const amount = Number(payload.amount || 0);
  if (!orderId || amount <= 0) return;

  const exists = await queryOne(
    client,
    "SELECT id FROM accounting.journal_entries WHERE reference_type = 'refund' AND reference_id = $1",
    [paymentEntryId],
  );
  if (exists) return;

  const order = await queryOne<{
    order_number: string;
    status: string;
    metadata: Record<string, unknown>;
    merchant_id: string | null;
    store_id: string | null;
  }>(
    client,
    `
    SELECT COALESCE(custom_display_id, 'ORD-' || display_id::text) AS order_number,
           status::text, metadata, merchant_id, store_id
    FROM public."order"
    WHERE id = $1 AND deleted_at IS NULL
  `,
    [orderId],
  );
  if (!order) return;

  const charge = await queryOne<{ method: string }>(
    client,
    `
    SELECT method
    FROM app.payment_entries
    WHERE order_id = $1 AND direction = 'charge' AND status = 'posted'
    ORDER BY created_at ASC
    LIMIT 1
  `,
    [orderId],
  );

  const canonicalPaymentEventId = String(
    payload.canonicalPaymentEventId || paymentEntryId,
  );
  const refund = await queryOne<{
    merchant_id: string;
    store_id: string;
    order_id: string;
    amount_minor: string;
    metadata: Record<string, unknown>;
    component_version: number;
    method: string;
  }>(
    client,
    `
    SELECT events.merchant_id, events.store_id, events.order_id, events.amount_minor::text, events.metadata, events.method,
      COALESCE((to_jsonb(components)->>'component_version')::int, 1) AS component_version
    FROM app.payment_events events
    JOIN app.order_commercial_revision_components components ON components.revision_id = events.commercial_revision_id
    WHERE events.id::text = $1 AND events.kind = 'refund' AND events.status = 'posted'
  `,
    [canonicalPaymentEventId],
  );
  const frozen = refund?.metadata.refundAllocationV2
    ? readFrozenRefundAllocationV2(refund.metadata.refundAllocationV2)
    : undefined;
  if (
    refund &&
    (refund.merchant_id !== order.merchant_id ||
      refund.store_id !== order.store_id ||
      refund.order_id !== orderId ||
      Number(refund.amount_minor) !== amount)
  )
    invalidLineage();
  if (
    (refund?.component_version === 2 ||
      (!refund && order.metadata?.commercialCalculationVersion === 2)) &&
    !frozen
  )
    invalidLineage();
  if (
    refund &&
    refund.component_version !== 1 &&
    refund.component_version !== 2
  )
    invalidLineage();
  if (frozen) {
    if (
      !refund ||
      refund.merchant_id !== order.merchant_id ||
      refund.store_id !== order.store_id ||
      refund.order_id !== orderId ||
      Number(refund.amount_minor) !== amount ||
      frozen.amountMinor !== amount ||
      payload.merchantId !== order.merchant_id ||
      payload.storeId !== order.store_id
    )
      invalidLineage();
    const mirror = await queryOne(
      client,
      `
      SELECT id FROM app.payment_entries
      WHERE id::text=$1 AND merchant_id=$2 AND store_id=$3 AND order_id=$4
        AND direction='refund' AND status='posted' AND amount=$5
        AND metadata->>'canonicalPaymentEventId'=$6
    `,
      [
        paymentEntryId,
        order.merchant_id,
        order.store_id,
        orderId,
        amount,
        canonicalPaymentEventId,
      ],
    );
    if (!mirror) invalidLineage();
    const payableRows = await client.query(
      `
      SELECT allocations.payable_id::text AS payable_id, allocations.amount_minor::text,
        payables.payable_kind, payables.commercial_revision_id::text, payables.source_type, payables.source_id
      FROM app.customer_refund_payout_allocations allocations
      JOIN app.customer_refund_payables payables ON payables.id = allocations.payable_id
      WHERE allocations.payment_event_id = $1
    `,
      [canonicalPaymentEventId],
    );
    if (payableRows.rows.length !== frozen.payableAllocations.length)
      invalidLineage();
    for (const part of frozen.payableAllocations) {
      const row = payableRows.rows.find(
        (row) => row.payable_id === part.payableId,
      );
      if (
        !row ||
        Number(row.amount_minor) !== part.amountMinor ||
        row.payable_kind !== part.payableKind ||
        row.commercial_revision_id !== part.commercialRevisionId ||
        row.source_type !== part.sourceType ||
        row.source_id !== part.sourceId
      )
        invalidLineage();
    }
    const obligationRows = await client.query(
      `
      SELECT obligation_id::text, amount_minor::text FROM app.payment_event_allocations
      WHERE payment_event_id = $1 AND allocation_kind = 'refund'
    `,
      [canonicalPaymentEventId],
    );
    if (obligationRows.rows.length !== frozen.obligationAllocations.length)
      invalidLineage();
    for (const part of frozen.obligationAllocations) {
      const row = obligationRows.rows.find(
        (row) => row.obligation_id === part.obligationId,
      );
      if (!row || Number(row.amount_minor) !== part.amountMinor)
        invalidLineage();
    }
  }

  const canonical = frozen
    ? null
    : await queryOne<{
        tax_mode: "inclusive" | "exclusive";
        merchandise_net_minor: string;
        shipping_minor: string;
        merchandise_vat_minor: string;
        shipping_vat_minor: string;
        vat_minor: string;
        total_minor: string;
      }>(
        client,
        `
    SELECT components.tax_mode, components.merchandise_net_minor::text,
           components.shipping_minor::text, components.merchandise_vat_minor::text,
           components.shipping_vat_minor::text, components.vat_minor::text,
           components.total_minor::text
    FROM app.order_commercial_revisions revisions
    JOIN app.order_commercial_revision_components components
      ON components.revision_id = revisions.id
    WHERE revisions.merchant_id = $1 AND revisions.store_id = $2
      AND revisions.order_id = $3
    ORDER BY revisions.revision DESC, revisions.effective_at DESC, revisions.id DESC
    LIMIT 1
  `,
        [order.merchant_id, order.store_id, orderId],
      );
  const metadata = { ...(order.metadata || {}) };
  if (canonical) {
    const merchandisePayable = Number(canonical.merchandise_net_minor || 0);
    const shippingPayable = Number(canonical.shipping_minor || 0);
    const merchandiseVat = Number(canonical.merchandise_vat_minor || 0);
    const shippingVat = Number(canonical.shipping_vat_minor || 0);
    metadata.total = Number(canonical.total_minor || 0);
    metadata.tax = Number(canonical.vat_minor || 0);
    metadata.merchandiseRevenue =
      canonical.tax_mode === "inclusive"
        ? Math.max(0, merchandisePayable - merchandiseVat)
        : merchandisePayable;
    metadata.shippingRevenue =
      canonical.tax_mode === "inclusive"
        ? Math.max(0, shippingPayable - shippingVat)
        : shippingPayable;
  }
  const split = frozen
    ? {
        merchandiseRevenue: frozen.reversalComponents.merchandiseRevenueMinor,
        shippingRevenue: frozen.reversalComponents.shippingRevenueMinor,
        paymentFeeRevenue: frozen.reversalComponents.paymentFeeRevenueMinor,
        tax: frozen.reversalComponents.vatMinor,
      }
    : { ...splitRefundAmount(amount, metadata), paymentFeeRevenue: 0 };
  const reversalAmount = frozen ? amount - frozen.settlementOnlyMinor : amount;
  if (frozen ? reversalAmount > 0 : order.status !== "canceled") {
    const lines = [
      ...(split.merchandiseRevenue > 0
        ? [
            {
              accountCode: "5111",
              debitAmount: split.merchandiseRevenue,
              creditAmount: 0,
              description: "Refund revenue reversal",
            },
          ]
        : []),
      ...(split.shippingRevenue > 0
        ? [
            {
              accountCode: "5112",
              debitAmount: split.shippingRevenue,
              creditAmount: 0,
              description: "Refund shipping revenue reversal",
            },
          ]
        : []),
      ...(split.paymentFeeRevenue > 0
        ? [
            {
              accountCode: "5113",
              debitAmount: split.paymentFeeRevenue,
              creditAmount: 0,
              description: "Refund payment fee revenue reversal",
            },
          ]
        : []),
      ...(split.tax > 0
        ? [
            {
              accountCode: "3331",
              debitAmount: split.tax,
              creditAmount: 0,
              description: "Refund VAT reversal",
            },
          ]
        : []),
      {
        accountCode: "CUSTOMER_REFUND_PAYABLE",
        debitAmount: 0,
        creditAmount: reversalAmount,
        description: "Open customer refund payable",
      },
    ];

    await insertJournalEntryForClient(client, {
      entryDate: new Date().toISOString().slice(0, 10),
      referenceType: "refund",
      referenceId: paymentEntryId,
      description: `Nghia vu hoan tien - ${order.order_number || orderId}`,
      status: "posted",
      createdBy: String(payload.operatorId || "system"),
      merchantId: order.merchant_id || undefined,
      storeId: order.store_id || undefined,
      lines,
    });
  }

  const payoutExists = await queryOne(
    client,
    `
    SELECT id FROM accounting.journal_entries
    WHERE reference_type = 'customer_refund_payout' AND reference_id = $1
  `,
    [canonicalPaymentEventId],
  );
  if (!payoutExists) {
    await insertJournalEntryForClient(client, {
      entryDate: new Date().toISOString().slice(0, 10),
      referenceType: "customer_refund_payout",
      referenceId: canonicalPaymentEventId,
      description: `Chi hoan tien - ${order.order_number || orderId}`,
      status: "posted",
      createdBy: String(payload.operatorId || "system"),
      merchantId: order.merchant_id || undefined,
      storeId: order.store_id || undefined,
      lines: [
        {
          accountCode: "CUSTOMER_REFUND_PAYABLE",
          debitAmount: amount,
          creditAmount: 0,
          description: "Clear customer refund payable",
        },
        {
          accountCode: paymentAccountForMethod(
            frozen
              ? refund!.method === "manual_bank"
                ? "bank_transfer"
                : refund!.method
              : payload.paymentMethod ||
                  charge?.method ||
                  metadata.paymentMethod ||
                  "cash",
          ),
          debitAmount: 0,
          creditAmount: amount,
          description: "Customer refund payout",
        },
      ],
    });
  }
}
