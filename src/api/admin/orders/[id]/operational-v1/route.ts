import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { getOrderOperationalDetailV1, PlatformError, requireOperatingReadScope } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOrderHistoryScope, headers, route } from "../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor, scope } = await actorWithOrderHistoryScope(req, "staff", permissions.ordersRead);
    let cancellationContext;
    try {
      cancellationContext = { actor, scope: await requireOperatingReadScope(actor, headers(req)) };
    } catch (error) {
      if (!(error instanceof PlatformError) || !["scope_required", "forbidden", "resource_not_found"].includes(error.code)) throw error;
    }
    const { id } = req.params as { id: string };
    const order = await getOrderOperationalDetailV1(id, scope, cancellationContext);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Order-Detail-Contract", "orders.operational.v1");
    return { order };
  });
}
