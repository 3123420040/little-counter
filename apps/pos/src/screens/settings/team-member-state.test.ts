import { describe, expect, it } from "vitest";
import type { TeamMemberDto } from "../../api/settings-endpoints";
import {
  canDisableTeamMembership,
  canEnableTeamMembership,
  hasCurrentTeamMemberValidity,
  TEAM_MEMBER_STATUS_LABEL,
  teamMemberAuthorityDetail,
} from "./team-member-state";

const now = new Date("2026-07-29T10:00:00.000Z");
const member = (overrides: Partial<TeamMemberDto> = {}): TeamMemberDto => ({
  membershipId: "membership-1",
  operatorId: "operator-1",
  displayName: "Operator One",
  role: "staff",
  scopeType: "merchant",
  membershipStatus: "active",
  status: "active",
  globalStatus: "active",
  validFrom: "2026-01-01T00:00:00.000Z",
  validTo: null,
  joinedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("TeamScreen effective authority presentation", () => {
  it("labels all effective states", () => {
    expect(Object.keys(TEAM_MEMBER_STATUS_LABEL).sort()).toEqual([
      "active", "disabled", "expired", "pending", "revoked", "scheduled", "suspended",
    ]);
  });

  it("only offers transitions valid for current authority", () => {
    expect(canDisableTeamMembership(member(), now)).toBe(true);
    expect(canDisableTeamMembership(member({ status: "scheduled", validFrom: "2026-08-01T00:00:00.000Z" }), now)).toBe(false);
    expect(canDisableTeamMembership(member({ status: "suspended", globalStatus: "suspended" }), now)).toBe(false);
    expect(canEnableTeamMembership(member({ membershipStatus: "disabled", status: "disabled" }), now)).toBe(true);
    expect(canEnableTeamMembership(member({ membershipStatus: "disabled", status: "disabled", validTo: "2026-07-01T00:00:00.000Z" }), now)).toBe(false);
  });

  it("fails closed for malformed validity and explains ineffective state", () => {
    expect(hasCurrentTeamMemberValidity(member({ validFrom: "invalid" }), now)).toBe(false);
    expect(teamMemberAuthorityDetail(member({ status: "scheduled", validFrom: "2026-08-01T00:00:00.000Z" }), now)).toContain("Hiệu lực từ");
    expect(teamMemberAuthorityDetail(member({ status: "suspended", globalStatus: "suspended" }), now)).toBe("Tài khoản bị tạm khóa toàn hệ thống");
  });
});
