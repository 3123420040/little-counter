import { describe, expect, it } from "vitest";
import { formatVnd } from "../scan-go/formatVnd";

describe("formatVnd (VND only, never USD)", () => {
  it("groups thousands and appends the dong sign", () => {
    expect(formatVnd(250000)).toBe("250,000₫");
    expect(formatVnd(0)).toBe("0₫");
    expect(formatVnd(1250000)).toBe("1,250,000₫");
  });

  it("never renders USD or a dollar amount", () => {
    const out = formatVnd(250000);
    expect(out).not.toContain("USD");
    expect(out).not.toContain("$");
  });
});
