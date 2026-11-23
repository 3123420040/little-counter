import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getStoreSettingsProfile, getStoreSettingsTarget, updateStoreSettingsProfile, type UpdateStoreProfileInput } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetAccess, actorWithMerchantTargetMutation, body, route } from "../../../../lib/route-utils";

function storeId(req: MedusaRequest): string {
  return String(req.params?.storeId || "");
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const target = await getStoreSettingsTarget(storeId(req));
    const { scope } = await actorWithMerchantTargetAccess(req, permissions.settingsRead, target.merchantId);
    return getStoreSettingsProfile(target.storeId, scope);
  });
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const target = await getStoreSettingsTarget(storeId(req));
    const { actor, scope } = await actorWithMerchantTargetMutation(req, permissions.settingsWrite, target.merchantId);
    return updateStoreSettingsProfile(target.storeId, body<UpdateStoreProfileInput>(req), actor, scope);
  });
}
