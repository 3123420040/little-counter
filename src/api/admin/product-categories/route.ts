import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { createProductCategory, listProductCategories } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithCategoryReadAccess, actorWithMerchantTargetMutation, actorWithOperatingScopeMutation, body, headers, merchantTargetIdFromHeaders, query, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const merchantId = merchantTargetIdFromHeaders(req);
    const { scope } = await actorWithCategoryReadAccess(req, merchantId);
    return listProductCategories(scope.merchantId, query(req));
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operating = await actorWithOperatingScopeMutation(req, permissions.catalogWrite);
    const { actor: operator, scope } = await actorWithMerchantTargetMutation(req, permissions.catalogWrite, operating.scope.merchantId);
    const result = await createProductCategory(headers(req), body(req), operator, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
