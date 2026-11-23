import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { listStockMovements } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, query, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithOperatingScopeAccess(req, permissions.inventoryRead);
    return listStockMovements(scope, query(req));
  });
}
