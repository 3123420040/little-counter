import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { createTelegramSalesDraft, listTelegramSalesCustomerDrafts } from "@medusa-snus/application";
import { body, headers, query, rateLimit, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "default");
    return listTelegramSalesCustomerDrafts(headers(req), query(req));
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "checkout");
    const result = await createTelegramSalesDraft(headers(req), body(req));
    res.status(result.statusCode);
    return result.response;
  });
}
