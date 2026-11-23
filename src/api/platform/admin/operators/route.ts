import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { listPlatformOperators } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithScopedPlatformPermissionAccess, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    await actorWithScopedPlatformPermissionAccess(req, permissions.platformOperatorRead);
    return listPlatformOperators();
  });
}
