import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  client: { query: vi.fn() },
  ensurePlatformSchema: vi.fn(),
  queryOne: vi.fn(),
  audit: vi.fn(),
  outbox: vi.fn(),
}));

vi.mock("../db/schema", () => ({ ensurePlatformSchema: deps.ensurePlatformSchema }));
vi.mock("../db/query", () => ({ queryOne: deps.queryOne }));
vi.mock("../db/transaction", () => ({
  withConnectedClient: vi.fn(async (handler: (client: typeof deps.client) => Promise<unknown>) => handler(deps.client)),
  withConnectedTransaction: vi.fn(async (handler: (client: typeof deps.client) => Promise<unknown>) => handler(deps.client)),
}));
vi.mock("../repositories/audit-repository", () => ({ recordAuditEntry: deps.audit }));
vi.mock("../repositories/outbox-repository", () => ({ emitExactOutbox: deps.outbox }));

import {
  buildProductImageSearchQuery,
  emitProductImageAutofillRequestForClient,
  firstValidProductImageCandidate,
  handleProductImageAutofillRequested,
  handleProductImageAutofillRequestedOnReadySchema,
  isProductImageAutofillEnabled,
  productImageAutofillFailureReason,
  productImageAutofillProvider,
  requestProductImageAutofill,
  runProductImageSearchProvider,
} from "../services/product-image-autofill-service";

const envKeys = [
  "PRODUCT_IMAGE_AUTOFILL_ENABLED",
  "PRODUCT_IMAGE_AUTOFILL_PROVIDER",
  "PRODUCT_RESEARCH_PROVIDER",
  "TAVILY_API_KEY",
  "TAVILY_API_BASE",
  "TAVILY_SEARCH_DEPTH",
  "TAVILY_MAX_RESULTS",
  "PRODUCT_RESEARCH_PREFERRED_LANGUAGE",
] as const;
const snapshot = (metadata: Record<string, unknown> = {}) => ({
  id: "product_a",
  merchant_id: "merchant_a",
  title: "VELO Freeze 14mg",
  sku: "VELO-14",
  metadata,
});

