import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { createTelegramNotificationRule } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetMutation, body, route } from "../../../../../../lib/route-utils";

function merchantId(req: MedusaRequest): string {
  return String(req.params?.merchantId || "");
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const target = merchantId(req);
    const { actor, scope } = await actorWithMerchantTargetMutation(req, permissions.settingsWrite, target);
    return createTelegramNotificationRule(target, body(req), actor, scope);
  }, 201);
}
