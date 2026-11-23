import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { OperationalTable, PageHeader, Panel, ScreenState, StatusPill, TableSkeleton, FilterBar, SearchBox, Button, PaginatedListFrame, loadedListPaginationMeta } from "@medusa-snus/ui";
import { fetchSettingsAudit } from "../../api/settings-endpoints";
import { useSettingsOwner } from "./useSettingsOwner";

export default function SettingsAuditScreen() {
  const { merchantId, isOwner } = useSettingsOwner();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ["settingsAudit", merchantId], queryFn: () => fetchSettingsAudit(merchantId!), enabled: !!merchantId });
  const entries = (query.data?.data || []).filter((e) => !search || [e.actorId, e.action, e.subjectType, e.reason].join(" ").toLowerCase().includes(search.toLowerCase()));
  const pageMeta = loadedListPaginationMeta(entries.length, page, 20);
  const visibleEntries = entries.slice((pageMeta.page - 1) * 20, pageMeta.page * 20);
  useEffect(() => setPage(1), [merchantId, search]);
  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Lịch sử thao tác" subtitle="Ghi lại các thao tác cài đặt của merchant." status={!isOwner ? <StatusPill tone="info" label="Chỉ đọc" /> : undefined} />
      <FilterBar actions={<Button variant="secondary" size="sm" onClick={() => setSearch("")}>Xóa lọc</Button>}><SearchBox value={search} onChange={setSearch} placeholder="Tìm actor, hành động..." /></FilterBar>
      <Panel title="Bản ghi">
        {query.isLoading ? <TableSkeleton rows={8} cols={4} /> : query.error ? <div className="p-4"><ScreenState state="error" title="Không thể tải lịch sử" actionLabel="Thử lại" onAction={() => query.refetch()} /></div> : !entries.length ? <div className="p-4"><ScreenState state="empty" title="Chưa có bản ghi" /></div> : (
          <>
          <PaginatedListFrame
            label="Phân trang lịch sử cài đặt"
            rowNoun="bản ghi"
            meta={pageMeta}
            onPageChange={setPage}
          >
            <OperationalTable
              ariaLabel="Lịch sử cài đặt"
              columns={[
                { key: "actor", label: "Người" },
                { key: "action", label: "Hành động" },
                { key: "target", label: "Đối tượng" },
                { key: "time", label: "Thời gian" },
              ]}
              rows={visibleEntries.map((e) => ({
                actor: <span className="font-medium break-words">{e.actorId}</span>,
                action: <StatusPill tone="info" label={e.action} />,
                target: (
                  <span className="font-mono text-xs break-words">
                    {e.subjectType}/{(e.subjectId || "").slice(0, 8)}
                  </span>
                ),
                time: (
                  <span className="text-xs text-text-muted">
                    {new Date(e.createdAt).toLocaleString("vi-VN")}
                  </span>
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
