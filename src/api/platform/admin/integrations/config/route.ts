import { mutatePlatformIntegrationConfig, type PlatformIntegrationConfigInput } from "@medusa-snus/application";
import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { actorWithPlatformIntegrationConfigMutation, body, route } from "../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor } = await actorWithPlatformIntegrationConfigMutation(req);
    return mutatePlatformIntegrationConfig(body<PlatformIntegrationConfigInput>(req), actor);
  });
}
