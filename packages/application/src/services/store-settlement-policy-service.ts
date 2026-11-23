import { readManualBankConfirmationRuntimeConfigV1 } from "./manual-bank-confirmation-service";
import { readFoundStockPolicyForClient } from "./merchant-checkout-policy-service";
import {
  BANK_TRANSFER_SETTLEMENT_ACKNOWLEDGMENT_VERSION,
  STORE_BANK_SETTLEMENT_POLICY_METADATA_KEY,
  bankTransferSettlementModes,
  type BankTransferSettlementMode,
  type CheckoutBankSettlementPolicyResponse,
  type MerchantTargetScope,
  type StoreBankSettlementPolicyValue,
} from "@medusa-snus/contracts";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import { PlatformError } from "../errors/platform-error";
import { recordAuditEntry } from "../repositories/audit-repository";

/**
 * Store-scoped bank-transfer settlement policy (2.1).
 *
 * The policy is a server-controlled, versioned value persisted under a
 * dedicated namespace of app.stores.metadata. A missing namespace means
 * `manual_confirmation` (the pre-2.1 behavior); a malformed namespace is a
 * hard error so a broken store can never silently promote payments to
 * posted. Checkout payloads never supply the mode — only the server reads
 * this value inside the checkout decision.
 */

export interface StoreSettlementPolicySnapshot {
  mode: BankTransferSettlementMode;
  version: number;
  source: "configured" | "default";
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface UpdateStoreSettlementPolicyInput {
  mode: BankTransferSettlementMode;
  /** Compare-and-swap guard: must equal the currently stored version. */
  expectedVersion: number;
}

type PolicyActor = {
  operatorId: string;
  role?: string;
  organizationId?: string;
};

type StoreMetadataRow = {
  id: string;
  merchant_id: string;
  metadata: Record<string, unknown> | string | null;
};

export class StoreSettlementPolicyErrorV1 extends PlatformError {
  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(code, message, status, details);
    this.name = "StoreSettlementPolicyErrorV1";
  }
}

function storedMetadata(value: StoreMetadataRow["metadata"]): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value;
}

function parsePolicyValue(raw: unknown): StoreBankSettlementPolicyValue | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const source = raw as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  const expected = ["mode", "updatedAt", "updatedBy", "version"].join(",");
  if (keys.join(",") !== expected) return "invalid";
  if (!bankTransferSettlementModes.includes(source.mode as BankTransferSettlementMode)) {
    return "invalid";
  }
  if (!Number.isSafeInteger(source.version) || (source.version as number) < 1) {
    return "invalid";
  }
  if (typeof source.updatedAt !== "string" || !source.updatedAt) return "invalid";
  if (typeof source.updatedBy !== "string" || !source.updatedBy) return "invalid";
  return {
    mode: source.mode as BankTransferSettlementMode,
    version: source.version as number,
    updatedAt: source.updatedAt,
    updatedBy: source.updatedBy,
  };
}

export function resolveStoreSettlementPolicyFromMetadata(
  metadata: Record<string, unknown> | string | null,
): StoreSettlementPolicySnapshot {
  const described = describeStoreSettlementPolicyFromMetadata(metadata);
  if (described.status === "invalid") {
    throw new StoreSettlementPolicyErrorV1(
      "store_settlement_policy_invalid",
      "Store bank settlement policy is malformed and must be repaired before checkout",
      500,
      { metadataKey: STORE_BANK_SETTLEMENT_POLICY_METADATA_KEY },
    );
  }
  const { status: _status, ...snapshot } = described;
  return snapshot;
}

/**
 * Non-throwing description used by settings reads, where a malformed value
 * must be surfaced to the owner for repair instead of failing the whole
 * store list.
 */
