import type { RuntimeCapabilitySelectionV1 } from "./runtimeCapabilitySelector";

export type OrderHistoryCapabilityBindingV1 = {
  effectivePageEnabled: boolean;
  legacyOrdersEnabled: boolean;
  capabilityPending: boolean;
  v2Compatibility: boolean;
  explicitUnavailable: boolean;
};

export function bindOrderHistoryCapabilities(
  runtime: Pick<RuntimeCapabilitySelectionV1, "handshakeState" | "surfaces">,
  feeAwareOrders = false,
): OrderHistoryCapabilityBindingV1 {
  const effectivePageEnabled = feeAwareOrders || runtime.surfaces.ordersRead === "v4";
  const capabilityPending = runtime.handshakeState === "pending";
  const v2Compatibility = !feeAwareOrders && runtime.surfaces.ordersRead === "v2_compatibility";
  return {
    effectivePageEnabled,
    legacyOrdersEnabled: v2Compatibility,
    capabilityPending,
    v2Compatibility,
    explicitUnavailable: !feeAwareOrders && (runtime.surfaces.ordersRead === "unavailable" || runtime.surfaces.ordersRead === "v3"),
  };
}
