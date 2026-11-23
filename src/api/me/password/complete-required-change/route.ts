import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { assertNotReadOnlyImpersonation, completeRequiredOperatorPasswordChange, requireActorPermission } from "@medusa-snus/application";
import { actor, body, route } from "../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operator = await actor(req, "staff", { allowPasswordChangeRequired: true });
    await assertNotReadOnlyImpersonation(operator);
    await requireActorPermission(operator, "profile:password_write");
    return completeRequiredOperatorPasswordChange(operator, body(req));
  });
}
