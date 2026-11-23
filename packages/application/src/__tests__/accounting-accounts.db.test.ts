import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import { listAccounts } from "../services/accounting-service";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const accountCodes = {
  asset: `DBA${runId.replace(/[^a-zA-Z0-9]/g, "").slice(-10)}`,
  expense: `DBE${runId.replace(/[^a-zA-Z0-9]/g, "").slice(-10)}`,
  revenue: `DBR${runId.replace(/[^a-zA-Z0-9]/g, "").slice(-10)}`,
  liability: `DBL${runId.replace(/[^a-zA-Z0-9]/g, "").slice(-10)}`,
};

let client: PoolClient;

type AccountRow = {
  code: string;
  type: string;
  balance: string | number;
};

const scopes = {
  merchantAAll: {
    scopeKind: "report" as const,
    merchantId: `merchant-a-${runId}`,
    storeIds: [`store-a1-${runId}`, `store-a2-${runId}`],
  },
  merchantAStore1: {
    scopeKind: "report" as const,
    merchantId: `merchant-a-${runId}`,
    storeIds: [`store-a1-${runId}`],
  },
  merchantB: {
    scopeKind: "report" as const,
    merchantId: `merchant-b-${runId}`,
    storeIds: [`store-b1-${runId}`],
  },
};

function balanceFor(accounts: AccountRow[], code: string) {
  return Number(accounts.find((account) => account.code === code)?.balance || 0);
}

async function insertJournalEntry(input: {
  suffix: string;
  status: "draft" | "posted" | "voided";
  merchantId: string | null;
  storeId: string | null;
  amountScale: number;
}) {
  const entry = await client.query<{ id: string }>(`
    INSERT INTO accounting.journal_entries (
      entry_number, entry_date, reference_type, reference_id, description,
      status, posted_at, created_by, merchant_id, store_id
    )
    VALUES (
      $1, current_date, 'db_test', $2, $3, $4,
      CASE WHEN $4 = 'posted' THEN now() ELSE NULL END,
      'db_test', $5, $6
    )
    RETURNING id::text
  `, [
    `DB-${runId}-${input.suffix}`,
    `${runId}:${input.suffix}`,
    `DB account balance ${input.suffix}`,
    input.status,
    input.merchantId,
    input.storeId,
  ]);

  const lines = [
    { accountCode: accountCodes.asset, debitAmount: 123000 * input.amountScale, creditAmount: 0 },
    { accountCode: accountCodes.expense, debitAmount: 20000 * input.amountScale, creditAmount: 0 },
    { accountCode: accountCodes.revenue, debitAmount: 0, creditAmount: 123000 * input.amountScale },
    { accountCode: accountCodes.liability, debitAmount: 0, creditAmount: 20000 * input.amountScale },
  ];

  for (const line of lines) {
    const account = await queryOne<{ id: string }>(
      client,
      "SELECT id::text FROM accounting.accounts WHERE code = $1",
      [line.accountCode],
    );
    expect(account).toBeTruthy();
    await client.query(`
      INSERT INTO accounting.journal_lines (
        journal_entry_id, account_id, debit_amount, credit_amount
      )
      VALUES ($1::uuid, $2::uuid, $3, $4)
    `, [entry.rows[0].id, account?.id, line.debitAmount, line.creditAmount]);
  }
}

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await client.query(`
    INSERT INTO accounting.accounts (code, name, type) VALUES
      ($1, 'DB test asset account', 'asset'),
      ($2, 'DB test expense account', 'expense'),
      ($3, 'DB test revenue account', 'revenue'),
      ($4, 'DB test liability account', 'liability')
    ON CONFLICT (code) DO UPDATE
    SET name = EXCLUDED.name,
        type = EXCLUDED.type,
        is_active = true
  `, [accountCodes.asset, accountCodes.expense, accountCodes.revenue, accountCodes.liability]);
});

afterAll(async () => {
  await client?.query(
    `DELETE FROM accounting.journal_lines
     WHERE journal_entry_id IN (
       SELECT id FROM accounting.journal_entries
       WHERE reference_type = 'db_test' AND reference_id LIKE $1
     )`,
    [`${runId}:%`],
  ).catch(() => undefined);
  await client?.query(
    "DELETE FROM accounting.journal_entries WHERE reference_type = 'db_test' AND reference_id LIKE $1",
    [`${runId}:%`],
  ).catch(() => undefined);
  await client?.query(
    "DELETE FROM accounting.accounts WHERE code = ANY($1::text[])",
    [[accountCodes.asset, accountCodes.expense, accountCodes.revenue, accountCodes.liability]],
  ).catch(() => undefined);
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("accounting account balances", () => {
  it("isolates shared account codes by merchant and authorized store scope", async () => {
    await insertJournalEntry({
      suffix: "merchant-a-store-1-posted",
      status: "posted",
      merchantId: scopes.merchantAAll.merchantId,
      storeId: scopes.merchantAAll.storeIds[0],
      amountScale: 1,
    });
    await insertJournalEntry({
      suffix: "merchant-a-store-2-posted",
      status: "posted",
      merchantId: scopes.merchantAAll.merchantId,
      storeId: scopes.merchantAAll.storeIds[1],
      amountScale: 2,
    });
    await insertJournalEntry({
      suffix: "merchant-a-unauthorized-store-posted",
      status: "posted",
      merchantId: scopes.merchantAAll.merchantId,
      storeId: `store-a3-${runId}`,
      amountScale: 32,
    });
    await insertJournalEntry({
      suffix: "merchant-b-store-1-posted",
      status: "posted",
      merchantId: scopes.merchantB.merchantId,
      storeId: scopes.merchantB.storeIds[0],
      amountScale: 4,
    });
    await insertJournalEntry({
      suffix: "merchant-a-shared-posted",
      status: "posted",
      merchantId: scopes.merchantAAll.merchantId,
      storeId: null,
      amountScale: 8,
    });
    await insertJournalEntry({
      suffix: "legacy-unowned-posted",
      status: "posted",
      merchantId: null,
      storeId: null,
      amountScale: 16,
    });
    await insertJournalEntry({
      suffix: "merchant-a-draft",
      status: "draft",
      merchantId: scopes.merchantAAll.merchantId,
      storeId: scopes.merchantAAll.storeIds[0],
      amountScale: 64,
    });
    await insertJournalEntry({
      suffix: "merchant-a-voided",
      status: "voided",
      merchantId: scopes.merchantAAll.merchantId,
      storeId: scopes.merchantAAll.storeIds[0],
      amountScale: 128,
    });

    const merchantAAll = (await listAccounts(scopes.merchantAAll)).data as AccountRow[];
    const merchantAStore1 = (await listAccounts(scopes.merchantAStore1)).data as AccountRow[];
    const merchantB = (await listAccounts(scopes.merchantB)).data as AccountRow[];

    expect(balanceFor(merchantAAll, accountCodes.asset)).toBe(123000 * 11);
    expect(balanceFor(merchantAAll, accountCodes.expense)).toBe(20000 * 11);
    expect(balanceFor(merchantAAll, accountCodes.revenue)).toBe(123000 * 11);
    expect(balanceFor(merchantAAll, accountCodes.liability)).toBe(20000 * 11);
    expect(balanceFor(merchantAStore1, accountCodes.asset)).toBe(123000 * 9);
    expect(balanceFor(merchantB, accountCodes.asset)).toBe(123000 * 4);
    expect(merchantAAll.find((account) => account.code === accountCodes.asset)).toMatchObject({
      type: "asset",
    });
  });
});
