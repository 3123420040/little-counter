import { isPartnerBusinessActor, businessActorId, partnerActorMetadata, type PartnerBusinessActor } from "../utils/business-actor";
import { readManualBankConfirmationRuntimeConfigV1 } from "./manual-bank-confirmation-service";
import { readFoundStockPolicyForClient } from "./merchant-checkout-policy-service";
import { orderCancellationAccessForClient, requireOrderCancellationAccessForClient } from "./order-cancellation-access-service";
import { createHash } from "node:crypto";
import { cartPaymentFeeConfirmationV1 } from "./cart-payment-fee-confirmation";
import { isDeepStrictEqual } from "node:util";
import { withScopedIdempotency } from "../db/idempotency";
import { lockActiveBusinessScopeForClient, lockActivePartnerBusinessScopeForClient } from "./business-lifecycle-service";
import { verifyProviderOrderLifecycleForClient } from "./provider-order-lifecycle-service";
import { queryOne } from "../db/query";
import { rawNumber } from "../db/raw-number";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import {
  BANK_TRANSFER_SETTLEMENT_ACKNOWLEDGMENT_VERSION,
  OrderCommercialComponentsV2Schema,
  CartPaymentFeePreviewInputV1Schema,
  CartPaymentFeePreviewV1Schema,
  type PaymentFeeInputV1,
  type OperatingScope,
  type ReportScope,
  type ShiftAttributionMode,
} from "@medusa-snus/contracts";
import type { HeadersLike } from "../http/headers";
import { findCustomer } from "../repositories/customer-repository";
import { serializeCsv, type CsvCell } from "./csv-export-service";

// Stable operation codes used with withScopedIdempotency. Each mutation has a
// distinct, lowercase, tenant-stable identifier so the same Idempotency-Key
// can be safely reused across merchants and operations.
export const ORDER_OPS = {
  completeSale: "order.complete_sale",
  createRemoteOrder: "order.create_remote_order",
  updateOrder: "order.update_order",
  updateOrderShippingFee: "order.update_shipping_fee",
  cancelOrder: "order.cancel_order",
  cancelOwnOrder: "order.cancel_own_order",
  refundOrder: "order.refund_order",
} as const;
import { recordAuditEntry } from "../repositories/audit-repository";
import { emitExactOutbox } from "../repositories/outbox-repository";
import { id } from "../utils/id";
import type { OperatorContext } from "./auth-service";
import { assertOperatingMutationTarget } from "./mutation-scope-service";
import type { ChannelActor } from "./channel-auth-service";
import {
  getRefundablePaymentBalance,
  isExternalProviderPaymentMethod,
  recordOrderRefund,
  recordSaleCharge,
} from "./payment-service";
import {
  applyOrderCorrection,
  getOrderCorrectionProjectionForClient,
  previewOrderCorrection,
  type OrderCorrectionInput,
} from "./order-correction-service";
import {
  ORIGINAL_ORDER_COMMERCIAL_REVISION_CALLER_DEFAULT_CONFIG_V1,
  recordOriginalOrderCommercialRevisionFromOrderCreateV1,
  recordOriginalOrderCommercialRevisionFromOrderCreateV2,
  type OriginalOrderCommercialRevisionCallerInputV1,
  type OriginalOrderCommercialRevisionCallerDependenciesV1,
} from "./original-order-commercial-revision-caller";
import {
  ORDER_CREATED_PAYMENT_CHARGE_CALLER_DEFAULT_CONFIG_V1,
  recordOrderCreatedPaymentChargeV1,
  recordOrderCreatedPaymentChargeV2,
  type OrderCreatedPaymentChargeCallerInputV1,
  type OrderCreatedPaymentChargeCallerDependenciesV1,
} from "./order-created-payment-charge-caller";
import {
  PROVIDER_INITIAL_POSTED_CHARGE_CALLER_DEFAULT_CONFIG_V1,
  recordProviderInitialPostedChargeFromLockedStateV1,
} from "./provider-initial-posted-charge-caller";
import { PAYMENT_ENTRY_COMPATIBILITY_DEFAULT_CONFIG_V1 } from "./payment-entry-compatibility-policy";
import { calculateOrderTotals, calculateOrderTotalsV2, paymentFeeFinancialSnapshotV1, type CommercialAdjustmentContext } from "./order-total-service";
import { checkoutPaymentFeeResponseV1 } from "./checkout-payment-fee-presentation";
import { readPaymentFeeInput, vatRatePpmFromRate } from "./payment-fee-calculation";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1, type PaymentFeeHttpContractV1 } from "@medusa-snus/contracts/runtime-capabilities";
import { recordStockMovement } from "./stock-movement-service";
import {
  buildExactRefundCreatedEvent,
  buildExactSaleCancelledEvent,
  buildExactSaleCreatedEvent,
  buildExactStockChangedEvent,
  buildExactStockFoundEvent,
} from "./exact-outbox-event-builders";
import { resolveShiftAttributionForSale } from "./shift-service";
import { appendCancellationCommercialRevisionV1 } from "./cancellation-commercial-revision-service";
import {
  openCustomerRefundPayableV1,
  readCustomerRefundPositionV1,
  recordCustomerRefundPayoutV1,
} from "./customer-refund-payable-service";
import {
  createCancellationQuoteV1,
  validateCancellationQuoteV1,
} from "./order-cancellation-quote-service";
import { resolveRefundPayoutAmountV1 } from "./refund-payout-amount-policy";
import { resolveStoreSettlementPolicyForCheckoutV1 } from "./store-settlement-policy-service";

// The store operates in Vietnam time. Date-range filters resolve created_at in
// this timezone so an operator's "Hôm nay" / "đến ngày" matches the calendar
// day they see locally, regardless of the DB session timezone.
const ORDER_LIST_TZ = "Asia/Ho_Chi_Minh";
const ORDER_EXPORT_MAX_DAYS = 92;

const ORDER_EXPORT_COLUMNS = [
  "exported_at",
  "merchant_id",
  "store_id",
  "store_name",
  "timezone",
  "date_from",
  "date_to",
  "order_id",
  "display_id",
  "order_created_at",
  "order_status",
  "payment_status",
  "fulfillment_status",
  "sales_channel",
  "sales_channel_label",
  "sales_channel_locked",
  "source_flow",
  "scan_go_cart_id",
  "scan_go_redeemed_at",
  "customer_id",
  "customer_name",
  "customer_phone",
  "customer_email",
  "customer_nickname",
  "customer_contact_type",
  "created_by_operator_id",
  "created_by_operator_name",
  "created_by_role",
  "redeemed_by_operator_id",
  "payment_method",
  "payment_reference",
  "paid_at",
  "currency_code",
  "subtotal",
  "discount_total",
  "shipping_total",
  "tax_total",
  "grand_total",
  "amount_paid",
  "change_due",
  "line_id",
  "product_id",
  "variant_id",
  "sku",
  "barcode",
  "brand",
  "product_title",
  "variant_title",
  "category",
  "quantity",
  "unit_price",
  "line_subtotal",
  "line_discount",
  "line_total",
  "stock_location_id",
  "pickup_or_delivery",
  "delivery_address_short",
  "is_first_customer_order",
  "line_share_of_order",
  "basket_size",
  "order_hour",
  "order_weekday",
  "created_at",
  "updated_at",
  "cancelled_at",
  "cancel_reason",
  "notes",
] as const;

export interface SaleItemVisionContext {
  scanEventId: string;
  detectionId?: string;
  correctionId?: string;
  objectId?: string;
  candidateSource: "ai_candidate" | "manual_search_after_scan";
  provider: string;
  providerCandidateRank?: number;
  providerConfidence?: number;
  providerProductRef?: string;
  providerImageRef?: string;
}

export interface SaleInputItem {
  variantId: string;
  quantity: number;
  vision?: SaleItemVisionContext;
  visionContexts?: SaleItemVisionContext[];
}

export interface SaleInput extends Partial<PaymentFeeInputV1> {
  cartConfirmationToken?: string;
  items: SaleInputItem[];
  customerId?: string;
  customerMode?: "linked" | "walk_in";
  paymentMethod: "cash" | "bank_transfer" | "cod" | string;
  amountReceived: number;
  discountPercent?: number;
  discountType?: "percent" | "amount";
  discountValue?: number;
  shippingFee?: number;
  notes?: string;
  salesChannel?: string;
  sourceFlow?: string;
  scanGoCartId?: string;
  scanGoCheckoutToken?: string;
  scanGoRedeemedAt?: string;
  salesChannelLocked?: boolean;
  customerNickname?: string | null;
  customerContactType?: string | null;
  redeemedByOperatorId?: string | null;
  telegramSalesDraftId?: string;
  telegramSalesOperatorNotes?: string | null;
  /** Source order for a recreate-as-new-sale workflow. */
  sourceOrderId?: string;
  shiftId?: string;
  shiftOpenedAt?: string;
  shiftAttribution?: ShiftAttributionMode;
  queuedAt?: string;
  foundStockConfirmation?: FoundStockConfirmationInput;
  bankTransferSettlementAcknowledgment?: {
    policyVersion: number;
    acknowledgmentVersion: number;
  };
}

export interface RemoteOrderInput {
  items: Array<{ variantId: string; quantity: number }>;
  customerId?: string;
  paymentMethod?: "bank_transfer" | "cod" | "cash" | string;
  amountReceived?: number;
  discountPercent?: number;
  discountType?: "percent" | "amount";
  discountValue?: number;
  shippingFee?: number;
  note?: string;
  notes?: string;
  salesChannel?: string;
  status?: "confirmed";
}

export interface RefundOrderInput {
  amount?: number;
  method?: "cash" | "bank_transfer";
  sourceReference?: string;
  paidAt?: string;
  reason?: string;
  confirmationToken?: string;
  restock?: boolean;
}

export interface CancelOrderInput {
  reason?: string;
  quoteId?: string;
  effectiveRevision?: number;
  quoteGeneratedAt?: string;
}

export interface UpdateOrderInput {
  customerId?: string | null;
  notes?: string | null;
  salesChannel?: string | null;
}

export interface UpdateOrderShippingInput {
  shippingFee?: number;
  reason?: string;
  paymentMethod?: "cash" | "bank_transfer" | "cod" | string;
  amountReceived?: number;
  confirmationToken?: string;
}

export interface OrderExportQuery {
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  search?: string;
}

export type OrderWorkflowActor = OperatorContext | ChannelActor | PartnerBusinessActor;

export interface NormalizedOrderInput extends Partial<PaymentFeeInputV1> {
  cartConfirmationToken?: string;
  items: SaleInputItem[];
  customerId?: string;
  customerMode?: "linked" | "walk_in";
  paymentMethod: string;
  amountReceived: number;
  discountPercent?: number;
  discountType?: "percent" | "amount";
  discountValue?: number;
  shippingFee?: number;
  notes?: string;
  salesChannel: string;
  sourceFlow?: string;
  scanGoCartId?: string;
  scanGoRedeemedAt?: string;
  salesChannelLocked?: boolean;
  customerNickname?: string | null;
  customerContactType?: string | null;
  redeemedByOperatorId?: string | null;
  telegramSalesDraftId?: string;
  telegramSalesOperatorNotes?: string | null;
  sourceOrderId?: string;
  shiftId?: string;
  shiftOpenedAt?: string;
  shiftAttribution?: ShiftAttributionMode;
  queuedAt?: string;
  foundStockConfirmation?: FoundStockConfirmationInput;
}

export function assertCustomerAttributionMode(
  input: Pick<SaleInput, "customerId" | "customerMode">,
): void {
  if (input.customerMode === undefined) return;
  if (input.customerMode !== "linked" && input.customerMode !== "walk_in") {
    throw new PlatformError("validation_error", "Customer attribution mode is invalid", 400);
  }
  const customerId = typeof input.customerId === "string" ? input.customerId.trim() : "";
  if (input.customerMode === "linked" && !customerId) {
    throw new PlatformError(
      "validation_error",
      "Linked-customer checkout requires a selected customer",
      400,
    );
  }
  if (input.customerMode === "walk_in" && customerId) {
    throw new PlatformError(
      "validation_error",
      "Walk-in checkout cannot include a customer ID",
      400,
    );
  }
}

function resolvedCustomerAttributionMode(
  input: Pick<NormalizedOrderInput, "customerId" | "customerMode">,
): "linked" | "walk_in" | "unknown" {
  if (input.customerMode) return input.customerMode;
  return input.customerId ? "linked" : "unknown";
}

function bankBookingConfirmationForPolicy(
  raw: SaleInput["bankTransferSettlementAcknowledgment"],
  policy: { mode: "manual_confirmation" | "confirm_on_booking"; version: number },
  operatorId: string,
) {
  if (policy.mode === "manual_confirmation") {
    if (raw !== undefined) {
      throw new PlatformError(
        "checkout_policy_refresh_required",
        "Bank settlement policy changed; reload checkout before completing the sale",
        409,
      );
    }
    if (!readManualBankConfirmationRuntimeConfigV1().enabled) {
      throw new PlatformError("manual_bank_confirmation_disabled", "Manual bank confirmation is unavailable; reload checkout or choose another payment method", 409);
    }
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlatformError(
      "checkout_bank_acknowledgment_required",
      "Bank receipt acknowledgment is required before completing this sale",
      409,
    );
  }
  const keys = Object.keys(raw).sort();
  if (
    keys.join(",") !== "acknowledgmentVersion,policyVersion"
    || !Number.isSafeInteger(raw.policyVersion)
    || !Number.isSafeInteger(raw.acknowledgmentVersion)
    || raw.policyVersion !== policy.version
    || raw.acknowledgmentVersion !== BANK_TRANSFER_SETTLEMENT_ACKNOWLEDGMENT_VERSION
  ) {
    throw new PlatformError(
      "checkout_policy_refresh_required",
      "Bank settlement policy changed; reload checkout before completing the sale",
      409,
      { currentPolicyVersion: policy.version },
    );
  }
  return {
    operatorId,
    policyVersion: raw.policyVersion,
    acknowledgmentVersion: raw.acknowledgmentVersion,
  };
}

export interface OrderWorkflowOptions {
  source: "pos" | "remote";
  salesChannelId: "sc_pos" | "sc_remote" | "sc_stash_dash";
  orderStatus: "completed";
  remoteStatus?: "confirmed";
  paymentMetadata?: Record<string, unknown>;
  commercialContext?: CommercialAdjustmentContext;
  stockLocationId?: string;
  /**
   * Tenant provenance stamped onto the order, stock movement, outbox and
   * audit. The captured merchant/store/location flow from the OperatingScope
   * resolved at command start so settlement and cancel use the same envelope
   * the sale used.
   */
  merchantId?: string;
  storeId?: string;
  manualBankConfirmation?: {
    operatorId: string;
    policyVersion: number;
    acknowledgmentVersion: number;
  };
}

interface FoundStockConfirmationInput {
  confirmed?: boolean;
  reasonCode?: string;
  reasonLabel?: string;
  acknowledgedShortages?: Array<{ variantId?: string; shortageQuantity?: number }>;
}

interface SaleLine {
  orderLineItemId?: string;
  product_id: string;
  product_title: string;
  product_handle: string;
  variant_id: string;
  variant_title: string;
  sku: string;
  barcode: string;
  inventory_item_id: string;
  inventory_level_id: string;
  reorder_level: number;
  quantity: number;
  stock: number;
  price: number;
  costPrice: number;
  costEvidenceUpdatedAt: Date | string | null;
  lineTotal: number;
  lineCogs: number;
  visionContexts: SaleItemVisionContext[];
}

function assertFinancialSaleLines(input: SaleInput, lines: SaleLine[], calculationVersion: number) {
  if (calculationVersion === 2 && (input.items.length !== lines.length
    || lines.some(line => !input.items.some(item => item.variantId === line.variant_id && item.quantity === line.quantity)))) {
    throw new PlatformError("validation_error", "Fee-aware sale requires unique variant identities and quantities", 400);
  }
}

interface FoundStockAdjustment {
  type: "found_stock";
  reasonCode: "found_stock";
  reason: "Tìm thấy";
  productId: string;
  variantId: string;
  productName: string;
  sku: string;
  inventoryItemId: string;
  systemStockBefore: number;
  requestedQuantity: number;
  adjustedQuantity: number;
  unitCost: number;
  inventoryValue: number;
  performedBy: string;
  movementId?: string;
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedClient(fn);
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedTransaction(fn);
}

function vatRate(): number {
  const value = Number(process.env.VAT_RATE ?? "0.10");
  return Number.isFinite(value) && value >= 0 ? value : 0.1;
}

function taxMode(): "inclusive" | "exclusive" {
  return process.env.TAX_MODE === "exclusive" ? "exclusive" : "inclusive";
}

function isChannelActor(actor: OrderWorkflowActor): actor is ChannelActor {
  return "channel" in actor;
}

function channelMetadata(actor: OrderWorkflowActor): Record<string, unknown> {
  if (isPartnerBusinessActor(actor)) return partnerActorMetadata(actor);
  if (!isChannelActor(actor)) return {};
  return {
    channel: actor.channel,
    channelUserId: actor.channelUserId,
    serviceIdentity: actor.serviceIdentity,
    requestId: actor.requestId || null,
  };
}

function saleStockSourceAction(input: NormalizedOrderInput, actor: OrderWorkflowActor, options: OrderWorkflowOptions): string {
  if (isPartnerBusinessActor(actor)) return "partner_booking";
  if (input.sourceFlow === "customer_scan_go") return "scan_go_checkout";
  if (input.salesChannel === "stash_dash") return "stash_dash_sale";
  if (isChannelActor(actor) && actor.channel === "telegram") return "telegram_sale";
  if (input.salesChannel === "telegram") return "telegram_sale";
  if (options.source === "remote") return "remote_sale";
  return "pos_sale";
}

function saleStockSourceChannel(input: NormalizedOrderInput, actor: OrderWorkflowActor, options: OrderWorkflowOptions): string {
  if (isPartnerBusinessActor(actor)) return "partner_api";
  if (isChannelActor(actor)) return actor.channel;
  if (input.sourceFlow === "customer_scan_go" || input.salesChannel === "stash_dash") return "stash_dash";
  if (options.source === "remote") return input.salesChannel || "remote";
  return "pos";
}

const SALES_CHANNEL_LABELS: Record<string, string> = {
  pos_counter: "Tại quầy",
  whatsapp: "WhatsApp",
  zalo: "Zalo",
  instagram: "Instagram",
  telegram: "Telegram",
  website: "Website",
  stash_dash: "Stash Dash",
  partner_api: "Partner API",
};

function normalizeNotes(value: unknown): string | null {
  const notes = String(value || "").trim();
  if (!notes) return null;
  if (notes.length > 1000) {
    throw new PlatformError("validation_error", "Order notes must be at most 1000 characters", 400);
  }
  return notes;
}

function normalizeSalesChannel(value: unknown, fallback = "pos_counter"): string {
  const channel = String(value || fallback).trim().toLowerCase();
  if (!SALES_CHANNEL_LABELS[channel]) {
    throw new PlatformError("validation_error", "Invalid sales channel", 400);
  }
  return channel;
}

function optionalVisionText(value: unknown): string | undefined {
  const normalized = String(value || "").trim();
  return normalized || undefined;
}

