import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import { evaluateTier, pointsToNextTier } from "@medusa-snus/domain";
import { withScopedIdempotency } from "../db/idempotency";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import type { HeadersLike } from "../http/headers";
import { recordAuditEntry } from "../repositories/audit-repository";
import { emitExactOutbox } from "../repositories/outbox-repository";
import { id } from "../utils/id";
import type { MerchantTargetScope } from "@medusa-snus/contracts";
import type { OperatorContext } from "./auth-service";
import { assertMerchantMutationTarget } from "./mutation-scope-service";
import {
  buildExactCustomerCreatedEvent,
  buildExactCustomerDeletedEvent,
  buildExactCustomerMergedEvent,
} from "./exact-outbox-event-builders";

// Stable operation codes used with withScopedIdempotency.
export const CUST_OPS = {
  createCustomer: "customer.create",
  updateCustomer: "customer.update",
  deleteCustomer: "customer.delete",
  mergeCustomers: "customer.merge",
} as const;

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedClient(fn);
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedTransaction(fn);
}

export async function listCustomers(query?: { q?: string; merchantId?: string }) {
  return withClient(async (client) => {
    const q = `%${String(query?.q || "").toLowerCase()}%`;
    const merchantId = String(query?.merchantId || "").trim();
    const conditions = [
      "deleted_at IS NULL",
      "($1 = '%%' OR lower(COALESCE(phone, '')) LIKE $1 OR lower(COALESCE(first_name, '')) LIKE $1 OR lower(COALESCE(last_name, '')) LIKE $1)",
    ];
    const params: unknown[] = [q];
    if (merchantId) {
      params.push(merchantId);
      conditions.push(`merchant_id = $${params.length}`);
    }
    const result = await client.query(`
      SELECT id, phone, first_name, last_name, email, merchant_id
      FROM public.customer
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT 100
    `, params);
    return { customers: result.rows, count: result.rows.length, limit: 100, offset: 0 };
  });
}

export async function getCustomer(customerId: string, options: { merchantId: string }) {
  return withClient(async (client) => {
    const merchantId = String(options.merchantId || "").trim();
    if (!merchantId) throw new PlatformError("scope_required", "Customer detail requires a merchant scope", 409);
    const customer = await queryOne<Record<string, unknown>>(client, `
      SELECT id, phone, first_name, last_name, email, merchant_id
      FROM public.customer
      WHERE id = $1
        AND merchant_id = $2
        AND deleted_at IS NULL
    `, [customerId, merchantId]);
    if (!customer) throw new PlatformError("resource_not_found", "Customer not found", 404);
    return { customer };
  });
}

export async function createCustomer(
  headers: HeadersLike,
  body: { phone?: string; first_name?: string; last_name?: string; email?: string },
  actor: OperatorContext,
  scope: MerchantTargetScope,
) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId: scope.merchantId });
    const result = await withScopedIdempotency(client, headers, body, scope.merchantId, CUST_OPS.createCustomer, async () => {
      if (!body.phone || !body.first_name) throw new PlatformError("validation_error", "phone and first_name are required", 400);
      const existing = await queryOne<Record<string, unknown>>(client, "SELECT id, phone, first_name, last_name, email FROM public.customer WHERE phone = $1 AND merchant_id = $2 AND deleted_at IS NULL", [body.phone, scope.merchantId]);
      if (existing) return { customer: existing };

      const customerId = id("cus");
      const insert = await client.query(`
        INSERT INTO public.customer (id, phone, first_name, last_name, email, has_account, created_by, merchant_id)
        VALUES ($1, $2, $3, $4, $5, false, $6, $7)
        RETURNING id, phone, first_name, last_name, email, created_at
      `, [customerId, body.phone, body.first_name, body.last_name || "", body.email || null, actor.operatorId, scope.merchantId]);
      await client.query(`
        INSERT INTO ai_module.customer_profiles (customer_id, phone, total_spent, order_count, merchant_id)
        VALUES ($1, $2, 0, 0, $3)
        ON CONFLICT (customer_id) DO NOTHING
      `, [customerId, body.phone, scope.merchantId]);
      const eventId = await emitExactOutbox(client, buildExactCustomerCreatedEvent({
        customerId,
        merchantId: scope.merchantId,
        sourceOccurredAt: insert.rows[0]?.created_at,
      }));
      await recordAuditEntry(client, actor, "customer.created", "customer", customerId, {
        after: insert.rows[0],
        correlationId: eventId,
        merchantId: scope.merchantId,
      });
      return { customer: insert.rows[0] };
    });
    return result;
  });
}

