import { createHash } from "node:crypto";
import { withScopedIdempotency } from "../db/idempotency";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import {
  withConnectedClient,
  withConnectedTransaction,
} from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import type { HeadersLike } from "../http/headers";
import { recordAuditEntry } from "../repositories/audit-repository";
import { emitExactOutbox } from "../repositories/outbox-repository";
import { recordPaymentEntry } from "../repositories/payment-repository";
import { id } from "../utils/id";
import type { OperatingScope, PaymentFeeInputV1 } from "@medusa-snus/contracts";
import { OrderCorrectionFinancialInputV1Schema } from "@medusa-snus/contracts";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 } from "@medusa-snus/contracts/runtime-capabilities";
import type { OperatorContext } from "./auth-service";
import { assertOperatingMutationTarget } from "./mutation-scope-service";
import {
  calculateOrderTotals,
  calculateOrderTotalsV2,
  commercialAdjustmentContext,
  totalsFromMetadata as totalsFromShared,
  totalsFromMetadataV2,
  paymentFeeFinancialSnapshotV1,
  type NormalizedOrderTotals,
  type NormalizedOrderTotalsV2,
} from "./order-total-service";
import {
  createCorrectionCommercialRevisionTaskV1,
  createCorrectionCommercialRevisionTaskV2,
} from "./correction-commercial-revision-service";
import { PostgresCorrectionCommercialRevisionRepositoryV1 } from "./postgres-correction-commercial-revision-repository";
import {
  buildPositiveCorrectionChargeContractV1,
  buildPositiveCorrectionChargeContractV2,
} from "./payment-positive-correction-charge-contract";
import {
  readPaymentFeeInput,
  vatRatePpmFromRate,
} from "./payment-fee-calculation";
import {
  recordPositiveCorrectionChargeV1,
  type PersistedPositiveCorrectionChargeV1,
  type PositiveCorrectionSettlementMethodV1,
} from "./postgres-positive-correction-charge-repository";
import {
  openCustomerRefundPayableV1,
  recordCustomerRefundPayoutV1,
  type OpenCustomerRefundPayableResultV1,
  type RecordCustomerRefundPayoutResultV1,
} from "./customer-refund-payable-service";
import { recordStockMovement } from "./stock-movement-service";
import { orderCorrectionFinancialPreviewV1, orderCorrectionFinancialResponseV1 } from "./order-correction-payment-fee-presentation";
import {
  buildExactOrderCorrectedEvent,
  buildExactStockChangedEvent,
} from "./exact-outbox-event-builders";

// Stable operation codes used with withScopedIdempotency.
export const CORRECTION_OPS = {
  applyOrderCorrection: "order_correction.apply",
} as const;

type CorrectionFinancialContract = "legacy" | typeof PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1;
function assertCorrectionInputContract(input: OrderCorrectionInput, contract: CorrectionFinancialContract) {
  if ((contract !== "legacy" && contract !== PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1)
    || (contract === "legacy" && Object.keys(input).some(key => key.startsWith("paymentFee")))) {
    throw new PlatformError("unsupported_contract", "A fee-aware correction contract is required", 409);
  }
  if (contract !== "legacy" && !OrderCorrectionFinancialInputV1Schema.safeParse(input).success) {
    throw new PlatformError("validation_error", "Invalid fee-aware correction input", 400);
  }
}
function assertCorrectionTotalsContract(contract: CorrectionFinancialContract, ...totals: Array<NormalizedOrderTotals | NormalizedOrderTotalsV2>) {
  if (contract === "legacy" && totals.some(value => value.commercialAdjustmentVersion === 2 && (value.paymentFeeMinor !== 0 || value.paymentFeeVatMinor !== 0))) {
    throw new PlatformError("unsupported_contract", "A fee-aware correction contract is required for this order", 409);
  }
}

export interface OrderCorrectionInput extends Partial<PaymentFeeInputV1> {
  baseRevision: number;
  confirmationToken?: string;
  reason: string;
  items: Array<{ variantId: string; quantity: number }>;
  /** Final order-level shipping fee after the correction, in minor units. */
  shippingFee?: number;
  settlement?: {
    method?: "cash" | "bank_transfer" | "cod" | string;
    amountReceived?: number;
  };
}

type Totals = NormalizedOrderTotals | NormalizedOrderTotalsV2;

type EffectiveLine = {
  variantId: string;
  productId: string;
  productTitle: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  costPrice: number;
};

type CatalogLine = Omit<EffectiveLine, "unitPrice"> & {
  unitPrice: number | null;
  inventoryItemId: string;
  inventoryLevelId: string;
  stock: number;
  reorderLevel: number;
};

function numeric(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function totalsFrom(value: Record<string, unknown>): Totals {
  if (
    [
      value.commercialAdjustmentVersion,
      value.commercialCalculationVersion,
    ].some((version) => version !== undefined && version !== 1 && version !== 2)
  ) {
    throw new PlatformError(
      "financial_invariant_error",
      "Unsupported persisted commercial version",
      409,
    );
  }
  if (
    value.commercialAdjustmentVersion === 2 ||
    value.commercialCalculationVersion === 2
  )
    return totalsFromMetadataV2(value);
  return totalsFromShared(value);
}

function validCorrectionReason(value: unknown): string {
  const reason = String(value || "").trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new PlatformError(
      "validation_error",
      "Correction reason must be 10 to 500 characters",
      422,
    );
  }
  return reason;
}

function normalizedTargets(
  items: OrderCorrectionInput["items"],
): Map<string, number> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new PlatformError(
      "validation_error",
      "At least one corrected order item is required",
      422,
    );
  }
  const targets = new Map<string, number>();
  for (const item of items) {
    const variantId = String(item?.variantId || "").trim();
    const quantity = Number(item?.quantity);
    if (
      !variantId ||
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      quantity > 99
    ) {
      throw new PlatformError(
        "validation_error",
        "Each correction item requires a variant and quantity from 1 to 99",
        422,
      );
    }
    targets.set(variantId, (targets.get(variantId) || 0) + quantity);
  }
  return targets;
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>) {
  await ensurePlatformSchema();
  return withConnectedClient(fn);
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>) {
  await ensurePlatformSchema();
  return withConnectedTransaction(fn);
}

