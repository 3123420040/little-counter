import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  client: { query: vi.fn() },
  ensurePlatformSchema: vi.fn(),
}));

const entitlement = vi.hoisted(() => ({
  requireFeatureCapability: vi.fn(),
}));
vi.mock("../services/business-lifecycle-service", () => ({ lockActiveBusinessScopeForClient: vi.fn() }));

vi.mock("../db/schema", () => ({
  ensurePlatformSchema: db.ensurePlatformSchema,
}));

vi.mock("../db/transaction", () => ({
  withConnectedClient: vi.fn(async (handler: (client: typeof db.client) => Promise<unknown>) => handler(db.client)),
  withConnectedTransaction: vi.fn(async (handler: (client: typeof db.client) => Promise<unknown>) => handler(db.client)),
}));

vi.mock("../services/feature-entitlement-service", () => ({
  requireFeatureCapability: entitlement.requireFeatureCapability,
}));

import {
  createScanGoCart,
  createScanGoCheckoutToken,
  extractScanGoToken,
  redeemScanGoCartForStaff,
  resolvePublicScanGoProduct,
  resolveScanGoCartForStaff,
  updateScanGoCart,
} from "../services/scan-go-service";

const scope = {
  scopeKind: "operating" as const,
  merchantId: "merchant_a",
  storeId: "store_a",
  stockLocationId: "sloc_a",
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const publicScopeRow = {
  merchant_id: "merchant_a",
  store_id: "store_a",
  stock_location_id: "sloc_a",
};

function cartRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sgc_1",
    merchant_id: "merchant_a",
    store_id: "store_a",
    status: "draft",
    merchant_slug: "default",
    store_slug: "main",
    customer_nickname: null,
    customer_contact: null,
    contact_type: null,
    age_acknowledged_at: new Date("2026-06-26T09:58:00.000Z"),
    edit_secret_hash: hash("sge_test"),
    token_hash: null,
    token_expires_at: null,
    redeemed_at: null,
    redeemed_by_operator_id: null,
    ...overrides,
  };
}

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    qr_code_id: "qr_1",
    product_id: "prod_1",
    variant_id: "var_1",
    inventory_item_id: "iitem_1",
    title: "VELO Freeze 14mg",
    image_url: "https://images.example.test/velo.jpg",
    status: "published",
    sku: "VELO-14",
    barcode: "123",
    price: "250000",
    stock: "8",
    qr_slug: "velo-freeze",
    ...overrides,
  };
}

