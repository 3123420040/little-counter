import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { generatePartnerMcpKey, verifyPartnerMcpKey } from "../partner/mcp-key";

describe("MCP-20 canonical Bearer key format and environment separation", () => {
  it.each(["sandbox", "production"] as const)("generates a 128-bit ID and 256-bit secret for %s", environment => {
    const first = generatePartnerMcpKey(environment), second = generatePartnerMcpKey(environment);
    const prefix = environment === "sandbox" ? "test" : "live";
    expect(new RegExp(`^snus_mcp_${prefix}_[a-f0-9]{32}\\.[A-Za-z0-9_-]{43}$`).test(first.key)).toBe(true);
    expect(Buffer.from(first.keyId, "hex")).toHaveLength(16);
    expect(Buffer.from(first.key.split(".")[1], "base64url")).toHaveLength(32);
    expect(first.keyId === second.keyId || first.key === second.key).toBe(false);
    expect(first.secretHash === createHash("sha256").update(first.key).digest("hex")).toBe(true);
  });

  it("rejects noncanonical base64url pad bits, excess bytes and unsupported auth before querying the registry", async () => {
    const generated = generatePartnerMcpKey("sandbox"), query = vi.fn();
    const header = `Bearer ${generated.key}`;
    const secret = generated.key.split(".")[1], alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const index = alphabet.indexOf(secret.at(-1)!);
    const noncanonical = secret.slice(0, -1) + alphabet[index + 1];
    expect(Buffer.from(noncanonical, "base64url").equals(Buffer.from(secret, "base64url"))).toBe(true);
    for (const invalid of [header.replace(secret, noncanonical), header + "a", header + "=", header.replace("Bearer", "Basic"), [header]]) {
      await expect(verifyPartnerMcpKey({ query }, invalid, "sandbox")).rejects.toMatchObject({ code: "invalid_token", status: 401 });
    }
    expect(query).not.toHaveBeenCalled();
  });
});
