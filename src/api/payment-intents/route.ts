import type { MedusaRequest, MedusaResponse } from "../../lib/http-types";
import { createPaymentIntent, listPaymentIntents, paymentIntentFinancialResponseV1, paymentIntentFinancialViewV1, PlatformError, recoverPaymentFeeReceiptV1, requireMutationScope, requireReadableReportScope } from "@medusa-snus/application";
import { PaymentIntentFinancialListFiltersV1Schema, PaymentIntentFinancialListResponseV1Schema } from "@medusa-snus/contracts";
import { actorWithPermission, body, headers, query, route } from "../../lib/route-utils";
import { assertPaymentFeeWriteHttpContractV1, paymentFeeReadHttpContractV1 } from "../../lib/payment-fee-http-contract";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operator = await actorWithPermission(req, "staff", "payment_intent:read");
    const scope = await requireReadableReportScope(operator, headers(req));
    const financialContract = paymentFeeReadHttpContractV1(req, res);
    const selected = financialContract === "legacy" ? null : PaymentIntentFinancialListFiltersV1Schema.safeParse(query(req));
    if (selected && !selected.success) throw new PlatformError("validation_error", "Invalid payment intent filters", 400);
    const params = selected?.success ? selected.data : query(req);
    const result = await listPaymentIntents({
      status: params.status as never,
      provider: params.provider as never,
      limit: params.limit ? Number(params.limit) : undefined,
      offset: params.offset ? Number(params.offset) : undefined,
      merchantId: scope.merchantId,
      storeIds: scope.storeIds,
    }, financialContract);
    return financialContract === "legacy" ? result : PaymentIntentFinancialListResponseV1Schema.parse({
      schemaVersion: 1, contractVersion: financialContract, ...result, data: result.data.map(paymentIntentFinancialViewV1),
    });
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operator = await actorWithPermission(req, "staff", "payment_intent:create", "checkout");
    const scope = await requireMutationScope(operator, headers(req));
    let financialContract;
    try { financialContract = assertPaymentFeeWriteHttpContractV1(req, res, "payment_intent"); }
    catch (error) {
      if (!(error instanceof PlatformError) || error.code !== "feature_unavailable") throw error;
      const receipt = await recoverPaymentFeeReceiptV1("payment_intent", headers(req), body(req), operator, scope);
      paymentFeeReadHttpContractV1(req, res);
      res.status(200);
      return receipt;
    }
    const result = await createPaymentIntent(headers(req), body(req), operator, {
      merchantId: scope.merchantId,
      storeId: scope.storeId,
      stockLocationId: scope.stockLocationId,
    });
    res.status(result.statusCode);
    return financialContract === "legacy" ? result.response : paymentIntentFinancialResponseV1(result.response);
  });
}
