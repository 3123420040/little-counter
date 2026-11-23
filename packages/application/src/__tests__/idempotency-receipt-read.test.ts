import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readScopedIdempotencyReceipt, withScopedIdempotency, withIdempotency, isClosedIdempotencyReceiptV1, CLOSED_IDEMPOTENCY_OUTCOME_V1 } from "../db/idempotency";
import type { PoolClient } from "../db/client";
const body = { items: [{ variantId: "v", quantity: 1 }], paymentFeeType: "percent", paymentFeeValue: 0 };
const headers = { "idempotency-key": "original-key" };
const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
describe("read-only retained scoped receipt", () => {
  it("reads the exact tenant/operation/key/hash without defaults, locks or writes", async () => {
    const response = { data: { orderId: "original" } }, query = vi.fn().mockResolvedValue({ rows: [{ request_hash: hash, response }] });
    const before = JSON.stringify(body);
    expect(await readScopedIdempotencyReceipt({ query } as unknown as PoolClient, headers, body, "merchant", "order.complete_sale")).toBe(response);
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toMatch(/^SELECT request_hash, response/);
    expect(sql).toContain("expires_at > now()");
    expect(sql).not.toMatch(/DELETE|INSERT|UPDATE|FOR UPDATE|advisory/i);
    expect(params).toEqual(["merchant", "order.complete_sale", "original-key"]);
    expect(JSON.stringify(body)).toBe(before);
  });
  it("returns no receipt for an absent or expired scoped key without reserving it", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    expect(await readScopedIdempotencyReceipt({ query } as unknown as PoolClient, headers, body, "merchant", "order.complete_sale")).toBeNull();
    expect(query).toHaveBeenCalledOnce();
  });
  it("refuses a changed raw body and never invokes a command", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ request_hash: hash, response: { data: "private" } }] });
    await expect(readScopedIdempotencyReceipt({ query } as unknown as PoolClient, headers, { ...body, paymentFeeValue: 10 }, "merchant", "order.complete_sale"))
      .rejects.toMatchObject({ code: "idempotency_conflict", statusCode: 409 });
    expect(query).toHaveBeenCalledOnce();
  });
  it("requires the original header key before touching the database", async () => {
    const query = vi.fn();
    await expect(readScopedIdempotencyReceipt({ query } as unknown as PoolClient, {}, body, "merchant", "order.complete_sale"))
      .rejects.toMatchObject({ code: "idempotency_key_required", statusCode: 400 });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("permanent closed request refusal", () => {
  const closed = { schemaVersion: 1, idempotencyOutcome: CLOSED_IDEMPOTENCY_OUTCOME_V1, operatorId: "operator", merchantId: "merchant", storeId: "store" };
  it.each(["legacy", "scoped", "read"])("never executes or returns a closed marker as a successful %s receipt", async family => {
    const query = vi.fn().mockImplementation(async (sql: string) => ({ rows: sql.startsWith("SELECT request_hash") ? [{ request_hash: hash, response: closed }] : [] }));
    const client = { query } as unknown as PoolClient, command = vi.fn();
    const result = family === "legacy" ? withIdempotency(client, headers, body, command)
      : family === "scoped" ? withScopedIdempotency(client, headers, body, "merchant", "payment_intent.create", command)
        : readScopedIdempotencyReceipt(client, headers, body, "merchant", "payment_intent.create");
    await expect(result).rejects.toMatchObject({ code: "idempotency_request_closed", statusCode: 409 });
    expect(command).not.toHaveBeenCalled(); expect(query.mock.calls.some(([sql]) => /^INSERT/.test(sql))).toBe(false);
  });
  it("keeps hash conflicts ahead of outcome disclosure and does not reinterpret other versions", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ request_hash: "different", response: closed }] });
    await expect(readScopedIdempotencyReceipt({ query } as unknown as PoolClient, headers, body, "merchant", "payment_intent.create"))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(isClosedIdempotencyReceiptV1(closed)).toBe(true);
    for (const response of [null, [], { data: closed }, { ...closed, schemaVersion: 2 }, { ...closed, idempotencyOutcome: "other" }]) {
      expect(isClosedIdempotencyReceiptV1(response)).toBe(false);
    }
  });
});
