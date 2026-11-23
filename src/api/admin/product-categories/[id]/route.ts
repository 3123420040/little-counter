import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import {
  deleteProductCategory,
  getProductCategory,
  getProductCategoryMutationTarget,
  updateProductCategory,
} from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithCategoryReadAccess, actorWithMerchantTargetMutation, body, headers, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const target = await getProductCategoryMutationTarget(id);
    const { scope } = await actorWithCategoryReadAccess(req, target.merchantId);
    return getProductCategory(id, scope.merchantId);
  });
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const target = await getProductCategoryMutationTarget(id);
    const { actor: operator, scope } = await actorWithMerchantTargetMutation(req, permissions.catalogWrite, target.merchantId);
    const result = await updateProductCategory(headers(req), id, body(req), operator, scope);
    res.status(result.statusCode);
    return result.response;
  });
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const target = await getProductCategoryMutationTarget(id);
    const { actor: operator, scope } = await actorWithMerchantTargetMutation(req, permissions.catalogWrite, target.merchantId);
    const result = await deleteProductCategory(headers(req), id, operator, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
