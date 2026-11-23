import { beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: calls,
}));
import {
  executePlatformMcpCommand,
  fetchPlatformMcpConnections,
  fetchPlatformMcpConnection,
} from "./platform-mcp-endpoints";
const data = {
  receiptId: "81de7598-a399-4bf0-af9f-4dc973533c3e",
  merchantId: "m-a",
  integrationId: "i-a",
  environment: "sandbox",
  integrationVersion: 2,
  integrationStatus: "active",
  writesEnabled: false,
  mcpUrl: "https://partner.example/mcp",
  key: {
    id: "a".repeat(32),
    version: 1,
    status: "active",
    label: "Synthetic",
    scopes: ["partner:read"],
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};
const first = () => ({
  data: structuredClone(data),
  replayed: false,
  requestState: "completed",
  secretStatus: "available_once",
  revealedKey: `snus_mcp_test_${data.key.id}.${"x".repeat(43)}`,
});
const input = {
  name: "Synthetic",
  storeIds: ["s-b", "s-a"],
  profile: "read",
  reason: "onboarding",
} as const;
beforeEach(() => {
  vi.resetAllMocks();
  calls.post.mockResolvedValue(first());
});
describe("platform MCP client boundary", () => {
  it("uses the stable request, normalized strict input and AbortSignal, without retrying", async () => {
    const signal = new AbortController().signal;
    expect(
      await executePlatformMcpCommand(
        "m-a",
        {
          action: "create",
          input: { ...input, storeIds: [...input.storeIds] },
        },
        "stable-client-attempt",
        signal,
      ),
    ).toMatchObject({ secretStatus: "available_once" });
    expect(calls.post).toHaveBeenCalledExactlyOnceWith(
      "/api/platform/admin/merchants/m-a/mcp-connections",
      { ...input, storeIds: ["s-a", "s-b"] },
      "stable-client-attempt",
      {},
      signal,
    );
  });
  it.each([
    "foreign-merchant",
    "foreign-integration",
    "replayed-secret",
    "invalid-envelope",
  ])(
    "discards an unsafe response without reflecting it in errors: %s",
    async (invalid) => {
      const result: any = first();
      if (invalid === "foreign-merchant") result.data.merchantId = "m-other";
      if (invalid === "foreign-integration")
        result.data.integrationId = "i-other";
      if (invalid === "replayed-secret") result.replayed = true;
      if (invalid === "invalid-envelope")
        result.unexpected = result.revealedKey;
      calls.post.mockResolvedValue(result);
      let error: any;
      try {
        await executePlatformMcpCommand(
          "m-a",
          {
            action: "issue",
            integrationId: "i-a",
            input: {
              profile: "read",
              expectedIntegrationVersion: 2,
              expectedAuthorizationSnapshotSha256: "a".repeat(64),
              reason: "onboarding",
            },
          },
          "stable-attempt-key",
        );
      } catch (failure) {
        error = failure;
      }
      expect(error).toMatchObject({
        code: "platform_mcp_contract_unavailable",
      });
      expect(error.message).not.toContain(result.revealedKey);
      expect(error.details).toBeUndefined();
    },
  );
  it("rejects raw provisioning fields before sending", async () => {
    await expect(
      executePlatformMcpCommand(
        "m-a",
        {
          action: "create",
          input: {
            ...input,
            storeIds: [...input.storeIds],
            scopes: ["orders:write"],
          },
        } as never,
        "stable-attempt-key",
      ),
    ).rejects.toBeDefined();
    expect(calls.post).not.toHaveBeenCalled();
  });
  it("checks metadata merchant binding and never accepts credential fields in list/detail", async () => {
    calls.get.mockResolvedValue({
      data: [
        {
          integrationId: "i-a",
          merchantId: "m-other",
          name: "Other",
          environment: "sandbox",
          status: "active",
          writesEnabled: false,
          integrationVersion: 1,
          merchantStatus: "active",
          managedByPlatform: true,
          hasOauthClients: false,
        },
      ],
      nextAfter: null,
      canRevokeKeys: true,
      mcpUrl: data.mcpUrl,
    });
    await expect(fetchPlatformMcpConnections("m-a")).rejects.toMatchObject({
      code: "platform_mcp_contract_unavailable",
    });
    calls.get.mockResolvedValue({ revealedKey: first().revealedKey });
    await expect(
      fetchPlatformMcpConnection("m-a", "i-a", { keysAfter: "b".repeat(32) }),
    ).rejects.toMatchObject({ code: "platform_mcp_contract_unavailable" });
    expect(calls.get).toHaveBeenLastCalledWith(
      `/api/platform/admin/merchants/m-a/mcp-connections/i-a?keysAfter=${"b".repeat(32)}`,
    );
  });
});
