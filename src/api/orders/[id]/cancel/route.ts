import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { cancelOrder,  requireMutationScope, resolveChannelActor, type ChannelActor, type OperatorContext } from "@medusa-snus/application";
import { actor, body, headers, route } from "../../../../lib/route-utils";

function hasChannelHeaders(req: MedusaRequest): boolean {
  const value = req.headers["x-channel"] ?? req.headers["X-Channel"];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

async function cancelActor(req: MedusaRequest): Promise<ChannelActor | OperatorContext> {
  if (hasChannelHeaders(req)) {
    return resolveChannelActor(headers(req));
  }
  return await actor(req, "staff");
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operator = await cancelActor(req);
    const scope = await requireMutationScope(operator, headers(req));
    const { id } = req.params as { id: string };
    const result = await cancelOrder(headers(req), id, body(req), operator, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
