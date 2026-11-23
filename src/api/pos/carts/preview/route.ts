import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { PlatformError, previewSalePaymentFee } from "@medusa-snus/application";
import { actorWithMutationScope, body, rateLimit, route } from "../../../../lib/route-utils";
import { paymentFeeReadHttpContractV1 } from "../../../../lib/payment-fee-http-contract";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "checkout");
    const { scope } = await actorWithMutationScope(req, "staff", "remote_order:create", "checkout");
    if (paymentFeeReadHttpContractV1(req, res) === "legacy") {
      throw new PlatformError("unsupported_contract", "A compatible order financial contract is required for cart preview", 409);
    }
    return previewSalePaymentFee(body(req), scope);
  });
}
