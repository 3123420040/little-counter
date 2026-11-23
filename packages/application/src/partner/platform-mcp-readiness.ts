import { createHash } from "node:crypto";
import { z } from "zod";
import { PlatformMcpCommandMetadataV1Schema } from "@medusa-snus/contracts";
import { RuntimeBuildInfoV1Schema } from "@medusa-snus/contracts/runtime-capabilities";
import type { PartnerEnvironment } from "@medusa-snus/contracts/partner-api";
import { PlatformError } from "../errors/platform-error";
import { readPrivateFile } from "../utils/private-file";
import { getBuildInfo } from "../services/build-info-service";
import { commercialAdjustmentContext } from "../services/order-total-service";
import { vatRatePpmFromRate } from "../services/payment-fee-calculation";
import { hashPlatformMcpPolicyV1 } from "../services/platform-mcp-authorization-snapshot";
import { platformMcpIssuancePresetV1 } from "../services/platform-mcp-policy";
import { canonicalPartnerJson } from "./fingerprints";
import { trustedPlatformMcpUrlForHost } from "./platform-mcp-url";
import { readBoundedResponse } from "./bounded-response";

export const PLATFORM_MCP_READINESS_PATH = "/mcp-control-readiness";
export const PLATFORM_MCP_CONFORMANCE_FILE = "/run/partner/mcp-conformance.json";
const productionReplicaUrls = ["partner-api-a", "partner-api-b"].map(host => `http://${host}:9001${PLATFORM_MCP_READINESS_PATH}`);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const image = z.string().regex(/^[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/);
const candidate = z.object({ sourceCommit: RuntimeBuildInfoV1Schema.shape.sourceCommit,
  releaseId: RuntimeBuildInfoV1Schema.shape.releaseId, apiImage: image }).strict();
const mcpUrl = PlatformMcpCommandMetadataV1Schema.shape.mcpUrl.unwrap();
export const PlatformMcpDeploymentArtifactV1Schema = z.object({
  schemaVersion: z.literal(1), workflowVersion: z.literal("platform-mcp-v1"), environment: z.enum(["sandbox", "production"]),
  candidate, mcpUrl, schemaFingerprintSha256: sha256, apiConfigurationSha256: sha256,
  presetVersion: z.literal("platform-mcp-v1"), policySha256: sha256, qualifiedAt: z.string().datetime(),
  replicas: z.array(z.object({ name: z.enum(["partner-api-a", "partner-api-b"]), apiImage: image,
    readEvidenceSha256: sha256, commerceEvidenceSha256: sha256.nullable() }).strict()).length(2),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.replicas.map(replica => replica.name)).size !== 2
    || value.replicas.some(replica => replica.apiImage !== value.candidate.apiImage)) {
    ctx.addIssue({ code: "custom", message: "Both qualified replica identities must match the exact candidate image" });
  }
});
export type PlatformMcpDeploymentArtifactV1 = z.infer<typeof PlatformMcpDeploymentArtifactV1Schema>;
export const PlatformMcpReplicaReadinessV1Schema = z.object({
  schemaVersion: z.literal(1), ready: z.literal(true), instanceId: z.uuid(), environment: z.enum(["sandbox", "production"]),
  candidate, mcpUrl, schemaFingerprintSha256: sha256, apiConfigurationSha256: sha256,
  presetVersion: z.literal("platform-mcp-v1"), policySha256: sha256,
  mcp: z.object({ enabled: z.boolean(), quotesEnabled: z.boolean(), bookingEnabled: z.boolean(), deliveryEnabled: z.boolean() }).strict(),
  commercial: z.object({ currency: z.literal("VND"), taxMode: z.enum(["inclusive", "exclusive"]),
    vatRatePpm: z.number().int().min(0).max(1_000_000) }).strict(),
}).strict();
export type PlatformMcpReplicaReadinessV1 = z.infer<typeof PlatformMcpReplicaReadinessV1Schema>;
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const unavailable = () => new PlatformError("mcp_readiness_unavailable", "MCP server conformance is unavailable", 503);

