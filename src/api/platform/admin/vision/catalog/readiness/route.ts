import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { listVisionCatalogReadiness } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetAccess, merchantTargetIdFromHeaders, query, route } from "../../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const merchantId = merchantTargetIdFromHeaders(req);
    const { scope } = await actorWithMerchantTargetAccess(req, permissions.visionScanRead, merchantId);
    return {
      data: await listVisionCatalogReadiness({
        ...query(req),
        merchantId: scope.merchantId,
      }),
    };
  });
}
