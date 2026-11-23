import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { getProductTagViewModel } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, route } from "../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const { scope } = await actorWithOperatingScopeAccess(req, permissions.catalogRead);
    return getProductTagViewModel({ productId: id, scope });
  });
}
