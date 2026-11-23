// ═══════════════════════════════════════════════════════
// Transactional Email Provider Interface
// ═══════════════════════════════════════════════════════

export type EmailProvider = "mailpit" | "resend" | "ses" | "log" | "test";

export interface TransactionalEmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  templateKey: string;
  requestId?: string;
  /** Stable per logical delivery; adapters may forward it to provider dedupe. */
  idempotencyKey?: string;
}

export interface DeliveryResult {
  provider: EmailProvider;
  status: "sent" | "failed" | "deferred";
  messageId?: string;
  errorCode?: string;
  errorMessage?: string;
  responseCode?: string;
}

export interface TransactionalEmailProvider {
  readonly provider: EmailProvider;
  send(message: TransactionalEmailMessage): Promise<DeliveryResult>;
}
