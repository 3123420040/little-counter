import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listTemplates,
  renderTemplate,
  type EmailTemplateKey,
} from "../email/templates";

const context = {
  verifyUrl: "https://app.example.test/verify?token=redacted",
  appUrl: "https://app.example.test",
  merchantName: "Demo Merchant",
  storeName: "Main Store",
  loginUrl: "https://app.example.test/login",
  daysLeft: 3,
  packageKey: "plus",
  renewUrl: "https://app.example.test/renew",
  periodEnd: "2026-09-30",
  graceEndsAt: "2026-10-07",
  renewalDate: "2027-09-30",
  actionUrl: "https://app.example.test/settings/subscription",
};

describe("transactional email template registry", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("lists every supported template exactly once", () => {
    const templates = listTemplates();
    expect(templates).toHaveLength(9);
    expect(new Set(templates).size).toBe(templates.length);
    expect(templates).toEqual(expect.arrayContaining([
      "signup.email_verification",
      "signup.verification_resent",
      "signup.provisioned",
      "subscription.renewal_reminder",
      "subscription.entered_grace",
      "subscription.grace_ending",
      "subscription.expired",
      "subscription.renewal_applied",
      "subscription.upgrade_applied",
    ]));
  });

  it.each(listTemplates())("renders complete text and HTML for %s", (templateKey) => {
    vi.stubEnv("TRANSACTIONAL_EMAIL_REPLY_TO", "support@example.test");
    const rendered = renderTemplate(templateKey, context);
    expect(rendered.subject).toContain("Little Counter");
    expect(rendered.text).toContain("support@example.test");
    expect(rendered.html).toMatch(/^<!DOCTYPE html>/);
    expect(rendered.html).toContain('lang="vi"');
    expect(rendered.html).toContain("support@example.test");
    expect(rendered.html).not.toContain("undefined");
  });

  it.each(listTemplates())("uses explicit harmless fallbacks for missing optional context in %s", (templateKey) => {
    vi.stubEnv("TRANSACTIONAL_EMAIL_REPLY_TO", undefined);
    const rendered = renderTemplate(templateKey, {});
    expect(rendered.html).not.toContain("mailto:");
    expect(rendered.subject).toBeTruthy();
    expect(rendered.text).not.toContain("undefined");
    expect(rendered.html).not.toContain("undefined");
  });

  it("rejects an unknown template key", () => {
    expect(() => renderTemplate("unknown.template" as EmailTemplateKey, {}))
      .toThrow("Unknown email template: unknown.template");
  });
});
