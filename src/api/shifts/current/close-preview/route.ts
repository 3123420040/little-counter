import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { previewCloseShift } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, body, route } from "../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithOperatingScopeAccess(req, permissions.shiftClose);
    return previewCloseShift(body(req), scope);
  });
}
