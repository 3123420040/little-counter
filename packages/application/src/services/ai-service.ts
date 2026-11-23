import { filterBlockedClaims, shouldTriggerAlert } from "@medusa-snus/domain";
import { withScopedIdempotency } from "../db/idempotency";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import type { HeadersLike } from "../http/headers";
import { recordAuditEntry } from "../repositories/audit-repository";
import type { OperatorContext } from "./auth-service";
import type { ChannelActor } from "./channel-auth-service";

type AiActor = OperatorContext | ChannelActor;

function assertReviewableAiAction<T extends { status: string }>(action: T | null, verb: "approve" | "reject"): asserts action is T {
  if (!action) throw new PlatformError("resource_not_found", "Action not found", 404);
  if (action.status !== "review_required" && action.status !== "pending") {
    throw new PlatformError("invalid_state_transition", `Cannot ${verb} action in status: ${action.status}`, 409);
  }
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedClient(fn);
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedTransaction(fn);
}

// Stable operation codes used with withScopedIdempotency.
export const AI_OPS = {
  persistReplyDraft: "ai.persist_reply_draft",
  approveAiAction: "ai.approve_action",
  rejectAiAction: "ai.reject_action",
  acknowledgeAiAlert: "ai.acknowledge_alert",
} as const;

export function buildLoyaltyRecommendations(tier: string, pointsEarned: number): string[] {
  const base = [`Khách vừa tích ${pointsEarned} điểm. Nhắc khách kiểm tra ưu đãi hạng ${tier}.`];
  if (tier === "gold" || tier === "platinum") base.push("Gợi ý ưu đãi khách thân thiết cho đơn tiếp theo.");
  else base.push("Gợi ý combo sản phẩm phổ biến để tăng điểm nhanh hơn.");
  return base;
}

export async function syncInventoryAlertForStockChange(client: PoolClient, eventId: string, payload: Record<string, unknown>) {
  const productId = String(payload.productId || "");
  const variantId = String(payload.variantId || "") || null;
  const inventoryItemId = String(payload.inventoryItemId || "") || null;
  const currentStock = Number(payload.quantityAfter || 0);
  const reorderLevel = Number(payload.reorderLevel || 5);
  const merchantId = String(payload.merchantId || "");
  const storeId = String(payload.storeId || "");
  if (!merchantId || !storeId) throw new Error("stock.changed payload is missing tenant scope");
  if (shouldTriggerAlert(currentStock, reorderLevel)) {
    const suggestedQuantity = Math.max(1, 20 - currentStock);
    await client.query(`
      INSERT INTO ai_module.inventory_alerts (
        source_event_id, product_id, variant_id, inventory_item_id,
        product_title_snapshot, sku_snapshot,
        current_stock, reorder_level, suggested_quantity, status, merchant_id, store_id
      )
      SELECT $1::uuid, $2, $3, $4, p.title, v.sku, $5, $6, $7, 'new', $8, $9
      FROM public.product p
      LEFT JOIN public.product_variant v ON v.id = $3 AND v.deleted_at IS NULL
      WHERE p.id = $2 AND p.deleted_at IS NULL AND p.merchant_id = $8
      ON CONFLICT (source_event_id) DO NOTHING
    `, [eventId, productId, variantId, inventoryItemId, currentStock, reorderLevel, suggestedQuantity, merchantId, storeId]);
  } else {
    await client.query(`
      UPDATE ai_module.inventory_alerts
      SET status = 'resolved'
      WHERE product_id = $1 AND merchant_id = $2 AND store_id = $3
        AND status IN ('new', 'acknowledged')
    `, [productId, merchantId, storeId]);
  }
}

