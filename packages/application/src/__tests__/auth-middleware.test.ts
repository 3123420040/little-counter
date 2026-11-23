import { afterEach, describe, expect, it } from "vitest";
import { signJwt, verifyJwt } from "../middleware/auth";

const originalJwtSecret = process.env.JWT_SECRET;

afterEach(() => {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

describe("JWT middleware secret handling", () => {
  const payload = {
    operatorId: "op_test",
    role: "owner",
    displayName: "Test Owner",
    organizationId: "org_test",
    sessionVersion: 3,
    authState: "authenticated" as const,
  };

  it("fails closed when JWT_SECRET is missing", () => {
    delete process.env.JWT_SECRET;

    expect(() => signJwt(payload)).toThrow("JWT_SECRET must be set");
  });

  it("fails closed when JWT_SECRET uses the historical placeholder", () => {
    process.env.JWT_SECRET = "change-me-to-a-random-256-bit-secret-min-32-chars";

    expect(() => signJwt(payload)).toThrow("JWT_SECRET must be set");
  });

  it("signs and verifies with an explicit non-placeholder secret", () => {
    process.env.JWT_SECRET = "unit-test-jwt-secret-min-32-characters";

    const token = signJwt(payload);
    expect(verifyJwt(token)).toMatchObject(payload);
  });
});
