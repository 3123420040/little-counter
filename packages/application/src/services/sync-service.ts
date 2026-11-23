import { listCustomers, listLoyaltyTiers } from "./customer-service";
import { getPackageEntitlements, resolvePackageEntitlements } from "./feature-entitlement-service";
import {
  getPaymentProviderAvailability,
  resolvePaymentProviderAvailability,
} from "./payment-provider-service";
import { listProducts } from "./product-service";
import { decideScopeCoupledAuthorization } from "./coupled-authorization-policy";
import { resolveScopeBootstrap, type ScopeActor } from "./access-service";
import { permissions, type PermissionId } from "@medusa-snus/contracts";
import type { HeadersLike } from "../http/headers";

function earliestExpiry(values: Array<string | null | undefined>): string | null {
  const timestamps = values
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite);
  return timestamps.length > 0
    ? new Date(Math.min(...timestamps)).toISOString()
    : null;
}

export async function getSyncBootstrap(actor?: ScopeActor, headers?: HeadersLike) {
  const scope = actor ? await resolveScopeBootstrap(actor, headers) : null;

  // Resolve access FIRST. When there is no unambiguous active operating scope
  // the bootstrap returns the scope-selection state only — products/customers
  // are empty so a caller with no resolved scope cannot read any merchant's
  // business data through the bootstrap. Only when an active operating scope
  // exists does the bootstrap return catalog/customer data scoped to that
  // merchant and stock location.
  const activeMerchantId = scope?.activeOperatingScope?.merchantId;
  const activeStoreId = scope?.activeOperatingScope?.storeId;
  const activeStockLocationId = scope?.activeOperatingScope?.stockLocationId;
  const hasScope = Boolean(activeMerchantId);
  const target = activeMerchantId && activeStoreId
    ? { scopeType: "store" as const, merchantId: activeMerchantId, storeId: activeStoreId }
    : null;
  const snapshotAuthorization = target && scope
    ? ([permissions.catalogRead, permissions.customerRead] as PermissionId[]).map(
        (permissionId) => ({
          permissionId,
          decision: decideScopeCoupledAuthorization(scope.access, permissionId, target),
        }),
      )
    : [];
  const snapshotPermissionIds = snapshotAuthorization
    .filter(({ decision }) => decision.allowed)
    .map(({ permissionId }) => permissionId);
  const snapshotAuthorizationExpiresAt = earliestExpiry([
    actor?.sessionExpiresAt,
    ...snapshotAuthorization.map(({ decision }) => {
      const proof = decision.proof;
      if (!proof || !scope) return null;
      if (proof.sourceType === "membership") {
        return (scope.access.memberships as Array<typeof scope.access.memberships[number] & {
          validTo?: string | null;
        }>).find(
          (membership) => membership.membershipId === proof.sourceId,
        )?.validTo;
      }
      return scope.access.explicitPermissions.find(
        (grant) => grant.grantId === proof.sourceId,
      )?.validTo;
    }),
  ]);
  const canReadCatalog = snapshotPermissionIds.includes(permissions.catalogRead);
  const canReadCustomers = snapshotPermissionIds.includes(permissions.customerRead);

  const [products, customers, loyaltyTiers, entitlements, paymentProviders] = await Promise.all([
    hasScope && canReadCatalog
      ? listProducts({ merchantId: activeMerchantId, stockLocationId: activeStockLocationId, limit: 500 })
      : Promise.resolve([]),
    hasScope && canReadCustomers
      ? listCustomers({ merchantId: activeMerchantId })
      : Promise.resolve({ customers: [], count: 0, limit: 100, offset: 0 }),
    hasScope && canReadCustomers
      ? listLoyaltyTiers(activeMerchantId as string)
      : Promise.resolve({ data: [] }),
    activeMerchantId
      ? resolvePackageEntitlements({ merchantId: activeMerchantId }).then(({ packageKey, features }) => ({
          data: { packageKey, features },
        }))
      : Promise.resolve(getPackageEntitlements()),
    activeMerchantId
      ? resolvePaymentProviderAvailability({ merchantId: activeMerchantId, storeId: activeStoreId })
      : Promise.resolve(getPaymentProviderAvailability()),
  ]);
  return {
    data: {
      generatedAt: new Date().toISOString(),
      products,
      customers: customers.customers,
      loyaltyTiers: loyaltyTiers.data,
      entitlements,
      paymentProviders,
      accessibleMerchants: scope?.merchants || [],
      accessibleStores: scope?.stores || [],
      memberships: scope?.access.memberships || [],
      permissionIds: scope?.access.permissionIds || [],
      snapshotPermissionIds,
      snapshotAuthorizationExpiresAt,
      permissionVersion: scope?.permissionVersion || null,
      sessionVersion: actor?.sessionVersion || null,
      operatorId: actor?.operatorId || null,
      activeOperatingScope: scope?.activeOperatingScope || null,
      reportOptions: scope?.reportOptions || [],
      platformReadScope: scope?.platformReadScope || null,
    },
  };
}
