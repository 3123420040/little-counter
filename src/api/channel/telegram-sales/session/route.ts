import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { clearTelegramSalesSession, getTelegramSalesSession, updateTelegramSalesSession, type ChannelSessionInput } from "@medusa-snus/application";
import { body, headers, rateLimit, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "auth");
    return getTelegramSalesSession(headers(req));
  });
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "auth");
    return updateTelegramSalesSession(headers(req), body<ChannelSessionInput>(req));
  });
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "auth");
    return clearTelegramSalesSession(headers(req));
  });
}
