import { describe, expect, it, vi } from "vitest";
import { PlatformError } from "@medusa-snus/application";
import { sendAiError } from "../error-response";

function replyDouble() {
  const state: { statusCode?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const reply = {
    header: vi.fn((name: string, value: string) => {
      state.headers[name] = value;
      return reply;
    }),
    status: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      return reply;
    }),
    send: vi.fn((body: unknown) => {
      state.body = body;
      return body;
    }),
  };
  return { reply, state };
}

describe("AI HTTP error boundary", () => {
  it("does not expose unexpected or provider 5xx diagnostics", () => {
    const secret = "postgresql://admin:private-password@db.internal/prod";
    for (const error of [
      new Error(secret),
      new PlatformError("provider_request_failed", secret, 502, { providerBody: secret }),
    ]) {
      const { reply, state } = replyDouble();
      sendAiError(reply as never, error);
      expect(state.statusCode).toBeGreaterThanOrEqual(500);
      expect(JSON.stringify(state.body)).not.toContain(secret);
      expect(state.body).toMatchObject({
        error: {
          message: "Request could not be completed",
          correlationId: expect.any(String),
        },
      });
    }
  });

  it("preserves reviewed retry metadata and emits Retry-After", () => {
    const { reply, state } = replyDouble();
    sendAiError(reply as never, new PlatformError("rate_limited", "Too many requests", 429, {
      retryAfterSeconds: 12,
      privateDiagnostic: "do-not-return",
    }));
    expect(state).toEqual({
      statusCode: 429,
      headers: { "Retry-After": "12" },
      body: {
        error: {
          code: "rate_limited",
          message: "Too many requests",
          details: { retryAfterSeconds: 12 },
        },
      },
    });
  });
});
