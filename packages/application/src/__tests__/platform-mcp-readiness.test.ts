import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildPlatformMcpReplicaReadinessV1, hashPlatformMcpApiConfigurationV1, parsePlatformMcpDeploymentArtifactV1, validatePlatformMcpReplicaReadinessV1 } from "../partner/platform-mcp-readiness";
import { hashPlatformMcpPolicyV1 } from "../services/platform-mcp-authorization-snapshot";
import { platformMcpIssuancePresetV1 } from "../services/platform-mcp-policy";
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const candidate = { sourceCommit: "a".repeat(40), releaseId: "snus-v230-synthetic", apiImage: `ghcr.io/synthetic/snus@sha256:${"b".repeat(64)}` };
// Synthetic protocol fixtures only; their hashes do not certify a live server or release.
const artifact = () => ({ schemaVersion: 1, workflowVersion: "platform-mcp-v1", environment: "sandbox", candidate,
  mcpUrl: "https://partner.example/mcp", schemaFingerprintSha256: "c".repeat(64), apiConfigurationSha256: "d".repeat(64),
  presetVersion: "platform-mcp-v1", policySha256: hashPlatformMcpPolicyV1(platformMcpIssuancePresetV1.policy), qualifiedAt: "2026-10-27T00:00:00.000Z",
  replicas: ["partner-api-a", "partner-api-b"].map(name => ({ name, apiImage: candidate.apiImage,
    readEvidenceSha256: "e".repeat(64), commerceEvidenceSha256: "f".repeat(64) as string | null })) });
