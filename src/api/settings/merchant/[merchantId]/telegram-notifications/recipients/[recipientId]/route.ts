import type { MedusaRequest, MedusaResponse } from "../../../../../../../lib/http-types";
import { updateTelegramNotificationRecipient } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetMutation, body, route } from "../../../../../../../lib/route-utils";

function merchantId(req: MedusaRequest): string {
  return String(req.params?.merchantId || "");
}

function recipientId(req: MedusaRequest): string {
  return String(req.params?.recipientId || "");
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const target = merchantId(req);
    const { actor, scope } = await actorWithMerchantTargetMutation(req, permissions.settingsWrite, target);
    return updateTelegramNotificationRecipient(target, recipientId(req), body(req), actor, scope);
  });
}
