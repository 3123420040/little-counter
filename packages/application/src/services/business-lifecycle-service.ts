import { AuthorizationTargetV1Schema, type AuthorizationTargetV1 } from "@medusa-snus/contracts/authorization-policy";
import type { PoolClient } from "../db/client";
import { queryOne } from "../db/query";
import { PlatformError } from "../errors/platform-error";

type BusinessLifecycleTarget = Exclude<AuthorizationTargetV1, { scopeType: "platform" }>;

export async function lockActivePartnerControlScopeForClient(client: PoolClient, merchantId: string, storeId?: string): Promise<void> {
  await client.query("SAVEPOINT business_lifecycle_guard; RELEASE SAVEPOINT business_lifecycle_guard");
  try {
    await client.query("SELECT integration.lock_active_control_scope($1,$2)", [merchantId, storeId ?? null]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "P0001" && error.message === "Business scope inactive") {
      throw new PlatformError("scope_suspended", "Merchant or store is not active", 403);
    }
    throw error;
  }
}

/** Partner authorization locks precede this guard; no tenant UPDATE grant is needed. */
export async function lockActivePartnerBusinessScopeForClient(client: PoolClient, merchantId: string, storeId: string): Promise<void> {
  await client.query("SAVEPOINT business_lifecycle_guard; RELEASE SAVEPOINT business_lifecycle_guard");
  try {
    await client.query("SELECT integration.lock_active_business_scope($1,$2)", [merchantId, storeId]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "P0001" && error.message === "Business scope inactive") {
      throw new PlatformError("scope_suspended", "Merchant or store is not active", 403);
    }
    throw error;
  }
}

/** Caller owns the transaction; lock parent before store and before business rows. */
export async function lockActiveBusinessScopeForClient(
  client: PoolClient, input: BusinessLifecycleTarget, lockMode: "share" | "update" = "share",
): Promise<void> {
  const parsed = AuthorizationTargetV1Schema.safeParse(input);
  if (!parsed.success || parsed.data.scopeType === "platform") {
    throw new PlatformError("scope_required", "A concrete merchant or store target is required", 409);
  }
  const target = parsed.data;
  // SAVEPOINT fails in autocommit, where a row lock would otherwise expire before the write.
  await client.query("SAVEPOINT business_lifecycle_guard; RELEASE SAVEPOINT business_lifecycle_guard");
  const merchant = await queryOne<{ status: string }>(client,
    `SELECT status FROM app.merchants WHERE id=$1 FOR ${target.scopeType === "merchant" && lockMode === "update" ? "UPDATE" : "SHARE"}`, [target.merchantId]);
  if (!merchant) throw new PlatformError("resource_not_found", "Merchant not found", 404);
  if (merchant.status !== "active") {
    throw new PlatformError("scope_suspended", "Merchant is not active", 403, { merchantId: target.merchantId });
  }
  if (target.scopeType === "store") {
    const store = await queryOne<{ status: string }>(client,
      `SELECT status FROM app.stores WHERE merchant_id=$1 AND id=$2 FOR ${lockMode === "update" ? "UPDATE" : "SHARE"}`, [target.merchantId, target.storeId]);
    if (!store) throw new PlatformError("forbidden", "Store is outside the merchant scope", 403);
    if (store.status !== "active") {
      throw new PlatformError("scope_suspended", "Store is not active", 403,
        { merchantId: target.merchantId, storeId: target.storeId });
    }
  }
}
