import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { PlatformError, closePaymentIntentCreationReceiptV1 } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMutationScope, body, headers, route } from "../../../../lib/route-utils";
import { paymentFeeReadHttpContractV1 } from "../../../../lib/payment-fee-http-contract";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor, scope } = await actorWithMutationScope(req, "staff", permissions.paymentIntentCreate);
    if (paymentFeeReadHttpContractV1(req, res) === "legacy") throw new PlatformError("unsupported_contract", "A compatible financial contract is required for creation receipt closure", 409);
    return closePaymentIntentCreationReceiptV1(headers(req), body(req), actor, scope);
  });
}
