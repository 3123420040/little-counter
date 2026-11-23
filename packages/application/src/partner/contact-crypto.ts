import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import type { PartnerFulfillment } from "@medusa-snus/contracts/partner-api";
import { PartnerError } from "./errors";

export const partnerContactKeyringSchema = z.strictObject({
  current: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  keys: z.record(z.string().min(1).max(64), z.string().regex(/^[A-Za-z0-9_-]{43}$/)
    .refine(value => Buffer.from(value, "base64url").length === 32)),
}).refine(value => !!value.keys[value.current]);
export type PartnerContactKeyring = z.infer<typeof partnerContactKeyringSchema>;
export const partnerDeliveryContactSchema = z.strictObject({
  mode: z.literal("delivery"), recipient_name: z.string().min(1).max(120),
  phone: z.string().min(1).max(32), address: z.string().min(1).max(500),
});
export interface PartnerContactBinding { merchantId: string; storeId: string; orderId: string }
interface EncryptedContact { key_version: string; ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer }
function aad(binding: PartnerContactBinding, version: string) {
  return Buffer.from(JSON.stringify(["partner-delivery-contact-v1", binding.merchantId, binding.storeId, binding.orderId, version]));
}
export function encryptPartnerContact(keys: PartnerContactKeyring, binding: PartnerContactBinding,
  contact: Extract<PartnerFulfillment, { mode: "delivery" }>): EncryptedContact {
  if (!partnerContactKeyringSchema.safeParse(keys).success) throw new PartnerError("dependency_unavailable");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keys.keys[keys.current], "base64url"), nonce);
  cipher.setAAD(aad(binding, keys.current));
  return { key_version: keys.current, nonce,
    ciphertext: Buffer.concat([cipher.update(JSON.stringify(contact), "utf8"), cipher.final()]), auth_tag: cipher.getAuthTag() };
}
export function decryptPartnerContact(keys: PartnerContactKeyring, binding: PartnerContactBinding, row: EncryptedContact) {
  try {
    if (!partnerContactKeyringSchema.safeParse(keys).success || !keys.keys[row.key_version]) throw new Error("Missing key");
    const cipher = createDecipheriv("aes-256-gcm", Buffer.from(keys.keys[row.key_version], "base64url"), row.nonce);
    cipher.setAAD(aad(binding, row.key_version)); cipher.setAuthTag(row.auth_tag);
    const value = JSON.parse(Buffer.concat([cipher.update(row.ciphertext), cipher.final()]).toString("utf8"));
    return partnerDeliveryContactSchema.parse(value);
  } catch { throw new PartnerError("dependency_unavailable"); }
}
