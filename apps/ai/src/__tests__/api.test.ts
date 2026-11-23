import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as applicationNamespace from "@medusa-snus/application";
import { buildServer, requiredChannelPermissionForRequest, requiredRoleForRequest } from "../index.js";
import {
  bestResearchSource,
  customerSelectorForOrderDraft,
  buildVisionOcrProductSearchResponse,
  normalizeTavilyProductResearch,
  normalizeGoogleProductSearchDetections,
  normalizeGoogleProductSearchResponse,
  rankCatalogByOcrText,
  shouldIncludePendingVisionOcrReferenceImages,
  normalizeModelOrderDraftPayload,
  orderTextWithoutCustomerSelector,
  orderDraftClarification,
  parseOrderDraftPaymentMethod,
  parseOrderDraftQuantity,
  searchQueryForOrderDraft,
  selectOrderDraftCustomer,
} from "../routes/index.js";

const applicationModule = ((applicationNamespace as unknown as { default?: typeof import("@medusa-snus/application") }).default ?? applicationNamespace) as typeof import("@medusa-snus/application");
const { signJwt } = applicationModule as typeof import("@medusa-snus/application");

let server: Awaited<ReturnType<typeof buildServer>>;
const originalPackage = process.env.APP_PACKAGE_KEY;
const originalFlags = process.env.FEATURE_FLAGS;

beforeAll(async () => {
  server = await buildServer();
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  if (originalPackage === undefined) delete process.env.APP_PACKAGE_KEY;
  else process.env.APP_PACKAGE_KEY = originalPackage;
  if (originalFlags === undefined) delete process.env.FEATURE_FLAGS;
  else process.env.FEATURE_FLAGS = originalFlags;
});

