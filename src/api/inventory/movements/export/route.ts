import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { createStockMovementHistoryExportCsv } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, csvDownloadRoute, query } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await csvDownloadRoute(res, "inventory-stock-history-export.csv", async () => {
    const { scope } = await actorWithOperatingScopeAccess(req, permissions.inventoryRead);
    return createStockMovementHistoryExportCsv(scope, query(req));
  });
}
