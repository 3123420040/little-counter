import { describe, expect, it } from "vitest";
import {
  EFFECTIVE_ORDER_FIXTURES,
  changedFixtureNames,
  originalFallbackProjection,
  projectEffectiveOrder,
  type EffectiveOrderOracleInput,
} from "./effective-order-oracle-fixtures";

describe("TEST-01 independent effective-order oracle", () => {
  it("matches hand-derived totals for every approved correction shape", () => {
    for (const fixture of EFFECTIVE_ORDER_FIXTURES) {
      expect(projectEffectiveOrder(fixture.input), fixture.name).toEqual(fixture.expected);
    }
  });

  it("catches a mutation that falls back to original order facts", () => {
    for (const name of changedFixtureNames) {
      const fixture = EFFECTIVE_ORDER_FIXTURES.find((item) => item.name === name)!;
      expect(originalFallbackProjection(fixture.input), name).not.toEqual(fixture.expected);
    }
  });

  it("ignores a newer pending revision and uses the latest applied revision", () => {
    const fixture = EFFECTIVE_ORDER_FIXTURES.find((item) => item.name === "multiple revisions")!;
    const withPending: EffectiveOrderOracleInput = {
      ...fixture.input,
      revisions: [
        ...fixture.input.revisions,
        {
          id: "rev-pending",
          revision: 99,
          status: "pending_settlement",
          effectiveAt: "2026-08-04T12:00:00.000Z",
          snapshot: {
            lines: [{ sku: "WRONG", quantity: 99, unitPriceMinor: 999_999 }],
            discountMinor: 0,
            shippingMinor: 0,
            vatMinor: 0,
            unclassifiedMinor: 0,
            totalMinor: 98_999_901,
          },
        },
      ],
    };

    expect(projectEffectiveOrder(withPending)).toEqual(fixture.expected);
  });

  it("fails closed on fractional minor units and inconsistent component arithmetic", () => {
    const fixture = EFFECTIVE_ORDER_FIXTURES[0]!;
    expect(() => projectEffectiveOrder({
      ...fixture.input,
      original: {
        ...fixture.input.original,
        shippingMinor: 0.5,
      },
    })).toThrow("integer minor units");

    expect(() => projectEffectiveOrder({
      ...fixture.input,
      original: {
        ...fixture.input.original,
        totalMinor: fixture.input.original.totalMinor + 1,
      },
    })).toThrow("component arithmetic");
  });
});
