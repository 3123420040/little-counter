import { describe, expect, it } from "vitest";
import { PlatformError } from "../errors/platform-error";
import { normalizeChannelSessionInput } from "../services/channel-session-service";

describe("channel session service", () => {
  it("normalizes valid session state and expiry", () => {
    const input = normalizeChannelSessionInput({
      state: { flow: "remote_order", step: "items" },
      expiresAt: "2026-06-14T12:00:00.000Z",
    });

    expect(input).toEqual({
      state: { flow: "remote_order", step: "items" },
      expiresAt: "2026-06-14T12:00:00.000Z",
    });
  });

  it("rejects non-object state", () => {
    expect(() => normalizeChannelSessionInput({ state: [] as unknown as Record<string, unknown> })).toThrow(PlatformError);
  });

  it("rejects invalid expiry", () => {
    expect(() => normalizeChannelSessionInput({ expiresAt: "not-a-date" })).toThrow("expiresAt must be an ISO timestamp");
  });
});