async function latestCorrection(client: PoolClient, orderId: string) {
  return queryOne<{
    id: string;
    revision: number;
    status: string;
    after_totals: Record<string, unknown>;
    total_delta: string;
    reason: string;
    settlement_method: string | null;
    settlement_payment_entry_id: string | null;
    created_by: string;
    created_at: Date;
  }>(
    client,
    `
    SELECT id, revision, status, after_totals, total_delta::numeric, reason,
           settlement_method, settlement_payment_entry_id::text, created_by, created_at
    FROM app.order_corrections
    WHERE order_id = $1 AND status = 'applied'
    ORDER BY revision DESC
    LIMIT 1
  `,
    [orderId],
  );
}

async function sourceEffectiveLines(
  client: PoolClient,
  orderId: string,
): Promise<EffectiveLine[]> {
  const latest = await latestCorrection(client, orderId);
  if (latest) {
    const corrected = await client.query(
      `
      SELECT variant_id, product_id, product_title, COALESCE(sku, '') AS sku,
             quantity_after, unit_price::numeric, cost_price::numeric
      FROM app.order_correction_items
      WHERE correction_id = $1 AND quantity_after > 0
      ORDER BY created_at ASC
    `,
      [latest.id],
    );
    return corrected.rows.map((row) => ({
      variantId: String(row.variant_id),
      productId: String(row.product_id),
      productTitle: String(row.product_title),
      sku: String(row.sku || ""),
      quantity: numeric(row.quantity_after),
      unitPrice: numeric(row.unit_price),
      costPrice: numeric(row.cost_price),
    }));
  }

  const original = await client.query(
    `
    SELECT
      li.variant_id,
      li.product_id,
      COALESCE(li.product_title, li.title, '') AS product_title,
      COALESCE(li.variant_sku, '') AS sku,
      oi.quantity::numeric AS quantity,
      li.unit_price::numeric AS unit_price,
      COALESCE((li.metadata->>'costPrice')::numeric, ps.cost_price, 0)::numeric AS cost_price
    FROM public.order_item oi
    JOIN public.order_line_item li ON li.id = oi.item_id AND li.deleted_at IS NULL
    LEFT JOIN inventory.product_settings ps ON ps.variant_id = li.variant_id
    WHERE oi.order_id = $1 AND oi.deleted_at IS NULL
    ORDER BY li.created_at ASC
  `,
    [orderId],
  );
  return original.rows.map((row) => ({
    variantId: String(row.variant_id),
    productId: String(row.product_id),
    productTitle: String(row.product_title),
    sku: String(row.sku || ""),
    quantity: numeric(row.quantity),
    unitPrice: numeric(row.unit_price),
    costPrice: numeric(row.cost_price),
  }));
}

async function catalogLine(
  client: PoolClient,
  variantId: string,
  lock: boolean,
  stockLocationId: string,
  merchantId: string,
): Promise<CatalogLine> {
  const row = await queryOne<{
    product_id: string;
    product_title: string;
    variant_id: string;
    sku: string;
    unit_price: string | null;
    cost_price: string;
    inventory_item_id: string;
    inventory_level_id: string;
    stock: string;
    reorder_level: number;
  }>(
    client,
    `
    SELECT
      p.id AS product_id,
      p.title AS product_title,
      v.id AS variant_id,
      COALESCE(v.sku, '') AS sku,
      pr.amount::numeric AS unit_price,
      COALESCE(ps.cost_price, 0)::numeric AS cost_price,
      vii.inventory_item_id,
      il.id AS inventory_level_id,
      il.stocked_quantity::numeric AS stock,
      COALESCE(ps.reorder_level, 5) AS reorder_level
    FROM public.product_variant v
    JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
    LEFT JOIN public.product_variant_price_set vps ON vps.variant_id = v.id AND vps.deleted_at IS NULL
    LEFT JOIN public.price pr ON pr.price_set_id = vps.price_set_id AND pr.currency_code = 'vnd' AND pr.deleted_at IS NULL
    JOIN public.product_variant_inventory_item vii ON vii.variant_id = v.id AND vii.deleted_at IS NULL
    JOIN public.inventory_level il ON il.inventory_item_id = vii.inventory_item_id AND il.deleted_at IS NULL
    LEFT JOIN inventory.product_settings ps ON ps.variant_id = v.id
    WHERE v.id = $1 AND v.deleted_at IS NULL
      AND il.location_id = $2 AND p.merchant_id = $3
    LIMIT 1
    ${lock ? "FOR UPDATE OF il" : ""}
  `,
    [variantId, stockLocationId, merchantId],
  );
  if (!row)
    throw new PlatformError(
      "resource_not_found",
      `Variant not found: ${variantId}`,
      404,
    );
  return {
    variantId: String(row.variant_id),
    productId: String(row.product_id),
    productTitle: String(row.product_title),
    sku: String(row.sku || ""),
    quantity: 0,
    unitPrice: row.unit_price === null ? null : Number(row.unit_price),
    costPrice: numeric(row.cost_price),
    inventoryItemId: String(row.inventory_item_id),
    inventoryLevelId: String(row.inventory_level_id),
    stock: numeric(row.stock),
    reorderLevel: Number(row.reorder_level || 5),
  };
}

