import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { shutdownPlatformDb } from "../platform-db";
import type { EffectiveOrderPageSnapshotTransactionV2 } from "../services/effective-order-page-service";
import { PostgresOrderPageSnapshotRepositoryV1 } from "../services/postgres-order-page-snapshot-repository";
import { randomUUID } from "node:crypto";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";

let client: PoolClient;

beforeAll(async () => {
  client = await connectPlatformClient();
  await assertSafeTestDatabaseSentinel(client, requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL));
});

afterAll(async () => {
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("effective-order page payable hydration on PostgreSQL", () => {
  it.each([
    ["vnd", false, ["provider"]],
    ["usd", false, ["unknown"]],
    ["vnd", true, ["unknown"]],
  ])("bounds pending intent evidence by currency %s and future=%s", async (currency, future, expected) => {
    const id = `csv-intent-${randomUUID()}`;
    try {
      await client.query(`INSERT INTO public."order"(id,currency_code,merchant_id,store_id)
        VALUES($1,'vnd','merchant_default','store_default')`, [id]);
      await client.query(`INSERT INTO app.payment_intents
        (id,merchant_id,store_id,provider,status,amount,currency_code,order_input,reference_code,
          expires_at,completed_order_id,created_by,created_at)
        VALUES($1,'merchant_default','store_default','mock','pending',1000,$2,'{}',$1,
          now()+interval '1 hour',$1,'synthetic-csv',now()+$3::interval)`,
      [id, currency, future ? "1 hour" : "-1 second"]);
      const repository = new PostgresOrderPageSnapshotRepositoryV1(client, 10_000);
      const summaries = await repository.withRepeatableReadSnapshot(async (baseSnapshot) => {
        const snapshot = baseSnapshot as EffectiveOrderPageSnapshotTransactionV2;
        return snapshot.readPaymentSummaries({ scope: { merchantId: "merchant_default", storeIds: ["store_default"] },
          orderIds: [id], asOf: await snapshot.readAsOf() });
      });
      expect(summaries[0]!.paymentMethods).toEqual(expected);
    } finally {
      await client.query("DELETE FROM app.payment_intents WHERE id=$1", [id]);
      await client.query('DELETE FROM public."order" WHERE id=$1', [id]);
    }
  });
  it.each([
    [["bank_transfer"], "vnd", ["manual_bank"]],
    [["sepay_va"], "vnd", ["provider"]],
    [["nowpayments"], "vnd", ["provider"]],
    [["mock"], "vnd", ["provider"]],
    [["cash", "bank_transfer"], "vnd", ["cash", "manual_bank"]],
    [["voucher"], "vnd", ["unknown"]],
    [["bank_transfer"], "usd", ["unknown"]],
  ])("canonicalizes pending payment evidence %j in %s", async (methods, currency, expected) => {
    const id = `csv-pending-${randomUUID()}`;
    try {
      await client.query(`INSERT INTO public."order"(id,currency_code,merchant_id,store_id)
        VALUES($1,'vnd','merchant_default','store_default')`, [id]);
      for (const method of methods) await client.query(`INSERT INTO app.payment_entries
        (order_id,merchant_id,store_id,direction,method,amount,currency_code,status,created_by,created_at)
        VALUES($1,'merchant_default','store_default','charge',$2,1000,$3,'pending','synthetic-csv',now()-interval '1 second')`, [id, method, currency]);
      const repository = new PostgresOrderPageSnapshotRepositoryV1(client, 10_000);
      const summaries = await repository.withRepeatableReadSnapshot(async (baseSnapshot) => {
        const snapshot = baseSnapshot as EffectiveOrderPageSnapshotTransactionV2;
        return snapshot.readPaymentSummaries({ scope: { merchantId: "merchant_default", storeIds: ["store_default"] },
          orderIds: [id], asOf: await snapshot.readAsOf() });
      });
      expect(summaries[0]!.paymentMethods).toEqual(expected);
    } finally {
      await client.query("DELETE FROM app.payment_entries WHERE order_id=$1", [id]);
      await client.query('DELETE FROM public."order" WHERE id=$1', [id]);
    }
  });
  it("returns the exact as-of customer refund payable instead of inventing zero", async () => {
    const candidate = await client.query<{
      order_id: string;
      merchant_id: string;
      store_id: string;
    }>(`
      SELECT id AS order_id, merchant_id, store_id
      FROM public."order"
      WHERE deleted_at IS NULL
        AND merchant_id IS NOT NULL
        AND store_id IS NOT NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);
    const selected = candidate.rows[0];
    if (!selected) throw new Error("DB fixture requires at least one scoped order");

    const repository = new PostgresOrderPageSnapshotRepositoryV1(client, 10_000);
    const result = await repository.withRepeatableReadSnapshot(async (baseSnapshot) => {
      const snapshot = baseSnapshot as EffectiveOrderPageSnapshotTransactionV2;
      const asOf = await snapshot.readAsOf();
      const summaries = await snapshot.readPaymentSummaries({
        scope: {
          merchantId: selected.merchant_id,
          storeIds: [selected.store_id],
        },
        orderIds: [selected.order_id],
        asOf,
      });
      return { asOf, summary: summaries[0] };
    });
    if (!result.summary) throw new Error("payable hydration returned no order summary");

    const expected = await client.query<{ amount_minor: string }>(`
      SELECT COALESCE(SUM(
        CASE event_kind
          WHEN 'open' THEN amount_minor
          WHEN 'clear' THEN -amount_minor
        END
      ), 0)::text AS amount_minor
      FROM app.customer_refund_payable_events
      WHERE merchant_id = $1
        AND store_id = $2
        AND order_id = $3
        AND source_occurred_at <= $4::timestamptz
    `, [selected.merchant_id, selected.store_id, selected.order_id, result.asOf]);

    expect(result.summary.customerRefundPayableMinor)
      .toBe(Number(expected.rows[0]?.amount_minor || "0"));
    expect(Number.isSafeInteger(result.summary.customerRefundPayableMinor)).toBe(true);
    expect(result.summary.customerRefundPayableMinor).toBeGreaterThanOrEqual(0);
  });
});
