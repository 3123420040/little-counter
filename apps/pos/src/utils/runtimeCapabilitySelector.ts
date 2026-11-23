import {
  RUNTIME_COMPATIBILITY_FAMILY_V1,
  RuntimeBuildInfoV1Schema,
  runtimeCapabilityNamesV1,
  runtimeCapabilityVersionsV1,
  type RuntimeBuildInfoV1,
  type RuntimeCapabilityNameV1,
  type RuntimeCapabilityVersionV1,
} from "@medusa-snus/contracts/runtime-capabilities";

type RuntimeCapabilityClientManifestV1 = {
  compatibilityFamily: typeof RUNTIME_COMPATIBILITY_FAMILY_V1;
  capabilities: {
    [Capability in RuntimeCapabilityNameV1]: readonly (
      typeof runtimeCapabilityVersionsV1
    )[Capability][number][];
  };
};

export const POS_RUNTIME_CAPABILITIES_V1 = {
  compatibilityFamily: RUNTIME_COMPATIBILITY_FAMILY_V1,
  capabilities: {
    ordersRead: ["v2", "v3", "v4"],
    orderDetail: ["v1", "v2"],
    orderRecreate: ["v1", "v2"],
    checkoutWrite: ["v1"],
    paymentWrite: ["v1"],
    dashboardRead: ["v1", "v2"],
  },
} as const satisfies RuntimeCapabilityClientManifestV1;

export type RuntimeCapabilityHandshakeV1 =
  | { status: "pending" }
  | { status: "unreachable" }
  | { status: "received"; body: unknown };

export type RuntimeCapabilityHandshakeStateV1 =
  | "pending"
  | "compatible"
  | "v2_compatibility"
  | "partial"
  | "invalid"
  | "unreachable"
  | "family_mismatch";

type SelectedRuntimeCapabilitiesV1 = {
  [Capability in RuntimeCapabilityNameV1]:
    (typeof runtimeCapabilityVersionsV1)[Capability][number] | null;
};

export interface RuntimeCapabilitySelectionV1 {
  handshakeState: RuntimeCapabilityHandshakeStateV1;
  trustedForOnlineWrites: boolean;
  serverBuild: RuntimeBuildInfoV1 | null;
  selected: SelectedRuntimeCapabilitiesV1;
  surfaces: {
    ordersRead: "skeleton" | "v4" | "v3" | "v2_compatibility" | "unavailable";
    customerAttribution: "pending" | "verified" | "unknown" | "unavailable";
    customerDependentActions: "enabled" | "blocked";
    orderRecreateCustomerPrefill: "enabled" | "blocked";
    orderDetail: "enabled" | "blocked";
    orderRecreate: "enabled" | "blocked";
    checkoutWrite: "enabled" | "blocked";
    paymentWrite: "enabled" | "blocked";
    dashboardRead: "skeleton" | "enabled" | "unavailable";
  };
}

function emptySelected(): SelectedRuntimeCapabilitiesV1 {
  return {
    ordersRead: null,
    orderDetail: null,
    orderRecreate: null,
    checkoutWrite: null,
    paymentWrite: null,
    dashboardRead: null,
  };
}

function untrustedSelection(
  state: "pending" | "invalid" | "unreachable" | "family_mismatch",
): RuntimeCapabilitySelectionV1 {
  const pending = state === "pending";
  return {
    handshakeState: state,
    trustedForOnlineWrites: false,
    serverBuild: null,
    selected: emptySelected(),
    surfaces: {
      ordersRead: pending ? "skeleton" : "unavailable",
      customerAttribution: pending ? "pending" : "unavailable",
      customerDependentActions: "blocked",
      orderRecreateCustomerPrefill: "blocked",
      orderDetail: "blocked",
      orderRecreate: "blocked",
      checkoutWrite: "blocked",
      paymentWrite: "blocked",
      dashboardRead: pending ? "skeleton" : "unavailable",
    },
  };
}

