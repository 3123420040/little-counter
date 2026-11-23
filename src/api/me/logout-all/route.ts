import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { assertNotReadOnlyImpersonation, logoutAllOperatorSessions } from "@medusa-snus/application";
import { actor, route } from "../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operator = await actor(req, "staff");
    await assertNotReadOnlyImpersonation(operator);
    return logoutAllOperatorSessions(operator);
  });
}
