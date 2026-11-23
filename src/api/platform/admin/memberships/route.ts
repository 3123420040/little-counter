import { grantPlatformMembership, listPlatformMemberships, type PlatformMembershipInput } from "@medusa-snus/application";
import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { actorWithPlatformMutation, actorWithPlatformReadAccess, body, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithPlatformReadAccess(req);
    return listPlatformMemberships(scope);
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor } = await actorWithPlatformMutation(req);
    return grantPlatformMembership(body<PlatformMembershipInput>(req), actor);
  }, 201);
}
