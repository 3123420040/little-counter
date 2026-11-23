import { describe, expect, it } from "vitest";
import {
  AuthorizationTargetV1Schema,
  ScopeCoupledAuthorizationDecisionV1Schema,
} from "../authorization-policy";

describe("AUTH-01 coupled authorization contract", () => {
  it.each([
    { scopeType: "platform" },
    { scopeType: "merchant", merchantId: "merchant_a" },
    { scopeType: "store", merchantId: "merchant_a", storeId: "store_a" },
  ])("accepts one explicit target: %j", (target) => {
    expect(AuthorizationTargetV1Schema.parse(target)).toEqual(target);
  });

  it("rejects ambiguous, incomplete and extra target scope", () => {
    for (const target of [
      { scopeType: "merchant" },
      { scopeType: "store", merchantId: "merchant_a" },
      { scopeType: "platform", merchantId: "merchant_a" },
      { scopeType: "all", merchantId: "merchant_a" },
    ]) expect(AuthorizationTargetV1Schema.safeParse(target).success).toBe(false);
  });

  it("requires a single scoped proof for an allowed decision", () => {
    expect(ScopeCoupledAuthorizationDecisionV1Schema.parse({
      allowed: true,
      permissionId: "order:write",
      target: { scopeType: "store", merchantId: "merchant_a", storeId: "store_a" },
      proof: {
        sourceType: "membership",
        sourceId: "membership_a",
        scopeType: "store",
      },
    })).toBeTruthy();
    expect(ScopeCoupledAuthorizationDecisionV1Schema.safeParse({
      allowed: true,
      permissionId: "order:write",
      target: { scopeType: "store", merchantId: "merchant_a", storeId: "store_a" },
      proof: null,
    }).success).toBe(false);
  });
});
