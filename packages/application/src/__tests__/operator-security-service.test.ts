import { describe, expect, it } from "vitest";
import { PlatformError } from "../errors/platform-error";
import {
  assertOperatorCanUseChannel,
  assertOperatorSecurityAllowsRequest,
  tokenIssuedBeforeForceLogout,
  type OperatorSecurityState,
} from "../services/operator-security-service";
import type { JwtPayload } from "../middleware/auth";

const payload: JwtPayload = {
  operatorId: "op_test",
  role: "staff",
  displayName: "Test",
  organizationId: "org_default",
  sessionVersion: 2,
  authState: "authenticated",
  iat: 1_000,
  exp: 2_000,
};

function state(overrides: Partial<OperatorSecurityState> = {}): OperatorSecurityState {
  return {
    operatorId: "op_test",
    requiresPasswordChange: false,
    forceLogoutAfter: null,
    sessionVersion: 2,
    globalStatus: "active",
    passwordChangedAt: null,
    temporaryPasswordHash: null,
    temporaryPasswordExpiresAt: null,
    lastLoginAt: null,
    ...overrides,
  };
}

function captureError(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

describe("operator security-state request validation", () => {
  it("accepts a matching active session", () => {
    expect(() => assertOperatorSecurityAllowsRequest(payload, state())).not.toThrow();
  });

  it("rejects stale session versions immediately", () => {
    expect(captureError(() => assertOperatorSecurityAllowsRequest(payload, state({ sessionVersion: 3 })))).toMatchObject({
      code: "session_invalidated",
    });
  });

  it("rejects tokens issued before force_logout_after", () => {
    const forceLogoutAfter = new Date((payload.iat + 1) * 1000);
    expect(tokenIssuedBeforeForceLogout(payload, forceLogoutAfter)).toBe(true);
    expect(captureError(() => assertOperatorSecurityAllowsRequest(payload, state({ forceLogoutAfter })))).toMatchObject({
      code: "session_invalidated",
    });
  });

  it("rejects suspended operators", () => {
    expect(captureError(() => assertOperatorSecurityAllowsRequest(payload, state({ globalStatus: "suspended" })))).toMatchObject({
      code: "operator_suspended",
    });
  });

  it("allows only the forced password-change route while restricted", () => {
    const restrictedPayload = { ...payload, authState: "password_change_required" as const };
    expect(captureError(() => assertOperatorSecurityAllowsRequest(
      restrictedPayload,
      state({ requiresPasswordChange: true }),
    ))).toMatchObject({
      code: "password_change_required",
    });
    expect(() => assertOperatorSecurityAllowsRequest(
      restrictedPayload,
      state({ requiresPasswordChange: true }),
      { allowPasswordChangeRequired: true },
    )).not.toThrow();
  });

  it("blocks channel actors when suspended or forced-change", () => {
    expect(() => assertOperatorCanUseChannel(state())).not.toThrow();
    expect(() => assertOperatorCanUseChannel(state({ globalStatus: "suspended" }))).toThrow(PlatformError);
    expect(() => assertOperatorCanUseChannel(state({ requiresPasswordChange: true }))).toThrow(PlatformError);
  });
});
