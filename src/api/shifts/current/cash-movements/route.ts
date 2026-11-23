import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { recordShiftCashMovement } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, body, headers, route } from "../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor, scope } = await actorWithOperatingScopeMutation(req, permissions.shiftCashAdjust);
    const result = await recordShiftCashMovement(headers(req), body(req), actor, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
