import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Button, ConfirmDialog, Drawer, FilterBar, InlineError, MutationBanner,
  PaginatedListFrame, loadedListPaginationMeta, localListPaginationMeta, OperationalTable, PageHeader, Panel, ResponsiveMetricGrid, ScreenState,
  StatusPill, TableSkeleton,
} from "@medusa-snus/ui";
import { api } from "../api/client";
import { fetchCashFlow, reportExportUrl } from "../api/endpoints";
import { FileText, Plus } from "lucide-react";
import { useI18n } from "../i18n";

function formatMoney(value: unknown) {
  const amount = Number(value || 0);
  return `${amount.toLocaleString("vi-VN")} ₫`;
}

type JournalLine = {
  accountCode?: string;
  accountName?: string;
  accountType?: string;
  debitAmount?: number | string;
  creditAmount?: number | string;
  description?: string;
};

type DraftJournalLine = {
  clientId: string;
  accountCode: string;
  debitAmount: string;
  creditAmount: string;
  desc: string;
};

function newDraftJournalLine(clientId: string, accountCode = "1111"): DraftJournalLine {
  return { clientId, accountCode, debitAmount: "", creditAmount: "", desc: "" };
}

type JournalEntryItem = {
  id: string;
  entryNumber: string;
  entryDate: string;
  description: string;
  status: string;
  referenceType?: string | null;
  referenceId?: string | null;
  createdBy?: string | null;
  postedAt?: string | null;
  lines: JournalLine[];
};

function accountImpact(line: JournalLine) {
  const type = String(line.accountType || "");
  const debit = Number(line.debitAmount || 0);
  const credit = Number(line.creditAmount || 0);
  if (type === "asset") {
    const amount = debit - credit;
    return { section: "Tài sản", amount, description: amount >= 0 ? "Tăng tài sản trên bảng cân đối" : "Giảm tài sản trên bảng cân đối" };
  }
  if (type === "liability") {
    const amount = credit - debit;
    return { section: "Nợ phải trả", amount, description: amount >= 0 ? "Tăng nợ phải trả trên bảng cân đối" : "Giảm nợ phải trả trên bảng cân đối" };
  }
  if (type === "equity") {
    const amount = credit - debit;
    return { section: "Vốn chủ sở hữu", amount, description: amount >= 0 ? "Tăng vốn chủ sở hữu trên bảng cân đối" : "Giảm vốn chủ sở hữu trên bảng cân đối" };
  }
  if (type === "revenue") {
    const amount = credit - debit;
    return { section: "Kết quả kinh doanh", amount, description: "Tăng doanh thu; tăng lợi nhuận giữ lại khi kết chuyển sang vốn chủ sở hữu" };
  }
  if (type === "expense") {
    const amount = debit - credit;
    return { section: "Kết quả kinh doanh", amount: -amount, description: "Tăng chi phí; giảm lợi nhuận giữ lại khi kết chuyển sang vốn chủ sở hữu" };
  }
  return { section: "Khác", amount: debit - credit, description: "Chưa xác định loại tài khoản để diễn giải tác động" };
}

export type BalanceSheetData = {
  totalAssets: number;
  totalLiabilities: number;
  ledgerEquity: number;
  currentEarnings: number;
  reportedEquity: number;
  totalEquity: number;
  balanceDelta: number;
};

