import {
  RUNTIME_COMPATIBILITY_FAMILY_V1,
  RuntimeBuildInfoV1Schema,
  emptyRuntimeCapabilitySetV1,
  runtimeCapabilityNamesV1,
  runtimeCapabilityTokensV1,
  runtimeCapabilityVersionsV1,
  type RuntimeBuildInfoV1,
  type RuntimeCapabilityTokenV1,
  RuntimeBuildInfoV2Schema,
  emptyPaymentFeeCapabilitySetV1,
  paymentFeeCapabilityNamesV1,
  paymentFeeCapabilityVersionsV1,
  paymentFeeCapabilityTokensV1,
  type PaymentFeeCapabilityTokenV1,
  type RuntimeBuildInfoV2,
} from "@medusa-snus/contracts/runtime-capabilities";
import { compiledRuntimeCapabilityRouteTokensV1, compiledPaymentFeeCapabilityRouteTokensV1 } from "./runtime-capability-route-manifest";

type BuildInfoEnvironment = Partial<Pick<NodeJS.ProcessEnv,
  | "BUILD_SOURCE_COMMIT"
  | "BUILD_RELEASE_ID"
  | "BUILD_COMPATIBILITY_FAMILY"
  | "BUILD_ROUTE_CAPABILITIES"
  | "BUILD_CONFIG_CAPABILITIES"
  | "BUILD_DATABASE_CAPABILITIES"
>>;

const supportedTokens = new Set<string>(runtimeCapabilityTokensV1);

function parseReadinessAttestation(value: string | undefined, allowedTokens: ReadonlySet<string> = supportedTokens): Set<string> {
  if (!value?.trim()) return new Set();
  const tokens = value.split(",").map((token) => token.trim());
  if (
    tokens.some((token) => !allowedTokens.has(token))
    || new Set(tokens).size !== tokens.length
  ) {
    throw new Error("Build capability readiness contains an unknown or duplicate capability token");
  }
  return new Set(tokens);
}

function intersectReadiness(environment: BuildInfoEnvironment) {
  const layers = [
    new Set(compiledRuntimeCapabilityRouteTokensV1),
    parseReadinessAttestation(environment.BUILD_ROUTE_CAPABILITIES),
    parseReadinessAttestation(environment.BUILD_CONFIG_CAPABILITIES),
    parseReadinessAttestation(environment.BUILD_DATABASE_CAPABILITIES),
  ];
  const capabilities = emptyRuntimeCapabilitySetV1();
  for (const capability of runtimeCapabilityNamesV1) {
    for (const version of runtimeCapabilityVersionsV1[capability]) {
      const token = `${capability}:${version}` as RuntimeCapabilityTokenV1;
      if (layers.every((layer) => layer.has(token))) {
        (capabilities[capability] as string[]).push(version);
      }
    }
  }
  return capabilities;
}

/**
 * Public immutable build identity. Capability readiness is the strict
 * intersection of route, configuration, and database/ACL attestations. A
 * missing layer therefore advertises nothing instead of guessing readiness.
 */
export function getBuildInfo(
  service: string,
  environment: BuildInfoEnvironment = process.env,
): RuntimeBuildInfoV1 {
  const candidate = {
    service,
    sourceCommit: environment.BUILD_SOURCE_COMMIT,
    releaseId: environment.BUILD_RELEASE_ID,
    compatibilityFamily: environment.BUILD_COMPATIBILITY_FAMILY,
    capabilities: intersectReadiness(environment),
  };
  const parsed = RuntimeBuildInfoV1Schema.safeParse(candidate);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(" ") || "identity";
    if (field === "compatibilityFamily") {
      throw new Error(
        `Build compatibility family must be ${RUNTIME_COMPATIBILITY_FAMILY_V1}`,
      );
    }
    throw new Error(`Build ${field.replace(/([A-Z])/g, " $1").toLowerCase()} is missing or unsafe`);
  }
  return parsed.data;
}

type FeeBuildInfoEnvironment = BuildInfoEnvironment & Partial<Pick<NodeJS.ProcessEnv,
  "BUILD_FEE_ROUTE_CAPABILITIES" | "BUILD_FEE_CONFIG_CAPABILITIES" | "BUILD_FEE_DATABASE_CAPABILITIES"
>>;
const supportedFeeTokens = new Set<string>(paymentFeeCapabilityTokensV1);
export function getBuildInfoV2(service: string, environment: FeeBuildInfoEnvironment = process.env): RuntimeBuildInfoV2 {
  const legacy = getBuildInfo(service, environment);
  const layers = [new Set(compiledPaymentFeeCapabilityRouteTokensV1),
    parseReadinessAttestation(environment.BUILD_FEE_ROUTE_CAPABILITIES, supportedFeeTokens),
    parseReadinessAttestation(environment.BUILD_FEE_CONFIG_CAPABILITIES, supportedFeeTokens),
    parseReadinessAttestation(environment.BUILD_FEE_DATABASE_CAPABILITIES, supportedFeeTokens)];
  const paymentFeeCapabilities = emptyPaymentFeeCapabilitySetV1();
  for (const name of paymentFeeCapabilityNamesV1) {
    for (const version of paymentFeeCapabilityVersionsV1[name]) {
      const token = `${name}:${version}` as PaymentFeeCapabilityTokenV1;
      if (layers.every((layer) => layer.has(token))) (paymentFeeCapabilities[name] as string[]).push(version);
    }
  }
  if (paymentFeeCapabilityNamesV1.some((name) => name !== "paymentFeeWrite" && paymentFeeCapabilities[name].length === 0)
    || !legacy.capabilities.checkoutWrite.includes("v1") || !legacy.capabilities.paymentWrite.includes("v1")) {
    paymentFeeCapabilities.paymentFeeWrite = [];
  }
  return RuntimeBuildInfoV2Schema.parse({ ...legacy, schemaVersion: 2, paymentFeeCapabilities });
}
