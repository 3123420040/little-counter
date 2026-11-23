import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPartnerProductionReadinessHandler, PLATFORM_MCP_READINESS_PATH } from "../partner/production-readiness";
import { buildPlatformMcpReplicaReadinessV1 } from "../partner/platform-mcp-readiness";
const realFetch = globalThis.fetch;
let server: Server | undefined, origin: string;
const api = { query: vi.fn() }, core = { query: vi.fn() }, redis = { ping: vi.fn() }, buildMcpReadiness = vi.fn();
const dependencyFetch = vi.fn();
const payload = () => buildPlatformMcpReplicaReadinessV1({ environment: { BUILD_SOURCE_COMMIT: "a".repeat(40),
  BUILD_RELEASE_ID: "snus-native-protocol-fixture", BUILD_COMPATIBILITY_FAMILY: "snus-runtime-v1",
  PLATFORM_MCP_API_IMAGE: `ghcr.io/synthetic/snus@sha256:${"b".repeat(64)}`, PARTNER_ENVIRONMENT: "sandbox",
  PARTNER_PUBLIC_HOST: "partner.example", PARTNER_MCP_ENABLED: "true", PARTNER_MUTATIONS_ENABLED: "true", PARTNER_BOOKING_ENABLED: "true" },
  instanceId: randomUUID(), schemaFingerprintSha256: "c".repeat(64), configRaw: "{}", fingerprintsRaw: "{}" });
beforeEach(async () => {
  vi.clearAllMocks(); api.query.mockResolvedValue({ rows: [{ allowed: true }] }); core.query.mockResolvedValue({ rows: [{ allowed: true }] });
  redis.ping.mockResolvedValue("PONG"); const body = payload(); buildMcpReadiness.mockResolvedValue(body);
  dependencyFetch.mockImplementation(async (url: string) => url === "http://127.0.0.1:9000/health" ? new Response("OK")
    : new Response(JSON.stringify({ keys: [{ kty: "RSA", use: "sig", kid: "synthetic", n: "synthetic", e: "AQAB" }] }),
      { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", dependencyFetch);
  server = createServer(createPartnerProductionReadinessHandler({ apiPool: api as never, corePools: [core as never], redis,
    jwksUrl: "https://as.example/certs", buildMcpReadiness }));
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing loopback test port");
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve())); server = undefined;
  vi.unstubAllGlobals();
});
describe("private production readiness HTTP boundary", () => {
  it("preserves legacy ready JSON and its AS check", async () => {
    const response = await realFetch(`${origin}/ready`);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ready: true });
    expect(dependencyFetch).toHaveBeenCalledWith("https://as.example/certs", expect.anything());
    expect(buildMcpReadiness).not.toHaveBeenCalled();
  });
  it("serves a stable safe MCP replica identity while AS is unavailable, without probing AS", async () => {
    dependencyFetch.mockImplementation(async (url: string) => {
      if (url !== "http://127.0.0.1:9000/health") throw new Error("synthetic-private-AS-failure");
      return new Response("OK");
    });
    const first = await realFetch(`${origin}${PLATFORM_MCP_READINESS_PATH}`), second = await realFetch(`${origin}${PLATFORM_MCP_READINESS_PATH}`);
    expect(first.status).toBe(200); expect(first.headers.get("cache-control")).toBe("no-store");
    expect((await first.json()).instanceId).toBe((await second.json()).instanceId);
    expect(dependencyFetch.mock.calls.every(([url]) => url === "http://127.0.0.1:9000/health")).toBe(true);
    const legacy = await realFetch(`${origin}/ready`); expect(legacy.status).toBe(503);
    expect(await legacy.text()).not.toContain("synthetic-private-AS-failure");
  });
  it("refuses unsafe MCP output while leaving the legacy health response available", async () => {
    buildMcpReadiness.mockResolvedValue({ ...payload(), secret: "synthetic-private-output" });
    const response = await realFetch(`${origin}${PLATFORM_MCP_READINESS_PATH}`);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("synthetic-private-output");
    expect((await realFetch(`${origin}/ready`)).status).toBe(200);
  });
  it.each(["api", "core", "redis"])("fails closed before returning a replica proof when %s is unsafe/unavailable", async failed => {
    if (failed === "api") api.query.mockResolvedValue({ rows: [{ allowed: false }] });
    if (failed === "core") core.query.mockResolvedValue({ rows: [{ allowed: false }] });
    if (failed === "redis") redis.ping.mockRejectedValue(new Error("synthetic-private-redis-failure"));
    const response = await realFetch(`${origin}${PLATFORM_MCP_READINESS_PATH}`);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private");
    expect(buildMcpReadiness).not.toHaveBeenCalled();
  });
  it("bounds concurrent health probes and recovers after the running check completes", async () => {
    let enter!: () => void, release!: (value: unknown) => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
    api.query.mockImplementationOnce(() => { enter(); return gate; });
    const first = realFetch(`${origin}${PLATFORM_MCP_READINESS_PATH}`);
    try {
      await entered;
      expect((await realFetch(`${origin}/ready`)).status).toBe(503);
    } finally { release({ rows: [{ allowed: true }] }); }
    expect((await first).status).toBe(200);
    expect((await realFetch(`${origin}/ready`)).status).toBe(200);
  });
  it.each([["POST", "/ready"], ["GET", "/unknown"], ["GET", "/ready?redirect=http://other.invalid"]])("does not probe dependencies for %s %s", async (method, path) => {
    expect((await realFetch(`${origin}${path}`, { method })).status).toBe(404);
    expect(api.query).not.toHaveBeenCalled(); expect(dependencyFetch).not.toHaveBeenCalled(); expect(buildMcpReadiness).not.toHaveBeenCalled();
  });
});
