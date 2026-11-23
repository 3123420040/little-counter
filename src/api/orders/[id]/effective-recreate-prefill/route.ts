import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getEffectiveOrderFeatureRecreateV1 } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithOperatingScopeAccess(req, permissions.ordersRead);
    const { id } = req.params as { id: string };
    return { prefill: await getEffectiveOrderFeatureRecreateV1({ scope, orderId: id }) };
  });
}
