import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { getTelegramNotificationSettings } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetAccess, route } from "../../../../../lib/route-utils";

function merchantId(req: MedusaRequest): string {
  return String(req.params?.merchantId || "");
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const target = merchantId(req);
    const { scope } = await actorWithMerchantTargetAccess(req, permissions.settingsRead, target);
    return getTelegramNotificationSettings(target, scope);
  });
}