export function BalanceSheetSummary({ data }: { data?: BalanceSheetData }) {
  const totalAssets = Number(data?.totalAssets ?? 0);
  const totalLiabilities = Number(data?.totalLiabilities ?? 0);
  const ledgerEquity = Number(data?.ledgerEquity ?? 0);
  const currentEarnings = Number(data?.currentEarnings ?? 0);
  const totalEquity = Number(data?.reportedEquity ?? data?.totalEquity ?? 0);
  const calculatedDelta = totalAssets - totalLiabilities - totalEquity;
  const balanceDelta = Number.isFinite(data?.balanceDelta)
    ? Number(data?.balanceDelta)
    : calculatedDelta;
  const isBalanced = Math.abs(balanceDelta) < 0.01;

  return (
    <div className="space-y-1 p-3 text-sm">
      <div className="flex justify-between">
        <span>Tài sản</span>
        <span className="tabular-nums">{formatMoney(totalAssets)}</span>
      </div>
      <div className="flex justify-between">
        <span>Nợ phải trả</span>
        <span className="tabular-nums">{formatMoney(totalLiabilities)}</span>
      </div>
      <div className="flex justify-between border-t pt-1">
        <span>Vốn theo sổ cái</span>
        <span className="tabular-nums">{formatMoney(ledgerEquity)}</span>
      </div>
      <div className="flex justify-between">
        <span>Lợi nhuận chưa kết chuyển</span>
        <span className="tabular-nums">{formatMoney(currentEarnings)}</span>
      </div>
      <div className="flex justify-between border-t pt-1 font-bold">
        <span>Tổng vốn chủ sở hữu</span>
        <span className="tabular-nums">{formatMoney(totalEquity)}</span>
      </div>
      <div
        data-testid="balance-sheet-equation"
        data-balanced={isBalanced ? "true" : "false"}
        className={isBalanced ? "text-status-success" : "text-status-danger"}
      >
        {isBalanced
          ? "Đã cân đối: Tài sản = Nợ phải trả + Vốn chủ sở hữu"
          : `Chênh lệch bảng cân đối: ${formatMoney(balanceDelta)}`}
      </div>
    </div>
  );
}

