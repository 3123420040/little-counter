import { revokePlatformMembership, type PlatformMembershipRevokeInput } from "@medusa-snus/application";
import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { actorWithPlatformMutation, body, route } from "../../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor } = await actorWithPlatformMutation(req);
    return revokePlatformMembership(
      String(req.params?.membershipId || ""),
      actor,
      body<PlatformMembershipRevokeInput>(req),
    );
  });
}
