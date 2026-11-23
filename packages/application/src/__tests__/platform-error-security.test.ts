import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformError, serializePlatformError } from "../errors/platform-error";

afterEach(() => vi.restoreAllMocks());

describe("public error serialization", () => {
  it("never returns or logs raw unexpected error messages", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = "postgresql://admin:super-secret@db.internal/prod";
    const serialized = serializePlatformError(new Error(secret));

    expect(serialized.statusCode).toBe(500);
    expect(JSON.stringify(serialized)).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(serialized.body.error.correlationId).toBeTruthy();
  });

  it("removes provider payload details from 5xx errors but preserves safe retry metadata", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const providerFailure = serializePlatformError(new PlatformError(
      "provider_request_failed",
      "Provider returned a private diagnostic",
      502,
      { payload: { apiKey: "secret", sql: "SELECT password_hash" } },
    ));
    expect(providerFailure.body.error.message).toBe("Request could not be completed");
    expect(providerFailure.body.error.details).toBeUndefined();

    const retryable = serializePlatformError(new PlatformError(
      "billing_apply_retryable",
      "retry",
      503,
      { retryAfterSeconds: 20, attempt: 2, internal: "hidden" },
    ));
    expect(retryable.retryAfterSeconds).toBe(20);
    expect(retryable.body.error.details).toEqual({ retryAfterSeconds: 20, attempt: 2 });
  });
});
