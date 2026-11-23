import { describe, expect, it } from "vitest";
import {
  selectCheckoutPolicy,
  selectFoundStockEnabled,
  selectCheckoutPolicyFailClosed,
  type CheckoutSettlementPolicySnapshot,
} from "./useCheckoutPolicy";

function policyResponse(overrides: Partial<CheckoutSettlementPolicySnapshot> = {}) {
  return {
    data: {
      merchantId: "merchant_1",
      storeId: "store_1",
      mode: "confirm_on_booking",
      policyVersion: 2,
      acknowledgmentVersion: 1,
      source: "configured",
      manualConfirmationEnabled: true,
      ...overrides,
    },
  };
}

describe("checkout settlement policy selection (T01/PAY01)", () => {
  it("selects a configured confirm_on_booking policy", () => {
    expect(selectCheckoutPolicy(policyResponse())).toEqual({
      status: "ready",
      manualConfirmationEnabled: true,
      mode: "confirm_on_booking",
      policyVersion: 2,
      acknowledgmentVersion: 1,
    });
  });

  it("selects the manual default policy", () => {
    expect(selectCheckoutPolicy(policyResponse({
      mode: "manual_confirmation",
      policyVersion: 0,
      source: "default",
    }))).toMatchObject({ status: "ready", mode: "manual_confirmation", policyVersion: 0 });
  });

  it("fails closed to manual for malformed, missing, or pending reads", () => {
    const unavailable = { status: "unavailable", mode: "manual_confirmation", policyVersion: 0, acknowledgmentVersion: 0, manualConfirmationEnabled: false };
    expect(selectCheckoutPolicy(null)).toEqual(unavailable);
    expect(selectCheckoutPolicy({ data: { mode: "auto_settle" } })).toEqual(unavailable);
    expect(selectCheckoutPolicy({ data: { mode: "confirm_on_booking", policyVersion: "2" } })).toEqual(unavailable);
    expect(selectCheckoutPolicyFailClosed({ isPending: true, isError: false, data: undefined })).toEqual({
      ...unavailable,
      status: "pending",
    });
    expect(selectCheckoutPolicyFailClosed({ isPending: false, isError: true, data: undefined })).toEqual(unavailable);
  });

  it("never trusts non-integer policy versions", () => {
    expect(selectCheckoutPolicy(policyResponse({ policyVersion: Number.NaN }))).toMatchObject({
      status: "unavailable",
      mode: "manual_confirmation",
    });
  });
});

it("rejects responses without authoritative capability", () => {
  expect(selectCheckoutPolicy(policyResponse({ manualConfirmationEnabled: undefined }))).toMatchObject({ status: "unavailable" });
});

describe("independent found-stock policy selection", () => {
  it("fails closed without invalidating a valid bank settlement policy", () => {
    const body = { ...policyResponse(), data: { ...policyResponse().data, foundStockCheckout: { status: "invalid", enabled: false } } };
    expect(selectCheckoutPolicy(body).status).toBe("ready");
    expect(selectFoundStockEnabled(body)).toBe(false);
    expect(selectFoundStockEnabled({ data: { foundStockCheckout: { status: "ok", enabled: true } } })).toBe(true);
    expect(selectFoundStockEnabled({ data: { foundStockCheckout: { status: "ok", enabled: "true" } } })).toBe(false);
    expect(selectFoundStockEnabled(null)).toBe(false);
  });
});
