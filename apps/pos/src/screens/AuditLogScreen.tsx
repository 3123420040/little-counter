import { useEffect, useState } from "react";
import {
  Button, FilterBar, InlineError, PaginatedListFrame, loadedListPaginationMeta, OperationalTable,
  PageHeader, Panel, SearchBox, StatusPill, TableSkeleton,
} from "@medusa-snus/ui";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { FileSearch, User, Clock } from "lucide-react";
import { useI18n } from "../i18n";

interface AuditEntry {
  actorType: string;
  actorId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  reason?: string;
  correlationId: string;
  createdAt: string;
}

export default function AuditLogScreen() {
  const PAGE_SIZE = 20;
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState("all");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["auditLog"],
    queryFn: () => api.get<{ data: AuditEntry[] }>("/api/audit"),
    refetchInterval: 30_000,
  });

  const entries = data?.data || [];
  const actions = Array.from(new Set(entries.map((entry) => entry.action).filter(Boolean)));
  const filteredEntries = entries.filter((entry) => {
    const term = search.trim().toLowerCase();
    const haystack = [
      entry.actorId,
      entry.actorType,
      entry.action,
      entry.subjectType,
      entry.subjectId,
      entry.reason,
      entry.correlationId,
    ].join(" ").toLowerCase();
    return (!term || haystack.includes(term))
      && (actionFilter === "all" || entry.action === actionFilter);
  });
  const pageMeta = loadedListPaginationMeta(filteredEntries.length, page, PAGE_SIZE);
  const visibleEntries = filteredEntries.slice((pageMeta.page - 1) * PAGE_SIZE, pageMeta.page * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [search, actionFilter]);

  if (error) {
    return (
      <div className="p-4">
        <InlineError message="Không thể tải lịch sử thao tác" onRetry={() => refetch()} stale />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader title={t("audit.title")} />

      <FilterBar
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => { setSearch(""); setActionFilter("all"); }}
          >
            Xóa lọc
          </Button>
        }
      >
        <SearchBox value={search} onChange={setSearch} placeholder="Tìm actor, action, subject, correlation..." />
        <select
          value={actionFilter}
          onChange={(event) => setActionFilter(event.target.value)}
          className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
        >
          <option value="all">Tất cả hành động</option>
          {actions.map((action) => (
            <option key={action} value={action}>{action}</option>
          ))}
        </select>
      </FilterBar>

      <Panel title={t("audit.title")}>
        {isLoading ? (
          <TableSkeleton rows={8} cols={5} />
        ) : filteredEntries.length === 0 ? (
          <div className="p-6 text-center">
            <FileSearch size={32} className="text-text-muted mb-3 mx-auto" />
            <p className="text-sm font-medium text-text-secondary">
              {entries.length === 0 ? t("audit.empty") : t("state.noResults")}
            </p>
            <p className="text-xs text-text-muted mt-1">
              {entries.length === 0 ? t("audit.emptyExplanation") : "Điều chỉnh bộ lọc để xem thêm bản ghi."}
            </p>
          </div>
        ) : (
          <>
          <PaginatedListFrame
            label="Phân trang lịch sử thao tác"
            rowNoun="bản ghi audit"
            meta={pageMeta}
            onPageChange={setPage}
          >
            <OperationalTable
              ariaLabel={t("audit.title")}
              columns={[
                { key: "actor", label: "Người thực hiện" },
                { key: "action", label: "Hành động" },
                { key: "subject", label: "Đối tượng" },
                { key: "details", label: "Chi tiết" },
                { key: "time", label: "Thời gian" },
              ]}
              rows={visibleEntries.map((e) => ({
                actor: (
                  <div className="flex items-center gap-1">
                    <User size={12} className="text-text-muted" />
                    <span className="font-medium text-text-primary">{e.actorId}</span>
                    <span className="text-[10px] text-text-muted">({e.actorType})</span>
                  </div>
                ),
                action: <StatusPill tone="info" label={e.action} />,
                subject: (
                  <span className="font-mono text-xs">
                    {e.subjectType}/{e.subjectId?.slice(0, 8)}
                  </span>
                ),
                details: e.reason || e.correlationId?.slice(0, 8) || "-",
                time: (
                  <div className="flex items-center gap-1 text-xs text-text-muted">
                    <Clock size={10} />
                    {new Date(e.createdAt).toLocaleString("vi-VN")}
                  </div>
                ),
              }))}
            />
          </PaginatedListFrame>
          </>
        )}
      </Panel>
    </div>
  );
}
