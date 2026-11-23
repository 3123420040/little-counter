import type { AccountType, Actor } from "@medusa-snus/contracts";

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentId?: string;
  isActive: boolean;
  description?: string;
}

export interface JournalEntry {
  id: string;
  entryNumber: string;
  entryDate: string;
  referenceType?: string;
  referenceId?: string;
  description: string;
  status: "draft" | "posted" | "voided";
  postedAt?: string;
  createdBy: string;
  lines: JournalLine[];
}

export interface JournalLine {
  accountCode: string;
  debitAmount: number;
  creditAmount: number;
  description?: string;
}

export interface IncomeStatementResult {
  revenue: number;
  cogs: number;
  operatingExpenses: number;
  grossProfit: number;
  netIncome: number;
}

export interface BalanceSheetResult {
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
}

export interface AccountBalance {
  code: string;
  name: string;
  type: AccountType;
  debitTotal: number;
  creditTotal: number;
  balance: number;
}
