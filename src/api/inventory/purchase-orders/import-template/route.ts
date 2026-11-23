import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { createPurchaseOrderImportTemplateCsv } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, csvDownloadRoute } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await csvDownloadRoute(res, "purchase-orders-import-template.csv", async () => {
    await actorWithOperatingScopeAccess(req, permissions.inventoryRead);
    return createPurchaseOrderImportTemplateCsv();
  });
}
