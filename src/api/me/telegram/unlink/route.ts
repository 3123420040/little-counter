import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { assertNotReadOnlyImpersonation, requireActorPermission, unlinkOwnTelegramIdentity } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actor, route } from "../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const requestActor = await actor(req, "staff");
    await assertNotReadOnlyImpersonation(requestActor);
    await requireActorPermission(requestActor, permissions.profileTelegramWrite);
    return unlinkOwnTelegramIdentity(requestActor);
  });
}
