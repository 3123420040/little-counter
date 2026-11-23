import {
  runtimeCapabilityNamesV1,
  runtimeCapabilityVersionsV1,
  type RuntimeCapabilityNameV1,
  type RuntimeCapabilityVersionV1,
} from "@medusa-snus/contracts/runtime-capabilities";
import type { RuntimeCapabilityHandshakeStateV1 } from "./runtimeCapabilitySelector";

const telemetryEvents = new Set([
  "runtime_capability_selected",
  "runtime_capability_mismatch",
  "runtime_capability_v2_usage",
]);
const handshakeStates = new Set<RuntimeCapabilityHandshakeStateV1>([
  "pending",
  "compatible",
  "v2_compatibility",
  "partial",
  "invalid",
  "unreachable",
  "family_mismatch",
]);
const capabilityNames = new Set<RuntimeCapabilityNameV1>(runtimeCapabilityNamesV1);

export interface RuntimeCapabilityTelemetryInputV1 {
  event: "runtime_capability_selected" | "runtime_capability_mismatch" | "runtime_capability_v2_usage";
  capability: RuntimeCapabilityNameV1;
  handshakeState: RuntimeCapabilityHandshakeStateV1;
  selectedVersion: RuntimeCapabilityVersionV1 | null;
  serverVersions: RuntimeCapabilityVersionV1[];
  clientVersions: RuntimeCapabilityVersionV1[];
  sourceCommit: string;
  releaseId: string;
}

function validVersions(
  capability: RuntimeCapabilityNameV1,
  versions: RuntimeCapabilityVersionV1[],
): boolean {
  const supported = runtimeCapabilityVersionsV1[capability] as readonly string[];
  return new Set(versions).size === versions.length
    && versions.every((version) => supported.includes(version));
}

/** Builds a fixed-schema event. Unknown input properties are never copied. */
export function createRuntimeCapabilityTelemetry(input: RuntimeCapabilityTelemetryInputV1) {
  const safeRelease = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(input.releaseId)
    && input.releaseId !== "unknown"
    && input.releaseId !== "local";
  if (
    !telemetryEvents.has(input.event)
    || !capabilityNames.has(input.capability)
    || !handshakeStates.has(input.handshakeState)
    || !/^[0-9a-f]{40}$/.test(input.sourceCommit)
    || !safeRelease
    || !validVersions(input.capability, input.serverVersions)
    || !validVersions(input.capability, input.clientVersions)
    || (input.selectedVersion !== null
      && !validVersions(input.capability, [input.selectedVersion]))
  ) {
    throw new Error("Runtime capability telemetry identity or version is unsafe");
  }
  return {
    schemaVersion: 1 as const,
    event: input.event,
    capability: input.capability,
    handshakeState: input.handshakeState,
    selectedVersion: input.selectedVersion,
    serverVersions: [...input.serverVersions],
    clientVersions: [...input.clientVersions],
    sourceCommitPrefix: input.sourceCommit.slice(0, 12),
    releaseId: input.releaseId,
  };
}