export async function upsertAiActionForClient(client: PoolClient, input: {
  sourceEventId?: string;
  actionType: string;
  status: string;
  customerId?: string;
  orderId?: string;
  productId?: string;
  outputPayload: Record<string, unknown>;
  confidence?: number;
  riskLevel?: string;
  merchantId: string;
  storeId?: string;
}) {
  const existing = input.sourceEventId
    ? await queryOne(client, "SELECT id FROM ai_module.actions WHERE source_event_id = $1::uuid AND action_type = $2", [input.sourceEventId, input.actionType])
    : null;
  if (existing) return existing;
  const result = await client.query(`
    INSERT INTO ai_module.actions (
      source_event_id, action_type, status, customer_id, order_id, product_id,
      output_payload, confidence, risk_level, model_provider, model_name, prompt_version, completed_at,
      merchant_id, store_id
    ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, CASE WHEN $3 = 'completed' THEN now() ELSE NULL END, $13, $14)
    RETURNING *
  `, [
    input.sourceEventId || null,
    input.actionType,
    input.status,
    input.customerId || null,
    input.orderId || null,
    input.productId || null,
    JSON.stringify(input.outputPayload),
    input.confidence ?? null,
    input.riskLevel || null,
    process.env.AI_PROVIDER || "deterministic",
    process.env.AI_MODEL || "deterministic-rules",
    "v1",
    input.merchantId,
    input.storeId || null,
  ]);
  return result.rows[0];
}

export async function persistReplyDraft(headers: HeadersLike, input: {
  customerMessage: string;
  productContext?: string[];
  operatorInstruction?: string;
  /**
   * Tenant scope for scoped idempotency. Required: AI reply drafts belong
   * to a merchant's customer conversation and must not be replays across
   * merchants under the same Idempotency-Key.
   */
  merchantId: string;
  plan: {
    responseText: string;
    intent: string;
    confidence: number;
    riskLevel: string;
    nextBestAction?: string;
    missingInformation?: string[];
  };
}) {
  if (!input.merchantId) {
    throw new PlatformError("scope_required", "persistReplyDraft requires tenantId for scoped idempotency", 409);
  }
  return withTransaction(async (client) => {
    const result = await withScopedIdempotency(client, headers, {
      customerMessage: input.customerMessage,
      productContext: input.productContext || [],
      operatorInstruction: input.operatorInstruction || "",
    }, input.merchantId, AI_OPS.persistReplyDraft, async () => {
      const action = await upsertAiActionForClient(client, {
        actionType: "reply_draft",
        status: "review_required",
        outputPayload: {
          responseText: input.plan.responseText,
          intent: input.plan.intent,
          confidence: input.plan.confidence,
          riskLevel: input.plan.riskLevel,
          blockedClaimsFiltered: filterBlockedClaims(input.plan.responseText).matches,
          kbArtifactsUsed: input.productContext || [],
          nextBestAction: input.plan.nextBestAction || "answer_question",
          missingInformation: input.plan.missingInformation || [],
        },
        confidence: input.plan.confidence,
        riskLevel: input.plan.riskLevel,
        merchantId: input.merchantId,
      });
      const policy = filterBlockedClaims(input.plan.responseText);
      await client.query(`
        INSERT INTO ai_module.policy_decisions (ai_action_id, subject_type, subject_id, decision, reason_codes, evidence)
        VALUES ($1, 'reply_draft', $2, $3, $4, $5::jsonb)
      `, [action.id, action.id, policy.blocked ? "block" : policy.matches.length ? "flagged" : "allow", policy.matches, JSON.stringify({ customerMessage: input.customerMessage })]);
      return {
        data: {
          actionId: String(action.id),
          status: "review_required",
          output: action.output_payload,
          reviewRequired: true,
        },
      };
    }, 202);
    return result;
  });
}

export async function listAiReviewQueue(merchantId: string) {
  return withClient(async (client) => {
    const result = await client.query(`
      SELECT
        id::text,
        action_type AS "actionType",
        status,
        output_payload AS "outputPayload",
        confidence,
        risk_level AS "riskLevel",
        reviewed_by AS "reviewedBy",
        approved_text AS "approvedText",
        rejection_reason AS "rejectionReason",
        created_at AS "createdAt"
      FROM ai_module.actions
      WHERE status IN ('review_required', 'pending')
        AND merchant_id = $1
      ORDER BY created_at DESC
    `, [merchantId]);
    return { data: result.rows };
  });
}

