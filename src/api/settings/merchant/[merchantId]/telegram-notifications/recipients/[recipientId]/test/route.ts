import type { MedusaRequest, MedusaResponse } from "../../../../../../../../lib/http-types";
import { sendTelegramNotificationRecipientTest } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetMutation, route } from "../../../../../../../../lib/route-utils";

function merchantId(req: MedusaRequest): string {
  return String(req.params?.merchantId || "");
}

function recipientId(req: MedusaRequest): string {
  return String(req.params?.recipientId || "");
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const target = merchantId(req);
    const { actor, scope } = await actorWithMerchantTargetMutation(req, permissions.settingsWrite, target);
    return sendTelegramNotificationRecipientTest(target, recipientId(req), actor, scope);
  }, 202);
}