export async function updateCustomer(
  headers: HeadersLike,
  customerId: string,
  body: { phone?: string; first_name?: string; last_name?: string; email?: string },
  actor: OperatorContext,
  scope: MerchantTargetScope,
) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId: scope.merchantId });
    const result = await withScopedIdempotency(client, headers, { customerId, ...body }, scope.merchantId, CUST_OPS.updateCustomer, async () => {
      const before = await queryOne<Record<string, unknown>>(client, "SELECT id, phone, first_name, last_name, email, merchant_id FROM public.customer WHERE id = $1 AND deleted_at IS NULL", [customerId]);
      if (!before) throw new PlatformError("resource_not_found", "Customer not found", 404);
      assertMerchantMutationTarget(scope, { merchantId: typeof before.merchant_id === "string" ? before.merchant_id : null }, "Customer");
      const hasPhone = Object.prototype.hasOwnProperty.call(body, "phone");
      const hasFirstName = Object.prototype.hasOwnProperty.call(body, "first_name");
      const hasLastName = Object.prototype.hasOwnProperty.call(body, "last_name");
      const hasEmail = Object.prototype.hasOwnProperty.call(body, "email");
      const nextPhone = hasPhone ? String(body.phone ?? "").trim() : String(before.phone || "");
      const nextFirstName = hasFirstName ? String(body.first_name ?? "").trim() : String(before.first_name || "");
      const nextLastName = hasLastName ? String(body.last_name ?? "").trim() : String(before.last_name || "");
      const nextEmail = hasEmail ? String(body.email ?? "").trim() || null : before.email || null;
      if (!nextPhone || !nextFirstName) {
        throw new PlatformError("validation_error", "phone and first_name are required", 400);
      }
      const updated = await client.query(`
        UPDATE public.customer
        SET phone = $2,
            first_name = $3,
            last_name = $4,
            email = $5,
            updated_at = now()
        WHERE id = $1
        RETURNING id, phone, first_name, last_name, email
      `, [customerId, nextPhone, nextFirstName, nextLastName, nextEmail]);
      await client.query("UPDATE ai_module.customer_profiles SET phone = $2, updated_at = now() WHERE customer_id = $1 AND merchant_id = $3", [customerId, nextPhone, scope.merchantId]);
      await recordAuditEntry(client, actor, "customer.updated", "customer", customerId, {
        before,
        after: updated.rows[0],
        merchantId: scope.merchantId,
      });
      return { customer: updated.rows[0] };
    }, 200);
    return result;
  });
}

export async function deleteCustomer(
  headers: HeadersLike,
  customerId: string,
  actor: OperatorContext,
  scope: MerchantTargetScope,
) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId: scope.merchantId });
    const result = await withScopedIdempotency(client, headers, { customerId }, scope.merchantId, CUST_OPS.deleteCustomer, async () => {
      const before = await queryOne<Record<string, unknown>>(client, `
        SELECT id, phone, first_name, last_name, email, merchant_id
        FROM public.customer
        WHERE id = $1
          AND deleted_at IS NULL
      `, [customerId]);
      if (!before) throw new PlatformError("resource_not_found", "Customer not found", 404);
      assertMerchantMutationTarget(scope, { merchantId: typeof before.merchant_id === "string" ? before.merchant_id : null }, "Customer");

      const deleted = await client.query<{ deleted_at: Date | string }>(`
        UPDATE public.customer
        SET deleted_at = now(),
            updated_at = now()
        WHERE id = $1
          AND merchant_id = $2
          AND deleted_at IS NULL
        RETURNING deleted_at
      `, [customerId, scope.merchantId]);

      const eventId = await emitExactOutbox(client, buildExactCustomerDeletedEvent({
        customerId,
        merchantId: scope.merchantId,
        sourceOccurredAt: deleted.rows[0]?.deleted_at,
      }));
      await recordAuditEntry(client, actor, "customer.deleted", "customer", customerId, {
        before,
        after: { deleted: true },
        correlationId: eventId,
        merchantId: scope.merchantId,
      });
      return { deleted: true, id: customerId };
    }, 200);
    return result;
  });
}

