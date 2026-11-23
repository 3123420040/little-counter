import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { listTeamOperatorAudit, requireActorPermission } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actor, route } from "../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const membershipId = String(req.params?.membershipId || "");
    const requestActor = await actor(req, "staff");
    await requireActorPermission(requestActor, permissions.teamRead);
    return listTeamOperatorAudit(membershipId, requestActor);
  });
}
