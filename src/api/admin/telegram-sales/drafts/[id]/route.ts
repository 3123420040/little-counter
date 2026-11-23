import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { getTelegramSalesDraft } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithReportScope, route } from "../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const { scope } = await actorWithReportScope(req, "staff", permissions.ordersRead);
    return getTelegramSalesDraft(id, scope);
  });
}