function normalizeVisionConfidence(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeSaleItemVisionContexts(item: SaleInputItem): SaleItemVisionContext[] {
  const rawContexts = Array.isArray(item.visionContexts)
    ? item.visionContexts
    : item.vision
      ? [item.vision]
      : [];
  const contexts: SaleItemVisionContext[] = [];
  for (const raw of rawContexts) {
    if (!raw || typeof raw !== "object") continue;
    const scanEventId = optionalVisionText((raw as SaleItemVisionContext).scanEventId);
    const candidateSource = (raw as SaleItemVisionContext).candidateSource;
    const provider = optionalVisionText((raw as SaleItemVisionContext).provider);
    if (!scanEventId || !provider) continue;
    if (candidateSource !== "ai_candidate" && candidateSource !== "manual_search_after_scan") continue;
    const rank = Number((raw as SaleItemVisionContext).providerCandidateRank);
    contexts.push({
      scanEventId,
      detectionId: optionalVisionText((raw as SaleItemVisionContext).detectionId),
      correctionId: optionalVisionText((raw as SaleItemVisionContext).correctionId),
      objectId: optionalVisionText((raw as SaleItemVisionContext).objectId),
      candidateSource,
      provider,
      providerCandidateRank: Number.isInteger(rank) && rank > 0 ? rank : undefined,
      providerConfidence: normalizeVisionConfidence((raw as SaleItemVisionContext).providerConfidence),
      providerProductRef: optionalVisionText((raw as SaleItemVisionContext).providerProductRef),
      providerImageRef: optionalVisionText((raw as SaleItemVisionContext).providerImageRef),
    });
    if (contexts.length >= Number(item.quantity || 0)) break;
  }
  return contexts;
}

function salesChannelLabel(value: string): string {
  return SALES_CHANNEL_LABELS[value] || value;
}

function salesChannelIdForChannel(channel: string): "sc_pos" | "sc_remote" | "sc_stash_dash" {
  if (channel === "pos_counter") return "sc_pos";
  if (channel === "stash_dash") return "sc_stash_dash";
  return "sc_remote";
}

function assertScanGoSalesChannel(input: NormalizedOrderInput): void {
  if (input.sourceFlow !== "customer_scan_go") return;
  if (input.salesChannel !== "stash_dash") {
    throw new PlatformError(
      "invalid_sales_channel",
      "Customer Scan & Go orders must keep the Stash Dash sales channel for tracking",
      409,
    );
  }
  if (!input.scanGoCartId) {
    throw new PlatformError(
      "scan_go_cart_required",
      "Customer Scan & Go orders require a redeemed cart id for tracking",
      409,
    );
  }
}

function scanGoTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function extractScanGoCheckoutToken(value: unknown): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^sgt_[a-f0-9]+$/i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const token = (url.searchParams.get("t") || url.searchParams.get("token") || "").trim();
    return /^sgt_[a-f0-9]+$/i.test(token) ? token : null;
  } catch {
    return null;
  }
}

function stripScanGoCheckoutToken(input: SaleInput): SaleInput {
  const { scanGoCheckoutToken: _scanGoCheckoutToken, ...safeInput } = input;
  return safeInput;
}

export async function preparePaymentIntentSaleInputForClient(
  client: PoolClient,
  body: SaleInput,
  scope: { merchantId: string; storeId: string; paymentIntentId?: string },
): Promise<SaleInput> {
  if (body.sourceFlow !== "customer_scan_go") return stripScanGoCheckoutToken(body);
  const safeInput = stripScanGoCheckoutToken(body);
  if (!body.scanGoCartId) return safeInput;
  const cart = await queryOne<{
    merchant_id: string;
    store_id: string;
    status: string;
    token_hash: string | null;
    token_expires_at: Date | string | null;
    metadata: Record<string, unknown> | null;
  }>(client, `
    SELECT merchant_id, store_id, status, token_hash, token_expires_at, metadata
    FROM app.scan_go_carts
    WHERE id = $1
    FOR UPDATE
  `, [body.scanGoCartId]);
  if (!cart) {
    throw new PlatformError("resource_not_found", "Scan & Go cart not found", 404);
  }
  if (cart.merchant_id !== scope.merchantId || cart.store_id !== scope.storeId) {
    throw new PlatformError("forbidden", "Scan & Go cart belongs to another store", 403);
  }
  if (cart.status === "redeemed") {
    throw new PlatformError("cart_already_redeemed", "Scan & Go cart already redeemed", 409);
  }
  if (cart.status !== "ready") {
    throw new PlatformError("cart_not_ready", "Scan & Go cart is not ready", 409);
  }
  const claimedPaymentIntentId = typeof cart.metadata?.paymentIntentId === "string" ? cart.metadata.paymentIntentId : "";
  if (claimedPaymentIntentId && claimedPaymentIntentId !== scope.paymentIntentId) {
    const activeClaim = await queryOne<{ id: string; status: string }>(client, `
      SELECT id, status
      FROM app.payment_intents
      WHERE id = $1
        AND status IN ('pending', 'paid')
        AND (status <> 'pending' OR expires_at > now())
    `, [claimedPaymentIntentId]);
    if (activeClaim) {
      throw new PlatformError(
        "scan_go_payment_intent_active",
        "Scan & Go cart already has an active payment intent",
        409,
      );
    }
    await client.query(`
      UPDATE app.scan_go_carts
      SET metadata = COALESCE(metadata, '{}'::jsonb) - 'paymentIntentId' - 'paymentIntentClaimedAt',
          updated_at = now()
      WHERE id = $1
    `, [body.scanGoCartId]);
  }
  const token = extractScanGoCheckoutToken(body.scanGoCheckoutToken);
  if (!token) {
    throw new PlatformError("scan_go_token_required", "Scan & Go token is required for payment intent checkout", 409);
  }
  if (!cart.token_hash || cart.token_hash !== scanGoTokenHash(token)) {
    throw new PlatformError("forbidden", "Scan & Go token does not match this cart", 403);
  }
  const expiresAt = cart.token_expires_at ? new Date(String(cart.token_expires_at)) : null;
  if (!expiresAt || expiresAt.getTime() < Date.now()) {
    await client.query("UPDATE app.scan_go_carts SET status = 'expired', updated_at = now() WHERE id = $1 AND status <> 'redeemed'", [body.scanGoCartId]);
    throw new PlatformError("cart_token_expired", "Scan & Go cart QR expired", 410);
  }
  if (scope.paymentIntentId) {
    await client.query(`
      UPDATE app.scan_go_carts
      SET metadata = COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object('paymentIntentId', $2::text, 'paymentIntentClaimedAt', now()),
          updated_at = now()
      WHERE id = $1
    `, [body.scanGoCartId, scope.paymentIntentId]);
  }
  return safeInput;
}

async function redeemScanGoCartForProviderOrder(
  client: PoolClient,
  input: NormalizedOrderInput,
  actor: OperatorContext,
  providerMetadata: Record<string, unknown>,
  scope: { merchantId: string; storeId: string },
): Promise<NormalizedOrderInput> {
  if (input.sourceFlow !== "customer_scan_go") return input;
  const paymentIntentId = typeof providerMetadata.paymentIntentId === "string" ? providerMetadata.paymentIntentId : "";
  if (!paymentIntentId) return input;
  const row = await queryOne<{ redeemed_at: Date | string; redeemed_by_operator_id: string | null }>(client, `
    UPDATE app.scan_go_carts
    SET status = 'redeemed',
        redeemed_at = COALESCE(redeemed_at, now()),
        redeemed_by_operator_id = COALESCE(redeemed_by_operator_id, $2),
        metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object('paymentIntentId', $5::text, 'providerRedeemedAt', now()),
        updated_at = now()
    WHERE id = $1
      AND merchant_id = $3
      AND store_id = $4
      AND status IN ('ready', 'redeemed')
      AND redeemed_order_id IS NULL
    RETURNING redeemed_at, redeemed_by_operator_id
  `, [input.scanGoCartId, actor.operatorId, scope.merchantId, scope.storeId, paymentIntentId]);
  if (!row) {
    throw new PlatformError(
      "scan_go_cart_not_redeemed",
      "Scan & Go cart must be redeemable in this store before checkout",
      409,
      { scanGoCartId: input.scanGoCartId },
    );
  }
  return {
    ...input,
    scanGoRedeemedAt: input.scanGoRedeemedAt || isoTimestamp(row.redeemed_at),
    redeemedByOperatorId: input.redeemedByOperatorId || row.redeemed_by_operator_id || actor.operatorId,
  };
}

async function lockScanGoCartForOrder(
  client: PoolClient, input: Pick<SaleInput, "sourceFlow" | "scanGoCartId">,
  scope: { merchantId: string; storeId: string }, paymentIntentId?: string,
) {
  if (input.sourceFlow !== "customer_scan_go") return;
  const cart = await queryOne<{ merchant_id: string; store_id: string; status: string;
    redeemed_order_id: string | null; claimed_intent: string | null }>(client, `
    SELECT merchant_id,store_id,status,redeemed_order_id,metadata->>'paymentIntentId' AS claimed_intent
    FROM app.scan_go_carts WHERE id=$1 FOR UPDATE
  `, [input.scanGoCartId]);
  if (!cart || cart.merchant_id !== scope.merchantId || cart.store_id !== scope.storeId
    || cart.redeemed_order_id || (paymentIntentId
      ? cart.claimed_intent !== paymentIntentId || !["ready", "redeemed"].includes(cart.status)
      : Boolean(cart.claimed_intent) || cart.status !== "redeemed")) {
    throw new PlatformError(paymentIntentId ? "scan_go_cart_unavailable" : "scan_go_cart_not_redeemed",
      "Scan & Go cart claim or scope is unavailable", 409);
  }
}

async function linkRedeemedScanGoCartToOrder(
  client: PoolClient,
  input: NormalizedOrderInput,
  orderId: string,
  scope: { merchantId: string; storeId: string },
): Promise<void> {
  if (input.sourceFlow !== "customer_scan_go") return;
  const result = await client.query(`
    UPDATE app.scan_go_carts
    SET redeemed_order_id = $2,
        metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object('redeemedOrderId', $2, 'orderLinkedAt', now()),
        updated_at = now()
    WHERE id = $1
      AND merchant_id = $3
      AND store_id = $4
      AND status = 'redeemed'
      AND (redeemed_order_id IS NULL OR redeemed_order_id = $2)
  `, [input.scanGoCartId, orderId, scope.merchantId, scope.storeId]);
  if (result.rowCount !== 1) {
    throw new PlatformError(
      "scan_go_cart_not_redeemed",
      "Scan & Go cart must be redeemed in this store before checkout",
      409,
      { scanGoCartId: input.scanGoCartId },
    );
  }
}

function normalizeMoney(value: unknown, field: string): number {
  const amount = Math.round(Number(value || 0));
  if (!Number.isFinite(amount) || amount < 0) {
    throw new PlatformError("validation_error", `${field} must be a non-negative amount`, 400);
  }
  return amount;
}

function taxableRevenue(amount: number, tax: number) {
  return Math.max(0, taxMode() === "inclusive" ? amount - tax : amount);
}

function isoTimestamp(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function numberValue(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateOnlyMillis(value: string | undefined): number | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PlatformError("validation_error", "Date filters must use YYYY-MM-DD", 400);
  }
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(time) ? null : time;
}

function assertOrderExportDateWindow(query?: OrderExportQuery): void {
  const from = dateOnlyMillis(query?.dateFrom);
  const to = dateOnlyMillis(query?.dateTo);
  if (from !== null && to !== null) {
    if (from > to) {
      throw new PlatformError("validation_error", "dateFrom must be before or equal to dateTo", 400);
    }
    const days = Math.floor((to - from) / 86_400_000) + 1;
    if (days > ORDER_EXPORT_MAX_DAYS) {
      throw new PlatformError("validation_error", `Order export date range cannot exceed ${ORDER_EXPORT_MAX_DAYS} days`, 400, {
        maxDays: ORDER_EXPORT_MAX_DAYS,
      });
    }
  }
}

export function normalizeRemoteOrderInput(body: RemoteOrderInput): NormalizedOrderInput {
  if (readPaymentFeeInput(body)) throw new PlatformError("validation_error", "Payment fee is not supported by remote orders", 400);
  if (body.status && body.status !== "confirmed") {
    throw new PlatformError("validation_error", "Remote order status must be confirmed", 400);
  }

  return {
    items: body.items || [],
    customerId: body.customerId,
    paymentMethod: body.paymentMethod || "cod",
    amountReceived: Number(body.amountReceived || 0),
    discountPercent: body.discountPercent,
    discountType: body.discountType,
    discountValue: body.discountValue,
    shippingFee: normalizeMoney(body.shippingFee, "shippingFee"),
    notes: normalizeNotes(body.notes ?? body.note) || undefined,
    salesChannel: normalizeSalesChannel(body.salesChannel || "telegram", "telegram"),
  };
}

async function getSaleLinesForUpdate(client: PoolClient, items: SaleInput["items"], stockLocationId: string, merchantId: string): Promise<SaleLine[]> {
  await client.query("SELECT integration.lock_commerce_inputs($1,$2::text[])", [merchantId, items.map((item) => item.variantId)]);
  const lines: SaleLine[] = [];
  const resolved = new Map<string, SaleInputItem & { inventoryItemId: string }>();
  for (const item of items) {
    if (!Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity) <= 0) {
      throw new PlatformError("validation_error", "Quantity must be a positive safe integer", 400);
    }
    const mappings = await client.query<{ variant_id: string; inventory_item_id: string; required_quantity: number }>(`
      SELECT v.id AS variant_id,vii.inventory_item_id,vii.required_quantity
      FROM public.product_variant v
      JOIN public.product p ON p.id=v.product_id AND p.deleted_at IS NULL
      JOIN public.product_variant_inventory_item vii ON vii.variant_id=v.id AND vii.deleted_at IS NULL
      JOIN public.inventory_item ii ON ii.id=vii.inventory_item_id AND ii.deleted_at IS NULL
      WHERE v.deleted_at IS NULL AND (v.id=$1 OR p.id=$1) AND p.merchant_id=$2
      ORDER BY v.id,vii.inventory_item_id
    `, [item.variantId,merchantId]);
    if (!mappings.rowCount) throw new PlatformError("resource_not_found", `Variant not found: ${item.variantId}`, 404);
    // Legacy product-id input remains supported only when unambiguous. Picking
    // an arbitrary component/variant cannot preserve a stock invariant.
    if (mappings.rowCount !== 1 || Number(mappings.rows[0].required_quantity) !== 1) {
      throw new PlatformError("unsupported_inventory_model", "Sale requires one unambiguous unit inventory component", 422);
    }
    const mapping=mappings.rows[0];
    const previous=resolved.get(mapping.variant_id);
    const quantity=(previous?.quantity ?? 0)+Number(item.quantity);
    if (!Number.isSafeInteger(quantity)) throw new PlatformError("validation_error", "Combined quantity exceeds safe integer range", 400);
    resolved.set(mapping.variant_id, { variantId:mapping.variant_id,quantity,inventoryItemId:mapping.inventory_item_id,
      visionContexts:[...(previous?.visionContexts ?? []),...normalizeSaleItemVisionContexts(item)] });
  }
  const ordered=[...resolved.values()].sort((a,b)=>a.inventoryItemId<b.inventoryItemId ? -1 : a.inventoryItemId>b.inventoryItemId ? 1
    : a.variantId<b.variantId ? -1 : a.variantId>b.variantId ? 1 : 0);
  const remainingStock = new Map<string,number>();
  // Both absent-row materialization and existing-row locks follow this stable
  // inventory-item order across POS, Telegram and provider-paid callers.
  for (const item of ordered) {
    const inventoryItem = { inventory_item_id:item.inventoryItemId };
    // A newly-created store can legitimately have no inventory_level row yet.
    // Materialize a zero level inside the sale transaction so checkout reaches
    // the normal shortage/found-stock flow instead of misreporting the variant
    // as missing. If confirmation is not supplied, the transaction rolls this
    // insert back together with the structured shortage warning.
    await client.query(`
      INSERT INTO public.inventory_level (
        id,
        inventory_item_id,
        location_id,
        stocked_quantity,
        reserved_quantity,
        incoming_quantity
      )
      VALUES ($1, $2, $3, 0, 0, 0)
      ON CONFLICT (inventory_item_id, location_id) WHERE deleted_at IS NULL
      DO NOTHING
    `, [id("ilev"), inventoryItem.inventory_item_id, stockLocationId]);

    const params: (string | null)[] = [item.variantId, stockLocationId, merchantId];
    const row = await queryOne<{
      product_id: string;
      product_title: string;
      product_handle: string;
      variant_id: string;
      variant_title: string;
      sku: string;
      barcode: string;
      price: string | null;
      cost_price: string;
      cost_evidence_updated_at: Date | string | null;
      reorder_level: number;
      inventory_item_id: string;
      inventory_level_id: string;
      stocked_quantity: string;
    }>(client, `
      SELECT
        p.id AS product_id,
        p.title AS product_title,
        p.handle AS product_handle,
        v.id AS variant_id,
        v.title AS variant_title,
        COALESCE(v.sku, '') AS sku,
        COALESCE(v.barcode, '') AS barcode,
        pr.amount::numeric AS price,
        COALESCE(ps.cost_price, 0)::numeric AS cost_price,
        ps.updated_at AS cost_evidence_updated_at,
        COALESCE(ps.reorder_level, 5) AS reorder_level,
        vii.inventory_item_id,
        il.id AS inventory_level_id,
        il.stocked_quantity::numeric AS stocked_quantity
      FROM public.product_variant v
      JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
      LEFT JOIN public.product_variant_price_set vps ON vps.variant_id = v.id AND vps.deleted_at IS NULL
      LEFT JOIN public.price pr ON pr.price_set_id = vps.price_set_id AND pr.currency_code = 'vnd' AND pr.deleted_at IS NULL
      JOIN public.product_variant_inventory_item vii ON vii.variant_id = v.id AND vii.deleted_at IS NULL
      JOIN public.inventory_level il ON il.inventory_item_id = vii.inventory_item_id AND il.deleted_at IS NULL
        AND il.location_id = $2
      LEFT JOIN inventory.product_settings ps ON ps.variant_id = v.id
      WHERE v.deleted_at IS NULL AND v.id = $1
        AND p.merchant_id = $3
      LIMIT 1
      FOR UPDATE OF il
    `, params);
    if (!row) throw new PlatformError("resource_not_found", `Inventory location not found: ${stockLocationId}`, 404);
    if (row.price === null) throw new PlatformError("variant_price_unavailable", "Product has no current VND price", 409);

    const quantity = Number(item.quantity);
    const stock = remainingStock.get(row.inventory_level_id) ?? Number(row.stocked_quantity);
    remainingStock.set(row.inventory_level_id, Math.max(0, stock - quantity));
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new PlatformError("validation_error", "Quantity must be a positive integer", 400);
    }

    lines.push({
      ...row,
      quantity,
      stock,
      price: Number(row.price),
      costPrice: Number(row.cost_price),
      costEvidenceUpdatedAt: row.cost_evidence_updated_at,
      lineTotal: Number(row.price) * quantity,
      lineCogs: Number(row.cost_price) * quantity,
      visionContexts: normalizeSaleItemVisionContexts(item),
    });
  }
  return lines;
}

function shortageLines(lines: SaleLine[]): SaleLine[] {
  return lines.filter((line) => line.stock < line.quantity);
}

function shortageDetails(lines: SaleLine[]) {
  return lines.map((line) => ({
    variantId: line.variant_id,
    productId: line.product_id,
    productName: line.product_title,
    sku: line.sku,
    systemStock: line.stock,
    requestedQuantity: line.quantity,
    shortageQuantity: Math.max(0, line.quantity - line.stock),
    unitCost: line.costPrice,
  }));
}

function requireFoundStockCostPrices(lines: SaleLine[]): void {
  const missing = lines.find((line) => line.costPrice <= 0);
  if (missing) {
    throw new PlatformError(
      "missing_cost_price",
      `Cost price is required before found-stock checkout for ${missing.product_title}`,
      409,
      {
        variantId: missing.variant_id,
        productId: missing.product_id,
        productName: missing.product_title,
        sku: missing.sku,
        unitCost: missing.costPrice,
      },
    );
  }
}

