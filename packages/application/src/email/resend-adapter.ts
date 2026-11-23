// ═══════════════════════════════════════════════════════
// Resend HTTP API adapter for initial production provider
// API: https://api.resend.com/emails
// ═══════════════════════════════════════════════════════

import type { TransactionalEmailMessage, DeliveryResult, TransactionalEmailProvider } from "./provider";

import { transactionalEmailIdentity } from "./identity";

export const { from: RESEND_FROM, replyTo: RESEND_REPLY_TO } = transactionalEmailIdentity();
export const RESEND_API_BASE = process.env.RESEND_API_BASE ?? "https://api.resend.com";
/**
 * Non-secret product identifier sent with every request. Resend's contract
 * recommends a descriptive User-Agent and this carries no credential.
 */
export const RESEND_USER_AGENT = process.env.RESEND_USER_AGENT ?? "medusa-snus-pos/1.1.2 (+transactional-email)";

export class ResendProvider implements TransactionalEmailProvider {
  readonly provider = "resend" as const;

  private readonly apiKey: string;
  private readonly apiBase: string;

  constructor(apiKey?: string, apiBase?: string) {
    this.apiKey = apiKey ?? process.env.RESEND_API_KEY ?? "";
    this.apiBase = apiBase ?? RESEND_API_BASE;
  }

  async send(message: TransactionalEmailMessage): Promise<DeliveryResult> {
    if (!this.apiKey) {
      return {
        provider: this.provider,
        status: "failed",
        errorCode: "RESEND_NO_API_KEY",
        errorMessage: "RESEND_API_KEY is not configured",
      };
    }

    const { from, replyTo } = transactionalEmailIdentity();
    if (!from || !replyTo) {
      return {
        provider: this.provider,
        status: "failed",
        errorCode: "RESEND_NO_SENDER",
        errorMessage: "Set TRANSACTIONAL_EMAIL_FROM and a valid TRANSACTIONAL_EMAIL_REPLY_TO",
      };
    }

    const body = {
      from,
      reply_to: replyTo,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    };

    try {
      const resp = await fetch(`${this.apiBase}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": RESEND_USER_AGENT,
          ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
      });

      const responseCode = String(resp.status);

      if (resp.ok) {
        const data = (await resp.json()) as { id?: string };
        return {
          provider: this.provider,
          status: "sent",
          messageId: data.id,
          responseCode,
        };
      }

      const errBody = await resp.json().catch(() => ({}));
      const errName = (errBody as { name?: string }).name ?? "RESEND_ERROR";
      const errMsg = (errBody as { message?: string }).message ?? "Unknown Resend error";

      return {
        provider: this.provider,
        status: resp.status >= 500 ? "deferred" : "failed",
        errorCode: errName,
        errorMessage: errMsg,
        responseCode,
      };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      return {
        provider: this.provider,
        status: "deferred",
        errorCode: "RESEND_NETWORK_ERROR",
        errorMessage: e.message,
      };
    }
  }
}

export class SesStubProvider implements TransactionalEmailProvider {
  readonly provider = "ses" as const;

  async send(message: TransactionalEmailMessage): Promise<DeliveryResult> {
    return {
      provider: this.provider,
      status: "failed",
      errorCode: "SES_NOT_IMPLEMENTED",
      errorMessage: `Amazon SES stub (not live). To: ${message.to}, Subject: ${message.subject}`,
    };
  }
}
