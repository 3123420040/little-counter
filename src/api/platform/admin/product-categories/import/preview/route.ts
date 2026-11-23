import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { previewCategoryImport } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetAccess, body, merchantTargetIdFromHeaders, route } from "../../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const merchantId = merchantTargetIdFromHeaders(req);
    const { scope } = await actorWithMerchantTargetAccess(req, permissions.catalogWrite, merchantId);
    const { csv } = body<{ csv: string }>(req);
    if (!csv || typeof csv !== "string") {
      return { statusCode: 400, code: "validation_error", message: "csv field is required" };
    }
    const result = await previewCategoryImport(csv, scope.merchantId);
    return { data: result };
  });
}
