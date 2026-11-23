import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./TeamScreen.tsx", import.meta.url), "utf8");

describe("TeamScreen effective authority contract", () => {
  it("renders the effective state and guards state-transition affordances", () => {
    expect(source).toContain("TEAM_MEMBER_STATUS_TONE[member.status]");
    expect(source).toContain("teamMemberAuthorityDetail(member)");
    expect(source).toContain("canDisableTeamMembership(member)");
    expect(source).toContain("canEnableTeamMembership(member)");
    expect(source).not.toContain('member.status === "active"');
  });
});
