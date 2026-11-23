import { OrderCorrectionFinancialContextV1Schema, type OperatingScope } from "@medusa-snus/contracts";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 } from "@medusa-snus/contracts/runtime-capabilities";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import { queryOne } from "../db/query";
import { PlatformError } from "../errors/platform-error";
import { readEffectiveOrderCsvProjectionsV5 } from "./effective-order-projection-service";

export async function readOrderCorrectionFinancialContextV1(orderId: string, scope: OperatingScope) {
  await ensurePlatformSchema();
  return withConnectedClient(async client => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const order = await queryOne<{ currency_code: string; status: string; as_of: Date }>(client, `
        SELECT currency_code, status::text, transaction_timestamp() AS as_of FROM public."order"
        WHERE id=$1 AND merchant_id=$2 AND store_id=$3 AND deleted_at IS NULL`, [orderId, scope.merchantId, scope.storeId]);
      if (!order) throw new PlatformError("resource_not_found", "Order not found", 404);
      if (order.currency_code.toUpperCase() !== "VND") throw new PlatformError("unsupported_contract", "Correction fee editing requires a VND order", 409);
      const [projection] = await readEffectiveOrderCsvProjectionsV5(client, { scope: { scopeKind: "report", merchantId: scope.merchantId, storeIds: [scope.storeId] },
        orderIds: [orderId], currencyCode: "VND", asOf: new Date(order.as_of).toISOString() });
      if (!projection) throw new PlatformError("financial_invariant_error", "Correction source is unavailable", 409);
      const effective = projection.effectiveOrder;
      const parsed = OrderCorrectionFinancialContextV1Schema.safeParse({ schemaVersion: 1, contractVersion: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
        data: { merchantId: scope.merchantId, storeId: scope.storeId, orderId, baseRevision: effective.effectiveRevision,
          currencyCode: effective.currencyCode, minorUnitExponent: effective.minorUnitExponent,
          commercialState: order.status === "canceled" ? "cancelled" : effective.commercialState,
          componentVersion: effective.componentVersion, components: effective.components, paymentFee: projection.paymentFee, items: effective.lines } });
      if (!parsed.success) throw new PlatformError("financial_invariant_error", "Order correction context is inconsistent", 409);
      return parsed.data;
    } finally { await client.query("ROLLBACK"); }
  });
}
