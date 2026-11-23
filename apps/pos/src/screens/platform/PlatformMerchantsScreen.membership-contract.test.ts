import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./PlatformMerchantsScreen.tsx", import.meta.url), "utf8");

describe("PlatformMerchantsScreen bounded membership contract", () => {
  it("reviews grant validity before mutation", () => {
    expect(source).toContain("onClick={() => setGrantReviewOpen(true)}");
    expect(source).toContain("validFrom: membershipDateTimeToIso(form.validFrom)");
    expect(source).toContain("validTo: form.validTo ? membershipDateTimeToIso(form.validTo) : null");
  });

  it("requires a reason and renders effective validity", () => {
    expect(source).toContain('label="Lý do thu hồi"');
    expect(source).toContain("reason: revokeReason.trim()");
    expect(source).toContain("membership.effectiveStatus");
    expect(source).toContain("platformMembershipValidityLabel(membership)");
  });
});
