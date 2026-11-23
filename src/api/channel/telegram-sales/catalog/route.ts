import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { listTelegramSalesCatalog } from "@medusa-snus/application";
import { headers, query, rateLimit, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "default");
    return listTelegramSalesCatalog(headers(req), query(req));
  });
}