/** Caller completes dependency/role checks first; raw private inputs are hashed, never returned. */
export function buildPlatformMcpReplicaReadinessV1(input: { environment: NodeJS.ProcessEnv; instanceId: string;
  schemaFingerprintSha256: string; configRaw: string; fingerprintsRaw: string }): PlatformMcpReplicaReadinessV1 {
  try {
    const env = input.environment, build = getBuildInfo("medusa-partner-api", env), commercial = commercialAdjustmentContext(env);
    return PlatformMcpReplicaReadinessV1Schema.parse({ schemaVersion: 1, ready: true, instanceId: input.instanceId,
      environment: env.PARTNER_ENVIRONMENT, candidate: { sourceCommit: build.sourceCommit, releaseId: build.releaseId, apiImage: env.PLATFORM_MCP_API_IMAGE },
      mcpUrl: trustedPlatformMcpUrlForHost(env.PARTNER_PUBLIC_HOST), schemaFingerprintSha256: input.schemaFingerprintSha256,
      apiConfigurationSha256: hashPlatformMcpApiConfigurationV1(input.configRaw, input.fingerprintsRaw),
      presetVersion: platformMcpIssuancePresetV1.version, policySha256: hashPlatformMcpPolicyV1(platformMcpIssuancePresetV1.policy),
      mcp: { enabled: env.PARTNER_MCP_ENABLED === "true", quotesEnabled: env.PARTNER_MUTATIONS_ENABLED === "true",
        bookingEnabled: env.PARTNER_BOOKING_ENABLED === "true", deliveryEnabled: env.PARTNER_DELIVERY_ENABLED === "true" },
      commercial: { currency: "VND", taxMode: commercial.taxMode, vatRatePpm: vatRatePpmFromRate(commercial.vatRate) } });
  } catch { throw unavailable(); }
}

/** File ownership/mount checks belong to the loader; evidence truth belongs to the release qualifier. */
export function parsePlatformMcpDeploymentArtifactV1(raw: string, expected: { expectedSha256: string; environment: PartnerEnvironment;
  sourceCommit: string; releaseId: string; mcpUrl: string }) {
  try {
    const digest = hash(raw);
    if (!sha256.safeParse(expected.expectedSha256).success || digest !== expected.expectedSha256) throw unavailable();
    const artifact = PlatformMcpDeploymentArtifactV1Schema.parse(JSON.parse(raw));
    if (artifact.environment !== expected.environment || artifact.candidate.sourceCommit !== expected.sourceCommit
      || artifact.candidate.releaseId !== expected.releaseId || artifact.mcpUrl !== expected.mcpUrl
      || artifact.policySha256 !== hashPlatformMcpPolicyV1(platformMcpIssuancePresetV1.policy)) throw unavailable();
    return { artifact, sha256: digest };
  } catch { throw unavailable(); }
}

/** A bounded live check of both replicas; it does not mint or validate merchant authority. */
export function validatePlatformMcpReplicaReadinessV1(artifact: PlatformMcpDeploymentArtifactV1, rawReplicas: unknown,
  profile: "read" | "commerce") {
  const parsed = z.array(PlatformMcpReplicaReadinessV1Schema).length(2).safeParse(rawReplicas);
  if (!parsed.success || !["read", "commerce"].includes(profile)) throw unavailable();
  const replicas = parsed.data;
  if (replicas[0].instanceId === replicas[1].instanceId
    || canonicalPartnerJson(replicas[0].mcp) !== canonicalPartnerJson(replicas[1].mcp)
    || canonicalPartnerJson(replicas[0].commercial) !== canonicalPartnerJson(replicas[1].commercial)
    || replicas.some(replica => replica.environment !== artifact.environment
      || canonicalPartnerJson(replica.candidate) !== canonicalPartnerJson(artifact.candidate)
      || replica.mcpUrl !== artifact.mcpUrl || replica.schemaFingerprintSha256 !== artifact.schemaFingerprintSha256
      || replica.apiConfigurationSha256 !== artifact.apiConfigurationSha256 || replica.presetVersion !== artifact.presetVersion
      || replica.policySha256 !== artifact.policySha256 || !replica.mcp.enabled)) throw unavailable();
  if (profile === "commerce" && (artifact.replicas.some(replica => !replica.commerceEvidenceSha256)
    || replicas.some(replica => !replica.mcp.quotesEnabled || !replica.mcp.bookingEnabled || replica.commercial.taxMode !== "inclusive"))) {
    throw unavailable();
  }
  return replicas;
}

export function hashPlatformMcpApiConfigurationV1(configRaw: string, fingerprintsRaw: string) {
  return hash(canonicalPartnerJson({ configSha256: hash(configRaw), fingerprintsSha256: hash(fingerprintsRaw) }));
}

