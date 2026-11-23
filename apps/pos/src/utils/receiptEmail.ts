import { ReceiptEmailSchema } from "@medusa-snus/contracts";

export type ReceiptEmailValidation =
  | { valid: true; normalized: string; error: null }
  | { valid: false; normalized: null; error: string };

export function validateReceiptEmail(value: string): ReceiptEmailValidation {
  const parsed = ReceiptEmailSchema.safeParse({ email: value });
  if (!parsed.success || !parsed.data.email) {
    return { valid: false, normalized: null, error: "Email nhận hóa đơn không hợp lệ." };
  }
  return { valid: true, normalized: parsed.data.email, error: null };
}
