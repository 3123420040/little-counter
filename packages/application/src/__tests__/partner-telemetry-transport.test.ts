import { Resolver } from "node:dns";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postPartnerTelemetry } from "../partner/telemetry-transport";

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
async function endpoint(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/logs`);
}
describe("collector transport resource isolation", () => {
  it("cancels unresolved DNS on every deadline instead of accumulating shared-pool lookups", async () => {
    vi.useFakeTimers();
    const ipv4 = vi.spyOn(Resolver.prototype, "resolve4").mockImplementation(() => undefined);
    const ipv6 = vi.spyOn(Resolver.prototype, "resolve6").mockImplementation(() => undefined);
    const cancel = vi.spyOn(Resolver.prototype, "cancel");
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = postPartnerTelemetry(new URL("http://missing-collector.invalid/v1/logs"), "{}");
      const check = expect(result).rejects.toThrow("timeout");
      await vi.advanceTimersByTimeAsync(2000);
      await check;
    }
    expect(ipv4).toHaveBeenCalledTimes(5);
    expect(ipv6).toHaveBeenCalledTimes(5);
    expect(cancel).toHaveBeenCalledTimes(5);
  });
  it("retains working IPv4 when AAAA resolves first, and preserves the original Host", async () => {
    let host = "";
    const url = await endpoint((req, res) => { host = req.headers.host!; req.resume(); res.end("{}"); });
    const port = url.port;
    url.hostname = "collector.test";
    vi.spyOn(Resolver.prototype, "resolve4").mockImplementation((_host, callback: unknown) => {
      setImmediate(() => (callback as (error: null, addresses: string[]) => void)(null, ["127.0.0.1"]));
    });
    vi.spyOn(Resolver.prototype, "resolve6").mockImplementation((_host, callback: unknown) => {
      (callback as (error: null, addresses: string[]) => void)(null, ["::1"]);
    });
    expect(await postPartnerTelemetry(url, "{}")).toBe("{}");
    expect(host).toBe(`collector.test:${port}`);
  });
  it("rejects redirects without sending telemetry to the destination", async () => {
    let hits = 0;
    const destination = await endpoint((_req, res) => { hits++; res.end("{}"); });
    const url = await endpoint((_req, res) => { res.writeHead(302, { location: destination.href }).end(); });
    await expect(postPartnerTelemetry(url, "{}")).rejects.toThrow("unavailable");
    expect(hits).toBe(0);
  });
  it("enforces the response byte ceiling while streaming", async () => {
    const url = await endpoint((_req, res) => { res.write("x".repeat(4096)); res.end("x"); });
    await expect(postPartnerTelemetry(url, "{}")).rejects.toThrow("byte limit");
  });
  it("bounds a stalled response after its headers", async () => {
    const url = await endpoint((_req, res) => { res.writeHead(200); res.flushHeaders(); });
    await expect(postPartnerTelemetry(url, "{}")).rejects.toThrow("timeout");
  });
});
