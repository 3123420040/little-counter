import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { createInventoryAdjustmentExportCsv } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, csvDownloadRoute } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await csvDownloadRoute(res, "inventory-adjustments-export.csv", async () => {
    const { scope } = await actorWithOperatingScopeAccess(req, permissions.inventoryRead);
    return createInventoryAdjustmentExportCsv(scope);
  });
}