describe("AI Module API offline gate", () => {
  it("returns health without auth", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok", service: "ai-module" });
  });

  it("returns health at the public /ai/health alias", async () => {
    const res = await server.inject({ method: "GET", url: "/ai/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).service).toBe("ai-module");
  });

  it("returns 401 before touching DB when auth is missing", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/ai/reply-draft",
      payload: { customerMessage: "Hello" },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("unauthorized");
  });

  it("returns 400 before touching DB when request body is invalid", async () => {
    const token = signJwt({
      operatorId: "op_staff",
      role: "staff",
      displayName: "Staff",
      organizationId: "org_default",
    });
    const res = await server.inject({
      method: "POST",
      url: "/ai/reply-draft",
      headers: { authorization: `Bearer ${token}` },
      payload: { customerMessage: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("validation_error");
  });

  it("returns 403 for channel access to routes without channel permission mapping", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/ai/reply-draft",
      headers: {
        authorization: "Bearer test-token",
        "x-channel": "telegram",
        "x-channel-user-id": "123",
      },
      payload: { customerMessage: "Hello" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("forbidden");
  });

  it("maps vision routes to staff role and vision_scan:use channel permission", () => {
    expect(requiredRoleForRequest("POST", "/ai/vision/product-search")).toBe("staff");
    expect(requiredChannelPermissionForRequest("POST", "/ai/vision/product-search")).toBe("vision_scan:use");
  });

  it("normalizes Google Product Search candidates from product labels", () => {
    const candidates = normalizeGoogleProductSearchResponse({
      responses: [{
        productSearchResults: {
          results: [{
            score: 0.91,
            image: "projects/p/locations/asia-east1/products/prod_1/referenceImages/img_1",
            product: {
              name: "projects/p/locations/asia-east1/products/var_1",
              productLabels: [
                { key: "variantId", value: "var_1" },
                { key: "sku", value: "VEL-CRISPY-PEPPERMINT" },
              ],
            },
          }],
        },
      }],
    });

    expect(candidates).toEqual([expect.objectContaining({
      variantId: "var_1",
      sku: "VEL-CRISPY-PEPPERMINT",
      providerProductRef: "projects/p/locations/asia-east1/products/var_1",
      confidence: 0.91,
    })]);
  });

  it("normalizes Google Product Search grouped detections with bounding boxes", () => {
    const detections = normalizeGoogleProductSearchDetections({
      responses: [{
        productSearchResults: {
          productGroupedResults: [{
            boundingPoly: {
              normalizedVertices: [{ x: 0.45, y: 0.1 }, { x: 0.8, y: 0.1 }, { x: 0.8, y: 0.5 }, { x: 0.45, y: 0.5 }],
            },
            results: [{
              score: 0.84,
              product: {
                name: "projects/p/locations/asia-east1/products/var_b",
                productLabels: [{ key: "variantId", value: "var_b" }, { key: "sku", value: "B-SKU" }],
              },
            }],
          }, {
            boundingPoly: {
              normalizedVertices: [{ x: 0.05, y: 0.1 }, { x: 0.35, y: 0.1 }, { x: 0.35, y: 0.5 }, { x: 0.05, y: 0.5 }],
            },
            results: [{
              score: 0.91,
              product: {
                name: "projects/p/locations/asia-east1/products/var_a",
                productLabels: [{ key: "variantId", value: "var_a" }, { key: "sku", value: "A-SKU" }],
              },
            }],
          }],
        },
      }],
    });

    expect(detections).toHaveLength(2);
    expect(detections[0]).toMatchObject({
      objectId: "obj_1",
      bbox: expect.objectContaining({ source: "product_search" }),
      candidates: [expect.objectContaining({ variantId: "var_a", confidence: 0.91 })],
    });
    expect(detections[1]).toMatchObject({
      objectId: "obj_2",
      candidates: [expect.objectContaining({ variantId: "var_b" })],
    });
  });

  it("ranks catalog variants from Google Vision OCR text", () => {
    const candidates = rankCatalogByOcrText("VELO CRISPY PEPPERMINT 10MG", [{
      id: "prod_1",
      title: "VELO Crispy Peppermint",
      variants: [{ id: "var_1", sku: "VEL-CRISPY-PEPPERMINT", barcode: "" }],
    }, {
      id: "prod_2",
      title: "ZYN Mini Spearmint",
      variants: [{ id: "var_2", sku: "ZYN-MINI-SPEARMINT", barcode: "" }],
    }]);

    expect(candidates[0]).toMatchObject({
      productId: "prod_1",
      variantId: "var_1",
      sku: "VEL-CRISPY-PEPPERMINT",
    });
    expect(candidates[0].confidence).toBeGreaterThan(candidates[1]?.confidence || 0);
  });

  it("does not expose raw OCR text in vision search responses", () => {
    const response = buildVisionOcrProductSearchResponse({
      modelVersion: "google_vision_ocr:text_detection:v1",
      location: "asia-east1",
      candidates: [{
        productId: "prod_1",
        variantId: "var_1",
        sku: "VEL-CRISPY-PEPPERMINT",
        confidence: 0.9,
        warnings: ["ocr_fuzzy_match"],
      }],
    });

    expect(response).toMatchObject({
      provider: "google_vision_ocr",
      modelVersion: "google_vision_ocr:text_detection:v1",
      location: "asia-east1",
      productSet: "",
      candidates: [expect.objectContaining({ variantId: "var_1" })],
    });
    expect(response).not.toHaveProperty("ocrText");
    expect(JSON.stringify(response)).not.toContain("CRISPY PEPPERMINT 10MG");
  });

  it("keeps pending OCR reference images disabled unless explicitly enabled", () => {
    expect(shouldIncludePendingVisionOcrReferenceImages({} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldIncludePendingVisionOcrReferenceImages({
      VISION_OCR_INCLUDE_PENDING_REFERENCE_IMAGES: "false",
    } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldIncludePendingVisionOcrReferenceImages({
      VISION_OCR_INCLUDE_PENDING_REFERENCE_IMAGES: "true",
    } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("does not let repeated background brand text outrank a fuller OCR product match", () => {
    const candidates = rankCatalogByOcrText([
      "NICOTINE POUCHES",
      "VELO",
      "CRISPY PEPPERMINT",
      "KILLA",
      "KILLA",
      "MEDIUM",
      "FLAVOR",
      "CRISPY",
      "PEPPERMINT",
      "10mg",
    ].join("\\n"), [{
      id: "prod_killa",
      title: "KILLA Apple",
      variants: [{ id: "var_killa", sku: "KLA-APPLE", barcode: "" }],
    }, {
      id: "prod_velo",
      title: "VELO Crispy Peppermint",
      variants: [{ id: "var_velo", sku: "VEL-CRISPY-PEPPERMINT", barcode: "" }],
    }]);

    expect(candidates[0]).toMatchObject({
      productId: "prod_velo",
      variantId: "var_velo",
      sku: "VEL-CRISPY-PEPPERMINT",
    });
    expect(candidates[0].confidence).toBeGreaterThan(candidates[1]?.confidence || 0);
  });

  it("blocks product research and Telegram order drafting for Basic package", async () => {
    process.env.APP_PACKAGE_KEY = "basic";
    delete process.env.FEATURE_FLAGS;
    const token = signJwt({
      operatorId: "op_owner",
      role: "owner",
      displayName: "Owner",
      organizationId: "org_default",
    });

    const research = await server.inject({
      method: "POST",
      url: "/ai/product-research",
      headers: { authorization: `Bearer ${token}` },
      payload: { productId: "prod_mint" },
    });
    expect(research.statusCode).toBe(403);
    expect(JSON.parse(research.body).error).toMatchObject({
      code: "feature_not_entitled",
      details: { feature: "product_research", packageKey: "basic" },
    });

    const orderDraft = await server.inject({
      method: "POST",
      url: "/ai/order-draft",
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "2 mint medium" },
    });
    expect(orderDraft.statusCode).toBe(403);
    expect(JSON.parse(orderDraft.body).error).toMatchObject({
      code: "feature_not_entitled",
      details: { feature: "telegram_ai_ordering", packageKey: "basic" },
    });
  });

  it("parses AI order payment hints without polluting product search query", () => {
    expect(parseOrderDraftPaymentMethod("2 hop mint medium chuyen khoan QR")).toBe("sepay_va");
    expect(parseOrderDraftPaymentMethod("1 citrus usdt")).toBe("nowpayments");
    expect(parseOrderDraftPaymentMethod("1 mint giao hang")).toBe("cod");
    expect(searchQueryForOrderDraft("2 hop mint medium chuyen khoan QR")).toBe("mint medium");
    expect(searchQueryForOrderDraft("mint x1 qr")).toBe("mint");
    expect(searchQueryForOrderDraft("MINT-MED-20 x1 qr")).toBe("MINT-MED-20");
    expect(parseOrderDraftQuantity("MINT-MED-20 x1 qr")).toBe(1);
    expect(parseOrderDraftQuantity("2 hop MINT-MED-20 qr")).toBe(2);
    expect(parseOrderDraftQuantity("MINT-MED-20 qr")).toBe(1);
  });

  it("resolves an explicitly identified customer and clarifies an ambiguous customer", () => {
    expect(customerSelectorForOrderDraft("2 mint medium customer=0901234567 qr")).toBe("0901234567");
    expect(customerSelectorForOrderDraft("2 mint medium 0901234567 qr")).toBe("0901234567");
    expect(orderTextWithoutCustomerSelector("2 mint medium customer=0901234567 qr")).toBe("2 mint medium qr");
    expect(searchQueryForOrderDraft("2 mint medium customer=0901234567 qr")).toBe("mint medium");

    expect(selectOrderDraftCustomer("0901234567", [
      { id: "cus_1", phone: "0901234567", first_name: "An", last_name: "Nguyen" },
    ])).toEqual({ customerId: "cus_1" });

    expect(selectOrderDraftCustomer("an", [
      { id: "cus_1", phone: "0901234567", first_name: "An", last_name: "Nguyen" },
      { id: "cus_2", phone: "0907654321", first_name: "An", last_name: "Tran" },
    ])).toMatchObject({
      clarification: {
        type: "customer",
        options: [{ customerId: "cus_1" }, { customerId: "cus_2" }],
      },
    });
  });

  it("normalizes model order drafts only when the catalog variant is valid and in stock", () => {
    const catalog = [
      { productId: "prod_mint", productName: "Mint Medium Pouch", variantId: "var_mint_20", sku: "MINT-MED-20", stock: 4 },
      { productId: "prod_mint_slim", productName: "Mint Slim Pack", variantId: "var_mint_slim_20", sku: "MINT-SLIM-20", stock: 4 },
      { productId: "prod_old", productName: "Old Mint", variantId: "var_old", sku: "OLD-MINT", stock: 0 },
    ];

    expect(normalizeModelOrderDraftPayload({
      variantId: "var_mint_20",
      sku: "MINT-MED-20",
      quantity: 2,
      paymentMethod: "sepay_va",
      confidence: 0.88,
      queryText: "mint medium",
    }, catalog, "MINT-MED-20 x2 qr")).toMatchObject({
      variantId: "var_mint_20",
      quantity: 2,
      paymentMethod: "sepay_va",
      sku: "MINT-MED-20",
    });

    expect(normalizeModelOrderDraftPayload({ variantId: "var_fake", quantity: 1, confidence: 0.99 }, catalog, "fake x1")).toBeNull();
    expect(normalizeModelOrderDraftPayload({ variantId: "var_old", quantity: 1, confidence: 0.99 }, catalog, "old mint x1")).toBeNull();
    expect(normalizeModelOrderDraftPayload({ variantId: "var_mint_20", quantity: 5, confidence: 0.99 }, catalog, "mint x5")).toBeNull();
    expect(normalizeModelOrderDraftPayload({ variantId: "var_mint_20", quantity: 1, confidence: 0.2 }, catalog, "mint x1")).toBeNull();
    expect(normalizeModelOrderDraftPayload({ variantId: "var_mint_20", quantity: 1, confidence: 0.99 }, catalog, "mint x1 qr")).toBeNull();
  });

  it("builds order draft clarification options with in-stock SKUs first", () => {
    const clarification = orderDraftClarification("mint", [
      {
        id: "prod_oos",
        title: "Mint Old",
        status: "published",
        categories: [],
        variants: [{ id: "var_oos", sku: "MINT-OOS", barcode: "", prices: [{ amount: 200000 }], inventory_quantity: 0 }],
      },
      {
        id: "prod_mint",
        title: "Mint Medium",
        status: "published",
        categories: [],
        variants: [{ id: "var_mint", sku: "MINT-MED", barcode: "", prices: [{ amount: 250000 }], inventory_quantity: 8 }],
      },
    ]);

    expect(clarification.options[0]).toMatchObject({ sku: "MINT-MED", stock: 8 });
    expect(clarification.message).toContain("Multiple product candidates");
  });

  it("selects a best product research source for the operator workspace", () => {
    expect(bestResearchSource([
      { title: "", url: "", snippet: "bad", rank: 1 },
      { title: "Source A", url: "https://example.com/a", snippet: "review source", language: "en", rank: 2 },
    ])).toEqual({
      title: "Source A",
      url: "https://example.com/a",
      snippet: "review source",
      content: "",
      language: "en",
      rank: 2,
    });
    expect(bestResearchSource([])).toBeNull();
  });

  it("keeps Tavily source excerpts and the effective Vietnamese query for the product workspace", () => {
    const result = normalizeTavilyProductResearch({
      answer: "Coffee Medium có kết quả nguồn để operator đối chiếu.",
      results: [{
        title: "Thông tin Coffee Medium",
        url: "https://example.vn/coffee-medium",
        content: "Đoạn tóm tắt từ kết quả tìm kiếm.",
        raw_content: "# Coffee Medium\n\nThông tin chi tiết được Tavily trích xuất từ nguồn.",
      }],
    }, "Coffee Medium", "Coffee Medium thông tin sản phẩm", "vi");

    expect(result).toMatchObject({
      query: "Coffee Medium thông tin sản phẩm",
      confidence: "medium",
      summary: "Coffee Medium có kết quả nguồn để operator đối chiếu.",
    });
    expect(result.sources[0]).toMatchObject({
      title: "Thông tin Coffee Medium",
      language: "vi",
      snippet: "Đoạn tóm tắt từ kết quả tìm kiếm.",
      content: "# Coffee Medium\n\nThông tin chi tiết được Tavily trích xuất từ nguồn.",
    });

    const noSourceResult = normalizeTavilyProductResearch({}, "Coffee Medium", "Coffee Medium", "vi");
    expect(noSourceResult).toMatchObject({
      confidence: "low",
      sources: [],
      summary: "Coffee Medium: Tavily did not return a usable source for this query.",
    });
  });

  it("uses read permission for cached product research and run permission only for new research", () => {
    expect(requiredRoleForRequest("GET", "/ai/product-research/prod_mint/latest")).toBe("staff");
    expect(requiredChannelPermissionForRequest("GET", "/ai/product-research/prod_mint/latest")).toBe("product_research:read");

    expect(requiredRoleForRequest("POST", "/ai/product-research")).toBe("manager");
    expect(requiredChannelPermissionForRequest("POST", "/ai/product-research")).toBe("product_research:run");
    expect(requiredChannelPermissionForRequest("POST", "/ai/telegram-sales/order-draft")).toBeNull();
  });
});