export type PlatformMcpDeploymentReadinessSettingsV1 = Parameters<typeof parsePlatformMcpDeploymentArtifactV1>[1] & {
  artifactPath: string; replicaUrls: readonly [string, string];
};
const liveProof = Symbol("platform-mcp-readiness");
export type PlatformMcpReadinessProofV1 = Readonly<{ [liveProof]: true; artifact: PlatformMcpDeploymentArtifactV1;
  artifactSha256: string; replicas: readonly PlatformMcpReplicaReadinessV1[]; checkedAtMonotonic: number; profile: "read" | "commerce" }>;

/** Trusted deployment input only; production file/probe locations cannot be overridden. */
export async function loadPlatformMcpReadinessForDeploymentV1(settings: PlatformMcpDeploymentReadinessSettingsV1,
  profile: "read" | "commerce"): Promise<PlatformMcpReadinessProofV1> {
  try {
    if (!["read", "commerce"].includes(profile)) throw unavailable();
    if (settings.environment === "production") {
      if (settings.artifactPath !== PLATFORM_MCP_CONFORMANCE_FILE
        || settings.replicaUrls.length !== 2 || settings.replicaUrls.some((url, index) => url !== productionReplicaUrls[index])) throw unavailable();
    } else if (settings.environment === "sandbox") {
      if (settings.replicaUrls.length !== 2 || new Set(settings.replicaUrls).size !== 2 || settings.replicaUrls.some(value => {
        const url = new URL(value), port = Number(url.port);
        return url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1024 || port > 65535
          || url.username || url.password || url.search || url.hash || url.pathname !== PLATFORM_MCP_READINESS_PATH || url.toString() !== value;
      })) throw unavailable();
    } else throw unavailable();
    const loaded = parsePlatformMcpDeploymentArtifactV1(readPrivateFile(settings.artifactPath), settings);
    const responses = await Promise.allSettled(settings.replicaUrls.map(async url => {
      const response = await fetch(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(3000) });
      if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel(); throw unavailable();
      }
      return JSON.parse(await readBoundedResponse(response, 16_384));
    }));
    if (responses.some(response => response.status === "rejected")) throw unavailable();
    const replicas = validatePlatformMcpReplicaReadinessV1(loaded.artifact,
      responses.map(response => (response as PromiseFulfilledResult<unknown>).value), profile);
    Object.freeze(loaded.artifact.candidate); loaded.artifact.replicas.forEach(Object.freeze);
    Object.freeze(loaded.artifact.replicas); Object.freeze(loaded.artifact);
    for (const replica of replicas) {
      Object.freeze(replica.candidate); Object.freeze(replica.mcp); Object.freeze(replica.commercial); Object.freeze(replica);
    }
    return Object.freeze({ [liveProof]: true as const, artifact: loaded.artifact, artifactSha256: loaded.sha256,
      replicas: Object.freeze(replicas), checkedAtMonotonic: performance.now(), profile });
  } catch { throw unavailable(); }
}

export function assertPlatformMcpReadinessFreshV1(proof: PlatformMcpReadinessProofV1, profile: "read" | "commerce") {
  if (!proof || proof[liveProof] !== true || proof.profile !== profile) throw unavailable();
  const age = performance.now() - proof.checkedAtMonotonic;
  if (!Number.isFinite(age) || age < 0 || age > 10_000) throw unavailable();
}

/** Production control configuration is server-owned; request data supplies none of these settings. */
export async function loadPlatformMcpProductionReadinessV1(profile: "read" | "commerce") {
  try {
    if (process.env.PARTNER_ENVIRONMENT !== "production") throw unavailable();
    const build = getBuildInfo("medusa-staff"), url = trustedPlatformMcpUrlForHost(process.env.PARTNER_PUBLIC_HOST);
    if (!url) throw unavailable();
    return await loadPlatformMcpReadinessForDeploymentV1({ environment: "production", artifactPath: PLATFORM_MCP_CONFORMANCE_FILE,
      replicaUrls: productionReplicaUrls as [string, string], expectedSha256: process.env.PLATFORM_MCP_CONFORMANCE_SHA256 ?? "",
      sourceCommit: build.sourceCommit, releaseId: build.releaseId, mcpUrl: url }, profile);
  } catch { throw unavailable(); }
}
