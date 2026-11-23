import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { applyInventoryImport } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, body, headers, route } from "../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor: requestActor, scope } = await actorWithOperatingScopeMutation(req, permissions.inventoryWrite);
    const { csv } = body<{ csv: string }>(req);
    if (!csv || typeof csv !== "string") {
      return { statusCode: 400, code: "validation_error", message: "csv field is required" };
    }
    const result = await applyInventoryImport(headers(req), csv, requestActor as any, scope);
    return { data: result };
  }, 201);
}
