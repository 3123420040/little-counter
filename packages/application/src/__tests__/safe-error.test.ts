import { describe, expect, it } from "vitest";
import { PlatformError } from "../errors/platform-error";
import { importApplyErrorMessage } from "../services/import-types";
import { publicOperationErrorMessage, safeErrorCode, safeErrorMetadata } from "../utils/safe-error";

describe("safe runtime error metadata", () => {
  it("retains stable codes and drops raw diagnostics", () => {
    const secret = "postgresql://admin:private-password@db.internal/prod";
    const error = Object.assign(new Error(secret), { code: "ECONNREFUSED", statusCode: 503 });
    expect(safeErrorCode(error)).toBe("ECONNREFUSED");
    expect(safeErrorMetadata(error)).toEqual({ errorType: "Error", errorCode: "ECONNREFUSED", statusCode: 503 });
    expect(JSON.stringify(safeErrorMetadata(error))).not.toContain(secret);
  });

  it("only exposes intentional PlatformError 4xx messages", () => {
    expect(publicOperationErrorMessage(new PlatformError("validation_error", "Invalid row", 400), "fallback"))
      .toBe("Invalid row");
    expect(publicOperationErrorMessage(new PlatformError("provider_failed", "private diagnostic", 502), "fallback"))
      .toBe("fallback");
    expect(importApplyErrorMessage(new Error("SELECT password_hash"))).toBe("Row could not be applied");
  });
});
