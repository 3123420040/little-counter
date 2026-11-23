import { withScopedIdempotency } from "../db/idempotency";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import type { HeadersLike } from "../http/headers";
import { recordAuditEntry } from "../repositories/audit-repository";
import { emitExactOutbox } from "../repositories/outbox-repository";
import { ReportScopeSchema, type OperatingScope, type ReportScope } from "@medusa-snus/contracts";
import type { OperatorContext } from "./auth-service";
import { assertOperatingMutationTarget } from "./mutation-scope-service";
import { buildExactJournalPostedEvent } from "./exact-outbox-event-builders";

// Stable operation codes used with withScopedIdempotency.
export const ACCT_OPS = {
  createJournalEntry: "accounting.create_journal_entry",
  updateJournalEntry: "accounting.update_journal_entry",
  postJournalEntry: "accounting.post_journal_entry",
  voidJournalEntry: "accounting.void_journal_entry",
} as const;

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedClient(fn);
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedTransaction(fn);
}

export async function insertJournalEntryForClient(client: PoolClient, input: {
  entryDate: string;
  referenceType?: string;
  referenceId?: string;
  description: string;
  status?: "draft" | "posted" | "voided";
  createdBy: string;
  merchantId?: string | null;
  storeId?: string | null;
  lines: Array<{ accountCode: string; debitAmount: number; creditAmount: number; description?: string }>;
}) {
  const debits = input.lines.reduce((sum, line) => sum + Number(line.debitAmount || 0), 0);
  const credits = input.lines.reduce((sum, line) => sum + Number(line.creditAmount || 0), 0);
  if (input.lines.length < 2 || debits <= 0 || debits !== credits) {
    throw new PlatformError("validation_error", "Balanced journal entry with at least two lines is required", 400);
  }
  // Serialize daily sequence allocation inside the caller's transaction.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`journal-entry:${input.entryDate}`]);
  // Use MAX of the existing daily sequence suffix (not COUNT) so that deleted
  // or voided entries do not cause the next allocated number to collide with a
  // still-existing higher entry_number. entry_number is formatted as
  // JE-YYYYMMDD-NNN; split on '-' and take the numeric tail.
  const seq = await client.query(
    "SELECT COALESCE(MAX((string_to_array(entry_number, '-'))[3]::int), 0) + 1 AS next FROM accounting.journal_entries WHERE entry_date = $1",
    [input.entryDate],
  );
  const entryNumber = `JE-${input.entryDate.replace(/-/g, "")}-${String(seq.rows[0].next).padStart(3, "0")}`;
  const entry = await client.query(`
    INSERT INTO accounting.journal_entries (
      entry_number, entry_date, reference_type, reference_id, description, status, posted_at, created_by,
      merchant_id, store_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'posted' THEN now() ELSE NULL END, $7, $8, $9)
    RETURNING *
  `, [
    entryNumber,
    input.entryDate,
    input.referenceType || null,
    input.referenceId || null,
    input.description,
    input.status || "draft",
    input.createdBy,
    input.merchantId || null,
    input.storeId || null,
  ]);
  for (const line of input.lines) {
    const account = await queryOne<{ id: string }>(client, "SELECT id::text FROM accounting.accounts WHERE code = $1 AND is_active = true", [line.accountCode]);
    if (!account) throw new PlatformError("validation_error", `Account ${line.accountCode} not found`, 400);
    await client.query(`
      INSERT INTO accounting.journal_lines (journal_entry_id, account_id, description, debit_amount, credit_amount)
      VALUES ($1, $2, $3, $4, $5)
    `, [entry.rows[0].id, account.id, line.description || null, line.debitAmount || 0, line.creditAmount || 0]);
  }
  return entry.rows[0];
}