async function correctionPlan(
  client: PoolClient,
  orderId: string,
  input: OrderCorrectionInput,
  lock: boolean,
  scope: OperatingScope,
  financialContract: CorrectionFinancialContract,
) {
  const requestedFee = readPaymentFeeInput(input);
  const order = await queryOne<{
    id: string;
    status: string;
    customer_id: string | null;
    custom_display_id: string | null;
    metadata: Record<string, unknown>;
    merchant_id: string | null;
    store_id: string | null;
  }>(
    client,
    `
    SELECT id, status::text, customer_id, custom_display_id, metadata, merchant_id, store_id
    FROM public."order"
    WHERE id = $1 AND deleted_at IS NULL
    ${lock ? "FOR UPDATE" : ""}
  `,
    [orderId],
  );
  if (!order)
    throw new PlatformError("resource_not_found", "Order not found", 404);
  assertOperatingMutationTarget(
    scope,
    { merchantId: order.merchant_id, storeId: order.store_id },
    "Order",
  );
  if (order.status === "canceled") {
    throw new PlatformError(
      "invalid_state_transition",
      "Canceled orders cannot be corrected",
      409,
    );
  }

  const refunds = await client.query(
    `
    SELECT direction, method, status, metadata
    FROM app.payment_entries
    WHERE order_id = $1
    ORDER BY created_at ASC
  `,
    [orderId],
  );
  if (
    refunds.rows.some(
      (payment) =>
        payment.direction === "refund" &&
        payment.status === "posted" &&
        payment.metadata?.source !== "order_correction",
    )
  ) {
    throw new PlatformError(
      "invalid_state_transition",
      "Refunded orders cannot be corrected",
      409,
    );
  }
  const sourcePaymentMethod = String(
    (order.metadata || {}).paymentMethod ||
      refunds.rows.find((payment) => payment.direction === "charge")?.method ||
      "cash",
  );
  if (
    ["sepay_va", "nowpayments", "crypto_usdc", "crypto_usdt"].includes(
      sourcePaymentMethod,
    )
  ) {
    throw new PlatformError(
      "payment_settlement_required",
      "External-provider orders require a new payment intent or manual review before correction",
      409,
    );
  }

  const currentRevision =
    (await latestCorrection(client, orderId))?.revision || 0;
  if (
    !Number.isInteger(input.baseRevision) ||
    input.baseRevision !== currentRevision
  ) {
    throw new PlatformError(
      "order_correction_conflict",
      "Order has changed since this correction was opened",
      409,
      { currentRevision },
    );
  }

  if (financialContract === "legacy") {
    const canonical = await queryOne<{ has_fee: boolean }>(client, `SELECT EXISTS (
      SELECT 1 FROM app.order_commercial_revisions revision
      JOIN app.order_commercial_revision_components components ON components.revision_id=revision.id
      WHERE revision.order_id=$1 AND revision.merchant_id=$2 AND revision.store_id=$3 AND revision.revision=$4
        AND (COALESCE((to_jsonb(components)->>'payment_fee_minor')::bigint,0) <> 0
          OR COALESCE((to_jsonb(components)->>'payment_fee_vat_minor')::bigint,0) <> 0)
    ) AS has_fee`, [orderId, scope.merchantId, scope.storeId, currentRevision]);
    if (canonical?.has_fee) throw new PlatformError("unsupported_contract", "A fee-aware correction contract is required for this order", 409);
  }
  const currentLines = await sourceEffectiveLines(client, orderId);
  const targets = normalizedTargets(input.items);
  const currentByVariant = new Map(
    currentLines.map((line) => [line.variantId, line]),
  );
  const allVariantIds = Array.from(
    new Set([...currentByVariant.keys(), ...targets.keys()]),
  );
  const lines: Array<
    EffectiveLine &
      CatalogLine & {
        quantityBefore: number;
        quantityAfter: number;
        quantityDelta: number;
        stockDelta: number;
      }
  > = [];

  // Resolve under the same parent lock protocol as booking, then lock levels
  // by inventory item. Variant order is not a common lock order when variants
  // share or have differently ordered inventory items.
  if (lock) {
    await client.query(
      "SELECT integration.lock_commerce_inputs($1, $2::text[])",
      [scope.merchantId, allVariantIds],
    );
  }
  const catalogs = await Promise.all(
    allVariantIds.map((variantId) =>
      catalogLine(
        client,
        variantId,
        false,
        scope.stockLocationId,
        scope.merchantId,
      ),
    ),
  );
  catalogs.sort(
    (left, right) =>
      (left.inventoryItemId < right.inventoryItemId
        ? -1
        : left.inventoryItemId > right.inventoryItemId
          ? 1
          : 0) ||
      (targets.get(left.variantId) || 0) -
        (currentByVariant.get(left.variantId)?.quantity || 0) -
        ((targets.get(right.variantId) || 0) -
          (currentByVariant.get(right.variantId)?.quantity || 0)) ||
      (left.variantId < right.variantId
        ? -1
        : left.variantId > right.variantId
          ? 1
          : 0),
  );
  const runningStock = new Map<string, number>();
  for (const resolved of catalogs) {
    const variantId = resolved.variantId;
    const catalog = lock
      ? await catalogLine(
          client,
          variantId,
          true,
          scope.stockLocationId,
          scope.merchantId,
        )
      : resolved;
    catalog.stock = runningStock.get(catalog.inventoryLevelId) ?? catalog.stock;
    const current = currentByVariant.get(variantId);
    const unitPrice = current?.unitPrice ?? catalog.unitPrice;
    if (unitPrice === null || !Number.isSafeInteger(unitPrice) || unitPrice < 0) {
      throw new PlatformError("variant_price_unavailable", "A valid price is required for a new correction item", 409, { variantId });
    }
    const quantityBefore = current?.quantity || 0;
    const quantityAfter = targets.get(variantId) || 0;
    const quantityDelta = quantityAfter - quantityBefore;
    const stockDelta = -quantityDelta;
    if (quantityDelta > 0 && catalog.stock < quantityDelta) {
      throw new PlatformError(
        "insufficient_stock",
        `${catalog.productTitle} has only ${catalog.stock} units available`,
        409,
        {
          shortages: [
            {
              variantId,
              productId: catalog.productId,
              productName: catalog.productTitle,
              sku: catalog.sku,
              systemStock: catalog.stock,
              requestedQuantity: quantityDelta,
              shortageQuantity: quantityDelta - catalog.stock,
            },
          ],
        },
      );
    }
    runningStock.set(catalog.inventoryLevelId, catalog.stock + stockDelta);
    lines.push({
      ...catalog,
      productTitle: current?.productTitle || catalog.productTitle,
      sku: current?.sku || catalog.sku,
      unitPrice,
      costPrice: current?.costPrice ?? catalog.costPrice,
      quantity: quantityAfter,
      quantityBefore,
      quantityAfter,
      quantityDelta,
      stockDelta,
    });
  }

  const beforeTotals = latestCorrection(client, orderId).then((latest) =>
    latest ? totalsFrom(latest.after_totals) : totalsFrom(order.metadata || {}),
  );
  const afterSubtotal = lines.reduce(
    (sum, line) => sum + line.quantityAfter * line.unitPrice,
    0,
  );
  let before = await beforeTotals;
  if (requestedFee && before.commercialAdjustmentVersion === 1) {
    const canonical = await queryOne<Record<string, unknown>>(
      client,
      `SELECT components.* FROM app.order_commercial_revisions revisions
      JOIN app.order_commercial_revision_components components ON components.revision_id=revisions.id
      WHERE revisions.merchant_id=$1 AND revisions.store_id=$2 AND revisions.order_id=$3
        AND revisions.revision=$4 AND revisions.commercial_state='active'
        AND revisions.currency_code='VND' AND revisions.minor_unit_exponent=0`,
      [scope.merchantId, scope.storeId, orderId, currentRevision],
    );
    if (
      !canonical ||
      Number(canonical.component_version ?? 1) !== 1 ||
      Number(canonical.unclassified_minor) !== 0 ||
      Number(canonical.payment_fee_minor ?? 0) !== 0 ||
      Number(canonical.payment_fee_vat_minor ?? 0) !== 0
    ) {
      throw new PlatformError(
        "financial_invariant_error",
        "A complete legacy canonical snapshot is required to add a fee",
        409,
      );
    }
    // Select a context for the new revision only when it preserves every old monetary component.
    const promoted = calculateOrderTotalsV2(
      before.subtotal,
      {
        discountType: before.discountType,
        discountValue: before.discountValue,
        discountPercent: before.discountPercent,
        paymentFeeType: "amount",
        paymentFeeValue: 0,
      },
      before.shippingFee,
      {
        taxMode: canonical.tax_mode as "inclusive" | "exclusive",
        vatRatePpm: vatRatePpmFromRate(commercialAdjustmentContext().vatRate),
      },
    );
    const columns = {
      subtotal: "merchandise_gross_minor",
      discount: "discount_minor",
      merchandisePayable: "merchandise_net_minor",
      shippingFee: "shipping_minor",
      merchandiseTax: "merchandise_vat_minor",
      shippingTax: "shipping_vat_minor",
      tax: "vat_minor",
      total: "total_minor",
    } as const;
    if (
      Object.entries(columns).some(
        ([key, column]) =>
          before[key as keyof typeof columns] !==
            promoted[key as keyof typeof columns] ||
          Number(canonical[column]) !== promoted[key as keyof typeof columns],
      )
    ) {
      throw new PlatformError(
        "financial_invariant_error",
        "Legacy VAT or totals differ from the immutable snapshot; review is required",
        409,
      );
    }
    before = promoted;
  }
  if (
    before.commercialAdjustmentVersion === 2 &&
    input.shippingFee !== undefined &&
    (typeof input.shippingFee !== "number" ||
      !Number.isSafeInteger(input.shippingFee) ||
      input.shippingFee < 0)
  ) {
    throw new PlatformError(
      "validation_error",
      "Shipping fee must be a safe non-negative whole minor-unit amount",
      422,
    );
  }
  const requestedShippingFee =
    input.shippingFee === undefined
      ? before.shippingFee
      : numeric(input.shippingFee);
  if (!Number.isInteger(requestedShippingFee) || requestedShippingFee < 0) {
    throw new PlatformError(
      "validation_error",
      "Shipping fee must be a non-negative whole minor-unit amount",
      422,
    );
  }
  const adjustment = {
    discountType: before.discountType,
    discountValue: before.discountValue,
    discountPercent: before.discountPercent,
    shippingFee: requestedShippingFee,
  };
  const after =
    before.commercialAdjustmentVersion === 2
      ? calculateOrderTotalsV2(
          afterSubtotal,
          {
            ...adjustment,
            ...(requestedFee ?? {
              paymentFeeType: before.paymentFeeType,
              paymentFeeValue: before.paymentFeeValue,
            }),
          },
          requestedShippingFee,
          { taxMode: before.taxMode, vatRatePpm: before.vatRatePpm },
        )
      : calculateOrderTotals(afterSubtotal, adjustment, requestedShippingFee);
  const totalDelta = after.total - before.total;
  assertCorrectionTotalsContract(financialContract, before, after);
  const cogsDelta = lines.reduce(
    (sum, line) => sum + line.quantityDelta * line.costPrice,
    0,
  );

  return {
    order,
    currentRevision,
    before,
    after,
    totalDelta,
    cogsDelta,
    sourcePaymentMethod,
    lines,
  };
}

