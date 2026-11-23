import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { createInventoryAdjustmentImportTemplateCsv } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, csvDownloadRoute } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await csvDownloadRoute(res, "inventory-adjustments-import-template.csv", async () => {
    await actorWithOperatingScopeAccess(req, permissions.inventoryRead);
    return createInventoryAdjustmentImportTemplateCsv();
  });
}
