import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getCustomerLoyalty, getCustomerMutationTarget } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetAccess, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const target = await getCustomerMutationTarget(id);
    const { scope } = await actorWithMerchantTargetAccess(req, permissions.loyaltyRead, target.merchantId);
    return getCustomerLoyalty(id, { merchantId: scope.merchantId });
  });
}
