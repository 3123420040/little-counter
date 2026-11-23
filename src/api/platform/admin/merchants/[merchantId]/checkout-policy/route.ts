import { readMerchantCheckoutPolicy, updateMerchantCheckoutPolicy } from "@medusa-snus/application";
import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { actorWithPlatformReadAccess, actorWithPlatformMutation, route } from "../../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithPlatformReadAccess(req);
    return readMerchantCheckoutPolicy(scope, String(req.params?.merchantId || ""));
  });
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor } = await actorWithPlatformMutation(req);
    return updateMerchantCheckoutPolicy(String(req.params?.merchantId || ""), req.body, actor);
  });
}
