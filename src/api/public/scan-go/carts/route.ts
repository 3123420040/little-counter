import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { createScanGoCart } from "@medusa-snus/application";
import { body, rateLimit, route } from "../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "checkout");
    return createScanGoCart(body(req));
  }, 201);
}
