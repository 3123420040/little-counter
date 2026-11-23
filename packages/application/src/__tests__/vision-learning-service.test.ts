import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  enabled: vi.fn(),
  read: vi.fn(),
  upload: vi.fn(),
}));
const db = vi.hoisted(() => ({ queryOne: vi.fn() }));
const imaging = vi.hoisted(() => ({
  sharp: vi.fn(),
  sourceMetadata: { width: 1000, height: 800 },
  cropMetadata: { width: 300, height: 260 },
  bytes: Buffer.from("cropped-image"),
}));

vi.mock("../db/query", () => ({ queryOne: db.queryOne }));
vi.mock("../services/vision-image-storage-service", () => ({
  visionLearningEnabled: storage.enabled,
  readVisionStorageObject: storage.read,
  uploadVisionStorageObject: storage.upload,
}));
vi.mock("sharp", () => ({ default: imaging.sharp }));

import {
  buildVisionLearningReferenceObjectName,
  handleVisionLearningFromSale,
} from "../services/vision-learning-service";

const client = { query: vi.fn() } as never;
const mapping = (overrides: Record<string, unknown> = {}) => ({
  scan_id: "11111111-1111-4111-8111-111111111111",
  merchant_id: "merchant_a",
  store_id: "store_a",
  raw_image_storage_key: "raw/fallback.jpg",
  scan_metadata: { rawImageStorageKeys: ["raw/first.jpg", "raw/second.jpg"] },
  detection_id: "22222222-2222-4222-8222-222222222222",
  object_id: "image_2_object_1",
  bbox: {
    normalizedVertices: [
      { x: 0.2, y: 0.2 },
      { x: 0.5, y: 0.2 },
      { x: 0.5, y: 0.6 },
      { x: 0.2, y: 0.6 },
    ],
    confidence: 0.9,
  },
  detection_metadata: { warnings: [] },
  correction_id: "33333333-3333-4333-8333-333333333333",
  selected_variant_id: "variant_a",
  product_id: "product_a",
  variant_id: "variant_a",
  ...overrides,
});

function payload(overrides: Record<string, unknown> = {}) {
  return {
    merchantId: "merchant_a",
    storeId: "store_a",
    orderId: "order_a",
    items: [{
      orderLineItemId: "line_a",
      variantId: "variant_a",
      quantity: 1,
      vision: {
        scanEventId: "11111111-1111-4111-8111-111111111111",
        detectionId: "22222222-2222-4222-8222-222222222222",
        correctionId: "33333333-3333-4333-8333-333333333333",
        candidateSource: "staff_correction",
        provider: "google_vision",
        providerConfidence: 0.91,
        providerCandidateRank: 1,
        providerProductRef: "provider-product",
        providerImageRef: "provider-image",
      },
    }],
    ...overrides,
  };
}

