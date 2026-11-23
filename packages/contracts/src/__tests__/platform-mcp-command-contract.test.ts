import { describe, expect, it } from "vitest";
import { PlatformMcpCreateConnectionV1Schema, PlatformMcpIssueKeyV1Schema, PlatformMcpRotateKeyV1Schema,
  PlatformMcpRevokeKeyV1Schema, PlatformMcpChangeStatusV1Schema } from "../platform-mcp";

const create = { name: "  Merchant agent  ", storeIds: ["store-b", "store-a"], reason: "onboarding" };
const expectedAuthorizationSnapshotSha256 = "a".repeat(64);
describe("platform MCP staff command contracts", () => {
  it("defaults to read and canonicalizes store identity order without changing the selected stores", () => {
    expect(PlatformMcpCreateConnectionV1Schema.parse(create)).toEqual({ ...create, name: "Merchant agent", storeIds: ["store-a", "store-b"], profile: "read" });
    expect(PlatformMcpCreateConnectionV1Schema.parse({ ...create, profile: "commerce" }).profile).toBe("commerce");
  });
  it.each([
    { name: " " }, { name: "a".repeat(121) }, { label: " " }, { label: "a".repeat(129) },
    { storeIds: [] }, { storeIds: ["store-a", "store-a"] }, { storeIds: Array.from({ length: 21 }, (_, i) => `store-${i}`) },
    { profile: "write" }, { scopes: ["orders:write"] }, { writes_enabled: true }, { environment: "production" },
    { merchantId: "foreign" }, { stockLocationId: "foreign" }, { conformance_receipt_sha256: "a".repeat(64) },
    { mcp_url: "https://arbitrary.example/mcp" }, { reason: "bypass" }, { policy: {} }, { keyTtlDays: 365 },
  ])("rejects untrusted onboarding field %j", fields => {
    expect(PlatformMcpCreateConnectionV1Schema.safeParse({ ...create, ...fields }).success).toBe(false);
  });
  it("bounds selected stores at twenty and does not default a label into legacy names", () => {
    const result = PlatformMcpCreateConnectionV1Schema.parse({ ...create, storeIds: Array.from({ length: 20 }, (_, i) => `store-${i}`) });
    expect(result.storeIds).toHaveLength(20); expect(result).not.toHaveProperty("label");
  });
  it("defaults additional keys to read and requires exact safe integration/key versions", () => {
    expect(PlatformMcpIssueKeyV1Schema.parse({ expectedIntegrationVersion: 1, expectedAuthorizationSnapshotSha256, reason: "onboarding" })).toMatchObject({ profile: "read" });
    expect(PlatformMcpIssueKeyV1Schema.parse({ profile: "commerce", expectedIntegrationVersion: 1, expectedAuthorizationSnapshotSha256, reason: "commercial_policy" }).profile).toBe("commerce");
    for (const version of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(PlatformMcpIssueKeyV1Schema.safeParse({ expectedIntegrationVersion: version, expectedAuthorizationSnapshotSha256, reason: "onboarding" }).success).toBe(false);
      expect(PlatformMcpRotateKeyV1Schema.safeParse({ expectedIntegrationVersion: 1, expectedKeyVersion: version, expectedAuthorizationSnapshotSha256, reason: "credential_rotation" }).success).toBe(false);
      expect(PlatformMcpRevokeKeyV1Schema.safeParse({ expectedKeyVersion: version, reason: "security_incident" }).success).toBe(false);
    }
  });
  it("rotation preserves key scopes and requires the credential rotation reason", () => {
    const input = { expectedIntegrationVersion: 1, expectedKeyVersion: 2, expectedAuthorizationSnapshotSha256, reason: "credential_rotation" };
    expect(PlatformMcpRotateKeyV1Schema.parse(input)).toEqual(input);
    for (const fields of [{ scopes: ["orders:write"] }, { profile: "commerce" }, { overlap_seconds: 86400 }, { reason: "onboarding" }, { keyId: "a".repeat(32) }]) {
      expect(PlatformMcpRotateKeyV1Schema.safeParse({ ...input, ...fields }).success).toBe(false);
    }
  });
  it("revoke accepts a reason and key version only", () => {
    const input = { expectedKeyVersion: 1, reason: "security_incident" };
    expect(PlatformMcpRevokeKeyV1Schema.parse(input)).toEqual(input);
    expect(PlatformMcpRevokeKeyV1Schema.safeParse({ ...input, integrationId: "foreign" }).success).toBe(false);
  });
  it("resumes read by default and never accepts a write flag or profile when paused", () => {
    const input = { status: "active", expectedIntegrationVersion: 1, expectedAuthorizationSnapshotSha256, reason: "operator_request" };
    expect(PlatformMcpChangeStatusV1Schema.parse(input)).toEqual({ ...input, profile: "read" });
    expect(PlatformMcpChangeStatusV1Schema.parse({ ...input, profile: "commerce" })).toMatchObject({ profile: "commerce" });
    const pause = { status: "paused", expectedIntegrationVersion: 1, reason: "operator_request" };
    expect(PlatformMcpChangeStatusV1Schema.parse(pause)).toEqual(pause);
    for (const fields of [{ status: "paused", profile: "commerce" }, { writes_enabled: true }, { status: "revoked" }, { approvedProfile: "commerce" }]) {
      expect(PlatformMcpChangeStatusV1Schema.safeParse({ ...input, ...fields }).success).toBe(false);
    }
  });
  it.each([undefined, "", "A".repeat(64), "a".repeat(63), "a".repeat(65), 1])("requires the reviewed authorization snapshot for widening/rotation: %s", snapshot => {
    expect(PlatformMcpIssueKeyV1Schema.safeParse({ expectedIntegrationVersion: 1, reason: "onboarding", expectedAuthorizationSnapshotSha256: snapshot }).success).toBe(false);
    expect(PlatformMcpRotateKeyV1Schema.safeParse({ expectedIntegrationVersion: 1, expectedKeyVersion: 1, reason: "credential_rotation", expectedAuthorizationSnapshotSha256: snapshot }).success).toBe(false);
    expect(PlatformMcpChangeStatusV1Schema.safeParse({ status: "active", expectedIntegrationVersion: 1, reason: "operator_request", expectedAuthorizationSnapshotSha256: snapshot }).success).toBe(false);
  });
});
