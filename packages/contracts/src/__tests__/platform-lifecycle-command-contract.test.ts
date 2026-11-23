import { describe, expect, it } from "vitest";
import { PlatformLifecycleCommandV1Schema, PlatformLifecycleCommandResultV1Schema } from "../platform-entity";

const input = { status: "suspended", expectedVersion: 1, reason: "  Merchant handover  " };
describe("platform lifecycle command contract", () => {
  it("accepts only active/suspended with a safe version and canonical reason", () => {
    expect(PlatformLifecycleCommandV1Schema.parse(input)).toEqual({ ...input, reason: "Merchant handover" });
    expect(PlatformLifecycleCommandV1Schema.parse({ ...input, status: "active", expectedVersion: Number.MAX_SAFE_INTEGER }).status).toBe("active");
  });
  it.each([
    { status: "closed" }, { status: "disabled" }, { expectedVersion: 0 }, { expectedVersion: 1.5 },
    { expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, { expectedVersion: "1" }, { expectedVersion: -1 },
    { expectedVersion: null }, { expectedVersion: true }, { status: null }, { reason: "" },
    { reason: " " }, { reason: "a".repeat(501) },
    { merchantId: "foreign" }, { storeId: "foreign" }, { stockLocationId: "foreign" }, { allowSuspended: true },
  ])("rejects untrusted lifecycle fields %j", fields => {
    expect(PlatformLifecycleCommandV1Schema.safeParse({ ...input, ...fields }).success).toBe(false);
  });
  it.each(["status", "expectedVersion", "reason"])("rejects a missing required %s", field => {
    const incomplete: Record<string, unknown> = { ...input };
    delete incomplete[field];
    expect(PlatformLifecycleCommandV1Schema.safeParse(incomplete).success).toBe(false);
  });
  it("whitelists one transition/no-op result without entity metadata", () => {
    const result = { entityType: "merchant", entityId: "merchant-a", status: "suspended", statusVersion: 2,
      changed: true, statusChangedAt: "2026-10-26T00:00:00.000Z" };
    expect(PlatformLifecycleCommandResultV1Schema.parse(result)).toEqual(result);
    expect(PlatformLifecycleCommandResultV1Schema.parse({ ...result, changed: false, statusChangedAt: null }).changed).toBe(false);
    expect(PlatformLifecycleCommandResultV1Schema.safeParse({ ...result, metadata: { secret: "forbidden" } }).success).toBe(false);
    expect(PlatformLifecycleCommandResultV1Schema.safeParse({ ...result, status: "closed" }).success).toBe(false);
  });
});
