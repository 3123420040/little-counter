import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { resolveScanGoCartForStaff } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, body, route } from "../../../../lib/route-utils";

type ResolveBody = { tokenOrPayload?: string };

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor, scope } = await actorWithOperatingScopeMutation(req, permissions.scanGoRedeem, "checkout");
    return resolveScanGoCartForStaff(body<ResolveBody>(req), scope, actor);
  });
}
