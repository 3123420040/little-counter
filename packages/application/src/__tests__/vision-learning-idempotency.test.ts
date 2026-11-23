import { describe, expect, it } from "vitest";
import { buildVisionLearningReferenceObjectName } from "../services/vision-learning-service";

describe("vision learning storage idempotency", () => {
  const base = {
    merchantId: "merchant_a",
    storeId: "store_a",
    variantId: "variant_a",
    orderId: "order_a",
    detectionId: "detection_a",
    learningKey: "vision-learning:line_a:scan_a:detection_a:variant_a:1",
  };

  it("derives one stable object name from the durable learning identity", () => {
    const first = buildVisionLearningReferenceObjectName(base);
    const replay = buildVisionLearningReferenceObjectName(base);

    expect(replay).toBe(first);
    expect(first).toMatch(/^reference-images\/merchant_a\/store_a\/variant_a\/learned\/[a-f0-9]{64}\.jpg$/);
    expect(first).not.toContain(base.learningKey);
  });

  it("does not alias different learning identities", () => {
    expect(buildVisionLearningReferenceObjectName({
      ...base,
      learningKey: `${base.learningKey}:different`,
    })).not.toBe(buildVisionLearningReferenceObjectName(base));
  });
});
