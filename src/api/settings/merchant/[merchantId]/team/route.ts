import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { createTeamOperator, listTeamMembers } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetAccess, actorWithMerchantTargetMutation, body, route } from "../../../../../lib/route-utils";

function merchantId(req: MedusaRequest): string {
  return String(req.params?.merchantId || "");
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const target = merchantId(req);
    const { actor, scope } = await actorWithMerchantTargetAccess(req, permissions.teamRead, target);
    return listTeamMembers(target, scope, actor);
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const target = merchantId(req);
    const { actor, scope } = await actorWithMerchantTargetMutation(req, permissions.teamWrite, target);
    return createTeamOperator(target, body(req), actor, scope);
  }, 201);
}