export async function getCustomerLoyalty(customerId: string, options: { merchantId: string }) {
  return withClient(async (client) => {
    const merchantId = String(options.merchantId || "").trim();
    if (!merchantId) throw new PlatformError("scope_required", "Customer loyalty requires a merchant scope", 409);
    const conditions = ["cp.customer_id = $1"];
    const params: unknown[] = [customerId];
    params.push(merchantId);
    conditions.push(`cp.merchant_id = $${params.length}`);
    const profile = await queryOne<{ total_points: string; total_spent: string; order_count: number }>(client, `
      SELECT
        COALESCE(SUM(lr.points_earned - lr.points_redeemed), 0)::numeric AS total_points,
        COALESCE(cp.total_spent, 0)::numeric AS total_spent,
        COALESCE(cp.order_count, 0) AS order_count
      FROM ai_module.customer_profiles cp
      LEFT JOIN ai_module.loyalty_records lr ON lr.customer_id = cp.customer_id AND lr.merchant_id = cp.merchant_id
      WHERE ${conditions.join(" AND ")}
      GROUP BY cp.total_spent, cp.order_count
    `, params);
    if (!profile) throw new PlatformError("resource_not_found", "Customer not found", 404);

    const tiers = await getLoyaltyTiersForClient(client, merchantId);
    const points = Number(profile.total_points);
    const tier = evaluateTier(points, tiers);
    const history = await client.query(`
      SELECT
        points_earned AS "pointsEarned",
        points_redeemed AS "pointsRedeemed",
        description,
        tier_at_time AS "tierAtTime",
        created_at AS "createdAt"
      FROM ai_module.loyalty_records
      WHERE customer_id = $1 AND merchant_id = $2
      ORDER BY created_at DESC
    `, params);
    return { data: { points, tier, nextTierPoints: pointsToNextTier(points, tiers), history: history.rows } };
  });
}

export async function getLoyaltyTiersForClient(client: PoolClient, merchantId: string) {
  if (!merchantId) throw new PlatformError("scope_required", "Loyalty tiers require a merchant scope", 409);
  const result = await client.query(
    "SELECT name, points_threshold AS \"pointsThreshold\", discount_percent AS \"discountPercent\" FROM ai_module.loyalty_tiers WHERE merchant_id = $1 ORDER BY points_threshold ASC",
    [merchantId],
  );
  return result.rows.map((row) => ({ name: row.name, pointsThreshold: Number(row.pointsThreshold), discountPercent: Number(row.discountPercent) }));
}

export async function listLoyaltyTiers(merchantId: string) {
  return withClient(async (client) => ({ data: await getLoyaltyTiersForClient(client, merchantId) }));
}

async function getCustomerMutationTargetForClient(client: PoolClient, customerId: string): Promise<{ merchantId: string; storeId: null }> {
  const customer = await queryOne<{ merchant_id: string | null }>(client, `
    SELECT merchant_id
    FROM public.customer
    WHERE id = $1 AND deleted_at IS NULL
  `, [customerId]);
  if (!customer) throw new PlatformError("resource_not_found", "Customer not found", 404);
  if (!customer.merchant_id) throw new PlatformError("forbidden", "Customer has no merchant scope", 403);
  return { merchantId: customer.merchant_id, storeId: null };
}

