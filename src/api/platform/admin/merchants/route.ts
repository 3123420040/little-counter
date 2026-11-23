import { createPlatformMerchant, listPlatformMerchants } from "@medusa-snus/application";
import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { actorWithPlatformMutation, actorWithPlatformReadAccess, body, headers, query, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithPlatformReadAccess(req);
    return listPlatformMerchants(scope,query(req).status||undefined);
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  await route(res, async () => {
    const { actor } = await actorWithPlatformMutation(req);
    return createPlatformMerchant(body(req), actor, headers(req));
  });
}
