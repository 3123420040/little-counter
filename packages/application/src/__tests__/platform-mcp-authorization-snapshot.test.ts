import { describe, expect, it } from "vitest";
import { hashPlatformMcpAuthorizationSnapshotV1 } from "../services/platform-mcp-authorization-snapshot";
import { platformMcpIssuancePresetV1 } from "../services/platform-mcp-policy";

const grant = { storeId: "store-a", stockLocationId: "stock-a", status: "active", allowedScopes: ["catalog:read", "inventory:read"],
  mcpCatalogMode: "merchant_published", grantVersion: 1, assortmentId: "assortment-a", assortmentStatus: "active", assortmentVersion: 1 };
const snapshot = () => ({ schemaVersion: 1, environment: "sandbox", merchantId: "merchant-a", integrationId: "integration-a",
  integration: { status: "active", writesEnabled: false, version: 1, policyId: "policy-a", policyVersion: 1, policy: platformMcpIssuancePresetV1.policy },
  grants: [{ ...grant }, { ...grant, storeId: "store-b", stockLocationId: "stock-b" }], approval: null });
describe("complete resource authorization snapshot for platform MCP CAS", () => {
  it("canonicalizes set order without mutating caller values", () => {
    const first = snapshot(), second = snapshot();
    second.grants.reverse(); second.grants[0].allowedScopes = [...grant.allowedScopes].reverse();
    expect(hashPlatformMcpAuthorizationSnapshotV1(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashPlatformMcpAuthorizationSnapshotV1(second)).toBe(hashPlatformMcpAuthorizationSnapshotV1(first));
    expect(second.grants[0].storeId).toBe("store-b");
  });
  it.each(["environment", "merchantId", "integrationId", "integrationVersion", "writes", "policy", "grantVersion", "grantScope", "grantStore", "stockLocation", "catalogMode", "assortmentVersion", "assortmentStatus", "hiddenGrant"])("changes on relevant authorization fact %s", field => {
    const changed = snapshot();
    if (field === "environment") changed.environment = "production";
    if (field === "merchantId") changed.merchantId = "merchant-b";
    if (field === "integrationId") changed.integrationId = "integration-b";
    if (field === "integrationVersion") changed.integration.version++;
    if (field === "writes") changed.integration.writesEnabled = true;
    if (field === "policy") changed.integration.policy = { ...changed.integration.policy, safety_stock: 1 };
    if (field === "grantVersion") changed.grants[0].grantVersion++;
    if (field === "grantScope") changed.grants[0].allowedScopes = ["orders:read"];
    if (field === "grantStore") changed.grants[0].storeId = "store-c";
    if (field === "stockLocation") changed.grants[0].stockLocationId = "stock-c";
    if (field === "catalogMode") changed.grants[0].mcpCatalogMode = "explicit";
    if (field === "assortmentVersion") changed.grants[0].assortmentVersion++;
    if (field === "assortmentStatus") changed.grants[0].assortmentStatus = "inactive";
    if (field === "hiddenGrant") changed.grants.push({ ...grant, storeId: "store-unpaged", stockLocationId: "stock-unpaged" });
    expect(hashPlatformMcpAuthorizationSnapshotV1(changed)).not.toBe(hashPlatformMcpAuthorizationSnapshotV1(snapshot()));
  });
  it("binds durable maximum approval independently of current active writes", () => {
    const first = { ...snapshot(), approval: { workflowVersion: "platform-mcp-v1", maxApprovedProfile: "read", approvedScopes: ["catalog:read", "inventory:read"],
      approvedStoreIds: ["store-b", "store-a"], presetVersion: "platform-mcp-v1", policyId: "policy-a", policyVersion: 1,
      policySha256: "b".repeat(64) } };
    const reordered = { ...first, approval: { ...first.approval, approvedStoreIds: ["store-a", "store-b"], approvedScopes: [...first.approval.approvedScopes].reverse() } };
    expect(hashPlatformMcpAuthorizationSnapshotV1(reordered)).toBe(hashPlatformMcpAuthorizationSnapshotV1(first));
    expect(hashPlatformMcpAuthorizationSnapshotV1(first)).not.toBe(hashPlatformMcpAuthorizationSnapshotV1(snapshot()));
    expect(hashPlatformMcpAuthorizationSnapshotV1({ ...first, approval: { ...first.approval, maxApprovedProfile: "commerce" } })).not.toBe(hashPlatformMcpAuthorizationSnapshotV1(first));
  });
  it.each(["keys", "secret_hash", "issuedAt", "products", "now", "runtimeFlags"])("rejects irrelevant or sensitive field %s instead of silently hashing it", key => {
    expect(() => hashPlatformMcpAuthorizationSnapshotV1({ ...snapshot(), [key]: "forbidden" })).toThrow();
  });
  it("rejects duplicate grant identities, duplicate scopes and unsafe versions", () => {
    const input = snapshot();
    expect(() => hashPlatformMcpAuthorizationSnapshotV1({ ...input, grants: [grant, grant] })).toThrow();
    expect(() => hashPlatformMcpAuthorizationSnapshotV1({ ...input, grants: [{ ...grant, allowedScopes: ["catalog:read", "catalog:read"] }] })).toThrow();
    expect(() => hashPlatformMcpAuthorizationSnapshotV1({ ...input, integration: { ...input.integration, version: Number.MAX_SAFE_INTEGER + 1 } })).toThrow();
  });
});
