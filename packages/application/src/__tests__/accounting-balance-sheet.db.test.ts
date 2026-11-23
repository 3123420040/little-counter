import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import { getBalanceSheet } from "../services/accounting-service";

const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`.slice(-10);
const merchantId = `merchant-balance-${suffix}`;
const storeAId = `store-balance-a-${suffix}`;
const storeBId = `store-balance-b-${suffix}`;
const referencePrefix = `balance-sheet-${suffix}`;
const accountCodes = {
  asset: `BSA${suffix}`,
  liability: `BSL${suffix}`,
  equity: `BSE${suffix}`,
  revenue: `BSR${suffix}`,
  expense: `BSX${suffix}`,
};

let client: PoolClient;

async function insertEntry(input: {
  name: string;
  storeId: string;
  lines: Array<{ accountCode: string; debit: number; credit: number }>;
  entryDate?: string;
  status?: "posted" | "voided";
}) {
  const status = input.status ?? "posted";
  const entry = await client.query<{ id: string }>(`
    INSERT INTO accounting.journal_entries (
      entry_number, entry_date, reference_type, reference_id, description,
      status, posted_at, created_by, merchant_id, store_id
    )
    VALUES ($1, $2::date, 'db_test_balance_sheet', $3, $4, $5,
      CASE WHEN $5 = 'posted' THEN now() ELSE NULL END, 'db_test', $6, $7)
    RETURNING id::text
  `, [
    `BS-${suffix}-${input.name}`,
    input.entryDate ?? "2026-07-28",
    `${referencePrefix}:${input.name}`,
    `Balance sheet ${input.name}`,
    status,
    merchantId,
    input.storeId,
  ]);

  for (const line of input.lines) {
    await client.query(`
      INSERT INTO accounting.journal_lines (
        journal_entry_id, account_id, debit_amount, credit_amount
      )
      SELECT $1::uuid, id, $3, $4
      FROM accounting.accounts
      WHERE code = $2
    `, [entry.rows[0].id, line.accountCode, line.debit, line.credit]);
  }
}

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await client.query(`
    INSERT INTO accounting.accounts (code, name, type) VALUES
      ($1, 'Balance asset', 'asset'),
      ($2, 'Balance liability', 'liability'),
      ($3, 'Balance equity', 'equity'),
      ($4, 'Balance revenue', 'revenue'),
      ($5, 'Balance expense', 'expense')
  `, [
    accountCodes.asset,
    accountCodes.liability,
    accountCodes.equity,
    accountCodes.revenue,
    accountCodes.expense,
  ]);
});

afterAll(async () => {
  await client?.query(`
    DELETE FROM accounting.journal_lines
    WHERE journal_entry_id IN (
      SELECT id FROM accounting.journal_entries
      WHERE reference_type = 'db_test_balance_sheet' AND reference_id LIKE $1
    )
  `, [`${referencePrefix}:%`]).catch(() => undefined);
  await client?.query(`
    DELETE FROM accounting.journal_entries
    WHERE reference_type = 'db_test_balance_sheet' AND reference_id LIKE $1
  `, [`${referencePrefix}:%`]).catch(() => undefined);
  await client?.query(
    "DELETE FROM accounting.accounts WHERE code = ANY($1::text[])",
    [Object.values(accountCodes)],
  ).catch(() => undefined);
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("balance sheet current earnings", () => {
  it("reports unclosed earnings as equity without double-counting closing entries", async () => {
    const combinedScope = { scopeKind: "report" as const, merchantId, storeIds: [storeAId, storeBId] };
    const storeAScope = { ...combinedScope, storeIds: [storeAId] };

    expect((await getBalanceSheet(combinedScope, "2026-07-27")).data).toEqual({
      totalAssets: 0,
      totalLiabilities: 0,
      ledgerEquity: 0,
      currentEarnings: 0,
      reportedEquity: 0,
      totalEquity: 0,
      balanceDelta: 0,
    });

    await insertEntry({
      name: "voided",
      storeId: storeAId,
      status: "voided",
      lines: [
        { accountCode: accountCodes.asset, debit: 900_000, credit: 0 },
        { accountCode: accountCodes.revenue, debit: 0, credit: 900_000 },
      ],
    });
    await insertEntry({
      name: "future",
      storeId: storeAId,
      entryDate: "2026-07-29",
      lines: [
        { accountCode: accountCodes.asset, debit: 800_000, credit: 0 },
        { accountCode: accountCodes.revenue, debit: 0, credit: 800_000 },
      ],
    });
    await insertEntry({
      name: "store-a-open",
      storeId: storeAId,
      lines: [
        { accountCode: accountCodes.asset, debit: 300_000, credit: 0 },
        { accountCode: accountCodes.liability, debit: 0, credit: 50_000 },
        { accountCode: accountCodes.revenue, debit: 0, credit: 250_000 },
      ],
    });
    await insertEntry({
      name: "store-b-open",
      storeId: storeBId,
      lines: [
        { accountCode: accountCodes.asset, debit: 100_000, credit: 0 },
        { accountCode: accountCodes.expense, debit: 20_000, credit: 0 },
        { accountCode: accountCodes.revenue, debit: 0, credit: 120_000 },
      ],
    });

    expect((await getBalanceSheet(storeAScope, "2026-07-28")).data).toEqual({
      totalAssets: 300_000,
      totalLiabilities: 50_000,
      ledgerEquity: 0,
      currentEarnings: 250_000,
      reportedEquity: 250_000,
      totalEquity: 250_000,
      balanceDelta: 0,
    });
    expect((await getBalanceSheet(combinedScope, "2026-07-28")).data).toMatchObject({
      totalAssets: 400_000,
      totalLiabilities: 50_000,
      currentEarnings: 350_000,
      totalEquity: 350_000,
      balanceDelta: 0,
    });

    await insertEntry({
      name: "store-a-close",
      storeId: storeAId,
      lines: [
        { accountCode: accountCodes.revenue, debit: 250_000, credit: 0 },
        { accountCode: accountCodes.equity, debit: 0, credit: 250_000 },
      ],
    });

    expect((await getBalanceSheet(storeAScope, "2026-07-28")).data).toMatchObject({
      ledgerEquity: 250_000,
      currentEarnings: 0,
      reportedEquity: 250_000,
      totalEquity: 250_000,
      balanceDelta: 0,
    });
    expect((await getBalanceSheet(combinedScope, "2026-07-28")).data).toMatchObject({
      ledgerEquity: 250_000,
      currentEarnings: 100_000,
      reportedEquity: 350_000,
      totalEquity: 350_000,
      balanceDelta: 0,
    });
  });
});
