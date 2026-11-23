import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { listOrders } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOrderHistoryScope, query, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithOrderHistoryScope(req, "staff", permissions.ordersRead);
    return listOrders({ ...query(req), merchantId: scope.merchantId, storeIds: scope.storeIds });
  });
}
