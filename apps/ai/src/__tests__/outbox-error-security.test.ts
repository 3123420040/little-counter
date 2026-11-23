import { describe, expect, it } from "vitest";
import { outboxFailureReason, outboxFailureMetadata } from "../worker/outbox-poller";

describe("legacy outbox error boundary", () => {
  it("does not persist or log raw handler diagnostics", () => {
    const secret = "Bearer private-token SELECT password_hash";
    const error = Object.assign(new Error(secret), { code: "HANDLER_FAILED", statusCode: 503 });
    expect(outboxFailureReason(error)).toBe("outbox_handler_failed:HANDLER_FAILED");
    expect(outboxFailureMetadata(error)).toEqual({
      errorType: "Error",
      errorCode: "HANDLER_FAILED",
      statusCode: 503,
    });
    expect(JSON.stringify({ reason: outboxFailureReason(error), ...outboxFailureMetadata(error) })).not.toContain(secret);
  });
});
