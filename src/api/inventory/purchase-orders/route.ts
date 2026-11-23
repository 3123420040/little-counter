import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { createPurchaseOrder, listPurchaseOrders } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, actorWithOperatingScopeMutation, body, headers, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithOperatingScopeAccess(req, permissions.inventoryRead);
    return listPurchaseOrders(scope);
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor: operator, scope } = await actorWithOperatingScopeMutation(req, permissions.inventoryWrite);
    const result = await createPurchaseOrder(headers(req), body(req), operator, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