async function replaceJournalLines(
  client: PoolClient,
  entryId: string,
  lines: Array<{ accountCode: string; debitAmount: number; creditAmount: number; description?: string }>,
) {
  const debits = lines.reduce((sum, line) => sum + Number(line.debitAmount || 0), 0);
  const credits = lines.reduce((sum, line) => sum + Number(line.creditAmount || 0), 0);
  if (lines.length < 2 || debits <= 0 || debits !== credits) {
    throw new PlatformError("validation_error", "Balanced journal entry with at least two lines is required", 400);
  }
  await client.query("DELETE FROM accounting.journal_lines WHERE journal_entry_id = $1", [entryId]);
  for (const line of lines) {
    const account = await queryOne<{ id: string }>(client, "SELECT id::text FROM accounting.accounts WHERE code = $1 AND is_active = true", [line.accountCode]);
    if (!account) throw new PlatformError("validation_error", `Account ${line.accountCode} not found`, 400);
    await client.query(`
      INSERT INTO accounting.journal_lines (journal_entry_id, account_id, description, debit_amount, credit_amount)
      VALUES ($1, $2, $3, $4, $5)
    `, [entryId, account.id, line.description || null, line.debitAmount || 0, line.creditAmount || 0]);
  }
}

function normalizedAccountReportScope(scope: ReportScope): ReportScope {
  const parsed = ReportScopeSchema.safeParse(scope);
  if (!parsed.success || new Set(parsed.data.storeIds).size !== parsed.data.storeIds.length) {
    throw new PlatformError(
      "scope_required",
      "listAccounts requires one merchant and a unique authorized store set",
      409,
    );
  }
  return {
    ...parsed.data,
    storeIds: [...parsed.data.storeIds].sort(),
  };
}

export async function listAccountsForClient(client: PoolClient, scope: ReportScope) {
  const normalizedScope = normalizedAccountReportScope(scope);
  const result = await client.query(`
      WITH scoped_lines AS (
        SELECT jl.account_id, jl.debit_amount, jl.credit_amount
        FROM accounting.journal_lines jl
        JOIN accounting.journal_entries je ON je.id = jl.journal_entry_id
        WHERE je.status = 'posted'
          AND je.merchant_id = $1
          AND (je.store_id IS NULL OR je.store_id = ANY($2::text[]))
      )
      SELECT
        a.code,
        a.name,
        a.type,
        COALESCE(SUM(
          CASE
            WHEN a.type IN ('asset', 'expense') THEN scoped.debit_amount - scoped.credit_amount
            ELSE scoped.credit_amount - scoped.debit_amount
          END
        ), 0)::numeric AS balance
      FROM accounting.accounts a
      LEFT JOIN scoped_lines scoped ON scoped.account_id = a.id
      WHERE a.is_active = true
      GROUP BY a.code, a.name, a.type
      ORDER BY a.code
    `, [normalizedScope.merchantId, normalizedScope.storeIds]);
  return result.rows;
}

export async function listAccounts(scope: ReportScope) {
  return withClient(async (client) => {
    return { data: await listAccountsForClient(client, scope) };
  });
}

async function listJournalEntriesForClient(
  client: PoolClient,
  scope: ReportScope,
  query?: { dateFrom?: string; dateTo?: string; status?: string; entryId?: string },
) {
  if (!scope?.merchantId) {
    throw new PlatformError("scope_required", "listJournalEntries requires tenantId in ReportScope", 409);
  }
  const storeFilter = scope.storeIds && scope.storeIds.length > 0
    ? ` AND (je.store_id IS NULL OR je.store_id = ANY($6::text[]))`
    : "";
  const params: unknown[] = [
    query?.dateFrom || null,
    query?.dateTo || null,
    query?.status || null,
    scope.merchantId,
    query?.entryId || null,
  ];
  if (scope.storeIds && scope.storeIds.length > 0) params.push(scope.storeIds);
  const result = await client.query(`
      SELECT
        je.id::text,
        je.entry_number AS "entryNumber",
        je.entry_date::text AS "entryDate",
        je.reference_type AS "referenceType",
        je.reference_id AS "referenceId",
        je.description,
        je.status,
        je.posted_at AS "postedAt",
        je.created_by AS "createdBy",
        COALESCE(json_agg(json_build_object(
          'accountCode', a.code,
          'accountName', a.name,
          'accountType', a.type,
          'debitAmount', jl.debit_amount,
          'creditAmount', jl.credit_amount,
          'description', jl.description
        ) ORDER BY jl.id) FILTER (WHERE jl.id IS NOT NULL), '[]') AS lines
      FROM accounting.journal_entries je
      LEFT JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
      LEFT JOIN accounting.accounts a ON a.id = jl.account_id
      WHERE ($1::date IS NULL OR je.entry_date >= $1::date)
        AND ($2::date IS NULL OR je.entry_date <= $2::date)
        AND ($3::text IS NULL OR je.status = $3)
        AND je.merchant_id = $4${storeFilter}
        AND ($5::text IS NULL OR je.id::text = $5)
      GROUP BY je.id
      ORDER BY je.entry_date DESC, je.created_at DESC
      LIMIT 300
    `, params);
  return result.rows;
}

