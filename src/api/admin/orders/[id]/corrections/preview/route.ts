import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { assertOperatingMutationTarget, getOrderMutationTarget, previewOrderCorrection, orderCorrectionFinancialPreviewV1, readOrderCorrectionFinancialContextV1, PlatformError } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, body, route } from "../../../../../../lib/route-utils";
import { assertPaymentFeeWriteHttpContractV1, paymentFeeReadHttpContractV1 } from "../../../../../../lib/payment-fee-http-contract";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const { scope } = await actorWithOperatingScopeMutation(req, permissions.orderWrite);
    if (paymentFeeReadHttpContractV1(req, res) === "legacy") throw new PlatformError("unsupported_contract", "A financial correction contract is required", 409);
    return readOrderCorrectionFinancialContextV1(id, scope);
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const { actor: operator, scope } = await actorWithOperatingScopeMutation(req, permissions.orderWrite);
    const financialContract = assertPaymentFeeWriteHttpContractV1(req, res, "correction");
    assertOperatingMutationTarget(scope, await getOrderMutationTarget(id), "Order");
    const result = await previewOrderCorrection(id, body(req), operator, scope, financialContract);
    return financialContract === "legacy" ? result : orderCorrectionFinancialPreviewV1(result, id, scope);
  });
}
