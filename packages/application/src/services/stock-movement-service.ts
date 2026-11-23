import { isPartnerBusinessActor, businessActorId, partnerActorMetadata, type PartnerBusinessActor } from "../utils/business-actor";
import type { PoolClient } from "../db/client";
import { queryOne } from "../db/query";
import { PlatformError } from "../errors/platform-error";
import type { Role } from "../middleware/auth";

export type StockMovementActor = {
  operatorId: string;
  displayName?: string;
  role?: Role | string;
  actualOperatorId?: string;
  channel?: string;
  channelUserId?: string;
  serviceIdentity?: string;
  requestId?: string;
};

export type StockMovementScope = {
  merchantId: string;
  storeId: string;
  stockLocationId: string;
};

export type RecordStockMovementInput = {
  inventoryItemId: string;
  productId?: string | null;
  variantId?: string | null;
  sku?: string | null;
  productTitle?: string | null;
  movementType: string;
  sourceAction: string;
  quantityBefore: number;
  quantityChange: number;
  quantityAfter: number;
  referenceType?: string | null;
  referenceId?: string | null;
  referenceDisplay?: string | null;
  reason?: string | null;
  reasonCode?: string | null;
  actor: StockMovementActor | PartnerBusinessActor;
  scope: StockMovementScope;
  sourceChannel?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
};

type MovementSnapshot = {
  inventory_item_id: string;
  product_id: string | null;
  variant_id: string | null;
  sku: string | null;
  product_title: string | null;
};

function integer(value: number, field: string): number {
  if (!Number.isInteger(value)) {
    throw new PlatformError("validation_error", `${field} must be an integer`, 400);
  }
  return value;
}

function text(value: unknown, fallback = ""): string {
  return String(value ?? fallback).trim();
}

export async function recordStockMovement(client: PoolClient, input: RecordStockMovementInput) {
  const partner = isPartnerBusinessActor(input.actor) ? input.actor : null;
  const staff = isPartnerBusinessActor(input.actor) ? null : input.actor;
  if (partner && (input.scope.merchantId !== partner.merchantId || input.scope.storeId !== partner.storeId)) {
    throw new PlatformError("forbidden", "Partner stock movement scope mismatch", 403);
  }
  const quantityBefore = integer(Number(input.quantityBefore), "quantityBefore");
  const quantityChange = integer(Number(input.quantityChange), "quantityChange");
  const quantityAfter = integer(Number(input.quantityAfter), "quantityAfter");
  if (quantityChange === 0) throw new PlatformError("validation_error", "quantityChange must be non-zero", 400);
  if (quantityAfter < 0) throw new PlatformError("validation_error", "quantityAfter cannot be negative", 400);
  if (quantityBefore + quantityChange !== quantityAfter) {
    throw new PlatformError("validation_error", "Stock movement quantities are inconsistent", 400, {
      quantityBefore,
      quantityChange,
      quantityAfter,
    });
  }

  const snapshot = await queryOne<MovementSnapshot>(client, `
    SELECT
      ii.id AS inventory_item_id,
      v.product_id,
      v.id AS variant_id,
      COALESCE(v.sku, ii.sku, '') AS sku,
      COALESCE(p.title, ii.title, '') AS product_title
    FROM public.inventory_item ii
    LEFT JOIN public.product_variant_inventory_item vii
      ON vii.inventory_item_id = ii.id
     AND vii.deleted_at IS NULL
    LEFT JOIN public.product_variant v
      ON v.id = vii.variant_id
     AND v.deleted_at IS NULL
    LEFT JOIN public.product p
      ON p.id = v.product_id
     AND p.deleted_at IS NULL
    WHERE ii.id = $1
      AND ii.deleted_at IS NULL
    LIMIT 1
  `, [input.inventoryItemId]);

  const productId = text(input.productId || snapshot?.product_id || null) || null;
  const variantId = text(input.variantId || snapshot?.variant_id || null) || null;
  const skuSnapshot = text(input.sku || snapshot?.sku || null) || null;
  const titleSnapshot = text(input.productTitle || snapshot?.product_title || null) || null;
  const referenceType = text(input.referenceType || null) || null;
  const referenceId = text(input.referenceId || null) || null;
  const referenceDisplay = text(input.referenceDisplay || referenceId || null) || null;
  const reason = text(input.reason || null) || null;
  const reasonCode = text(input.reasonCode || input.reason || input.sourceAction) || input.sourceAction;
  const sourceChannel = text(input.sourceChannel || staff?.channel || null) || null;
  const metadata = {
    historyQuality: "native",
    ...(input.metadata || {}),
    quantityBefore,
    ...(partner ? partnerActorMetadata(partner) : {}),
    ...(staff?.channelUserId ? { channelUserId: staff?.channelUserId } : {}),
    ...(staff?.serviceIdentity ? { serviceIdentity: staff?.serviceIdentity } : {}),
    ...(input.actor.requestId ? { requestId: input.actor.requestId } : {}),
  };

  const result = await client.query(`
    INSERT INTO medusa.stock_movements (
      inventory_item_id,
      product_id,
      variant_id,
      sku_snapshot,
      product_title_snapshot,
      movement_type,
      source_action,
      quantity_change,
      quantity_after,
      reference_type,
      reference_id,
      reference_display,
      reason,
      reason_code,
      performed_by,
      actor_display_name_snapshot,
      actor_role_snapshot,
      actual_operator_id,
      source_channel,
      correlation_id,
      metadata,
      merchant_id,
      store_id,
      stock_location_id
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12, $13, $14,
      $15, $16, $17, $18, $19, $20, $21::jsonb,
      $22, $23, $24
    )
    RETURNING *
  `, [
    input.inventoryItemId,
    productId,
    variantId,
    skuSnapshot,
    titleSnapshot,
    input.movementType,
    input.sourceAction,
    quantityChange,
    quantityAfter,
    referenceType,
    referenceId,
    referenceDisplay,
    reason,
    reasonCode,
    businessActorId(input.actor),
    text(staff?.displayName || businessActorId(input.actor)),
    partner ? "partner" : text(staff?.role || null) || null,
    text(staff?.actualOperatorId || null) || null,
    sourceChannel,
    text(input.correlationId || null) || null,
    JSON.stringify(metadata),
    input.scope.merchantId,
    input.scope.storeId,
    input.scope.stockLocationId,
  ]);

  return result.rows[0];
}
