import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { createOrderExportCsv } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOrderHistoryScope, csvDownloadRoute, query } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await csvDownloadRoute(res, "orders-export.csv", async () => {
    const { scope } = await actorWithOrderHistoryScope(req, "staff", permissions.ordersExport);
    return createOrderExportCsv(query(req), scope);
  });
}
