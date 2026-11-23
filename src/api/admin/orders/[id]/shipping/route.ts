import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { assertOperatingMutationTarget, getOrderMutationTarget, updateOrderShippingFee } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, body, headers, route } from "../../../../../lib/route-utils";

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const { actor: operator, scope } = await actorWithOperatingScopeMutation(req, permissions.orderWrite);
    assertOperatingMutationTarget(scope, await getOrderMutationTarget(id), "Order");
    const result = await updateOrderShippingFee(headers(req), id, body(req), operator, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
