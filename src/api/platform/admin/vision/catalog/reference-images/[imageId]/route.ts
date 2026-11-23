import type { MedusaRequest, MedusaResponse } from "../../../../../../../lib/http-types";
import { updateVisionReferenceImage } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetMutation, body, merchantTargetIdFromHeaders, route } from "../../../../../../../lib/route-utils";

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const merchantId = merchantTargetIdFromHeaders(req);
    const { scope } = await actorWithMerchantTargetMutation(req, permissions.visionCatalogWrite, merchantId);
    return {
      data: await updateVisionReferenceImage({
        ...body(req),
        imageId: String(req.params?.imageId || "").trim(),
        merchantId: scope.merchantId,
      }),
    };
  });
}
