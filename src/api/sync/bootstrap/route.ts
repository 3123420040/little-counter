import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { getSyncBootstrap } from "@medusa-snus/application";
import { actor, headers, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operator = await actor(req, "staff");
    return getSyncBootstrap(operator, headers(req));
  });
}
