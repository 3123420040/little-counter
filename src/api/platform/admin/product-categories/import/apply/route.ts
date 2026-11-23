import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { applyCategoryImport } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetMutation, body, headers, merchantTargetIdFromHeaders, route } from "../../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const merchantId = merchantTargetIdFromHeaders(req);
    const { actor: requestActor, scope: merchantScope } = await actorWithMerchantTargetMutation(req, permissions.catalogWrite, merchantId);
    const { csv } = body<{ csv: string }>(req);
    if (!csv || typeof csv !== "string") {
      return { statusCode: 400, code: "validation_error", message: "csv field is required" };
    }
    const result = await applyCategoryImport(headers(req), csv, requestActor as any, merchantScope);
    return { data: result };
  }, 201);
}
