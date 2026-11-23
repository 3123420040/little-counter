import { describe, expect, it } from "vitest";
import {
  assertCanDelegateRequestedScope,
  assertTeamTargetPolicy,
  type TeamAuthority,
} from "../services/operator-team-service";

const owner: TeamAuthority = {
  hasMerchantOwnerAuthority: true,
  hasMerchantManagerAuthority: false,
  storeIds: [],
};

const merchantManager: TeamAuthority = {
  hasMerchantOwnerAuthority: false,
  hasMerchantManagerAuthority: true,
  storeIds: [],
};

const storeManager: TeamAuthority = {
  hasMerchantOwnerAuthority: false,
  hasMerchantManagerAuthority: false,
  storeIds: ["store_north", "store_south"],
};

describe("team authority policy", () => {
  it("allows an owner to manage and delegate non-owner authority", () => {
    expect(() => assertTeamTargetPolicy(owner, "owner_a", {
      operatorId: "manager_a",
      storeId: "store_north",
      hasOwnerAuthority: false,
      hasElevatedAuthority: true,
    })).not.toThrow();
    expect(() => assertCanDelegateRequestedScope(owner, "manager", "merchant", null)).not.toThrow();
  });

  it("allows merchant managers to manage staff but prevents elevated delegation", () => {
    expect(() => assertTeamTargetPolicy(merchantManager, "manager_a", {
      operatorId: "staff_a",
      storeId: null,
      hasOwnerAuthority: false,
      hasElevatedAuthority: false,
    })).not.toThrow();
    expect(() => assertCanDelegateRequestedScope(merchantManager, "staff", "merchant", null)).not.toThrow();
    for (const role of ["manager", "accountant"] as const) {
      expect(() => assertCanDelegateRequestedScope(merchantManager, role, "store", "store_north"))
        .toThrow("Managers can delegate only staff authority");
    }
  });

  it("prevents self-management and peer or higher-authority management", () => {
    expect(() => assertTeamTargetPolicy(storeManager, "manager_a", {
      operatorId: "manager_a",
      storeId: "store_north",
      hasOwnerAuthority: false,
      hasElevatedAuthority: false,
    })).toThrow("Operators cannot manage their own team authority");
    expect(() => assertTeamTargetPolicy(storeManager, "manager_a", {
      operatorId: "manager_b",
      storeId: "store_north",
      hasOwnerAuthority: false,
      hasElevatedAuthority: true,
    })).toThrow("Managers cannot manage peer or higher-authority operators");
  });

  it("honors every assigned store and rejects merchant or cross-store expansion", () => {
    for (const storeId of storeManager.storeIds) {
      expect(() => assertTeamTargetPolicy(storeManager, "manager_a", {
        operatorId: `staff_${storeId}`,
        storeId,
        hasOwnerAuthority: false,
        hasElevatedAuthority: false,
      })).not.toThrow();
      expect(() => assertCanDelegateRequestedScope(storeManager, "staff", "store", storeId)).not.toThrow();
    }
    expect(() => assertTeamTargetPolicy(storeManager, "manager_a", {
      operatorId: "staff_elsewhere",
      storeId: "store_other",
      hasOwnerAuthority: false,
      hasElevatedAuthority: false,
    })).toThrow("Store managers can manage only members in their own store");
    expect(() => assertCanDelegateRequestedScope(storeManager, "staff", "merchant", null))
      .toThrow("Store managers cannot delegate merchant or cross-store scope");
  });

  it("prevents owners from using team tools on themselves or another owner", () => {
    expect(() => assertTeamTargetPolicy(owner, "owner_a", {
      operatorId: "owner_a",
      storeId: null,
      hasOwnerAuthority: true,
      hasElevatedAuthority: true,
    })).toThrow("Operators cannot manage their own team authority");
    expect(() => assertTeamTargetPolicy(owner, "owner_a", {
      operatorId: "owner_b",
      storeId: "store_north",
      hasOwnerAuthority: true,
      hasElevatedAuthority: true,
    })).toThrow("Team tools cannot manage operators with owner authority");
  });
});
