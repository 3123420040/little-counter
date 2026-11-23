import { describe, expect, it } from "vitest";
import {
  STORE_BANK_SETTLEMENT_POLICY_METADATA_KEY,
  type StoreBankSettlementPolicyValue,
} from "@medusa-snus/contracts";
import {
  describeStoreSettlementPolicyFromMetadata,
  resolveStoreSettlementPolicyFromMetadata,
  StoreSettlementPolicyErrorV1,
} from "../services/store-settlement-policy-service";

function policyValue(overrides: Partial<StoreBankSettlementPolicyValue> = {}): StoreBankSettlementPolicyValue {
  return {
    mode: "confirm_on_booking",
    version: 3,
    updatedAt: "2026-09-06T08:00:00.000Z",
    updatedBy: "op_owner_1",
    ...overrides,
  };
}

describe("store bank settlement policy resolution (T01/PAY01)", () => {
  it("defaults to manual_confirmation with version 0 when the namespace is absent", () => {
    expect(resolveStoreSettlementPolicyFromMetadata(null)).toEqual({
      mode: "manual_confirmation",
      version: 0,
      source: "default",
      updatedAt: null,
      updatedBy: null,
    });
    expect(resolveStoreSettlementPolicyFromMetadata({})).toEqual({
      mode: "manual_confirmation",
      version: 0,
      source: "default",
      updatedAt: null,
      updatedBy: null,
    });
    expect(resolveStoreSettlementPolicyFromMetadata({ ownerSettings: { publicName: "X" } })).toEqual({
      mode: "manual_confirmation",
      version: 0,
      source: "default",
      updatedAt: null,
      updatedBy: null,
    });
  });

  it("reads a configured policy from a JSON string metadata blob", () => {
    const metadata = JSON.stringify({
      ownerSettings: { publicName: "Shop" },
      [STORE_BANK_SETTLEMENT_POLICY_METADATA_KEY]: policyValue({ mode: "manual_confirmation", version: 2 }),
    });
    expect(resolveStoreSettlementPolicyFromMetadata(metadata)).toEqual({
      mode: "manual_confirmation",
      version: 2,
      source: "configured",
      updatedAt: "2026-09-06T08:00:00.000Z",
      updatedBy: "op_owner_1",
    });
  });

  it("rejects an invalid enum mode instead of defaulting to money received", () => {
    const metadata = {
      [STORE_BANK_SETTLEMENT_POLICY_METADATA_KEY]: policyValue({ mode: "auto_settle" as never }),
    };
    expect(() => resolveStoreSettlementPolicyFromMetadata(metadata)).toThrow(StoreSettlementPolicyErrorV1);
  });

  it("rejects malformed shapes: missing keys, extra keys, non-integer versions", () => {
    const cases: unknown[] = [
      "not-an-object",
      42,
      [],
      { mode: "confirm_on_booking", version: 1 },
      { mode: "confirm_on_booking", version: 1, updatedAt: "2026-09-06T08:00:00.000Z", updatedBy: "op", extra: true },
      policyValue({ version: 0 }),
      policyValue({ version: 1.5 }),
      policyValue({ updatedAt: "" }),
      policyValue({ updatedBy: "" }),
    ];
    for (const malformed of cases) {
      expect(
        () => resolveStoreSettlementPolicyFromMetadata({ [STORE_BANK_SETTLEMENT_POLICY_METADATA_KEY]: malformed }),
        `expected rejection for ${JSON.stringify(malformed)}`,
      ).toThrow(StoreSettlementPolicyErrorV1);
    }
  });

  it("surfaces an invalid policy without throwing for settings reads", () => {
    const described = describeStoreSettlementPolicyFromMetadata({
      [STORE_BANK_SETTLEMENT_POLICY_METADATA_KEY]: { mode: "nonsense" },
    });
    expect(described).toEqual({ status: "invalid" });
    expect(describeStoreSettlementPolicyFromMetadata({}).status).toBe("ok");
  });

  it("ignores unrelated metadata corruption outside the policy namespace", () => {
    expect(resolveStoreSettlementPolicyFromMetadata({ otherNamespace: "garbage" }).mode)
      .toBe("manual_confirmation");
  });
});
