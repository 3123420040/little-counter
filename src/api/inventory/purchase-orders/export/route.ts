import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { createPurchaseOrderExportCsv } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, csvDownloadRoute } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await csvDownloadRoute(res, "purchase-orders-export.csv", async () => {
    const { scope } = await actorWithOperatingScopeAccess(req, permissions.inventoryRead);
    return createPurchaseOrderExportCsv(scope);
  });
}