export function describeStoreSettlementPolicyFromMetadata(
  metadata: Record<string, unknown> | string | null,
):
  | ({ status: "ok" } & StoreSettlementPolicySnapshot)
  | { status: "invalid" } {
  const rawNamespace = storedMetadata(metadata)[STORE_BANK_SETTLEMENT_POLICY_METADATA_KEY];
  const parsed = parsePolicyValue(rawNamespace);
  if (parsed === "invalid") {
    return { status: "invalid" };
  }
  if (parsed === null) {
    return {
      status: "ok",
      mode: "manual_confirmation",
      version: 0,
      source: "default",
      updatedAt: null,
      updatedBy: null,
    };
  }
  return {
    status: "ok",
    mode: parsed.mode,
    version: parsed.version,
    source: "configured",
    updatedAt: parsed.updatedAt,
    updatedBy: parsed.updatedBy,
  };
}

async function storeMetadataRow(
  client: PoolClient,
  storeId: string,
  lock = false,
): Promise<StoreMetadataRow> {
  const row = await queryOne<StoreMetadataRow>(client, `
    SELECT id, merchant_id, metadata
    FROM app.stores
    WHERE id = $1 AND status = 'active'
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
  `, [storeId]);
  if (!row) {
    throw new StoreSettlementPolicyErrorV1(
      "resource_not_found",
      "Store settlement policy target not found",
      404,
      { storeId },
    );
  }
  return row;
}

function ensureScope(scope: MerchantTargetScope, merchantId: string): void {
  if (scope.merchantId !== merchantId) {
    throw new StoreSettlementPolicyErrorV1(
      "forbidden",
      "Merchant target is not accessible",
      403,
      { merchantId },
    );
  }
}

/** Read the effective settlement policy for one store (public settings read). */
export async function readStoreSettlementPolicy(
  storeId: string,
  scope: MerchantTargetScope,
): Promise<{ data: StoreSettlementPolicySnapshot }> {
  ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const row = await storeMetadataRow(client, storeId);
    ensureScope(scope, row.merchant_id);
    return { data: resolveStoreSettlementPolicyFromMetadata(row.metadata) };
  });
}

/** Read the scoped checkout policy used by the POS terminal (checkout read capability). */
export async function readCheckoutSettlementPolicy(
  merchantId: string,
  storeId: string,
): Promise<{ data: CheckoutBankSettlementPolicyResponse }> {
  ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const row = await storeMetadataRow(client, storeId);
    if (row.merchant_id !== merchantId) {
      throw new StoreSettlementPolicyErrorV1(
        "forbidden",
        "Store does not belong to the operating merchant scope",
        403,
        { storeId, merchantId },
      );
    }
    const snapshot = resolveStoreSettlementPolicyFromMetadata(row.metadata);
    return {
      data: {
        merchantId,
        storeId,
        mode: snapshot.mode,
        policyVersion: snapshot.version,
        acknowledgmentVersion: BANK_TRANSFER_SETTLEMENT_ACKNOWLEDGMENT_VERSION,
        source: snapshot.source,
        manualConfirmationEnabled: readManualBankConfirmationRuntimeConfigV1().enabled,
        foundStockCheckout: await readFoundStockPolicyForClient(client, merchantId),
      },
    };
  });
}

/**
 * Resolve the settlement mode for use inside a caller-owned checkout
 * transaction. `client` is the checkout transaction client; the store row is
 * read without an additional lock because the checkout transaction already
 * serializes its own writes, and the policy decision binds the version it
 * read into the resulting payment evidence.
 */
export async function resolveStoreSettlementPolicyForCheckoutV1(
  client: PoolClient,
  merchantId: string,
  storeId: string,
): Promise<StoreSettlementPolicySnapshot> {
  const row = await queryOne<StoreMetadataRow>(client, `
    SELECT id, merchant_id, metadata
    FROM app.stores
    WHERE id = $1 AND merchant_id = $2 AND status = 'active'
    LIMIT 1
    FOR SHARE
  `, [storeId, merchantId]);
  if (!row) {
    throw new StoreSettlementPolicyErrorV1(
      "scope_required",
      "Checkout requires an active store within the operating merchant scope",
      409,
      { storeId, merchantId },
    );
  }
  return resolveStoreSettlementPolicyFromMetadata(row.metadata);
}