export async function approveAiAction(headers: HeadersLike, actionId: string, approvedText: string | undefined, actor: AiActor, merchantId: string) {
  return withTransaction(async (client) => {
    // Resolve tenantId from the action row BEFORE idempotency so the key
    // is partitioned by (tenant, op, key) and never replays across merchants.
    const actionRow = await queryOne<{ merchant_id: string | null }>(client, `
      SELECT merchant_id FROM ai_module.actions WHERE id::text = $1
    `, [actionId]);
    const actionMerchantId = actionRow?.merchant_id;
    if (!actionMerchantId || actionMerchantId !== merchantId) {
      throw new PlatformError("resource_not_found", "AI action not found", 404);
    }
    const result = await withScopedIdempotency(client, headers, { actionId, approvedText, action: "approve" }, actionMerchantId, AI_OPS.approveAiAction, async () => {
      const before = await queryOne<{ status: string; approved_text: string | null; reviewed_by: string | null }>(client, `
        SELECT status, approved_text, reviewed_by
        FROM ai_module.actions
        WHERE id::text = $1 AND merchant_id = $2
      `, [actionId, merchantId]);
      assertReviewableAiAction(before, "approve");
      const update = await client.query(`
        UPDATE ai_module.actions
        SET status = 'approved', approved_text = $2, reviewed_by = $3, completed_at = now()
        WHERE id::text = $1 AND merchant_id = $4 AND status IN ('review_required', 'pending')
        RETURNING *
      `, [actionId, approvedText || null, actor.operatorId, merchantId]);
      if (!update.rows[0]) throw new PlatformError("invalid_state_transition", "Action is no longer pending review", 409);
      await recordAuditEntry(client, actor, "ai_action.approved", "ai_action", actionId, {
        before: {
          status: before.status,
          approvedText: before.approved_text,
          reviewedBy: before.reviewed_by,
        },
        after: {
          status: "approved",
          approvedText: approvedText || null,
          reviewedBy: actor.operatorId,
        },
        merchantId,
      });
      return { data: update.rows[0] };
    });
    return result;
  });
}

export async function rejectAiAction(headers: HeadersLike, actionId: string, reason: string | undefined, actor: AiActor, merchantId: string) {
  return withTransaction(async (client) => {
    // Resolve tenantId from the action row BEFORE idempotency.
    const actionRow = await queryOne<{ merchant_id: string | null }>(client, `
      SELECT merchant_id FROM ai_module.actions WHERE id::text = $1
    `, [actionId]);
    const actionMerchantId = actionRow?.merchant_id;
    if (!actionMerchantId || actionMerchantId !== merchantId) {
      throw new PlatformError("resource_not_found", "AI action not found", 404);
    }
    const result = await withScopedIdempotency(client, headers, { actionId, reason, action: "reject" }, actionMerchantId, AI_OPS.rejectAiAction, async () => {
      const before = await queryOne<{ status: string; rejection_reason: string | null; reviewed_by: string | null }>(client, `
        SELECT status, rejection_reason, reviewed_by
        FROM ai_module.actions
        WHERE id::text = $1 AND merchant_id = $2
      `, [actionId, merchantId]);
      assertReviewableAiAction(before, "reject");
      const rejectionReason = reason || "operator_rejected";
      const update = await client.query(`
        UPDATE ai_module.actions
        SET status = 'rejected', rejection_reason = $2, reviewed_by = $3, completed_at = now()
        WHERE id::text = $1 AND merchant_id = $4 AND status IN ('review_required', 'pending')
        RETURNING *
      `, [actionId, rejectionReason, actor.operatorId, merchantId]);
      if (!update.rows[0]) throw new PlatformError("invalid_state_transition", "Action is no longer pending review", 409);
      await recordAuditEntry(client, actor, "ai_action.rejected", "ai_action", actionId, {
        before: {
          status: before.status,
          rejectionReason: before.rejection_reason,
          reviewedBy: before.reviewed_by,
        },
        after: {
          status: "rejected",
          rejectionReason,
          reviewedBy: actor.operatorId,
        },
        reason: rejectionReason,
        merchantId,
      });
      return { data: update.rows[0] };
    });
    return result;
  });
}

