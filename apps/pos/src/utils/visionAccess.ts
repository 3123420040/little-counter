const VISION_OPS_FEATURE = "vision_correction_report";
const VISION_OPS_PERMISSIONS = new Set(["vision_scan:read", "vision_catalog:write"]);

export interface VisionOpsAccessInput {
  featureEntitlements?: readonly string[];
  permissionIds?: readonly string[];
}

export function canAccessVisionOps(input: VisionOpsAccessInput): boolean {
  if (!input.featureEntitlements?.includes(VISION_OPS_FEATURE)) return false;
  return Boolean(input.permissionIds?.some((permissionId) => VISION_OPS_PERMISSIONS.has(permissionId)));
}
