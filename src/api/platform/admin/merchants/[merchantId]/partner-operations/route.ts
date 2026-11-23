import { randomUUID } from "node:crypto";
import { permissions } from "@medusa-snus/contracts";
import { readPartnerOperations } from "@medusa-snus/application/partner-operations";
import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { actorWithMerchantTargetAccess, route } from "../../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const requestId = `req_${randomUUID()}`;
  res.setHeader("X-Request-Id", requestId); res.setHeader("Cache-Control", "no-store");
  await route(res, async () => {
    const { actor, scope } = await actorWithMerchantTargetAccess(req, permissions.partnerLogsRead,
      String(req.params?.merchantId ?? ""));
    return readPartnerOperations(actor, scope, req.query, requestId);
  });
}
