import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getProduct, getProductMutationTarget, updateProduct, PlatformError } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetMutation, actorWithMerchantTargetAccess, actorWithOperatingScopeAccess, actorWithOperatingScopeMutation, body, headers, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const target = await getProductMutationTarget(id);
    const { scope } = await actorWithMerchantTargetAccess(req, permissions.catalogRead, target.merchantId);
    const operating = req.headers["x-operating-store-id"] || req.headers["X-Operating-Store-Id"]
      ? await actorWithOperatingScopeAccess(req, permissions.catalogRead)
      : null;
    if (operating && operating.scope.merchantId !== scope.merchantId) {
      throw new PlatformError("forbidden", "Product merchant does not match the selected store", 403);
    }
    return getProduct(id, { merchantId: scope.merchantId, stockLocationId: operating?.scope.stockLocationId });
  });
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const target = await getProductMutationTarget(id);
    const { actor: operator, scope } = await actorWithMerchantTargetMutation(req, permissions.catalogWrite, target.merchantId);
    const operating = req.headers["x-operating-store-id"] || req.headers["X-Operating-Store-Id"]
      ? await actorWithOperatingScopeMutation(req, permissions.catalogWrite)
      : null;
    const result = await updateProduct(headers(req), id, body(req), operator, scope, operating?.scope);
    res.status(result.statusCode);
    return result.response;
  });
}