function settlementFor(
  totalDelta: number,
  sourcePaymentMethod: string,
  settlement: OrderCorrectionInput["settlement"],
  requireExactAmount: boolean,
) {
  if (totalDelta === 0)
    return {
      method: "none",
      amount: 0,
      status: "none" as const,
      direction: null,
    };
  const method = String(settlement?.method || sourcePaymentMethod || "").trim();
  if (!["cash", "bank_transfer", "cod"].includes(method)) {
    throw new PlatformError(
      "payment_settlement_required",
      "Choose cash, bank transfer, or COD settlement for this correction",
      409,
    );
  }
  if (totalDelta < 0 && method === "cod") {
    throw new PlatformError(
      "payment_settlement_required",
      "COD is a collection policy, not a customer refund rail; choose cash or bank transfer",
      409,
    );
  }
  const submittedAmount = Math.round(Number(settlement?.amountReceived || 0));
  if (
    requireExactAmount &&
    (!Number.isFinite(submittedAmount) ||
      submittedAmount !== Math.abs(totalDelta))
  ) {
    throw new PlatformError(
      "payment_settlement_required",
      "Settlement amount must exactly match the correction total delta",
      409,
      {
        requiredAmount: Math.abs(totalDelta),
        direction: totalDelta > 0 ? "collect" : "refund",
      },
    );
  }
  return {
    method,
    amount: Math.abs(totalDelta),
    // COD has no later end-user/system confirmation in this product. A
    // successful positive correction is therefore exact posted collection
    // evidence. Outbound refunds never inherit that inbound-only policy.
    status:
      method === "bank_transfer" ? ("pending" as const) : ("posted" as const),
    direction: totalDelta > 0 ? ("charge" as const) : ("refund" as const),
  };
}

