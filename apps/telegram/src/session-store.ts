import { BackendClient, type BotSessionResponse } from "./backend-client";

function confirmationTtlSeconds(): number {
  const parsed = Number(process.env.TELEGRAM_CONFIRMATION_TTL_SECONDS || "900");
  return Number.isFinite(parsed) && parsed >= 60 ? Math.round(parsed) : 900;
}

function expiresAtFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export class SessionStore {
  constructor(private backend: BackendClient) {}

  async getRecord(telegramUserId: string): Promise<BotSessionResponse["data"]> {
    const response = await this.backend.getSession(telegramUserId);
    return response.data;
  }

  async get(telegramUserId: string): Promise<Record<string, unknown>> {
    const record = await this.getRecord(telegramUserId);
    return record.state;
  }

  async set(telegramUserId: string, state: Record<string, unknown>, idempotencyKey?: string, expiresAt?: string | null): Promise<Record<string, unknown>> {
    const response = await this.backend.updateSession(telegramUserId, state, idempotencyKey, expiresAt);
    return response.data.state;
  }

  async setPending(telegramUserId: string, state: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const expiresAt = expiresAtFromNow(confirmationTtlSeconds());
    const response = await this.backend.updateSession(telegramUserId, {
      ...state,
      expiresAt,
    }, idempotencyKey, expiresAt);
    return response.data.state;
  }

  async clear(telegramUserId: string): Promise<void> {
    await this.backend.clearSession(telegramUserId);
  }
}
