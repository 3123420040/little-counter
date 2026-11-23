import { describe, expect, it } from "vitest";
import { PlatformMcpCommandMetadataV1Schema } from "../platform-mcp";
const metadata = { receiptId: "09e086cd-9ec3-4b89-b35f-02537c50b703", merchantId: "merchant-a", integrationId: "integration-a",
  environment: "sandbox", integrationVersion: 1, integrationStatus: "active", writesEnabled: false, mcpUrl: "https://partner.example/mcp",
  key: { id: "a".repeat(32), version: 1, status: "active", label: "Agent", scopes: ["catalog:read", "inventory:read"], expiresAt: "2026-12-01T00:00:00.000Z" } };
describe("metadata-only platform MCP command receipt", () => {
  it("preserves the whitelisted safe response independently from a one-time key", () => {
    expect(PlatformMcpCommandMetadataV1Schema.parse(metadata)).toEqual(metadata);
    expect(PlatformMcpCommandMetadataV1Schema.parse({ ...metadata, key: null, mcpUrl: null, integrationStatus: "paused" })).toMatchObject({ key: null, mcpUrl: null });
  });
  it.each(["revealedKey", "revealed_key", "secret", "secret_hash", "authorization", "credential_reference", "oauthSecret"])("rejects persisted secret field %s", name => {
    expect(PlatformMcpCommandMetadataV1Schema.safeParse({ ...metadata, [name]: "sensitive" }).success).toBe(false);
    expect(PlatformMcpCommandMetadataV1Schema.safeParse({ ...metadata, key: { ...metadata.key, [name]: "sensitive" } }).success).toBe(false);
  });
  it.each(["http://partner.example/mcp", "https://user:password@partner.example/mcp", "https://partner.example/mcp?key=secret", "https://partner.example/mcp#key", "https://partner.example/other"])("rejects untrusted MCP URL %s", mcpUrl => {
    expect(PlatformMcpCommandMetadataV1Schema.safeParse({ ...metadata, mcpUrl }).success).toBe(false);
  });
});
