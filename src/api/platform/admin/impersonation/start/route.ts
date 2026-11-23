import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { assertNotReadOnlyImpersonation, requireActorPermission, startReadOnlyImpersonation } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actor, body, route } from "../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const requestActor = await actor(req, "staff");
    await assertNotReadOnlyImpersonation(requestActor);
    await requireActorPermission(requestActor, permissions.platformImpersonationStart);
    return startReadOnlyImpersonation(requestActor, body(req));
  }, 201);
}
