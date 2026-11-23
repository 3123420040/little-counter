import { describe, expect, it } from "vitest";
import {
  resolveTeamMemberEffectiveStatus,
  type TeamMemberDto,
} from "../services/owner-settings-service";

const now = new Date("2026-09-02T10:00:00.000Z");
const authority = (overrides: Partial<TeamMemberDto> = {}) => ({
  membershipStatus: "active" as const,
  globalStatus: "active" as const,
  validFrom: "2026-01-01T00:00:00.000Z",
  validTo: null,
  ...overrides,
});

describe("owner team effective authority status", () => {
  it.each([
    [authority(), "active"],
    [authority({ membershipStatus: "disabled" }), "disabled"],
    [authority({ membershipStatus: "pending" }), "pending"],
    [authority({ membershipStatus: "revoked" }), "revoked"],
    [authority({ validFrom: "2026-09-03T00:00:00.000Z" }), "scheduled"],
    [authority({ validTo: "2026-09-02T10:00:00.000Z" }), "expired"],
    [authority({ globalStatus: "suspended" }), "suspended"],
  ])("resolves %#", (input, expected) => {
    expect(resolveTeamMemberEffectiveStatus(input, now)).toBe(expected);
  });

  it("fails closed for malformed validity", () => {
    expect(resolveTeamMemberEffectiveStatus(authority({ validFrom: "not-a-date" }), now)).toBe("expired");
  });

  it("does not obscure a revoked membership with global suspension", () => {
    expect(resolveTeamMemberEffectiveStatus(authority({
      membershipStatus: "revoked",
      globalStatus: "suspended",
    }), now)).toBe("revoked");
  });
});
