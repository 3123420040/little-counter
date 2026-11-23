import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { createProduct, listAdminProducts, PlatformError } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetMutation, actorWithOperatingScopeMutation, actorWithOperatingScopeAccess, actorWithMerchantTargetAccess, body, headers, merchantTargetIdFromHeaders, query, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const merchantId = merchantTargetIdFromHeaders(req);
    const { scope } = await actorWithMerchantTargetAccess(req, permissions.catalogRead, merchantId);
    const operating = req.headers["x-operating-store-id"] || req.headers["X-Operating-Store-Id"]
      ? await actorWithOperatingScopeAccess(req, permissions.catalogRead)
      : null;
    if (operating && operating.scope.merchantId !== scope.merchantId) {
      throw new PlatformError("forbidden", "Product merchant does not match the selected store", 403);
    }
    return listAdminProducts({ ...query(req), merchantId: scope.merchantId, stockLocationId: operating?.scope.stockLocationId });
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operating = await actorWithOperatingScopeMutation(req, permissions.catalogWrite);
    const { actor: operator, scope } = await actorWithMerchantTargetMutation(req, permissions.catalogWrite, operating.scope.merchantId);
    const result = await createProduct(headers(req), body(req), operator, scope, operating.scope);
    res.status(result.statusCode);
    return result.response;
  });
}
