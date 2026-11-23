import { describe, expect, it } from "vitest";
import { usageWindowForAnchor } from "../services/subscription-usage-service";

function utc(year: number, monthIndex: number, day: number, hours = 0, minutes = 0, seconds = 0, ms = 0): Date {
  return new Date(Date.UTC(year, monthIndex, day, hours, minutes, seconds, ms));
}

describe("subscription usage — monthly anniversary windows", () => {
  const periodStartIso = utc(2026, 5, 20, 9, 0, 0).toISOString();
  const anchorDay = 20;

  it("creates a window covering the current month when now is after the anchor", () => {
    const now = utc(2026, 6, 25, 12, 0, 0);
    const window = usageWindowForAnchor(periodStartIso, anchorDay, now);
    expect(window.start.toISOString()).toBe(utc(2026, 6, 20, 9, 0, 0).toISOString());
    expect(window.end.toISOString()).toBe(utc(2026, 7, 20, 9, 0, 0).toISOString());
  });

  it("rolls back to the previous window when now is before the anchor", () => {
    const now = utc(2026, 6, 15, 12, 0, 0);
    const window = usageWindowForAnchor(periodStartIso, anchorDay, now);
    expect(window.start.toISOString()).toBe(utc(2026, 5, 20, 9, 0, 0).toISOString());
    expect(window.end.toISOString()).toBe(utc(2026, 6, 20, 9, 0, 0).toISOString());
  });

  it("clamps the anchor day at month end (31 → 30 in April)", () => {
    const periodStartIso31 = utc(2026, 0, 31, 9, 0, 0).toISOString();
    const now = utc(2026, 3, 15, 12, 0, 0);
    const window = usageWindowForAnchor(periodStartIso31, 31, now);
    expect(window.start.toISOString()).toBe(utc(2026, 2, 31, 9, 0, 0).toISOString());
    expect(window.end.toISOString()).toBe(utc(2026, 3, 30, 9, 0, 0).toISOString());
  });

  it("handles the Feb-29 anchor clamp in non-leap years", () => {
    const periodStartIsoFeb29 = utc(2024, 1, 29, 9, 0, 0).toISOString();
    const now = utc(2025, 1, 10, 12, 0, 0); // Feb 2025, anchor 29 should clamp to 28
    const window = usageWindowForAnchor(periodStartIsoFeb29, 29, now);
    expect(window.start.toISOString()).toBe(utc(2025, 0, 29, 9, 0, 0).toISOString());
    expect(window.end.toISOString()).toBe(utc(2025, 1, 28, 9, 0, 0).toISOString());
  });
});