function buildFoundStockAdjustments(
  lines: SaleLine[],
  confirmation: FoundStockConfirmationInput | undefined,
  actor: OrderWorkflowActor,
  options: OrderWorkflowOptions,
): FoundStockAdjustment[] {
  const shortages = shortageLines(lines);
  if (shortages.length === 0) return [];

  if (options.source !== "pos") {
    const first = shortages[0];
    throw new PlatformError("insufficient_stock", `${first.product_title} has only ${first.stock} units in stock`, 409, {
      shortages: shortageDetails(shortages),
    });
  }

  requireFoundStockCostPrices(shortages);

  const acknowledged = new Set(
    (confirmation?.acknowledgedShortages || [])
      .map((item) => String(item.variantId || ""))
      .filter(Boolean),
  );
  const confirmed = confirmation?.confirmed === true
    && (!confirmation.reasonCode || confirmation.reasonCode === "found_stock");
  const unacknowledged = shortages.filter((line) => !acknowledged.has(line.variant_id));

  if (!confirmed || unacknowledged.length > 0) {
    throw new PlatformError(
      "stock_shortage_requires_confirmation",
      "Stock shortage requires found-stock confirmation",
      409,
      { shortages: shortageDetails(shortages) },
    );
  }

  return shortages.map((line) => {
    const adjustedQuantity = line.quantity - line.stock;
    return {
      type: "found_stock",
      reasonCode: "found_stock",
      reason: "Tìm thấy",
      productId: line.product_id,
      variantId: line.variant_id,
      productName: line.product_title,
      sku: line.sku,
      inventoryItemId: line.inventory_item_id,
      systemStockBefore: line.stock,
      requestedQuantity: line.quantity,
      adjustedQuantity,
      unitCost: line.costPrice,
      inventoryValue: adjustedQuantity * line.costPrice,
      performedBy: businessActorId(actor),
    };
  });
}

function calculateTotals(subtotal: number, discountPercent = 0, shippingFeeInput: unknown = 0) {
  return calculateOrderTotals(subtotal, { discountPercent, shippingFee: Number(shippingFeeInput) || 0 }, shippingFeeInput);
}

function calculateTotalsFromInput(
  subtotal: number,
  input: {
    discountPercent?: number;
    discountType?: "percent" | "amount";
    discountValue?: number;
    shippingFee?: number;
    paymentFeeType?: "percent" | "amount";
    paymentFeeValue?: number;
  },
  commercialContext: CommercialAdjustmentContext = { vatRate: vatRate(), taxMode: taxMode() },
) {
  const fee = readPaymentFeeInput(input);
  if (fee) return calculateOrderTotalsV2(subtotal, { ...input, ...fee }, input.shippingFee ?? 0,
    { taxMode: commercialContext.taxMode, vatRatePpm: commercialContext.vatRatePpm ?? vatRatePpmFromRate(commercialContext.vatRate) });
  return calculateOrderTotals(subtotal, {
    discountPercent: input.discountPercent,
    discountType: input.discountType,
    discountValue: input.discountValue,
    shippingFee: input.shippingFee,
  }, input.shippingFee, commercialContext);
}
export async function formatOrder(client: PoolClient, orderId: string) {
  const order = await queryOne<Record<string, unknown>>(client, `
    SELECT
      o.id,
      COALESCE(o.custom_display_id, 'ORD-' || o.display_id::text) AS order_number,
      o.status::text AS status,
      o.customer_id,
      o.email,
      o.metadata,
      o.created_at,
      o.merchant_id,
      o.store_id,
      c.first_name,
      c.last_name,
      c.phone
    FROM public."order" o
    LEFT JOIN public.customer c ON c.id = o.customer_id
    WHERE o.id = $1 AND o.deleted_at IS NULL
  `, [orderId]);
  if (!order) return null;

  const items = await client.query(`
    SELECT
      li.product_id AS "productId",
      li.variant_id AS "variantId",
      li.title AS name,
      oi.quantity::numeric AS quantity,
      li.unit_price::numeric AS "unitPrice",
      (oi.quantity::numeric * li.unit_price::numeric) AS "lineTotal"
    FROM public.order_item oi
    JOIN public.order_line_item li ON li.id = oi.item_id
    WHERE oi.order_id = $1 AND oi.deleted_at IS NULL AND li.deleted_at IS NULL
    ORDER BY li.created_at ASC
  `, [orderId]);
  const creator = await queryOne<{
    actor_id: string;
    actor_type: string;
    channel: string | null;
    channel_user_id: string | null;
    service_identity: string | null;
    created_at: Date;
    display_name: string | null;
    staff_role: string | null;
  }>(client, `
    SELECT
      ae.actor_id,
      ae.actor_type,
      ae.channel,
      ae.channel_user_id,
      ae.service_identity,
      ae.created_at,
      su.display_name,
      su.role AS staff_role
    FROM audit.events ae
    LEFT JOIN medusa.staff_users su ON su.operator_id = ae.actor_id AND ae.actor_type <> 'partner'
    WHERE ae.subject_type = 'order'
      AND ae.subject_id = $1
      AND ae.action IN ('order.created', 'order.remote_created', 'order.partner_created')
    ORDER BY ae.created_at ASC
    LIMIT 1
  `, [orderId]);
  const metadata = (order.metadata || {}) as Record<string, unknown>;
  const stockAdjustments = Array.isArray(metadata.stockAdjustments) ? metadata.stockAdjustments : [];
  // Resolve each legacy receipt against its own canonical obligation. The raw
  // mirror status remains immutable; aggregate order receipts cannot resolve an
  // unrelated correction or a partially collected obligation.
  const payments = await client.query(`
    SELECT entry.*, resolved.obligation_count, resolved.obligation_amount_minor,
      resolved.collected_amount_minor
    FROM app.payment_entries entry
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS obligation_count,
        max(obligations.amount_minor)::text AS obligation_amount_minor,
        max(collections.amount_minor)::text AS collected_amount_minor
      FROM app.commercial_obligations obligations
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(allocation.amount_minor), 0) AS amount_minor
        FROM app.payment_event_allocations allocation
        JOIN app.payment_events event ON event.id = allocation.payment_event_id
          AND event.merchant_id = allocation.merchant_id AND event.store_id = allocation.store_id
        WHERE allocation.obligation_id = obligations.id
          AND allocation.merchant_id = obligations.merchant_id
          AND allocation.store_id = obligations.store_id
          AND allocation.allocation_kind = 'collection'
          AND event.kind = 'charge' AND event.status = 'posted'
      ) collections ON true
      WHERE entry.status = 'pending' AND entry.direction = 'charge'
        AND entry.method IN ('bank_transfer', 'manual_bank')
        AND obligations.order_id = entry.order_id
        AND obligations.merchant_id = entry.merchant_id AND obligations.store_id = entry.store_id
        AND obligations.currency_code = upper(entry.currency_code)
        AND obligations.amount_minor = entry.amount
        AND CASE
          WHEN entry.metadata->>'canonicalPaymentObligationId' IS NOT NULL
            THEN obligations.id::text = entry.metadata->>'canonicalPaymentObligationId'
          WHEN entry.metadata->>'canonicalPaymentEventId' IS NOT NULL THEN EXISTS (
            SELECT 1 FROM app.payment_events pending
            WHERE pending.id::text = entry.metadata->>'canonicalPaymentEventId'
              AND pending.merchant_id = obligations.merchant_id AND pending.store_id = obligations.store_id
              AND pending.order_id = obligations.order_id AND pending.status = 'pending'
              AND pending.commercial_revision_id = obligations.commercial_revision_id
          )
          WHEN entry.metadata->>'correctionId' IS NOT NULL
            THEN obligations.obligation_kind = 'order_correction_charge'
              AND obligations.source_id = entry.metadata->>'correctionId'
          ELSE obligations.obligation_kind = 'order_charge'
        END
    ) resolved ON true
    WHERE entry.order_id = $1
    ORDER BY entry.created_at ASC, entry.id ASC
  `, [orderId]);
  const paymentEntries = payments.rows.map((payment) => {
    const paymentMetadata = (payment.metadata || {}) as Record<string, unknown>;
    return {
      id: String(payment.id),
      direction: String(payment.direction),
      method: String(payment.method),
      amount: Number(payment.amount || 0),
      currencyCode: String(payment.currency_code || "vnd"),
      status: String(payment.status),
      ...(Number(payment.obligation_count) === 1 ? {
        effectiveStatus: Number(payment.collected_amount_minor) >= Number(payment.obligation_amount_minor)
          ? "posted" : Number(payment.collected_amount_minor) > 0 ? "partially_collected" : "pending",
        collectedAmountMinor: Number(payment.collected_amount_minor),
        remainingAmountMinor: Math.max(0, Number(payment.obligation_amount_minor) - Number(payment.collected_amount_minor)),
      } : {}),
      reference: payment.reference ? String(payment.reference) : null,
      reason: payment.reason ? String(payment.reason) : null,
      paymentIntentId: paymentMetadata.paymentIntentId ? String(paymentMetadata.paymentIntentId) : null,
      paymentProvider: paymentMetadata.paymentProvider ? String(paymentMetadata.paymentProvider) : null,
      providerEventId: paymentMetadata.providerEventId ? String(paymentMetadata.providerEventId) : null,
      providerReference: paymentMetadata.providerReference ? String(paymentMetadata.providerReference) : null,
      referenceCode: paymentMetadata.referenceCode ? String(paymentMetadata.referenceCode) : null,
      providerTransactionId: paymentMetadata.providerTransactionId ? String(paymentMetadata.providerTransactionId) : null,
      providerTransactionHash: paymentMetadata.providerTransactionHash ? String(paymentMetadata.providerTransactionHash) : null,
      providerNetwork: paymentMetadata.providerNetwork ? String(paymentMetadata.providerNetwork) : null,
      providerPayCurrency: paymentMetadata.providerPayCurrency ? String(paymentMetadata.providerPayCurrency) : null,
      source: paymentMetadata.source ? String(paymentMetadata.source) : null,
      correctionId: paymentMetadata.correctionId ? String(paymentMetadata.correctionId) : null,
      canonicalPaymentEventId: paymentMetadata.canonicalPaymentEventId
        ? String(paymentMetadata.canonicalPaymentEventId)
        : null,
      customerRefundPayableId: paymentMetadata.customerRefundPayableId
        ? String(paymentMetadata.customerRefundPayableId)
        : null,
      createdBy: String(payment.created_by),
      createdAt: isoTimestamp(payment.created_at),
    };
  });
  const chargeEntry = paymentEntries.find((payment) => payment.direction === "charge");
  const canonicalPaymentLifecycle = await queryOne<{
    obligation_count: number;
    uncollected_count: number;
  }>(client, `
    SELECT
      count(*)::int AS obligation_count,
      count(*) FILTER (
        WHERE coalesce(collections.collected_minor, 0) < obligations.amount_minor
      )::int AS uncollected_count
    FROM app.commercial_obligations obligations
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(allocations.amount_minor), 0) AS collected_minor
      FROM app.payment_event_allocations allocations
      WHERE allocations.merchant_id = obligations.merchant_id
        AND allocations.store_id = obligations.store_id
        AND allocations.obligation_id = obligations.id
        AND allocations.allocation_kind = 'collection'
    ) collections ON true
    WHERE obligations.merchant_id = $1
      AND obligations.store_id = $2
      AND obligations.order_id = $3
  `, [String(order.merchant_id || ""), String(order.store_id || ""), orderId]);
  const canonicalPaymentStatus = Number(canonicalPaymentLifecycle?.obligation_count || 0) > 0
    ? Number(canonicalPaymentLifecycle?.uncollected_count || 0) > 0
      ? "pending"
      : "posted"
    : null;
  const canonicalPaymentSummaryRow = await queryOne<{
    recorded_gross_collections_minor: string;
    refunds_minor: string;
    reversals_minor: string;
    chargebacks_minor: string;
    customer_refund_payable_minor: string;
  }>(client, `
    SELECT
      coalesce(sum(events.amount_minor) FILTER (
        WHERE events.kind = 'charge' AND events.status = 'posted'
      ), 0)::text AS recorded_gross_collections_minor,
      coalesce(sum(events.amount_minor) FILTER (
        WHERE events.kind = 'refund' AND events.status = 'posted'
      ), 0)::text AS refunds_minor,
      coalesce(sum(events.amount_minor) FILTER (
        WHERE events.kind = 'reversal' AND events.status = 'posted'
      ), 0)::text AS reversals_minor,
      coalesce(sum(events.amount_minor) FILTER (
        WHERE events.kind = 'chargeback' AND events.status = 'posted'
      ), 0)::text AS chargebacks_minor,
      coalesce((
        SELECT sum(balances.balance_minor)
        FROM app.customer_refund_payable_balances balances
        WHERE balances.merchant_id = $1
          AND balances.store_id = $2
          AND balances.order_id = $3
      ), 0)::text AS customer_refund_payable_minor
    FROM app.payment_events events
    WHERE events.merchant_id = $1
      AND events.store_id = $2
      AND events.order_id = $3
  `, [String(order.merchant_id || ""), String(order.store_id || ""), orderId]);
  const recordedGrossCollectionsMinor = Number(
    canonicalPaymentSummaryRow?.recorded_gross_collections_minor || 0,
  );
  const refundsMinor = Number(canonicalPaymentSummaryRow?.refunds_minor || 0);
  const reversalsMinor = Number(canonicalPaymentSummaryRow?.reversals_minor || 0);
  const chargebacksMinor = Number(canonicalPaymentSummaryRow?.chargebacks_minor || 0);
  const negativeCollectionsMinor = refundsMinor + reversalsMinor + chargebacksMinor;
  const correctionProjection = await getOrderCorrectionProjectionForClient(client, orderId);
  const effectiveTotals = correctionProjection.effectiveTotals;
  const effectiveItems = correctionProjection.effectiveItems;
  return {
    id: order.id,
    orderId: order.id,
    orderNumber: order.order_number,
    display_id: order.order_number,
    status: order.status,
    merchantId: order.merchant_id ? String(order.merchant_id) : null,
    storeId: order.store_id ? String(order.store_id) : null,
    subtotal: Number(effectiveTotals?.subtotal ?? metadata.subtotal ?? 0),
    merchandisePayable: Number(effectiveTotals?.merchandisePayable ?? metadata.merchandisePayable ?? Math.max(0, Number(metadata.subtotal || 0) - Number(metadata.discount || 0))),
    shippingFee: Number(effectiveTotals?.shippingFee ?? metadata.shippingFee ?? 0),
    merchandiseTax: Number(effectiveTotals?.merchandiseTax ?? metadata.merchandiseTax ?? metadata.tax ?? 0),
    shippingTax: Number(effectiveTotals?.shippingTax ?? metadata.shippingTax ?? 0),
    merchandiseRevenue: Number(effectiveTotals?.merchandiseRevenue ?? metadata.merchandiseRevenue ?? 0),
    shippingRevenue: Number(effectiveTotals?.shippingRevenue ?? metadata.shippingRevenue ?? 0),
    loyaltyBase: Number(effectiveTotals?.loyaltyBase ?? metadata.loyaltyBase ?? Math.max(0, Number(metadata.subtotal || 0) - Number(metadata.discount || 0))),
    tax: Number(effectiveTotals?.tax ?? metadata.tax ?? 0),
    discount: Number(effectiveTotals?.discount ?? metadata.discount ?? 0),
    total: Number(effectiveTotals?.total ?? metadata.total ?? 0),
    change: Number(metadata.change || 0),
    paymentMethod: String(metadata.paymentMethod || "cash"),
    paymentStatus: canonicalPaymentStatus || chargeEntry?.status || null,
    manualBankConfirmationEnabled: readManualBankConfirmationRuntimeConfigV1().enabled,
    canonicalPaymentSummary: {
      recordedGrossCollectionsMinor,
      refundsMinor,
      reversalsMinor,
      chargebacksMinor,
      negativeCollectionsMinor,
      netCollectionsMinor: recordedGrossCollectionsMinor - negativeCollectionsMinor,
      customerRefundPayableMinor: Number(
        canonicalPaymentSummaryRow?.customer_refund_payable_minor || 0,
      ),
    },
    paymentEntries,
    notes: typeof metadata.notes === "string" ? metadata.notes : null,
    salesChannel: metadata.sourceFlow === "partner_api_v1" ? "partner_api" : normalizeSalesChannel(metadata.salesChannel, "pos_counter"),
    salesChannelLabel: metadata.sourceFlow === "partner_api_v1" ? SALES_CHANNEL_LABELS.partner_api
      : salesChannelLabel(normalizeSalesChannel(metadata.salesChannel, "pos_counter")),
    salesChannelLocked: metadata.salesChannelLocked === true,
    salesChannelLockReason: typeof metadata.salesChannelLockReason === "string" ? metadata.salesChannelLockReason : null,
    sourceFlow: typeof metadata.sourceFlow === "string" ? metadata.sourceFlow : null,
    scanGoCartId: typeof metadata.scanGoCartId === "string" ? metadata.scanGoCartId : null,
    scanGoRedeemedAt: typeof metadata.scanGoRedeemedAt === "string" ? metadata.scanGoRedeemedAt : null,
    customerNickname: typeof metadata.customerNickname === "string" ? metadata.customerNickname : null,
    customerContactType: typeof metadata.customerContactType === "string" ? metadata.customerContactType : null,
    redeemedByOperatorId: typeof metadata.redeemedByOperatorId === "string" ? metadata.redeemedByOperatorId : null,
    telegramSalesDraftId: typeof metadata.telegramSalesDraftId === "string" ? metadata.telegramSalesDraftId : null,
    shiftId: typeof metadata.shiftId === "string" ? metadata.shiftId : null,
    shiftOpenedAt: typeof metadata.shiftOpenedAt === "string" ? metadata.shiftOpenedAt : null,
    shiftAttribution: typeof metadata.shiftAttribution === "string" ? metadata.shiftAttribution : null,
    shiftQueuedAt: typeof metadata.shiftQueuedAt === "string" ? metadata.shiftQueuedAt : null,
    stockAdjustments,
    items: effectiveItems || items.rows,
    originalItems: items.rows,
    correctionSummary: correctionProjection.correctionSummary,
    corrections: correctionProjection.corrections,
    createdBy: creator ? {
      operatorId: creator.actor_type === "partner" ? null : creator.actor_id,
      actorType: creator.actor_type === "partner" ? "partner" : "staff",
      actorId: creator.actor_id,
      displayName: creator.display_name || creator.actor_id,
      role: creator.staff_role || creator.actor_type,
      channel: creator.channel,
      channelUserId: creator.channel_user_id,
      serviceIdentity: creator.service_identity,
      createdAt: isoTimestamp(creator.created_at),
    } : undefined,
    customerId: order.customer_id,
    customerAttribution: order.customer_id
      ? "linked"
      : metadata.customerAttributionMode === "walk_in"
        ? "walk_in"
        : "unknown",
    customer: order.customer_id ? {
      id: order.customer_id,
      first_name: order.first_name,
      last_name: order.last_name,
      phone: order.phone,
      email: order.email,
    } : undefined,
    createdAt: isoTimestamp(order.created_at),
    created_at: isoTimestamp(order.created_at),
  };
}

