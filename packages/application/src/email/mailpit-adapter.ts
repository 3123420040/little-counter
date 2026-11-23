// ═══════════════════════════════════════════════════════
// Mailpit / SMTP adapter for local and test environments
// ═══════════════════════════════════════════════════════

import type { TransactionalEmailMessage, DeliveryResult, TransactionalEmailProvider } from "./provider";

export const MAILPIT_DEFAULTS = {
  host: process.env.SMTP_HOST ?? "localhost",
  port: Number(process.env.SMTP_PORT ?? 1025),
  secure: process.env.SMTP_SECURE === "true",
  user: process.env.SMTP_USER ?? "",
  pass: process.env.SMTP_PASS ?? "",
  from: process.env.SMTP_FROM ?? "Snus Ops <no-reply@snus.local>",
};

export class MailpitProvider implements TransactionalEmailProvider {
  readonly provider = "mailpit" as const;

  private readonly transport: {
    host: string;
    port: number;
    secure: boolean;
    auth?: { user: string; pass: string };
  };

  constructor(opts: Partial<typeof MAILPIT_DEFAULTS> = {}) {
    const host = opts.host ?? MAILPIT_DEFAULTS.host;
    const port = opts.port ?? MAILPIT_DEFAULTS.port;
    const secure = opts.secure ?? MAILPIT_DEFAULTS.secure;
    const user = opts.user ?? MAILPIT_DEFAULTS.user;
    const pass = opts.pass ?? MAILPIT_DEFAULTS.pass;

    this.transport = {
      host,
      port,
      secure,
      ...(user ? { auth: { user, pass } } : {}),
    };
  }

  async send(message: TransactionalEmailMessage): Promise<DeliveryResult> {
    // Mailpit is for local/test only — never called in production with real provider
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      ...this.transport,
      name: "snus-mailpit",
    });

    try {
      const info = await transporter.sendMail({
        from: MAILPIT_DEFAULTS.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: message.idempotencyKey ? { "X-Subscription-Idempotency-Key": message.idempotencyKey } : undefined,
      });

      return {
        provider: this.provider,
        status: "sent",
        messageId: info.messageId,
        responseCode: "250",
      };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      return {
        provider: this.provider,
        status: "failed",
        errorCode: "SMTP_ERROR",
        errorMessage: e.message,
      };
    }
  }
}
