import type { MedusaRequest, MedusaResponse } from "../../lib/http-types";
import { createRemoteOrder, listOrders, requireActorPermission, requireChannelPermission, requireMutationScope, requireOperatingReadScope, resolveChannelActor } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithPermission, body, headers, query, rateLimit, route } from "../../lib/route-utils";

function hasChannelHeaders(req: MedusaRequest): boolean {
  const value = req.headers["x-channel"] ?? req.headers["X-Channel"];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    if (hasChannelHeaders(req)) {
      rateLimit(req, "default");
      const operator = await resolveChannelActor(headers(req));
      await requireActorPermission(operator, permissions.ordersRead);
      const scope = await requireOperatingReadScope(operator, headers(req));
      return listOrders({ ...query(req), merchantId: scope.merchantId, storeIds: [scope.storeId] });
    }
    const operator = await actorWithPermission(req, "staff", permissions.ordersRead);
    const resolvedScope = await requireOperatingReadScope(operator, headers(req));
    return listOrders({ ...query(req), merchantId: resolvedScope.merchantId, storeIds: [resolvedScope.storeId] });
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "checkout");
    const operator = await resolveChannelActor(headers(req));
    requireChannelPermission(operator, "remote_order:create");
    const scope = await requireMutationScope(operator, headers(req));
    const result = await createRemoteOrder(headers(req), body(req), operator, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
