import { permissions, type PermissionId } from "@medusa-snus/contracts";
import type { MeResponse } from "../api/settings-endpoints";

export interface AppAccessSnapshotV1 {
  operatorId: string;
  merchantId: string;
  storeIds: string[];
  permissionIds: PermissionId[];
  accessEpoch: string;
  permissionVersion?: string;
  sessionVersion?: number;
  capabilityPartition: string;
}

export interface AppAccessSnapshotInputV1 {
  merchantId: string;
  storeIds: string[];
  capabilities: Record<string, string | null | undefined>;
}

export interface ClientOperatingScopeV1 {
  operatingMerchantId: string;
  operatingStoreId: string;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function buildAppAccessSnapshotV1(
  me: MeResponse,
  input: AppAccessSnapshotInputV1,
): AppAccessSnapshotV1 {
  const permissionIds = sortedUnique([...(me.permissionIds || []),
    ...(me.historicalPermissionIds || []).filter(permission =>
      [permissions.ordersRead, permissions.ordersExport, permissions.reportsRead].some(readPermission => readPermission === permission)),
  ]) as PermissionId[];
  const capabilityPartition = Object.entries(input.capabilities)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => `${name}:${version}`)
    .join("|");
  const sessionVersion = me.security?.sessionVersion ?? 0;
  return {
    operatorId: me.operatorId,
    merchantId: input.merchantId,
    storeIds: sortedUnique(input.storeIds),
    permissionIds,
    accessEpoch: `session:${sessionVersion};permissionVersion:${me.permissionVersion || "unverified"};permissions:${permissionIds.join(",")}`,
    permissionVersion: me.permissionVersion,
    sessionVersion,
    capabilityPartition,
  };
}

/** Keep catalog reads bound to the selected operating store, not report scope. */
export function withOperatingScopeAccessSnapshotV1(
  snapshot: AppAccessSnapshotV1,
  scope: ClientOperatingScopeV1,
  accessibleStores: ReadonlyArray<{ merchantId: string; storeId: string }>,
): AppAccessSnapshotV1 | null {
  if (!scope.operatingMerchantId || !scope.operatingStoreId) return null;
  if (!snapshot.permissionVersion || !accessibleStores.some((store) => store.merchantId === scope.operatingMerchantId
    && store.storeId === scope.operatingStoreId)) return null;
  return {
    ...snapshot,
    merchantId: scope.operatingMerchantId,
    storeIds: [scope.operatingStoreId],
  };
}

export function buildPartitionedQueryKeyV1(
  snapshot: AppAccessSnapshotV1,
  resource: string,
  input?: unknown,
): readonly unknown[] {
  return [
    resource,
    `operator:${snapshot.operatorId}`,
    `merchant:${snapshot.merchantId}`,
    `stores:${snapshot.storeIds.join(",")}`,
    `epoch:${snapshot.accessEpoch}`,
    `capabilities:${snapshot.capabilityPartition}`,
    ...(input === undefined ? [] : [input]),
  ];
}

const partitionPrefixes = ["operator:", "merchant:", "stores:", "epoch:", "capabilities:"];

export function isAppAccessPartitionedQueryKeyV1(queryKey: readonly unknown[]): boolean {
  const values = queryKey.filter((value): value is string => typeof value === "string");
  return partitionPrefixes.every((prefix) => values.some((value) => value.startsWith(prefix)));
}

const routePermission: Array<[prefix: string, permission: PermissionId]> = [
  ["/orders", permissions.ordersRead],
  ["/customers", permissions.customerRead],
  ["/accounting", permissions.accountingRead],
];

export function canAccessAppRouteV1(snapshot: AppAccessSnapshotV1, path: string): boolean {
  if (path === "/dashboard" || path.startsWith("/dashboard/")) {
    return snapshot.permissionIds.includes(permissions.reportsRead)
      || snapshot.permissionIds.includes(permissions.dashboardSelfRead);
  }
  const match = routePermission.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  return !match || snapshot.permissionIds.includes(match[1]);
}
