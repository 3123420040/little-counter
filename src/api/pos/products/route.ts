import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { listProducts } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, query, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithOperatingScopeAccess(req, permissions.catalogRead);
    return {
      data: await listProducts({
        ...query(req),
        merchantId: scope.merchantId,
        stockLocationId: scope.stockLocationId,
      }),
    };
  });
}
