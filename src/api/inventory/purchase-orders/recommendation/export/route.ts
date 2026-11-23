import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { createPurchaseOrderRecommendationCsv } from "@medusa-snus/application";
import { permissions, PurchaseOrderRecommendationParamsSchema, type OperatingScope } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, csvDownloadRoute, query } from "../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const today = new Date().toISOString().slice(0, 10);
  let resolvedScope: OperatingScope | null = null;
  await csvDownloadRoute(res, async () => {
    const { scope } = await actorWithOperatingScopeAccess(req, permissions.inventoryRead);
    resolvedScope = scope;
    return `purchase-order-recommendation-${scope.storeId}-${today}.csv`;
  }, async () => {
    if (!resolvedScope) {
      const { scope } = await actorWithOperatingScopeAccess(req, permissions.inventoryRead);
      resolvedScope = scope;
    }
    const params = PurchaseOrderRecommendationParamsSchema.parse(query(req));
    return createPurchaseOrderRecommendationCsv(resolvedScope, params);
  });
}