export async function listJournalEntries(scope: ReportScope, query?: { dateFrom?: string; dateTo?: string; status?: string }) {
  return withClient(async (client) => {
    return { data: await listJournalEntriesForClient(client, scope, query) };
  });
}

export async function getJournalEntryMutationTarget(entryId: string): Promise<{ merchantId: string; storeId: string | null }> {
  return withClient(async (client) => {
    const entry = await queryOne<{ merchant_id: string | null; store_id: string | null }>(client, `
      SELECT merchant_id, store_id
      FROM accounting.journal_entries
      WHERE id = $1
    `, [entryId]);
    if (!entry) throw new PlatformError("resource_not_found", "Journal entry not found", 404);
    if (!entry.merchant_id) throw new PlatformError("forbidden", "Journal entry has no merchant scope", 403);
    return { merchantId: entry.merchant_id, storeId: entry.store_id };
  });
}

export async function createJournalEntry(headers: HeadersLike, body: {
  entryDate?: string;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  createdBy?: string;
  lines?: Array<{ accountCode: string; debitAmount: number; creditAmount: number; description?: string }>;
}, actor: OperatorContext, scope: OperatingScope) {
  return withTransaction(async (client) => {
    const result = await withScopedIdempotency(client, headers, body, scope.merchantId, ACCT_OPS.createJournalEntry, async () => {
      if (!body.entryDate || !body.description) throw new PlatformError("validation_error", "entryDate and description are required", 400);
      const entry = await insertJournalEntryForClient(client, {
        entryDate: body.entryDate,
        referenceType: body.referenceType,
        referenceId: body.referenceId,
        description: body.description,
        createdBy: body.createdBy || actor.operatorId,
        merchantId: scope.merchantId,
        storeId: scope.storeId,
        lines: body.lines || [],
      });
      await recordAuditEntry(client, actor, "journal_entry.created", "journal_entry", String(entry.id), {
        after: { entryNumber: entry.entry_number },
        merchantId: scope.merchantId,
        storeId: scope.storeId,
      });
      const reportScope: ReportScope = {
        scopeKind: "report",
        merchantId: scope.merchantId,
        storeIds: [scope.storeId],
      };
      return { data: (await listJournalEntriesForClient(client, reportScope, { entryId: String(entry.id) }))[0] };
    });
    return result;
  });
}

