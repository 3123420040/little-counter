import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCart, createCheckoutToken, updateCart } from "../scan-go/scanGoCartClient";
import { CheckoutError, type CreateScanGoCartInput, type ScanGoCartDto, type ScanGoCartLine } from "../scan-go/types";

const LINE: ScanGoCartLine = {
  qrSlug: "sample-berry",
  merchantSlug: "default",
  storeSlug: "main",
  productId: "prod_1",
  variantId: "variant_1",
  sku: "SAMPLE-BERRY",
  title: "SAMPLE Berry Sample",
  quantity: 1,
  unitPriceVnd: 250000,
  brand: "SAMPLE",
  flavor: "Berry Sample",
  strengthLabel: "6mg/pouch",
  imageUrl: null,
};

function buildInput(overrides: Partial<CreateScanGoCartInput> = {}): CreateScanGoCartInput {
  return {
    merchantSlug: "default",
    storeSlug: "main",
    lines: [LINE],
    ageAcknowledgedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("scanGoCartClient (mock)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Mock mode must never touch the network — assert no fetch at all, which
    // also proves no order/payment/inventory/stock/POS endpoint is called.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("creates a draft cart with an sgc_ id and echoes lines", async () => {
    const cart = await createCart(buildInput());
    expect(cart.cartId).toMatch(/^sgc_/);
    expect(cart.editSecret).toMatch(/^sge_/);
    expect(cart.merchantSlug).toBe("default");
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0].quantity).toBe(1);
  });

  it("issues a checkout token with a 30-minute window and a redeem URL payload", async () => {
    const cart = await createCart(buildInput());
    const token = await createCheckoutToken(cart.cartId, cart.editSecret);
    expect(token.cartId).toBe(cart.cartId);
    expect(token.token).toMatch(/^sgt_/);
    expect(token.redeemableSeconds).toBe(30 * 60);
    expect(token.qrPayload).toContain("/redeem?t=");
    expect(Date.parse(token.expiresAt)).toBeGreaterThan(Date.now() - 1000);
  });

  it("updates cart lines", async () => {
    const cart = await createCart(buildInput());
    const updated = await updateCart(cart.cartId, {
      editSecret: cart.editSecret,
      lines: [{ ...LINE, quantity: 3 }],
    });
    expect(updated.lines[0].quantity).toBe(3);
  });

  it("NEVER calls fetch in mock mode (no order/payment/stock/POS)", async () => {
    const cart = await createCart(buildInput());
    await updateCart(cart.cartId, { editSecret: cart.editSecret, lines: [{ ...LINE, quantity: 2 }] });
    await createCheckoutToken(cart.cartId, cart.editSecret);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("scanGoCartClient (live adapter)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function cartDto(overrides: Partial<ScanGoCartDto> = {}): ScanGoCartDto {
    return {
      cartId: "sgc_live_1",
      editSecret: "sge_live_secret",
      merchantSlug: "default",
      storeSlug: "main",
      lines: [LINE],
      customerNickname: null,
      customerContact: null,
      contactType: null,
      ageAcknowledgedAt: "2026-06-26T10:00:00.000Z",
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.stubEnv("VITE_SCAN_GO_LIVE", "1");
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fetchSpy.mockRestore();
  });

  it("calls only the public scan-go draft-cart API in live mode", async () => {
    fetchSpy
      .mockResolvedValueOnce(Response.json({ data: cartDto() }))
      .mockResolvedValueOnce(Response.json({ data: cartDto({ lines: [{ ...LINE, quantity: 2 }] }) }))
      .mockResolvedValueOnce(Response.json({
        data: {
          cartId: "sgc_live_1",
          token: "sgt_live",
          qrPayload: "https://snus.example/s/default/main/redeem?t=sgt_live",
          expiresAt: "2026-06-26T10:30:00.000Z",
          redeemableSeconds: 1800,
        },
      }));

    const created = await createCart(buildInput());
    const updated = await updateCart(created.cartId, { editSecret: created.editSecret, lines: [{ ...LINE, quantity: 2 }] });
    const token = await createCheckoutToken(updated.cartId, updated.editSecret);

    expect(created.cartId).toBe("sgc_live_1");
    expect(updated.lines[0].quantity).toBe(2);
    expect(token.qrPayload).toContain("/redeem?t=sgt_live");
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "/api/public/scan-go/carts",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "/api/public/scan-go/carts/sgc_live_1",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      "/api/public/scan-go/carts/sgc_live_1/checkout-token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body))).toMatchObject({
      editSecret: "sge_live_secret",
    });
    expect(JSON.parse(String((fetchSpy.mock.calls[2][1] as RequestInit).body))).toMatchObject({
      editSecret: "sge_live_secret",
    });
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).toMatch(/^\/api\/public\/scan-go\//);
      expect(String(call[0])).not.toMatch(/\/api\/(?:pos|admin|inventory|orders?|stock|payment)/);
    }
  });

  it("fails closed when the live backend response no longer matches the DTO", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json({ data: { cartId: "sgc_bad" } }));

    await expect(createCart(buildInput())).rejects.toBeInstanceOf(CheckoutError);
  });
});
