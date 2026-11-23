import { transactionalEmailIdentity } from "./identity";
import { PlatformError } from "../errors/platform-error";
import { MailpitProvider } from "./mailpit-adapter";
import { ResendProvider, SesStubProvider } from "./resend-adapter";
import { LogEmailProvider, TestEmailProvider } from "./test-adapter";
import type { TransactionalEmailProvider } from "./provider";

export type EmailProviderName = "mailpit" | "resend" | "ses" | "log" | "test";

let testProvider: TestEmailProvider | null = null;

export function resolveTransactionalEmailProvider(): TransactionalEmailProvider {
  const provider = (process.env.PUBLIC_SIGNUP_EMAIL_PROVIDER || (process.env.NODE_ENV === "production" ? "resend" : "mailpit")) as EmailProviderName;

  if (process.env.NODE_ENV === "test") {
    if (!testProvider) testProvider = new TestEmailProvider();
    return testProvider;
  }

  switch (provider) {
    case "mailpit":
      if (process.env.NODE_ENV === "production") {
        throw new PlatformError("config_error", "Mailpit cannot be used in production", 500);
      }
      return new MailpitProvider();
    case "resend":
      if (process.env.PUBLIC_SIGNUP_ENABLED === "true") validateResendProductionConfig();
      return new ResendProvider();
    case "ses":
      return new SesStubProvider();
    case "log":
      if (process.env.NODE_ENV === "production") {
        throw new PlatformError("config_error", "Log email provider cannot be used in production", 500);
      }
      return new LogEmailProvider();
    case "test":
      if (!testProvider) testProvider = new TestEmailProvider();
      return testProvider;
    default:
      throw new PlatformError("config_error", `Unsupported email provider: ${provider}`, 500);
  }
}

export function validateResendProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  const errors: string[] = [];
  const { from, replyTo } = transactionalEmailIdentity();
  if (!from) errors.push("TRANSACTIONAL_EMAIL_FROM is required");
  if (!replyTo) errors.push("A valid TRANSACTIONAL_EMAIL_REPLY_TO is required");
  if (!process.env.RESEND_API_KEY) errors.push("RESEND_API_KEY is required");
  if (process.env.RESEND_SENDER_DOMAIN_VERIFIED !== "true") errors.push("RESEND_SENDER_DOMAIN_VERIFIED=true is required");
  if (!process.env.PUBLIC_APP_URL) errors.push("PUBLIC_APP_URL is required");
  if (!process.env.SIGNUP_VERIFICATION_SECRET || process.env.SIGNUP_VERIFICATION_SECRET.length < 32) {
    errors.push("SIGNUP_VERIFICATION_SECRET must be at least 32 characters");
  }
  if (process.env.PUBLIC_SIGNUP_EMAIL_PROVIDER !== "resend") errors.push("PUBLIC_SIGNUP_EMAIL_PROVIDER=resend is required");
  if (errors.length) throw new PlatformError("config_error", errors.join("; "), 500);
}

export function getTestEmailProvider(): TestEmailProvider {
  if (!testProvider) testProvider = new TestEmailProvider();
  return testProvider;
}