export async function updateJournalEntry(headers: HeadersLike, entryId: string, body: {
  entryDate?: string;
  referenceType?: string | null;
  referenceId?: string | null;
  description?: string;
  lines?: Array<{ accountCode: string; debitAmount: number; creditAmount: number; description?: string }>;
}, actor: OperatorContext, scope: OperatingScope) {
  return withTransaction(async (client) => {
    const result = await withScopedIdempotency(client, headers, { entryId, ...body }, scope.merchantId, ACCT_OPS.updateJournalEntry, async () => {
      const before = await queryOne<Record<string, unknown>>(client, "SELECT * FROM accounting.journal_entries WHERE id = $1 FOR UPDATE", [entryId]);
      if (!before) throw new PlatformError("resource_not_found", "Journal entry not found", 404);
      assertOperatingMutationTarget(scope, {
        merchantId: typeof before.merchant_id === "string" ? before.merchant_id : null,
        storeId: typeof before.store_id === "string" ? before.store_id : null,
      }, "Journal entry");
      if (before.status !== "draft") throw new PlatformError("invalid_state_transition", "Only draft entries can be edited", 409);
      if (!body.description && !body.entryDate && !body.lines) {
        throw new PlatformError("validation_error", "No journal entry fields to update", 400);
      }
      await client.query(`
        UPDATE accounting.journal_entries
        SET entry_date = COALESCE($2::date, entry_date),
            reference_type = COALESCE($3, reference_type),
            reference_id = COALESCE($4, reference_id),
            description = COALESCE($5, description),
            updated_at = now()
        WHERE id = $1
      `, [
        entryId,
        body.entryDate || null,
        body.referenceType ?? null,
        body.referenceId ?? null,
        body.description || null,
      ]);
      if (body.lines) {
        await replaceJournalLines(client, entryId, body.lines);
      }
      const reportScope: ReportScope = {
        scopeKind: "report",
        merchantId: scope.merchantId,
        storeIds: [scope.storeId],
      };
      const updated = (await listJournalEntriesForClient(client, reportScope, { entryId }))[0];
      await recordAuditEntry(client, actor, "journal_entry.updated", "journal_entry", entryId, {
        before,
        after: updated,
        merchantId: scope.merchantId,
        storeId: scope.storeId,
      });
      return { data: updated };
    });
    return result;
  });
}

export async function postJournalEntry(headers: HeadersLike, entryId: string, actor: OperatorContext, scope: OperatingScope) {
  return withTransaction(async (client) => {
    const result = await withScopedIdempotency(client, headers, { entryId, action: "post" }, scope.merchantId, ACCT_OPS.postJournalEntry, async () => {
      const entry = await queryOne<Record<string, unknown>>(client, "SELECT * FROM accounting.journal_entries WHERE id = $1 FOR UPDATE", [entryId]);
      if (!entry) throw new PlatformError("resource_not_found", "Journal entry not found", 404);
      assertOperatingMutationTarget(scope, {
        merchantId: typeof entry.merchant_id === "string" ? entry.merchant_id : null,
        storeId: typeof entry.store_id === "string" ? entry.store_id : null,
      }, "Journal entry");
      if (entry.status !== "draft") throw new PlatformError("invalid_state_transition", "Only draft entries can be posted", 409);
      const updated = await client.query("UPDATE accounting.journal_entries SET status = 'posted', posted_at = now(), updated_at = now() WHERE id = $1 RETURNING *", [entryId]);
      const eventId = await emitExactOutbox(client, buildExactJournalPostedEvent({
        journalEntryId: entryId,
        merchantId: scope.merchantId,
        storeId: scope.storeId,
        sourceOccurredAt: updated.rows[0]?.posted_at,
      }));
      await recordAuditEntry(client, actor, "journal_entry.posted", "journal_entry", entryId, {
        before: { status: "draft" },
        after: { status: "posted" },
        correlationId: eventId,
        merchantId: scope.merchantId,
        storeId: scope.storeId,
      });
      return { data: updated.rows[0] };
    });
    return result;
  });
}

export async function voidJournalEntry(headers: HeadersLike, entryId: string, actor: OperatorContext, scope: OperatingScope) {
  return withTransaction(async (client) => {
    const result = await withScopedIdempotency(client, headers, { entryId, action: "void" }, scope.merchantId, ACCT_OPS.voidJournalEntry, async () => {
      const entry = await queryOne<Record<string, unknown>>(client, "SELECT * FROM accounting.journal_entries WHERE id = $1 FOR UPDATE", [entryId]);
      if (!entry) throw new PlatformError("resource_not_found", "Journal entry not found", 404);
      assertOperatingMutationTarget(scope, {
        merchantId: typeof entry.merchant_id === "string" ? entry.merchant_id : null,
        storeId: typeof entry.store_id === "string" ? entry.store_id : null,
      }, "Journal entry");
      if (entry.status === "voided") throw new PlatformError("invalid_state_transition", "Entry already voided", 409);
      const updated = await client.query("UPDATE accounting.journal_entries SET status = 'voided', updated_at = now() WHERE id = $1 RETURNING *", [entryId]);
      await recordAuditEntry(client, actor, "journal_entry.voided", "journal_entry", entryId, {
        before: { status: entry.status },
        after: { status: "voided" },
        merchantId: scope.merchantId,
        storeId: scope.storeId,
      });
      return { data: updated.rows[0] };
    });
    return result;
  });
}

