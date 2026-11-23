import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { cancelPaymentIntent, paymentIntentFinancialResponseV1, requireMutationScope } from "@medusa-snus/application";
import { paymentFeeReadHttpContractV1 } from "../../../../lib/payment-fee-http-contract";
import { actorWithPermission, headers, route } from "../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operator = await actorWithPermission(req, "staff", "payment_intent:resolve", "checkout");
    const scope = await requireMutationScope(operator, headers(req));
    const financialContract = paymentFeeReadHttpContractV1(req, res);
    const result = await cancelPaymentIntent(headers(req), String(req.params?.id || ""), operator, {
      merchantId: scope.merchantId,
      storeId: scope.storeId,
    }, financialContract);
    res.status(result.statusCode);
    return financialContract === "legacy" ? result.response : paymentIntentFinancialResponseV1(result.response);
  });
}
