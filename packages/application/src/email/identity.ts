import { ReceiptEmailSchema } from "@medusa-snus/contracts";

export function transactionalEmailIdentity() {
  const from = process.env.TRANSACTIONAL_EMAIL_FROM?.trim() || "";
  const parsed = ReceiptEmailSchema.safeParse({ email: process.env.TRANSACTIONAL_EMAIL_REPLY_TO });
  const replyTo = parsed.success ? parsed.data.email || "" : "";
  return { from, replyTo };
}
