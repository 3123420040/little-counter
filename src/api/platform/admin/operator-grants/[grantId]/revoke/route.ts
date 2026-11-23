import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { assertNotReadOnlyImpersonation, revokePlatformOperatorPermission, requireActorPermission } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actor, body, route } from "../../../../../../lib/route-utils";

function grantId(req: MedusaRequest): string {
  return String(req.params?.grantId || "");
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const requestActor = await actor(req, "staff");
    await assertNotReadOnlyImpersonation(requestActor);
    await requireActorPermission(requestActor, permissions.platformMembershipWrite);
    return revokePlatformOperatorPermission(grantId(req), requestActor, body(req));
  });
}
