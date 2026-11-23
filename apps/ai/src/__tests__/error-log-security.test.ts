import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("AI provider error logging", () => {
  it("does not log provider response bodies or API credentials", async () => {
    const responseSecret = "provider-body-private-diagnostic";
    const apiKey = "private-api-key-value";
    vi.stubEnv("AI_API_KEY", apiKey);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(responseSecret, { status: 400 })));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { OpenAICompatibleProvider } = await import("../services/openai-provider");
    const result = await new OpenAICompatibleProvider().draftReply({
      customerMessage: "Gia san pham?",
      products: [],
    });

    expect(result.responseText).toBeTruthy();
    const serialized = JSON.stringify(errorLog.mock.calls);
    expect(serialized).not.toContain(responseSecret);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).toContain("ai_provider_fallback");
  });

  it("falls back without exposing malformed provider payloads", async () => {
    const privatePayload = "private-provider-payload";
    vi.stubEnv("AI_API_KEY", "private-api-key-value");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: privatePayload.repeat(4_000) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { OpenAICompatibleProvider } = await import("../services/openai-provider");
    const result = await new OpenAICompatibleProvider().draftReply({
      customerMessage: "Gia san pham?",
      products: [],
    });

    expect(result.responseText).toBeTruthy();
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(privatePayload);
  });
});
