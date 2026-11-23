import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { redeemScanGoCartForStaff } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, body, route } from "../../../../lib/route-utils";

type RedeemBody = { tokenOrPayload?: string };

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor, scope } = await actorWithOperatingScopeMutation(req, permissions.scanGoRedeem, "checkout");
    return redeemScanGoCartForStaff(body<RedeemBody>(req), scope, actor);
  });
}
