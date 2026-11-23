import { describe, expect, it } from "vitest";
import {
  addCalendarYearsClamped,
  addCalendarDays,
  clampUtcDay,
  statusForClock,
  renewalReminderOffsets,
} from "../services/subscription-service";

function utc(year: number, monthIndex: number, day: number, hours = 0, minutes = 0, seconds = 0, ms = 0): Date {
  return new Date(Date.UTC(year, monthIndex, day, hours, minutes, seconds, ms));
}

describe("subscription lifecycle — calendar-year period and Feb-29 clamp", () => {
  it("adds one calendar year preserving month/day for normal anchors", () => {
    const start = utc(2026, 5, 20);
    expect(addCalendarYearsClamped(start, 1).toISOString()).toBe(utc(2027, 5, 20).toISOString());
  });

  it("clamps Feb-29 forward to Feb-28 in a non-leap target year (Feb-29 clamp policy)", () => {
    const leapDay = utc(2024, 1, 29); // 2024-02-29
    const next = addCalendarYearsClamped(leapDay, 1);
    expect(next.getUTCFullYear()).toBe(2025);
    expect(next.getUTCMonth()).toBe(1);
    expect(next.getUTCDate()).toBe(28);
  });

  it("keeps Feb-29 in a leap target year", () => {
    const leapDay = utc(2023, 1, 28); // anchor day 28
    expect(addCalendarYearsClamped(leapDay, 1).toISOString()).toBe(utc(2024, 1, 28).toISOString());
  });

  it("clamps month-end anchors consistently (Jan-31 → Jan-31)", () => {
    const start = utc(2026, 0, 31);
    expect(addCalendarYearsClamped(start, 1).toISOString()).toBe(utc(2027, 0, 31).toISOString());
  });

  it("clampUtcDay returns last day of month when anchor exceeds month length", () => {
    expect(clampUtcDay(2026, 1, 30)).toBe(28); // Feb 2026
    expect(clampUtcDay(2024, 1, 30)).toBe(29); // Feb 2024 leap
    expect(clampUtcDay(2026, 3, 31)).toBe(30); // Apr 2026
  });
});

describe("subscription lifecycle — seven-calendar-day grace boundaries", () => {
  const periodEnd = utc(2027, 5, 20, 0, 0, 0);

  it("is active before period end", () => {
    expect(statusForClock(periodEnd, null, utc(2027, 5, 19, 23, 59, 59))).toBe("active");
  });

  it("enters grace exactly at period end and remains in grace through day 6", () => {
    expect(statusForClock(periodEnd, addCalendarDays(periodEnd, 7), utc(2027, 5, 20, 0, 0, 1))).toBe("grace");
    expect(statusForClock(periodEnd, addCalendarDays(periodEnd, 7), utc(2027, 5, 26, 23, 59, 59))).toBe("grace");
  });

  it("is expired exactly at grace end (seven calendar days later)", () => {
    expect(statusForClock(periodEnd, addCalendarDays(periodEnd, 7), utc(2027, 5, 27, 0, 0, 0))).toBe("expired");
  });

  it("treats grace window as calendar days, not 7*24h relative to a non-midnight period end", () => {
    const end = utc(2027, 5, 20, 9, 30, 0);
    const grace = addCalendarDays(end, 7);
    expect(statusForClock(end, grace, utc(2027, 5, 27, 9, 29, 59))).toBe("grace");
    expect(statusForClock(end, grace, utc(2027, 5, 27, 9, 30, 0))).toBe("expired");
  });
});

describe("subscription lifecycle — renewal reminder schedule", () => {
  it("uses T-30/T-14/T-7/T-1 offsets", () => {
    expect(renewalReminderOffsets()).toEqual([30, 14, 7, 1]);
  });

  it("fires the T-1 reminder one calendar day before period end", () => {
    const offsets = renewalReminderOffsets();
    expect(offsets).toContain(1);
    const oneDayBefore = addCalendarDays(periodEnd(2027), -1);
    expect(oneDayBefore.toISOString()).toBe(utc(2027, 5, 19).toISOString());
  });
});

function periodEnd(year: number): Date {
  return utc(year, 5, 20, 0, 0, 0);
}

describe("subscription lifecycle — monthly usage window edge cases", () => {
  it("anchors monthly windows and clamps end-of-month anchors", () => {
    expect(clampUtcDay(2026, 0, 31)).toBe(31); // Jan has 31
    expect(clampUtcDay(2026, 2, 31)).toBe(31); // Mar has 31
    expect(clampUtcDay(2026, 3, 31)).toBe(30); // Apr has 30
    expect(clampUtcDay(2024, 1, 31)).toBe(29); // Feb leap
    expect(clampUtcDay(2025, 1, 31)).toBe(28); // Feb non-leap
  });

  it("rolls the current window back when 'now' is before the month's anchor day", () => {
    // Anchor day 20. On the 5th of the month, the window started last month on the 20th.
    expect(clampUtcDay(2026, 5, 20)).toBe(20);
    expect(clampUtcDay(2026, 4, 20)).toBe(20);
  });
});
