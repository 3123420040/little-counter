import { describe, expect, it } from "vitest";
import { PlatformMcpListQueryV1Schema, PlatformMcpDetailQueryV1Schema, PlatformMcpConnectionSummaryV1Schema,
  PlatformMcpConnectionListV1Schema, PlatformMcpConnectionDetailV1Schema } from "../platform-mcp";
const connection = { integrationId: "integration-a", merchantId: "merchant-a", name: "Merchant agent", environment: "sandbox",
  status: "active", writesEnabled: false, integrationVersion: 1, merchantStatus: "suspended", managedByPlatform: false, hasOauthClients: true };
const detail = { connection, canRevokeKeys: false, mcpUrl: null, authorizationSnapshotSha256: "a".repeat(64),
  authorizationWarning: null, maxApprovedProfile: null,
  keys: { data: [{ id: "b".repeat(32), version: 1, status: "active", label: "Agent", scopes: ["catalog:read"],
    expiresAt: "2026-11-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", revokedAt: null }], nextAfter: null },
  grants: { data: [], nextAfter: null }, receipts: { data: [], nextAfter: null } };
describe("bounded safe platform MCP metadata contracts", () => {
  it("defaults page size to fifty and supports explicit numeric HTTP page values", () => {
    expect(PlatformMcpListQueryV1Schema.parse({})).toEqual({ limit: 50 });
    expect(PlatformMcpDetailQueryV1Schema.parse({ limit: "1", keysAfter: "b".repeat(32) })).toEqual({ limit: 1, keysAfter: "b".repeat(32) });
    expect(PlatformMcpListQueryV1Schema.parse({ limit: 50, status: "revoked", after: "integration-a" })).toMatchObject({ limit: 50 });
  });
  it.each([0, 51, 1.5, -1, true, false, null, "", "00", "1.0", "1e1", "51", [], ["1"]])("rejects invalid limit %j", limit => {
    expect(PlatformMcpListQueryV1Schema.safeParse({ limit }).success).toBe(false);
    expect(PlatformMcpDetailQueryV1Schema.safeParse({ limit }).success).toBe(false);
  });
  it.each([{ merchantId: "other" }, { environment: "production" }, { scopes: ["orders:write"] }, { after: "../other" }, { status: "all" }])("rejects query target/config injection %j", query => {
    expect(PlatformMcpListQueryV1Schema.safeParse(query).success).toBe(false);
  });
  it("requires separately typed page cursors", () => {
    expect(PlatformMcpDetailQueryV1Schema.safeParse({ keysAfter: "integration-a" }).success).toBe(false);
    expect(PlatformMcpDetailQueryV1Schema.safeParse({ receiptsAfter: "not-a-uuid" }).success).toBe(false);
    expect(PlatformMcpDetailQueryV1Schema.safeParse({ grantsAfter: "store-a", receiptsAfter: "2e5ca0aa-44df-40b1-a9f9-155f4d998ce0" }).success).toBe(true);
  });
  it("whitelists summary/key/history fields without allowing secrets or raw durable result blobs", () => {
    expect(PlatformMcpConnectionSummaryV1Schema.safeParse(connection).success).toBe(true);
    expect(PlatformMcpConnectionDetailV1Schema.safeParse(detail).success).toBe(true);
    expect(PlatformMcpConnectionListV1Schema.safeParse({ data: [connection], canRevokeKeys: false, nextAfter: null, mcpUrl: null }).success).toBe(true);
    expect(PlatformMcpConnectionSummaryV1Schema.safeParse({ ...connection, credential_reference: "private-ref" }).success).toBe(false);
    expect(PlatformMcpConnectionDetailV1Schema.safeParse({ ...detail, result_metadata: {} }).success).toBe(false);
    expect(PlatformMcpConnectionDetailV1Schema.safeParse({ ...detail, keys: { data: [{ ...detail.keys.data[0], secret_hash: "private-hash" }], nextAfter: null } }).success).toBe(false);
  });
});
