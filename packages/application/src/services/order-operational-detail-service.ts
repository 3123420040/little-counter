import { OrderOperationalDetailV1Schema, ReportScopeSchema, type ReportScope } from "@medusa-snus/contracts";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 } from "@medusa-snus/contracts/runtime-capabilities";
import { getOrder } from "./order-service";

export async function getOrderOperationalDetailV1(
  orderId: string,
  scope: ReportScope,
  cancellationContext?: Parameters<typeof getOrder>[2],
) {
  const selectedScope = ReportScopeSchema.parse(scope);
  const { order } = await getOrder(orderId, selectedScope, cancellationContext, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
  // Discard the formatter's legacy totals and raw nested metadata at this explicit read boundary.
  return OrderOperationalDetailV1Schema.strip().parse({ ...order, schemaVersion: 1 });
}
