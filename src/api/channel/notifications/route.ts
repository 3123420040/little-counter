import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { claimTelegramNotifications } from "@medusa-snus/application";
import { headers, query, rateLimit, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "default");
    return claimTelegramNotifications(headers(req), Number(query(req).limit || 10));
  });
}
