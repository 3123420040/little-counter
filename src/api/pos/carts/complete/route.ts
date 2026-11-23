import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { completeSale, checkoutPaymentFeeResponseV1, recoverPaymentFeeReceiptV1, PlatformError } from "@medusa-snus/application";
import { actorWithMutationScope, body, headers, rateLimit, route } from "../../../../lib/route-utils";
import { assertPaymentFeeWriteHttpContractV1, paymentFeeReadHttpContractV1 } from "../../../../lib/payment-fee-http-contract";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "checkout");
    const { actor: operator, scope } = await actorWithMutationScope(req, "staff", "remote_order:create", "checkout");
    let financialContract;
    try { financialContract = assertPaymentFeeWriteHttpContractV1(req, res, "checkout"); }
    catch (error) {
      if (!(error instanceof PlatformError) || error.code !== "feature_unavailable") throw error;
      const receipt = await recoverPaymentFeeReceiptV1("checkout", headers(req), body(req), operator, scope);
      paymentFeeReadHttpContractV1(req, res);
      res.status(200);
      return receipt;
    }
    const result = await completeSale(headers(req), body(req), operator, scope);
    res.status(result.statusCode);
    return financialContract === "legacy" ? result.response : checkoutPaymentFeeResponseV1(result.response);
  });
}
