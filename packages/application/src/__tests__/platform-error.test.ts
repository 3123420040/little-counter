import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformError, sendPlatformError } from "../errors/platform-error";

function responseRecorder() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { response: { status }, status, json };
}

describe("sendPlatformError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves reviewed domain errors", () => {
    const { response, status, json } = responseRecorder();

    sendPlatformError(
      response,
      new PlatformError("unauthorized", "Invalid credentials", 401),
    );

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: "unauthorized",
        message: "Invalid credentials",
      },
    });
  });

  it("logs unexpected errors server-side without exposing database details", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { response, status, json } = responseRecorder();

    sendPlatformError(
      response,
      new Error("permission denied for schema medusa"),
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: expect.objectContaining({
      code: "internal_error",
      message: "Request could not be completed",
      correlationId: expect.any(String),
    }) });
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(
      "permission denied for schema medusa",
    );
  });
});
