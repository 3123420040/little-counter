import { describe, expect, it } from "vitest";
import { PartnerControlPolicy } from "@medusa-snus/contracts/partner-api";
import { platformMcpIssuancePresetV1, platformMcpProfileScopesV1 } from "../services/platform-mcp-policy";

describe("reviewable finite platform MCP issuance preset", () => {
  it("fixes all existing policy fields at finite reviewed limits without copying a live merchant", () => {
    expect(platformMcpIssuancePresetV1).toEqual({ version: "platform-mcp-v1", policy: {
      currency: "VND", max_order_total: 10_000_000, max_quantity: 100, safety_stock: 0, delivery_fee: null,
      contact_retention_days: 30, read_per_minute: 120, read_burst: 20, quote_per_minute: 30, quote_burst: 5,
      book_per_minute: 10, book_burst: 2, mutation_concurrency: 2,
    } });
    expect(PartnerControlPolicy.safeParse(platformMcpIssuancePresetV1.policy).success).toBe(true);
    expect(Object.isFrozen(platformMcpIssuancePresetV1)).toBe(true);
    expect(Object.isFrozen(platformMcpIssuancePresetV1.policy)).toBe(true);
  });
  it("adds exactly quote/write for the explicit commerce profile and never exposes management scopes", () => {
    expect(platformMcpProfileScopesV1.read).toEqual(["partner:read", "catalog:read", "inventory:read", "orders:read"]);
    expect(platformMcpProfileScopesV1.commerce).toEqual([...platformMcpProfileScopesV1.read, "orders:quote", "orders:write"]);
    expect(Object.isFrozen(platformMcpProfileScopesV1)).toBe(true);
    expect(Object.isFrozen(platformMcpProfileScopesV1.read)).toBe(true);
    expect(Object.isFrozen(platformMcpProfileScopesV1.commerce)).toBe(true);
  });
});
