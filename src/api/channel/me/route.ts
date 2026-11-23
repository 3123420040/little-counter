import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { getChannelMe } from "@medusa-snus/application";
import { headers, rateLimit, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "auth");
    return getChannelMe(headers(req));
  });
}
