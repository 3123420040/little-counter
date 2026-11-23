import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { assertNotReadOnlyImpersonation, resetPlatformOperatorPassword, requireActorPermission } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actor, body, route } from "../../../../../../lib/route-utils";

function operatorId(req: MedusaRequest): string {
  return String(req.params?.operatorId || "");
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const requestActor = await actor(req, "staff");
    await assertNotReadOnlyImpersonation(requestActor);
    await requireActorPermission(requestActor, permissions.platformOperatorResetPassword);
    return resetPlatformOperatorPassword(operatorId(req), requestActor, body(req));
  });
}
