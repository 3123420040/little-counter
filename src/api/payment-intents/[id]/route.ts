import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { getPaymentIntent, paymentIntentFinancialResponseV1, requireReadableReportScope } from "@medusa-snus/application";
import { paymentFeeReadHttpContractV1 } from "../../../lib/payment-fee-http-contract";
import { actorWithPermission, headers, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operator = await actorWithPermission(req, "staff", "payment_intent:read");
    const scope = await requireReadableReportScope(operator, headers(req));
    const financialContract = paymentFeeReadHttpContractV1(req, res);
    const result = await getPaymentIntent(String(req.params?.id || ""), {
      merchantId: scope.merchantId,
      storeIds: scope.storeIds,
    }, financialContract);
    return financialContract === "legacy" ? result : paymentIntentFinancialResponseV1(result);
  });
}
