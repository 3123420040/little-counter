import { listPlatformAudit } from "@medusa-snus/application";
import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { actorWithPlatformReadAccess, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithPlatformReadAccess(req);
    return listPlatformAudit(scope);
  });
}
