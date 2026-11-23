import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  client: { query: vi.fn() },
  ensurePlatformSchema: vi.fn(),
}));

const entitlement = vi.hoisted(() => ({
  requireFeatureCapability: vi.fn(),
}));

const qr = vi.hoisted(() => ({
  resolveProductScan: vi.fn(),
}));

vi.mock("../db/schema", () => ({
  ensurePlatformSchema: db.ensurePlatformSchema,
}));

vi.mock("../db/transaction", () => ({
  withConnectedClient: vi.fn(async (handler: (client: typeof db.client) => Promise<unknown>) => handler(db.client)),
  withConnectedTransaction: vi.fn(async (handler: (client: typeof db.client) => Promise<unknown>) => handler(db.client)),
}));
vi.mock("../services/business-lifecycle-service", () => ({ lockActiveBusinessScopeForClient: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../services/feature-entitlement-service", () => entitlement);
vi.mock("../services/product-qr-service", () => qr);

import { listVisionScanReport, recordVisionScanCorrection, scanVisionProducts } from "../services/vision-scan-service";
import { PlatformError } from "../errors/platform-error";

const originalEnv = { ...process.env };
const scope = { scopeKind: "operating" as const, merchantId: "merchant_a", storeId: "store_a", stockLocationId: "sloc_a" };
const actor = { operatorId: "op_staff", role: "staff", type: "staff" };
const jpegDataUrl = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]).toString("base64")}`;

function mockCommonQueries() {
  db.client.query.mockImplementation(async (sql: string) => {
    if (sql.includes("count(*)::int AS count") && sql.includes("app.vision_scan_events")) {
      return { rows: [{ count: 0 }] };
    }
    if (sql.includes("INSERT INTO app.vision_scan_events")) {
      return { rows: [{ id: "scan_1" }] };
    }
    if (sql.includes("INSERT INTO app.vision_scan_detections")) {
      return { rows: [{ id: "det_1" }] };
    }
    return { rows: [] };
  });
}

function normalizedSqlCalls(): string {
  return db.client.query.mock.calls
    .map(([sql]) => String(sql).replace(/\s+/g, " ").trim().toLowerCase())
    .join("\n");
}

function expectNoCommerceMutationQueries() {
  const sql = normalizedSqlCalls();
  const forbidden = [
    /\b(insert|update|delete)\s+(into\s+)?public\.order\b/,
    /\b(insert|update|delete)\s+(into\s+)?public\.order_/,
    /\b(insert|update|delete)\s+(into\s+)?app\.payment_entries\b/,
    /\b(insert|update|delete)\s+(into\s+)?public\.payment\b/,
    /\b(insert|update|delete)\s+(into\s+)?public\.payment_/,
    /\b(insert|update|delete)\s+(into\s+)?public\.inventory_level\b/,
    /\b(insert|update|delete)\s+(into\s+)?medusa\.stock_movements\b/,
    /\b(insert|update|delete)\s+(into\s+)?app\.stock_movements\b/,
    /stock\.changed/,
  ];
  for (const pattern of forbidden) {
    expect(sql).not.toMatch(pattern);
  }
}

describe("vision scan service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      VISION_FEATURE_ENABLED: "true",
      VISION_KILL_SWITCH: "false",
      VISION_PROVIDER: "noop",
      VISION_POS_SINGLE_CAPTURE_ENABLED: "true",
      VISION_POS_BULK_CAPTURE_ENABLED: "false",
      VISION_DAILY_SCAN_LIMIT_PER_STORE: "300",
      VISION_SCAN_RATE_LIMIT_WINDOW_SECONDS: "60",
      VISION_SCAN_RATE_LIMIT_PER_OPERATOR: "30",
      VISION_MONTHLY_BUDGET_VND: "",
      VISION_ESTIMATED_PROVIDER_SCAN_COST_VND: "200",
    };
    entitlement.requireFeatureCapability.mockResolvedValue({ allowed: true });
    mockCommonQueries();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("records a QR-first exact match without provider candidates", async () => {
    qr.resolveProductScan.mockResolvedValueOnce({
      data: {
        context: "pos_add_to_cart",
        resolutionSource: "qr",
        qrCodeId: "qr_1",
        productId: "prod_1",
        variantId: "var_1",
        inventoryItemId: "ii_1",
        title: "VEL Crispy Peppermint",
        imageUrl: "https://cdn.example/vel.jpg",
        status: "published",
        sku: "VEL-CRISPY-PEPPERMINT",
        barcode: "",
        price: 120000,
        stock: 10,
      },
    });

    const result = await scanVisionProducts({
      imageHash: "hash_1",
      qrCodes: ["https://snus.example/s/default/main/p/vel"],
    }, scope, actor);

    expect(entitlement.requireFeatureCapability).toHaveBeenCalledWith("vision_pos_input", { merchantId: "merchant_a", client: db.client });
    expect(entitlement.requireFeatureCapability).toHaveBeenCalledWith("vision_pos_single_capture", { merchantId: "merchant_a", client: db.client });
    expect(qr.resolveProductScan).toHaveBeenCalledWith(
      { code: "https://snus.example/s/default/main/p/vel", context: "pos_add_to_cart" },
      scope,
      { operatorId: "op_staff", type: "staff", role: "staff" },
      { client: db.client },
    );
    expect(result.data).toMatchObject({
      scanId: "scan_1",
      status: "success",
      provider: "qr_first",
      requiresStaffConfirmation: true,
    });
    expect(result.data.detections[0]).toMatchObject({
      detectionId: "det_1",
      source: "qr",
      detectionType: "exact_match",
      resolvedVariantId: "var_1",
      decision: "pending",
    });
    expectNoCommerceMutationQueries();
  });

  it("hydrates provider candidates by variant id when QR does not resolve", async () => {
    qr.resolveProductScan.mockRejectedValueOnce(new PlatformError("resource_not_found", "not found", 404));
    db.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("count(*)::int AS count") && sql.includes("app.vision_scan_events")) return { rows: [{ count: 0 }] };
      if (sql.includes("SELECT DISTINCT ON (v.id)")) {
        return {
          rows: [{
            product_id: "prod_2",
            variant_id: "var_2",
            title: "ZYN Mini Spearmint",
            image_url: "https://cdn.example/zyn.jpg",
            sku: "ZYN-MINI-SPEARMINT",
            barcode: "",
            price: 99000,
            stock: 5,
          }],
        };
      }
      if (sql.includes("INSERT INTO app.vision_scan_events")) return { rows: [{ id: "scan_2" }] };
      if (sql.includes("INSERT INTO app.vision_scan_detections")) return { rows: [{ id: "det_2" }] };
      return { rows: [] };
    });

    const result = await scanVisionProducts({
      imageHash: "hash_2",
      qrCodes: ["unresolved"],
      providerCandidates: [{ variantId: "var_2", confidence: 0.82 }],
    }, scope, actor, { allowProviderCandidates: true });

    expect(result.data.scanId).toBe("scan_2");
    expect(result.data.detections[0]).toMatchObject({
      detectionId: "det_2",
      source: "vision_provider",
      detectionType: "candidate_match",
      resolvedVariantId: "var_2",
    });
    expect(result.data.detections[0].candidates[0]).toMatchObject({
      sku: "ZYN-MINI-SPEARMINT",
      confidence: 0.82,
    });
    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("JOIN public.product_variant_inventory_item pvii"),
      expect.any(Array),
    );
    expectNoCommerceMutationQueries();
  });

  it("combines provider candidates from multiple images in one scan request", async () => {
    process.env.VISION_PROVIDER = "google_vision_ocr";
    const secondJpegDataUrl = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x44]).toString("base64")}`;
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as { imageBase64?: string };
      const variantId = body.imageBase64 === secondJpegDataUrl ? "var_3" : "var_2";
      return new Response(JSON.stringify({
        data: {
          modelVersion: "google_vision_ocr:text_detection:v1",
          candidates: [{ variantId, confidence: variantId === "var_2" ? 0.91 : 0.84 }],
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    qr.resolveProductScan.mockRejectedValueOnce(new PlatformError("resource_not_found", "not found", 404));
    db.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("count(*)::int AS count") && sql.includes("app.vision_scan_events")) return { rows: [{ count: 0 }] };
      if (sql.includes("SELECT DISTINCT ON (v.id)")) {
        return {
          rows: [
            {
              product_id: "prod_2",
              variant_id: "var_2",
              title: "VELO Crispy Peppermint",
              image_url: "https://cdn.example/vel.jpg",
              sku: "VEL-CRISPY-PEPPERMINT",
              barcode: "",
              price: 180000,
              stock: 15,
            },
            {
              product_id: "prod_3",
              variant_id: "var_3",
              title: "ZYN Menthol Ice",
              image_url: "https://cdn.example/zyn.jpg",
              sku: "ZSE-SLIM-MENTHOL-ICE-16",
              barcode: "",
              price: 230000,
              stock: 100,
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO app.vision_scan_events")) return { rows: [{ id: "scan_multi" }] };
      if (sql.includes("INSERT INTO app.vision_scan_detections")) return { rows: [{ id: "det_multi" }] };
      return { rows: [] };
    });

    const result = await scanVisionProducts({
      mode: "single",
      imageBase64List: [jpegDataUrl, secondJpegDataUrl],
    }, scope, actor);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.data).toMatchObject({
      scanId: "scan_multi",
      mode: "single",
      status: "success",
      provider: "google_vision_ocr",
    });
    expect(result.data.detections[0].candidates.map((candidate) => candidate.sku)).toEqual([
      "VEL-CRISPY-PEPPERMINT",
      "ZSE-SLIM-MENTHOL-ICE-16",
    ]);
    expectNoCommerceMutationQueries();
  });

  it("persists multiple provider detections with bounding boxes from the sidecar", async () => {
    process.env.VISION_PROVIDER = "google_vision_ocr";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: {
        modelVersion: "google_vision_ocr:text_detection:v1+google_vision_object_localization:v1",
        candidates: [{ variantId: "var_left", confidence: 0.91 }, { variantId: "var_right", confidence: 0.84 }],
        detections: [{
          objectId: "obj_left",
          bbox: { source: "object_localization", normalizedVertices: [{ x: 0.05, y: 0.1 }, { x: 0.35, y: 0.1 }, { x: 0.35, y: 0.5 }, { x: 0.05, y: 0.5 }] },
          candidates: [{ variantId: "var_left", confidence: 0.91 }],
        }, {
          objectId: "obj_right",
          bbox: { source: "object_localization", normalizedVertices: [{ x: 0.45, y: 0.1 }, { x: 0.8, y: 0.1 }, { x: 0.8, y: 0.5 }, { x: 0.45, y: 0.5 }] },
          candidates: [{ variantId: "var_right", confidence: 0.84 }],
        }],
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    qr.resolveProductScan.mockRejectedValueOnce(new PlatformError("resource_not_found", "not found", 404));
    let insertedDetectionCount = 0;
    db.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("count(*)::int AS count") && sql.includes("app.vision_scan_events")) return { rows: [{ count: 0 }] };
      if (sql.includes("SELECT DISTINCT ON (v.id)")) {
        const variantIds = Array.isArray(params?.[2]) ? params?.[2] as string[] : [];
        if (variantIds.includes("var_left")) {
          return {
            rows: [{
              product_id: "prod_left",
              variant_id: "var_left",
              title: "Left Product",
              image_url: "",
              sku: "LEFT",
              barcode: "",
              price: 100000,
              stock: 3,
            }],
          };
        }
        return {
          rows: [{
            product_id: "prod_right",
            variant_id: "var_right",
            title: "Right Product",
            image_url: "",
            sku: "RIGHT",
            barcode: "",
            price: 110000,
            stock: 4,
          }],
        };
      }
      if (sql.includes("INSERT INTO app.vision_scan_events")) return { rows: [{ id: "scan_objects" }] };
      if (sql.includes("INSERT INTO app.vision_scan_detections")) {
        insertedDetectionCount += 1;
        return { rows: [{ id: `det_${insertedDetectionCount}` }] };
      }
      return { rows: [] };
    });

    const result = await scanVisionProducts({ imageBase64: jpegDataUrl }, scope, actor);

    expect(result.data.status).toBe("success");
    expect(result.data.detections).toHaveLength(2);
    expect(result.data.detections[0]).toMatchObject({
      detectionId: "det_1",
      objectId: "obj_left",
      bbox: expect.objectContaining({ source: "object_localization" }),
      candidates: [expect.objectContaining({ variantId: "var_left" })],
    });
    expect(result.data.detections[1]).toMatchObject({
      detectionId: "det_2",
      objectId: "obj_right",
      candidates: [expect.objectContaining({ variantId: "var_right" })],
    });
    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO app.vision_scan_detections"),
      expect.arrayContaining([expect.stringContaining("object_localization")]),
    );
    expectNoCommerceMutationQueries();
  });

  it("ignores client-supplied provider candidates unless the internal seam is enabled", async () => {
    qr.resolveProductScan.mockRejectedValueOnce(new PlatformError("resource_not_found", "not found", 404));

    const result = await scanVisionProducts({
      imageHash: "hash_untrusted",
      qrCodes: ["unresolved"],
      providerCandidates: [{ variantId: "var_spoofed", confidence: 0.99 }],
    }, scope, actor);

    expect(result.data).toMatchObject({
      scanId: "scan_1",
      status: "failed",
      provider: "noop",
    });
    expect(result.data.detections[0]).toMatchObject({
      detectionType: "unresolved",
      decision: "unresolved",
      candidates: [],
      warnings: ["provider_noop"],
    });
    expect(db.client.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SELECT DISTINCT ON (v.id)"),
      expect.any(Array),
    );
    expectNoCommerceMutationQueries();
  });

  it("fails closed when feature flag is off", async () => {
    process.env.VISION_FEATURE_ENABLED = "false";

    await expect(scanVisionProducts({ imageHash: "hash_3" }, scope, actor)).rejects.toThrow("Vision scan feature is disabled");
    expect(db.client.query).not.toHaveBeenCalled();
  });

  it("fails closed through the kill switch before provider calls or DB writes", async () => {
    process.env.VISION_KILL_SWITCH = "true";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(scanVisionProducts({ imageBase64: jpegDataUrl }, scope, actor)).rejects.toMatchObject({
      code: "vision_disabled",
      statusCode: 503,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.client.query).not.toHaveBeenCalled();
  });

  it("rejects invalid image payloads before DB scan writes", async () => {
    await expect(scanVisionProducts({
      imageBase64: Buffer.from("plain text").toString("base64"),
    }, scope, actor)).rejects.toThrow("imageBase64 must be JPEG, PNG, or WebP");

    expect(db.client.query).not.toHaveBeenCalled();
  });

  it("does not call the provider when the monthly budget guard is exhausted", async () => {
    process.env.VISION_PROVIDER = "google_vision_ocr";
    process.env.VISION_MONTHLY_BUDGET_VND = "400";
    process.env.VISION_ESTIMATED_PROVIDER_SCAN_COST_VND = "200";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    db.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("count(*)::int AS count") && sql.includes("date_trunc('day'")) return { rows: [{ count: 0 }] };
      if (sql.includes("count(*)::int AS count") && sql.includes("date_trunc('month'")) return { rows: [{ count: 2 }] };
      if (sql.includes("INSERT INTO app.vision_scan_events")) return { rows: [{ id: "scan_budget" }] };
      if (sql.includes("INSERT INTO app.vision_scan_detections")) return { rows: [{ id: "det_budget" }] };
      return { rows: [] };
    });

    const result = await scanVisionProducts({
      imageBase64: jpegDataUrl,
    }, scope, actor);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      scanId: "scan_budget",
      status: "failed",
      provider: "budget_guard",
    });
    expect(result.data.detections[0]).toMatchObject({
      detectionType: "unresolved",
      warnings: ["monthly_budget_exceeded"],
      decision: "unresolved",
    });
    expectNoCommerceMutationQueries();
  });

  it("rate-limits short-window scan bursts before provider calls or scan writes", async () => {
    process.env.VISION_PROVIDER = "google_vision_ocr";
    process.env.VISION_SCAN_RATE_LIMIT_WINDOW_SECONDS = "60";
    process.env.VISION_SCAN_RATE_LIMIT_PER_OPERATOR = "2";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    db.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("date_trunc('day'")) return { rows: [{ count: 0 }] };
      if (sql.includes("interval '1 second'")) return { rows: [{ count: 2 }] };
      return { rows: [] };
    });

    await expect(scanVisionProducts({
      imageBase64: jpegDataUrl,
    }, scope, actor)).rejects.toMatchObject({
      code: "vision_scan_rate_limited",
      statusCode: 429,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.client.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO app.vision_scan_events"),
      expect.any(Array),
    );
    expect(db.client.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO app.vision_scan_detections"),
      expect.any(Array),
    );
    expectNoCommerceMutationQueries();
  });

  it("records unresolved manual fallback when the sidecar provider returns an error", async () => {
    process.env.VISION_PROVIDER = "google_vision_ocr";
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "provider_unavailable" } }),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await scanVisionProducts({
      imageBase64: jpegDataUrl,
    }, scope, actor);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/ai/vision/product-search"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.data).toMatchObject({
      scanId: "scan_1",
      status: "failed",
      provider: "google_vision_ocr",
    });
    expect(result.data.detections[0]).toMatchObject({
      detectionType: "unresolved",
      decision: "unresolved",
      candidates: [],
      warnings: ["provider_http_503", "provider_unavailable"],
    });
    expectNoCommerceMutationQueries();
  });

  it("records unresolved manual fallback when the sidecar provider times out", async () => {
    process.env.VISION_PROVIDER = "google_vision_ocr";
    const timeoutError = new Error("aborted");
    timeoutError.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw timeoutError;
    }));

    const result = await scanVisionProducts({
      imageBase64: jpegDataUrl,
    }, scope, actor);

    expect(result.data).toMatchObject({
      scanId: "scan_1",
      status: "failed",
      provider: "google_vision_ocr",
    });
    expect(result.data.detections[0]).toMatchObject({
      detectionType: "unresolved",
      decision: "unresolved",
      candidates: [],
      warnings: ["provider_timeout"],
    });
    expectNoCommerceMutationQueries();
  });

  it("stores staff correction and updates the detection decision", async () => {
    db.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM app.vision_scan_events")) return { rows: [{ id: "scan_1" }] };
      if (sql.includes("FROM app.vision_scan_detections")) return { rows: [{ id: "det_1" }] };
      if (sql.includes("FROM public.product_variant")) return { rows: [{ id: "var_correct" }] };
      if (sql.includes("INSERT INTO app.vision_scan_corrections")) return { rows: [{ id: "corr_1" }] };
      if (sql.includes("UPDATE app.vision_scan_detections")) return { rows: [] };
      return { rows: [] };
    });

    const result = await recordVisionScanCorrection("scan_1", {
      detectionId: "det_1",
      selectedVariantId: "var_correct",
      previousVariantId: "var_wrong",
      correctionType: "staff_selected_correct_variant",
    }, scope, actor);

    expect(entitlement.requireFeatureCapability).toHaveBeenCalledWith("vision_correction_report", { merchantId: "merchant_a", client: db.client });
    expect(result.data).toMatchObject({
      correctionId: "corr_1",
      scanId: "scan_1",
      detectionId: "det_1",
      selectedVariantId: "var_correct",
      previousVariantId: "var_wrong",
    });
    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE app.vision_scan_detections"),
      ["det_1", "scan_1", "corrected", "var_correct"],
    );
    expectNoCommerceMutationQueries();
  });

  it("rejects corrections for unpublished or inventory-unlinked selected variants", async () => {
    db.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM app.vision_scan_events")) return { rows: [{ id: "scan_1" }] };
      if (sql.includes("FROM app.vision_scan_detections")) return { rows: [{ id: "det_1" }] };
      if (sql.includes("FROM public.product_variant")) return { rows: [] };
      return { rows: [] };
    });

    await expect(recordVisionScanCorrection("scan_1", {
      detectionId: "det_1",
      selectedVariantId: "var_unpublished",
      previousVariantId: "var_wrong",
      correctionType: "staff_selected_correct_variant",
    }, scope, actor)).rejects.toThrow("selectedVariantId must be a published inventory-linked variant for this merchant");

    expect(db.client.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO app.vision_scan_corrections"),
      expect.any(Array),
    );
    expectNoCommerceMutationQueries();
  });

  it("stores staff acceptance without marking the detection corrected", async () => {
    db.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM app.vision_scan_events")) return { rows: [{ id: "scan_1" }] };
      if (sql.includes("FROM app.vision_scan_detections")) return { rows: [{ id: "det_1" }] };
      if (sql.includes("FROM public.product_variant")) return { rows: [{ id: "var_top" }] };
      if (sql.includes("INSERT INTO app.vision_scan_corrections")) return { rows: [{ id: "corr_accept" }] };
      if (sql.includes("UPDATE app.vision_scan_detections")) return { rows: [] };
      return { rows: [] };
    });

    const result = await recordVisionScanCorrection("scan_1", {
      detectionId: "det_1",
      selectedVariantId: "var_top",
      previousVariantId: "var_top",
      correctionType: "staff_accepted",
    }, scope, actor);

    expect(result.data.correctionType).toBe("staff_accepted");
    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE app.vision_scan_detections"),
      ["det_1", "scan_1", "accepted", "var_top"],
    );
    expectNoCommerceMutationQueries();
  });

  it("stores manual search fallback as a corrected vision decision", async () => {
    db.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM app.vision_scan_events")) return { rows: [{ id: "scan_manual" }] };
      if (sql.includes("FROM app.vision_scan_detections")) return { rows: [{ id: "det_manual" }] };
      if (sql.includes("FROM public.product_variant")) return { rows: [{ id: "var_manual" }] };
      if (sql.includes("INSERT INTO app.vision_scan_corrections")) return { rows: [{ id: "corr_manual" }] };
      if (sql.includes("UPDATE app.vision_scan_detections")) return { rows: [] };
      return { rows: [] };
    });

    const result = await recordVisionScanCorrection("scan_manual", {
      detectionId: "det_manual",
      selectedVariantId: "var_manual",
      previousVariantId: "var_unresolved",
      correctionType: "manual_search_selected",
      metadata: { source: "pos_manual_search_fallback" },
    }, scope, actor);

    expect(result.data).toMatchObject({
      correctionId: "corr_manual",
      correctionType: "manual_search_selected",
      selectedVariantId: "var_manual",
      previousVariantId: "var_unresolved",
    });
    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE app.vision_scan_detections"),
      ["det_manual", "scan_manual", "corrected", "var_manual"],
    );
    expectNoCommerceMutationQueries();
  });

  it("lists scan report rows with latest correction context", async () => {
    const createdAt = new Date("2026-06-27T10:00:00.000Z");
    const correctedAt = new Date("2026-06-27T10:01:00.000Z");
    db.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM app.vision_scan_events e")) {
        return {
          rows: [{
            scan_id: "scan_1",
            detection_id: "det_1",
            created_at: createdAt,
            merchant_id: "merchant_a",
            store_id: "store_a",
            operator_id: "op_staff",
            mode: "single",
            status: "success",
            provider: "google_vision_ocr",
            model_version: "google_vision_ocr:text_detection:v1",
            latency_ms: 123,
            image_hash: "hash_1",
            object_id: "obj_1",
            source: "vision_provider",
            detection_type: "candidate_match",
            suggested_variant_id: "var_wrong",
            confidence: "0.82",
            decision: "corrected",
            warnings: ["ocr_fuzzy_match"],
            candidates: [{ variantId: "var_wrong" }, { variantId: "var_correct" }],
            selected_variant_id: "var_correct",
            correction_type: "staff_selected_correct_variant",
            corrected_at: correctedAt,
            suggested_title: "Wrong Product",
            suggested_sku: "WRONG",
            selected_title: "Correct Product",
            selected_sku: "CORRECT",
            total_count: 1,
          }],
        };
      }
      return { rows: [] };
    });

    const result = await listVisionScanReport({ merchantId: "merchant_a", decision: "corrected", limit: 25 });

    expect(result.meta).toMatchObject({ count: 1, limit: 25, offset: 0 });
    expect(result.data[0]).toMatchObject({
      scanId: "scan_1",
      provider: "google_vision_ocr",
      modelVersion: "google_vision_ocr:text_detection:v1",
      decision: "corrected",
      suggestedSku: "WRONG",
      selectedSku: "CORRECT",
      warnings: ["ocr_fuzzy_match"],
      candidateCount: 2,
      correctedAt: correctedAt.toISOString(),
    });
  });
});
