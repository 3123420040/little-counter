import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { shutdownPlatformDb } from "../platform-db";

let client: PoolClient;

beforeAll(async () => {
  client = await connectPlatformClient();
  await client.query("BEGIN TRANSACTION READ ONLY");
});

afterAll(async () => {
  if (client) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
  await shutdownPlatformDb().catch(() => undefined);
});

describe("TEST-02 PostgreSQL payment/accounting semantics", () => {
  it("deduplicates by stable identity, filters by event time, and never sums currencies", async () => {
    const result = await client.query<{
      currency_code: string;
      gross_minor: string;
      negative_minor: string;
      net_minor: string;
    }>(`
      WITH source (
        event_id, idempotency_key, kind, status, currency_code, amount_minor,
        event_at, order_updated_at
      ) AS (
        VALUES
          ('evt-cod', 'cod:1', 'charge', 'posted', 'VND', 2000::bigint,
            '2026-08-04T08:00:00Z'::timestamptz, '2026-08-10T00:00:00Z'::timestamptz),
          ('evt-cod-retry', 'cod:1', 'charge', 'posted', 'VND', 2000::bigint,
            '2026-08-04T08:00:00Z'::timestamptz, '2026-08-11T00:00:00Z'::timestamptz),
          ('evt-provider', 'provider:1', 'charge', 'pending', 'VND', 9999::bigint,
            '2026-08-04T09:00:00Z'::timestamptz, '2026-08-04T09:00:00Z'::timestamptz),
          ('evt-refund', 'refund:1', 'refund', 'posted', 'VND', 100::bigint,
            '2026-08-04T10:00:00Z'::timestamptz, '2026-08-12T00:00:00Z'::timestamptz),
          ('evt-usd', 'usd:1', 'charge', 'posted', 'USD', 1500::bigint,
            '2026-08-04T11:00:00Z'::timestamptz, '2026-07-01T00:00:00Z'::timestamptz),
          ('evt-outside', 'outside:1', 'charge', 'posted', 'VND', 777777::bigint,
            '2026-08-03T23:59:59.999Z'::timestamptz, '2026-08-04T12:00:00Z'::timestamptz)
      ),
      exact_once AS (
        SELECT DISTINCT ON (idempotency_key) *
        FROM source
        WHERE status = 'posted'
          AND event_at >= '2026-08-04T00:00:00Z'::timestamptz
          AND event_at < '2026-08-05T00:00:00Z'::timestamptz
        ORDER BY idempotency_key, event_at, event_id
      )
      SELECT
        currency_code,
        sum(amount_minor) FILTER (WHERE kind = 'charge')::text AS gross_minor,
        coalesce(sum(amount_minor) FILTER (WHERE kind IN ('refund', 'reversal', 'chargeback')), 0)::text
          AS negative_minor,
        (
          coalesce(sum(amount_minor) FILTER (WHERE kind = 'charge'), 0)
          - coalesce(sum(amount_minor) FILTER (WHERE kind IN ('refund', 'reversal', 'chargeback')), 0)
        )::text AS net_minor
      FROM exact_once
      GROUP BY currency_code
      ORDER BY currency_code
    `);

    expect(result.rows).toEqual([
      { currency_code: "USD", gross_minor: "1500", negative_minor: "0", net_minor: "1500" },
      { currency_code: "VND", gross_minor: "2000", negative_minor: "100", net_minor: "1900" },
    ]);
  });

  it("proves balanced journals per currency instead of across currencies", async () => {
    const result = await client.query<{ currency_code: string; imbalance_minor: string }>(`
      WITH journal_lines (currency_code, direction, amount_minor) AS (
        VALUES
          ('VND', 'debit', 11000::bigint),
          ('VND', 'credit', 11000::bigint),
          ('USD', 'debit', 1500::bigint),
          ('USD', 'credit', 1500::bigint)
      )
      SELECT
        currency_code,
        sum(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END)::text
          AS imbalance_minor
      FROM journal_lines
      GROUP BY currency_code
      ORDER BY currency_code
    `);

    expect(result.rows).toEqual([
      { currency_code: "USD", imbalance_minor: "0" },
      { currency_code: "VND", imbalance_minor: "0" },
    ]);
  });
});
