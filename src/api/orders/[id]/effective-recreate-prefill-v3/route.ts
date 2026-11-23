import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getEffectiveOrderFeatureRecreateV3 } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Order-Recreate-Contract", "orders.effective-recreate.v3");
  await route(res, async () => {
    const { scope } = await actorWithOperatingScopeAccess(req, permissions.ordersRead);
    const { id } = req.params as { id: string };
    return { prefill: await getEffectiveOrderFeatureRecreateV3({ scope, orderId: id }) };
  });
}
