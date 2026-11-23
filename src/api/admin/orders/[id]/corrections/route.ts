import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { applyOrderCorrection, assertOperatingMutationTarget, getOrderMutationTarget, orderCorrectionFinancialResponseV1, PlatformError } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, body, headers, route } from "../../../../../lib/route-utils";
import { assertPaymentFeeWriteHttpContractV1 } from "../../../../../lib/payment-fee-http-contract";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const { actor: operator, scope } = await actorWithOperatingScopeMutation(req, permissions.orderWrite);
    const financialContract = assertPaymentFeeWriteHttpContractV1(req, res, "correction");
    const input = body<Parameters<typeof applyOrderCorrection>[2]>(req);
    if (financialContract !== "legacy" && !input.confirmationToken) throw new PlatformError("validation_error", "Confirm a current correction preview before applying", 400);
    assertOperatingMutationTarget(scope, await getOrderMutationTarget(id), "Order");
    const result = await applyOrderCorrection(headers(req), id, input, operator, scope, financialContract);
    res.status(result.statusCode);
    return financialContract === "legacy" ? result.response : orderCorrectionFinancialResponseV1(result.response, id, scope);
  });
}
