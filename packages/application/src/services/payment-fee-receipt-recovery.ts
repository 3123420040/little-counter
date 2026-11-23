import { permissions } from "@medusa-snus/contracts";
import { withConnectedClient } from "../db/transaction";
import { readScopedIdempotencyReceipt } from "../db/idempotency";
import { PlatformError } from "../errors/platform-error";
import type { HeadersLike } from "../http/headers";
import type { OperatorContext } from "./auth-service";
import { requireScopedActorPermission } from "./permission-service";
import { ORDER_OPS } from "./order-service";
import { PI_OPS } from "./payment-intent-service";
import { checkoutPaymentFeeResponseV1 } from "./checkout-payment-fee-presentation";
import { paymentIntentFinancialResponseV1 } from "./payment-intent-financial-projection";

/** Called only after strict HTTP input and fresh scoped command authority, when new admission is off. */
export async function recoverPaymentFeeReceiptV1(family: "checkout" | "payment_intent", headers: HeadersLike,
  body: unknown, actor: OperatorContext, scope: { merchantId: string; storeId: string }) {
  await requireScopedActorPermission(actor, family === "checkout" ? permissions.ordersRead : permissions.paymentIntentRead,
    { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
  return withConnectedClient(async client => {
    await client.query("BEGIN READ ONLY");
    try {
      const receipt = await readScopedIdempotencyReceipt<{ data: unknown }>(client, headers, body, scope.merchantId,
        family === "checkout" ? ORDER_OPS.completeSale : PI_OPS.createPaymentIntent);
      if (!receipt) throw new PlatformError("feature_unavailable", "Payment fee writes are not ready and no retained receipt matches this request", 503);
      const response = family === "checkout" ? checkoutPaymentFeeResponseV1(receipt) : paymentIntentFinancialResponseV1(receipt);
      if (response.data.merchantId !== scope.merchantId || response.data.storeId !== scope.storeId) {
        throw new PlatformError("forbidden", "Receipt belongs to another operating store", 403);
      }
      return response;
    } finally { await client.query("ROLLBACK"); }
  });
}
