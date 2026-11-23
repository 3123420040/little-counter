import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { createPurchaseOrderDetailExportCsv } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, csvDownloadRoute } from "../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params as { id: string };
  const today = new Date().toISOString().slice(0, 10);
  await csvDownloadRoute(res, `purchase-order-${id}-detail-${today}.csv`, async () => {
    const { scope } = await actorWithOperatingScopeAccess(req, permissions.inventoryRead);
    return createPurchaseOrderDetailExportCsv(id, scope);
  });
}
