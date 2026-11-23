import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, FilterBar, PaginatedListFrame, loadedListPaginationMeta, OperationalTable, PageHeader, Panel, ScreenState, StatusPill, TableSkeleton, SearchBox } from "@medusa-snus/ui";
import { fetchPlatformAudit } from "../../api/settings-endpoints";
import { usePlatformAdmin } from "./usePlatformAdmin";

export default function PlatformAuditScreen() {
  const { isPlatformAdmin } = usePlatformAdmin();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ["platformAudit"], queryFn: fetchPlatformAudit, enabled: isPlatformAdmin });
  const entries = (query.data?.data || []).filter((e) => !search || [e.actorId, e.action, e.subjectType].join(" ").toLowerCase().includes(search.toLowerCase()));
  const pageMeta = loadedListPaginationMeta(entries.length, page, 20);
  const visibleEntries = entries.slice((pageMeta.page - 1) * 20, pageMeta.page * 20);
  useEffect(() => setPage(1), [search]);
  if (!isPlatformAdmin) return <div className="p-4"><PageHeader title="Lịch sử platform" /><ScreenState state="error" title="Không có quyền" /></div>;
  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Lịch sử thao tác platform" subtitle="Ghi lại các thao tác của platform admin và sự kiện hệ thống." />
      <FilterBar actions={<Button variant="secondary" size="sm" onClick={() => setSearch("")}>Xóa lọc</Button>}><SearchBox value={search} onChange={setSearch} placeholder="Tìm actor, hành động..." /></FilterBar>
      <Panel title="Bản ghi">
        {query.isLoading ? <TableSkeleton rows={8} cols={4} /> : query.error ? <div className="p-4"><ScreenState state="error" title="Không thể tải lịch sử" actionLabel="Thử lại" onAction={() => query.refetch()} /></div> : !entries.length ? <div className="p-4"><ScreenState state="empty" title="Chưa có bản ghi" /></div> : (
          <div>
          <PaginatedListFrame
            label="Phân trang lịch sử platform"
            rowNoun="bản ghi"
            meta={pageMeta}
            onPageChange={setPage}
          >
            <OperationalTable
              ariaLabel="Lịch sử platform"
              columns={[
                { key: "actor", label: "Actor" },
                { key: "action", label: "Action" },
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
          </div>
        )}
      </Panel>
    </div>
  );
}
