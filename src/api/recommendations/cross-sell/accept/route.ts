import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { assertNotReadOnlyImpersonation, recordCrossSellAcceptance, requireActorPermission, requireOperatingScope } from "@medusa-snus/application";
import { actor, body, rateLimit, route } from "../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "default");
    const operator = await actor(req, "staff");
    await assertNotReadOnlyImpersonation(operator);
    await requireActorPermission(operator, "recommendation:read");
    const scope = await requireOperatingScope(operator, req.headers);
    return recordCrossSellAcceptance({
      ...body(req),
      merchantId: scope.merchantId,
      storeId: scope.storeId,
    }, operator);
  });
}
