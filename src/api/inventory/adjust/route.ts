import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { adjustStock } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, body, headers, route } from "../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor: operator, scope } = await actorWithOperatingScopeMutation(req, permissions.inventoryWrite);
    const result = await adjustStock(headers(req), body(req), operator, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
