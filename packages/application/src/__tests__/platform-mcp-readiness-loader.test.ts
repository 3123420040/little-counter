import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPlatformMcpReadinessFreshV1, buildPlatformMcpReplicaReadinessV1, hashPlatformMcpApiConfigurationV1,
  loadPlatformMcpReadinessForDeploymentV1, type PlatformMcpDeploymentReadinessSettingsV1 } from "../partner/platform-mcp-readiness";
import { hashPlatformMcpPolicyV1 } from "../services/platform-mcp-authorization-snapshot";
import { platformMcpIssuancePresetV1 } from "../services/platform-mcp-policy";

let directory: string, settings: PlatformMcpDeploymentReadinessSettingsV1, bodies: unknown[], servers: Server[];
let hits: string[], responses: Array<{ status?: number; location?: string; contentType?: string; raw?: string }>;
const candidate = { sourceCommit: "a".repeat(40), releaseId: "snus-native-protocol-fixture", apiImage: `ghcr.io/synthetic/snus@sha256:${"b".repeat(64)}` };
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "snus-mcp-readiness-")); chmodSync(directory, 0o700); hits = []; responses = [{}, {}]; servers = [];
  const artifact = { schemaVersion: 1, workflowVersion: "platform-mcp-v1", environment: "sandbox", candidate,
    mcpUrl: "https://partner.example/mcp", schemaFingerprintSha256: "c".repeat(64), apiConfigurationSha256: hashPlatformMcpApiConfigurationV1("{}", "{}"),
    presetVersion: "platform-mcp-v1", policySha256: hashPlatformMcpPolicyV1(platformMcpIssuancePresetV1.policy), qualifiedAt: "2026-10-27T00:00:00.000Z",
    replicas: ["partner-api-a", "partner-api-b"].map(name => ({ name, apiImage: candidate.apiImage, readEvidenceSha256: "e".repeat(64), commerceEvidenceSha256: "f".repeat(64) })) };
  // These loopback fixtures test the protocol/transport, not actual deployment conformance.
  bodies = [0, 1].map(() => buildPlatformMcpReplicaReadinessV1({ environment: { BUILD_SOURCE_COMMIT: candidate.sourceCommit,
    BUILD_RELEASE_ID: candidate.releaseId, BUILD_COMPATIBILITY_FAMILY: "snus-runtime-v1", PLATFORM_MCP_API_IMAGE: candidate.apiImage,
    PARTNER_ENVIRONMENT: "sandbox", PARTNER_PUBLIC_HOST: "partner.example", PARTNER_MCP_ENABLED: "true",
    PARTNER_MUTATIONS_ENABLED: "true", PARTNER_BOOKING_ENABLED: "true" }, instanceId: randomUUID(),
    schemaFingerprintSha256: artifact.schemaFingerprintSha256, configRaw: "{}", fingerprintsRaw: "{}" }));
  const urls: string[] = [];
  for (let index = 0; index < 2; index++) {
    const server = createServer((req, res) => {
      hits.push(`${index}:${req.url}`); const response = responses[index];
      res.writeHead(response.status ?? 200, { "content-type": response.contentType ?? "application/json",
        ...(response.location ? { location: response.location } : {}) });
      res.end(response.raw ?? JSON.stringify(bodies[index]));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing loopback test port");
    urls.push(`http://127.0.0.1:${address.port}/mcp-control-readiness`);
  }
  const raw = JSON.stringify(artifact), artifactPath = join(directory, "mcp-conformance.json");
  writeFileSync(artifactPath, raw, { mode: 0o600 });
  settings = { artifactPath, replicaUrls: urls as [string, string], environment: "sandbox", sourceCommit: candidate.sourceCommit,
    releaseId: candidate.releaseId, mcpUrl: artifact.mcpUrl, expectedSha256: createHash("sha256").update(raw).digest("hex") };
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  rmSync(directory, { recursive: true, force: true });
});
describe("owned-file and bounded live MCP readiness loader", () => {
  it("loads a pinned private artifact and two live responses into a fresh server-only proof", async () => {
    const proof = await loadPlatformMcpReadinessForDeploymentV1(settings, "commerce");
    expect(proof.artifactSha256).toBe(settings.expectedSha256); expect(hits).toHaveLength(2);
    expect(() => assertPlatformMcpReadinessFreshV1(proof, "commerce")).not.toThrow();
    expect(() => assertPlatformMcpReadinessFreshV1(proof, "read")).toThrow();
    expect(() => assertPlatformMcpReadinessFreshV1(JSON.parse(JSON.stringify(proof)), "commerce")).toThrow();
    expect(() => { (proof.artifact.candidate as { sourceCommit: string }).sourceCommit = "0".repeat(40); }).toThrow();
    expect(() => { (proof.replicas[0].mcp as { enabled: boolean }).enabled = false; }).toThrow();
  });
  it("rejects an invalid profile before any file/network work", async () => {
    await expect(loadPlatformMcpReadinessForDeploymentV1(settings, "invalid" as never)).rejects.toMatchObject({ code: "mcp_readiness_unavailable" });
    expect(hits).toHaveLength(0);
  });
  it.each(["changed-pin", "public-file", "public-directory", "symlink"])("does not probe after an unsafe artifact %s", async bad => {
    if (bad === "changed-pin") settings.expectedSha256 = "0".repeat(64);
    if (bad === "public-file") chmodSync(settings.artifactPath, 0o644);
    if (bad === "public-directory") chmodSync(directory, 0o755);
    if (bad === "symlink") {
      const target = join(directory, "do-not-follow.json"); writeFileSync(target, "private-sentinel", { mode: 0o600 });
      unlinkSync(settings.artifactPath); symlinkSync(target, settings.artifactPath);
    }
    await expect(loadPlatformMcpReadinessForDeploymentV1(settings, "read")).rejects.toMatchObject({ code: "mcp_readiness_unavailable" });
    expect(hits).toHaveLength(0);
  });
  it.each(["remote", "credentials", "query", "wrong-path", "duplicate", "production-override"])("refuses untrusted probe configuration %s", async bad => {
    const url = new URL(settings.replicaUrls[0]);
    if (bad === "remote") url.hostname = "other.invalid";
    if (bad === "credentials") url.username = "private-user";
    if (bad === "query") url.search = "?redirect=other";
    if (bad === "wrong-path") url.pathname = "/private";
    if (bad === "duplicate") settings.replicaUrls = [settings.replicaUrls[0], settings.replicaUrls[0]];
    else settings.replicaUrls = [url.toString(), settings.replicaUrls[1]];
    if (bad === "production-override") settings.environment = "production";
    await expect(loadPlatformMcpReadinessForDeploymentV1(settings, "read")).rejects.toMatchObject({ code: "mcp_readiness_unavailable" });
    expect(hits).toHaveLength(0);
  });
  it.each(["status", "content-type", "redirect", "oversize", "replica-drift"])("fails closed on a bad bounded live response %s", async bad => {
    if (bad === "status") responses[0].status = 503;
    if (bad === "content-type") responses[0].contentType = "text/html";
    if (bad === "redirect") responses[0] = { status: 302, location: new URL("/must-not-follow", settings.replicaUrls[1]).toString() };
    if (bad === "oversize") responses[0].raw = JSON.stringify({ oversized: "x".repeat(17_000) });
    if (bad === "replica-drift") bodies[1] = { ...(bodies[1] as object), schemaFingerprintSha256: "0".repeat(64) };
    await expect(loadPlatformMcpReadinessForDeploymentV1(settings, "commerce")).rejects.toMatchObject({ code: "mcp_readiness_unavailable" });
    expect(hits).not.toContain("1:/must-not-follow");
  });
  it("expires a live proof after ten seconds without treating the pinned artifact as a permanent live check", async () => {
    const proof = await loadPlatformMcpReadinessForDeploymentV1(settings, "read"), now = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(now + 10_001);
    expect(() => assertPlatformMcpReadinessFreshV1(proof, "read")).toThrowError(expect.objectContaining({ code: "mcp_readiness_unavailable" }));
  });
});