async function resolveRecreateSource(
  client: PoolClient,
  sourceOrderId: string | undefined,
  merchantId: string,
  storeId: string,
): Promise<{ id: string; orderNumber: string } | null> {
  const normalizedId = String(sourceOrderId || "").trim();
  if (!normalizedId) return null;
  const source = await queryOne<{
    id: string;
    order_number: string;
    merchant_id: string | null;
    store_id: string | null;
  }>(client, `
    SELECT
      o.id::text,
      COALESCE(o.custom_display_id, 'ORD-' || o.display_id::text) AS order_number,
      o.merchant_id,
      o.store_id
    FROM public."order" o
    WHERE o.id = $1 AND o.deleted_at IS NULL
  `, [normalizedId]);
  if (!source) throw new PlatformError("resource_not_found", "Source order for recreate was not found", 404);
  if (source.merchant_id !== merchantId || source.store_id !== storeId) {
    throw new PlatformError("forbidden", "Source order is outside the active merchant/store scope", 403);
  }
  return { id: source.id, orderNumber: source.order_number };
}

/** Transaction-aware shared core. Caller owns BEGIN/COMMIT/ROLLBACK and schema
 * readiness; this port never opens another connection or runs schema DDL. */
export interface PartnerCoreOrderReceipt {
  orderId: string; orderNumber: string; total: number; createdAt: string;
  paymentEntryId: string | null; paymentStatus: string | null;
}
type StaffCoreOrderReceipt = NonNullable<Awaited<ReturnType<typeof formatOrder>>> & {
  medusaStatus?: string; remoteStatus?: string; paymentEntryId?: string; paymentStatus?: string | null;
  financial?: ReturnType<typeof paymentFeeFinancialSnapshotV1>;
};
export function createOrderForClient(client: PoolClient, input: NormalizedOrderInput, actor: PartnerBusinessActor,
  options: OrderWorkflowOptions): Promise<{ data: PartnerCoreOrderReceipt }>;
export function createOrderForClient(client: PoolClient, input: NormalizedOrderInput, actor: OperatorContext | ChannelActor,
  options: OrderWorkflowOptions): Promise<{ data: StaffCoreOrderReceipt }>;
export async function createOrderForClient(
  client: PoolClient,
  input: NormalizedOrderInput,
  actor: OrderWorkflowActor,
  options: OrderWorkflowOptions,
): Promise<{ data: PartnerCoreOrderReceipt | StaffCoreOrderReceipt }> {
  const scope = orderWorkflowScope(options);
  if (isPartnerBusinessActor(actor)) await lockActivePartnerBusinessScopeForClient(client, scope.merchantId, scope.storeId);
  else await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
  await assertOrderStockLocationForClient(client, scope);
  if (!isPartnerBusinessActor(actor)) await lockScanGoCartForOrder(client, input, scope);
  return createOrderForClientInternal(client, input, actor, options);
}

function orderWorkflowScope(options: OrderWorkflowOptions) {
  if (!options.stockLocationId) {
    throw new PlatformError("scope_required", "Order workflow requires stockLocationId", 409);
  }
  const orderMerchantId = options.merchantId
    || (typeof options.paymentMetadata?.merchantId === "string" ? options.paymentMetadata.merchantId : undefined);
  const orderStoreId = options.storeId
    || (typeof options.paymentMetadata?.storeId === "string" ? options.paymentMetadata.storeId : undefined);
  if (!orderMerchantId || !orderStoreId) {
    throw new PlatformError("scope_required", "Order creation requires merchant and store provenance", 409);
  }
  return { merchantId: orderMerchantId, storeId: orderStoreId, stockLocationId: options.stockLocationId };
}

async function assertOrderStockLocationForClient(client: PoolClient, scope: ReturnType<typeof orderWorkflowScope>) {
  const store = await queryOne<{ stock_location_id: string }>(client,
    "SELECT stock_location_id FROM app.stores WHERE merchant_id=$1 AND id=$2", [scope.merchantId, scope.storeId]);
  if (!store || store.stock_location_id !== scope.stockLocationId) {
    throw new PlatformError("forbidden", "Order stock location differs from its store", 403);
  }
}

async function createOrderForClientInternal(
  client: PoolClient, input: NormalizedOrderInput, actor: OrderWorkflowActor, options: OrderWorkflowOptions,
  settlement?: Awaited<ReturnType<typeof verifyProviderOrderLifecycleForClient>>,
) {
  const { merchantId: orderMerchantId, storeId: orderStoreId, stockLocationId } = orderWorkflowScope(options);
  if (readPaymentFeeInput(input) && (options.source !== "pos" || isPartnerBusinessActor(actor))) {
    throw new PlatformError("validation_error", "Payment fee is only supported by POS checkout", 400);
  }
  if (isPartnerBusinessActor(actor)) {
    if (actor.merchantId !== orderMerchantId || actor.storeId !== orderStoreId || !actor.organizationId
      || options.source !== "remote" || input.paymentMethod !== "cod" || input.amountReceived !== 0
      || input.shiftId || input.shiftAttribution || input.foundStockConfirmation || input.customerId
      || input.sourceOrderId || input.scanGoCartId || input.redeemedByOperatorId || options.manualBankConfirmation
      || options.paymentMetadata || input.discountPercent || input.discountValue || input.notes
      || input.salesChannel !== "website" || input.sourceFlow !== "partner_api_v1") {
      throw new PlatformError("forbidden", "Invalid partner commerce context", 403);
    }
  }
  if (isPartnerBusinessActor(actor)) {
    // PostgreSQL rejects SAVEPOINT outside a transaction before any commerce
    // write. The facade must own the full atomic booking boundary.
    await client.query("SAVEPOINT partner_core_transaction_guard; RELEASE SAVEPOINT partner_core_transaction_guard");
  }
  const foundStockPolicy = options.source === "pos" && !settlement?.suspended
    ? await readFoundStockPolicyForClient(client, orderMerchantId, true) : null;
  const recreateSource = await resolveRecreateSource(
    client,
    input.sourceOrderId,
    orderMerchantId,
    orderStoreId,
  );
  const lines = await getSaleLinesForUpdate(client, input.items || [], stockLocationId, orderMerchantId);
  if (lines.length === 0) {
    throw new PlatformError("validation_error", "At least one order item is required", 400);
  }
  if (options.source === "pos" && shortageLines(lines).length > 0) {
    if (!foundStockPolicy?.enabled) throw new PlatformError("insufficient_stock", "Merchant does not allow found-stock checkout", 409,
      { shortages: shortageDetails(shortageLines(lines)) });
  }
  const foundStockAdjustments = buildFoundStockAdjustments(lines, input.foundStockConfirmation, actor, options);
  const foundStockByVariant = new Map(foundStockAdjustments.map((adjustment) => [adjustment.variantId, adjustment]));

  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const commercialContext = options.commercialContext ?? { vatRate: vatRate(), taxMode: taxMode() };
  const totals = calculateTotalsFromInput(subtotal, input, commercialContext);
  const financial = paymentFeeFinancialSnapshotV1(totals);
  assertFinancialSaleLines(input, lines, totals.commercialAdjustmentVersion);
  if (financial && input.cartConfirmationToken && (!orderStoreId || input.cartConfirmationToken !== cartPaymentFeeConfirmationV1(
    { merchantId: orderMerchantId, storeId: orderStoreId, stockLocationId }, financial,
    lines.map(line => ({ productId: line.product_id, variantId: line.variant_id, quantity: line.quantity, unitPrice: line.price, lineTotal: line.lineTotal })),
  ))) throw new PlatformError("cart_quote_changed", "Cart prices or charges changed; review the current preview before confirming", 409);
  const paymentFeeSnapshot = totals.commercialAdjustmentVersion === 2 ? {
    commercialCalculationVersion: 2, taxMode: totals.taxMode, vatRatePpm: totals.vatRatePpm,
    paymentFeeType: totals.paymentFeeType, paymentFeeValue: totals.paymentFeeValue, paymentFeeBasisMinor: totals.paymentFeeBasisMinor,
    paymentFeeMinor: totals.paymentFeeMinor, paymentFeeVatMinor: totals.paymentFeeVatMinor, paymentFeeRevenueMinor: totals.paymentFeeRevenueMinor,
  } : {};
  const change = input.paymentMethod === "cash" ? Math.max(0, input.amountReceived - totals.total) : 0;
  if (input.paymentMethod === "cash" && input.amountReceived < totals.total) {
    throw new PlatformError("validation_error", "Amount received is less than total", 400);
  }

  const customer = await findCustomer(client, input.customerId, orderMerchantId);
  if (input.customerId && !customer) throw new PlatformError("resource_not_found", "Customer not found", 404);
  const customerAttributionMode = resolvedCustomerAttributionMode(input);

  const orderId = id("order");
  const workflowMetadata = {
    source: options.source,
    remoteStatus: options.remoteStatus || null,
    paymentMethod: input.paymentMethod,
    amountReceived: input.amountReceived,
    subtotal: totals.subtotal,
    discount: totals.discount,
    merchandisePayable: totals.merchandisePayable,
    shippingFee: totals.shippingFee,
    merchandiseTax: totals.merchandiseTax,
    shippingTax: totals.shippingTax,
    merchandiseRevenue: totals.merchandiseRevenue,
    shippingRevenue: totals.shippingRevenue,
    loyaltyBase: totals.loyaltyBase,
    tax: totals.tax,
    total: totals.total,
    change,
    commercialAdjustmentVersion: totals.commercialAdjustmentVersion,
    ...paymentFeeSnapshot,
    discountType: totals.discountType,
    discountValue: totals.discountValue,
    discountPercent: totals.discountPercent,
    recreatedFromOrderId: recreateSource?.id || null,
    recreatedFromOrderNumber: recreateSource?.orderNumber || null,
    createdBy: businessActorId(actor),
    createdByRole: isPartnerBusinessActor(actor) ? "partner" : actor.role || null,
    createdByName: isPartnerBusinessActor(actor) || isChannelActor(actor) ? null : actor.displayName,
    notes: input.notes || null,
    salesChannel: input.salesChannel,
    salesChannelLabel: salesChannelLabel(input.salesChannel),
    sourceFlow: input.sourceFlow || null,
    scanGoCartId: input.scanGoCartId || null,
    scanGoRedeemedAt: input.scanGoRedeemedAt || null,
    salesChannelLocked: input.salesChannelLocked === true,
    salesChannelLockReason: input.salesChannelLocked ? "customer_scan_go_tracking" : null,
    customerNickname: input.customerNickname || null,
    customerContactType: input.customerContactType || null,
    customerAttributionMode,
    redeemedByOperatorId: input.redeemedByOperatorId || null,
    telegramSalesDraftId: input.telegramSalesDraftId || null,
    telegramSalesOperatorNotes: input.telegramSalesOperatorNotes || null,
    shiftId: input.shiftId || null,
    shiftOpenedAt: input.shiftOpenedAt || null,
    shiftAttribution: input.shiftAttribution || null,
    shiftQueuedAt: input.queuedAt || null,
    stockAdjustments: foundStockAdjustments.map((adjustment) => ({
      type: adjustment.type,
      reasonCode: adjustment.reasonCode,
      reason: adjustment.reason,
      productId: adjustment.productId,
      variantId: adjustment.variantId,
      productName: adjustment.productName,
      sku: adjustment.sku,
      systemStockBefore: adjustment.systemStockBefore,
      requestedQuantity: adjustment.requestedQuantity,
      adjustedQuantity: adjustment.adjustedQuantity,
      unitCost: adjustment.unitCost,
      inventoryValue: adjustment.inventoryValue,
      performedBy: adjustment.performedBy,
    })),
    ...channelMetadata(actor),
  };
  const orderInsert = await client.query<{
    display_id: number | string;
    created_at: Date | string;
  }>(`
    INSERT INTO public."order" (id, region_id, customer_id, sales_channel_id, status, email, currency_code, metadata, merchant_id, store_id)
    VALUES ($1, 'reg_vn', $2, $3, $4, $5, 'vnd', $6::jsonb, $7, $8)
    RETURNING display_id, created_at
  `, [
    orderId,
    input.customerId || null,
    options.salesChannelId,
    options.orderStatus,
    customer?.email || null,
    JSON.stringify(workflowMetadata),
    orderMerchantId,
    orderStoreId,
  ]);
  const orderCreatedAt = isoTimestamp(orderInsert.rows[0]!.created_at) || "";
  const orderNumber = `ORD-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${String(orderInsert.rows[0]!.display_id).padStart(4, "0")}`;
  await client.query("UPDATE public.\"order\" SET custom_display_id = $2 WHERE id = $1", [orderId, orderNumber]);
  await linkRedeemedScanGoCartToOrder(client, input, orderId, {
    merchantId: orderMerchantId,
    storeId: orderStoreId,
  });

  for (const line of lines) {
    const lineId = id("ordli");
    const orderItemId = id("orditem");
    line.orderLineItemId = lineId;
    await client.query(`
      INSERT INTO public.order_line_item (
        id, title, variant_id, product_id, product_title, product_handle, variant_sku, variant_barcode,
        variant_title, unit_price, raw_unit_price, is_tax_inclusive, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb)
    `, [
      lineId,
      line.product_title,
      line.variant_id,
      line.product_id,
      line.product_title,
      line.product_handle,
      line.sku,
      line.barcode,
      line.variant_title,
      line.price,
      JSON.stringify(rawNumber(line.price)),
      commercialContext.taxMode === "inclusive",
      JSON.stringify({
        costPrice: line.costPrice,
        vision: line.visionContexts[0],
        visionContexts: line.visionContexts.length > 0 ? line.visionContexts : undefined,
        foundStockAdjustment: foundStockByVariant.has(line.variant_id)
          ? {
              reasonCode: "found_stock",
              reason: "Tìm thấy",
              systemStockBefore: foundStockByVariant.get(line.variant_id)?.systemStockBefore,
              adjustedQuantity: foundStockByVariant.get(line.variant_id)?.adjustedQuantity,
            }
          : undefined,
      }),
    ]);
    await client.query(`
      INSERT INTO public.order_item (
        id, order_id, version, item_id, quantity, raw_quantity,
        fulfilled_quantity, shipped_quantity, return_requested_quantity, return_received_quantity,
        return_dismissed_quantity, written_off_quantity, delivered_quantity, unit_price, raw_unit_price
      ) VALUES ($1, $2, 1, $3, $4, $5::jsonb, 0, 0, 0, 0, 0, 0, 0, $6, $7::jsonb)
    `, [orderItemId, orderId, lineId, line.quantity, JSON.stringify(rawNumber(line.quantity)), line.price, JSON.stringify(rawNumber(line.price))]);
    await client.query("UPDATE public.order_line_item SET totals_id = $2 WHERE id = $1", [lineId, orderItemId]);

    const foundStockAdjustment = foundStockByVariant.get(line.variant_id);
    let stockBeforeSale = line.stock;
    if (foundStockAdjustment) {
      const stockAfterFound = line.stock + foundStockAdjustment.adjustedQuantity;
      await client.query("UPDATE public.inventory_level SET stocked_quantity = $2, updated_at = now() WHERE id = $1", [line.inventory_level_id, stockAfterFound]);
      const movement = await recordStockMovement(client, {
        inventoryItemId: line.inventory_item_id,
        productId: line.product_id,
        variantId: line.variant_id,
        sku: line.sku,
        productTitle: line.product_title,
        movementType: "manual_adjustment",
        sourceAction: "found_stock",
        quantityBefore: line.stock,
        quantityChange: foundStockAdjustment.adjustedQuantity,
        quantityAfter: stockAfterFound,
        referenceType: "order_found_stock",
        referenceId: orderId,
        referenceDisplay: orderNumber,
        reason: foundStockAdjustment.reason,
        reasonCode: foundStockAdjustment.reasonCode,
        actor,
        scope: {
          merchantId: orderMerchantId,
          storeId: orderStoreId,
          stockLocationId: stockLocationId,
        },
        sourceChannel: saleStockSourceChannel(input, actor, options),
        metadata: {
          orderId,
          orderNumber,
        source: options.source,
        salesChannel: input.salesChannel,
        sourceFlow: input.sourceFlow || null,
        shiftId: input.shiftId || null,
        shiftAttribution: input.shiftAttribution || null,
      },
      });
      foundStockAdjustment.movementId = String(movement.id || "");
      stockBeforeSale = stockAfterFound;
      await emitExactOutbox(client, buildExactStockChangedEvent({
        merchantId: orderMerchantId,
        storeId: orderStoreId,
        inventoryItemId: line.inventory_item_id,
        movementId: String(movement.id),
        sourceOccurredAt: movement.created_at,
        payload: {
          orderId,
          source: options.source,
          reasonCode: "found_stock",
          productId: line.product_id,
          variantId: line.variant_id,
          quantityBefore: line.stock,
          quantityChange: foundStockAdjustment.adjustedQuantity,
          quantityAfter: stockAfterFound,
          reorderLevel: line.reorder_level,
          stockLocationId: stockLocationId,
          ...channelMetadata(actor),
        },
      }));
    }

    const newStock = stockBeforeSale - line.quantity;
    if (newStock < 0) {
      throw new PlatformError("insufficient_stock", `${line.product_title} has only ${line.stock} units in stock`, 409, {
        shortages: shortageDetails([line]),
      });
    }
    await client.query("UPDATE public.inventory_level SET stocked_quantity = $2, updated_at = now() WHERE id = $1", [line.inventory_level_id, newStock]);
    const movement = await recordStockMovement(client, {
      inventoryItemId: line.inventory_item_id,
      productId: line.product_id,
      variantId: line.variant_id,
      sku: line.sku,
      productTitle: line.product_title,
      movementType: "sale",
      sourceAction: saleStockSourceAction(input, actor, options),
      quantityBefore: stockBeforeSale,
      quantityChange: -line.quantity,
      quantityAfter: newStock,
      referenceType: "order",
      referenceId: orderId,
      referenceDisplay: orderNumber,
      reason: options.source === "remote" ? `Remote order ${orderNumber}` : `Sale ${orderNumber}`,
      reasonCode: "sale",
      actor,
      scope: {
        merchantId: orderMerchantId,
        storeId: orderStoreId,
        stockLocationId: stockLocationId,
      },
      sourceChannel: saleStockSourceChannel(input, actor, options),
      metadata: {
        orderId,
        orderNumber,
        source: options.source,
        remoteStatus: options.remoteStatus || null,
        salesChannel: input.salesChannel,
        sourceFlow: input.sourceFlow || null,
        scanGoCartId: input.scanGoCartId || null,
        shiftId: input.shiftId || null,
        shiftAttribution: input.shiftAttribution || null,
        foundStockMovementId: foundStockAdjustment?.movementId || null,
      },
    });
    await emitExactOutbox(client, buildExactStockChangedEvent({
      merchantId: orderMerchantId,
      storeId: orderStoreId,
      inventoryItemId: line.inventory_item_id,
      movementId: String(movement.id),
      sourceOccurredAt: movement.created_at,
      payload: {
        orderId,
        source: options.source,
        remoteStatus: options.remoteStatus || null,
        productId: line.product_id,
        variantId: line.variant_id,
        quantityBefore: stockBeforeSale,
        quantityChange: -line.quantity,
        quantityAfter: newStock,
        reorderLevel: line.reorder_level,
        foundStockAdjustedQuantity: foundStockAdjustment?.adjustedQuantity || 0,
        stockLocationId: stockLocationId,
        ...channelMetadata(actor),
      },
    }));
  }

  let foundStockEventId: string | null = null;
  if (foundStockAdjustments.length > 0) {
    await client.query(`
      UPDATE public."order"
      SET metadata = COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object('stockAdjustments', $2::jsonb)
      WHERE id = $1
    `, [
      orderId,
      JSON.stringify(foundStockAdjustments.map((adjustment) => ({
        type: adjustment.type,
        reasonCode: adjustment.reasonCode,
        reason: adjustment.reason,
        productId: adjustment.productId,
        variantId: adjustment.variantId,
        productName: adjustment.productName,
        sku: adjustment.sku,
        systemStockBefore: adjustment.systemStockBefore,
        requestedQuantity: adjustment.requestedQuantity,
        adjustedQuantity: adjustment.adjustedQuantity,
        unitCost: adjustment.unitCost,
        inventoryValue: adjustment.inventoryValue,
        performedBy: adjustment.performedBy,
        movementId: adjustment.movementId || null,
      }))),
    ]);
    foundStockEventId = await emitExactOutbox(client, buildExactStockFoundEvent({
      merchantId: orderMerchantId,
      storeId: orderStoreId,
      orderId,
      sourceOccurredAt: orderCreatedAt,
      payload: {
        orderNumber,
        source: options.source,
        operatorId: businessActorId(actor),
        inventoryValue: foundStockAdjustments.reduce((sum, adjustment) => sum + adjustment.inventoryValue, 0),
        stockLocationId: stockLocationId,
        items: foundStockAdjustments.map((adjustment) => ({
          productId: adjustment.productId,
          variantId: adjustment.variantId,
          inventoryItemId: adjustment.inventoryItemId,
          productName: adjustment.productName,
          sku: adjustment.sku,
          quantity: adjustment.adjustedQuantity,
          costPrice: adjustment.unitCost,
          inventoryValue: adjustment.inventoryValue,
          movementId: adjustment.movementId || null,
          systemStockBefore: adjustment.systemStockBefore,
          requestedQuantity: adjustment.requestedQuantity,
        })),
        ...channelMetadata(actor),
      },
    }));
    await recordAuditEntry(client, actor, "stock.found_adjusted_for_sale", "order", orderId, {
      after: {
        orderNumber,
        adjustments: foundStockAdjustments.map((adjustment) => ({
          variantId: adjustment.variantId,
          sku: adjustment.sku,
          adjustedQuantity: adjustment.adjustedQuantity,
          inventoryValue: adjustment.inventoryValue,
          movementId: adjustment.movementId || null,
        })),
      },
      reason: "Tìm thấy",
      correlationId: foundStockEventId,
      merchantId: orderMerchantId,
      storeId: orderStoreId,
    });
  }

  const originalRevisionDependencies: OriginalOrderCommercialRevisionCallerDependenciesV1 = {
    client,
    config: ORIGINAL_ORDER_COMMERCIAL_REVISION_CALLER_DEFAULT_CONFIG_V1,
    transactionContext: {
      ownership: "caller",
      orderCreatedInCurrentTransaction: true,
    },
    repositoryOptions: {
      statementTimeoutMs: isPartnerBusinessActor(actor) ? 3_000 : 5_000,
      lockTimeoutMs: 1_000,
    },
  };
  const originalRevisionInput: Omit<OriginalOrderCommercialRevisionCallerInputV1, "totals"> = {
    merchantId: orderMerchantId,
    storeId: orderStoreId,
    orderId,
    orderCreatedAt,
    currencyCode: "VND",
    minorUnitExponent: 0,
    commercialContext,
    lines: lines.map((line) => ({
      orderLineItemId: line.orderLineItemId || "",
      productId: line.product_id,
      variantId: line.variant_id,
      skuSnapshot: line.sku,
      titleSnapshot: line.product_title,
      quantity: line.quantity,
      unitPriceMinor: line.price,
      unitCostMinor: line.costPrice,
      costEvidenceSource: "inventory.product_settings",
      costEvidenceUpdatedAt: line.costEvidenceUpdatedAt
        ? isoTimestamp(line.costEvidenceUpdatedAt) || ""
        : "",
    })),
  };
  const originalRevisionResult = totals.commercialAdjustmentVersion === 2
    ? await recordOriginalOrderCommercialRevisionFromOrderCreateV2(originalRevisionDependencies, { ...originalRevisionInput, totals,
      commercialContext: { taxMode: totals.taxMode, vatRatePpm: totals.vatRatePpm } })
    : await recordOriginalOrderCommercialRevisionFromOrderCreateV1(originalRevisionDependencies, { ...originalRevisionInput, totals });

  const paymentProvider = typeof options.paymentMetadata?.paymentProvider === "string"
    ? options.paymentMetadata.paymentProvider
    : "";
  const paymentIntentId = typeof options.paymentMetadata?.paymentIntentId === "string"
    ? options.paymentMetadata.paymentIntentId
    : "";
  const providerEventId = typeof options.paymentMetadata?.providerEventId === "string"
    ? options.paymentMetadata.providerEventId
    : "";
  const localMockProviderSettlement = options.paymentMetadata?.localMockSettlement === true;
  const providerChargeInput: {
    provider: "sepay_va" | "nowpayments";
    paymentIntentId: string;
    providerEventId: string;
  } | null = !localMockProviderSettlement
    && (paymentProvider === "sepay_va" || paymentProvider === "nowpayments")
    ? { provider: paymentProvider, paymentIntentId, providerEventId }
    : null;
  // A zero commercial value is not a payment event. Only the trusted partner
  // COD path may omit the positive charge; verify the persisted, scoped original
  // revision in this same transaction before selecting that outcome.
  const noChargeRequired = isPartnerBusinessActor(actor) && totals.total === 0;
  if (noChargeRequired) {
    if (!originalRevisionResult.enabled || input.paymentMethod !== "cod"
      || input.amountReceived !== 0 || change !== 0 || providerChargeInput || options.manualBankConfirmation) {
      throw new PlatformError("internal_error", "Invalid zero-value commercial order", 500);
    }
    const zeroRevision = await client.query(`
      SELECT r.id FROM app.order_commercial_revisions r
      JOIN app.order_commercial_revision_components c ON c.revision_id=r.id
      WHERE r.id=$1 AND r.merchant_id=$2 AND r.store_id=$3 AND r.order_id=$4
        AND r.revision=0 AND r.source_type='original_order' AND r.source_id=$4
        AND r.commercial_state='active' AND r.currency_code='VND'
        AND r.minor_unit_exponent=0 AND c.total_minor=0
    `, [originalRevisionResult.revisionId, orderMerchantId, orderStoreId, orderId]);
    if (zeroRevision.rowCount !== 1) {
      throw new PlatformError("internal_error", "Zero-value commercial revision is missing", 500);
    }
  }
  const initialChargeDependencies: OrderCreatedPaymentChargeCallerDependenciesV1 = {
    client,
    config: ORDER_CREATED_PAYMENT_CHARGE_CALLER_DEFAULT_CONFIG_V1,
    transactionContext: {
      ownership: "caller",
      orderCreatedInCurrentTransaction: true,
    },
    repositoryOptions: {
      statementTimeoutMs: isPartnerBusinessActor(actor) ? 3_000 : 5_000,
      lockTimeoutMs: 1_000,
    },
  };
  const initialChargeInput: OrderCreatedPaymentChargeCallerInputV1 = {
    merchantId: orderMerchantId,
    storeId: orderStoreId,
    orderId,
    orderCreatedAt,
    commercialRevisionId: originalRevisionResult.enabled
      ? originalRevisionResult.revisionId
      : "",
    commercialRevision: 0,
    currencyCode: "VND",
    minorUnitExponent: 0,
    paymentMethod: input.paymentMethod,
    amountReceivedMinor: input.paymentMethod === "cash" ? input.amountReceived : 0,
    changeMinor: change,
    ...(options.manualBankConfirmation
      ? { manualBankConfirmation: options.manualBankConfirmation }
      : {}),
    components: {
      taxMode: commercialContext.taxMode,
      merchandiseGrossMinor: totals.subtotal,
      discountMinor: totals.discount,
      merchandiseNetMinor: totals.merchandisePayable,
      shippingMinor: totals.shippingFee,
      merchandiseVatMinor: totals.merchandiseTax,
      shippingVatMinor: totals.shippingTax,
      vatMinor: totals.tax,
      unclassifiedMinor: 0,
      totalMinor: totals.total,
    },
    ...(localMockProviderSettlement || paymentProvider === "mock"
      ? {
          localMockProviderSettlement: {
            paymentIntentId,
            providerEventId,
          },
        }
      : {}),
  };
  const orderCreatedChargeResult = noChargeRequired ? null : providerChargeInput
    ? await recordProviderInitialPostedChargeFromLockedStateV1({
        client,
        config: PROVIDER_INITIAL_POSTED_CHARGE_CALLER_DEFAULT_CONFIG_V1,
        transactionContext: {
          ownership: "caller",
          orderCreatedInCurrentTransaction: true,
        },
        repositoryOptions: {
          statementTimeoutMs: isPartnerBusinessActor(actor) ? 3_000 : 5_000,
          lockTimeoutMs: 1_000,
        },
      }, {
        paymentIntentId: providerChargeInput.paymentIntentId,
        orderId,
        provider: providerChargeInput.provider,
        providerEventId: providerChargeInput.providerEventId,
      })
    : totals.commercialAdjustmentVersion === 2
      ? await recordOrderCreatedPaymentChargeV2(initialChargeDependencies, { ...initialChargeInput,
        components: OrderCommercialComponentsV2Schema.parse({ ...initialChargeInput.components,
          paymentFeeMinor: totals.paymentFeeMinor, paymentFeeVatMinor: totals.paymentFeeVatMinor }) })
      : await recordOrderCreatedPaymentChargeV1(initialChargeDependencies, initialChargeInput);

  await client.query(`
    INSERT INTO public.order_summary (id, order_id, version, totals)
    VALUES ($1, $2, 1, $3::jsonb)
  `, [id("ordsum"), orderId, JSON.stringify(totals)]);

  const paymentEntry = orderCreatedChargeResult === null ? null : await recordSaleCharge(client, {
    organizationId: actor.organizationId,
    orderId,
    orderNumber,
    merchantId: orderMerchantId,
    storeId: orderStoreId,
    method: input.paymentMethod,
    amount: totals.total,
    amountReceived: input.amountReceived,
    change,
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    source: options.source,
    createdBy: businessActorId(actor),
    metadata: {
      remoteStatus: options.remoteStatus || null,
      merchandisePayable: totals.merchandisePayable,
      shippingFee: totals.shippingFee,
      merchandiseTax: totals.merchandiseTax,
      shippingTax: totals.shippingTax,
      merchandiseRevenue: totals.merchandiseRevenue,
      shippingRevenue: totals.shippingRevenue,
      loyaltyBase: totals.loyaltyBase,
      ...paymentFeeSnapshot,
      sourceFlow: input.sourceFlow || null,
      scanGoCartId: input.scanGoCartId || null,
      scanGoRedeemedAt: input.scanGoRedeemedAt || null,
      shiftId: input.shiftId || null,
      shiftOpenedAt: input.shiftOpenedAt || null,
      shiftAttribution: input.shiftAttribution || null,
      shiftQueuedAt: input.queuedAt || null,
      ...(options.paymentMetadata || {}),
      ...channelMetadata(actor),
    },
  }, {
    config: PAYMENT_ENTRY_COMPATIBILITY_DEFAULT_CONFIG_V1,
    boundary: "order_created",
    canonicalCharge: orderCreatedChargeResult,
  });

  const cogs = lines.reduce((sum, line) => sum + line.lineCogs, 0);
  const saleEventId = await emitExactOutbox(client, buildExactSaleCreatedEvent({
    merchantId: orderMerchantId,
    storeId: orderStoreId,
    orderId,
    sourceOccurredAt: orderCreatedAt,
    payload: {
      orderNumber,
      source: options.source,
      remoteStatus: options.remoteStatus || null,
      customerId: input.customerId || null,
      customerMode: customerAttributionMode,
      total: totals.total,
      subtotal: totals.subtotal,
      tax: totals.tax,
      discount: totals.discount,
      merchandisePayable: totals.merchandisePayable,
      shippingFee: totals.shippingFee,
      merchandiseTax: totals.merchandiseTax,
      shippingTax: totals.shippingTax,
      merchandiseRevenue: totals.merchandiseRevenue,
      shippingRevenue: totals.shippingRevenue,
      loyaltyBase: totals.loyaltyBase,
      ...paymentFeeSnapshot,
      cogs,
      paymentMethod: input.paymentMethod,
      paymentEntryId: paymentEntry?.id ?? null,
      paymentStatus: paymentEntry?.status ?? null,
      foundStockEventId,
      stockLocationId: stockLocationId,
      recreatedFromOrderId: recreateSource?.id || null,
      recreatedFromOrderNumber: recreateSource?.orderNumber || null,
      shiftId: input.shiftId || null,
      shiftOpenedAt: input.shiftOpenedAt || null,
      shiftAttribution: input.shiftAttribution || null,
      shiftQueuedAt: input.queuedAt || null,
      ...(options.paymentMetadata || {}),
      ...channelMetadata(actor),
      items: lines.map((line) => ({
        orderLineItemId: line.orderLineItemId,
        productId: line.product_id,
        variantId: line.variant_id,
        inventoryItemId: line.inventory_item_id,
        name: line.product_title,
        quantity: line.quantity,
        unitPrice: line.price,
        costPrice: line.costPrice,
        vision: line.visionContexts[0],
        visionContexts: line.visionContexts,
      })),
    },
  }));
  await recordAuditEntry(client, actor, isPartnerBusinessActor(actor) ? "order.partner_created" : options.source === "remote" ? "order.remote_created" : "order.created", "order", orderId, {
    after: {
      orderNumber,
      source: options.source,
      remoteStatus: options.remoteStatus || null,
      customerId: input.customerId || null,
      customerMode: customerAttributionMode,
      total: totals.total,
      ...paymentFeeSnapshot,
      shippingFee: totals.shippingFee,
      items: lines.length,
      paymentEntryId: paymentEntry?.id ?? null,
      paymentStatus: paymentEntry?.status ?? null,
      recreatedFromOrderId: recreateSource?.id || null,
      recreatedFromOrderNumber: recreateSource?.orderNumber || null,
    },
    correlationId: saleEventId,
    merchantId: orderMerchantId,
    storeId: orderStoreId,
  });

  // Partner facade maps its own safe receipt. It must not need the broad staff
  // formatter's customer/staff/payment evidence SELECT access to book an order.
  if (isPartnerBusinessActor(actor)) return { data: { orderId, orderNumber, total: totals.total,
    createdAt: new Date(orderInsert.rows[0]!.created_at).toISOString(), paymentEntryId: paymentEntry ? String(paymentEntry.id) : null, paymentStatus: paymentEntry ? String(paymentEntry.status) : null } };
  if (!paymentEntry) throw new PlatformError("internal_error", "Staff order payment charge is missing", 500);
  const formatted = await formatOrder(client, orderId);
  if (!formatted) throw new PlatformError("internal_error", "Order was created but could not be loaded", 500);
  if (options.source === "remote") {
    return {
      data: {
        ...formatted,
        status: options.remoteStatus || formatted.status,
        medusaStatus: String(formatted.status),
        remoteStatus: options.remoteStatus,
        paymentEntryId: paymentEntry.id,
        paymentStatus: paymentEntry.status,
      },
    };
  }
  const response = { data: { ...formatted, ...(financial ? { financial } : {}) } };
  if (financial) checkoutPaymentFeeResponseV1(response);
  return response;
}

