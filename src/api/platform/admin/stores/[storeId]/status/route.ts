import { changePlatformBusinessStatus } from "@medusa-snus/application";
import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { actorWithPlatformMutation, body, headers, route } from "../../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  await route(res, async () => {
    const { actor } = await actorWithPlatformMutation(req);
    const result = await changePlatformBusinessStatus("store", String(req.params?.storeId || ""), body(req), actor, headers(req));
    return { ...result.response, statusCode: result.statusCode };
  });
}
