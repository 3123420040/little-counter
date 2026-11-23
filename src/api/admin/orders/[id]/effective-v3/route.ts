import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { getEffectiveOrderFeatureDetailV3 } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOrderHistoryScope, route } from "../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithOrderHistoryScope(req, "staff", permissions.ordersRead);
    const { id } = req.params as { id: string };
    const order = await getEffectiveOrderFeatureDetailV3({ scope, orderId: id });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Order-Detail-Contract", "orders.effective-detail.v3");
    return { order };
  });
}
