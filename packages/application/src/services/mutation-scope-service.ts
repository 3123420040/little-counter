import type { MerchantTargetScope, OperatingScope } from "@medusa-snus/contracts";
import { PlatformError } from "../errors/platform-error";

export interface MerchantOwnedTarget {
  merchantId: string | null | undefined;
}

export interface StoreOwnedTarget extends MerchantOwnedTarget {
  storeId: string | null | undefined;
}

function denied(resource: string): never {
  throw new PlatformError("forbidden", `${resource} is outside the authorized mutation scope`, 403);
}

/**
 * Defends merchant-owned commands when they are invoked outside an HTTP route.
 * The route guard proves membership; this assertion proves the loaded target
 * belongs to the target that was authorized.
 */
export function assertMerchantMutationTarget(
  scope: MerchantTargetScope,
  target: MerchantOwnedTarget,
  resource: string,
): void {
  if (!target.merchantId || target.merchantId !== scope.merchantId) denied(resource);
}

/**
 * Defends store-bound commands. A store-agnostic target may be changed only
 * within the selected merchant; a store-bound target must match exactly.
 */
export function assertOperatingMutationTarget(
  scope: OperatingScope,
  target: StoreOwnedTarget,
  resource: string,
): void {
  if (!target.merchantId || target.merchantId !== scope.merchantId) denied(resource);
  if (target.storeId && target.storeId !== scope.storeId) denied(resource);
}