export async function listAiAlerts(merchantId: string, storeIds: string[]) {
  return withClient(async (client) => {
    const result = await client.query(`
      SELECT
        a.id::text,
        a.product_id AS "productId",
        a.variant_id AS "variantId",
        a.inventory_item_id AS "inventoryItemId",
        COALESCE(p.title, a.product_title_snapshot, 'Sản phẩm không còn khả dụng') AS "productTitle",
        COALESCE(v.sku, fallback_variant.sku, a.sku_snapshot) AS sku,
        a.current_stock AS "currentStock",
        a.reorder_level AS "reorderLevel",
        a.suggested_quantity AS "suggestedQuantity",
        a.status,
        a.acknowledged_by AS "acknowledgedBy",
        a.acknowledged_at AS "acknowledgedAt",
        a.created_at AS "createdAt"
      FROM ai_module.inventory_alerts a
      LEFT JOIN public.product p ON p.id = a.product_id AND p.deleted_at IS NULL
      LEFT JOIN public.product_variant v ON v.id = a.variant_id AND v.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT pv.sku
        FROM public.product_variant pv
        WHERE pv.product_id = a.product_id AND pv.deleted_at IS NULL
        ORDER BY pv.created_at ASC
        LIMIT 1
      ) fallback_variant ON true
      WHERE a.status <> 'resolved'
        AND a.merchant_id = $1
        AND a.store_id = ANY($2::text[])
      ORDER BY a.created_at DESC
    `, [merchantId, storeIds]);
    return { data: result.rows };
  });
}

export async function acknowledgeAiAlert(headers: HeadersLike, alertId: string, actor: AiActor, merchantId: string, storeId: string) {
  return withTransaction(async (client) => {
    // Resolve tenantId from the alert row BEFORE idempotency.
    const alertRow = await queryOne<{ merchant_id: string | null }>(client, `
      SELECT merchant_id FROM ai_module.inventory_alerts WHERE id::text = $1
    `, [alertId]);
    const alertMerchantId = alertRow?.merchant_id;
    if (!alertMerchantId || alertMerchantId !== merchantId) {
      throw new PlatformError("resource_not_found", "AI alert not found", 404);
    }
    const result = await withScopedIdempotency(client, headers, { alertId, action: "acknowledge" }, alertMerchantId, AI_OPS.acknowledgeAiAlert, async () => {
      const update = await client.query(`
        UPDATE ai_module.inventory_alerts
        SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now()
        WHERE id::text = $1 AND merchant_id = $3 AND store_id = $4
        RETURNING *
      `, [alertId, actor.operatorId, merchantId, storeId]);
      if (!update.rows[0]) throw new PlatformError("resource_not_found", "Alert not found", 404);
      return { data: { acknowledged: true } };
    });
    return result;
  });
}

export async function getAiRecommendations(customerId: string, merchantId: string) {
  return withClient(async (client) => {
    const result = await client.query(`
      SELECT output_payload
      FROM ai_module.actions
      WHERE action_type = 'loyalty_recommendation'
        AND customer_id = $1
        AND merchant_id = $2
        AND status IN ('completed', 'approved')
      ORDER BY created_at DESC
      LIMIT 1
    `, [customerId, merchantId]);
    const payload = result.rows[0]?.output_payload as { recommendations?: string[] } | undefined;
    return { data: payload?.recommendations || [] };
  });
}