describe("product image autofill service", () => {
  const originalEnv = new Map<string, string | undefined>();
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of envKeys) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    originalFetch = globalThis.fetch;
    deps.client.query.mockResolvedValue({ rows: [], rowCount: 1 });
    deps.audit.mockResolvedValue({
      id: "audit_a",
      createdAt: "2026-09-03T00:00:00.000Z",
      correlationId: "correlation_a",
    });
    deps.outbox.mockResolvedValue("outbox_a");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("normalizes feature/provider configuration and deterministic queries", async () => {
    expect(isProductImageAutofillEnabled()).toBe(false);
    process.env.PRODUCT_IMAGE_AUTOFILL_ENABLED = " TRUE ";
    expect(isProductImageAutofillEnabled()).toBe(true);
    expect(productImageAutofillProvider()).toBe("deterministic");
    process.env.PRODUCT_RESEARCH_PROVIDER = "tavily";
    expect(productImageAutofillProvider()).toBe("tavily");
    process.env.PRODUCT_IMAGE_AUTOFILL_PROVIDER = "unknown";
    expect(productImageAutofillProvider()).toBe("deterministic");
    expect(buildProductImageSearchQuery({ title: "VELO Freeze", sku: "V-1" }))
      .toBe("VELO Freeze SKU V-1 official product pack image");
    expect(buildProductImageSearchQuery({ title: "VELO Freeze" }))
      .toBe("VELO Freeze official product pack image");

    const deterministic = await runProductImageSearchProvider({ title: "A/B Product", sku: "" });
    expect(deterministic).toMatchObject({
      provider: "deterministic",
      candidate: {
        imageUrl: "https://dummyimage.com/512x512/0f766e/ffffff.png&text=A%2FB%20Product",
        sourceUrl: "deterministic-local-product-image",
      },
    });
  });

  it("selects the first normalized HTTPS candidate and ignores unsafe provider data", () => {
    expect(firstValidProductImageCandidate([
      { imageUrl: "javascript:alert(1)" },
      { imageUrl: "" },
      { imageUrl: " https://images.example.test/product.jpg ", sourceUrl: " https://source.test/item " },
      { imageUrl: "https://images.example.test/later.jpg" },
    ])).toEqual({
      imageUrl: "https://images.example.test/product.jpg",
      sourceUrl: "https://source.test/item",
    });
    expect(firstValidProductImageCandidate([{ imageUrl: null }, { imageUrl: "http://insecure.test/a.jpg" }])).toBeNull();
    expect(firstValidProductImageCandidate([{ imageUrl: "https://images.example.test/a.jpg", sourceUrl: 42 }])).toEqual({
      imageUrl: "https://images.example.test/a.jpg",
      sourceUrl: undefined,
    });
  });

  it("fails Tavily closed without credentials and classifies HTTP/no-field responses", async () => {
    process.env.PRODUCT_IMAGE_AUTOFILL_PROVIDER = "tavily";
    await expect(runProductImageSearchProvider({ title: "Product" })).resolves.toMatchObject({
      provider: "tavily", candidate: null, reason: "provider_config_missing",
    });

    process.env.TAVILY_API_KEY = "redacted-test-key";
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("not json", { status: 429 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 })) as typeof fetch;
    await expect(runProductImageSearchProvider({ title: "Product" })).resolves.toMatchObject({
      candidate: null, reason: "provider_http_429",
    });
    await expect(runProductImageSearchProvider({ title: "Product" })).resolves.toMatchObject({
      candidate: null, reason: "no_image_field",
    });
  });

  it("extracts Tavily string/object/result/nested candidates with bounded request options", async () => {
    process.env.PRODUCT_IMAGE_AUTOFILL_PROVIDER = "tavily";
    process.env.TAVILY_API_KEY = "redacted-test-key";
    process.env.TAVILY_API_BASE = "https://tavily.test/";
    process.env.TAVILY_SEARCH_DEPTH = "basic";
    process.env.TAVILY_MAX_RESULTS = "99";
    process.env.PRODUCT_RESEARCH_PREFERRED_LANGUAGE = "vi";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      images: [
        "http://unsafe.test/a.jpg",
        { image_url: "https://images.test/direct.jpg", source_url: "https://source.test/direct" },
      ],
      results: [{
        url: "https://source.test/result",
        imageUrl: "https://images.test/result.jpg",
        images: [
          "https://images.test/nested-string.jpg",
          { url: "https://images.test/nested-object.jpg" },
        ],
      }],
    }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await runProductImageSearchProvider({ title: "Product", sku: "SKU" });

    expect(result.candidate).toEqual({
      imageUrl: "https://images.test/direct.jpg",
      sourceUrl: "https://source.test/direct",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://tavily.test/search", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer redacted-test-key" }),
    }));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toMatchObject({ search_depth: "basic", max_results: 10, country: "vietnam" });

    process.env.TAVILY_MAX_RESULTS = "not-a-number";
    process.env.PRODUCT_RESEARCH_PREFERRED_LANGUAGE = "en";
    await runProductImageSearchProvider({ title: "Product" });
    const fallbackBody = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(fallbackBody).toMatchObject({ max_results: 5 });
    expect(fallbackBody.country).toBeUndefined();
  });

  it("does not emit when disabled, absent, imaged, attempted, or already queued", async () => {
    await expect(emitProductImageAutofillRequestForClient(deps.client as never, {
      productId: "product_a", merchantId: "merchant_a",
    })).resolves.toBeNull();

    process.env.PRODUCT_IMAGE_AUTOFILL_ENABLED = "true";
    for (const product of [
      null,
      snapshot({ imageUrl: "https://manual.test/image.jpg" }),
      snapshot({ imageAutofill: { attemptedAt: "2026-09-03T00:00:00.000Z" } }),
    ]) {
      deps.queryOne.mockReset();
      deps.queryOne.mockResolvedValueOnce(product);
      await expect(emitProductImageAutofillRequestForClient(deps.client as never, {
        productId: "product_a", merchantId: "merchant_a",
      })).resolves.toBeNull();
    }

    deps.queryOne.mockReset();
    deps.queryOne.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce({ id: "existing_outbox" });
    await expect(emitProductImageAutofillRequestForClient(deps.client as never, {
      productId: "product_a", merchantId: "merchant_a",
    })).resolves.toBe("existing_outbox");
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("emits one exact audited request with normalized defaults and overrides", async () => {
    process.env.PRODUCT_IMAGE_AUTOFILL_ENABLED = "true";
    deps.queryOne.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(null);

    const result = await emitProductImageAutofillRequestForClient(deps.client as never, {
      productId: "product_a",
      merchantId: "merchant_a",
      storeId: "store_a",
      title: "Override title",
      sku: "OVERRIDE",
      source: "product.create",
      requestedBy: "owner_a",
    });

    expect(result).toBe("outbox_a");
    expect(deps.audit).toHaveBeenCalledWith(
      deps.client,
      expect.objectContaining({ operatorId: "owner_a", serviceIdentity: "product-image-autofill" }),
      "product.image_autofill_requested",
      "product",
      "product_a",
      expect.objectContaining({
        after: { source: "product.create", title: "Override title", sku: "OVERRIDE" },
        merchantId: "merchant_a",
        storeId: "store_a",
      }),
    );
    expect(deps.outbox).toHaveBeenCalledOnce();

    deps.queryOne.mockReset();
    deps.queryOne.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(null);
    await requestProductImageAutofill({ productId: "product_a", merchantId: "merchant_a" });
    expect(deps.ensurePlatformSchema).toHaveBeenCalledOnce();
  });

  it("ignores incomplete/stale events and applies one deterministic result", async () => {
    await handleProductImageAutofillRequestedOnReadySchema({});
    expect(deps.queryOne).not.toHaveBeenCalled();

    for (const product of [null, snapshot({ imageUrl: "https://manual.test/image.jpg" }), snapshot({ imageAutofill: { attemptedAt: "now" } })]) {
      deps.queryOne.mockReset();
      deps.queryOne.mockResolvedValueOnce(product);
      await handleProductImageAutofillRequestedOnReadySchema({ productId: "product_a", merchantId: "merchant_a" });
      expect(deps.client.query).not.toHaveBeenCalled();
    }

    deps.queryOne.mockReset();
    deps.queryOne.mockResolvedValueOnce(snapshot());
    await handleProductImageAutofillRequested({
      productId: "product_a", merchantId: "merchant_a", storeId: "store_a", title: "Payload title", sku: "PAYLOAD",
    });
    expect(deps.client.query).toHaveBeenCalledWith(
      expect.stringContaining("COALESCE(metadata->>'imageUrl', '') = ''"),
      ["product_a", "merchant_a", expect.stringContaining('"status":"applied"')],
    );
    expect(deps.audit).toHaveBeenLastCalledWith(
      deps.client,
      expect.objectContaining({ operatorId: "system" }),
      "product.image_autofilled",
      "product",
      "product_a",
      expect.objectContaining({ merchantId: "merchant_a", storeId: "store_a" }),
    );
  });

  it("records skipped/failed provider outcomes but never overwrites a concurrent image", async () => {
    process.env.PRODUCT_IMAGE_AUTOFILL_PROVIDER = "tavily";
    deps.queryOne.mockResolvedValueOnce(snapshot());
    deps.client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await handleProductImageAutofillRequestedOnReadySchema({ productId: "product_a", merchantId: "merchant_a" });
    expect(deps.client.query.mock.calls[0][1][2]).toContain('"status":"skipped"');
    expect(deps.audit).toHaveBeenLastCalledWith(
      deps.client, expect.any(Object), "product.image_autofill_skipped", "product", "product_a", expect.any(Object),
    );

    process.env.TAVILY_API_KEY = "redacted-test-key";
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("provider secret detail")) as typeof fetch;
    deps.queryOne.mockReset();
    deps.queryOne.mockResolvedValueOnce(snapshot());
    deps.client.query.mockClear();
    deps.client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await handleProductImageAutofillRequestedOnReadySchema({ productId: "product_a", merchantId: "merchant_a" });
    expect(deps.client.query.mock.calls[0][1][2]).toContain('"status":"failed"');
    expect(deps.client.query.mock.calls[0][1][2]).not.toContain("provider secret detail");

    deps.queryOne.mockReset();
    deps.queryOne.mockResolvedValueOnce(snapshot());
    deps.client.query.mockClear();
    deps.audit.mockClear();
    deps.client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await handleProductImageAutofillRequestedOnReadySchema({ productId: "product_a", merchantId: "merchant_a" });
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("reduces provider errors to a stable non-secret reason", () => {
    const error = Object.assign(new Error("secret"), { code: "RATE_LIMITED" });
    expect(productImageAutofillFailureReason(error)).toBe("provider_error:RATE_LIMITED");
  });
});
