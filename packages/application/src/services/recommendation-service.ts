import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { OperatorContext } from "./auth-service";
import { requireFeature } from "./feature-entitlement-service";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";

export interface CrossSellInput {
  items: Array<{ variantId: string; quantity?: number }>;
  customerId?: string;
  limit?: number;
  merchantId: string;
  storeId?: string;
  stockLocationId?: string;
}

export interface CrossSellRecommendation {
  productId: string;
  variantId: string;
  sku: string;
  name: string;
  price: number;
  stock: number;
  score: number;
  reason: string;
}

export interface CrossSellAcceptanceInput {
  merchantId: string;
  storeId: string;
  acceptedVariantId: string;
  acceptedProductId?: string;
  cartVariantIds?: string[];
  customerId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export async function getCrossSellRecommendations(input: CrossSellInput) {
  requireFeature("smart_cross_sell");
  if (!input.merchantId?.trim()) {
    throw new Error("merchantId is required for cross-sell recommendations");
  }
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const cartVariantIds = (input.items || []).map((item) => String(item.variantId || "")).filter(Boolean);
    const limit = Math.min(Math.max(Number(input.limit || 3), 1), 5);
    const result = await client.query(`
      WITH customer_history AS (
        SELECT
          li.product_id,
          COUNT(*)::int AS purchase_count
        FROM public."order" o
        JOIN public.order_item oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
        JOIN public.order_line_item li ON li.id = oi.item_id AND li.deleted_at IS NULL
        WHERE $3::text IS NOT NULL
          AND o.customer_id = $3::text
          AND o.merchant_id = $5::text
          AND o.deleted_at IS NULL
        GROUP BY li.product_id
      ),
      active_promotions AS (
        SELECT product_id, category_name, MAX(priority)::int AS priority
        FROM ai_module.promotion_strategies
        WHERE is_active = true
          AND merchant_id = $5::text
          AND (store_id IS NULL OR store_id = $6::text)
          AND (starts_at IS NULL OR starts_at <= now())
          AND (ends_at IS NULL OR ends_at >= now())
        GROUP BY product_id, category_name
      )
      SELECT
        p.id AS product_id,
        p.title AS product_title,
        v.id AS variant_id,
        COALESCE(v.sku, '') AS sku,
        COALESCE(pr.amount, 0)::numeric AS price,
        COALESCE(il.stocked_quantity, 0)::numeric AS stock,
        COALESCE(pc.name, '') AS category_name,
        COALESCE(ch.purchase_count, 0)::int AS customer_purchase_count,
        COALESCE(ap.priority, 0)::int AS promotion_priority
      FROM public.product p
      JOIN public.product_variant v ON v.product_id = p.id AND v.deleted_at IS NULL
      LEFT JOIN public.product_variant_price_set vps ON vps.variant_id = v.id AND vps.deleted_at IS NULL
      LEFT JOIN public.price pr ON pr.price_set_id = vps.price_set_id AND pr.currency_code = 'vnd' AND pr.deleted_at IS NULL
      LEFT JOIN public.product_variant_inventory_item vii ON vii.variant_id = v.id AND vii.deleted_at IS NULL
      LEFT JOIN public.inventory_level il ON il.inventory_item_id = vii.inventory_item_id
        AND il.deleted_at IS NULL
        AND ($4::text IS NULL OR il.location_id = $4::text)
      LEFT JOIN public.product_category_product pcp ON pcp.product_id = p.id
      LEFT JOIN public.product_category pc ON pc.id = pcp.product_category_id AND pc.deleted_at IS NULL
      LEFT JOIN customer_history ch ON ch.product_id = p.id
      LEFT JOIN active_promotions ap ON ap.product_id = p.id OR (ap.category_name IS NOT NULL AND ap.category_name = pc.name)
      WHERE p.deleted_at IS NULL
        AND p.status = 'published'
        AND p.merchant_id = $5::text
        AND COALESCE(il.stocked_quantity, 0) > 0
        AND NOT (v.id = ANY($1::text[]))
      ORDER BY
        COALESCE(ap.priority, 0)::int DESC,
        COALESCE(ch.purchase_count, 0)::int DESC,
        COALESCE(il.stocked_quantity, 0)::numeric DESC,
        p.title ASC
      LIMIT $2
    `, [
      cartVariantIds,
      limit,
      input.customerId || null,
      input.stockLocationId || null,
      input.merchantId,
      input.storeId || null,
    ]);

    const data: CrossSellRecommendation[] = result.rows.map((row, index) => {
      const price = Number(row.price || 0);
      const stock = Number(row.stock || 0);
      const purchaseCount = Number(row.customer_purchase_count || 0);
      const promotionPriority = Number(row.promotion_priority || 0);
      return {
        productId: String(row.product_id),
        variantId: String(row.variant_id),
        sku: String(row.sku || ""),
        name: String(row.product_title),
        price,
        stock,
        score: Math.max(1, 100 - index * 10 + purchaseCount * 12 + promotionPriority * 15 + Math.min(stock, 20)),
        reason: [
          purchaseCount > 0 ? `khách từng mua ${purchaseCount} lần` : "khách chưa có lịch sử mua sản phẩm này",
          promotionPriority > 0 ? "đang có khuyến mãi phù hợp" : "không có khuyến mãi hiện tại",
          stock > 5 ? "Còn đủ hàng" : "Sắp hết, nên bán khi còn stock",
          row.category_name ? `nhóm ${row.category_name}` : "phù hợp giỏ hiện tại",
        ].join(" | "),
      };
    });

    return { data };
  });
}

export async function recordCrossSellAcceptance(input: CrossSellAcceptanceInput, actor: OperatorContext) {
  requireFeature("smart_cross_sell");
  if (!input.merchantId?.trim() || !input.storeId?.trim()) {
    return { data: { recorded: false, reason: "missing_operating_scope" } };
  }
  const acceptedVariantId = String(input.acceptedVariantId || "").trim();
  if (!acceptedVariantId) {
    return { data: { recorded: false, reason: "missing_accepted_variant_id" } };
  }
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, {
      scopeType: "store", merchantId: input.merchantId, storeId: input.storeId,
    });
    const result = await client.query(`
      INSERT INTO ai_module.cross_sell_events (
        merchant_id, store_id, event_type, cart_variant_ids, accepted_variant_id, accepted_product_id,
        customer_id, source, metadata, created_by
      )
      VALUES ($1, $2, 'accepted', $3::text[], $4, $5, $6, $7, $8::jsonb, $9)
      RETURNING id, created_at
    `, [
      input.merchantId,
      input.storeId,
      (input.cartVariantIds || []).map((value) => String(value || "")).filter(Boolean),
      acceptedVariantId,
      input.acceptedProductId || null,
      input.customerId || null,
      input.source || "pos",
      JSON.stringify(input.metadata || {}),
      actor.operatorId,
    ]);
    return {
      data: {
        recorded: true,
        id: String(result.rows[0].id),
        createdAt: new Date(result.rows[0].created_at).toISOString(),
      },
    };
  });
}