export default function AccountingScreen() {
  const PAGE_SIZE = 20;
  const DRAFT_LINE_PAGE_SIZE = 10;
  const { t } = useI18n();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"entries" | "reports">("entries");
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [postConfirm, setPostConfirm] = useState<string | null>(null);
  const [voidConfirm, setVoidConfirm] = useState<string | null>(null);
  const currentYear = new Date().getFullYear();
  const [reportFrom, setReportFrom] = useState(`${currentYear}-01-01`);
  const [reportTo, setReportTo] = useState(new Date().toISOString().slice(0, 10));
  const [formError, setFormError] = useState("");
  const [mutationNotice, setMutationNotice] = useState<{ tone: "success" | "error" | "pending"; message: string } | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<JournalEntryItem | null>(null);
  const [entryPage, setEntryPage] = useState(1);
  const [accountsPage, setAccountsPage] = useState(1);
  const [draftLinesPage, setDraftLinesPage] = useState(1);
  const [draftLineSequence, setDraftLineSequence] = useState(3);
  const [journalDetailLinesPage, setJournalDetailLinesPage] = useState(1);

  const { data: entries, isLoading, error, refetch } = useQuery({
    queryKey: ["journalEntries"],
    queryFn: () => api.get<{ data: Array<Record<string, unknown>> }>("/api/accounting/journal-entries"),
  });

  const { data: accounts, isLoading: accountsLoading, error: accountsError } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<{ data: Array<Record<string, unknown>> }>("/api/accounting/accounts"),
  });

  const { data: pnl, isLoading: pnlLoading, error: pnlError, refetch: refetchPnl } = useQuery({
    queryKey: ["incomeStatement", reportFrom, reportTo],
    queryFn: () =>
      api.get<{ data: { revenue: number; merchandiseRevenue?: number; shippingRevenue?: number; otherIncome?: number; inventoryVarianceIncome?: number; cogs: number; grossProfit: number; operatingExpenses: number; netIncome: number } }>(
        `/api/accounting/reports/income-statement?from=${encodeURIComponent(reportFrom)}&to=${encodeURIComponent(reportTo)}`,
      ),
    enabled: tab === "reports",
  });

  const { data: balanceSheet, isLoading: balanceLoading, error: balanceError, refetch: refetchBalance } = useQuery({
    queryKey: ["balanceSheet", reportTo],
    queryFn: () =>
      api.get<{ data: BalanceSheetData }>(
        `/api/accounting/reports/balance-sheet?asOf=${encodeURIComponent(reportTo)}`,
      ),
    enabled: tab === "reports",
  });

  const { data: cashFlow, isLoading: cashFlowLoading, error: cashFlowError, refetch: refetchCashFlow } = useQuery({
    queryKey: ["cashFlow", reportFrom, reportTo],
    queryFn: () => fetchCashFlow(reportFrom, reportTo),
    enabled: tab === "reports",
  });

  const postMutation = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/accounting/journal-entries/${id}/post`, {}, `je-post-${Date.now()}`),
    onMutate: () => setMutationNotice({ tone: "pending", message: "Đang ghi sổ bút toán..." }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journalEntries"] });
      setPostConfirm(null);
      setMutationNotice({ tone: "success", message: "Đã ghi sổ bút toán." });
    },
    onError: (err) => {
      setMutationNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể ghi sổ bút toán.",
      });
    },
  });

  const voidMutation = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/accounting/journal-entries/${id}/void`, {}, `je-void-${Date.now()}`),
    onMutate: () => setMutationNotice({ tone: "pending", message: "Đang hủy bút toán..." }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journalEntries"] });
      setVoidConfirm(null);
      setSelectedEntry((current) => current ? { ...current, status: "voided" } : current);
      setMutationNotice({ tone: "success", message: "Đã hủy bút toán." });
    },
    onError: (err) => {
      setMutationNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể hủy bút toán.",
      });
    },
  });

  const entryList = (entries?.data || []) as JournalEntryItem[];
  const entryPageMeta = loadedListPaginationMeta(entryList.length, entryPage, PAGE_SIZE);
  const visibleEntries = entryList.slice((entryPageMeta.page - 1) * PAGE_SIZE, entryPageMeta.page * PAGE_SIZE);
  const accountList = (accounts?.data || []) as Array<Record<string, unknown>>;
  const accountsPageMeta = localListPaginationMeta(accountList.length, accountsPage, PAGE_SIZE);
  const visibleAccounts = accountList.slice(
    (accountsPageMeta.page - 1) * PAGE_SIZE,
    accountsPageMeta.page * PAGE_SIZE,
  );

  // Create form state
  const [desc, setDesc] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<DraftJournalLine[]>([
    newDraftJournalLine("journal-line-1", "1111"),
    newDraftJournalLine("journal-line-2", "5111"),
  ]);
  const draftLinesMeta = localListPaginationMeta(lines.length, draftLinesPage, DRAFT_LINE_PAGE_SIZE);
  const visibleDraftLines = lines.slice(
    (draftLinesMeta.page - 1) * DRAFT_LINE_PAGE_SIZE,
    draftLinesMeta.page * DRAFT_LINE_PAGE_SIZE,
  );
  const journalDetailLinesMeta = localListPaginationMeta(selectedEntry?.lines.length || 0, journalDetailLinesPage, PAGE_SIZE);
  const visibleJournalDetailLines = (selectedEntry?.lines || []).slice(
    (journalDetailLinesMeta.page - 1) * PAGE_SIZE,
    journalDetailLinesMeta.page * PAGE_SIZE,
  );

  useEffect(() => {
    setEntryPage(1);
  }, [entryList.length]);

  useEffect(() => {
    setJournalDetailLinesPage(1);
  }, [selectedEntry?.id]);

  const createMutation = useMutation({
    mutationFn: () => {
      const payload = {
        entryDate: date,
        description: desc,
        createdBy: "operator",
        lines: lines
          .filter((l) => Number(l.debitAmount) > 0 || Number(l.creditAmount) > 0)
          .map((l) => ({
            accountCode: l.accountCode,
            debitAmount: Number(l.debitAmount) || 0,
            creditAmount: Number(l.creditAmount) || 0,
            description: l.desc,
          })),
      };
      return editingId
        ? api.patch(`/api/accounting/journal-entries/${editingId}`, payload, `je-update-${Date.now()}`)
        : api.post("/api/accounting/journal-entries", payload, `je-create-${Date.now()}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journalEntries"] });
      setShowCreate(false);
      setEditingId(null);
      setDesc("");
      setFormError("");
      setMutationNotice({ tone: "success", message: editingId ? "Đã cập nhật bút toán." : "Đã tạo bút toán." });
    },
    onError: (err) => {
      setMutationNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể lưu bút toán.",
      });
    },
  });

  const activeLines = lines.filter((l) => Number(l.debitAmount) > 0 || Number(l.creditAmount) > 0);
  const debitTotal = activeLines.reduce((sum, line) => sum + (Number(line.debitAmount) || 0), 0);
  const creditTotal = activeLines.reduce((sum, line) => sum + (Number(line.creditAmount) || 0), 0);
  const canSaveEntry = !!desc.trim() && activeLines.length >= 2 && debitTotal > 0 && debitTotal === creditTotal;

  function handleSaveEntry() {
    if (!desc.trim()) {
      setFormError("Diễn giải là bắt buộc.");
      return;
    }
    if (activeLines.length < 2) {
      setFormError("Cần ít nhất 2 dòng phát sinh.");
      return;
    }
    if (debitTotal !== creditTotal) {
      setFormError("Tổng Nợ phải bằng tổng Có.");
      return;
    }
    setFormError("");
    setMutationNotice({ tone: "pending", message: editingId ? "Đang cập nhật bút toán..." : "Đang tạo bút toán..." });
    createMutation.mutate();
  }

  function updateDraftLine(clientId: string, patch: Partial<DraftJournalLine>) {
    setLines((current) => current.map((line) => line.clientId === clientId ? { ...line, ...patch } : line));
  }

  function openCreateForm() {
    setEditingId(null);
    setDesc("");
    setDate(new Date().toISOString().slice(0, 10));
    setLines([
      newDraftJournalLine("journal-line-1", "1111"),
      newDraftJournalLine("journal-line-2", "5111"),
    ]);
    setDraftLineSequence(3);
    setDraftLinesPage(1);
    setShowCreate(true);
  }

  function openEditForm(entry: typeof entryList[number]) {
    setEditingId(entry.id);
    setDesc(entry.description);
    setDate(new Date(entry.entryDate).toISOString().slice(0, 10));
    setLines(
      (entry.lines || []).map((line, index) => ({
        clientId: `journal-${entry.id}-line-${index + 1}`,
        accountCode: String(line.accountCode || "1111"),
        debitAmount: Number(line.debitAmount || 0) ? String(Number(line.debitAmount)) : "",
        creditAmount: Number(line.creditAmount || 0) ? String(Number(line.creditAmount)) : "",
        desc: String(line.description || ""),
      })),
    );
    setDraftLineSequence((entry.lines || []).length + 1);
    setDraftLinesPage(1);
    setShowCreate(true);
  }

  if (error) {
    return (
      <div className="p-4">
        <InlineError message="Không thể tải dữ liệu kế toán" onRetry={() => refetch()} stale />
      </div>
    );
  }

  return (
    <div className="flex gap-4 p-4 h-full">
      <div className="flex-1 space-y-4 min-w-0">
        <PageHeader title={t("accounting.title")} />

        {mutationNotice && (
          <MutationBanner
            tone={mutationNotice.tone}
            message={mutationNotice.message}
            actionLabel={mutationNotice.tone === "error" ? t("state.close") : undefined}
            onAction={() => setMutationNotice(null)}
          />
        )}

        {/* Tab Bar */}
        <div className="flex items-center gap-2">
          <Button variant={tab === "entries" ? "primary" : "secondary"} onClick={() => setTab("entries")}>
            {t("accounting.journal")}
          </Button>
          <Button variant={tab === "reports" ? "primary" : "secondary"} onClick={() => setTab("reports")}>
            {t("accounting.reports")}
          </Button>
          <div className="flex-1" />
          {tab === "entries" && (
            <Button variant="primary" onClick={openCreateForm}>
              <Plus size={14} className="mr-1" /> {t("accounting.createEntry")}
            </Button>
          )}
        </div>

        {/* ── Entries Tab ── */}
        {tab === "entries" && (
          <Panel title="Sổ nhật ký chung">
            {isLoading ? (
              <TableSkeleton rows={6} cols={6} />
            ) : entryList.length === 0 ? (
              <div className="p-6 text-center">
                <FileText size={32} className="text-text-muted mb-3 mx-auto" />
                <p className="text-sm text-text-muted">{t("accounting.emptyEntries")}</p>
                <p className="text-xs text-text-muted mt-1">{t("accounting.autoCreated")}</p>
              </div>
            ) : (
              <>
              <PaginatedListFrame
                label="Phân trang bút toán"
                rowNoun="bút toán"
                meta={entryPageMeta}
                onPageChange={setEntryPage}
              >
                <OperationalTable
                  columns={[
                    { key: "number", label: "Số" },
                    { key: "date", label: "Ngày" },
                    { key: "description", label: "Diễn giải" },
                    { key: "lines", label: "Dòng" },
                    { key: "status", label: "Trạng thái" },
                    { key: "actions", label: "" },
                  ]}
                  rows={visibleEntries.map((e) => ({
                    number: <span className="font-mono text-xs">{e.entryNumber}</span>,
                    date: new Date(e.entryDate).toLocaleDateString("vi-VN"),
                    description: e.description,
                    lines: `${e.lines?.length || 0} dòng`,
                    status: (
                      <StatusPill
                        tone={e.status === "posted" ? "success" : e.status === "voided" ? "danger" : "warning"}
                        label={e.status}
                      />
                    ),
                    actions:
                      e.status === "draft" ? (
                        <div className="flex gap-1" onClick={(event) => event.stopPropagation()}>
                          <Button variant="secondary" size="sm" onClick={() => openEditForm(e)}>
                            {t("state.edit")}
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => setPostConfirm(e.id)}>
                            {t("accounting.post")}
                          </Button>
                        </div>
                      ) : null,
                  }))}
                  onRowClick={(_row, index) => {
                    const entry = index === undefined ? undefined : visibleEntries[index];
                    if (entry) setSelectedEntry(entry);
                  }}
                />
              </PaginatedListFrame>
              </>
            )}
          </Panel>
        )}

        {/* ── Reports Tab ── */}
        {tab === "reports" && (
          <div className="space-y-4">
            <FilterBar>
              <label className="flex items-center gap-2 text-xs text-text-muted">
                Từ
                <input
                  type="date"
                  value={reportFrom}
                  onChange={(event) => setReportFrom(event.target.value)}
                  className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm text-text-primary focus:border-action-primary focus:outline-none"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-text-muted">
                Đến
                <input
                  type="date"
                  value={reportTo}
                  onChange={(event) => setReportTo(event.target.value)}
                  className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm text-text-primary focus:border-action-primary focus:outline-none"
                />
              </label>
            </FilterBar>

            {(pnlError || balanceError || cashFlowError) && (
              <InlineError
                message="Không thể tải đầy đủ báo cáo"
                onRetry={() => {
                  void refetchPnl();
                  void refetchBalance();
                  void refetchCashFlow();
                }}
                stale
              />
            )}

            <ResponsiveMetricGrid>
              <Panel title={t("accounting.incomeStatement")}>
                {pnlLoading ? (
                  <TableSkeleton rows={5} cols={2} />
                ) : (
                <div className="p-3 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span>Doanh thu</span>
                    <span className="font-medium tabular-nums">
                      {(pnl?.data?.revenue || 0).toLocaleString("vi-VN")} ₫
                    </span>
                  </div>
                  <div className="flex justify-between text-xs text-text-muted">
                    <span>Doanh thu hàng hóa</span>
                    <span className="tabular-nums">
                      {(pnl?.data?.merchandiseRevenue || 0).toLocaleString("vi-VN")} ₫
                    </span>
                  </div>
                  <div className="flex justify-between text-xs text-text-muted">
                    <span>Doanh thu vận chuyển</span>
                    <span className="tabular-nums">
                      {(pnl?.data?.shippingRevenue || 0).toLocaleString("vi-VN")} ₫
                    </span>
                  </div>
                  <div className="flex justify-between text-xs text-text-muted">
                    <span>Thu nhập khác - chênh lệch kiểm kê</span>
                    <span className="tabular-nums">
                      {(pnl?.data?.otherIncome || 0).toLocaleString("vi-VN")} ₫
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Giá vốn</span>
                    <span className="text-status-danger tabular-nums">
                      {(pnl?.data?.cogs || 0).toLocaleString("vi-VN")} ₫
                    </span>
                  </div>
                  <div className="flex justify-between border-t pt-1 font-bold">
                    <span>Lợi nhuận gộp</span>
                    <span className="tabular-nums">
                      {(pnl?.data?.grossProfit || 0).toLocaleString("vi-VN")} ₫
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Chi phí HĐ</span>
                    <span className="text-status-danger tabular-nums">
                      {(pnl?.data?.operatingExpenses || 0).toLocaleString("vi-VN")} ₫
                    </span>
                  </div>
                  <div className="flex justify-between border-t pt-1 font-bold">
                    <span>Lợi nhuận ròng</span>
                    <span className="text-status-success tabular-nums">
                      {(pnl?.data?.netIncome || 0).toLocaleString("vi-VN")} ₫
                    </span>
                  </div>
                </div>
                )}
              </Panel>

              <Panel title={t("accounting.balanceSheet")}>
                {balanceLoading ? (
                  <TableSkeleton rows={6} cols={2} />
                ) : (
                  <BalanceSheetSummary data={balanceSheet?.data} />
                )}
              </Panel>

              <Panel title={t("accounting.cashFlow")}>
                {cashFlowLoading ? (
                  <TableSkeleton rows={3} cols={2} />
                ) : (
                <div className="p-3 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span>Tiền vào</span>
                    <span className="tabular-nums">
                      {(cashFlow?.data?.cashIn || 0).toLocaleString("vi-VN")} ₫
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Tiền ra</span>
                    <span className="text-status-danger tabular-nums">
                      {(cashFlow?.data?.cashOut || 0).toLocaleString("vi-VN")} ₫
                    </span>
                  </div>
                  <div className="flex justify-between border-t pt-1 font-bold">
                    <span>Net</span>
                    <span className="tabular-nums">
                      {(cashFlow?.data?.netCashFlow || 0).toLocaleString("vi-VN")} ₫
                    </span>
                  </div>
                </div>
                )}
              </Panel>
            </ResponsiveMetricGrid>

            {/* Export Buttons */}
            <div className="flex gap-2 flex-wrap">
              <Button
                variant="secondary"
                onClick={() =>
                  window.open(reportExportUrl("income-statement", { from: reportFrom, to: reportTo }), "_blank")
                }
              >
                Xuất P&amp;L
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  window.open(reportExportUrl("balance-sheet", { asOf: reportTo }), "_blank")
                }
              >
                Xuất CĐKT
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  window.open(reportExportUrl("tax-summary", { from: reportFrom, to: reportTo }), "_blank")
                }
              >
                Xuất VAT
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  window.open(reportExportUrl("cash-flow", { from: reportFrom, to: reportTo }), "_blank")
                }
              >
                Xuất Dòng tiền
              </Button>
            </div>

            {/* Chart of Accounts */}
            <Panel title={t("accounting.chartOfAccounts")}>
              {accountsLoading ? (
                <TableSkeleton rows={6} cols={3} />
              ) : accountsError ? (
                <div className="p-3">
                  <InlineError message="Không thể tải hệ thống tài khoản" stale />
                </div>
              ) : (accounts?.data || []).length === 0 ? (
                <ScreenState state="empty" title="Chưa có tài khoản kế toán" />
              ) : (
                <>
                  <PaginatedListFrame
                    label="Phân trang hệ thống tài khoản"
                    rowNoun="tài khoản"
                    meta={accountsPageMeta}
                    onPageChange={setAccountsPage}
                  >
                    <div className="max-h-64 overflow-auto space-y-1 text-xs p-2">
                      {visibleAccounts.map((a) => (
                        <div
                          key={String(a.code)}
                          className="grid grid-cols-[4.5rem_1fr_auto_8rem] items-center gap-3 rounded px-2 py-1 hover:bg-surface-hover transition-colors"
                        >
                          <span className="font-mono">{String(a.code)}</span>
                          <span className="min-w-0 truncate">{String(a.name)}</span>
                          <span className="rounded border border-border-subtle px-2 py-0.5 text-[11px] uppercase text-text-muted">
                            {String(a.type)}
                          </span>
                          <span className="text-right tabular-nums font-medium text-text-primary">
                            {formatMoney(a.balance)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </PaginatedListFrame>
                </>
              )}
            </Panel>
          </div>
        )}
      </div>

      {/* ── Create/Edit Entry Drawer ── */}
      <Drawer
        open={showCreate}
        title={editingId ? t("accounting.editDraft") : t("accounting.createEntry")}
        onClose={() => { setShowCreate(false); setEditingId(null); }}
        actions={
          <>
            <Button variant="primary" onClick={handleSaveEntry} disabled={!canSaveEntry || createMutation.isPending}>
              {createMutation.isPending ? t("state.loading") : editingId ? "Cập nhật" : "Tạo"}
            </Button>
            <Button variant="secondary" onClick={() => { setShowCreate(false); setEditingId(null); }}>
              {t("state.cancel")}
            </Button>
          </>
        }
      >
            <div className="space-y-3">
              {formError && <MutationBanner tone="error" message={formError} />}
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="h-9 w-full rounded-md border border-border-default bg-surface-panel px-3 text-xs
                           focus:border-action-primary focus:outline-none"
              />
              <input
                placeholder="Diễn giải"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                className="h-9 w-full rounded-md border border-border-default bg-surface-panel px-3 text-xs
                           focus:border-action-primary focus:outline-none"
              />
              <PaginatedListFrame
                label="Phân trang dòng nháp bút toán"
                rowNoun="dòng hạch toán"
                meta={draftLinesMeta}
                onPageChange={setDraftLinesPage}
              >
                {visibleDraftLines.map((l) => {
                  return (
                    <div key={l.clientId} className="grid grid-cols-3 gap-1">
                      <select
                        value={l.accountCode}
                        onChange={(e) => updateDraftLine(l.clientId, { accountCode: e.target.value })}
                        className="h-8 rounded border border-border-default px-1 text-[11px]
                                           focus:border-action-primary focus:outline-none"
                      >
                        <option value="1111">1111 TM</option>
                        <option value="5111">5111 DT</option>
                        <option value="6321">6321 GV</option>
                        <option value="1561">1561 HH</option>
                        <option value="6421">6421 CP</option>
                      </select>
                      <input
                        placeholder="Nợ"
                        value={l.debitAmount}
                        onChange={(e) => updateDraftLine(l.clientId, { debitAmount: e.target.value })}
                        className="h-8 rounded border border-border-default px-1 text-[11px]
                                           focus:border-action-primary focus:outline-none"
                      />
                      <input
                        placeholder="Có"
                        value={l.creditAmount}
                        onChange={(e) => updateDraftLine(l.clientId, { creditAmount: e.target.value })}
                        className="h-8 rounded border border-border-default px-1 text-[11px]
                                           focus:border-action-primary focus:outline-none"
                      />
                    </div>
                  );
                })}
              </PaginatedListFrame>
              <Button
                variant="secondary"
                onClick={() => {
                  setLines((current) => [...current, newDraftJournalLine(`journal-line-${draftLineSequence}`)]);
                  setDraftLineSequence((current) => current + 1);
                }}
              >
                + Thêm dòng
              </Button>
              <div className="rounded-md border border-border-default bg-surface-subtle p-2 text-xs text-text-secondary">
                <div className="flex justify-between">
                  <span>Tổng Nợ</span>
                  <span className="tabular-nums">{debitTotal.toLocaleString("vi-VN")} ₫</span>
                </div>
                <div className="flex justify-between">
                  <span>Tổng Có</span>
                  <span className="tabular-nums">{creditTotal.toLocaleString("vi-VN")} ₫</span>
                </div>
              </div>
            </div>
      </Drawer>

      <Drawer
        open={!!selectedEntry}
        title={selectedEntry ? `Chi tiết ${selectedEntry.entryNumber}` : "Chi tiết bút toán"}
        onClose={() => setSelectedEntry(null)}
        actions={
          <Button variant="secondary" onClick={() => setSelectedEntry(null)}>
            {t("state.close")}
          </Button>
        }
      >
        {selectedEntry && (
          <div className="space-y-4">
            {selectedEntry.status === "posted" && (
              <Button variant="danger" size="sm" className="w-full" onClick={() => setVoidConfirm(selectedEntry.id)}>
                Hủy bút toán
              </Button>
            )}
            <div className="rounded-lg border border-border-default bg-surface-subtle p-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-text-muted">Ngày</span>
                <span className="font-medium text-text-primary">
                  {new Date(selectedEntry.entryDate).toLocaleDateString("vi-VN")}
                </span>
              </div>
              <div className="mt-2 flex justify-between gap-3">
                <span className="text-text-muted">Trạng thái</span>
                <StatusPill
                  tone={
                    selectedEntry.status === "posted" ? "success"
                    : selectedEntry.status === "voided" ? "danger"
                    : "warning"
                  }
                  label={selectedEntry.status}
                />
              </div>
              <div className="mt-2">
                <p className="text-text-muted">Diễn giải</p>
                <p className="mt-1 font-medium text-text-primary">{selectedEntry.description}</p>
              </div>
              {selectedEntry.createdBy && (
                <div className="mt-2 flex justify-between gap-3">
                  <span className="text-text-muted">Người tạo</span>
                  <span className="font-mono text-xs text-text-primary">{selectedEntry.createdBy}</span>
                </div>
              )}
            </div>

            <Panel title="Các dòng hạch toán">
              <PaginatedListFrame
                label="Phân trang dòng bút toán"
                rowNoun="dòng hạch toán"
                meta={journalDetailLinesMeta}
                onPageChange={setJournalDetailLinesPage}
              >
                <div className="space-y-2 p-3">
                  {visibleJournalDetailLines.map((line, index) => {
                    const impact = accountImpact(line);
                    return (
                      <div
                        key={`${line.accountCode}-${index}`}
                        className="rounded-lg border border-border-default p-3 text-sm"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium text-text-primary">
                              <span className="font-mono">{line.accountCode}</span> {line.accountName || ""}
                            </p>
                            <p className="mt-0.5 text-xs text-text-muted">
                              {line.description || "Không có mô tả dòng"}
                            </p>
                          </div>
                          <span className="rounded border border-border-subtle px-2 py-0.5 text-[11px] uppercase text-text-muted">
                            {line.accountType || "unknown"}
                          </span>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                          <div className="rounded bg-surface-subtle p-2">
                            <p className="text-text-muted">Nợ</p>
                            <p className="mt-1 font-semibold tabular-nums text-text-primary">
                              {formatMoney(line.debitAmount)}
                            </p>
                          </div>
                          <div className="rounded bg-surface-subtle p-2">
                            <p className="text-text-muted">Có</p>
                            <p className="mt-1 font-semibold tabular-nums text-text-primary">
                              {formatMoney(line.creditAmount)}
                            </p>
                          </div>
                        </div>
                        <div className="mt-3 rounded-md border border-border-subtle bg-surface-subtle p-2 text-xs">
                          <p className="font-medium text-text-primary">
                            {impact.section}: {formatMoney(Math.abs(impact.amount))}
                          </p>
                          <p className="mt-1 leading-4 text-text-muted">{impact.description}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </PaginatedListFrame>
            </Panel>

            <div className="rounded-lg border border-border-default bg-surface-subtle p-3 text-xs leading-5 text-text-muted">
              Bảng cân đối kế toán nhận trực tiếp các dòng tài sản, nợ phải trả và vốn chủ sở hữu.
              Các dòng doanh thu/chi phí đi qua báo cáo kết quả kinh doanh trước, rồi ảnh hưởng đến vốn chủ sở hữu qua lợi nhuận giữ lại khi kết chuyển kỳ.
            </div>
          </div>
        )}
      </Drawer>

      {/* ── Post Confirm ── */}
      <ConfirmDialog
        open={!!postConfirm}
        title="Ghi sổ bút toán?"
        message={t("accounting.postConfirm")}
        confirmLabel={t("accounting.post")}
        danger
        pending={postMutation.isPending}
        onConfirm={() => postConfirm && postMutation.mutate(postConfirm)}
        onCancel={() => setPostConfirm(null)}
      />
      <ConfirmDialog
        open={!!voidConfirm}
        title="Hủy bút toán?"
        message="Hủy bút toán đã ghi sổ này? Hành động sẽ đổi trạng thái bút toán sang voided và được ghi audit."
        confirmLabel="Hủy bút toán"
        danger
        pending={voidMutation.isPending}
        onConfirm={() => voidConfirm && voidMutation.mutate(voidConfirm)}
        onCancel={() => setVoidConfirm(null)}
      />
    </div>
  );
}
