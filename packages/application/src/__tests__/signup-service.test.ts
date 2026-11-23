import { describe, expect, it } from "vitest";
import {
  normalizeEmail,
  validatePassword,
  generateVerificationToken,
  hashVerificationToken,
  safeEqualHash,
  renderTemplate,
  listTemplates,
  TestEmailProvider,
} from "../platform-db";

describe("public signup helpers", () => {
  it("normalizes email for uniqueness", () => {
    expect(normalizeEmail(" USER@example.COM ")).toBe("user@example.com");
    expect(normalizeEmail("First.Last+signup@gmail.com")).toBe("firstlast@gmail.com");
  });

  it("rejects invalid email and weak password", () => {
    expect(() => normalizeEmail("not-email")).toThrow(/valid email/i);
    expect(() => validatePassword("short")).toThrow(/at least 10/i);
  });

  it("generates one-time token hashes without storing raw token", () => {
    const { token, requestId } = generateVerificationToken("sur_test");
    expect(requestId).toBe("sur_test");
    expect(token).toMatch(/^sur_test\.[a-f0-9]{64}$/);
    const hash = hashVerificationToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
    expect(safeEqualHash(token, hash)).toBe(true);
    expect(safeEqualHash(`${token}x`, hash)).toBe(false);
  });

  it("renders registered templates without secrets or empty bodies", () => {
    expect(listTemplates()).toContain("signup.email_verification");
    const rendered = renderTemplate("signup.email_verification", { verifyUrl: "http://localhost:8080/signup?token=t", appUrl: "http://localhost:8080" });
    expect(rendered.subject).toContain("Xác nhận");
    expect(rendered.text).toContain("http://localhost:8080/signup?token=t");
    expect(rendered.html).toContain("Xác nhận email");
    expect(rendered.html).not.toMatch(/RESEND|API_KEY|secret/i);
  });

  it("test adapter records deterministic messages without sending", async () => {
    const provider = new TestEmailProvider();
    const result = await provider.send({ to: "user@example.com", subject: "Hi", text: "Text", html: "<p>Text</p>", templateKey: "signup.email_verification" });
    expect(result.status).toBe("sent");
    expect(provider.findByRecipient("USER@example.com")).toHaveLength(1);
  });
});
