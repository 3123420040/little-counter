import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissions } from "@medusa-snus/contracts";

const application = vi.hoisted(() => ({
  createVisionReferenceImage: vi.fn(),
  listVisionCatalogReadiness: vi.fn(),
  listVisionReferenceImagesForProvider: vi.fn(),
  listVisionScanReport: vi.fn(),
  recordVisionScanCorrection: vi.fn(),
  scanVisionProducts: vi.fn(),
  syncVisionReferenceImagesFromProductMetadata: vi.fn(),
  updateVisionReferenceImage: vi.fn(),
  uploadVisionReferenceImage: vi.fn(),
}));

const routeUtils = vi.hoisted(() => ({
  actorWithMerchantTargetAccess: vi.fn(),
  actorWithMerchantTargetMutation: vi.fn(),
  actorWithOperatingScopeAccess: vi.fn(),
  actorWithOperatingScopeMutation: vi.fn(),
  body: vi.fn((request) => request.body || {}),
  headers: vi.fn((request) => request.headers || {}),
  merchantTargetIdFromHeaders: vi.fn(() => "merchant_a"),
  query: vi.fn((request) => request.query || {}),
  route: vi.fn(async (_response, handler: () => Promise<unknown>) => handler()),
}));

vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => routeUtils);

import { GET as listReadiness } from "../../../../src/api/platform/admin/vision/catalog/readiness/route";
import { GET as listReferenceImages, POST as createReferenceImage } from "../../../../src/api/platform/admin/vision/catalog/reference-images/route";
import { POST as uploadReferenceImage } from "../../../../src/api/platform/admin/vision/catalog/reference-image-uploads/route";
import { PATCH as updateReferenceImage } from "../../../../src/api/platform/admin/vision/catalog/reference-images/[imageId]/route";
import { POST as syncReferenceImages } from "../../../../src/api/platform/admin/vision/catalog/sync-reference-images/route";
import { GET as listScanReport } from "../../../../src/api/platform/admin/vision/scans/route";
import { POST as scanProducts } from "../../../../src/api/pos/vision/scan-products/route";
import { POST as recordCorrection } from "../../../../src/api/pos/vision/scans/[scanId]/corrections/route";

const actor = { operatorId: "op_staff", role: "staff", displayName: "Staff", organizationId: "org_a" };
const operatingScope = { scopeKind: "operating", merchantId: "merchant_a", storeId: "store_a", stockLocationId: "sloc_a" };
const merchantScope = { scopeKind: "merchant_target", merchantId: "merchant_a" };
const response = { status: vi.fn(), json: vi.fn() } as never;

function request(options: { params?: Record<string, string>; body?: Record<string, unknown>; query?: Record<string, string> } = {}) {
  return { headers: {}, query: options.query || {}, params: options.params || {}, body: options.body || {} } as never;
}

describe("vision routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeUtils.actorWithOperatingScopeAccess.mockResolvedValue({ actor, scope: operatingScope });
    routeUtils.actorWithOperatingScopeMutation.mockResolvedValue({ actor, scope: operatingScope });
    routeUtils.actorWithMerchantTargetAccess.mockResolvedValue({ actor, scope: merchantScope });
    routeUtils.actorWithMerchantTargetMutation.mockResolvedValue({ actor, scope: merchantScope });
    for (const service of Object.values(application)) service.mockResolvedValue({ data: {} });
  });

  it("uses vision_scan:use for POS scan suggestions", async () => {
    const payload = { imageHash: "hash", mode: "single" };

    await scanProducts(request({ body: payload }), response);

    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledWith(expect.anything(), permissions.visionScanUse, "ai");
    expect(application.scanVisionProducts).toHaveBeenCalledWith(payload, operatingScope, {
      operatorId: "op_staff",
      type: "staff",
      role: "staff",
    }, { providerHeaders: {}, allowProviderCandidates: false });
  });

  it("uses vision_scan:use for POS correction feedback", async () => {
    const payload = { detectionId: "det_1", selectedVariantId: "var_1" };

    await recordCorrection(request({ params: { scanId: "scan_1" }, body: payload }), response);

    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledWith(expect.anything(), permissions.visionScanUse, "ai");
    expect(application.recordVisionScanCorrection).toHaveBeenCalledWith("scan_1", payload, operatingScope, expect.objectContaining({ operatorId: "op_staff" }));
  });

  it("uses vision_scan:read for readiness reports", async () => {
    await listReadiness(request({ query: { storeId: "store_a", provider: "google_product_search" } }), response);

    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenCalledWith(expect.anything(), permissions.visionScanRead, "merchant_a");
    expect(application.listVisionCatalogReadiness).toHaveBeenCalledWith({
      storeId: "store_a",
      provider: "google_product_search",
      merchantId: "merchant_a",
    });
  });

  it("uses vision_scan:read for scan correction reports", async () => {
    await listScanReport(request({ query: { dateFrom: "2026-06-27", decision: "corrected" } }), response);

    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenCalledWith(expect.anything(), permissions.visionScanRead, "merchant_a");
    expect(application.listVisionScanReport).toHaveBeenCalledWith({
      dateFrom: "2026-06-27",
      decision: "corrected",
      merchantId: "merchant_a",
    });
  });

  it("uses vision_catalog:write for sync and provider reference image lists", async () => {
    await syncReferenceImages(request({ body: { storeId: "store_a" } }), response);
    await listReferenceImages(request({ query: { provider: "google_product_search" } }), response);

    expect(routeUtils.actorWithMerchantTargetMutation).toHaveBeenCalledWith(expect.anything(), permissions.visionCatalogWrite, "merchant_a");
    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenCalledWith(expect.anything(), permissions.visionCatalogWrite, "merchant_a");
    expect(application.syncVisionReferenceImagesFromProductMetadata).toHaveBeenCalledWith({
      merchantId: "merchant_a",
      storeId: "store_a",
    });
    expect(application.listVisionReferenceImagesForProvider).toHaveBeenCalledWith({
      provider: "google_product_search",
      includePending: "true",
      merchantId: "merchant_a",
    });
  });

  it("uses vision_catalog:write mutations for manual reference image create, upload, and update", async () => {
    const createPayload = { variantId: "var_1", imageUrl: "https://cdn.example/front.jpg" };
    const uploadPayload = { variantId: "var_1", imageBase64: "data:image/png;base64,abc", fileName: "front.png" };
    const updatePayload = { qualityStatus: "approved", isPrimary: true };

    await createReferenceImage(request({ body: createPayload }), response);
    await uploadReferenceImage(request({ body: uploadPayload }), response);
    await updateReferenceImage(request({ params: { imageId: "11111111-1111-4111-8111-111111111111" }, body: updatePayload }), response);

    expect(routeUtils.actorWithMerchantTargetMutation).toHaveBeenCalledWith(expect.anything(), permissions.visionCatalogWrite, "merchant_a");
    expect(application.createVisionReferenceImage).toHaveBeenCalledWith({
      ...createPayload,
      merchantId: "merchant_a",
    });
    expect(application.uploadVisionReferenceImage).toHaveBeenCalledWith({
      ...uploadPayload,
      merchantId: "merchant_a",
    });
    expect(application.updateVisionReferenceImage).toHaveBeenCalledWith({
      ...updatePayload,
      imageId: "11111111-1111-4111-8111-111111111111",
      merchantId: "merchant_a",
    });
  });
});