export async function completeSale(headers: HeadersLike, body: SaleInput, actor: OperatorContext, scope: OperatingScope) {
  assertCustomerAttributionMode(body);
  const fee = readPaymentFeeInput(body);
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
    const input: NormalizedOrderInput = {
      ...(body.cartConfirmationToken !== undefined ? { cartConfirmationToken: body.cartConfirmationToken } : {}),
      items: body.items || [],
      customerId: body.customerId,
      customerMode: body.customerMode,
      paymentMethod: body.paymentMethod || "cash",
      amountReceived: Number(body.amountReceived || 0),
      discountPercent: body.discountPercent,
      discountType: body.discountType,
      discountValue: body.discountValue,
      ...fee,
      shippingFee: body.shippingFee,
      notes: normalizeNotes(body.notes) || undefined,
      salesChannel: normalizeSalesChannel(body.salesChannel, "pos_counter"),
      sourceFlow: body.sourceFlow,
      scanGoCartId: body.scanGoCartId,
      scanGoRedeemedAt: body.scanGoRedeemedAt,
      salesChannelLocked: body.salesChannelLocked,
      customerNickname: body.customerNickname,
      customerContactType: body.customerContactType,
      redeemedByOperatorId: body.redeemedByOperatorId,
      sourceOrderId: body.sourceOrderId,
      shiftId: body.shiftId,
      shiftOpenedAt: body.shiftOpenedAt,
      shiftAttribution: body.shiftAttribution,
      queuedAt: body.queuedAt,
      foundStockConfirmation: body.foundStockConfirmation,
    };
    assertScanGoSalesChannel(input);
    if (isExternalProviderPaymentMethod(input.paymentMethod)) {
      throw new PlatformError(
        "payment_intent_required",
        "External provider payment methods must be completed through a payment intent",
        409,
        { paymentMethod: input.paymentMethod },
      );
    }
    return withScopedIdempotency(client, headers, body, scope.merchantId, ORDER_OPS.completeSale, async () => {
      // Merchant before store/commerce locks matches settings updates.
      await readFoundStockPolicyForClient(client, scope.merchantId, true);
      const shiftMetadata = await resolveShiftAttributionForSale(client, body, scope);
      const manualBankConfirmation = input.paymentMethod === "bank_transfer"
        ? bankBookingConfirmationForPolicy(
            body.bankTransferSettlementAcknowledgment,
            await resolveStoreSettlementPolicyForCheckoutV1(client, scope.merchantId, scope.storeId),
            actor.operatorId,
          )
        : undefined;
      const attributedInput = { ...input, ...shiftMetadata };
      return createOrderForClient(client, attributedInput, actor, {
        source: "pos",
        salesChannelId: salesChannelIdForChannel(input.salesChannel),
        orderStatus: "completed",
        stockLocationId: scope.stockLocationId,
        merchantId: scope.merchantId,
        storeId: scope.storeId,
        paymentMetadata: {
          merchantId: scope.merchantId,
          storeId: scope.storeId,
          ...shiftMetadata,
          ...(manualBankConfirmation
            ? {
                bankTransferSettlement: {
                  mode: "confirm_on_booking",
                  policyVersion: manualBankConfirmation.policyVersion,
                  acknowledgmentVersion: manualBankConfirmation.acknowledgmentVersion,
                  operatorId: manualBankConfirmation.operatorId,
                },
              }
            : {}),
        },
        ...(manualBankConfirmation ? { manualBankConfirmation } : {}),
      });
    });
  });
}

export async function previewSalePaymentFee(body: unknown, scope: OperatingScope) {
  const parsed = CartPaymentFeePreviewInputV1Schema.safeParse(body);
  if (!parsed.success) throw new PlatformError("validation_error", "Invalid cart preview input", 400);
  return withClient(async client => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL lock_timeout='1000ms'");
      await client.query("SET LOCAL statement_timeout='5000ms'");
      await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
      await assertOrderStockLocationForClient(client, scope);
      const quote = await quoteSaleForClient(client, { ...parsed.data, paymentMethod: "cash", amountReceived: 0, customerMode: "walk_in" },
        scope.stockLocationId, scope.merchantId, scope.storeId);
      const financial = paymentFeeFinancialSnapshotV1(quote.totals);
      if (!financial) throw new PlatformError("financial_invariant_error", "Fee-aware cart preview is missing", 409);
      return CartPaymentFeePreviewV1Schema.parse({ schemaVersion: 1, contractVersion: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
        data: { merchantId: scope.merchantId, storeId: scope.storeId, input: parsed.data, financial, items: quote.items,
          confirmationToken: cartPaymentFeeConfirmationV1(scope, financial, quote.items) } });
    } finally {
      // The shared quote reader may materialize a missing zero inventory level; preview must never commit it.
      await client.query("ROLLBACK");
    }
  });
}

