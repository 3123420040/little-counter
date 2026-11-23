import { CompleteSaleFinancialInputV1Schema, CreatePaymentIntentFinancialInputV1Schema, OrderCorrectionFinancialInputV1Schema, PAYMENT_FEE_RESOLVED_INPUT_FIELDS_V1, parseOptionalPaymentFeeInputV1 } from "@medusa-snus/contracts";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1, PAYMENT_FEE_WRITE_HTTP_HEADER_V1, type PaymentFeeHttpContractV1 } from "@medusa-snus/contracts/runtime-capabilities";
import { getBuildInfoV2, PlatformError } from "@medusa-snus/application";
import type { MedusaRequest, MedusaResponse } from "./http-types";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function feeFields(value: unknown): boolean {
  return record(value) && Object.keys(value).some(key => key.startsWith("paymentFee"));
}

export function paymentFeeReadHttpContractV1(req: MedusaRequest, res: MedusaResponse): PaymentFeeHttpContractV1 {
  res.setHeader("Cache-Control", "private, no-store");
  const declarations = Object.entries(req.headers).filter(([name, value]) => name.toLowerCase() === PAYMENT_FEE_WRITE_HTTP_HEADER_V1 && value !== undefined);
  if (!declarations.length) return "legacy";
  if (declarations.length !== 1 || declarations[0]![1] !== PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1) {
    throw new PlatformError("unsupported_contract", "A compatible order financial contract is required for payment fees", 409);
  }
  res.setHeader(PAYMENT_FEE_WRITE_HTTP_HEADER_V1, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
  return PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1;
}

export function assertPaymentFeeWriteHttpContractV1(
  req: MedusaRequest,
  res: MedusaResponse,
  family: "checkout" | "payment_intent" | "correction",
): "legacy" | typeof PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 {
  const declarations = Object.entries(req.headers).filter(([name, value]) => name.toLowerCase() === PAYMENT_FEE_WRITE_HTTP_HEADER_V1 && value !== undefined);
  const root = req.body, source = family === "payment_intent" && record(root) ? root.order : root;
  const hasFee = feeFields(root) || feeFields(source);
  if (!declarations.length && !hasFee) return "legacy";
  res.setHeader("Cache-Control", "private, no-store");
  if (declarations.length !== 1 || declarations[0]![1] !== PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1) {
    throw new PlatformError("unsupported_contract", "A compatible order financial contract is required for payment fees", 409);
  }
  try {
    if (!record(root) || !record(source) || (family === "payment_intent" && feeFields(root))) throw new Error("Invalid fee input location");
    if ([root, source].some(value => PAYMENT_FEE_RESOLVED_INPUT_FIELDS_V1.some(key => Object.hasOwn(value, key)))) throw new Error("Resolved financial input is not supported");
    const fee = parseOptionalPaymentFeeInputV1(source);
    if (family !== "correction" && !fee) throw new Error("A complete fee descriptor is required");
    if (family === "checkout" && !CompleteSaleFinancialInputV1Schema.safeParse(root).success) throw new Error("Invalid checkout input");
    if (family === "payment_intent" && !CreatePaymentIntentFinancialInputV1Schema.safeParse(root).success) throw new Error("Invalid intent input");
    if (family === "correction" && !OrderCorrectionFinancialInputV1Schema.safeParse(root).success) throw new Error("Invalid correction input");
  } catch {
    throw new PlatformError("validation_error", "Payment fee requests accept a valid type/value, not resolved financial values", 400);
  }
  let ready = false;
  try { ready = getBuildInfoV2("medusa").paymentFeeCapabilities.paymentFeeWrite.includes("v1"); }
  catch { /* An incomplete build identity or readiness layer cannot authorize new fee writes. */ }
  if (!ready) throw new PlatformError("feature_unavailable", "Payment fee writes are not ready on this runtime", 503);
  res.setHeader(PAYMENT_FEE_WRITE_HTTP_HEADER_V1, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
  return PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1;
}
