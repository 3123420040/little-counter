import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  ensurePlatformSchema: vi.fn(),
  withConnectedClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: vi.fn() })),
  recordAuditEntry: vi.fn(),
}));
const access = vi.hoisted(() => ({
  requireOperatingScope: vi.fn(),
}));

vi.mock("../db/schema", () => ({
  ensurePlatformSchema: db.ensurePlatformSchema,
}));

vi.mock("../db/transaction", () => ({
  withConnectedClient: db.withConnectedClient,
}));

vi.mock("../repositories/audit-repository", () => ({
  recordAuditEntry: db.recordAuditEntry,
}));

vi.mock("../services/access-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/access-service")>(),
  requireOperatingScope: access.requireOperatingScope,
}));

import {
  assertNotReadOnlyImpersonation,
  requireOperatingReadScope,
} from "../services/permission-service";

describe("permission read-only impersonation blocker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    access.requireOperatingScope.mockResolvedValue({
      scopeKind: "operating",
      merchantId: "merchant_a",
      storeId: "store_a",
      stockLocationId: "sloc_a",
    });
  });

  it("resolves an impersonated operating read without producing a mutation denial", async () => {
    const readOnlyActor = {
      operatorId: "op_target",
      role: "staff",
      organizationId: "org_a",
      actualOperatorId: "op_platform",
      effectiveOperatorId: "op_target",
      impersonationSessionId: "imp_read_scope",
      impersonationMode: "read_only",
    } as const;
    const requestHeaders = { "x-merchant-id": "merchant_a", "x-store-id": "store_a" };

    await expect(requireOperatingReadScope(readOnlyActor as never, requestHeaders))
      .resolves.toMatchObject({ merchantId: "merchant_a", storeId: "store_a" });

    expect(access.requireOperatingScope).toHaveBeenCalledWith(readOnlyActor, requestHeaders);
    expect(db.recordAuditEntry).not.toHaveBeenCalled();
  });

  it("allows normal actors without audit writes", async () => {
    await expect(assertNotReadOnlyImpersonation({
      operatorId: "op_staff",
      role: "staff",
      organizationId: "org_a",
    } as never)).resolves.toBeUndefined();

    expect(db.recordAuditEntry).not.toHaveBeenCalled();
  });

  it("audits denied read-only impersonation mutations before returning 403", async () => {
    const actor = {
      operatorId: "op_target",
      role: "staff",
      organizationId: "org_a",
      actualOperatorId: "op_platform",
      effectiveOperatorId: "op_target",
      impersonationSessionId: "imp_1",
      impersonationMode: "read_only",
    } as const;

    await expect(assertNotReadOnlyImpersonation(actor as never)).rejects.toMatchObject({
      code: "impersonation_read_only",
      statusCode: 403,
    });

    expect(db.ensurePlatformSchema).toHaveBeenCalled();
    expect(db.recordAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      "impersonation.mutation_denied",
      "impersonation_session",
      "imp_1",
      expect.objectContaining({
        reason: "impersonation_read_only",
        after: {
          actualOperatorId: "op_platform",
          effectiveOperatorId: "op_target",
          mode: "read_only",
        },
      }),
    );
  });
});
