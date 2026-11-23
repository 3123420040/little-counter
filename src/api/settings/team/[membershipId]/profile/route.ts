import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { assertNotReadOnlyImpersonation, requireActorPermission, updateTeamOperatorProfile } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actor, body, route } from "../../../../../lib/route-utils";

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const membershipId = String(req.params?.membershipId || "");
    const requestActor = await actor(req, "staff");
    await assertNotReadOnlyImpersonation(requestActor);
    await requireActorPermission(requestActor, permissions.teamWrite);
    return updateTeamOperatorProfile(membershipId, requestActor, body(req));
  });
}