export async function quoteSaleForClient(
  client: PoolClient,
  body: SaleInput,
  stockLocationId: string,
  merchantId: string,
  storeId?: string,
  commercialContext?: CommercialAdjustmentContext,
) {
  assertCustomerAttributionMode(body);
  const fee = readPaymentFeeInput(body);
  const input: NormalizedOrderInput = {
    ...(body.cartConfirmationToken !== undefined ? { cartConfirmationToken: body.cartConfirmationToken } : {}),
    items: body.items || [],
    customerId: body.customerId,
    customerMode: body.customerMode,
    paymentMethod: body.paymentMethod || "cash",
    amountReceived: Number(body.amountReceived || 0),
    discountPercent: body.discountPercent,
    discountType: body.discountType,
    discountValue: body.discountValue,
    ...fee,
    shippingFee: body.shippingFee,
    notes: normalizeNotes(body.notes) || undefined,
    salesChannel: normalizeSalesChannel(body.salesChannel, "pos_counter"),
    sourceFlow: body.sourceFlow,
    scanGoCartId: body.scanGoCartId,
    scanGoRedeemedAt: body.scanGoRedeemedAt,
    salesChannelLocked: body.salesChannelLocked,
    customerNickname: body.customerNickname,
    customerContactType: body.customerContactType,
    redeemedByOperatorId: body.redeemedByOperatorId,
    telegramSalesDraftId: body.telegramSalesDraftId,
    telegramSalesOperatorNotes: body.telegramSalesOperatorNotes,
    sourceOrderId: body.sourceOrderId,
    shiftId: body.shiftId,
    shiftOpenedAt: body.shiftOpenedAt,
    shiftAttribution: body.shiftAttribution,
    queuedAt: body.queuedAt,
    foundStockConfirmation: body.foundStockConfirmation,
  };
  assertScanGoSalesChannel(input);
  if (input.sourceOrderId && storeId) {
    await resolveRecreateSource(client, input.sourceOrderId, merchantId, storeId);
  }
  const lines = await getSaleLinesForUpdate(client, input.items || [], stockLocationId, merchantId);
  if (lines.length === 0) {
    throw new PlatformError("validation_error", "At least one order item is required", 400);
  }
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const totals = calculateTotalsFromInput(subtotal, input, commercialContext);
  assertFinancialSaleLines(input, lines, totals.commercialAdjustmentVersion);
  const financial = paymentFeeFinancialSnapshotV1(totals);
  const pricedItems = lines.map(line => ({ productId: line.product_id, variantId: line.variant_id, quantity: line.quantity, unitPrice: line.price, lineTotal: line.lineTotal }));
  if (financial && input.cartConfirmationToken && (!storeId || input.cartConfirmationToken !== cartPaymentFeeConfirmationV1(
    { merchantId, storeId, stockLocationId }, financial, pricedItems,
  ))) throw new PlatformError("cart_quote_changed", "Cart prices or charges changed; review the current preview before confirming", 409);
  return {
    input,
    totals,
    items: lines.map((line) => ({
      productId: line.product_id,
      variantId: line.variant_id,
      sku: line.sku,
      name: line.product_title,
      quantity: line.quantity,
      unitPrice: line.price,
      lineTotal: line.lineTotal,
      stock: line.stock,
    })),
  };
}

export async function createProviderPaidOrderForClient(
  client: PoolClient,
  body: SaleInput,
  actor: OperatorContext,
  providerMetadata: Record<string, unknown> = {},
  options: { stockLocationId?: string; commercialContext?: CommercialAdjustmentContext } = {},
) {
  if (!options.stockLocationId) {
    throw new PlatformError("scope_required", "createProviderPaidOrderForClient requires stockLocationId", 409);
  }
  const merchantId = typeof providerMetadata.merchantId === "string" ? providerMetadata.merchantId : "";
  if (!merchantId) throw new PlatformError("scope_required", "Provider order requires merchantId", 409);
  const storeId = typeof providerMetadata.storeId === "string" ? providerMetadata.storeId : "";
  const settlement = await verifyProviderOrderLifecycleForClient(client,
    { body, metadata: providerMetadata, merchantId, storeId, stockLocationId: options.stockLocationId });
  const paymentIntentId = typeof providerMetadata.paymentIntentId === "string" ? providerMetadata.paymentIntentId : "";
  if (body.sourceFlow === "customer_scan_go" && !paymentIntentId) {
    throw new PlatformError("scan_go_cart_unavailable", "Provider cart requires its persisted intent claim", 409);
  }
  await lockScanGoCartForOrder(client, body, { merchantId, storeId }, paymentIntentId);
  if (!settlement.suspended) await readFoundStockPolicyForClient(client, merchantId, true);
  const quoted = await quoteSaleForClient(
    client,
    body,
    options.stockLocationId,
    merchantId,
    typeof providerMetadata.storeId === "string" ? providerMetadata.storeId : undefined,
    options.commercialContext,
  );
  const frozenItems = settlement.quote.items;
  const financialLines = (items: unknown) => Array.isArray(items) ? items.map(item => {
    const line = item as Record<string, unknown>;
    return { variantId: line.variantId, quantity: line.quantity, unitPrice: line.unitPrice, lineTotal: line.lineTotal };
  }) : null;
  if (quoted.totals.total !== settlement.amount || !isDeepStrictEqual(quoted.totals, settlement.quote.totals)
    || !isDeepStrictEqual(financialLines(quoted.items), financialLines(frozenItems))) {
    throw new PlatformError("payment_intent_quote_invalid", "Current settlement differs from the persisted quote", 409);
  }
  const providerInput = await redeemScanGoCartForProviderOrder(client, quoted.input, actor, providerMetadata, {
    merchantId,
    storeId,
  });
  return createOrderForClientInternal(client, {
    ...providerInput,
    amountReceived: Number(providerMetadata.amountReceived || quoted.totals.total),
  }, actor, {
    source: "pos",
    salesChannelId: salesChannelIdForChannel(providerInput.salesChannel),
    orderStatus: "completed",
    paymentMetadata: { ...providerMetadata, localMockSettlement: settlement.localMockSettlement },
    commercialContext: options.commercialContext,
    stockLocationId: options.stockLocationId,
    merchantId: typeof providerMetadata.merchantId === "string" ? providerMetadata.merchantId : undefined,
    storeId: storeId || undefined,
  }, settlement);
}

export async function createRemoteOrder(headers: HeadersLike, body: RemoteOrderInput, actor: ChannelActor, scope?: OperatingScope) {
  if (!scope) {
    throw new PlatformError("scope_required", "createRemoteOrder requires OperatingScope", 409);
  }
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
    const input = normalizeRemoteOrderInput(body || { items: [] });
    return withScopedIdempotency(client, headers, body, scope.merchantId, ORDER_OPS.createRemoteOrder, () => createOrderForClient(client, input, actor, {
      source: "remote",
      salesChannelId: "sc_remote",
      orderStatus: "completed",
      remoteStatus: "confirmed",
      stockLocationId: scope.stockLocationId,
      merchantId: scope.merchantId,
      storeId: scope.storeId,
      paymentMetadata: { merchantId: scope.merchantId, storeId: scope.storeId, stockLocationId: scope.stockLocationId },
    }));
  });
}

export async function listOrders(query?: { limit?: number; customer_id?: string; merchantId?: string; storeIds?: string[]; dateFrom?: string; dateTo?: string }) {
  return withClient(async (client) => {
    const limit = Math.min(Number(query?.limit || 50), 200);
    const conditions = ["o.deleted_at IS NULL", "($1::text IS NULL OR o.customer_id = $1)"];
    const params: unknown[] = [query?.customer_id || null];
    if (query?.merchantId) {
      params.push(String(query.merchantId));
      conditions.push(`o.merchant_id = $${params.length}`);
    }
    if (query?.storeIds && query.storeIds.length > 0) {
      params.push(query.storeIds);
      conditions.push(`o.store_id = ANY($${params.length}::text[])`);
    }
    // Date filtering is resolved in the store's local timezone (ORDER_LIST_TZ)
    // and is inclusive on both ends: a "đến ngày" of D includes the whole of D.
    if (query?.dateFrom) {
      params.push(query.dateFrom);
      conditions.push(`(o.created_at AT TIME ZONE '${ORDER_LIST_TZ}')::date >= ($${params.length}::date)`);
    }
    if (query?.dateTo) {
      params.push(query.dateTo);
      conditions.push(`(o.created_at AT TIME ZONE '${ORDER_LIST_TZ}')::date <= ($${params.length}::date)`);
    }
    // Aggregate over the FULL filtered set (ignores LIMIT) so headline metrics
    // stay accurate even when the page is capped at `limit` orders. Revenue
    // uses the same metadata.total that formatOrder reports as `total`.
    const aggregate = await client.query<{ total_count: string; completed_count: string; total_revenue: string; incompatible_fee_count: string }>(`
      SELECT
        COUNT(*)::text AS total_count,
        COUNT(*) FILTER (WHERE ${LEGACY_ORDER_HAS_FEE_SQL})::text AS incompatible_fee_count,
        COUNT(*) FILTER (WHERE o.status = 'completed')::text AS completed_count,
        COALESCE(SUM(
          CASE WHEN (o.metadata->>'total') ~ '^[0-9]+$'
            THEN (o.metadata->>'total')::numeric
            ELSE 0
          END
        ), 0)::text AS total_revenue
      FROM public."order" o
      WHERE ${conditions.join(" AND ")}
    `, params);
    assertLegacyOrderRead(Number(aggregate.rows[0]?.incompatible_fee_count || 0) > 0);
    params.push(limit);
    const result = await client.query(`
      SELECT o.id
      FROM public."order" o
      WHERE ${conditions.join(" AND ")}
      ORDER BY o.created_at DESC
      LIMIT $${params.length}
    `, params);
    const orders = [];
    for (const row of result.rows) {
      const order = await formatOrder(client, row.id);
      if (order) orders.push({
        ...order,
        total: order.total,
        payment_method: order.paymentMethod,
      });
    }
    return {
      orders,
      count: orders.length,
      totalCount: Number(aggregate.rows[0]?.total_count || 0),
      completedCount: Number(aggregate.rows[0]?.completed_count || 0),
      totalRevenue: Number(aggregate.rows[0]?.total_revenue || 0),
      limit,
      offset: 0,
    };
  });
}

interface OrderExportRow {
  incompatible_fee: boolean;
  order_id: string;
  display_id: string;
  order_status: string;
  customer_id: string | null;
  order_email: string | null;
  currency_code: string;
  order_metadata: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
  canceled_at: Date | string | null;
  merchant_id: string | null;
  store_id: string | null;
  store_name: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_phone: string | null;
  creator_actor_id: string | null;
  creator_display_name: string | null;
  creator_role: string | null;
  payment_method: string | null;
  payment_amount: string | number | null;
  payment_status: string | null;
  payment_reference: string | null;
  payment_metadata: Record<string, unknown> | null;
  paid_at: Date | string | null;
  line_id: string | null;
  product_id: string | null;
  variant_id: string | null;
  sku: string | null;
  barcode: string | null;
  product_title: string | null;
  variant_title: string | null;
  quantity: string | number | null;
  unit_price: string | number | null;
  line_total: string | number | null;
  basket_size: string | number | null;
  order_hour: string | number | null;
  order_weekday: string | null;
  is_first_customer_order: boolean | null;
}

export async function createOrderExportCsv(query: OrderExportQuery, scope: ReportScope): Promise<string> {
  assertOrderExportDateWindow(query);
  return withClient(async (client) => {
    const conditions = ["o.deleted_at IS NULL", "o.merchant_id = $1", "o.store_id = ANY($2::text[])"];
    const params: unknown[] = [scope.merchantId, scope.storeIds];

    if (query?.dateFrom) {
      params.push(query.dateFrom);
      conditions.push(`(o.created_at AT TIME ZONE '${ORDER_LIST_TZ}')::date >= ($${params.length}::date)`);
    }
    if (query?.dateTo) {
      params.push(query.dateTo);
      conditions.push(`(o.created_at AT TIME ZONE '${ORDER_LIST_TZ}')::date <= ($${params.length}::date)`);
    }

    const status = String(query?.status || "all").trim().toLowerCase();
    if (status && status !== "all") {
      if (status === "completed") {
        conditions.push("o.status = 'completed'");
      } else if (status === "other") {
        conditions.push("o.status <> 'completed'");
      } else {
        params.push(status);
        conditions.push(`LOWER(o.status) = $${params.length}`);
      }
    }

    const search = String(query?.search || "").trim().toLowerCase();
    if (search) {
      params.push(`%${search}%`);
      const termIndex = params.length;
      conditions.push(`(
        LOWER(COALESCE(o.custom_display_id, 'ORD-' || o.display_id::text)) LIKE $${termIndex}
        OR LOWER(o.id) LIKE $${termIndex}
        OR LOWER(COALESCE(c.last_name, '') || ' ' || COALESCE(c.first_name, '')) LIKE $${termIndex}
        OR LOWER(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) LIKE $${termIndex}
        OR LOWER(COALESCE(c.phone, '')) LIKE $${termIndex}
        OR LOWER(COALESCE(c.email, o.email, '')) LIKE $${termIndex}
        OR EXISTS (
          SELECT 1
          FROM public.order_item search_oi
          JOIN public.order_line_item search_li ON search_li.id = search_oi.item_id AND search_li.deleted_at IS NULL
          WHERE search_oi.order_id = o.id
            AND search_oi.deleted_at IS NULL
            AND (
              LOWER(COALESCE(search_li.title, '')) LIKE $${termIndex}
              OR LOWER(COALESCE(search_li.variant_sku, '')) LIKE $${termIndex}
              OR LOWER(COALESCE(search_li.variant_barcode, '')) LIKE $${termIndex}
            )
        )
      )`);
    }

    const result = await client.query<OrderExportRow>(`
      SELECT
        ${LEGACY_ORDER_HAS_FEE_SQL} AS incompatible_fee,
        o.id AS order_id,
        COALESCE(o.custom_display_id, 'ORD-' || o.display_id::text) AS display_id,
        o.status::text AS order_status,
        o.customer_id,
        o.email AS order_email,
        o.currency_code,
        o.metadata AS order_metadata,
        o.created_at,
        o.updated_at,
        o.canceled_at,
        o.merchant_id,
        o.store_id,
        s.display_name AS store_name,
        c.first_name AS customer_first_name,
        c.last_name AS customer_last_name,
        c.phone AS customer_phone,
        creator.actor_id AS creator_actor_id,
        creator.display_name AS creator_display_name,
        creator.staff_role AS creator_role,
        payment.method AS payment_method,
        payment.amount AS payment_amount,
        payment.status AS payment_status,
        payment.reference AS payment_reference,
        payment.metadata AS payment_metadata,
        payment.created_at AS paid_at,
        oi.id AS line_id,
        li.product_id,
        li.variant_id,
        COALESCE(li.variant_sku, '') AS sku,
        COALESCE(li.variant_barcode, '') AS barcode,
        COALESCE(li.product_title, li.title, '') AS product_title,
        COALESCE(li.variant_title, '') AS variant_title,
        oi.quantity,
        COALESCE(oi.unit_price, li.unit_price, 0) AS unit_price,
        (COALESCE(oi.quantity, 0)::numeric * COALESCE(oi.unit_price, li.unit_price, 0)::numeric) AS line_total,
        COALESCE(SUM(oi.quantity::numeric) OVER (PARTITION BY o.id), 0) AS basket_size,
        EXTRACT(HOUR FROM o.created_at AT TIME ZONE '${ORDER_LIST_TZ}')::int AS order_hour,
        TRIM(TO_CHAR(o.created_at AT TIME ZONE '${ORDER_LIST_TZ}', 'Day')) AS order_weekday,
        CASE
          WHEN o.customer_id IS NULL THEN false
          ELSE NOT EXISTS (
            SELECT 1 FROM public."order" earlier
            WHERE earlier.customer_id = o.customer_id
              AND earlier.deleted_at IS NULL
              AND earlier.created_at < o.created_at
          )
        END AS is_first_customer_order
      FROM public."order" o
      LEFT JOIN public.customer c ON c.id = o.customer_id
      LEFT JOIN app.stores s ON s.id = o.store_id
      LEFT JOIN LATERAL (
        SELECT
          ae.actor_id,
          su.display_name,
          su.role AS staff_role
        FROM audit.events ae
        LEFT JOIN medusa.staff_users su ON su.operator_id = ae.actor_id AND ae.actor_type <> 'partner'
        WHERE ae.subject_type = 'order'
          AND ae.subject_id = o.id
          AND ae.action IN ('order.created', 'order.remote_created', 'order.partner_created')
        ORDER BY ae.created_at ASC
        LIMIT 1
      ) creator ON true
      LEFT JOIN LATERAL (
        SELECT
          pe.method,
          pe.amount,
          pe.status,
          pe.reference,
          pe.metadata,
          pe.created_at
        FROM app.payment_entries pe
        WHERE pe.order_id = o.id
          AND pe.direction = 'charge'
        ORDER BY pe.created_at ASC
        LIMIT 1
      ) payment ON true
      LEFT JOIN public.order_item oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
      LEFT JOIN public.order_line_item li ON li.id = oi.item_id AND li.deleted_at IS NULL
      WHERE ${conditions.join(" AND ")}
      ORDER BY o.created_at DESC, oi.created_at ASC NULLS LAST
    `, params);
    assertLegacyOrderRead(result.rows.some(row => row.incompatible_fee));

    const exportedAt = new Date().toISOString();
    const rows = result.rows.map((row): CsvCell[] => {
      const metadata = recordValue(row.order_metadata);
      const paymentMetadata = recordValue(row.payment_metadata);
      const customerName = `${stringValue(row.customer_last_name)} ${stringValue(row.customer_first_name)}`.trim();
      const grandTotal = numberValue(metadata.total);
      const lineTotal = numberValue(row.line_total);
      const salesChannel = normalizeSalesChannel(metadata.salesChannel, "pos_counter");
      const paymentReference = stringValue(row.payment_reference)
        || stringValue(paymentMetadata.providerReference)
        || stringValue(paymentMetadata.referenceCode)
        || stringValue(paymentMetadata.providerTransactionId)
        || stringValue(paymentMetadata.paymentIntentId);
      const lineShare = grandTotal > 0 && lineTotal > 0 ? Number((lineTotal / grandTotal).toFixed(6)) : "";

      return [
        exportedAt,
        stringValue(row.merchant_id),
        stringValue(row.store_id),
        stringValue(row.store_name),
        ORDER_LIST_TZ,
        stringValue(query?.dateFrom),
        stringValue(query?.dateTo),
        stringValue(row.order_id),
        stringValue(row.display_id),
        isoTimestamp(row.created_at) || "",
        stringValue(row.order_status),
        stringValue(row.payment_status),
        stringValue(metadata.fulfillmentStatus),
        salesChannel,
        salesChannelLabel(salesChannel),
        Boolean(metadata.salesChannelLocked),
        stringValue(metadata.sourceFlow),
        stringValue(metadata.scanGoCartId),
        stringValue(metadata.scanGoRedeemedAt),
        stringValue(row.customer_id),
        customerName,
        stringValue(row.customer_phone),
        stringValue(row.order_email),
        stringValue(metadata.customerNickname),
        stringValue(metadata.customerContactType),
        stringValue(row.creator_actor_id),
        stringValue(row.creator_display_name),
        stringValue(row.creator_role),
        stringValue(metadata.redeemedByOperatorId),
        stringValue(row.payment_method || metadata.paymentMethod),
        paymentReference,
        isoTimestamp(row.paid_at) || "",
        stringValue(row.currency_code || "vnd"),
        numberValue(metadata.subtotal),
        numberValue(metadata.discount),
        numberValue(metadata.shippingFee),
        numberValue(metadata.tax),
        grandTotal,
        numberValue(row.payment_amount || metadata.amountReceived),
        numberValue(metadata.change),
        stringValue(row.line_id),
        stringValue(row.product_id),
        stringValue(row.variant_id),
        stringValue(row.sku),
        stringValue(row.barcode),
        stringValue(metadata.brand),
        stringValue(row.product_title),
        stringValue(row.variant_title),
        stringValue(metadata.category),
        numberValue(row.quantity),
        numberValue(row.unit_price),
        lineTotal,
        "",
        lineTotal,
        stringValue(metadata.stockLocationId),
        stringValue(metadata.fulfillmentType),
        stringValue(metadata.deliveryAddressShort),
        Boolean(row.is_first_customer_order),
        lineShare,
        numberValue(row.basket_size),
        numberValue(row.order_hour),
        stringValue(row.order_weekday),
        isoTimestamp(row.created_at) || "",
        isoTimestamp(row.updated_at) || "",
        isoTimestamp(row.canceled_at) || "",
        stringValue(metadata.cancelReason),
        stringValue(metadata.notes),
      ];
    });

    return serializeCsv(ORDER_EXPORT_COLUMNS, rows);
  });
}

