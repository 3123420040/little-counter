import { randomUUID } from "node:crypto";
import type { ApplicationError } from "../index";

/**
 * @deprecated Test-only in-memory idempotency helper.
 * Production mutations use DB-backed idempotency records in app.idempotency_records.
 */
interface IdempotencyRecord {
  key: string;
  bodyHash: string;
  response: unknown;
  createdAt: Date;
}

const records = new Map<string, IdempotencyRecord>();

/**
 * @deprecated Test-only in-memory idempotency helper.
 * Use the DB-backed idempotency repository/service in production code.
 */
export function checkIdempotency(key: string, body: unknown): { cached?: unknown; conflict?: boolean } {
  if (!key) return {};

  const bodyHash = hashBody(body);
  const existing = records.get(key);

  if (existing) {
    if (existing.bodyHash === bodyHash) {
      return { cached: existing.response };
    }
    return { conflict: true };
  }

  records.set(key, { key, bodyHash, response: null, createdAt: new Date() });
  return {};
}

/**
 * @deprecated Test-only in-memory idempotency helper.
 */
export function storeIdempotencyResponse(key: string, body: unknown, response: unknown): void {
  const bodyHash = hashBody(body);
  const existing = records.get(key);
  if (existing) {
    existing.response = response;
  } else {
    records.set(key, { key, bodyHash, response, createdAt: new Date() });
  }
}

/**
 * @deprecated Test-only in-memory idempotency helper.
 */
export function requireIdempotencyKey(handler: Function): Function {
  return async (request: { headers: Record<string, string>; body: unknown }, ...args: unknown[]) => {
    const key = request.headers?.["idempotency-key"] || request.headers?.["Idempotency-Key"];
    if (!key) {
      throw Object.assign(new Error("Missing Idempotency-Key header"), { code: "idempotency_key_required", statusCode: 400 });
    }

    const check = checkIdempotency(key, request.body);
    if (check.cached) return check.cached;
    if (check.conflict) {
      throw Object.assign(new Error("Idempotency conflict: same key, different body"), { code: "idempotency_conflict", statusCode: 409 });
    }

    const result = await (handler as (...args: unknown[]) => unknown)(request, ...args);
    storeIdempotencyResponse(key, request.body, result);
    return result;
  };
}

function hashBody(body: unknown): string {
  return JSON.stringify(body);
}

// Cleanup old records every hour
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of records) {
    if (now - record.createdAt.getTime() > 24 * 60 * 60 * 1000) {
      records.delete(key);
    }
  }
}, 3600_000);
