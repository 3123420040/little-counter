import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { deleteCustomer, getCustomer, getCustomerMutationTarget, updateCustomer } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetAccess, actorWithMerchantTargetMutation, body, headers, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const target = await getCustomerMutationTarget(id);
    const { scope } = await actorWithMerchantTargetAccess(req, permissions.customerRead, target.merchantId);
    return getCustomer(id, { merchantId: scope.merchantId });
  });
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const target = await getCustomerMutationTarget(id);
    const { actor: operator, scope } = await actorWithMerchantTargetMutation(req, permissions.customerWrite, target.merchantId);
    const result = await updateCustomer(headers(req), id, body(req), operator, scope);
    res.status(result.statusCode);
    return result.response;
  });
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const target = await getCustomerMutationTarget(id);
    const { actor: operator, scope } = await actorWithMerchantTargetMutation(req, permissions.customerWrite, target.merchantId);
    const result = await deleteCustomer(headers(req), id, operator, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
