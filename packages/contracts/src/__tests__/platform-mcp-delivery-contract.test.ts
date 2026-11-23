import { describe, expect, it } from "vitest";
import { PlatformMcpCommandResultV1Schema } from "../platform-mcp";
const metadata = {
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
const secret = `snus_mcp_test_${"a".repeat(32)}.${"x".repeat(43)}`;
const first = () => ({
  data: structuredClone(metadata),
  replayed: false,
  requestState: "completed",
  secretStatus: "available_once",
  revealedKey: secret,
});
describe("MCP one-time delivery protocol", () => {
  it("accepts a first secret only with matching environment/key identity and safe rotation context", () => {
    expect(PlatformMcpCommandResultV1Schema.safeParse(first()).success).toBe(
      true,
    );
    expect(
      PlatformMcpCommandResultV1Schema.safeParse({
        ...first(),
        rotation: {
          previousKeyId: "b".repeat(32),
          previousKeyVersion: 2,
          previousKeyExpiresAt: metadata.key.expiresAt,
        },
      }).success,
    ).toBe(true);
  });
  it.each([
    "environment",
    "identity",
    "null-key",
    "revoked-key",
    "missing-url",
    "same-rotation-key",
    "raw-hash",
  ])("rejects an inconsistent first delivery: %s", (invalid) => {
    const value: any = first();
    if (invalid === "environment") value.data.environment = "production";
    if (invalid === "identity") value.data.key.id = "b".repeat(32);
    if (invalid === "null-key") value.data.key = null;
    if (invalid === "revoked-key") value.data.key.status = "revoked";
    if (invalid === "missing-url") value.data.mcpUrl = null;
    if (invalid === "same-rotation-key")
      value.rotation = {
        previousKeyId: metadata.key.id,
        previousKeyVersion: 1,
        previousKeyExpiresAt: metadata.key.expiresAt,
      };
    if (invalid === "raw-hash") value.data.key.secret_hash = "c".repeat(64);
    expect(PlatformMcpCommandResultV1Schema.safeParse(value).success).toBe(
      false,
    );
  });
  it.each(["completed", "expired"])(
    "permits %s replay metadata but never a secret or rotation payload",
    (state) => {
      const replay = {
        data:
          state === "completed"
            ? metadata
            : {
                receiptId: metadata.receiptId,
                integrationId: metadata.integrationId,
                keyId: metadata.key.id,
              },
        replayed: true,
        requestState: state,
        secretStatus: "unavailable_on_replay",
      };
      expect(PlatformMcpCommandResultV1Schema.safeParse(replay).success).toBe(
        true,
      );
      expect(
        PlatformMcpCommandResultV1Schema.safeParse({
          ...replay,
          revealedKey: secret,
        }).success,
      ).toBe(false);
      expect(
        PlatformMcpCommandResultV1Schema.safeParse({ ...replay, rotation: {} })
          .success,
      ).toBe(false);
    },
  );
  it("accepts no-secret commands with metadata and rejects unexpected secret fields", () => {
    const value = {
      data: { ...metadata, key: null },
      replayed: false,
      requestState: "completed",
      secretStatus: "not_applicable",
    };
    expect(PlatformMcpCommandResultV1Schema.safeParse(value).success).toBe(
      true,
    );
    expect(
      PlatformMcpCommandResultV1Schema.safeParse({
        ...value,
        revealedKey: secret,
      }).success,
    ).toBe(false);
  });
});
