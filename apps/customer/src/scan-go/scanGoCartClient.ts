import {
  checkoutTokenDtoSchema,
  scanGoCartDtoSchema,
  CheckoutError,
  type CheckoutTokenDto,
  type CreateScanGoCartInput,
  type ScanGoCartDto,
  type ScanGoCartLine,
  type ScanGoCartLineWire,
  type UpdateScanGoCartInput,
} from "./types";
import { REDEEMABLE_SECONDS, publicOrigin, scanGoLive } from "./config";

/* ═══════════════════════════════════════════════════════════════════
   SCAN & GO CART CLIENT ADAPTER.

   HARD INVARIANT — this client is the entire write surface the public
   flow has, and it may ONLY talk to the public scan-go draft-cart API:
     POST   /api/public/scan-go/carts
     PATCH  /api/public/scan-go/carts/:cartId
     POST   /api/public/scan-go/carts/:cartId/checkout-token
   It MUST NEVER call order, payment, inventory, stock, or POS endpoints.
   The final token is a draft-cart token for staff import later; it is not
   an order, payment, reservation, or stock hold. Verified by unit test.
   ═══════════════════════════════════════════════════════════════════ */

export async function createCart(input: CreateScanGoCartInput): Promise<ScanGoCartDto> {
  if (scanGoLive()) return createCartLive(input);
  return createCartMock(input);
}

export async function updateCart(cartId: string, patch: UpdateScanGoCartInput): Promise<ScanGoCartDto> {
  if (scanGoLive()) return updateCartLive(cartId, patch);
  return updateCartMock(cartId, patch);
}

export async function createCheckoutToken(cartId: string, editSecret?: string | null): Promise<CheckoutTokenDto> {
  if (scanGoLive()) return createCheckoutTokenLive(cartId, editSecret);
  return createCheckoutTokenMock(cartId, editSecret);
}

// ── Mock (in-memory) ─────────────────────────────────────────────────

const mockCarts = new Map<string, ScanGoCartDto>();