describe("scan go service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.client.query.mockReset().mockResolvedValue({ rows: [] });
    entitlement.requireFeatureCapability.mockResolvedValue(undefined);
    vi.useRealTimers();
    delete process.env.PUBLIC_APP_URL;
  });

  it("extracts checkout tokens from raw tokens and redeem URLs", () => {
    expect(extractScanGoToken("sgt_abc123")).toBe("sgt_abc123");
    expect(extractScanGoToken("https://snus.example/s/default/main/redeem?t=sgt_deadbeef")).toBe("sgt_deadbeef");
    expect(() => extractScanGoToken("https://snus.example/redeem")).toThrow(/Invalid Scan Go token/);
    expect(() => extractScanGoToken("https://snus.example/redeem?t=not_scan_go")).toThrow(/Invalid Scan Go token/);
  });

  it("creates a hashed one-time checkout token with a 30 minute redeem window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T10:00:00.000Z"));
    process.env.PUBLIC_APP_URL = "https://snus.example";
    db.client.query
      .mockResolvedValueOnce({
        rows: [{
          id: "sgc_1",
          merchant_id: "merchant_a",
          store_id: "store_a",
          status: "draft",
          merchant_slug: "default",
          store_slug: "main",
          customer_nickname: null,
          customer_contact: null,
          contact_type: null,
	          age_acknowledged_at: new Date("2026-06-26T09:58:00.000Z"),
	          edit_secret_hash: hash("sge_test"),
	          token_hash: null,
          token_expires_at: null,
          redeemed_at: null,
          redeemed_by_operator_id: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [cartRow()] })
      .mockResolvedValueOnce({ rows: [{ id: "item_1" }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await createScanGoCheckoutToken("sgc_1", { editSecret: "sge_test" });

    expect(entitlement.requireFeatureCapability).toHaveBeenCalledWith("customer_scan_go", {
      merchantId: "merchant_a",
      client: db.client,
    });
    expect(db.client.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("token_hash = $2"),
      ["sgc_1", expect.stringMatching(/^[a-f0-9]{64}$/), new Date("2026-06-26T10:30:00.000Z")],
    );
    expect(result.data).toMatchObject({
      cartId: "sgc_1",
      qrPayload: expect.stringContaining("https://snus.example/s/default/main/redeem?t=sgt_"),
      expiresAt: "2026-06-26T10:30:00.000Z",
      redeemableSeconds: 1800,
    });
    expect(result.data.token).toMatch(/^sgt_[a-f0-9]+$/);
  });

  it("rejects checkout token generation when the edit secret is wrong", async () => {
    db.client.query.mockResolvedValueOnce({
      rows: [{
        id: "sgc_1",
        merchant_id: "merchant_a",
        store_id: "store_a",
        status: "draft",
        merchant_slug: "default",
        store_slug: "main",
        customer_nickname: null,
        customer_contact: null,
        contact_type: null,
        age_acknowledged_at: new Date("2026-06-26T09:58:00.000Z"),
        edit_secret_hash: hash("sge_real"),
        token_hash: null,
        token_expires_at: null,
        redeemed_at: null,
        redeemed_by_operator_id: null,
      }],
    });

    await expect(createScanGoCheckoutToken("sgc_1", { editSecret: "sge_wrong" })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(entitlement.requireFeatureCapability).not.toHaveBeenCalled();
  });

  it("resolves a ready cart for staff with locked Stash Dash metadata", async () => {
    db.client.query
      .mockResolvedValueOnce({
        rows: [{
          id: "sgc_1",
          merchant_id: "merchant_a",
          store_id: "store_a",
          status: "ready",
          merchant_slug: "default",
          store_slug: "main",
          customer_nickname: "Tommy",
          customer_contact: "+44",
          contact_type: "whatsapp",
          age_acknowledged_at: new Date("2026-06-26T09:58:00.000Z"),
          token_hash: "hash",
          token_expires_at: new Date(Date.now() + 600_000),
          redeemed_at: null,
          redeemed_by_operator_id: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          product_id: "prod_1",
          variant_id: "var_1",
          inventory_item_id: "iitem_1",
          sku: "ICE-160",
          title: "ICEBERG Hardcore",
          status: "published",
          quantity: "2",
          unit_price_vnd: "250000",
          current_price: "250000",
          stock: "8",
        }],
      });

    const result = await resolveScanGoCartForStaff({ tokenOrPayload: "sgt_deadbeef" }, scope);

    expect(db.client.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("token_hash = $1"),
      [expect.stringMatching(/^[a-f0-9]{64}$/)],
    );
    expect(result.data).toMatchObject({
      cartId: "sgc_1",
      sourceFlow: "customer_scan_go",
      salesChannel: "stash_dash",
      salesChannelLocked: true,
      customerNickname: "Tommy",
      contactType: "whatsapp",
      lines: [{
        productId: "prod_1",
        variantId: "var_1",
        quantity: 2,
        unitPrice: 250000,
        stockLevel: 8,
      }],
      warnings: [],
    });
  });

  it("rejects incomplete public product routes before database access", async () => {
    for (const input of [
      {},
      { merchantSlug: "default" },
      { merchantSlug: "default", storeSlug: "main" },
    ]) {
      await expect(resolvePublicScanGoProduct(input)).rejects.toMatchObject({ code: "validation_error" });
    }
    expect(db.client.query).not.toHaveBeenCalled();
  });

  it("resolves public products with safe presentation and availability", async () => {
    db.client.query
      .mockResolvedValueOnce({ rows: [publicScopeRow] })
      .mockResolvedValueOnce({ rows: [productRow()] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await resolvePublicScanGoProduct({
      merchantSlug: " default ", storeSlug: " main ", qrSlug: " velo-freeze ",
    });

    expect(entitlement.requireFeatureCapability).toHaveBeenCalledWith("customer_scan_go", {
      merchantId: "merchant_a", client: db.client,
    });
    expect(result.data).toMatchObject({
      brand: "VELO",
      name: "Freeze",
      strengthLabel: "14mg/pouch",
      priceVnd: 250000,
      imageUrl: "https://images.example.test/velo.jpg",
      availability: "available",
    });

    db.client.query
      .mockResolvedValueOnce({ rows: [publicScopeRow] })
      .mockResolvedValueOnce({ rows: [productRow({ title: "Nordic Mint", sku: "MINT", image_url: "data:image/png;base64,unsafe", stock: 0 })] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(resolvePublicScanGoProduct({ merchantSlug: "default", storeSlug: "main", qrSlug: "mint" }))
      .resolves.toMatchObject({ data: { name: "Mint", strengthLabel: "Strong", imageUrl: null, availability: "unavailable" } });
  });

  it("reports missing public stores and products without leaking tenant data", async () => {
    db.client.query.mockResolvedValueOnce({ rows: [] });
    await expect(resolvePublicScanGoProduct({ merchantSlug: "missing", storeSlug: "main", qrSlug: "x" }))
      .rejects.toMatchObject({ code: "resource_not_found", statusCode: 404 });

    db.client.query
      .mockResolvedValueOnce({ rows: [publicScopeRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(resolvePublicScanGoProduct({ merchantSlug: "default", storeSlug: "main", qrSlug: "missing" }))
      .rejects.toMatchObject({ code: "product_not_found", statusCode: 404 });
  });

  it("creates a cart with a hashed edit secret and normalized product snapshot", async () => {
    db.client.query
      .mockResolvedValueOnce({ rows: [publicScopeRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [productRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [cartRow()] })
      .mockResolvedValueOnce({ rows: [{
        product_id: "prod_1", variant_id: "var_1", sku: "VELO-14", title: "VELO Freeze 14mg",
        quantity: "2", unit_price_vnd: "250000", qr_slug: "velo-freeze", product_snapshot: null,
      }] });

    const result = await createScanGoCart({
      merchantSlug: "default",
      storeSlug: "main",
      ageAcknowledgedAt: "2026-06-26T09:58:00.000Z",
      customerNickname: " A ".repeat(100),
      customerContact: " +44 ",
      contactType: "whatsapp",
      lines: [{ productId: "prod_1", variantId: "var_1", quantity: 2 }],
    });

    expect(result.data.editSecret).toMatch(/^sge_[a-f0-9]+$/);
    expect(result.data.lines[0]).toMatchObject({
      brand: "VELO", flavor: "Freeze", strengthLabel: "14mg/pouch", imageUrl: null,
    });
    const insertParams = db.client.query.mock.calls[1][1];
    expect(insertParams[9]).toMatch(/^[a-f0-9]{64}$/);
    expect(String(insertParams[5])).toHaveLength(80);
  });

  it("validates cart line count, age, contact type, product identity, quantity, and publication", async () => {
    const invalidInputs = [
      { lines: [], ageAcknowledgedAt: "2026-01-01" },
      { lines: Array.from({ length: 51 }, () => ({ productId: "p", variantId: "v", quantity: 1 })), ageAcknowledgedAt: "2026-01-01" },
      { lines: [{ productId: "p", variantId: "v", quantity: 1 }], ageAcknowledgedAt: "not-a-date" },
      { lines: [{ productId: "p", variantId: "v", quantity: 1 }], ageAcknowledgedAt: "2026-01-01", contactType: "sms" },
    ];
    for (const input of invalidInputs) {
      db.client.query.mockReset();
      db.client.query.mockResolvedValueOnce({ rows: [publicScopeRow] });
      await expect(createScanGoCart({ merchantSlug: "default", storeSlug: "main", ...input } as never))
        .rejects.toMatchObject({ statusCode: expect.any(Number) });
    }

    for (const lineCase of [
      { line: { productId: "", variantId: "v", quantity: 1 }, row: null, code: "validation_error" },
      { line: { productId: "p", variantId: "v", quantity: 1 }, row: null, code: "resource_not_found" },
      { line: { productId: "p", variantId: "v", quantity: 1 }, row: productRow({ status: "draft" }), code: "product_unavailable" },
      { line: { productId: "p", variantId: "v", quantity: 0 }, row: productRow(), code: "validation_error" },
      { line: { productId: "p", variantId: "v", quantity: 100 }, row: productRow(), code: "validation_error" },
    ]) {
      db.client.query.mockReset();
      db.client.query
        .mockResolvedValueOnce({ rows: [publicScopeRow] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      if (lineCase.line.productId) db.client.query.mockResolvedValueOnce({ rows: lineCase.row ? [lineCase.row] : [] });
      await expect(createScanGoCart({
        merchantSlug: "default", storeSlug: "main", ageAcknowledgedAt: "2026-01-01", lines: [lineCase.line],
      })).rejects.toMatchObject({ code: lineCase.code });
    }
  });

  it("updates editable cart fields, invalidates its token, and optionally replaces lines", async () => {
    db.client.query
      .mockResolvedValueOnce({ rows: [cartRow({ customer_nickname: "Old", customer_contact: "+1", contact_type: "phone" })] })
      .mockResolvedValueOnce({ rows: [cartRow({ customer_nickname: "Old", customer_contact: "+1", contact_type: "phone" })] })
      .mockResolvedValueOnce({ rows: [publicScopeRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [productRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [cartRow({ customer_nickname: "New", customer_contact: null, contact_type: "email" })] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await updateScanGoCart("sgc_1", {
      editSecret: "sge_test",
      customerNickname: " New ",
      customerContact: null,
      contactType: "email",
      lines: [{ productId: "prod_1", variantId: "var_1", quantity: 1 }],
    });
    expect(result.data).toMatchObject({ customerNickname: "New", customerContact: null, contactType: "email" });
    expect(db.client.query.mock.calls[6][0]).toContain("token_hash = NULL");
  });

  it("preserves omitted cart fields and rejects missing/redeemed carts", async () => {
    db.client.query.mockResolvedValueOnce({ rows: [] });
    await expect(updateScanGoCart("missing", { editSecret: "sge_test" })).rejects.toMatchObject({ code: "resource_not_found" });

    db.client.query.mockResolvedValueOnce({ rows: [cartRow({ status: "redeemed" })] })
      .mockResolvedValueOnce({ rows: [cartRow({ status: "redeemed" })] });
    await expect(updateScanGoCart("sgc_1", { editSecret: "sge_test" })).rejects.toMatchObject({ code: "cart_already_redeemed" });

    db.client.query
      .mockResolvedValueOnce({ rows: [cartRow({ customer_nickname: "Old", customer_contact: "+1", contact_type: "phone" })] })
      .mockResolvedValueOnce({ rows: [cartRow({ customer_nickname: "Old", customer_contact: "+1", contact_type: "phone" })] })
      .mockResolvedValueOnce({ rows: [publicScopeRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [cartRow({ customer_nickname: "Old", customer_contact: "+1", contact_type: "phone" })] })
      .mockResolvedValueOnce({ rows: [] });
    await updateScanGoCart("sgc_1", { editSecret: "sge_test" });
    expect(db.client.query.mock.calls.at(-3)?.[1]).toEqual(["sgc_1", "Old", "+1", "phone"]);
  });

  it("rejects absent/redeemed/empty carts before generating checkout tokens", async () => {
    db.client.query.mockResolvedValueOnce({ rows: [] });
    await expect(createScanGoCheckoutToken("missing", { editSecret: "sge_test" }))
      .rejects.toMatchObject({ code: "resource_not_found" });

    db.client.query.mockResolvedValueOnce({ rows: [cartRow({ status: "redeemed" })] })
      .mockResolvedValueOnce({ rows: [cartRow({ status: "redeemed" })] });
    await expect(createScanGoCheckoutToken("sgc_1", { editSecret: "sge_test" }))
      .rejects.toMatchObject({ code: "cart_already_redeemed" });

    db.client.query.mockResolvedValueOnce({ rows: [cartRow()] }).mockResolvedValueOnce({ rows: [cartRow()] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(createScanGoCheckoutToken("sgc_1", { editSecret: "sge_test" }))
      .rejects.toMatchObject({ code: "validation_error" });
  });

  it.each([null, cartRow({ merchant_id: "merchant_b" }), cartRow({ store_id: "store_b" })])(
    "rejects a cart moved or removed between initial authorization and row lock", async locked => {
      db.client.query.mockResolvedValueOnce({ rows: [cartRow()] })
        .mockResolvedValueOnce({ rows: locked ? [locked] : [] });
      await expect(createScanGoCheckoutToken("sgc_1", { editSecret: "sge_test" })).rejects.toMatchObject({ code: "forbidden" });
      expect(db.client.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE app.scan_go_carts"))).toBe(false);
    },
  );

  it.each([
    [null, "resource_not_found"],
    [cartRow({ merchant_id: "merchant_b" }), "forbidden"],
    [cartRow({ status: "redeemed" }), "cart_already_redeemed"],
    [cartRow({ status: "draft" }), "cart_not_ready"],
    [cartRow({ status: "ready", token_expires_at: null }), "cart_token_expired"],
    [cartRow({ status: "ready", token_expires_at: new Date(Date.now() - 1000) }), "cart_token_expired"],
  ])("fails staff resolution safely for %s", async (cart, code) => {
    db.client.query.mockResolvedValueOnce({ rows: cart ? [cart] : [] });
    if (code === "cart_token_expired") db.client.query.mockResolvedValueOnce({ rows: [] });
    db.client.query.mockResolvedValueOnce({ rows: [] });
    await expect(resolveScanGoCartForStaff({ tokenOrPayload: "sgt_deadbeef" }, scope, { operatorId: "op_a" }))
      .rejects.toMatchObject({ code });
  });

  it("surfaces unpublished, stock, and price warnings and rejects an empty ready cart", async () => {
    const ready = cartRow({ status: "ready", token_expires_at: new Date(Date.now() + 60_000) });
    db.client.query
      .mockResolvedValueOnce({ rows: [ready] })
      .mockResolvedValueOnce({ rows: [
        { ...productRow(), quantity: 1, unit_price_vnd: 250000, current_price: 250000, status: "draft" },
        { ...productRow({ product_id: "prod_2", variant_id: "var_2", title: "Low stock" }), quantity: 3, unit_price_vnd: 100, current_price: 100, stock: 1 },
        { ...productRow({ product_id: "prod_3", variant_id: "var_3", title: "Changed price" }), quantity: 1, unit_price_vnd: 100, current_price: 120, stock: 10 },
      ] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await resolveScanGoCartForStaff({ tokenOrPayload: "sgt_deadbeef" }, scope);
    expect(result.data.warnings).toHaveLength(3);
    expect(result.data.lines.every((line) => Boolean(line.warning))).toBe(true);

    db.client.query
      .mockResolvedValueOnce({ rows: [ready] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(resolveScanGoCartForStaff({ tokenOrPayload: "sgt_deadbeef" }, scope))
      .rejects.toMatchObject({ code: "validation_error" });
  });

  it("redeems a ready cart exactly once and records the responsible operator", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00.000Z"));
    const ready = cartRow({ status: "ready", token_expires_at: new Date("2026-09-03T10:10:00.000Z") });
    db.client.query
      .mockResolvedValueOnce({ rows: [ready] })
      .mockResolvedValueOnce({ rows: [{
        ...productRow(), quantity: 1, unit_price_vnd: 250000, current_price: 250000, stock: 5,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await redeemScanGoCartForStaff({ tokenOrPayload: "sgt_deadbeef" }, scope, {
      operatorId: "op_a", role: "staff", organizationId: "org_a",
    });

    expect(result.data).toMatchObject({
      status: "redeemed", redeemedAt: "2026-09-03T10:00:00.000Z", redeemedByOperatorId: "op_a",
    });
    expect(db.client.query).toHaveBeenNthCalledWith(3, expect.stringContaining("status = 'redeemed'"), [
      "sgc_1", new Date("2026-09-03T10:00:00.000Z"), "op_a",
    ]);
  });
});
