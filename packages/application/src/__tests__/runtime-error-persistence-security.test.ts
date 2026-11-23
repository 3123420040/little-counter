import { describe, expect, it } from "vitest";
import { receiptDeliveryFailureReason } from "../services/receipt-service";
import { productImageAutofillFailureReason } from "../services/product-image-autofill-service";
import { visionLearningFailureMetadata } from "../services/vision-learning-service";

describe("runtime error persistence boundaries", () => {
  const secret = "postgresql://admin:private-password@db.internal/prod";

  it("stores stable receipt and autofill failure reasons without raw diagnostics", () => {
    const error = Object.assign(new Error(secret), { code: "ECONNRESET", statusCode: 503 });
    expect(receiptDeliveryFailureReason(error)).toBe("email_delivery_failed:ECONNRESET");
    expect(productImageAutofillFailureReason(error)).toBe("provider_error:ECONNRESET");
    expect(receiptDeliveryFailureReason(error)).not.toContain(secret);
    expect(productImageAutofillFailureReason(error)).not.toContain(secret);
  });

  it("emits only safe Vision learning metadata", () => {
    const error = Object.assign(new Error(secret), { code: "VISION_STORAGE_FAILED", statusCode: 502 });
    const metadata = visionLearningFailureMetadata(error);
    expect(metadata).toEqual({ errorType: "Error", errorCode: "VISION_STORAGE_FAILED", statusCode: 502 });
    expect(JSON.stringify(metadata)).not.toContain(secret);
  });
});