export async function getIncomeStatement(scope: ReportScope, from = "1900-01-01", to = "2999-12-31") {
  if (!scope?.merchantId) {
    throw new PlatformError("scope_required", "getIncomeStatement requires tenantId in ReportScope", 409);
  }
  return withClient(async (client) => {
    const result = await client.query(`
      SELECT
        COALESCE(SUM(CASE WHEN a.code = '5111' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0)::numeric AS merchandise_revenue,
        COALESCE(SUM(CASE WHEN a.code = '5112' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0)::numeric AS shipping_revenue,
        COALESCE(SUM(CASE WHEN a.code = '5113' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0)::numeric AS payment_fee_revenue,
        COALESCE(SUM(CASE WHEN a.code = '7111' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0)::numeric AS other_income,
        COALESCE(SUM(CASE WHEN a.code = '6321' THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0)::numeric AS cogs,
        COALESCE(SUM(CASE WHEN a.code IN ('6421','6422') THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0)::numeric AS operating_expenses
      FROM accounting.journal_entries je
      JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
      JOIN accounting.accounts a ON a.id = jl.account_id
      WHERE je.status = 'posted' AND je.entry_date BETWEEN $1::date AND $2::date
        AND je.merchant_id = $3
        AND (je.store_id IS NULL OR je.store_id = ANY($4::text[]))
    `, [from, to, scope.merchantId, scope.storeIds]);
    const merchandiseRevenue = Number(result.rows[0]?.merchandise_revenue || 0);
    const shippingRevenue = Number(result.rows[0]?.shipping_revenue || 0);
    const paymentFeeRevenue = Number(result.rows[0]?.payment_fee_revenue || 0);
    const revenue = merchandiseRevenue + shippingRevenue + paymentFeeRevenue;
    const otherIncome = Number(result.rows[0]?.other_income || 0);
    const cogs = Number(result.rows[0]?.cogs || 0);
    const operatingExpenses = Number(result.rows[0]?.operating_expenses || 0);
    return {
      data: {
        revenue,
        merchandiseRevenue,
        shippingRevenue,
        paymentFeeRevenue,
        otherIncome,
        inventoryVarianceIncome: otherIncome,
        cogs,
        operatingExpenses,
        grossProfit: merchandiseRevenue - cogs,
        netIncome: revenue + otherIncome - cogs - operatingExpenses,
      },
    };
  });
}

export async function getBalanceSheet(scope: ReportScope, asOf = "2999-12-31") {
  if (!scope?.merchantId) {
    throw new PlatformError("scope_required", "getBalanceSheet requires tenantId in ReportScope", 409);
  }
  return withClient(async (client) => {
    const result = await client.query(`
      WITH balances AS (
        SELECT
          COALESCE(SUM(CASE WHEN a.type = 'asset' THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0)::numeric AS assets,
          COALESCE(SUM(CASE WHEN a.type = 'liability' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0)::numeric AS liabilities,
          COALESCE(SUM(CASE WHEN a.type = 'equity' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0)::numeric AS ledger_equity,
          COALESCE(SUM(CASE
            WHEN a.type IN ('revenue', 'expense') THEN jl.credit_amount - jl.debit_amount
            ELSE 0
          END), 0)::numeric AS current_earnings
        FROM accounting.journal_entries je
        JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
        JOIN accounting.accounts a ON a.id = jl.account_id
        WHERE je.status = 'posted' AND je.entry_date <= $1::date
          AND je.merchant_id = $2
          AND (je.store_id IS NULL OR je.store_id = ANY($3::text[]))
      )
      SELECT
        assets,
        liabilities,
        ledger_equity,
        current_earnings,
        (ledger_equity + current_earnings)::numeric AS reported_equity,
        (assets - liabilities - ledger_equity - current_earnings)::numeric AS balance_delta
      FROM balances
    `, [asOf, scope.merchantId, scope.storeIds]);
    const ledgerEquity = Number(result.rows[0]?.ledger_equity || 0);
    const currentEarnings = Number(result.rows[0]?.current_earnings || 0);
    const reportedEquity = Number(result.rows[0]?.reported_equity || 0);
    return {
      data: {
        totalAssets: Number(result.rows[0]?.assets || 0),
        totalLiabilities: Number(result.rows[0]?.liabilities || 0),
        ledgerEquity,
        currentEarnings,
        reportedEquity,
        totalEquity: reportedEquity,
        balanceDelta: Number(result.rows[0]?.balance_delta || 0),
      },
    };
  });
}

