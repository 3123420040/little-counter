import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { getMerchantIdForLegacyOrganization } from "../../../../packages/application/src/services/subscription-service";
import { getBillingOrderReadModels } from "../../../../packages/application/src/services/billing-order-service";
import { actorWithPermission, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const requestActor = await actorWithPermission(req, "owner", "subscription:read");
    const merchantId = await getMerchantIdForLegacyOrganization("organizationId" in requestActor ? requestActor.organizationId : "org_default");
    return getBillingOrderReadModels(merchantId);
  });
}
