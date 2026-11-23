import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { resolveProductScan } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, body, route } from "../../../../lib/route-utils";

type ScanBody = { code?: string; context?: string };

function permissionForContext(context: string | undefined) {
  return context === "inventory_check" ? permissions.inventoryRead : permissions.catalogRead;
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const input = body<ScanBody>(req);
    const { actor, scope } = await actorWithOperatingScopeMutation(req, permissionForContext(input.context));
    return resolveProductScan(input, scope, {
      operatorId: actor.operatorId,
      type: "channel" in actor ? actor.channel : "staff",
      role: actor.role,
    });
  });
}
