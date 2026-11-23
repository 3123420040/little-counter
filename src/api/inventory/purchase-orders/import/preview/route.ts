import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { previewPurchaseOrderImport } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeAccess, body, route } from "../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithOperatingScopeAccess(req, permissions.inventoryWrite);
    const { csv } = body<{ csv: string }>(req);
    if (!csv || typeof csv !== "string") {
      return { statusCode: 400, code: "validation_error", message: "csv field is required" };
    }
    const result = await previewPurchaseOrderImport(csv, scope);
    return { data: result };
  });
}
