import {
  EffectiveOrderRecreatePrefillV2Schema,
  EffectiveOrderRecreatePrefillV3Schema, type EffectiveOrderRecreatePrefillV3,
  type EffectiveOrderRecreatePrefillV1,
  type EffectiveOrderRecreatePrefillV2,
} from "@medusa-snus/contracts";
import type { OrderRecreatePrefill } from "../api/endpoints";

export function adaptEffectiveOrderRecreatePrefillV1(
  input: EffectiveOrderRecreatePrefillV1,
): OrderRecreatePrefill {
  const divisor = 10 ** input.minorUnitExponent;
  return {
    sourceOrderId: input.sourceOrder.orderId,
    sourceOrderNumber: input.sourceOrder.orderNumber,
    customerAttribution: "unknown",
    customer: null,
    items: input.items.map((item) => {
      if (item.mapping.status === "available") {
        return {
          variantId: item.mapping.variantId,
          productId: item.mapping.productId,
          productName: item.mapping.currentTitle,
          sku: item.mapping.currentSku,
          quantity: item.requestedQuantity,
          unitPrice: item.mapping.currentUnitPriceMinor / divisor,
          stockLevel: item.mapping.stockAvailableQuantity,
          unavailable: false,
          priceChanged: item.mapping.priceChanged,
          originalPrice: item.effectiveUnitPriceMinor / divisor,
          warning: undefined,
        };
      }
      const currentPriceMinor = item.mapping.currentUnitPriceMinor
        ?? item.effectiveUnitPriceMinor;
      return {
        variantId: item.mapping.currentVariantId || item.sourceVariantId || "",
        productId: item.mapping.currentProductId || item.sourceProductId || undefined,
        productName: item.mapping.currentTitle || item.titleSnapshot,
        sku: item.mapping.currentSku || item.skuSnapshot,
        quantity: item.requestedQuantity,
        unitPrice: currentPriceMinor / divisor,
        stockLevel: item.mapping.stockAvailableQuantity || 0,
        unavailable: true,
        priceChanged: currentPriceMinor !== item.effectiveUnitPriceMinor,
        originalPrice: item.effectiveUnitPriceMinor / divisor,
        warning: item.mapping.reasons.join(", "),
      };
    }),
    unavailableCount: input.unavailableCount,
    warningCount: input.warningCount,
  };
}

export function adaptEffectiveOrderRecreatePrefillV2(
  input: EffectiveOrderRecreatePrefillV2,
): OrderRecreatePrefill {
  const parsed = EffectiveOrderRecreatePrefillV2Schema.parse(input);
  return adaptCustomerPrefill(parsed);
}

export function adaptEffectiveOrderRecreatePrefillV3(input: EffectiveOrderRecreatePrefillV3): OrderRecreatePrefill {
  return adaptCustomerPrefill(EffectiveOrderRecreatePrefillV3Schema.parse(input));
}

function adaptCustomerPrefill(parsed: Pick<EffectiveOrderRecreatePrefillV2, "commercialPrefill" | "customerAttribution" | "customer">): OrderRecreatePrefill {
  const commercial = adaptEffectiveOrderRecreatePrefillV1(parsed.commercialPrefill);
  return {
    ...commercial,
    customerAttribution: parsed.customerAttribution,
    customer: parsed.customer ? {
      id: parsed.customer.id,
      phone: parsed.customer.phone || "",
      name: `${parsed.customer.lastName || ""} ${parsed.customer.firstName || ""}`.trim(),
    } : null,
  };
}
