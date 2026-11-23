import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { checkoutTelegramSalesDraft } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMutationScope, body, headers, route } from "../../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const { actor, scope } = await actorWithMutationScope(req, "staff", permissions.remoteOrderCreate, "checkout");
    const result = await checkoutTelegramSalesDraft(headers(req), id, body(req), actor, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