function correctionConfirmationToken(orderId: string, input: OrderCorrectionInput, scope: OperatingScope,
  plan: Awaited<ReturnType<typeof correctionPlan>>, settlement: ReturnType<typeof settlementFor>) {
  return createHash("sha256").update(JSON.stringify({ version: 1, operation: CORRECTION_OPS.applyOrderCorrection,
    orderId, merchantId: scope.merchantId, storeId: scope.storeId, baseRevision: plan.currentRevision, reason: input.reason.trim(),
    beforeTotals: plan.before, afterTotals: plan.after, totalDelta: plan.totalDelta, cogsDelta: plan.cogsDelta,
    lines: plan.lines.map(line => ({ variantId: line.variantId, productId: line.productId, quantityBefore: line.quantityBefore,
      quantityAfter: line.quantityAfter, unitPrice: line.unitPrice, costPrice: line.costPrice }))
      .sort((a, b) => a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0),
    settlement: { method: settlement.method, amount: settlement.amount, status: settlement.status },
  })).digest("hex");
}

export async function previewOrderCorrection(
  orderId: string,
  input: OrderCorrectionInput,
  _actor: OperatorContext,
  scope: OperatingScope,
  financialContract: CorrectionFinancialContract = "legacy",
) {
  assertCorrectionInputContract(input, financialContract);
  return withClient(async (client) => {
    const plan = await correctionPlan(client, orderId, input, false, scope, financialContract);
    // Preview determines the required amount. The operator confirms that exact amount only on apply.
    const settlement = settlementFor(
      plan.totalDelta,
      plan.sourcePaymentMethod,
      input.settlement,
      false,
    );
    const response = {
      data: {
        orderId,
        baseRevision: plan.currentRevision,
        nextRevision: plan.currentRevision + 1,
        beforeTotals: plan.before,
        afterTotals: plan.after,
        ...(plan.after.commercialAdjustmentVersion === 2 ? {
          beforeFinancial: paymentFeeFinancialSnapshotV1(plan.before) ?? null,
          afterFinancial: paymentFeeFinancialSnapshotV1(plan.after),
        } : {}),
        totalDelta: plan.totalDelta,
        cogsDelta: plan.cogsDelta,
        ...(financialContract !== "legacy" ? { confirmationToken: correctionConfirmationToken(orderId, input, scope, plan, settlement) } : {}),
        settlement: {
          ...settlement,
          direction:
            plan.totalDelta > 0
              ? "collect"
              : plan.totalDelta < 0
                ? "refund"
                : "none" as const,
        },
        items: plan.lines.map((line) => ({
          variantId: line.variantId,
          productId: line.productId,
          productTitle: line.productTitle,
          sku: line.sku,
          quantityBefore: line.quantityBefore,
          quantityAfter: line.quantityAfter,
          quantityDelta: line.quantityDelta,
          unitPrice: line.unitPrice,
          stockDelta: line.stockDelta,
          availableStock: line.stock,
        })),
      },
    };
    if (financialContract !== "legacy") orderCorrectionFinancialPreviewV1(response, orderId, scope);
    return response;
  });
}

