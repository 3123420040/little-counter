import { describe, expect, it } from "vitest";
import { resolveSignupIdentityStatus } from "../services/platform-admin-service";

const now = new Date("2026-09-02T10:00:00.000Z");

describe("platform signup identity lifecycle", () => {
  it("keeps terminal persistence states distinct", () => {
    expect(resolveSignupIdentityStatus("provisioned", {}, now)).toBe("provisioned");
    expect(resolveSignupIdentityStatus("expired", {}, now)).toBe("expired");
    expect(resolveSignupIdentityStatus("failed", {}, now)).toBe("suspended");
    expect(resolveSignupIdentityStatus("unknown", {}, now)).toBe("suspended");
  });

  it("requires a current unconsumed token for nonterminal states", () => {
    const pending = { expiresAt: "2026-09-02T11:00:00.000Z", consumedAt: null };
    const verified = { expiresAt: "2026-09-02T11:00:00.000Z", consumedAt: "2026-09-02T09:00:00.000Z" };
    expect(resolveSignupIdentityStatus("pending", pending, now)).toBe("pending_verification");
    expect(resolveSignupIdentityStatus("verified", verified, now)).toBe("verified");
    expect(resolveSignupIdentityStatus("pending", {}, now)).toBe("expired");
    expect(resolveSignupIdentityStatus("verified", verified, new Date("invalid"))).toBe("expired");
    expect(resolveSignupIdentityStatus("verified", pending, now)).toBe("expired");
    expect(resolveSignupIdentityStatus("pending", verified, now)).toBe("expired");
    expect(resolveSignupIdentityStatus("verified", {
      expiresAt: "2026-09-02T11:00:00.000Z",
      consumedAt: "invalid",
    }, now)).toBe("expired");
    expect(resolveSignupIdentityStatus("verified", {
      expiresAt: "2026-09-02T11:00:00.000Z",
      consumedAt: "2026-09-02T10:00:01.000Z",
    }, now)).toBe("expired");
    expect(resolveSignupIdentityStatus("verified", {
      expiresAt: "2026-09-02T10:00:00.000Z",
      consumedAt: "2026-09-02T09:00:00.000Z",
    }, now)).toBe("expired");
  });
});
