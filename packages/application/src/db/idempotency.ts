import { createHash } from "node:crypto";
import { PlatformError } from "../errors/platform-error";
import { headerValue, type HeadersLike } from "../http/headers";
import type { PoolClient } from "./client";
import { queryOne } from "./query";

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
}

function requireIdempotency(headers: HeadersLike): string {
  const key = headerValue(headers, "idempotency-key");
  if (!key) throw new PlatformError("idempotency_key_required", "Idempotency-Key header is required", 400);
  return key;
}

function idempotencyRetentionDays(): number {
  const parsed = Number(process.env.IDEMPOTENCY_RETENTION_DAYS || 30);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 30;
}

export const CLOSED_IDEMPOTENCY_OUTCOME_V1 = "closed_without_execution";
export function isClosedIdempotencyReceiptV1(response: unknown): boolean {
  return response !== null && typeof response === "object" && !Array.isArray(response)
    && (response as Record<string, unknown>).schemaVersion === 1
    && (response as Record<string, unknown>).idempotencyOutcome === CLOSED_IDEMPOTENCY_OUTCOME_V1;
}
function assertIdempotencyReceiptOpen(response: unknown) {
  if (isClosedIdempotencyReceiptV1(response)) throw new PlatformError("idempotency_request_closed", "The original request was closed without execution; inspect its receipt before replacing it", 409);
}

/** Recovery must never delete expired records, reserve a key or execute a command. */
export async function readScopedIdempotencyReceipt<T>(client: PoolClient, headers: HeadersLike,
  body: unknown, tenantId: string, operation: string): Promise<T | null> {
  const key = requireIdempotency(headers);
  const existing = await queryOne<{ request_hash: string; response: T }>(client,
    `SELECT request_hash, response FROM app.idempotency_records
     WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3 AND expires_at > now()`,
    [tenantId, operation, key]);
  if (!existing) return null;
  if (existing.request_hash !== hashBody(body)) throw new PlatformError("idempotency_conflict", "Same key, different request body", 409);
  assertIdempotencyReceiptOpen(existing.response);
  return existing.response;
}

export async function withIdempotency<T>(
  client: PoolClient,
  headers: HeadersLike,
  body: unknown,
  fn: () => Promise<T>,
  createdStatusCode = 201,
): Promise<{ response: T; statusCode: number }> {
  const key = requireIdempotency(headers);
  const requestHash = hashBody(body);
  await client.query("DELETE FROM app.idempotency_records WHERE idempotency_key = $1 AND expires_at <= now()", [key]);
  const existing = await queryOne<{ request_hash: string; response: T }>(
    client,
    "SELECT request_hash, response FROM app.idempotency_records WHERE idempotency_key = $1 FOR UPDATE",
    [key],
  );
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new PlatformError("idempotency_conflict", "Same key, different request body", 409);
    }
    assertIdempotencyReceiptOpen(existing.response);
    return { response: existing.response, statusCode: 200 };
  }
  const response = await fn();
  await client.query(
    `
      INSERT INTO app.idempotency_records (idempotency_key, request_hash, response, expires_at)
      VALUES ($1, $2, $3::jsonb, now() + ($4::int * INTERVAL '1 day'))
    `,
    [key, requestHash, JSON.stringify(response), idempotencyRetentionDays()],
  );
  return { response, statusCode: createdStatusCode };
}

export async function withScopedIdempotency<T>(
  client: PoolClient,
  headers: HeadersLike,
  body: unknown,
  tenantId: string,
  operation: string,
  fn: () => Promise<T>,
  createdStatusCode = 201,
): Promise<{ response: T; statusCode: number }> {
  const key = requireIdempotency(headers);
  const normalizedTenantId = String(tenantId || "").trim();
  const normalizedOperation = String(operation || "").trim();
  if (!normalizedTenantId || !normalizedOperation || normalizedOperation !== normalizedOperation.toLowerCase()) {
    throw new PlatformError(
      "invalid_idempotency_scope",
      "Tenant id and a lowercase operation code are required for scoped idempotency",
      500,
    );
  }
  const requestHash = hashBody(body);
  // SELECT ... FOR UPDATE cannot lock a row that does not exist. Serialize
  // the scoped key before checking/inserting so two first-time concurrent
  // requests cannot both execute the business mutation and race on INSERT.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`${normalizedTenantId}\u001f${normalizedOperation}\u001f${key}`],
  );
  await client.query(
    "DELETE FROM app.idempotency_records WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3 AND expires_at <= now()",
    [normalizedTenantId, normalizedOperation, key],
  );
  const existing = await queryOne<{ request_hash: string; response: T }>(
    client,
    "SELECT request_hash, response FROM app.idempotency_records WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3 FOR UPDATE",
    [normalizedTenantId, normalizedOperation, key],
  );
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new PlatformError("idempotency_conflict", "Same key, different request body", 409);
    }
    assertIdempotencyReceiptOpen(existing.response);
    return { response: existing.response, statusCode: 200 };
  }
  const response = await fn();
  await client.query(
    `
      INSERT INTO app.idempotency_records (tenant_id, operation, idempotency_key, request_hash, response, expires_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, now() + ($6::int * INTERVAL '1 day'))
    `,
    [normalizedTenantId, normalizedOperation, key, requestHash, JSON.stringify(response), idempotencyRetentionDays()],
  );
  return { response, statusCode: createdStatusCode };
}
