import { describe, expect, it } from "vitest";
import {
  localMembershipDateTimeValue,
  membershipDateTimeToIso,
  platformMembershipRevokeReasonError,
  platformMembershipValidityErrors,
} from "./platform-membership-state";

describe("platform membership grant and revoke UI contract", () => {
  it("round-trips a local datetime and rejects inverted validity", () => {
    const local = localMembershipDateTimeValue(new Date("2026-07-29T10:15:00.000Z"));
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(new Date(membershipDateTimeToIso(local)).getTime()).toBe(new Date(local).getTime());
    expect(platformMembershipValidityErrors("2026-07-30T10:00", "2026-07-29T10:00").validTo)
      .toBe("Thời điểm kết thúc phải sau thời điểm bắt đầu.");
  });

  it("requires a bounded non-blank revoke reason", () => {
    expect(platformMembershipRevokeReasonError(" ")).toBe("Nhập lý do ít nhất 4 ký tự.");
    expect(platformMembershipRevokeReasonError("x".repeat(501))).toBe("Lý do không được vượt quá 500 ký tự.");
    expect(platformMembershipRevokeReasonError("Access retired")).toBeUndefined();
  });
});
