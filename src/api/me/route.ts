import type { MedusaRequest, MedusaResponse } from "../../lib/http-types";
import { assertNotReadOnlyImpersonation, getSettingsMe, requireActorPermission, updateOwnOperatorProfile } from "@medusa-snus/application";
import { actor, body, headers, route } from "../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operator = await actor(req, "staff");
    return getSettingsMe(operator, headers(req));
  });
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operator = await actor(req, "staff");
    await assertNotReadOnlyImpersonation(operator);
    await requireActorPermission(operator, "profile:write");
    return updateOwnOperatorProfile(operator, body(req));
  });
}
