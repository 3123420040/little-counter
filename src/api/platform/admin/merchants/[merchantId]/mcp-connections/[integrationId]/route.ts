import { getPlatformMcpConnection } from "@medusa-snus/application";
import type { MedusaRequest, MedusaResponse } from "../../../../../../../lib/http-types";
import { actorWithPlatformReadAccess, query, route } from "../../../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  await route(res, async () => {
    const { actor } = await actorWithPlatformReadAccess(req);
    return getPlatformMcpConnection(actor, String(req.params?.merchantId || ""), String(req.params?.integrationId || ""), query(req));
  });
}
