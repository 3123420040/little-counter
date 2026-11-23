import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { uploadVisionReferenceImage } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetMutation, body, merchantTargetIdFromHeaders, route } from "../../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const merchantId = merchantTargetIdFromHeaders(req);
    const { scope } = await actorWithMerchantTargetMutation(req, permissions.visionCatalogWrite, merchantId);
    return {
      data: await uploadVisionReferenceImage({
        ...body(req),
        merchantId: scope.merchantId,
      }),
    };
  });
}
