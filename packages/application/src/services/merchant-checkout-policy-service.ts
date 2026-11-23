import { merchantCheckoutPolicyUpdateSchema, type FoundStockCheckoutPolicy, type PlatformReadScope } from "@medusa-snus/contracts";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { recordAuditEntry, type AuditActor } from "../repositories/audit-repository";

const metadataKey = "foundStockCheckout";
type MerchantRow = { id: string; metadata: Record<string, unknown> | null };

export function describeFoundStockPolicy(metadata: MerchantRow["metadata"]): FoundStockCheckoutPolicy {
  const raw = metadata?.[metadataKey];
  if (raw === undefined) return {
    status: "ok", enabled: true, version: 0, source: "default", updatedAt: null, updatedBy: null,
  };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") === "enabled,updatedAt,updatedBy,version"
      && typeof value.enabled === "boolean" && Number.isSafeInteger(value.version) && Number(value.version) > 0
      && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
      && typeof value.updatedBy === "string" && value.updatedBy.length > 0) {
      return { status: "ok", enabled: value.enabled, version: Number(value.version), source: "configured",
        updatedAt: value.updatedAt, updatedBy: value.updatedBy };
    }
  }
  return { status: "invalid", enabled: false, version: 0, source: "configured", updatedAt: null, updatedBy: null };
}

async function merchantRow(client: PoolClient, merchantId: string, lock: "" | "FOR SHARE" | "FOR UPDATE" = "") {
  const row = await queryOne<MerchantRow>(client, `
    SELECT id, metadata FROM app.merchants WHERE id = $1 AND status = 'active' ${lock}
  `, [merchantId]);
  if (!row) throw new PlatformError("resource_not_found", "Merchant not found", 404);
  return row;
}

export async function readFoundStockPolicyForClient(client: PoolClient, merchantId: string, lock = false) {
  return describeFoundStockPolicy((await merchantRow(client, merchantId, lock ? "FOR SHARE" : "")).metadata);
}

export async function readMerchantCheckoutPolicy(scope: PlatformReadScope, merchantId: string) {
  if (!(scope.merchantIds || []).includes(merchantId)) throw new PlatformError("forbidden", "Merchant is not accessible", 403);
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => ({ data: await readFoundStockPolicyForClient(client, merchantId) }));
}

export async function updateMerchantCheckoutPolicy(merchantId: string, rawInput: unknown, actor: AuditActor) {
  const parsed = merchantCheckoutPolicyUpdateSchema.safeParse(rawInput);
  if (!parsed.success) throw new PlatformError("validation_error", "Invalid merchant checkout policy", 400);
  if (!actor.operatorId) throw new PlatformError("unauthorized", "Authenticated operator required", 401);
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId }, "update");
    const row = await merchantRow(client, merchantId, "FOR UPDATE");
    const before = describeFoundStockPolicy(row.metadata);
    if (before.version !== parsed.data.expectedVersion) {
      throw new PlatformError("policy_version_conflict", "Policy changed; reload and retry", 409);
    }
    const value = { enabled: parsed.data.enabled, version: before.version + 1,
      updatedAt: new Date().toISOString(), updatedBy: actor.operatorId };
    const metadata = { ...row.metadata, [metadataKey]: value };
    await client.query("UPDATE app.merchants SET metadata = $2::jsonb, updated_at = now() WHERE id = $1",
      [merchantId, JSON.stringify(metadata)]);
    const after = describeFoundStockPolicy(metadata);
    await recordAuditEntry(client, actor, "merchant.checkout_policy.updated", "merchant", merchantId,
      { before, after, merchantId });
    return { data: after };
  });
}