function highestCommonVersion(
  capability: RuntimeCapabilityNameV1,
  client: readonly RuntimeCapabilityVersionV1[],
  server: readonly RuntimeCapabilityVersionV1[],
): RuntimeCapabilityVersionV1 | null {
  const canonical = runtimeCapabilityVersionsV1[capability];
  for (let index = canonical.length - 1; index >= 0; index -= 1) {
    const version = canonical[index]!;
    if (
      (client as readonly RuntimeCapabilityVersionV1[]).includes(version)
      && (server as readonly RuntimeCapabilityVersionV1[]).includes(version)
    ) return version;
  }
  return null;
}

export function selectRuntimeCapabilities(
  handshake: RuntimeCapabilityHandshakeV1,
  client: RuntimeCapabilityClientManifestV1 = POS_RUNTIME_CAPABILITIES_V1,
): RuntimeCapabilitySelectionV1 {
  if (handshake.status === "pending") return untrustedSelection("pending");
  if (handshake.status === "unreachable") return untrustedSelection("unreachable");

  const receivedFamily = typeof handshake.body === "object" && handshake.body !== null
    ? (handshake.body as { compatibilityFamily?: unknown }).compatibilityFamily
    : undefined;
  if (
    typeof receivedFamily === "string"
    && receivedFamily !== client.compatibilityFamily
  ) return untrustedSelection("family_mismatch");

  const parsed = RuntimeBuildInfoV1Schema.safeParse(handshake.body);
  if (!parsed.success) return untrustedSelection("invalid");

  const selected = emptySelected();
  for (const capability of runtimeCapabilityNamesV1) {
    (selected as Record<RuntimeCapabilityNameV1, RuntimeCapabilityVersionV1 | null>)[capability]
      = highestCommonVersion(
      capability,
      client.capabilities[capability],
      parsed.data.capabilities[capability],
    );
  }
  const ordersRead = selected.ordersRead;
  const hasEveryCapability = runtimeCapabilityNamesV1.every(
    (capability) => selected[capability] !== null,
  );
  const handshakeState: RuntimeCapabilityHandshakeStateV1 = ordersRead === "v2"
    ? "v2_compatibility"
    : hasEveryCapability
      ? "compatible"
      : "partial";
  return {
    handshakeState,
    trustedForOnlineWrites: true,
    serverBuild: parsed.data,
    selected,
    surfaces: {
      ordersRead: ordersRead === "v4"
        ? "v4"
        : ordersRead === "v3"
          ? "v3"
        : ordersRead === "v2"
          ? "v2_compatibility"
          : "unavailable",
      customerAttribution: ordersRead === "v3" || ordersRead === "v4"
        ? "verified"
        : ordersRead === "v2"
          ? "unknown"
          : "unavailable",
      customerDependentActions: (ordersRead === "v3" || ordersRead === "v4") && selected.orderDetail === "v2"
        ? "enabled"
        : "blocked",
      orderRecreateCustomerPrefill: (ordersRead === "v3" || ordersRead === "v4")
        && selected.orderDetail === "v2"
        && selected.orderRecreate === "v2"
        ? "enabled"
        : "blocked",
      orderDetail: selected.orderDetail ? "enabled" : "blocked",
      orderRecreate: selected.orderRecreate ? "enabled" : "blocked",
      checkoutWrite: selected.checkoutWrite ? "enabled" : "blocked",
      paymentWrite: selected.paymentWrite ? "enabled" : "blocked",
      dashboardRead: selected.dashboardRead ? "enabled" : "unavailable",
    },
  };
}

export function resolveCapabilityRequestFailure(_failure: {
  capability: RuntimeCapabilityNameV1;
  selectedVersion: RuntimeCapabilityVersionV1;
  httpStatus: number;
}) {
  return {
    action: "surface_error" as const,
    downgradeTo: null,
    requiresFreshHandshake: true,
  };
}
