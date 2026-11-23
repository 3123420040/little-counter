import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  ensurePlatformSchema: vi.fn(),
  withConnectedTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: vi.fn() })),
  queryOne: vi.fn(),
  signJwt: vi.fn(() => "signed-impersonation-token"),
  recordAuditEntry: vi.fn(),
  ensureOperatorSecurityState: vi.fn(),
  requireActorAccessPermission: vi.fn(),
}));

vi.mock("../db/schema", () => ({ ensurePlatformSchema: deps.ensurePlatformSchema }));
vi.mock("../db/transaction", () => ({ withConnectedTransaction: deps.withConnectedTransaction }));
vi.mock("../db/query", () => ({ queryOne: deps.queryOne }));
vi.mock("../middleware/auth", () => ({ signJwt: deps.signJwt }));
vi.mock("../repositories/audit-repository", () => ({ recordAuditEntry: deps.recordAuditEntry }));
vi.mock("../services/operator-security-service", () => ({
  ensureOperatorSecurityState: deps.ensureOperatorSecurityState,
}));
vi.mock("../services/access-service", () => ({
  requireActorAccessPermission: deps.requireActorAccessPermission,
}));

import {
  endReadOnlyImpersonation,
  startReadOnlyImpersonation,
} from "../services/impersonation-service";

const platformActor = {
  operatorId: "operator_platform_owner",
  role: "owner" as const,
  displayName: "Platform Owner",
  organizationId: "org_platform",
};

describe("impersonation identity attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deps.ensureOperatorSecurityState.mockResolvedValue({
      globalStatus: "active",
      requiresPasswordChange: false,
      sessionVersion: 7,
    });
  });

  it("audits both the actual and effective identities when a session starts", async () => {
    deps.queryOne
      .mockResolvedValueOnce({
        operator_id: "operator_target",
        display_name: "Target Operator",
        role: "staff",
        organization_id: "org_merchant",
        is_active: true,
      })
      .mockResolvedValueOnce({
        id: "impersonation_session_1",
        expires_at: "2026-09-02T12:00:00.000Z",
      });

    await startReadOnlyImpersonation(platformActor, {
      targetOperatorId: "operator_target",
      reason: "Investigate support ticket",
      ticketRef: "SEC-16",
      durationMinutes: 30,
    });

    expect(deps.recordAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operatorId: platformActor.operatorId,
        actualOperatorId: platformActor.operatorId,
        effectiveOperatorId: "operator_target",
        impersonationSessionId: "impersonation_session_1",
      }),
      "platform.impersonation.started",
      "impersonation_session",
      "impersonation_session_1",
      expect.objectContaining({
        after: expect.objectContaining({
          actualOperatorId: platformActor.operatorId,
          effectiveOperatorId: "operator_target",
          mode: "read_only",
        }),
      }),
    );
  });

  it("uses the locked session identities when the effective operator ends it", async () => {
    deps.queryOne.mockResolvedValueOnce({
      id: "impersonation_session_2",
      actual_operator_id: platformActor.operatorId,
      effective_operator_id: "operator_target",
    });

    await endReadOnlyImpersonation({
      operatorId: "operator_target",
      role: "staff",
      displayName: "Target Operator",
      organizationId: "org_merchant",
      actualOperatorId: platformActor.operatorId,
      effectiveOperatorId: "operator_target",
      impersonationSessionId: "impersonation_session_2",
      impersonationMode: "read_only",
    }, { reason: "Investigation complete" });

    expect(deps.recordAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operatorId: "operator_target",
        actualOperatorId: platformActor.operatorId,
        effectiveOperatorId: "operator_target",
        impersonationSessionId: "impersonation_session_2",
      }),
      "platform.impersonation.ended",
      "impersonation_session",
      "impersonation_session_2",
      expect.objectContaining({
        after: {
          actualOperatorId: platformActor.operatorId,
          effectiveOperatorId: "operator_target",
        },
      }),
    );
  });
});
