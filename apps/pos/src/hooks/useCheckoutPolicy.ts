import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BankTransferSettlementMode } from "../api/settings-endpoints";
import { useClientOperatingScope } from "./useProducts";

export function selectFoundStockEnabled(body: unknown): boolean {
  const policy = (body as { data?: { foundStockCheckout?: { status?: unknown; enabled?: unknown } } } | null)?.data?.foundStockCheckout;
  return policy?.status === "ok" && policy.enabled === true;
}

/**
 * Server-resolved bank-transfer settlement policy for the operating store.
 * The POS never trusts a locally stored mode: the cashier UI always binds to
 * this scoped read so a policy change takes effect on the next checkout
 * without redeploying or refreshing cached state.
 */
export interface CheckoutSettlementPolicySnapshot {
  manualConfirmationEnabled: boolean;
  merchantId: string;
  storeId: string;
  mode: BankTransferSettlementMode;
  policyVersion: number;
  acknowledgmentVersion: number;
  source: "configured" | "default";
}

export interface CheckoutPolicySelection {
  manualConfirmationEnabled: boolean;
  status: "pending" | "ready" | "unavailable";
  mode: BankTransferSettlementMode;
  policyVersion: number;
  acknowledgmentVersion: number;
}

const pendingSelection: CheckoutPolicySelection = {
  status: "pending",
  manualConfirmationEnabled: false,
  mode: "manual_confirmation",
  policyVersion: 0,
  acknowledgmentVersion: 0,
};

export function selectCheckoutPolicy(body: unknown): CheckoutPolicySelection {
  const data = (body as { data?: Partial<CheckoutSettlementPolicySnapshot> } | null)?.data;
  if (!data || (data.mode !== "manual_confirmation" && data.mode !== "confirm_on_booking")) {
    return { ...pendingSelection, status: "unavailable" };
  }
  // The checkout attestation binds the exact policy version, so a response
  // without safe-integer versions is a contract violation and reads as
  // unavailable (fail closed to manual) rather than ready-with-zero.
  const policyVersion = data.policyVersion;
  const acknowledgmentVersion = data.acknowledgmentVersion;
  if (
    typeof policyVersion !== "number"
    || typeof acknowledgmentVersion !== "number"
    || !Number.isSafeInteger(policyVersion)
    || !Number.isSafeInteger(acknowledgmentVersion)
    || policyVersion < 0
    || acknowledgmentVersion !== 1
    || (data.mode === "confirm_on_booking" && policyVersion === 0)
    || typeof data.manualConfirmationEnabled !== "boolean"
  ) {
    return { ...pendingSelection, status: "unavailable" };
  }
  return {
    status: "ready",
    manualConfirmationEnabled: data.manualConfirmationEnabled,
    mode: data.mode,
    policyVersion,
    acknowledgmentVersion,
  };
}

/** Fail-closed selection: anything other than a confirmed policy reads as manual. */
export function selectCheckoutPolicyFailClosed(
  queryState: { isPending: boolean; isError: boolean; data: unknown },
): CheckoutPolicySelection {
  if (queryState.isPending) return pendingSelection;
  if (queryState.isError) return { ...pendingSelection, status: "unavailable" };
  return selectCheckoutPolicy(queryState.data);
}

export function useCheckoutPolicy(): CheckoutPolicySelection & {
  foundStockEnabled: boolean;
  refreshFoundStockPolicy: () => Promise<boolean>;
  refreshPolicy: () => Promise<CheckoutPolicySelection>;
} {
  const scope = useClientOperatingScope();
  const hasScope = Boolean(scope.operatingMerchantId && scope.operatingStoreId);

  const query = useQuery({
    queryKey: ["checkoutBankSettlementPolicy", scope.operatingMerchantId, scope.operatingStoreId],
    queryFn: async () => api.get<unknown>("/api/pos/checkout-policy"),
    enabled: hasScope,
    staleTime: 30_000,
    retry: 1,
  });

  return { ...selectCheckoutPolicyFailClosed(query),
    foundStockEnabled: !query.isError && selectFoundStockEnabled(query.data),
    refreshFoundStockPolicy: async () => {
      const current = await query.refetch();
      return !current.isError && selectFoundStockEnabled(current.data);
    },
    refreshPolicy: async () => selectCheckoutPolicyFailClosed(await query.refetch()) };
}
