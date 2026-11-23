import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { assertNotReadOnlyImpersonation, enableTeamMembership, requireActorPermission } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actor, route } from "../../../../../lib/route-utils";

function membershipId(req: MedusaRequest): string {
  return String(req.params?.membershipId || "");
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const requestActor = await actor(req, "staff");
    await assertNotReadOnlyImpersonation(requestActor);
    await requireActorPermission(requestActor, permissions.teamWrite);
    return enableTeamMembership(membershipId(req), requestActor);
  });
}
