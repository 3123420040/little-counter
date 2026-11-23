import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { scanVisionProducts } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, body, headers, route } from "../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor, scope } = await actorWithOperatingScopeMutation(req, permissions.visionScanUse, "ai");
    return scanVisionProducts(body(req), scope, {
      operatorId: actor.operatorId,
      type: "channel" in actor ? actor.channel : "staff",
      role: actor.role,
    }, { providerHeaders: headers(req), allowProviderCandidates: false });
  });
}
