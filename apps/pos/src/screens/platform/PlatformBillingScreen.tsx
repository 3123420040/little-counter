import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PaginatedListFrame, loadedListPaginationMeta, OperationalTable, PageHeader, Panel, ScreenState, StatusPill, TableSkeleton } from "@medusa-snus/ui";
import { fetchPlatformBillingOrders } from "../../api/settings-endpoints";
import { usePlatformAdmin } from "./usePlatformAdmin";

function formatVnd(v?: string) { if (!v) return "—"; const n = Number(v); return Number.isFinite(n) ? n.toLocaleString("vi-VN") + "₫" : v; }
const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info"> = { paid: "success", applied: "success", waiting_payment: "warning", manual_review: "danger", failed: "danger", expired: "danger", cancelled: "warning", draft: "info" };

export default function PlatformBillingScreen() {
  const { isPlatformAdmin } = usePlatformAdmin();
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ["platformBilling"], queryFn: fetchPlatformBillingOrders, enabled: isPlatformAdmin });
  const billingOrders = query.data?.data || [];
  const pageMeta = loadedListPaginationMeta(billingOrders.length, page, 20);
  const visibleBillingOrders = billingOrders.slice((pageMeta.page - 1) * 20, pageMeta.page * 20);
  useEffect(() => setPage(1), [isPlatformAdmin]);
  if (!isPlatformAdmin) return <div className="p-4"><PageHeader title="Gói & Billing" /><ScreenState state="error" title="Không có quyền" /></div>;
  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Gói & Billing" subtitle="Đơn billing gói và trạng thái áp dụng. Không kết hợp tài chính chéo merchant." />
      <Panel title="Đơn billing">
        {query.isLoading ? <TableSkeleton rows={6} cols={6} /> : query.error ? <div className="p-4"><ScreenState state="error" title="Không thể tải" actionLabel="Thử lại" onAction={() => query.refetch()} /></div> : !query.data?.data.length ? <div className="p-4"><ScreenState state="empty" title="Chưa có đơn billing" /></div> : (
          <div>
          <PaginatedListFrame
            label="Phân trang đơn billing"
            rowNoun="đơn billing"
            meta={pageMeta}
            onPageChange={setPage}
          >
            <OperationalTable
              ariaLabel="Đơn billing gói"
              columns={[
                { key: "id", label: "ID" },
                { key: "merchant", label: "Merchant" },
                { key: "purpose", label: "Mục đích" },
                { key: "amount", label: "Số tiền" },
                { key: "status", label: "Trạng thái" },
                { key: "applied", label: "Áp dụng lúc" },
              ]}
              rows={visibleBillingOrders.map((b) => ({
                id: <span className="font-mono text-xs break-all">{b.billingOrderId}</span>,
                merchant: <span className="break-words">{b.merchantName}</span>,
                purpose: <StatusPill tone="info" label={b.purpose} />,
                amount: <span className="tabular-nums">{formatVnd(b.amountVnd)}</span>,
                status: <StatusPill tone={STATUS_TONE[b.status] || "info"} label={b.status} />,
                applied: b.appliedAt ? (
                  <span className="text-xs text-text-muted">
                    {new Date(b.appliedAt).toLocaleString("vi-VN")}
                  </span>
                ) : (
                  <span className="text-text-muted">—</span>
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
