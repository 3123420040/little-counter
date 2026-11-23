import { describe, expect, it } from "vitest";
import {
  resolvePlatformMembershipEffectiveStatus,
  type PlatformMembershipSummary,
} from "../services/platform-admin-service";

const now = new Date("2026-09-02T10:00:00.000Z");
const membership = (overrides: Partial<PlatformMembershipSummary> = {}) => ({
  status: "active" as const,
  validFrom: "2026-01-01T00:00:00.000Z",
  validTo: null,
  ...overrides,
});

describe("platform membership effective status", () => {
  it.each([
    [membership(), "active"],
    [membership({ validFrom: "2026-09-03T00:00:00.000Z" }), "scheduled"],
    [membership({ validTo: "2026-09-02T10:00:00.000Z" }), "expired"],
    [membership({ status: "disabled" }), "disabled"],
    [membership({ status: "pending" }), "pending"],
    [membership({ status: "revoked" }), "revoked"],
  ])("resolves %# without losing stored state", (input, expected) => {
    expect(resolvePlatformMembershipEffectiveStatus(input, now)).toBe(expected);
  });

  it("fails closed when active validity is malformed", () => {
    expect(resolvePlatformMembershipEffectiveStatus(membership({ validFrom: "invalid" }), now)).toBe("expired");
  });
});
