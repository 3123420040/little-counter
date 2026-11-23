import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { prepareOrderRecreatePrefill, requireActorPermission, requireOperatingReadScope, resolveChannelActor, type ChannelActor, type OperatorContext } from "@medusa-snus/application";
import { actor, headers, route } from "../../../../lib/route-utils";

function hasChannelHeaders(req: MedusaRequest): boolean {
  const value = req.headers["x-channel"] ?? req.headers["X-Channel"];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

async function readActor(req: MedusaRequest): Promise<ChannelActor | OperatorContext> {
  if (hasChannelHeaders(req)) {
    return resolveChannelActor(headers(req));
  }
  return await actor(req, "manager");
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operator = await readActor(req);
    await requireActorPermission(operator, "orders:read");
    const scope = await requireOperatingReadScope(operator, headers(req));
    const { id } = req.params as { id: string };
    const prefill = await prepareOrderRecreatePrefill(id, scope);
    return { prefill };
  });
}
