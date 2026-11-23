import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { updateScanGoCart } from "@medusa-snus/application";
import { body, rateLimit, route } from "../../../../../lib/route-utils";

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "checkout");
    const { cartId } = req.params as Record<string, string | undefined>;
    return updateScanGoCart(String(cartId || ""), body(req));
  });
}