function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto?.getRandomValues?.(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hex}`;
}

async function createCartMock(input: CreateScanGoCartInput): Promise<ScanGoCartDto> {
  await delay(220);
  const dto: ScanGoCartDto = {
    cartId: randomId("sgc_"),
    editSecret: randomId("sge_"),
    merchantSlug: input.merchantSlug,
    storeSlug: input.storeSlug,
    lines: input.lines,
    customerNickname: input.customerNickname ?? null,
    customerContact: input.customerContact ?? null,
    contactType: input.contactType ?? null,
    ageAcknowledgedAt: input.ageAcknowledgedAt,
  };
  const parsed = scanGoCartDtoSchema.safeParse(dto);
  if (!parsed.success) {
    throw new CheckoutError("network_error", "Couldn't start your stash. Try again.");
  }
  mockCarts.set(parsed.data.cartId, parsed.data);
  return parsed.data;
}

async function updateCartMock(cartId: string, patch: UpdateScanGoCartInput): Promise<ScanGoCartDto> {
  await delay(140);
  const existing = mockCarts.get(cartId);
  if (!existing) {
    throw new CheckoutError("network_error", "Your stash expired. Build it again.");
  }
  if (!patch.editSecret || patch.editSecret !== existing.editSecret) {
    throw new CheckoutError("network_error", "Your stash expired. Build it again.");
  }
  const next: ScanGoCartDto = {
    ...existing,
    lines: patch.lines ?? existing.lines,
    customerNickname: patch.customerNickname ?? existing.customerNickname,
    customerContact: patch.customerContact ?? existing.customerContact,
    contactType: patch.contactType ?? existing.contactType,
  };
  const parsed = scanGoCartDtoSchema.safeParse(next);
  if (!parsed.success) {
    throw new CheckoutError("network_error", "Couldn't update your stash.");
  }
  mockCarts.set(cartId, parsed.data);
  return parsed.data;
}

async function createCheckoutTokenMock(cartId: string, editSecret?: string | null): Promise<CheckoutTokenDto> {
  await delay(360);
  const cart = mockCarts.get(cartId);
  if (!cart) {
    throw new CheckoutError("network_error", "Your stash expired. Build it again.");
  }
  if (!editSecret || editSecret !== cart.editSecret) {
    throw new CheckoutError("regenerate_failed", "Couldn't make the QR. Try again.");
  }
  const token = randomId("sgt_");
  const expiresAt = new Date(Date.now() + REDEEMABLE_SECONDS * 1000).toISOString();
  const dto: CheckoutTokenDto = {
    cartId,
    token,
    qrPayload: `${publicOrigin()}/s/${encodeURIComponent(cart.merchantSlug)}/${encodeURIComponent(cart.storeSlug)}/redeem?t=${token}`,
    expiresAt,
    redeemableSeconds: REDEEMABLE_SECONDS,
  };
  const parsed = checkoutTokenDtoSchema.safeParse(dto);
  if (!parsed.success) {
    throw new CheckoutError("regenerate_failed", "Couldn't make the QR. Try again.");
  }
  return parsed.data;
}

// ── Live (server API) ──────────────────────────────────────

function toWire(line: ScanGoCartLine): ScanGoCartLineWire {
  return {
    productId: line.productId,
    variantId: line.variantId,
    sku: line.sku,
    title: line.title,
    quantity: line.quantity,
    unitPriceVnd: line.unitPriceVnd,
  };
}

async function createCartLive(input: CreateScanGoCartInput): Promise<ScanGoCartDto> {
  try {
    const res = await fetch(`/api/public/scan-go/carts`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        merchantSlug: input.merchantSlug,
        storeSlug: input.storeSlug,
        lines: input.lines.map(toWire),
        customerNickname: input.customerNickname ?? null,
        customerContact: input.customerContact ?? null,
        contactType: input.contactType ?? null,
        ageAcknowledgedAt: input.ageAcknowledgedAt,
      }),
    });
    if (!res.ok) throw new Error(`create cart failed: ${res.status}`);
    const json = (await res.json()) as { data?: unknown };
    const parsed = scanGoCartDtoSchema.safeParse(json.data);
    if (!parsed.success) throw new Error("invalid create cart response");
    return parsed.data;
  } catch {
    throw new CheckoutError("network_error", "Couldn't start your stash. Try again.");
  }
}

async function updateCartLive(cartId: string, patch: UpdateScanGoCartInput): Promise<ScanGoCartDto> {
  try {
    const res = await fetch(`/api/public/scan-go/carts/${encodeURIComponent(cartId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        editSecret: patch.editSecret ?? null,
        lines: patch.lines?.map(toWire),
        customerNickname: patch.customerNickname ?? null,
        customerContact: patch.customerContact ?? null,
        contactType: patch.contactType ?? null,
      }),
    });
    if (!res.ok) throw new Error(`update cart failed: ${res.status}`);
    const json = (await res.json()) as { data?: unknown };
    const parsed = scanGoCartDtoSchema.safeParse(json.data);
    if (!parsed.success) throw new Error("invalid update cart response");
    return parsed.data;
  } catch {
    throw new CheckoutError("network_error", "Couldn't update your stash.");
  }
}

async function createCheckoutTokenLive(cartId: string, editSecret?: string | null): Promise<CheckoutTokenDto> {
  try {
    const res = await fetch(
      `/api/public/scan-go/carts/${encodeURIComponent(cartId)}/checkout-token`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ editSecret: editSecret ?? null }),
      },
    );
    if (!res.ok) throw new Error(`checkout token failed: ${res.status}`);
    const json = (await res.json()) as { data?: unknown };
    const parsed = checkoutTokenDtoSchema.safeParse(json.data);
    if (!parsed.success) throw new Error("invalid checkout token response");
    return parsed.data;
  } catch {
    throw new CheckoutError("regenerate_failed", "Couldn't make the QR. Try again.");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