export async function applyOrderCorrection(
  headers: HeadersLike,
  orderId: string,
  input: OrderCorrectionInput,
  actor: OperatorContext,
  scope: OperatingScope,
  financialContract: CorrectionFinancialContract = "legacy",
) {
  assertCorrectionInputContract(input, financialContract);
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
    const result = await withScopedIdempotency(
      client,
      headers,
      { orderId, ...input },
      scope.merchantId,
      CORRECTION_OPS.applyOrderCorrection,
      async () => {
        const reason = validCorrectionReason(input.reason);
        const plan = await correctionPlan(client, orderId, input, true, scope, financialContract);
        const settlement = settlementFor(
          plan.totalDelta,
          plan.sourcePaymentMethod,
          input.settlement,
          true,
        );
        if (financialContract !== "legacy" && input.confirmationToken && input.confirmationToken !== correctionConfirmationToken(orderId, input, scope, plan, settlement)) {
          throw new PlatformError("order_correction_quote_changed", "Correction quote changed; preview and confirm the updated amounts", 409);
        }
        const correctionId = id("ordcorr");
        const revision = plan.currentRevision + 1;
        const orderNumber = plan.order.custom_display_id || orderId;

        const header = await client.query<{
          status: string;
          created_at: Date | string;
        }>(
          `
        INSERT INTO app.order_corrections (
          id, order_id, revision, base_revision, status, reason,
          before_totals, after_totals, total_delta, settlement_method, created_by
        ) VALUES ($1, $2, $3, $4, 'applied', $5, $6::jsonb, $7::jsonb, $8, $9, $10)
        RETURNING *
      `,
          [
            correctionId,
            orderId,
            revision,
            plan.currentRevision,
            reason,
            JSON.stringify(plan.before),
            JSON.stringify(plan.after),
            plan.totalDelta,
            settlement.method === "none" ? null : settlement.method,
            actor.operatorId,
          ],
        );

        for (const line of plan.lines) {
          const newStock = line.stock + line.stockDelta;
          if (line.stockDelta !== 0) {
            await client.query(
              `
            UPDATE public.inventory_level
            SET stocked_quantity = $2, updated_at = now()
            WHERE id = $1
          `,
              [line.inventoryLevelId, newStock],
            );
            const movement = await recordStockMovement(client, {
              inventoryItemId: line.inventoryItemId,
              productId: line.productId,
              variantId: line.variantId,
              sku: line.sku,
              productTitle: line.productTitle,
              movementType: "manual_adjustment",
              sourceAction: "order_correction",
              quantityBefore: line.stock,
              quantityChange: line.stockDelta,
              quantityAfter: newStock,
              referenceType: "order_correction",
              referenceId: correctionId,
              referenceDisplay: `${orderNumber} / correction ${revision}`,
              reason: `Điều chỉnh đơn #${revision}: ${reason}`,
              reasonCode: "order_correction",
              actor,
              scope,
              sourceChannel: "orders",
              metadata: {
                orderId,
                orderNumber,
                correctionId,
                revision,
                quantityBefore: line.quantityBefore,
                quantityAfter: line.quantityAfter,
                quantityDelta: line.quantityDelta,
              },
            });
            await emitExactOutbox(
              client,
              buildExactStockChangedEvent({
                merchantId: scope.merchantId,
                storeId: scope.storeId,
                inventoryItemId: line.inventoryItemId,
                movementId: String(movement.id),
                sourceOccurredAt: movement.created_at,
                payload: {
                  orderId,
                  correctionId,
                  revision,
                  source: "order_correction",
                  productId: line.productId,
                  variantId: line.variantId,
                  quantityBefore: line.stock,
                  quantityChange: line.stockDelta,
                  quantityAfter: newStock,
                  reorderLevel: line.reorderLevel,
                  stockLocationId: scope.stockLocationId,
                },
              }),
            );
          }

          await client.query(
            `
          INSERT INTO app.order_correction_items (
            correction_id, variant_id, product_id, product_title, sku,
            quantity_before, quantity_after, quantity_delta, unit_price, cost_price,
            line_total_before, line_total_after, stock_delta
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `,
            [
              correctionId,
              line.variantId,
              line.productId,
              line.productTitle,
              line.sku || null,
              line.quantityBefore,
              line.quantityAfter,
              line.quantityDelta,
              line.unitPrice,
              line.costPrice,
              line.quantityBefore * line.unitPrice,
              line.quantityAfter * line.unitPrice,
              line.stockDelta,
            ],
          );
        }

        const correctionOccurredAt = new Date(
          header.rows[0]!.created_at,
        ).toISOString();
        const correctionRevisionRepository =
          new PostgresCorrectionCommercialRevisionRepositoryV1(client, {
            statementTimeoutMs: 5_000,
            lockTimeoutMs: 1_000,
            transactionOwnership: "caller",
          });
        const correctionRevisionInput = {
          merchantId: scope.merchantId,
          storeId: scope.storeId,
          orderId,
          correctionId,
          revision,
          sourceOccurredAt: correctionOccurredAt,
          currencyCode: "VND" as const,
          minorUnitExponent: 0 as const,
          taxMode:
            plan.after.commercialAdjustmentVersion === 2
              ? plan.after.taxMode
              : commercialAdjustmentContext().taxMode,
          beforeTotals: plan.before,
          afterTotals: plan.after,
          lines: plan.lines
            .filter((line) => line.quantityAfter > 0)
            .map((line) => ({
              variantId: line.variantId,
              productId: line.productId,
              skuSnapshot: line.sku || line.variantId,
              titleSnapshot: line.productTitle,
              quantity: line.quantityAfter,
              unitPriceMinor: line.unitPrice,
            })),
        };
        const correctionRevisionTask =
          plan.before.commercialAdjustmentVersion === 2 &&
          plan.after.commercialAdjustmentVersion === 2
            ? createCorrectionCommercialRevisionTaskV2(
                { repository: correctionRevisionRepository },
                {
                  ...correctionRevisionInput,
                  beforeTotals: plan.before,
                  afterTotals: plan.after,
                  vatRatePpm: plan.after.vatRatePpm,
                },
              )
            : createCorrectionCommercialRevisionTaskV1(
                { repository: correctionRevisionRepository },
                correctionRevisionInput,
              );
        const correctionRevision = await correctionRevisionTask.execute();

        let canonicalPositiveCharge: PersistedPositiveCorrectionChargeV1 | null =
          null;
        let canonicalRefundPayable: OpenCustomerRefundPayableResultV1 | null =
          null;
        let canonicalRefundPayout: RecordCustomerRefundPayoutResultV1 | null =
          null;
        if (plan.totalDelta > 0) {
          const previousRevision = await queryOne<{ id: string }>(
            client,
            `
          SELECT id::text AS id
          FROM app.order_commercial_revisions
          WHERE merchant_id = $1
            AND store_id = $2
            AND order_id = $3
            AND revision = $4
          LIMIT 1
        `,
            [scope.merchantId, scope.storeId, orderId, revision - 1],
          );
          if (!previousRevision?.id) {
            throw new PlatformError(
              "financial_invariant_error",
              "Previous commercial revision is unavailable for correction collection",
              409,
            );
          }
          if (
            !settlement.method ||
            !["cash", "bank_transfer", "cod"].includes(settlement.method)
          ) {
            throw new PlatformError(
              "payment_settlement_required",
              "A supported settlement method is required for the positive correction",
              409,
            );
          }
          const positiveChargeInput = {
            merchantId: scope.merchantId,
            storeId: scope.storeId,
            orderId,
            correctionId,
            baseCommercialRevisionId: previousRevision.id,
            baseCommercialRevision: revision - 1,
            effectiveCommercialRevisionId: correctionRevision.revisionId,
            effectiveCommercialRevision: revision,
            currencyCode: "VND",
            minorUnitExponent: 0,
            sourceOccurredAt: correctionOccurredAt,
            beforeComponents: correctionRevisionTask.bundle.baseComponents,
            effectiveComponents: correctionRevisionTask.bundle.components,
          };
          const contract =
            correctionRevisionTask.bundle.bundleVersion === 2
              ? buildPositiveCorrectionChargeContractV2({
                  ...positiveChargeInput,
                  beforeComponents:
                    correctionRevisionTask.bundle.baseComponents,
                  effectiveComponents: correctionRevisionTask.bundle.components,
                })
              : buildPositiveCorrectionChargeContractV1(positiveChargeInput);
          canonicalPositiveCharge = await recordPositiveCorrectionChargeV1(
            client,
            {
              contract,
              settlementMethod:
                settlement.method as PositiveCorrectionSettlementMethodV1,
              transactionOwnership: "caller",
              statementTimeoutMs: 5_000,
              lockTimeoutMs: 1_000,
            },
          );
        } else if (plan.totalDelta < 0) {
          canonicalRefundPayable = await openCustomerRefundPayableV1(client, {
            merchantId: scope.merchantId,
            storeId: scope.storeId,
            orderId,
            commercialRevisionId: correctionRevision.revisionId,
            kind: "negative_correction",
            amountMinor: Math.abs(plan.totalDelta),
            sourceType: "order_correction",
            sourceId: correctionId,
            sourceOccurredAt: correctionOccurredAt,
            metadata: { revision, reason },
          });
          if (
            !settlement.method ||
            !["cash", "bank_transfer", "cod"].includes(settlement.method)
          ) {
            throw new PlatformError(
              "payment_settlement_required",
              "A supported refund method is required for the negative correction",
              409,
            );
          }
          if (settlement.status === "posted") {
            canonicalRefundPayout = await recordCustomerRefundPayoutV1(client, {
              merchantId: scope.merchantId,
              storeId: scope.storeId,
              orderId,
              amountMinor: Math.abs(plan.totalDelta),
              method: settlement.method as "cash" | "bank_transfer" | "cod",
              sourceType: "order_correction_refund",
              sourceId: correctionId,
              sourceOccurredAt: correctionOccurredAt,
              operatorId: actor.operatorId,
              reason,
              metadata: {
                revision,
                payableId: canonicalRefundPayable.payableId,
              },
            });
          }
        }

        let paymentEntryId: string | null = null;
        if (settlement.direction) {
          const entry = await recordPaymentEntry(client, {
            orderId,
            merchantId: scope.merchantId,
            storeId: scope.storeId,
            direction: settlement.direction,
            method: settlement.method,
            amount: settlement.amount,
            status: settlement.status,
            reference: String(orderNumber),
            reason,
            createdBy: actor.operatorId,
            metadata: {
              correctionId,
              revision,
              source: "order_correction",
              totalDelta: plan.totalDelta,
              canonicalPaymentEventId:
                canonicalPositiveCharge?.paymentEventId ||
                canonicalRefundPayout?.paymentEventId ||
                null,
              customerRefundPayableId:
                canonicalRefundPayable?.payableId || null,
            },
          });
          paymentEntryId = entry.id;
          await client.query(
            `
          UPDATE app.order_corrections
          SET settlement_payment_entry_id = $2
          WHERE id = $1
        `,
            [correctionId, paymentEntryId],
          );
        }
        await client.query(
          `
        INSERT INTO app.order_correction_settlements (
          correction_id, payment_entry_id, method, amount, status, metadata
        ) VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb)
      `,
          [
            correctionId,
            paymentEntryId,
            settlement.method,
            settlement.amount,
            settlement.status,
            JSON.stringify({ totalDelta: plan.totalDelta }),
          ],
        );
        await client.query(
          `
        UPDATE public."order"
        SET metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object(
            'correctionSummary',
            jsonb_build_object(
              'latestRevision', $2::int,
              'effectiveTotal', $3::numeric,
              'hasPendingSettlement', $4::boolean
            )
          ),
            updated_at = now()
        WHERE id = $1
      `,
          [
            orderId,
            revision,
            plan.after.total,
            settlement.status === "pending",
          ],
        );

        const eventId = await emitExactOutbox(
          client,
          buildExactOrderCorrectedEvent({
            merchantId: scope.merchantId,
            storeId: scope.storeId,
            orderId,
            correctionId,
            sourceOccurredAt: header.rows[0]!.created_at,
            payload: {
              orderNumber,
              revision,
              customerId: plan.order.customer_id,
              reason,
              beforeTotals: plan.before,
              afterTotals: plan.after,
              totalDelta: plan.totalDelta,
              cogsDelta: plan.cogsDelta,
              loyaltyBaseDelta:
                plan.after.loyaltyBase - plan.before.loyaltyBase,
              paymentMethod:
                settlement.method === "none"
                  ? plan.sourcePaymentMethod
                  : settlement.method,
              paymentEntryId,
              commercialRevisionId: correctionRevision.revisionId,
              canonicalPaymentEventId:
                canonicalPositiveCharge?.paymentEventId || null,
              customerRefundPayableId:
                canonicalRefundPayable?.payableId || null,
              canonicalRefundPaymentEventId:
                canonicalRefundPayout?.paymentEventId || null,
              settlementStatus: settlement.status,
              items: plan.lines.map((line) => ({
                variantId: line.variantId,
                productId: line.productId,
                productName: line.productTitle,
                sku: line.sku,
                quantityBefore: line.quantityBefore,
                quantityAfter: line.quantityAfter,
                quantityDelta: line.quantityDelta,
                unitPrice: line.unitPrice,
                costPrice: line.costPrice,
                stockDelta: line.stockDelta,
              })),
              operatorId: actor.operatorId,
              stockLocationId: scope.stockLocationId,
            },
          }),
        );
        await recordAuditEntry(
          client,
          actor,
          "order.corrected",
          "order",
          orderId,
          {
            before: { revision: plan.currentRevision, totals: plan.before },
            after: {
              correctionId,
              revision,
              totals: plan.after,
              totalDelta: plan.totalDelta,
              paymentEntryId,
            },
            reason,
            correlationId: eventId,
            merchantId: scope.merchantId,
            storeId: scope.storeId,
          },
        );

        const response = {
          data: {
            correction: {
              id: correctionId,
              revision,
              status: header.rows[0]?.status || "applied",
              reason,
              totalDelta: plan.totalDelta,
              beforeTotals: plan.before,
              afterTotals: plan.after,
              ...(plan.after.commercialAdjustmentVersion === 2 ? {
                beforeFinancial: paymentFeeFinancialSnapshotV1(plan.before) ?? null,
                afterFinancial: paymentFeeFinancialSnapshotV1(plan.after),
              } : {}),
              paymentEntryId,
              commercialRevisionId: correctionRevision.revisionId,
              canonicalPaymentEventId:
                canonicalPositiveCharge?.paymentEventId || null,
              canonicalObligationId:
                canonicalPositiveCharge?.obligationId || null,
              customerRefundPayableId:
                canonicalRefundPayable?.payableId || null,
              canonicalRefundPaymentEventId:
                canonicalRefundPayout?.paymentEventId || null,
              settlementStatus: settlement.status,
            },
          },
        };
        if (financialContract !== "legacy") orderCorrectionFinancialResponseV1(response, orderId, scope);
        return response;
      },
      201,
    );
    assertCorrectionTotalsContract(financialContract, result.response.data.correction.beforeTotals, result.response.data.correction.afterTotals);
    return result;
  });
}