// Raw detail includes correction/payment history, so an earlier fee must also be representable.
const LEGACY_ORDER_HAS_FEE_SQL = `EXISTS (
    SELECT 1
    FROM app.order_commercial_revisions revision
    JOIN app.order_commercial_revision_components components ON components.revision_id = revision.id
    WHERE revision.order_id = o.id AND revision.merchant_id = o.merchant_id AND revision.store_id = o.store_id
      AND (COALESCE((to_jsonb(components)->>'payment_fee_minor')::bigint, 0) <> 0
        OR COALESCE((to_jsonb(components)->>'payment_fee_vat_minor')::bigint, 0) <> 0)
  )`;

function assertLegacyOrderRead(hasFee: boolean) {
  if (hasFee) throw new PlatformError("unsupported_contract", "Update the client to read orders with payment surcharges", 409);
}

async function assertLegacyOrderReadForClient(
  client: PoolClient, orderId: string, order: { merchantId: string | null; storeId: string | null },
) {
  const fee = await queryOne<{ has_fee: boolean }>(client, `
    SELECT ${LEGACY_ORDER_HAS_FEE_SQL} AS has_fee FROM public."order" o
    WHERE o.id = $1 AND o.merchant_id = $2 AND o.store_id = $3
  `, [orderId, order.merchantId, order.storeId]);
  assertLegacyOrderRead(fee?.has_fee === true);
}

export async function getOrder(orderId: string, scope?: { merchantId?: string; storeIds?: string[] },
  cancellationContext?: { actor: OperatorContext | ChannelActor; scope: OperatingScope },
  financialContract: PaymentFeeHttpContractV1 = "legacy") {
  return withClient(async (client) => {
    const order = await formatOrder(client, orderId);
    if (!order) throw new PlatformError("resource_not_found", "Order not found", 404);
    if (scope?.merchantId && (!order.merchantId || order.merchantId !== scope.merchantId)) {
      throw new PlatformError("resource_not_found", "Order not found", 404);
    }
    if (scope?.storeIds && scope.storeIds.length > 0 && (!order.storeId || !scope.storeIds.includes(order.storeId))) {
      throw new PlatformError("resource_not_found", "Order not found", 404);
    }
    if (financialContract === "legacy") await assertLegacyOrderReadForClient(client, orderId, order);
    const cancellationAccess = cancellationContext && order.merchantId === cancellationContext.scope.merchantId
      && order.storeId === cancellationContext.scope.storeId
      ? await orderCancellationAccessForClient(client, orderId, cancellationContext.actor, cancellationContext.scope)
      : { allowed: false, mode: null, reasonCode: "scope_required" };
    return { order: { ...order, cancellationAccess: order.status === "canceled"
      ? { allowed: false, mode: null, reasonCode: "order_canceled" } : cancellationAccess } };
  });
}

async function getOrderMutationTargetForClient(client: PoolClient, orderId: string, lock = false): Promise<{ merchantId: string; storeId: string | null }> {
  const order = await queryOne<{ merchant_id: string | null; store_id: string | null }>(client, `
    SELECT merchant_id, store_id
    FROM public."order"
    WHERE id = $1 AND deleted_at IS NULL
    ${lock ? "FOR UPDATE" : ""}
  `, [orderId]);
  if (!order) throw new PlatformError("resource_not_found", "Order not found", 404);
  if (!order.merchant_id) throw new PlatformError("forbidden", "Order has no merchant scope", 403);
  return { merchantId: order.merchant_id, storeId: order.store_id };
}

export async function getOrderMutationTarget(orderId: string): Promise<{ merchantId: string; storeId: string | null }> {
  return withClient((client) => getOrderMutationTargetForClient(client, orderId));
}

export async function updateOrder(
  headers: HeadersLike,
  orderId: string,
  body: UpdateOrderInput,
  actor: OperatorContext,
  scope: OperatingScope,
) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
    const hasCustomer = Object.prototype.hasOwnProperty.call(body, "customerId");
    const hasNotes = Object.prototype.hasOwnProperty.call(body, "notes");
    const hasSalesChannel = Object.prototype.hasOwnProperty.call(body, "salesChannel");
    if (!hasCustomer && !hasNotes && !hasSalesChannel) {
      throw new PlatformError("validation_error", "No order fields to update", 400);
    }

    return withScopedIdempotency(client, headers, { orderId, ...body }, scope.merchantId, ORDER_OPS.updateOrder, async () => {
      const before = await formatOrder(client, orderId);
      if (!before) throw new PlatformError("resource_not_found", "Order not found", 404);
      assertOperatingMutationTarget(scope, await getOrderMutationTargetForClient(client, orderId), "Order");

      const customerId = hasCustomer ? body.customerId || null : before.customerId ? String(before.customerId) : null;
      const customer = customerId ? await findCustomer(client, customerId, scope.merchantId) : null;
      if (customerId && !customer) throw new PlatformError("resource_not_found", "Customer not found", 404);
      if (customerId) {
        const customerTarget = await queryOne<{ merchant_id: string | null }>(client, "SELECT merchant_id FROM public.customer WHERE id = $1 AND deleted_at IS NULL", [customerId]);
        if (!customerTarget?.merchant_id || customerTarget.merchant_id !== scope.merchantId) {
          throw new PlatformError("forbidden", "Customer is outside the authorized order scope", 403);
        }
      }
      const notes = hasNotes ? normalizeNotes(body.notes) : before.notes ? String(before.notes) : null;
      const salesChannel = hasSalesChannel
        ? normalizeSalesChannel(body.salesChannel, "pos_counter")
        : before.salesChannel ? String(before.salesChannel) : "pos_counter";
      const beforeSalesChannel = normalizeSalesChannel(before.salesChannel, "pos_counter");
      if (hasSalesChannel && (before as Record<string, unknown>).salesChannelLocked === true && salesChannel !== beforeSalesChannel) {
        throw new PlatformError(
          "sales_channel_locked",
          "Stash Dash orders keep their sales channel for tracking",
          409,
        );
      }
      const salesChannelId = salesChannelIdForChannel(salesChannel);

      await client.query(`
        UPDATE public."order"
        SET customer_id = $2,
            email = $3,
            sales_channel_id = $4,
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                'notes', $5::text,
                'salesChannel', $6::text,
                'salesChannelLabel', $7::text
              ),
            updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
      `, [orderId, customerId, customer?.email || null, salesChannelId, notes, salesChannel, salesChannelLabel(salesChannel)]);

      const after = await formatOrder(client, orderId);
      const auditAction = hasCustomer && !hasNotes && !hasSalesChannel ? "order.customer_updated" : "order.updated";
      await recordAuditEntry(client, actor, auditAction, "order", orderId, {
        before: {
          customerId: before.customerId || null,
          notes: before.notes || null,
          salesChannel: before.salesChannel || "pos_counter",
        },
        after: {
          customerId: after?.customerId || null,
          notes: after?.notes || null,
          salesChannel: after?.salesChannel || "pos_counter",
        },
        merchantId: scope.merchantId,
        storeId: scope.storeId,
      });
      return { order: after };
    }, 200);
  });
}

export async function updateOrderCustomer(
  headers: HeadersLike,
  orderId: string,
  body: UpdateOrderInput,
  actor: OperatorContext,
  scope: OperatingScope,
) {
  return updateOrder(headers, orderId, body, actor, scope);
}

function validShippingAdjustmentReason(value: unknown) {
  const reason = String(value || "").trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new PlatformError("validation_error", "Shipping adjustment reason must be 10 to 500 characters", 422);
  }
  return reason;
}

async function orderShippingAdjustmentPlan(
  orderId: string,
  body: UpdateOrderShippingInput,
  actor: OperatorContext,
  scope: OperatingScope,
) {
  if (readPaymentFeeInput(body)) throw new PlatformError("validation_error", "Shipping adjustments cannot change payment fees", 400);
  const reason = validShippingAdjustmentReason(body.reason);
  const newShippingFee = normalizeMoney(body.shippingFee, "shippingFee");
  const current = await getOrder(orderId, {
    merchantId: scope.merchantId,
    storeIds: [scope.storeId],
  }, undefined, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
  if (current.order.status === "canceled") {
    throw new PlatformError("invalid_state_transition", "Canceled orders cannot change shipping fee", 409);
  }

  const correctionInput: OrderCorrectionInput = {
    baseRevision: Number(current.order.correctionSummary?.latestRevision || 0),
    reason,
    shippingFee: newShippingFee,
    items: (current.order.items || []).map((item: { variantId?: string; quantity?: number }) => ({
      variantId: String(item.variantId || ""),
      quantity: Number(item.quantity || 0),
    })).filter((item: { variantId: string; quantity: number }) => item.variantId && item.quantity > 0),
    settlement: {
      method: body.paymentMethod || current.order.paymentMethod || "cash",
    },
  };
  const preview = await previewOrderCorrection(orderId, correctionInput, actor, scope, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
  correctionInput.settlement!.amountReceived = body.amountReceived === undefined
    ? Math.abs(preview.data.totalDelta)
    : normalizeMoney(body.amountReceived, "amountReceived");
  const confirmationToken = createHash("sha256").update(JSON.stringify({
    version: 1,
    orderId,
    baseRevision: correctionInput.baseRevision,
    reason,
    shippingFee: newShippingFee,
    settlement: correctionInput.settlement,
    beforeTotals: preview.data.beforeTotals,
    afterTotals: preview.data.afterTotals,
    totalDelta: preview.data.totalDelta,
  })).digest("hex");

  return { current, correctionInput, preview, confirmationToken };
}

export async function previewOrderShippingFee(
  orderId: string,
  body: UpdateOrderShippingInput,
  actor: OperatorContext,
  scope: OperatingScope,
) {
  const plan = await orderShippingAdjustmentPlan(orderId, body, actor, scope);
  const before = plan.preview.data.beforeTotals;
  const after = plan.preview.data.afterTotals;
  const totalDelta = plan.preview.data.totalDelta;
  const direction = totalDelta > 0 ? "collect" : totalDelta < 0 ? "refund" : "none";
  const method = String(plan.correctionInput.settlement?.method || "none");
  const amountReceived = Number(plan.correctionInput.settlement?.amountReceived || 0);
  return {
    data: {
      orderId,
      baseRevision: plan.correctionInput.baseRevision,
      before: {
        shippingFee: before.shippingFee,
        shippingTax: before.shippingTax,
        shippingRevenue: before.shippingRevenue,
        total: before.total,
      },
      after: {
        shippingFee: after.shippingFee,
        shippingTax: after.shippingTax,
        shippingRevenue: after.shippingRevenue,
        total: after.total,
      },
      shippingFeeDelta: after.shippingFee - before.shippingFee,
      totalDelta,
      settlement: {
        direction,
        method,
        amount: Math.abs(totalDelta),
        amountReceived,
        change: direction === "collect" && method === "cash"
          ? Math.max(0, amountReceived - totalDelta)
          : 0,
      },
      effects: {
        orderTotals: totalDelta === 0 ? "none" : "update",
        paymentEntry: direction === "collect" ? "charge" : direction === "refund" ? "refund" : "none",
        auditEvent: totalDelta === 0 ? "none" : "append",
        outboxEvent: totalDelta === 0 ? "none" : "append",
        accountingJournal: totalDelta === 0 ? "none" : "after_outbox_processing",
        inventory: "none",
      },
      confirmationToken: plan.confirmationToken,
    },
  };
}

export async function updateOrderShippingFee(
  headers: HeadersLike,
  orderId: string,
  body: UpdateOrderShippingInput,
  actor: OperatorContext,
  scope: OperatingScope,
) {
  const plan = await orderShippingAdjustmentPlan(orderId, body, actor, scope);
  if (Number(body.shippingFee || 0) === Number(plan.current.order.shippingFee || 0)) {
    return { response: plan.current, statusCode: 200 };
  }
  const suppliedConfirmationToken = String(body.confirmationToken || "").trim();
  if (!suppliedConfirmationToken) {
    throw new PlatformError(
      "shipping_preview_required",
      "Preview and confirm the shipping adjustment before applying it",
      409,
    );
  }
  if (suppliedConfirmationToken !== plan.confirmationToken) {
    throw new PlatformError(
      "shipping_preview_stale",
      "Order or shipping inputs changed after preview; preview again",
      409,
      {
        baseRevision: plan.correctionInput.baseRevision,
        currentShippingFee: Number(plan.current.order.shippingFee || 0),
        currentTotal: Number(plan.current.order.total || 0),
      },
    );
  }

  const result = await applyOrderCorrection(headers, orderId, plan.correctionInput, actor, scope, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
  const updated = await getOrder(orderId, {
    merchantId: scope.merchantId,
    storeIds: [scope.storeId],
  }, undefined, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
  return {
    // Preserve the established shipping-update HTTP contract even though the
    // financial mutation is now implemented by the canonical correction writer.
    statusCode: 200,
    response: {
      ...result.response,
      order: updated.order,
    },
  };
}

export interface OrderRecreatePrefillItem {
  variantId: string;
  productId?: string | null;
  productName: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  stockLevel: number;
  unavailable?: boolean;
  priceChanged?: boolean;
  originalPrice?: number;
  warning?: string;
}

export interface OrderRecreatePrefill {
  sourceOrderId: string;
  sourceOrderNumber: string;
  customer?: { id: string; phone?: string; name?: string } | null;
  items: OrderRecreatePrefillItem[];
  unavailableCount: number;
  warningCount: number;
}

export async function prepareOrderRecreatePrefill(
  orderId: string,
  scope: OperatingScope,
): Promise<OrderRecreatePrefill> {
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const order = await formatOrder(client, orderId);
    if (!order) throw new PlatformError("resource_not_found", "Order not found", 404);
    // Hard scope check before any read-shape work. Recreate must only ever
    // build a cart from an order that belongs to the active merchant/store.
    if (!order.merchantId || order.merchantId !== scope.merchantId) {
      throw new PlatformError("forbidden", "Order is outside the active merchant scope", 403);
    }
    if (!order.storeId || order.storeId !== scope.storeId) {
      throw new PlatformError("forbidden", "Order is outside the active store scope", 403);
    }
    await assertLegacyOrderReadForClient(client, orderId, order);
    const orderItems = (order.items || []) as Array<{
      productId?: string | null;
      variantId?: string | null;
      name?: string;
      quantity?: number | string;
      unitPrice?: number | string;
    }>;
    const variantIds = Array.from(new Set(orderItems
      .map((item) => String(item.variantId || ""))
      .filter((id) => id.length > 0)));
    const currentByVariant = new Map<string, {
      productId: string;
      productTitle: string;
      sku: string;
      unitPrice: number;
      stockLevel: number;
      published: boolean;
    }>();
    if (variantIds.length > 0) {
      const variants = await client.query(`
        SELECT
          pv.id AS variant_id,
          pv.product_id,
          p.title AS product_title,
          COALESCE(pv.sku, '') AS sku,
          COALESCE(p.status, '') AS product_status,
          COALESCE(pr.amount, 0)::numeric AS unit_price,
          COALESCE(il.stocked_quantity, 0)::numeric AS stock_level
        FROM public.product_variant pv
        JOIN public.product p ON p.id = pv.product_id AND p.deleted_at IS NULL
        LEFT JOIN public.product_variant_price_set vps
          ON vps.variant_id = pv.id AND vps.deleted_at IS NULL
        LEFT JOIN public.price pr
          ON pr.price_set_id = vps.price_set_id
         AND pr.currency_code = 'vnd'
         AND pr.deleted_at IS NULL
        LEFT JOIN public.product_variant_inventory_item pvii
          ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
        LEFT JOIN public.inventory_level il
          ON il.inventory_item_id = pvii.inventory_item_id
         AND il.location_id = $2
         AND il.deleted_at IS NULL
        WHERE pv.id = ANY($1::text[])
          AND pv.deleted_at IS NULL
          AND p.merchant_id = $3
        ORDER BY pv.id ASC, pr.created_at ASC
      `, [variantIds, scope.stockLocationId, scope.merchantId]);
      for (const row of variants.rows) {
        currentByVariant.set(String(row.variant_id), {
          productId: String(row.product_id),
          productTitle: String(row.product_title || ""),
          sku: String(row.sku || ""),
          unitPrice: Number(row.unit_price || 0),
          stockLevel: Number(row.stock_level || 0),
          published: String(row.product_status) === "published",
        });
      }
    }
    const items: OrderRecreatePrefillItem[] = [];
    let unavailableCount = 0;
    let warningCount = 0;
    for (const line of orderItems) {
      const variantId = String(line.variantId || "");
      const originalPrice = Number(line.unitPrice || 0);
      const originalName = String(line.name || "");
      const requestedQuantity = Math.max(1, Math.round(Number(line.quantity || 0)));
      const current = currentByVariant.get(variantId);
      if (!current) {
        items.push({
          variantId,
          productId: line.productId ?? null,
          productName: originalName,
          sku: "",
          quantity: requestedQuantity,
          unitPrice: originalPrice,
          stockLevel: 0,
          unavailable: true,
          priceChanged: false,
          originalPrice,
          warning: "Sản phẩm không còn tồn tại hoặc đã bị xoá khỏi cửa hàng hiện tại.",
        });
        unavailableCount += 1;
        warningCount += 1;
        continue;
      }
      const priceChanged = Number(current.unitPrice || 0) !== originalPrice;
      const insufficientStock = current.stockLevel < requestedQuantity;
      const unpublished = !current.published;
      const unavailable = unpublished || insufficientStock;
      const warningParts: string[] = [];
      if (unpublished) warningParts.push("Sản phẩm đang ngừng bán.");
      if (insufficientStock) warningParts.push(`Tồn kho hiện tại ${current.stockLevel}, đơn cũ yêu cầu ${requestedQuantity}.`);
      if (priceChanged) warningParts.push(`Giá đã đổi từ ${originalPrice.toLocaleString("vi-VN")} ₫ thành ${current.unitPrice.toLocaleString("vi-VN")} ₫.`);
      items.push({
        variantId,
        productId: current.productId,
        productName: current.productTitle || originalName,
        sku: current.sku,
        quantity: requestedQuantity,
        unitPrice: current.unitPrice,
        stockLevel: current.stockLevel,
        unavailable,
        priceChanged,
        originalPrice,
        warning: warningParts.length > 0 ? warningParts.join(" ") : undefined,
      });
      if (unavailable) unavailableCount += 1;
      if (warningParts.length > 0) warningCount += 1;
    }
    const customer = order.customer
      ? {
          id: String(order.customer.id || ""),
          phone: order.customer.phone ? String(order.customer.phone) : undefined,
          name: `${String(order.customer.last_name || "")} ${String(order.customer.first_name || "")}`.trim() || undefined,
        }
      : null;
    return {
      sourceOrderId: String(order.id || orderId),
      sourceOrderNumber: String(order.orderNumber || orderId),
      customer: customer && customer.id ? customer : null,
      items,
      unavailableCount,
      warningCount,
    };
  });
}

export async function quoteOrderCancellation(orderId: string, scope: OperatingScope, actor: OperatorContext | ChannelActor) {
  return withTransaction(async (client) => {
    const target = await getOrderMutationTargetForClient(client, orderId, true);
    assertOperatingMutationTarget(scope, target, "Order");
    await requireOrderCancellationAccessForClient(client, orderId, actor, scope);
    return { quote: await createCancellationQuoteV1(client, orderId, scope) };
  });
}

export async function cancelOrder(headers: HeadersLike, orderId: string, body: CancelOrderInput, actor: OperatorContext, scope: OperatingScope) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
    const target = await getOrderMutationTargetForClient(client, orderId, true);
    assertOperatingMutationTarget(scope, target, "Order");
    const access = await requireOrderCancellationAccessForClient(client, orderId, actor, scope);
    const requestBody = access.mode === "own" ? {
      reason: body.reason, quoteId: body.quoteId, effectiveRevision: body.effectiveRevision,
      quoteGeneratedAt: body.quoteGeneratedAt, orderId, operatorId: actor.operatorId,
    } : body;
    const result = await withScopedIdempotency(client, headers, requestBody, scope.merchantId,
      access.mode === "own" ? ORDER_OPS.cancelOwnOrder : ORDER_OPS.cancelOrder, async () => {
      const reason = String(body.reason || "").trim();
      if (reason.length < 8) {
        throw new PlatformError("validation_error", "Cancellation reason must contain at least 8 characters", 400);
      }
      if (reason.length > 500) {
        throw new PlatformError("validation_error", "Cancellation reason must not exceed 500 characters", 400);
      }
      const order = await formatOrder(client, orderId);
      if (!order) throw new PlatformError("resource_not_found", "Order not found", 404);
      // Hard scope assertion: cancel must only touch orders that belong to
      // the active merchant/store. This check runs inside the transaction
      // before any stock or order mutation so cross-store cancellation is
      // impossible regardless of which actor invokes the route.
      if (!order.merchantId || order.merchantId !== scope.merchantId) {
        throw new PlatformError("forbidden", "Order is outside the active merchant scope", 403);
      }
      if (!order.storeId || order.storeId !== scope.storeId) {
        throw new PlatformError("forbidden", "Order is outside the active store scope", 403);
      }
      if (order.status === "canceled") throw new PlatformError("invalid_state_transition", "Order already cancelled", 409);
      if (
        typeof body.quoteId !== "string"
        || !Number.isInteger(body.effectiveRevision)
        || typeof body.quoteGeneratedAt !== "string"
      ) {
        throw new PlatformError(
          "cancellation_quote_required",
          "A current server cancellation quote is required",
          409,
        );
      }
      await validateCancellationQuoteV1(client, orderId, scope, {
        quoteId: body.quoteId,
        effectiveRevision: Number(body.effectiveRevision),
        generatedAt: body.quoteGeneratedAt,
      });

      const quantitiesByVariant = new Map<string, number>();
      for (const item of (order.items || []) as Array<{ variantId?: string | null; quantity?: number | string }>) {
        const variantId = String(item.variantId || "");
        const quantity = Number(item.quantity || 0);
        if (!variantId || quantity <= 0) continue;
        quantitiesByVariant.set(variantId, (quantitiesByVariant.get(variantId) || 0) + quantity);
      }
      if (quantitiesByVariant.size === 0) {
        throw new PlatformError("invalid_state_transition", "Order has no effective items to restore", 409);
      }

      await client.query("SELECT integration.lock_commerce_inputs($1,$2::text[])",
        [scope.merchantId, Array.from(quantitiesByVariant.keys())]);
      const rows = await client.query(`
        SELECT
          vii.variant_id,
          pv.product_id,
          vii.inventory_item_id,
          il.id AS inventory_level_id,
          il.stocked_quantity::numeric AS stocked_quantity,
          COALESCE(ps.reorder_level, 5) AS reorder_level
        FROM public.product_variant_inventory_item vii
        JOIN public.product_variant pv ON pv.id = vii.variant_id
        JOIN public.inventory_level il ON il.inventory_item_id = vii.inventory_item_id AND il.deleted_at IS NULL
          AND il.location_id = $2
        LEFT JOIN inventory.product_settings ps ON ps.variant_id = vii.variant_id
        WHERE vii.variant_id = ANY($1::text[])
          AND vii.deleted_at IS NULL
        ORDER BY vii.inventory_item_id COLLATE "C", vii.variant_id COLLATE "C"
        FOR UPDATE OF il
      `, [Array.from(quantitiesByVariant.keys()), scope.stockLocationId]);
      const restorableVariants = new Set(rows.rows.map((row) => String(row.variant_id)));
      const missingVariants = Array.from(quantitiesByVariant.keys()).filter((variantId) => !restorableVariants.has(variantId));
      if (missingVariants.length > 0 || rows.rows.length !== quantitiesByVariant.size) {
        throw new PlatformError(
          "invalid_state_transition",
          "Order inventory cannot be restored unambiguously for one or more effective items",
          409,
          { variantIds: missingVariants },
        );
      }
      const restoredStock = new Map<string, number>();
      for (const row of rows.rows) {
        const restoreQuantity = Number(quantitiesByVariant.get(String(row.variant_id)) || 0);
        const previousStock = restoredStock.get(row.inventory_level_id) ?? Number(row.stocked_quantity);
        const newStock = previousStock + restoreQuantity;
        restoredStock.set(row.inventory_level_id, newStock);
        await client.query("UPDATE public.inventory_level SET stocked_quantity = $2, updated_at = now() WHERE id = $1", [row.inventory_level_id, newStock]);
        const movement = await recordStockMovement(client, {
          inventoryItemId: String(row.inventory_item_id),
          productId: String(row.product_id || ""),
          variantId: String(row.variant_id || ""),
          movementType: "return",
          sourceAction: "order_cancel",
          quantityBefore: previousStock,
          quantityChange: restoreQuantity,
          quantityAfter: newStock,
          referenceType: "order",
          referenceId: orderId,
          referenceDisplay: String(order.orderNumber || orderId),
          reason,
          reasonCode: "order_cancel",
          actor,
          scope,
          sourceChannel: "orders",
          metadata: {
            orderId,
            orderNumber: order.orderNumber || null,
            cancelReason: reason,
          },
        });
        await emitExactOutbox(client, buildExactStockChangedEvent({
          merchantId: scope.merchantId,
          storeId: scope.storeId,
          inventoryItemId: String(row.inventory_item_id),
          movementId: String(movement.id),
          sourceOccurredAt: movement.created_at,
          payload: {
            orderId,
            productId: row.product_id,
            variantId: row.variant_id,
            quantityBefore: previousStock,
            quantityChange: restoreQuantity,
            quantityAfter: newStock,
            reorderLevel: row.reorder_level,
            stockLocationId: scope.stockLocationId,
          },
        }));
      }
      const cancellation = await client.query<{ canceled_at: Date | string }>(`
        UPDATE public."order"
        SET status = 'canceled', canceled_at = now(), updated_at = now()
        WHERE id = $1
        RETURNING canceled_at
      `, [orderId]);
      const cancellationOccurredAt = new Date(cancellation.rows[0]!.canceled_at).toISOString();
      const cancellationRevision = await appendCancellationCommercialRevisionV1(client, {
        merchantId: scope.merchantId,
        storeId: scope.storeId,
        orderId,
        sourceId: `order:${orderId}:cancelled`,
        sourceOccurredAt: cancellationOccurredAt,
        reason,
      });
      const refundPosition = await readCustomerRefundPositionV1(client, {
        merchantId: scope.merchantId,
        storeId: scope.storeId,
        orderId,
      });
      const cancellationPayableAmount = Math.max(
        0,
        refundPosition.netCollectionsMinor - refundPosition.balanceMinor,
      );
      const cancellationPayable = cancellationPayableAmount > 0
        ? await openCustomerRefundPayableV1(client, {
            merchantId: scope.merchantId,
            storeId: scope.storeId,
            orderId,
            commercialRevisionId: cancellationRevision.revisionId,
            kind: "order_cancellation",
            amountMinor: cancellationPayableAmount,
            sourceType: "order_cancellation",
            sourceId: `order:${orderId}:cancelled`,
            sourceOccurredAt: cancellationOccurredAt,
            metadata: {
              reason,
              netCollectionsMinor: refundPosition.netCollectionsMinor,
              preexistingPayableMinor: refundPosition.balanceMinor,
            },
          })
        : null;
      const eventId = await emitExactOutbox(client, buildExactSaleCancelledEvent({
        merchantId: scope.merchantId,
        storeId: scope.storeId,
        orderId,
        sourceOccurredAt: cancellation.rows[0]!.canceled_at,
        payload: {
          customerId: order.customerId,
          total: order.total,
          reason,
          stockLocationId: scope.stockLocationId,
          commercialRevisionId: cancellationRevision.revisionId,
          customerRefundPayableId: cancellationPayable?.payableId || null,
          customerRefundPayableMinor: cancellationPayableAmount,
        },
      }));
      await recordAuditEntry(client, actor, "order.cancelled", "order", orderId, {
        before: { status: order.status },
        after: { status: "canceled" },
        reason,
        correlationId: eventId,
        merchantId: scope.merchantId,
        storeId: scope.storeId,
      });
      return {
        order: await formatOrder(client, orderId),
        financial: {
          commercialRevisionId: cancellationRevision.revisionId,
          customerRefundPayableId: cancellationPayable?.payableId || null,
          customerRefundPayableMinor: cancellationPayableAmount,
          customerRefundPayableStatus: cancellationPayable ? "open" : "none",
        },
      };
    });
    const receipt = result.response.order;
    if (!receipt || receipt.id !== orderId || receipt.merchantId !== scope.merchantId || receipt.storeId !== scope.storeId) {
      throw new PlatformError("idempotency_conflict", "Cancellation receipt belongs to another order or scope", 409);
    }
    return result;
  });
}

