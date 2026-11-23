import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { createVisionReferenceImage, listVisionReferenceImagesForProvider } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetAccess, actorWithMerchantTargetMutation, body, merchantTargetIdFromHeaders, query, route } from "../../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const merchantId = merchantTargetIdFromHeaders(req);
    const { scope } = await actorWithMerchantTargetAccess(req, permissions.visionCatalogWrite, merchantId);
    const filters = query(req);
    return {
      data: await listVisionReferenceImagesForProvider({
        ...filters,
        includePending: filters.includePending ?? "true",
        merchantId: scope.merchantId,
      }),
    };
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const merchantId = merchantTargetIdFromHeaders(req);
    const { scope } = await actorWithMerchantTargetMutation(req, permissions.visionCatalogWrite, merchantId);
    return {
      data: await createVisionReferenceImage({
        ...body(req),
        merchantId: scope.merchantId,
      }),
    };
  });
}
