import { randomUUID } from "node:crypto";
import { permissions } from "@medusa-snus/contracts";
import { executePartnerControl, readPartnerControl } from "@medusa-snus/application/partner-control";
import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { actorWithMerchantTargetAccess, actorWithMerchantTargetMutation, route } from "../../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const requestId = `req_${randomUUID()}`;
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("Cache-Control", "no-store");
  await route(res, async () => {
    const { actor, scope } = await actorWithMerchantTargetAccess(req, permissions.partnerManage, String(req.params?.merchantId || ""));
    return { data: { ...await readPartnerControl(actor, scope, req.query), request_id: requestId } };
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const requestId = `req_${randomUUID()}`;
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("Cache-Control", "no-store");
  await route(res, async () => {
    const { actor, scope } = await actorWithMerchantTargetMutation(req, permissions.partnerManage, String(req.params?.merchantId || ""));
    return { data: await executePartnerControl(actor, scope, req.body, requestId) };
  });
}
