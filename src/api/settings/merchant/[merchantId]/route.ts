import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getMerchantSettingsProfile, updateMerchantSettingsProfile, type UpdateMerchantProfileInput } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetAccess, actorWithMerchantTargetMutation, body, route } from "../../../../lib/route-utils";

function merchantId(req: MedusaRequest): string {
  return String(req.params?.merchantId || "");
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const target = merchantId(req);
    const { scope } = await actorWithMerchantTargetAccess(req, permissions.settingsRead, target);
    return getMerchantSettingsProfile(target, scope);
  });
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const target = merchantId(req);
    const { actor, scope } = await actorWithMerchantTargetMutation(req, permissions.settingsWrite, target);
    return updateMerchantSettingsProfile(target, body<UpdateMerchantProfileInput>(req), actor, scope);
  });
}
