import { describe, expect, it } from "vitest";
import { createRuntimeCapabilityTelemetry } from "./runtimeCapabilityTelemetry";

describe("CAP-09 sanitized compatibility telemetry", () => {
  it("emits only the whitelisted selection fields", () => {
    const event = createRuntimeCapabilityTelemetry({
      event: "runtime_capability_selected",
      capability: "ordersRead",
      handshakeState: "v2_compatibility",
      selectedVersion: "v2",
      serverVersions: ["v2"],
      clientVersions: ["v2", "v3"],
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      releaseId: "1.9.0-candidate.1",
      token: "bearer-secret",
      customerEmail: "customer@example.com",
      orderId: "order-secret",
    } as never);

    expect(event).toEqual({
      schemaVersion: 1,
      event: "runtime_capability_selected",
      capability: "ordersRead",
      handshakeState: "v2_compatibility",
      selectedVersion: "v2",
      serverVersions: ["v2"],
      clientVersions: ["v2", "v3"],
      sourceCommitPrefix: "0123456789ab",
      releaseId: "1.9.0-candidate.1",
    });
    expect(JSON.stringify(event)).not.toMatch(/bearer|customer@|order-secret/i);
  });

  it("rejects unsafe identity instead of logging arbitrary content", () => {
    expect(() => createRuntimeCapabilityTelemetry({
      event: "runtime_capability_mismatch",
      capability: "checkoutWrite",
      handshakeState: "invalid",
      selectedVersion: null,
      serverVersions: [],
      clientVersions: ["v1"],
      sourceCommit: "token.payload.signature",
      releaseId: "candidate\nforged",
    })).toThrow(/telemetry/i);
  });
});