export async function getTaxSummary(scope: ReportScope, from = "1900-01-01", to = "2999-12-31") {
  if (!scope?.merchantId) {
    throw new PlatformError("scope_required", "getTaxSummary requires tenantId in ReportScope", 409);
  }
  return withClient(async (client) => {
    const result = await client.query(`
      SELECT
        COALESCE(SUM(CASE WHEN a.code = '3331' THEN jl.credit_amount ELSE 0 END), 0)::numeric AS output_vat,
        COALESCE(SUM(CASE WHEN a.code = '3331' THEN jl.debit_amount ELSE 0 END), 0)::numeric AS input_vat
      FROM accounting.journal_entries je
      JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
      JOIN accounting.accounts a ON a.id = jl.account_id
      WHERE je.status = 'posted' AND je.entry_date BETWEEN $1::date AND $2::date
        AND je.merchant_id = $3
        AND (je.store_id IS NULL OR je.store_id = ANY($4::text[]))
    `, [from, to, scope.merchantId, scope.storeIds]);
    const outputVat = Number(result.rows[0]?.output_vat || 0);
    const inputVat = Number(result.rows[0]?.input_vat || 0);
    return { data: { outputVat, inputVat, vatPayable: outputVat - inputVat } };
  });
}

export async function getCashFlow(scope: ReportScope, from = "1900-01-01", to = "2999-12-31") {
  if (!scope?.merchantId) {
    throw new PlatformError("scope_required", "getCashFlow requires tenantId in ReportScope", 409);
  }
  return withClient(async (client) => {
    const result = await client.query(`
      SELECT
        COALESCE(SUM(CASE WHEN a.code IN ('1111','1121') THEN jl.debit_amount ELSE 0 END), 0)::numeric AS cash_in,
        COALESCE(SUM(CASE WHEN a.code IN ('1111','1121') THEN jl.credit_amount ELSE 0 END), 0)::numeric AS cash_out
      FROM accounting.journal_entries je
      JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
      JOIN accounting.accounts a ON a.id = jl.account_id
      WHERE je.status = 'posted' AND je.entry_date BETWEEN $1::date AND $2::date
        AND je.merchant_id = $3
        AND (je.store_id IS NULL OR je.store_id = ANY($4::text[]))
    `, [from, to, scope.merchantId, scope.storeIds]);
    const cashIn = Number(result.rows[0]?.cash_in || 0);
    const cashOut = Number(result.rows[0]?.cash_out || 0);
    return { data: { cashIn, cashOut, netCashFlow: cashIn - cashOut } };
  });
}

export function reportHtml(title: string, data: unknown): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:Arial,sans-serif;margin:32px;color:#111}pre{background:#f6f6f6;padding:16px;border-radius:6px}</style></head><body><h1>${title}</h1><pre>${JSON.stringify(data, null, 2)}</pre></body></html>`;
}

export async function reportPdfBuffer(title: string, data: unknown): Promise<Buffer> {
  const { default: PDFDocument } = await import("pdfkit");
  const document = new PDFDocument({ size: "A4", margin: 36, info: { Title: title } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    document.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });
  document.fontSize(18).text(title, { underline: true });
  document.moveDown();
  document.fontSize(9).text(JSON.stringify(data, null, 2), {
    width: 520,
    lineGap: 2,
  });
  document.end();
  return done;
}
