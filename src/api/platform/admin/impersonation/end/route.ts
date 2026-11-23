import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { endReadOnlyImpersonation } from "@medusa-snus/application";
import { actor, body, route } from "../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const requestActor = await actor(req, "staff");
    return endReadOnlyImpersonation(requestActor, body(req));
  });
}
