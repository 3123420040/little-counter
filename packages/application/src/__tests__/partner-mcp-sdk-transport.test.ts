import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { partnerMcpHttp } from "../partner/mcp-http";

const fixture = vi.hoisted(() => ({ host: "" }));
vi.mock("../partner/http", () => ({
  logPartnerAttempt: vi.fn(),
  getPartnerRuntime: () => ({
    mcpSettings: () => ({ host: fixture.host }),
    admitMcpIp: async () => undefined,
    admitMcpControl: async () => undefined,
    authenticateMcp: async () => ({
      grants: [{ scopes: ["partner:read", "catalog:read", "inventory:read", "orders:read"] }],
    }),
  }),
}));

let server: Server;
let url: URL;

beforeAll(async () => {
  vi.stubEnv("PARTNER_MCP_ENABLED", "true");
  server = createServer((request, response) => {
    void partnerMcpHttp(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback listener");
  fixture.host = `127.0.0.1:${address.port}`;
  url = new URL(`http://${fixture.host}/mcp`);
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.unstubAllEnvs();
});

describe("MCP SDK HTTP compatibility", () => {
  it("initializes, lists the six read tools and pings through the actual SDK transport", async () => {
    const client = new Client({ name: "sdk-upgrade-smoke", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: "Bearer synthetic-sdk-smoke" } },
      }));
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual([
        "get_catalog_summary", "get_inventory", "get_order", "get_partner_context", "list_orders", "list_products",
      ]);
      expect(await client.ping()).toEqual({});
    } finally {
      await client.close();
    }
  });

  it.each([
    ["oversized body", JSON.stringify({ padding: "x".repeat(65_536) }), {}, 413],
    ["batch", JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]), {}, 400],
    ["session reuse", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), { "mcp-session-id": "synthetic-session" }, 400],
    ["experimental task", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "get_partner_context", arguments: {}, task: { ttl: 1_000 },
    } }), {}, 400],
  ] as const)("retains the request boundary for %s", async (_name, body, headers, expected) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-sdk-smoke",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      body,
    });
    expect(response.status).toBe(expected);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const rejected = await response.text();
    expect(rejected).not.toContain("synthetic-sdk-smoke");
  });
});
