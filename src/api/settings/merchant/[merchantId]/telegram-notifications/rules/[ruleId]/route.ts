import type { MedusaRequest, MedusaResponse } from "../../../../../../../lib/http-types";
import { updateTelegramNotificationRule } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetMutation, body, route } from "../../../../../../../lib/route-utils";

function merchantId(req: MedusaRequest): string {
  return String(req.params?.merchantId || "");
}

function ruleId(req: MedusaRequest): string {
  return String(req.params?.ruleId || "");
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const target = merchantId(req);
    const { actor, scope } = await actorWithMerchantTargetMutation(req, permissions.settingsWrite, target);
    return updateTelegramNotificationRule(target, ruleId(req), body(req), actor, scope);
  });
}