export async function getOrderCorrectionProjectionForClient(
  client: PoolClient,
  orderId: string,
) {
  const corrections = await client.query(
    `
    SELECT corrections.id, corrections.revision, corrections.status,
           corrections.reason, corrections.total_delta::numeric,
           corrections.before_totals, corrections.after_totals,
           corrections.settlement_method,
           corrections.settlement_payment_entry_id::text,
           corrections.created_by, corrections.created_at,
           settlements.status AS settlement_status,
           CASE
             WHEN settlements.status <> 'pending' THEN false
             WHEN corrections.total_delta > 0 THEN
               obligations.id IS NULL
               OR coalesce(collections.collected_minor, 0) < obligations.amount_minor
             WHEN corrections.total_delta < 0 THEN
               payable_balances.payable_id IS NULL
               OR payable_balances.balance_minor > 0
             ELSE false
           END AS settlement_still_pending
    FROM app.order_corrections corrections
    LEFT JOIN app.order_correction_settlements settlements
      ON settlements.correction_id = corrections.id
    LEFT JOIN app.commercial_obligations obligations
      ON obligations.order_id = corrections.order_id
     AND obligations.source_type = 'order_correction'
     AND obligations.source_id = corrections.id
     AND obligations.obligation_kind = 'order_correction_charge'
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(allocations.amount_minor), 0) AS collected_minor
      FROM app.payment_event_allocations allocations
      WHERE allocations.obligation_id = obligations.id
        AND allocations.merchant_id = obligations.merchant_id
        AND allocations.store_id = obligations.store_id
        AND allocations.allocation_kind = 'collection'
    ) collections ON true
    LEFT JOIN app.customer_refund_payables payables
      ON payables.order_id = corrections.order_id
     AND payables.source_type = 'order_correction'
     AND payables.source_id = corrections.id
     AND payables.payable_kind = 'negative_correction'
    LEFT JOIN app.customer_refund_payable_balances payable_balances
      ON payable_balances.payable_id = payables.id
    WHERE corrections.order_id = $1
    ORDER BY corrections.revision ASC
  `,
    [orderId],
  );
  const latest = corrections.rows
    .filter((row) => row.status === "applied")
    .at(-1) as Record<string, unknown> | undefined;
  const effectiveItems = latest
    ? await client.query(
        `
      SELECT variant_id AS "variantId", product_id AS "productId", product_title AS name,
             quantity_after::numeric AS quantity, unit_price::numeric AS "unitPrice",
             line_total_after::numeric AS "lineTotal"
      FROM app.order_correction_items
      WHERE correction_id = $1 AND quantity_after > 0
      ORDER BY created_at ASC
    `,
        [latest.id],
      )
    : null;
  return {
    correctionSummary: latest
      ? {
          latestRevision: Number(latest.revision),
          effectiveTotal: totalsFrom(
            (latest.after_totals || {}) as Record<string, unknown>,
          ).total,
          hasPendingSettlement: corrections.rows.some(
            (row) => row.settlement_still_pending === true,
          ),
        }
      : {
          latestRevision: 0,
          effectiveTotal: null,
          hasPendingSettlement: corrections.rows.some(
            (row) => row.settlement_still_pending === true,
          ),
        },
    corrections: corrections.rows.map((row) => ({
      id: String(row.id),
      revision: Number(row.revision),
      status: String(row.status),
      reason: String(row.reason),
      totalDelta: numeric(row.total_delta),
      beforeTotals: row.before_totals,
      afterTotals: row.after_totals,
      settlementMethod: row.settlement_method
        ? String(row.settlement_method)
        : null,
      settlementPaymentEntryId: row.settlement_payment_entry_id
        ? String(row.settlement_payment_entry_id)
        : null,
      settlementStatus: row.settlement_status
        ? String(row.settlement_status)
        : null,
      createdBy: String(row.created_by),
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    })),
    effectiveItems: effectiveItems?.rows || null,
    effectiveTotals: latest
      ? totalsFrom((latest.after_totals || {}) as Record<string, unknown>)
      : null,
  };
}

export async function getOrderCorrections(orderId: string) {
  return withClient(async (client) => ({
    data: await getOrderCorrectionProjectionForClient(client, orderId),
  }));
}
