import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../utils/logger";

afterEach(() => vi.restoreAllMocks());

describe("structured logger sanitization", () => {
  it("drops raw error messages and redacts secrets recursively", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = "private-password";
    const error = Object.assign(new Error(`postgresql://admin:${secret}@db.internal/prod`), {
      code: "ECONNREFUSED",
    });

    createLogger("security-test").error("provider request failed", error, {
      apiKey: "private-api-key",
      nested: { accessToken: "private-access-token" },
      databaseUrl: `postgresql://admin:${secret}@db.internal/prod`,
      endpoint: "https://api.telegram.org/bot123456:private-bot-token/getUpdates",
    });

    const serialized = JSON.stringify(output.mock.calls);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("private-api-key");
    expect(serialized).not.toContain("private-access-token");
    expect(serialized).not.toContain("private-bot-token");
    expect(serialized).not.toContain(error.message);
    expect(serialized).toContain("ECONNREFUSED");
  });

  it("redacts secret query parameters and circular context without crashing", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const context: Record<string, unknown> = {
      callback: "https://provider.test/webhook?token=private-query-token&safe=1",
      headers: { "X-Api-Key": "private-header-key" },
      nested: { value: "api_key=private-inline-key" },
    };
    context.circular = context;

    expect(() => createLogger("security-test").error("redaction", undefined, context)).not.toThrow();
    const serialized = JSON.stringify(output.mock.calls);
    expect(serialized).not.toContain("private-query-token");
    expect(serialized).not.toContain("private-header-key");
    expect(serialized).not.toContain("private-inline-key");
    expect(serialized).toContain("[CIRCULAR]");
  });
});