export async function refundOrder(headers: HeadersLike, orderId: string, body: RefundOrderInput, actor: OperatorContext | ChannelActor, scope?: { merchantId?: string; storeId?: string }) {
  const tenantId = scope?.merchantId;
  if (!tenantId) {
    throw new PlatformError("scope_required", "refundOrder requires tenantId for scoped idempotency", 409);
  }
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId: tenantId });
    const lifecycleTarget = await getOrderMutationTargetForClient(client, orderId);
    if (lifecycleTarget.merchantId !== tenantId || (scope?.storeId && lifecycleTarget.storeId !== scope.storeId)) {
      throw new PlatformError("forbidden", "Order is outside the active scope", 403);
    }
    if (lifecycleTarget.storeId) await lockActiveBusinessScopeForClient(client,
      { scopeType: "store", merchantId: tenantId, storeId: lifecycleTarget.storeId });
    return withScopedIdempotency(client, headers, body, tenantId, ORDER_OPS.refundOrder, async () => {
      const target = await getOrderMutationTargetForClient(client, orderId, true);
      if (target.merchantId !== tenantId || (scope?.storeId && target.storeId !== scope.storeId)) {
        throw new PlatformError("forbidden", "Order is outside the active scope", 403);
      }
      const order = await formatOrder(client, orderId);
      if (!order) throw new PlatformError("resource_not_found", "Order not found", 404);
      // Hard scope assertion before any payment entry mutation.
      if (!order.merchantId || order.merchantId !== tenantId) {
        throw new PlatformError("forbidden", "Order is outside the active merchant scope", 403);
      }
      if (scope?.storeId && (!order.storeId || order.storeId !== scope.storeId)) {
        throw new PlatformError("forbidden", "Order is outside the active store scope", 403);
      }
      if (body.restock) {
        throw new PlatformError("unsupported_operation", "Refund does not restock inventory; use an explicit stock workflow", 400);
      }

      const reason = String(body.reason || "").trim();
      if (!reason) throw new PlatformError("validation_error", "Refund reason is required", 400);
      if (reason.length > 500 || (!isChannelActor(actor) && reason.length < 8)) {
        throw new PlatformError(
          "validation_error",
          "Web POS refund reason must contain between 8 and 500 characters",
          400,
        );
      }
      if (!isChannelActor(actor)) {
        const expectedConfirmation = String(order.orderNumber || orderId).trim();
        if (String(body.confirmationToken || "") !== expectedConfirmation) {
          throw new PlatformError(
            "validation_error",
            "Refund confirmation token must exactly match the order number",
            400,
          );
        }
      }

      const requestedPayoutMethod = String(body.method || "").trim();
      if (!isChannelActor(actor) && !["cash", "bank_transfer"].includes(requestedPayoutMethod)) {
        throw new PlatformError(
          "validation_error",
          "Web POS refund requires the actual payout method: cash or bank transfer",
          400,
        );
      }
      const sourceReference = String(body.sourceReference || "").trim();
      let paidAt: string | null = null;
      if (!isChannelActor(actor) && requestedPayoutMethod === "bank_transfer") {
        if (sourceReference.length < 3 || sourceReference.length > 128) {
          throw new PlatformError(
            "validation_error",
            "Bank refund source reference must contain between 3 and 128 characters",
            400,
          );
        }
        const parsedPaidAt = Date.parse(String(body.paidAt || ""));
        if (!Number.isFinite(parsedPaidAt)) {
          throw new PlatformError("validation_error", "Bank refund paidAt is invalid", 400);
        }
        paidAt = new Date(parsedPaidAt).toISOString();
      }

      const canonicalPosition = await readCustomerRefundPositionV1(client, {
        merchantId: tenantId,
        storeId: String(order.storeId),
        orderId,
      });
      if (canonicalPosition.netCollectionsMinor <= 0) {
        throw new PlatformError(
          "invalid_state_transition",
          "Order has no canonical posted refundable collection balance",
          409,
          { canonicalPosition },
        );
      }

      const amount = resolveRefundPayoutAmountV1({
        channelActor: isChannelActor(actor),
        orderStatus: String(order.status || ""),
        requestedAmount: body.amount,
        payableBalanceMinor: canonicalPosition.balanceMinor,
        netCollectionsMinor: canonicalPosition.netCollectionsMinor,
      });

      const payoutOccurredAtResult = await client.query<{ occurred_at: Date | string }>(`
        SELECT transaction_timestamp() AS occurred_at
      `);
      const payoutOccurredAt = paidAt
        || new Date(payoutOccurredAtResult.rows[0]!.occurred_at).toISOString();
      const refundRequestId = id("refundreq");
      let payableId: string | null = null;
      if (canonicalPosition.balanceMinor < amount) {
        if (!isChannelActor(actor)) {
          throw new PlatformError(
            "financial_invariant_error",
            "Customer refund payable does not cover the requested payout",
            409,
            { requested: amount, payable: canonicalPosition.balanceMinor },
          );
        }
        const latestRevision = await queryOne<{ id: string }>(client, `
          SELECT id::text AS id
          FROM app.order_commercial_revisions
          WHERE merchant_id = $1 AND store_id = $2 AND order_id = $3
          ORDER BY revision DESC, effective_at DESC, id DESC
          LIMIT 1
        `, [tenantId, String(order.storeId), orderId]);
        if (!latestRevision?.id) {
          throw new PlatformError("financial_invariant_error", "Commercial revision is unavailable", 409);
        }
        const payable = await openCustomerRefundPayableV1(client, {
          merchantId: tenantId,
          storeId: String(order.storeId),
          orderId,
          commercialRevisionId: latestRevision.id,
          kind: "manual_refund",
          amountMinor: amount - canonicalPosition.balanceMinor,
          sourceType: "manual_refund",
          sourceId: refundRequestId,
          sourceOccurredAt: payoutOccurredAt,
          metadata: { reason, confirmationToken: body.confirmationToken || null },
        });
        payableId = payable.payableId;
      }
      const canonicalPayout = await recordCustomerRefundPayoutV1(client, {
        merchantId: tenantId,
        storeId: String(order.storeId),
        orderId,
        amountMinor: amount,
        method: ["cash", "bank_transfer"].includes(requestedPayoutMethod)
          ? requestedPayoutMethod as "cash" | "bank_transfer"
          : ["cash", "bank_transfer", "cod"].includes(String(order.paymentMethod || ""))
            ? String(order.paymentMethod) as "cash" | "bank_transfer" | "cod"
          : "unknown",
        sourceType: "manual_refund_payout",
        sourceId: refundRequestId,
        sourceOccurredAt: payoutOccurredAt,
        operatorId: actor.operatorId,
        reason,
        metadata: {
          confirmationToken: body.confirmationToken || null,
          sourceReference: sourceReference || null,
          evidenceBoundary: requestedPayoutMethod === "bank_transfer"
            ? "manual_bank_refund_verified"
            : "operator_cash_refund_confirmed",
        },
      });

      const refundEntry = await recordOrderRefund(client, {
        orderId,
        orderNumber: String(order.orderNumber || orderId),
        merchantId: tenantId,
        storeId: String(order.storeId),
        amount,
        reason,
        createdBy: actor.operatorId,
        metadata: {
          source: isChannelActor(actor) ? "channel" : "web_pos",
          refundableBefore: canonicalPosition.netCollectionsMinor,
          refundableAfter: Math.max(0, canonicalPosition.netCollectionsMinor - amount),
          canonicalPaymentEventId: canonicalPayout.paymentEventId,
          customerRefundPayableId: payableId,
          confirmationToken: body.confirmationToken || null,
          payoutMethod: requestedPayoutMethod || order.paymentMethod || "unknown",
          payoutSourceReference: sourceReference || null,
          payoutOccurredAt,
          restock: false,
          ...channelMetadata(actor),
        },
      });

      const status = amount === canonicalPosition.netCollectionsMinor ? "refunded" : "partially_refunded";
      const eventId = await emitExactOutbox(client, buildExactRefundCreatedEvent({
        merchantId: tenantId,
        storeId: String(scope?.storeId || order.storeId || ""),
        orderId,
        paymentEntryId: refundEntry.id,
        sourceOccurredAt: refundEntry.createdAt,
        payload: {
          orderNumber: order.orderNumber,
          amount,
          reason,
          status,
          restock: false,
          operatorId: actor.operatorId,
          canonicalPaymentEventId: canonicalPayout.paymentEventId,
          customerRefundPayableId: payableId,
          orderStatus: order.status,
          paymentMethod: order.paymentMethod,
          payoutMethod: requestedPayoutMethod || order.paymentMethod || "unknown",
          payoutSourceReference: sourceReference || null,
          ...channelMetadata(actor),
        },
      }));
      await recordAuditEntry(client, actor, "order.refunded", "order", orderId, {
        before: { refundable: canonicalPosition.netCollectionsMinor },
        after: {
          status,
          refundEntryId: refundEntry.id,
          amount,
          refundable: Math.max(0, canonicalPosition.netCollectionsMinor - amount),
          canonicalPaymentEventId: canonicalPayout.paymentEventId,
          payoutMethod: requestedPayoutMethod || order.paymentMethod || "unknown",
          payoutSourceReference: sourceReference || null,
          payoutOccurredAt,
          restock: false,
        },
        reason,
        correlationId: eventId,
        merchantId: tenantId,
        storeId: scope?.storeId || order.storeId || undefined,
      });

      return {
        data: {
          orderId,
          orderNumber: order.orderNumber,
          status,
          refundEntryId: refundEntry.id,
          amount,
          refundableBefore: canonicalPosition.netCollectionsMinor,
          refundableAfter: Math.max(0, canonicalPosition.netCollectionsMinor - amount),
          canonicalPaymentEventId: canonicalPayout.paymentEventId,
          restock: false,
        },
      };
    });
  });
}
