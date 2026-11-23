import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { PlatformError, requireOperatingReadScope, assertOperatingMutationTarget, getOrder, getOrderMutationTarget, updateOrder } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, actorWithOrderHistoryScope, body, headers, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const { actor: operator, scope } = await actorWithOrderHistoryScope(req, "staff", permissions.ordersRead);
    let cancellationContext;
    try {
      cancellationContext = { actor: operator, scope: await requireOperatingReadScope(operator, headers(req)) };
    } catch (error) {
      if (!(error instanceof PlatformError) || !["scope_required", "forbidden", "resource_not_found"].includes(error.code)) throw error;
    }
    return getOrder(id, { merchantId: scope.merchantId, storeIds: scope.storeIds }, cancellationContext);
  });
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const { actor: operator, scope } = await actorWithOperatingScopeMutation(req, permissions.orderWrite);
    assertOperatingMutationTarget(scope, await getOrderMutationTarget(id), "Order");
    const result = await updateOrder(headers(req), id, body(req), operator, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
