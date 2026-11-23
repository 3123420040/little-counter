import { rotatePlatformMcpKey } from "@medusa-snus/application";
import type { MedusaRequest, MedusaResponse } from "../../../../../../../../../../lib/http-types";
import { actorWithPlatformMutation, body, headers, route } from "../../../../../../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  await route(res, async () => {
    const { actor } = await actorWithPlatformMutation(req);
    return rotatePlatformMcpKey(actor, String(req.params?.merchantId || ""), String(req.params?.integrationId || ""),
      String(req.params?.keyId || ""), body(req), headers(req));
  });
}
