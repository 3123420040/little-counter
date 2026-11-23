import type { TelegramConfig } from "./config";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
    from?: { id: number; first_name?: string; username?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number; first_name?: string; username?: string };
    message?: {
      message_id: number;
      text?: string;
      chat: { id: number };
    };
  };
}

export interface TelegramMessageOptions {
  parse_mode?: "HTML" | "MarkdownV2";
  reply_markup?: {
    inline_keyboard?: Array<Array<{
      text: string;
      callback_data: string;
    }>>;
    keyboard?: Array<Array<{
      text: string;
    }>>;
    resize_keyboard?: boolean;
    is_persistent?: boolean;
    input_field_placeholder?: string;
  };
}

export type TelegramPhotoOptions = TelegramMessageOptions & {
  caption?: string;
};

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

export class TelegramApi {
  private baseUrl: string;

  constructor(config: TelegramConfig) {
    this.baseUrl = `https://api.telegram.org/bot${config.botToken}`;
  }

  async getUpdates(offset: number | undefined, timeout: number): Promise<TelegramUpdate[]> {
    const params = new URLSearchParams({ timeout: String(timeout) });
    if (offset !== undefined) params.set("offset", String(offset));
    const response = await fetch(`${this.baseUrl}/getUpdates?${params.toString()}`);
    const body = await response.json() as TelegramResponse<TelegramUpdate[]>;
    if (!body.ok) throw new Error(body.description || "Telegram getUpdates failed");
    return body.result;
  }

  async sendMessage(chatId: number | string, text: string, options: TelegramMessageOptions = {}): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...options }),
    });
    const body = await response.json() as TelegramResponse<unknown>;
    if (!body.ok) throw new Error(body.description || "Telegram sendMessage failed");
  }

  async sendPhoto(chatId: number | string, photo: string, options: TelegramPhotoOptions = {}): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sendPhoto`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo, ...options }),
    });
    const body = await response.json() as TelegramResponse<unknown>;
    if (!body.ok) throw new Error(body.description || "Telegram sendPhoto failed");
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
    });
    const body = await response.json() as TelegramResponse<unknown>;
    if (!body.ok) throw new Error(body.description || "Telegram answerCallbackQuery failed");
  }

  async sendDocument(chatId: number | string, document: ArrayBuffer, filename: string, contentType = "application/pdf", caption?: string): Promise<void> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption);
    form.set("document", new Blob([document], { type: contentType }), filename);

    const response = await fetch(`${this.baseUrl}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const body = await response.json() as TelegramResponse<unknown>;
    if (!body.ok) throw new Error(body.description || "Telegram sendDocument failed");
  }
}
