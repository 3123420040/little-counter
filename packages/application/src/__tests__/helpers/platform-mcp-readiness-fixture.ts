import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlatformMcpReplicaReadinessV1, hashPlatformMcpApiConfigurationV1, loadPlatformMcpReadinessForDeploymentV1 } from "../../partner/platform-mcp-readiness";
import { hashPlatformMcpPolicyV1 } from "../../services/platform-mcp-authorization-snapshot";
import { platformMcpIssuancePresetV1 } from "../../services/platform-mcp-policy";

/** Synthetic private transport fixture, never a native deployment conformance certificate. */
export async function platformMcpReadinessFixture(schemaFingerprintSha256: string, profile: "read" | "commerce" = "read") {
  const directory = mkdtempSync(join(tmpdir(), "snus-mcp-command-")), servers: Server[] = [];
  chmodSync(directory, 0o700);
  const cleanup = async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const candidate = { sourceCommit: "a".repeat(40), releaseId: "synthetic-command-fixture", apiImage: `ghcr.io/synthetic/snus@sha256:${"b".repeat(64)}` };
    const artifact = { schemaVersion: 1, workflowVersion: "platform-mcp-v1", environment: "sandbox", candidate,
      mcpUrl: "https://partner.example/mcp", schemaFingerprintSha256, apiConfigurationSha256: hashPlatformMcpApiConfigurationV1("{}", "{}"),
      presetVersion: "platform-mcp-v1", policySha256: hashPlatformMcpPolicyV1(platformMcpIssuancePresetV1.policy), qualifiedAt: "2026-10-27T00:00:00.000Z",
      replicas: ["partner-api-a", "partner-api-b"].map(name => ({ name, apiImage: candidate.apiImage, readEvidenceSha256: "e".repeat(64), commerceEvidenceSha256: "f".repeat(64) })) };
    const urls: string[] = [];
    for (let index = 0; index < 2; index++) {
      const body = buildPlatformMcpReplicaReadinessV1({ environment: { BUILD_SOURCE_COMMIT: candidate.sourceCommit,
        BUILD_RELEASE_ID: candidate.releaseId, BUILD_COMPATIBILITY_FAMILY: "snus-runtime-v1", PLATFORM_MCP_API_IMAGE: candidate.apiImage,
        PARTNER_ENVIRONMENT: "sandbox", PARTNER_PUBLIC_HOST: "partner.example", PARTNER_MCP_ENABLED: "true",
        PARTNER_MUTATIONS_ENABLED: "true", PARTNER_BOOKING_ENABLED: "true" }, instanceId: randomUUID(), schemaFingerprintSha256, configRaw: "{}", fingerprintsRaw: "{}" });
      const server = createServer((_, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing owned loopback port");
      urls.push(`http://127.0.0.1:${address.port}/mcp-control-readiness`);
    }
    const raw = JSON.stringify(artifact), artifactPath = join(directory, "mcp-conformance.json");
    writeFileSync(artifactPath, raw, { mode: 0o600 });
    const proof = await loadPlatformMcpReadinessForDeploymentV1({ artifactPath, replicaUrls: urls as [string, string], environment: "sandbox",
      sourceCommit: candidate.sourceCommit, releaseId: candidate.releaseId, mcpUrl: artifact.mcpUrl, expectedSha256: createHash("sha256").update(raw).digest("hex") }, profile);
    return { proof, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
