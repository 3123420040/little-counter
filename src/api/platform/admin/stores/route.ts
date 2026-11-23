import { createPlatformStore, listPlatformStores, type CreatePlatformStoreInput } from "@medusa-snus/application";
import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { actorWithPlatformMutation, actorWithPlatformReadAccess, body, query, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithPlatformReadAccess(req);
    return listPlatformStores(scope, query(req).merchantId || undefined,query(req).status||undefined);
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor } = await actorWithPlatformMutation(req);
    return createPlatformStore(body<CreatePlatformStoreInput>(req), actor);
  }, 201);
}
