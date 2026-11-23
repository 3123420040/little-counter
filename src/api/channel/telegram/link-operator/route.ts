import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { authenticateChannelServiceHeaders, consumeOwnTelegramLinkToken } from "@medusa-snus/application";
import { body, headers, rateLimit, route } from "../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "default");
    const service = authenticateChannelServiceHeaders(headers(req));
    return consumeOwnTelegramLinkToken(service, body(req));
  });
}
