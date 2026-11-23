import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { recordVisionScanCorrection } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, body, route } from "../../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const scanId = String(req.params?.scanId || "").trim();
    const { actor, scope } = await actorWithOperatingScopeMutation(req, permissions.visionScanUse, "ai");
    return recordVisionScanCorrection(scanId, body(req), scope, {
      operatorId: actor.operatorId,
      type: "channel" in actor ? actor.channel : "staff",
      role: actor.role,
    });
  });
}