export async function getCustomerMutationTarget(customerId: string): Promise<{ merchantId: string; storeId: null }> {
  return withClient((client) => getCustomerMutationTargetForClient(client, customerId));
}

export async function mergeCustomers(
  headers: HeadersLike,
  body: { primaryId?: string; duplicateId?: string },
  actor: OperatorContext,
  scope: MerchantTargetScope,
) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId: scope.merchantId });
    const result = await withScopedIdempotency(client, headers, body, scope.merchantId, CUST_OPS.mergeCustomers, async () => {
      if (!body.primaryId || !body.duplicateId || body.primaryId === body.duplicateId) {
        throw new PlatformError("validation_error", "primaryId and duplicateId are required", 400);
      }
      const primary = await queryOne<{ id: string; phone: string; merchant_id: string | null }>(client, "SELECT id, phone, merchant_id FROM public.customer WHERE id = $1 AND deleted_at IS NULL", [body.primaryId]);
      const duplicate = await queryOne<{ id: string; phone: string; merchant_id: string | null }>(client, "SELECT id, phone, merchant_id FROM public.customer WHERE id = $1 AND deleted_at IS NULL", [body.duplicateId]);
      if (!primary || !duplicate) throw new PlatformError("resource_not_found", "Customer not found", 404);
      assertMerchantMutationTarget(scope, { merchantId: primary.merchant_id }, "Primary customer");
      assertMerchantMutationTarget(scope, { merchantId: duplicate.merchant_id }, "Duplicate customer");
      if (primary.merchant_id !== duplicate.merchant_id) {
        throw new PlatformError("forbidden", "Customers from different merchants cannot be merged", 403);
      }

      await client.query("UPDATE public.\"order\" SET customer_id = $1 WHERE customer_id = $2 AND merchant_id = $3", [body.primaryId, body.duplicateId, scope.merchantId]);
      await client.query("UPDATE ai_module.loyalty_records SET customer_id = $1 WHERE customer_id = $2 AND merchant_id = $3", [body.primaryId, body.duplicateId, scope.merchantId]);
      await client.query(`
        INSERT INTO ai_module.customer_profiles (customer_id, phone, total_spent, order_count, merchant_id)
        VALUES ($1, $2, 0, 0, $3)
        ON CONFLICT (customer_id) DO NOTHING
      `, [body.primaryId, primary.phone, scope.merchantId]);
      await client.query(`
        UPDATE ai_module.customer_profiles p
        SET total_spent = p.total_spent + COALESCE(d.total_spent, 0),
            order_count = p.order_count + COALESCE(d.order_count, 0),
            updated_at = now()
        FROM ai_module.customer_profiles d
        WHERE p.customer_id = $1 AND d.customer_id = $2 AND p.merchant_id = $3 AND d.merchant_id = $3
      `, [body.primaryId, body.duplicateId, scope.merchantId]);
      const merged = await client.query<{ deleted_at: Date | string }>("UPDATE public.customer SET deleted_at = now(), updated_at = now() WHERE id = $1 AND merchant_id = $2 RETURNING deleted_at", [body.duplicateId, scope.merchantId]);
      await client.query("DELETE FROM ai_module.customer_profiles WHERE customer_id = $1 AND merchant_id = $2", [body.duplicateId, scope.merchantId]);
      const eventId = await emitExactOutbox(client, buildExactCustomerMergedEvent({
        primaryId: body.primaryId,
        duplicateId: body.duplicateId,
        merchantId: scope.merchantId,
        sourceOccurredAt: merged.rows[0]?.deleted_at,
      }));
      await recordAuditEntry(client, actor, "customer.merged", "customer", body.primaryId, {
        before: duplicate,
        after: { primaryId: body.primaryId },
        correlationId: eventId,
        merchantId: scope.merchantId,
      });
      return { data: { primaryId: body.primaryId, mergedId: body.duplicateId } };
    });
    return result;
  });
}
