import { permissions, type OperatingScope } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { requireScopedActorPermission, type PermissionActor } from "./permission-service";

export type OrderCancellationAccess = {
  allowed: boolean;
  mode: "full" | "own" | null;
  reasonCode: string | null;
};

export function isTrustedOwnOrderCreator(events: Array<{
  actor_id: string; actor_type: string; merchant_id: string | null; store_id: string | null;
}>, operatorId: string, scope: OperatingScope): boolean {
  return events.length === 1 && events[0]!.actor_id === operatorId
    && ["staff", "manager", "owner", "accountant"].includes(events[0]!.actor_type)
    && events[0]!.merchant_id === scope.merchantId && events[0]!.store_id === scope.storeId;
}

export async function orderCancellationAccessForClient(
  client: PoolClient, orderId: string, actor: PermissionActor, scope: OperatingScope,
): Promise<OrderCancellationAccess> {
  if ("impersonationMode" in actor && actor.impersonationMode === "read_only") {
    return { allowed: false, mode: null, reasonCode: "impersonation_read_only" };
  }
  const target = { scopeType: "store" as const, merchantId: scope.merchantId, storeId: scope.storeId };
  if (actor.role === "manager" || actor.role === "owner") {
    try {
      await requireScopedActorPermission(actor, permissions.orderCancel, target);
      return { allowed: true, mode: "full", reasonCode: null };
    } catch (error) {
      if (!(error instanceof PlatformError) || error.code !== "forbidden") throw error;
    }
  }
  try {
    await requireScopedActorPermission(actor, permissions.orderCancelOwn, target);
  } catch (error) {
    if (!(error instanceof PlatformError) || error.code !== "forbidden") throw error;
    return { allowed: false, mode: null, reasonCode: "forbidden" };
  }
  const events = await client.query<{
    actor_id: string; actor_type: string; merchant_id: string | null; store_id: string | null;
  }>(`SELECT actor_id, actor_type, merchant_id, store_id FROM audit.events
    WHERE subject_type = 'order' AND subject_id = $1
      AND action IN ('order.created', 'order.remote_created', 'order.partner_created') LIMIT 2`, [orderId]);
  if (isTrustedOwnOrderCreator(events.rows, actor.operatorId, scope)) return { allowed: true, mode: "own", reasonCode: null };
  const unavailable = events.rows.length !== 1 || (events.rows[0]!.actor_id === actor.operatorId
    && (!events.rows[0]!.merchant_id || !events.rows[0]!.store_id));
  return { allowed: false, mode: null, reasonCode: unavailable ? "order_creator_provenance_unavailable" : "order_not_owned" };
}

export async function requireOrderCancellationAccessForClient(
  client: PoolClient, orderId: string, actor: PermissionActor, scope: OperatingScope,
) {
  const access = await orderCancellationAccessForClient(client, orderId, actor, scope);
  if (!access.allowed) throw new PlatformError(access.reasonCode || "forbidden", "Order cancellation is not permitted", 403);
  return access;
}
