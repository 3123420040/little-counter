import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { refundOrder, requireActorPermission, requireMutationScope, resolveChannelActor, type ChannelActor, type OperatorContext } from "@medusa-snus/application";
import { actor, body, headers, route } from "../../../../lib/route-utils";

function hasChannelHeaders(req: MedusaRequest): boolean {
  const value = req.headers["x-channel"] ?? req.headers["X-Channel"];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

async function refundActor(req: MedusaRequest): Promise<ChannelActor | OperatorContext> {
  if (hasChannelHeaders(req)) {
    return resolveChannelActor(headers(req));
  }
  return await actor(req, "owner");
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operator = await refundActor(req);
    await requireActorPermission(operator, "order:refund");
    // Capture (do not discard) the resolved mutation scope. refundOrder does
    // not restock, but resolving scope ensures the caller is operating in a
    // concrete store before any refund entry is written.
    const scope = await requireMutationScope(operator, headers(req));
    const { id } = req.params as { id: string };
    const result = await refundOrder(headers(req), id, body(req), operator, { merchantId: scope.merchantId, storeId: scope.storeId });
    res.status(result.statusCode);
    return result.response;
  });
}
