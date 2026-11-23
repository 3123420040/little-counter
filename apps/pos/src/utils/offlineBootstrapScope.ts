import { fetchSyncBootstrap } from "../api/endpoints";
import type { AppAccessSnapshotV1 } from "./appAccessSnapshot";
import { saveBootstrapSnapshot } from "./offlineQueue";

export type AccessibleScopeSnapshot = {
  merchantIds: string[];
  storeIds: string[];
};

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function reconcileAccessibleScope(
  current: AccessibleScopeSnapshot,
  next: AccessibleScopeSnapshot,
): AccessibleScopeSnapshot {
  return sameOrderedValues(current.merchantIds, next.merchantIds)
    && sameOrderedValues(current.storeIds, next.storeIds)
    ? current
    : next;
}
export async function refreshBootstrapSnapshot(access: AppAccessSnapshotV1 | null) {
  if (!access) return;
  try {
    const { data } = await fetchSyncBootstrap();
    await saveBootstrapSnapshot(data, access, data.activeOperatingScope);
  } catch {
    // Cache refresh is best-effort; the successful mutation stays successful.
  }
}
