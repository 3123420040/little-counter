import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import {
  quoteOrderCancellation,
  requireMutationScope,
  resolveChannelActor,
  type ChannelActor,
  type OperatorContext,
} from "@medusa-snus/application";
import { actor, headers, route } from "../../../../../lib/route-utils";

function hasChannelHeaders(req: MedusaRequest): boolean {
  const value = req.headers["x-channel"] ?? req.headers["X-Channel"];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

async function cancellationActor(req: MedusaRequest): Promise<ChannelActor | OperatorContext> {
  if (hasChannelHeaders(req)) return resolveChannelActor(headers(req));
  return actor(req, "staff");
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operator = await cancellationActor(req);
    const scope = await requireMutationScope(operator, headers(req));
    const { id } = req.params as { id: string };
    return quoteOrderCancellation(id, scope, operator);
  });
}
