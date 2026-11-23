import { z } from "zod";

/* ═══════════════════════════════════════════════════════════════════
   Scan & Go public DTO contract.

   The public client exchanges product, cart and checkout-token data with
   the Scan & Go API. Store staff process redeemed carts in the POS.

   MVP displays VND only. There is no USD field anywhere on purpose.
   ═══════════════════════════════════════════════════════════════════ */

// ── Product public DTO ───────────────────────────────────────────────

export const formatTagSchema = z.string();
export const availabilitySchema = z.enum(["available", "unavailable"]);
export const contactTypeSchema = z.enum(["whatsapp", "email", "phone"]);

export const productPublicDtoSchema = z.object({
  merchantSlug: z.string().min(1),
  storeSlug: z.string().min(1),
  qrSlug: z.string().min(1),
  productId: z.string().min(1),
  variantId: z.string().min(1),
  brand: z.string().min(1),
  name: z.string().min(1),
  flavor: z.string().min(1),
  formatTags: z.array(formatTagSchema).default([]),
  strengthLabel: z.string().min(1),
  priceVnd: z.number().int().nonnegative(),
  imageUrl: z.string().url().nullable(),
  approvedStory: z.string().default(""),
  availability: availabilitySchema,
});
export type ProductPublicDto = z.infer<typeof productPublicDtoSchema>;

// ── Customer cart DTO ────────────────────────────────────────────────
// Wire line = the subset sent to / kept by the backend.
export const scanGoCartLineWireSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().min(1),
  sku: z.string().min(1),
  title: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceVnd: z.number().int().nonnegative(),
});
export type ScanGoCartLineWire = z.infer<typeof scanGoCartLineWireSchema>;

// Local line = wire line + display fields the UI needs to render a rich
// cart without re-resolving every product. Display fields never leave the
// browser; createCart/updateCart map down to the wire subset.
export const scanGoCartLineSchema = scanGoCartLineWireSchema.extend({
  qrSlug: z.string().min(1),
  merchantSlug: z.string().min(1),
  storeSlug: z.string().min(1),
  brand: z.string().min(1),
  flavor: z.string().min(1),
  strengthLabel: z.string().min(1),
  imageUrl: z.string().url().nullable(),
});
export type ScanGoCartLine = z.infer<typeof scanGoCartLineSchema>;

export const scanGoCartDtoSchema = z.object({
  cartId: z.string().min(1),
  editSecret: z.string().min(1).optional(),
  merchantSlug: z.string().min(1),
  storeSlug: z.string().min(1),
  lines: z.array(scanGoCartLineSchema),
  customerNickname: z.string().nullable(),
  customerContact: z.string().nullable(),
  contactType: contactTypeSchema.nullable(),
  ageAcknowledgedAt: z.string().min(1),
});
export type ScanGoCartDto = z.infer<typeof scanGoCartDtoSchema>;

export interface CreateScanGoCartInput {
  merchantSlug: string;
  storeSlug: string;
  lines: ScanGoCartLine[];
  customerNickname?: string | null;
  customerContact?: string | null;
  contactType?: ContactType | null;
  ageAcknowledgedAt: string;
}

export interface UpdateScanGoCartInput {
  editSecret?: string | null;
  lines?: ScanGoCartLine[];
  customerNickname?: string | null;
  customerContact?: string | null;
  contactType?: ContactType | null;
}

// ── Checkout token DTO (the final cart QR) ───────────────────────────

export const checkoutTokenDtoSchema = z.object({
  cartId: z.string().min(1),
  token: z.string().min(1),
  qrPayload: z.string().min(1),
  expiresAt: z.string().min(1),
  redeemableSeconds: z.number().int().positive(),
});
export type CheckoutTokenDto = z.infer<typeof checkoutTokenDtoSchema>;

// ── Shared primitives ────────────────────────────────────────────────

export type Availability = z.infer<typeof availabilitySchema>;
export type ContactType = z.infer<typeof contactTypeSchema>;

export type ProductResolveErrorCode = "product_not_found" | "product_unavailable" | "network_error";

export class ProductResolveError extends Error {
  readonly code: ProductResolveErrorCode;
  constructor(code: ProductResolveErrorCode, message: string) {
    super(message);
    this.name = "ProductResolveError";
    this.code = code;
  }
}

export type CheckoutErrorCode = "network_error" | "regenerate_failed";

export class CheckoutError extends Error {
  readonly code: CheckoutErrorCode;
  constructor(code: CheckoutErrorCode, message: string) {
    super(message);
    this.name = "CheckoutError";
    this.code = code;
  }
}
