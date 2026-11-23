import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PaginatedListFrame, loadedListPaginationMeta, OperationalTable, PageHeader, Panel, ScreenState, StatusPill, TableSkeleton } from "@medusa-snus/ui";
import { fetchPaymentExceptions } from "../../api/settings-endpoints";
import { usePlatformAdmin } from "./usePlatformAdmin";

const STATUS_TONE: Record<string, "warning" | "success" | "info" | "danger"> = { pending_review: "warning", resolved: "success", waived: "info" };
const STATUS_LABEL: Record<string, string> = { pending_review: "Chờ xử lý", resolved: "Đã xử lý", waived: "Đã bỏ qua" };

export default function PlatformPaymentExceptionsScreen() {
  const { isPlatformAdmin } = usePlatformAdmin();
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ["paymentExceptions"], queryFn: fetchPaymentExceptions, enabled: isPlatformAdmin });
  const exceptions = query.data?.data || [];
  const pageMeta = loadedListPaginationMeta(exceptions.length, page, 20);
  const visibleExceptions = exceptions.slice((pageMeta.page - 1) * 20, pageMeta.page * 20);
  useEffect(() => setPage(1), [isPlatformAdmin]);
  if (!isPlatformAdmin) return <div className="p-4"><PageHeader title="Ngoại lệ thanh toán" /><ScreenState state="error" title="Không có quyền" /></div>;
  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Ngoại lệ thanh toán" subtitle="Các giao dịch cần xem xét thủ công: thiếu, thừa, sai đồng, callback thiếu terminal." />
      <Panel title="Danh sách ngoại lệ">
        {query.isLoading ? <TableSkeleton rows={6} cols={5} /> : query.error ? <div className="p-4"><ScreenState state="error" title="Không thể tải" actionLabel="Thử lại" onAction={() => query.refetch()} /></div> : !query.data?.data.length ? <div className="p-4"><ScreenState state="empty" title="Không có ngoại lệ" /></div> : (
          <div>
          <PaginatedListFrame
            label="Phân trang ngoại lệ thanh toán"
            rowNoun="ngoại lệ"
            meta={pageMeta}
            onPageChange={setPage}
          >
            <OperationalTable
              ariaLabel="Ngoại lệ thanh toán"
              columns={[
                { key: "id", label: "ID" },
                { key: "provider", label: "Provider" },
                { key: "ref", label: "Provider ref" },
                { key: "issue", label: "Vấn đề" },
                { key: "status", label: "Trạng thái" },
                { key: "created", label: "Tạo lúc" },
              ]}
              rows={visibleExceptions.map((e) => ({
                id: <span className="font-mono text-xs break-all">{e.exceptionId}</span>,
                provider: <span className="break-words">{e.providerKey}</span>,
                ref: <span className="font-mono text-xs break-all">{e.providerRef}</span>,
                issue: <span className="break-words text-sm">{e.issue}</span>,
                status: (
                  <StatusPill
                    tone={STATUS_TONE[e.status] || "info"}
                    label={STATUS_LABEL[e.status] || e.status}
                  />
                ),
                created: (
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
