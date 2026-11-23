import { createHash } from "node:crypto";
import type { OrderPaymentFeeFinancialSnapshotV1 } from "@medusa-snus/contracts";

type PricedLine = { productId: string; variantId: string; quantity: number; unitPrice: number; lineTotal: number };
export function cartPaymentFeeConfirmationV1(scope: { merchantId: string; storeId: string; stockLocationId: string },
  financial: OrderPaymentFeeFinancialSnapshotV1, items: readonly PricedLine[]) {
  return createHash("sha256").update(JSON.stringify({ schemaVersion: 1, purpose: "cart.payment-fee.confirmation.v1",
    merchantId: scope.merchantId, storeId: scope.storeId, stockLocationId: scope.stockLocationId, financial,
    items: items.map(({ productId, variantId, quantity, unitPrice, lineTotal }) => ({ productId, variantId, quantity, unitPrice, lineTotal }))
      .sort((a, b) => a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0),
  })).digest("hex");
}
