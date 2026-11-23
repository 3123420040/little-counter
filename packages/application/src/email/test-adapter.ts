// ═══════════════════════════════════════════════════════
// Deterministic test adapter — never sends real email
// ═══════════════════════════════════════════════════════

import type { TransactionalEmailMessage, DeliveryResult, TransactionalEmailProvider } from "./provider";

export interface SentMessage extends TransactionalEmailMessage {
  sentAt: Date;
}

export class TestEmailProvider implements TransactionalEmailProvider {
  readonly provider = "test" as const;

  private readonly _sent: SentMessage[] = [];

  async send(message: TransactionalEmailMessage): Promise<DeliveryResult> {
    this._sent.push({ ...message, sentAt: new Date() });
    return {
      provider: this.provider,
      status: "sent",
      messageId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      responseCode: "200",
    };
  }

  get sent(): ReadonlyArray<SentMessage> {
    return this._sent;
  }

  clear(): void {
    this._sent.length = 0;
  }

  findByTemplate(templateKey: string): SentMessage[] {
    return this._sent.filter((m) => m.templateKey === templateKey);
  }

  findByRecipient(email: string): SentMessage[] {
    const norm = email.toLowerCase().trim();
    return this._sent.filter((m) => m.to.toLowerCase().trim() === norm);
  }
}

export class LogEmailProvider implements TransactionalEmailProvider {
  readonly provider = "log" as const;

  async send(message: TransactionalEmailMessage): Promise<DeliveryResult> {
    console.info(`[email:log] To: ${message.to} | Template: ${message.templateKey} | Subject: ${message.subject}`);
    return {
      provider: this.provider,
      status: "sent",
      messageId: `log-${Date.now()}`,
    };
  }
}
