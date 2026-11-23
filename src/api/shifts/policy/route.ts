import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { getShiftPolicy, updateShiftPolicy } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, actorWithOperatingScopeMutation, body, headers, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithOperatingScopeAccess(req, permissions.shiftRead);
    return getShiftPolicy(scope);
  });
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor, scope } = await actorWithOperatingScopeMutation(req, permissions.shiftManage);
    const result = await updateShiftPolicy(headers(req), body(req), actor, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