/** Update the store settlement policy with compare-and-swap versioning and audit. */
export async function updateStoreSettlementPolicy(
  storeId: string,
  input: UpdateStoreSettlementPolicyInput,
  actor: PolicyActor,
  scope: MerchantTargetScope,
): Promise<{ data: StoreSettlementPolicySnapshot }> {
  ensurePlatformSchema();
  validatePolicyUpdateInput(input, actor);
  return withConnectedTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId }, "update");
    const row = await storeMetadataRow(client, storeId, true);
    ensureScope(scope, row.merchant_id);
    return updateStoreSettlementPolicyWithinClientV1(client, row, input, actor);
  });
}

function validatePolicyUpdateInput(
  input: UpdateStoreSettlementPolicyInput,
  actor: PolicyActor,
): void {
  if (!bankTransferSettlementModes.includes(input.mode)) {
    throw new StoreSettlementPolicyErrorV1(
      "validation_error",
      "Unsupported bank settlement mode",
      400,
      { mode: String(input.mode) },
    );
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new StoreSettlementPolicyErrorV1(
      "validation_error",
      "Expected policy version is invalid",
      400,
    );
  }
  if (!actor?.operatorId) {
    throw new StoreSettlementPolicyErrorV1(
      "validation_error",
      "Policy update requires an authenticated operator",
      401,
    );
  }
}

/**
 * Core CAS policy update for a caller that already holds a locked store row
 * in its own transaction (e.g. the owner settings profile update). The row's
 * metadata is read from the passed snapshot; the update merges only the
 * policy namespace.
 */
export async function updateStoreSettlementPolicyWithinClientV1(
  client: PoolClient,
  lockedRow: { id: string; merchant_id: string; metadata: Record<string, unknown> | string | null },
  input: UpdateStoreSettlementPolicyInput,
  actor: PolicyActor,
): Promise<{ data: StoreSettlementPolicySnapshot }> {
  validatePolicyUpdateInput(input, actor);
  // A malformed stored value has no trustworthy version. Repair is allowed
  // only through expectedVersion 0 (never a valid stored version — configured
  // policies start at 1), so the write stays deliberate while checkout reads
  // stay fail-closed.
  const before = describeStoreSettlementPolicyFromMetadata(lockedRow.metadata);
  const currentVersion = before.status === "ok" ? before.version : 0;
  if (currentVersion !== input.expectedVersion) {
    throw new StoreSettlementPolicyErrorV1(
      "policy_version_conflict",
      "Store settlement policy changed; reload and retry",
      409,
      { expectedVersion: input.expectedVersion, currentVersion: before.status === "ok" ? before.version : null },
    );
  }
  const nextValue: StoreBankSettlementPolicyValue = {
    mode: input.mode,
    version: currentVersion + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: actor.operatorId,
  };
  const metadata = storedMetadata(lockedRow.metadata);
  const updated = await queryOne<StoreMetadataRow>(client, `
    UPDATE app.stores
    SET metadata = $2::jsonb,
        updated_at = now()
    WHERE id = $1
    RETURNING id, merchant_id, metadata
  `, [lockedRow.id, JSON.stringify({
    ...metadata,
    [STORE_BANK_SETTLEMENT_POLICY_METADATA_KEY]: nextValue,
  })]);
  if (!updated) {
    throw new StoreSettlementPolicyErrorV1(
      "settings_update_failed",
      "Store settlement policy update failed",
      500,
      { storeId: lockedRow.id },
    );
  }
  const after = resolveStoreSettlementPolicyFromMetadata(updated.metadata);
  await recordAuditEntry(client, actor, "settings.store.bank_settlement_policy.updated", "store_settings", lockedRow.id, {
    before: before.status === "invalid"
      ? { status: "invalid" }
      : before.source === "configured"
        ? { mode: before.mode, version: before.version }
        : { mode: before.mode, version: before.version, source: "default" },
    after: { mode: after.mode, version: after.version },
    merchantId: lockedRow.merchant_id,
    storeId: lockedRow.id,
  });
  return { data: after };
}
