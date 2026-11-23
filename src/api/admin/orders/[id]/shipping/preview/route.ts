import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { assertOperatingMutationTarget, getOrderMutationTarget, previewOrderShippingFee } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, body, route } from "../../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const { actor: operator, scope } = await actorWithOperatingScopeMutation(req, permissions.orderWrite);
    assertOperatingMutationTarget(scope, await getOrderMutationTarget(id), "Order");
    return previewOrderShippingFee(id, body(req), operator, scope);
  });
}
