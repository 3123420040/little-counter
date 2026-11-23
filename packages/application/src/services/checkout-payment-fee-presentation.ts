import { CheckoutPaymentFeeResponseV1Schema } from "@medusa-snus/contracts";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 } from "@medusa-snus/contracts/runtime-capabilities";
import { PlatformError } from "../errors/platform-error";

export function checkoutPaymentFeeResponseV1(response: { data: unknown }) {
  const source = response.data;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new PlatformError("financial_invariant_error", "Checkout receipt is invalid", 409);
  const fields = CheckoutPaymentFeeResponseV1Schema.shape.data.shape;
  const raw = source as Record<string, unknown>;
  const databaseInteger = (value: unknown) => typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.0+)?$/.test(value) ? Number(value) : value;
  const items = Array.isArray(raw.items) ? raw.items.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const item = value as Record<string, unknown>;
    return { ...item, quantity: databaseInteger(item.quantity), unitPrice: databaseInteger(item.unitPrice), lineTotal: databaseInteger(item.lineTotal) };
  }) : raw.items;
  const parsed = CheckoutPaymentFeeResponseV1Schema.safeParse({ schemaVersion: 1, contractVersion: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
    data: { ...Object.fromEntries(Object.entries(source).filter(([key]) => Object.hasOwn(fields, key))), items },
  });
  if (!parsed.success) throw new PlatformError("financial_invariant_error", "Checkout receipt is inconsistent with its frozen amounts", 409);
  return parsed.data;
}
