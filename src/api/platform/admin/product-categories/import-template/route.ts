import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { createCategoryImportTemplateCsv } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetAccess, csvDownloadRoute, merchantTargetIdFromHeaders } from "../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await csvDownloadRoute(res, "product-categories-import-template.csv", async () => {
    const merchantId = merchantTargetIdFromHeaders(req);
    await actorWithMerchantTargetAccess(req, permissions.catalogRead, merchantId);
    return createCategoryImportTemplateCsv();
  });
}
