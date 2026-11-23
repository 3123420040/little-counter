import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => {
  class PlatformError extends Error {
    code: string;
    statusCode: number;
    details?: unknown;

    constructor(code: string, message: string, statusCode = 500, details?: unknown) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
      this.details = details;
    }
  }

  return {
    acknowledgeAiAlert: vi.fn(),
    adjustStock: vi.fn(),
    approveAiAction: vi.fn(),
    commitUsage: vi.fn(),
    completeSale: vi.fn(),
    createPaymentIntent: vi.fn(),
    createPurchaseOrder: vi.fn(),
    enforceRateLimit: vi.fn(),
    getAiRecommendations: vi.fn(),
    listAiAlerts: vi.fn(),
    listAiReviewQueue: vi.fn(),
    listCustomers: vi.fn(),
    listProducts: vi.fn(),
    listVisionReferenceImagesForProvider: vi.fn(),
    persistReplyDraft: vi.fn(),
    PlatformError,
    rejectAiAction: vi.fn(),
    releaseUsage: vi.fn(),
    requireActorPermission: vi.fn(),
    requireFeature: vi.fn(),
    requireMutationScope: vi.fn(),
    requireReadableReportScope: vi.fn(),
    requireRole: vi.fn(),
    reserveUsage: vi.fn(),
    resolveChannelActor: vi.fn(),
    verifyJwt: vi.fn(),
  };
});

const provider = vi.hoisted(() => ({
  normalizeGoogleProductSearchResponse: vi.fn(),
  rankCatalogByOcrText: vi.fn(),
  runGoogleProductSearch: vi.fn(),
  runGoogleVisionObjectLocalization: vi.fn(),
  runGoogleVisionOcr: vi.fn(),
}));

vi.mock("@medusa-snus/application", () => ({ ...app, default: app }));
vi.mock("../services/google-product-search-provider.js", () => provider);

import { buildServer } from "../index.js";

let server: Awaited<ReturnType<typeof buildServer>>;
const originalEnv = { ...process.env };

function forbiddenMutationSpies() {
  return [
    app.acknowledgeAiAlert,
    app.adjustStock,
    app.approveAiAction,
    app.commitUsage,
    app.completeSale,
    app.createPaymentIntent,
    app.createPurchaseOrder,
    app.getAiRecommendations,
    app.listAiAlerts,
    app.listAiReviewQueue,
    app.listCustomers,
    app.listProducts,
    app.persistReplyDraft,
    app.rejectAiAction,
    app.releaseUsage,
    app.reserveUsage,
  ];
}

describe("AI vision product search route", () => {
  beforeAll(async () => {
    server = await buildServer();
    await server.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      VISION_PROVIDER: "google_vision_ocr",
      VISION_OCR_INCLUDE_PENDING_REFERENCE_IMAGES: "true",
      GOOGLE_PRODUCT_SEARCH_LOCATION: "asia-east1",
    };
    app.verifyJwt.mockReturnValue({
      operatorId: "op_staff",
      role: "staff",
      displayName: "Staff",
      organizationId: "org_default",
    });
    app.requireRole.mockReturnValue(true);
    app.requireActorPermission.mockResolvedValue(undefined);
    app.requireMutationScope.mockResolvedValue({
      merchantId: "merchant_a",
      storeId: "store_a",
    });
    for (const spy of forbiddenMutationSpies()) {
      spy.mockImplementation(() => {
        throw new Error("Vision product-search route must not call mutation collaborators");
      });
    }
    app.listVisionReferenceImagesForProvider.mockResolvedValue([{
      productId: "prod_velo",
      variantId: "var_velo",
      title: "VELO Crispy Peppermint",
      sku: "VEL-CRISPY-PEPPERMINT",
      barcode: "",
    }]);
    provider.runGoogleVisionOcr.mockResolvedValue({
      text: "VELO CRISPY PEPPERMINT",
      modelVersion: "google_vision_ocr:text_detection:v1",
    });
    provider.runGoogleVisionObjectLocalization.mockResolvedValue({
      detections: [{
        objectId: "obj_1",
        bbox: {
          source: "object_localization",
          normalizedVertices: [{ x: 0.1, y: 0.1 }, { x: 0.8, y: 0.1 }, { x: 0.8, y: 0.8 }, { x: 0.1, y: 0.8 }],
        },
        objectLabel: "Packaged goods",
        objectConfidence: 0.76,
        warnings: [],
      }],
      modelVersion: "google_vision_object_localization:v1",
    });
    provider.rankCatalogByOcrText.mockReturnValue([{
      productId: "prod_velo",
      variantId: "var_velo",
      sku: "VEL-CRISPY-PEPPERMINT",
      confidence: 0.9,
      warnings: ["ocr_fuzzy_match"],
    }]);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(async () => {
    await server.close();
  });

  it("uses only vision auth, scope, provider OCR, and catalog read collaborators", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/ai/vision/product-search",
      headers: { authorization: "Bearer test-token" },
      payload: { imageBase64: "data:image/jpeg;base64,/9j/2wBD" },
    });

    expect(response.statusCode).toBe(200);
    expect(app.enforceRateLimit).toHaveBeenCalledWith(expect.anything(), "ai");
    expect(app.requireActorPermission).toHaveBeenCalledWith(expect.objectContaining({ operatorId: "op_staff" }), "vision_scan:use");
    expect(app.requireMutationScope).toHaveBeenCalledWith(expect.objectContaining({ operatorId: "op_staff" }), expect.anything());
    expect(provider.runGoogleVisionOcr).toHaveBeenCalledWith({ imageBase64: "data:image/jpeg;base64,/9j/2wBD" });
    expect(provider.runGoogleVisionObjectLocalization).toHaveBeenCalledWith({ imageBase64: "data:image/jpeg;base64,/9j/2wBD" });
    expect(app.listVisionReferenceImagesForProvider).toHaveBeenCalledWith({
      merchantId: "merchant_a",
      storeId: "store_a",
      provider: "google_vision_ocr",
      includePending: true,
      limit: 500,
    });
    expect(provider.rankCatalogByOcrText).toHaveBeenCalledWith("VELO CRISPY PEPPERMINT", [{
      id: "prod_velo",
      title: "VELO Crispy Peppermint",
      variants: [{ id: "var_velo", sku: "VEL-CRISPY-PEPPERMINT", barcode: "" }],
    }]);
    expect(JSON.parse(response.body).data).toMatchObject({
      provider: "google_vision_ocr",
      modelVersion: "google_vision_ocr:text_detection:v1+google_vision_object_localization:v1",
      location: "asia-east1",
      candidates: [expect.objectContaining({ variantId: "var_velo" })],
      detections: [expect.objectContaining({
        objectId: "obj_1",
        candidates: [expect.objectContaining({ variantId: "var_velo" })],
      })],
    });

    for (const spy of forbiddenMutationSpies()) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
