import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { sendReceiptEmail } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, body, headers, route } from "../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    // Receipt email is tenant-owned: require explicit customer:write
    // permission plus a MerchantTargetScope (single merchantId). The
    // underlying service re-checks the order's merchant_id before any
    // external SMTP call.
    const { actor, scope } = await actorWithOperatingScopeMutation(req, permissions.customerWrite);
    const { orderId } = req.params as { orderId: string };
    const result = await sendReceiptEmail(headers(req), orderId, body(req), actor, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
