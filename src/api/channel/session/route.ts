import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { clearChannelSession, getChannelSession, updateChannelSession, type ChannelSessionInput } from "@medusa-snus/application";
import { body, headers, rateLimit, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "auth");
    return getChannelSession(headers(req));
  });
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "auth");
    return updateChannelSession(headers(req), body<ChannelSessionInput>(req));
  });
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "auth");
    return clearChannelSession(headers(req));
  });
}