describe("Vision sale learning loop", () => {
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of [
      "VISION_LEARNING_AUTO_APPROVE",
      "VISION_LEARNING_CROP_MAX_DIMENSION",
      "VISION_LEARNING_CROP_PADDING_RATIO",
      "VISION_REFERENCE_MAX_APPROVED_PER_VARIANT",
      "GOOGLE_VISION_REFERENCE_PREFIX",
    ]) originalEnv.set(key, process.env[key]);
    storage.enabled.mockReturnValue(true);
    storage.read.mockResolvedValue({ bytes: Buffer.from("raw-image"), contentType: "image/jpeg" });
    storage.upload.mockResolvedValue({
      gcsUri: "gs://vision-test/reference.jpg",
      storageKey: "reference.jpg",
      contentType: "image/jpeg",
      byteSize: imaging.bytes.length,
    });
    let invocation = 0;
    imaging.sharp.mockImplementation(() => {
      invocation += 1;
      const chain: Record<string, unknown> = {};
      chain.metadata = vi.fn(async () => invocation === 1 ? imaging.sourceMetadata : imaging.cropMetadata);
      for (const method of ["extract", "rotate", "resize", "jpeg"]) chain[method] = vi.fn(() => chain);
      chain.toBuffer = vi.fn(async () => imaging.bytes);
      return chain;
    });
    (client as { query: ReturnType<typeof vi.fn> }).query.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("does nothing while learning is disabled or the event identity is incomplete", async () => {
    storage.enabled.mockReturnValueOnce(false);
    await handleVisionLearningFromSale(client, payload());
    for (const missing of ["merchantId", "storeId", "orderId"] as const) {
      await handleVisionLearningFromSale(client, payload({ [missing]: "" }));
    }
    await handleVisionLearningFromSale(client, payload({ items: "not-an-array" }));
    expect(db.queryOne).not.toHaveBeenCalled();
  });

  it("persists one bounded crop from a correction-backed strong mapping", async () => {
    process.env.VISION_LEARNING_AUTO_APPROVE = "true";
    process.env.VISION_LEARNING_CROP_MAX_DIMENSION = "640";
    process.env.VISION_LEARNING_CROP_PADDING_RATIO = "0.1";
    db.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mapping())
      .mockResolvedValueOnce({ count: "2" })
      .mockResolvedValueOnce({ id: "learned_image_a" });

    await handleVisionLearningFromSale(client, payload());

    expect(storage.read).toHaveBeenCalledWith("raw/second.jpg");
    expect(storage.upload).toHaveBeenCalledWith(expect.objectContaining({
      objectName: expect.stringMatching(/^reference-images\/merchant_a\/store_a\/variant_a\/learned\/[a-f0-9]{64}\.jpg$/),
      bytes: imaging.bytes,
      contentType: "image/jpeg",
    }));
    expect(db.queryOne.mock.calls[3][2]).toEqual(expect.arrayContaining([
      "merchant_a",
      "store_a",
      "product_a",
      "variant_a",
      "gs://vision-test/reference.jpg",
      "approved",
    ]));
    const artifactCall = (client as { query: ReturnType<typeof vi.fn> }).query.mock.calls[0];
    expect(artifactCall[0]).toContain("app.vision_scan_image_artifacts");
    expect(artifactCall[1]).toEqual(expect.arrayContaining(["reference.jpg", "image/jpeg"]));
    expect(JSON.stringify(artifactCall[1])).toContain("learned_image_a");
  });

  it("supports multi-context payloads, derived line ids, warning image indexes, and absolute bboxes", async () => {
    process.env.GOOGLE_VISION_REFERENCE_PREFIX = "/learned refs/";
    const contexts = [
      { scanEventId: "scan-1", detectionId: "detect-1", correctionId: "correct-1" },
      { scanEventId: "scan-2", detectionId: "detect-2", correctionId: "correct-2" },
    ];
    const absolute = mapping({
      object_id: "object_without_index",
      scan_metadata: {},
      raw_image_storage_key: "raw/fallback.jpg",
      detection_metadata: { warnings: ["image_3_blurry"] },
      bbox: { vertices: [{ x: 100, y: 100 }, { x: 400, y: 500 }] },
    });
    db.queryOne
      .mockResolvedValueOnce(null).mockResolvedValueOnce(absolute).mockResolvedValueOnce(undefined).mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null).mockResolvedValueOnce(mapping({ object_id: "image_1_object" })).mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce(null);

    await handleVisionLearningFromSale(client, payload({
      items: [{ variantId: "variant_a", visionContexts: contexts }],
    }));

    expect(storage.read).toHaveBeenNthCalledWith(1, "raw/fallback.jpg");
    expect(storage.read).toHaveBeenNthCalledWith(2, "raw/first.jpg");
    expect(storage.upload).toHaveBeenCalledTimes(2);
    expect(buildVisionLearningReferenceObjectName({
      merchantId: "méchant / unsafe",
      storeId: "",
      variantId: "***",
      learningKey: "stable",
    })).toMatch(/^learned refs\/me_chant_unsafe\/global\/variant\/learned\/[a-f0-9]{64}\.jpg$/);
  });

  it("skips replayed, weak, capped, full-image, too-small, and oversized mappings", async () => {
    const cases = [
      { sequence: [{ id: "existing" }] },
      { sequence: [null, null] },
      { sequence: [null, mapping({ correction_id: null })] },
      { sequence: [null, mapping({ selected_variant_id: "variant_other" })] },
      { sequence: [null, mapping({ bbox: null })] },
      { sequence: [null, mapping({ scan_metadata: {}, raw_image_storage_key: null })] },
      { sequence: [null, mapping(), { count: 25 }] },
      { sequence: [null, mapping({ bbox: { source: "full_image" } }), { count: 0 }] },
      { sequence: [null, mapping({ bbox: { normalizedVertices: [{ x: 0.1, y: 0.1 }] } }), { count: 0 }] },
      { sequence: [null, mapping({ bbox: { normalizedVertices: [{ x: 0.1, y: 0.1 }, { x: 0.11, y: 0.11 }] } }), { count: 0 }] },
      { sequence: [null, mapping({ bbox: { normalizedVertices: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }), { count: 0 }] },
    ];

    for (const testCase of cases) {
      db.queryOne.mockReset();
      db.queryOne.mockImplementation(async () => testCase.sequence.shift() ?? null);
      imaging.sharp.mockClear();
      storage.upload.mockClear();
      await handleVisionLearningFromSale(client, payload());
      expect(storage.upload).not.toHaveBeenCalled();
    }
  });

  it("skips items without variants/detections and sanitizes provider failures", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    storage.read.mockRejectedValueOnce(Object.assign(new Error("secret detail"), { code: "STORAGE_DOWN", statusCode: 502 }));
    db.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(mapping()).mockResolvedValueOnce({ count: 0 });

    await handleVisionLearningFromSale(client, payload({
      items: [
        {},
        { variantId: "variant_a", vision: {} },
        (payload().items as Array<Record<string, unknown>>)[0],
      ],
    }));

    expect(warning).toHaveBeenCalledWith(
      "[vision-learning] skipped failed learning context",
      expect.objectContaining({ errorCode: "STORAGE_DOWN", statusCode: 502 }),
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain("secret detail");
    warning.mockRestore();
  });
});