function parse(value = artifact(), expected = {}) {
  const raw = JSON.stringify(value);
  return parsePlatformMcpDeploymentArtifactV1(raw, { environment: "sandbox", sourceCommit: candidate.sourceCommit,
    releaseId: candidate.releaseId, mcpUrl: value.mcpUrl, expectedSha256: sha(raw), ...expected });
}
function replica() {
  const a = artifact();
  return { schemaVersion: 1, ready: true, instanceId: randomUUID(), environment: a.environment, candidate,
    mcpUrl: a.mcpUrl, schemaFingerprintSha256: a.schemaFingerprintSha256, apiConfigurationSha256: a.apiConfigurationSha256,
    presetVersion: a.presetVersion, policySha256: a.policySha256,
    mcp: { enabled: true, quotesEnabled: true, bookingEnabled: true, deliveryEnabled: false },
    commercial: { currency: "VND", taxMode: "inclusive", vatRatePpm: 100_000 } };
}
describe("server-owned MCP deployment conformance protocol", () => {
  it("builds safe replica identity from its assigned child environment without serializing config secrets", () => {
    const body = buildPlatformMcpReplicaReadinessV1({ environment: { BUILD_SOURCE_COMMIT: candidate.sourceCommit,
      BUILD_RELEASE_ID: candidate.releaseId, BUILD_COMPATIBILITY_FAMILY: "snus-runtime-v1", PLATFORM_MCP_API_IMAGE: candidate.apiImage,
      PARTNER_ENVIRONMENT: "sandbox", PARTNER_PUBLIC_HOST: "partner.example", PARTNER_MCP_ENABLED: "true",
      PARTNER_MUTATIONS_ENABLED: "true", PARTNER_BOOKING_ENABLED: "true", PARTNER_DELIVERY_ENABLED: "false" },
      instanceId: "71828989-25b1-40c5-8b28-f3caaee86d9b", schemaFingerprintSha256: "c".repeat(64),
      configRaw: '{"password":"synthetic-config-secret"}', fingerprintsRaw: '{"key":"synthetic-fingerprint-secret"}' });
    expect(body).toMatchObject({ ready: true, candidate, mcpUrl: "https://partner.example/mcp",
      mcp: { enabled: true, quotesEnabled: true, bookingEnabled: true, deliveryEnabled: false },
      commercial: { currency: "VND", taxMode: "inclusive", vatRatePpm: 100_000 } });
    expect(JSON.stringify(body)).not.toContain("synthetic-config-secret"); expect(JSON.stringify(body)).not.toContain("synthetic-fingerprint-secret");
  });
  it("uses the child VAT context rather than unforwarded parent environment values", () => {
    vi.stubEnv("VAT_RATE", "0.5"); vi.stubEnv("TAX_MODE", "exclusive");
    const environment = { BUILD_SOURCE_COMMIT: candidate.sourceCommit, BUILD_RELEASE_ID: candidate.releaseId,
      BUILD_COMPATIBILITY_FAMILY: "snus-runtime-v1", PLATFORM_MCP_API_IMAGE: candidate.apiImage,
      PARTNER_ENVIRONMENT: "sandbox", PARTNER_PUBLIC_HOST: "partner.example", PARTNER_MCP_ENABLED: "true" };
    const input = { environment, instanceId: randomUUID(), schemaFingerprintSha256: "c".repeat(64), configRaw: "{}", fingerprintsRaw: "{}" };
    try {
      expect(buildPlatformMcpReplicaReadinessV1(input).commercial).toEqual({ currency: "VND", taxMode: "inclusive", vatRatePpm: 100_000 });
      expect(buildPlatformMcpReplicaReadinessV1({ ...input, environment: { ...environment, VAT_RATE: "0.08", TAX_MODE: "exclusive" } }).commercial)
        .toEqual({ currency: "VND", taxMode: "exclusive", vatRatePpm: 80_000 });
    } finally { vi.unstubAllEnvs(); }
  });
  it("does not invent missing image identity or accept an unsafe configured host", () => {
    const input = { environment: { BUILD_SOURCE_COMMIT: candidate.sourceCommit, BUILD_RELEASE_ID: candidate.releaseId,
      BUILD_COMPATIBILITY_FAMILY: "snus-runtime-v1", PARTNER_ENVIRONMENT: "sandbox", PARTNER_PUBLIC_HOST: "partner.example" },
      instanceId: randomUUID(), schemaFingerprintSha256: "c".repeat(64), configRaw: "{}", fingerprintsRaw: "{}" };
    expect(() => buildPlatformMcpReplicaReadinessV1(input)).toThrowError(expect.objectContaining({ code: "mcp_readiness_unavailable" }));
    expect(() => buildPlatformMcpReplicaReadinessV1({ ...input, environment: { ...input.environment,
      PLATFORM_MCP_API_IMAGE: candidate.apiImage, PARTNER_PUBLIC_HOST: "user@other.invalid/path" } })).toThrow();
  });
  it("requires a pinned artifact matching the current source/release/environment/URL and finite preset", () => {
    const result = parse(); expect(result.sha256).toBe(sha(JSON.stringify(artifact())));
    expect(result.artifact.candidate).toEqual(candidate);
    for (const expected of [{ expectedSha256: "0".repeat(64) }, { sourceCommit: "b".repeat(40) },
      { releaseId: "other-release" }, { environment: "production" }, { mcpUrl: "https://other.example/mcp" }]) {
      expect(() => parse(artifact(), expected)).toThrowError(expect.objectContaining({ code: "mcp_readiness_unavailable", statusCode: 503 }));
    }
  });
  it.each(["schema", "unknown-secret", "policy", "mutable-image", "foreign-replica-image", "duplicate-replica", "missing-read-proof", "unsafe-url"])("rejects invalid artifact %s even with a matching file hash", bad => {
    const a = artifact();
    if (bad === "schema") a.schemaVersion = 2;
    if (bad === "unknown-secret") Object.assign(a, { revealedKey: "must-not-be-persisted" });
    if (bad === "policy") a.policySha256 = "0".repeat(64);
    if (bad === "mutable-image") a.candidate = { ...candidate, apiImage: "ghcr.io/synthetic/snus:latest" };
    if (bad === "foreign-replica-image") a.replicas[1].apiImage = `ghcr.io/other/snus@sha256:${"0".repeat(64)}`;
    if (bad === "duplicate-replica") a.replicas[1].name = a.replicas[0].name;
    if (bad === "missing-read-proof") a.replicas[0].readEvidenceSha256 = "";
    if (bad === "unsafe-url") a.mcpUrl = "https://partner.example/mcp?redirect=https://other.invalid";
    expect(() => parse(a)).toThrowError(expect.objectContaining({ code: "mcp_readiness_unavailable" }));
  });
  it("maps malformed/private artifact input to a safe error without reflecting its content", () => {
    const raw = "private-value-that-must-not-appear";
    let message = "";
    try { parsePlatformMcpDeploymentArtifactV1(raw, { environment: "sandbox", sourceCommit: candidate.sourceCommit,
      releaseId: candidate.releaseId, mcpUrl: "https://partner.example/mcp", expectedSha256: sha(raw) }); }
    catch (error) { message = String(error); }
    expect(message).not.toContain(raw); expect(message).toContain("MCP server conformance is unavailable");
  });
  it("checks two distinct current replicas and accepts read without commerce gates", () => {
    const a = artifact(); a.replicas.forEach(replica => { replica.commerceEvidenceSha256 = null; });
    const live = [replica(), replica()];
    live.forEach(r => { r.mcp.quotesEnabled = false; r.mcp.bookingEnabled = false; r.commercial.taxMode = "exclusive"; });
    expect(() => validatePlatformMcpReplicaReadinessV1(parse(a).artifact, live, "read")).not.toThrow();
    expect(() => validatePlatformMcpReplicaReadinessV1(parse(a).artifact, live, "commerce"))
      .toThrowError(expect.objectContaining({ code: "mcp_readiness_unavailable" }));
    expect(() => validatePlatformMcpReplicaReadinessV1(parse().artifact, [replica(), replica()], "commerce")).not.toThrow();
    const asymmetric = [replica(), replica()]; asymmetric[1].mcp.bookingEnabled = false;
    expect(() => validatePlatformMcpReplicaReadinessV1(parse().artifact, asymmetric, "read")).toThrow();
    expect(() => validatePlatformMcpReplicaReadinessV1(parse().artifact, [replica(), replica()], "invalid" as never)).toThrow();
  });
  it.each(["one", "same-instance", "source", "release", "image", "schema", "config", "url", "policy", "disabled", "quotes-off", "booking-off", "exclusive", "different-vat", "unsafe-field"])("fails closed on live replica drift %s", bad => {
    const live = [replica(), replica()];
    if (bad === "one") live.pop();
    if (bad === "same-instance") live[1].instanceId = live[0].instanceId;
    if (bad === "source") live[1].candidate = { ...candidate, sourceCommit: "b".repeat(40) };
    if (bad === "release") live[1].candidate = { ...candidate, releaseId: "wrong-release" };
    if (bad === "image") live[1].candidate = { ...candidate, apiImage: `ghcr.io/other/snus@sha256:${"0".repeat(64)}` };
    if (bad === "schema") live[1].schemaFingerprintSha256 = "0".repeat(64);
    if (bad === "config") live[1].apiConfigurationSha256 = "0".repeat(64);
    if (bad === "url") live[1].mcpUrl = "https://other.example/mcp";
    if (bad === "policy") live[1].policySha256 = "0".repeat(64);
    if (bad === "disabled") live[1].mcp.enabled = false;
    if (bad === "quotes-off") live[1].mcp.quotesEnabled = false;
    if (bad === "booking-off") live[1].mcp.bookingEnabled = false;
    if (bad === "exclusive") live.forEach(r => { r.commercial.taxMode = "exclusive"; });
    if (bad === "different-vat") live[1].commercial.vatRatePpm = 80_000;
    if (bad === "unsafe-field") Object.assign(live[1], { secret_hash: "must-not-return" });
    expect(() => validatePlatformMcpReplicaReadinessV1(parse().artifact, live, "commerce"))
      .toThrowError(expect.objectContaining({ code: "mcp_readiness_unavailable" }));
  });
  it("hashes the exact assigned API config/fingerprint bytes without exposing private content", () => {
    const config = '{"password":"synthetic-private"}', fingerprints = '{"current":"v1","keys":{"v1":"synthetic-key"}}';
    const digest = hashPlatformMcpApiConfigurationV1(config, fingerprints);
    expect(digest).toMatch(/^[a-f0-9]{64}$/); expect(digest).not.toContain("synthetic");
    expect(hashPlatformMcpApiConfigurationV1(config + "\n", fingerprints)).not.toBe(digest);
    expect(hashPlatformMcpApiConfigurationV1(config, fingerprints + "\n")).not.toBe(digest);
  });
});
