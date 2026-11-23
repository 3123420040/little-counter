import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlatformError } from "../errors/platform-error";
import {
  getTestEmailProvider,
  resolveTransactionalEmailProvider,
  validateResendProductionConfig,
} from "../email/factory";

const managedKeys = [
  "NODE_ENV",
  "PUBLIC_SIGNUP_EMAIL_PROVIDER",
  "PUBLIC_SIGNUP_ENABLED",
  "TRANSACTIONAL_EMAIL_FROM",
  "TRANSACTIONAL_EMAIL_REPLY_TO",
  "RESEND_API_KEY",
  "RESEND_SENDER_DOMAIN_VERIFIED",
  "PUBLIC_APP_URL",
  "SIGNUP_VERIFICATION_SECRET",
] as const;

describe("transactional email provider factory", () => {
  const original = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of managedKeys) original.set(key, process.env[key]);
    for (const key of managedKeys) delete process.env[key];
  });

  afterEach(() => {
    for (const key of managedKeys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("always selects the deterministic singleton adapter in test mode", () => {
    process.env.NODE_ENV = "test";
    process.env.PUBLIC_SIGNUP_EMAIL_PROVIDER = "resend";

    const first = resolveTransactionalEmailProvider();
    const second = resolveTransactionalEmailProvider();

    expect(first.provider).toBe("test");
    expect(second).toBe(first);
    expect(getTestEmailProvider()).toBe(first);
  });

  it.each([
    [undefined, "mailpit"],
    ["mailpit", "mailpit"],
    ["resend", "resend"],
    ["ses", "ses"],
    ["log", "log"],
    ["test", "test"],
  ])("selects %s as %s outside production", (configured, expected) => {
    process.env.NODE_ENV = "development";
    if (configured) process.env.PUBLIC_SIGNUP_EMAIL_PROVIDER = configured;

    expect(resolveTransactionalEmailProvider().provider).toBe(expected);
  });

  it("rejects unsafe or unknown production adapters", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_SIGNUP_ENABLED = "false";

    for (const provider of ["mailpit", "log", "bogus"]) {
      process.env.PUBLIC_SIGNUP_EMAIL_PROVIDER = provider;
      expect(() => resolveTransactionalEmailProvider()).toThrow(PlatformError);
    }
  });

  it("requires every Resend production invariant when public signup is enabled", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_SIGNUP_ENABLED = "true";
    process.env.PUBLIC_SIGNUP_EMAIL_PROVIDER = "resend";

    expect(() => validateResendProductionConfig()).toThrowError(
      /RESEND_API_KEY is required.*RESEND_SENDER_DOMAIN_VERIFIED=true.*PUBLIC_APP_URL.*SIGNUP_VERIFICATION_SECRET/,
    );

    process.env.TRANSACTIONAL_EMAIL_FROM = "Example Store <no-reply@example.test>";
    process.env.TRANSACTIONAL_EMAIL_REPLY_TO = "support@example.test";
    process.env.RESEND_API_KEY = "redacted-test-key";
    process.env.RESEND_SENDER_DOMAIN_VERIFIED = "true";
    process.env.PUBLIC_APP_URL = "https://example.test";
    process.env.SIGNUP_VERIFICATION_SECRET = "x".repeat(32);

    expect(() => validateResendProductionConfig()).not.toThrow();
    expect(resolveTransactionalEmailProvider().provider).toBe("resend");
  });

  it("does not apply production-only Resend checks in development", () => {
    process.env.NODE_ENV = "development";
    expect(() => validateResendProductionConfig()).not.toThrow();
  });
});
