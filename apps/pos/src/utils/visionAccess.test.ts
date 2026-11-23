import { describe, expect, it } from "vitest";
import { canAccessVisionOps } from "./visionAccess";

describe("canAccessVisionOps", () => {
  it("requires the correction-report feature entitlement", () => {
    expect(canAccessVisionOps({
      featureEntitlements: ["vision_pos_input"],
      permissionIds: ["vision_scan:read"],
    })).toBe(false);
  });

  it("requires a vision report or catalog permission", () => {
    expect(canAccessVisionOps({
      featureEntitlements: ["vision_correction_report"],
      permissionIds: ["vision_scan:use"],
    })).toBe(false);
  });

  it.each(["vision_scan:read", "vision_catalog:write"])(
    "allows AI Fan operators with %s",
    (permissionId) => {
      expect(canAccessVisionOps({
        featureEntitlements: ["vision_correction_report"],
        permissionIds: [permissionId],
      })).toBe(true);
    },
  );
});
