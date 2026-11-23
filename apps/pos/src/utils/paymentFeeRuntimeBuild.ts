import { RuntimeBuildInfoV2Schema, type RuntimeBuildInfoV1, type RuntimeBuildInfoV2 } from "@medusa-snus/contracts/runtime-capabilities";

export function selectPaymentFeeRuntimeBuild(legacy: RuntimeBuildInfoV1 | null, body: unknown): RuntimeBuildInfoV2 | null {
  const parsed = RuntimeBuildInfoV2Schema.safeParse(body);
  if (!legacy || !parsed.success) return null;
  const fee = parsed.data;
  if (fee.service !== legacy.service || fee.sourceCommit !== legacy.sourceCommit || fee.releaseId !== legacy.releaseId
    || fee.compatibilityFamily !== legacy.compatibilityFamily
    || JSON.stringify(fee.capabilities) !== JSON.stringify(legacy.capabilities)) return null;
  return fee;
}
