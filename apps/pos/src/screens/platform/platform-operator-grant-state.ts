import type { PlatformOperatorDto } from "../../api/settings-endpoints";

export type PlatformOperatorExplicitGrant = PlatformOperatorDto["explicitGrants"][number];

export function isEffectivePlatformOperatorGrant(
  grant: PlatformOperatorExplicitGrant,
  now = new Date(),
): boolean {
  if (grant.status !== "active") return false;
  const nowMs = now.getTime();
  const validFromMs = Date.parse(grant.validFrom);
  const validToMs = grant.validTo ? Date.parse(grant.validTo) : null;
  if (!Number.isFinite(nowMs) || !Number.isFinite(validFromMs) || (validToMs !== null && !Number.isFinite(validToMs))) {
    return false;
  }
  if (validFromMs > nowMs) return false;
  return validToMs === null || validToMs > nowMs;
}
