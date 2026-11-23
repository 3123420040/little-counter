import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { rejectTelegramSalesDraft } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMutationScope, body, route } from "../../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const { actor, scope } = await actorWithMutationScope(req, "staff", permissions.remoteOrderCreate, "checkout");
    return rejectTelegramSalesDraft(id, body(req), actor, scope);
  });
}
