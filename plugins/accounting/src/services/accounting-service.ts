import type { InMemoryStoreAdapter, AccountSummary } from "@medusa-snus/application";
import type { JournalEntry, JournalLine, IncomeStatementResult, BalanceSheetResult } from "../models/account";
import { validateJournalEntry } from "@medusa-snus/domain";
import { assertLegacyAccountingPluginAllowed } from "../legacy-quarantine";

/**
 * @deprecated Legacy in-memory service. Production accounting uses the
 * PostgreSQL-backed application accounting service.
 */
export class AccountingService {
  constructor(private store: InMemoryStoreAdapter) {
    assertLegacyAccountingPluginAllowed();
  }

  async getAccounts(type?: string): Promise<AccountSummary[]> {
    const all = [...(this.store.state.accounts)];
    return type ? all.filter(a => a.type === type) : all;
  }

  async getAccountByCode(code: string): Promise<AccountSummary | undefined> {
    return this.store.state.accounts.find(a => a.code === code);
  }

  async createAccount(data: { code: string; name: string; type: string; parentId?: string; description?: string }): Promise<AccountSummary> {
    const id = `acct_${this.store.state.accounts.length + 1}`;
    const account: AccountSummary = { id, code: data.code, name: data.name, type: data.type, balance: 0 };
    this.store.state.accounts.push(account);
    return account;
  }

  async createJournalEntry(data: {
    entryDate: string;
    referenceType?: string;
    referenceId?: string;
    description: string;
    createdBy: string;
    lines: JournalLine[];
    autoPost?: boolean;
  }): Promise<JournalEntry> {
    const totalDebits = data.lines.reduce((s, l) => s + l.debitAmount, 0);
    const totalCredits = data.lines.reduce((s, l) => s + l.creditAmount, 0);
    const err = validateJournalEntry(totalDebits, totalCredits);
    if (err) throw new Error(err);

    for (const line of data.lines) {
      const acct = this.store.state.accounts.find(a => a.code === line.accountCode);
      if (!acct) throw new Error(`Account ${line.accountCode} not found`);
    }

    const entry: JournalEntry = {
      id: `je_${this.store.state.journalEntries.length + 1}`,
      entryNumber: `JE-${data.entryDate.replace(/-/g, "")}-${String(this.store.state.journalEntries.length + 1).padStart(3, "0")}`,
      entryDate: data.entryDate,
      referenceType: data.referenceType,
      referenceId: data.referenceId,
      description: data.description,
      status: data.autoPost ? "posted" : "draft",
      postedAt: data.autoPost ? new Date().toISOString() : undefined,
      createdBy: data.createdBy,
      lines: data.lines,
    };

    this.store.state.journalEntries.push(entry as unknown as import("@medusa-snus/application").JournalEntry);
    return entry;
  }

  async postEntry(entryId: string): Promise<JournalEntry> {
    const entry = this.findEntry(entryId);
    if (!entry) throw new Error("Entry not found");
    if (entry.status !== "draft") throw new Error("Only draft entries can be posted");
    entry.status = "posted";
    entry.postedAt = new Date().toISOString();
    return entry;
  }

  async voidEntry(entryId: string): Promise<JournalEntry> {
    const entry = this.findEntry(entryId);
    if (!entry) throw new Error("Entry not found");
    entry.status = "voided";
    return entry;
  }

  findEntry(entryId: string): JournalEntry | undefined {
    return this.store.state.journalEntries.find(j => j.id === entryId) as JournalEntry | undefined;
  }

  getEntries(filters?: { dateFrom?: string; dateTo?: string; status?: string }): JournalEntry[] {
    let entries = [...this.store.state.journalEntries] as unknown as JournalEntry[];
    if (filters?.dateFrom) entries = entries.filter(e => e.entryDate >= filters.dateFrom!);
    if (filters?.dateTo) entries = entries.filter(e => e.entryDate <= filters.dateTo!);
    if (filters?.status) entries = entries.filter(e => e.status === filters.status);
    return entries;
  }

  getIncomeStatement(from: string, to: string): IncomeStatementResult {
    const entries = this.getEntries({ dateFrom: from, dateTo: to, status: "posted" });
    let revenue = 0, cogs = 0, operatingExpenses = 0;
    for (const entry of entries) {
      for (const line of entry.lines) {
        if (line.accountCode === "5111") revenue += line.creditAmount;
        if (line.accountCode === "6321") cogs += line.debitAmount;
        if (line.accountCode === "6421" || line.accountCode === "6422") operatingExpenses += line.debitAmount;
      }
    }
    const grossProfit = revenue - cogs;
    const netIncome = grossProfit - operatingExpenses;
    return { revenue, cogs, operatingExpenses, grossProfit, netIncome };
  }

  getBalanceSheet(asOf: string): BalanceSheetResult {
    const entries = this.getEntries({ dateTo: asOf, status: "posted" });
    let assetDebit = 0, assetCredit = 0;
    let liabilityDebit = 0, liabilityCredit = 0;
    let equityDebit = 0, equityCredit = 0;

    for (const entry of entries) {
      for (const line of entry.lines) {
        const acct = this.store.state.accounts.find(a => a.code === line.accountCode);
        if (!acct) continue;
        if (acct.type === "asset") { assetDebit += line.debitAmount; assetCredit += line.creditAmount; }
        if (acct.type === "liability") { liabilityDebit += line.debitAmount; liabilityCredit += line.creditAmount; }
        if (acct.type === "equity") { equityDebit += line.debitAmount; equityCredit += line.creditAmount; }
      }
    }

    const totalAssets = assetDebit - assetCredit;
    const totalLiabilities = liabilityCredit - liabilityDebit;
    const totalEquity = equityCredit - equityDebit;

    return { totalAssets, totalLiabilities, totalEquity };
  }

  getTaxSummary(from: string, to: string): { outputVat: number; inputVat: number; vatPayable: number } {
    const entries = this.getEntries({ dateFrom: from, dateTo: to, status: "posted" });
    let outputVat = 0, inputVat = 0;
    for (const entry of entries) {
      for (const line of entry.lines) {
        if (line.accountCode === "3331") { outputVat += line.creditAmount; }
      }
    }
    return { outputVat, inputVat, vatPayable: outputVat - inputVat };
  }
}
