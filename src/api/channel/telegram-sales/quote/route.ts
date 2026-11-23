import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { quoteTelegramSalesCart } from "@medusa-snus/application";
import { body, headers, rateLimit, route } from "../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "checkout");
    return quoteTelegramSalesCart(headers(req), body(req));
  });
}
