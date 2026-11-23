import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchStockMovements } from "../api/endpoints";
import { InlineError, PaginatedListFrame, loadedListPaginationMeta, Panel, TableSkeleton } from "@medusa-snus/ui";
import { ArrowDown, ArrowUp } from "lucide-react";

interface StockMovementLogProps {
  productId?: string;
  limit?: number;
}

const TYPE_LABELS: Record<string, string> = {
  sale: "Bán hàng",
  purchase_receipt: "Nhập hàng",
  manual_adjustment: "Điều chỉnh",
};

export function StockMovementLog({ productId, limit = 10 }: StockMovementLogProps) {
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["stockMovements", productId],
    queryFn: () => fetchStockMovements(productId),
    refetchInterval: 15_000,
  });

  const movements = (data?.data || []) as Array<{
    id: string; movementType: string; quantityChange: number;
    quantityAfter: number; reason?: string; referenceType?: string; referenceId?: string; performedBy: string; createdAt: string;
  }>;
  const pageMeta = loadedListPaginationMeta(movements.length, page, limit);
  const visibleMovements = movements.slice((pageMeta.page - 1) * limit, pageMeta.page * limit);

  useEffect(() => {
    setPage(1);
  }, [productId]);

  return (
    <Panel title="Biến động gần đây">
      <PaginatedListFrame
        label="Phân trang biến động tồn kho"
        rowNoun="movement"
        meta={pageMeta}
        onPageChange={setPage}
        showPagination={Boolean(!isLoading && !error && movements.length > 0)}
      >
        <div className="space-y-1 max-h-64 overflow-auto p-2">
          {isLoading ? (
            <TableSkeleton rows={4} cols={3} />
          ) : error ? (
            <InlineError message="Không thể tải biến động tồn kho" onRetry={() => refetch()} stale />
          ) : (
            visibleMovements.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between rounded border border-border-default px-3 py-1.5 text-xs"
              >
                <div className="flex items-center gap-2">
                  {m.quantityChange > 0 ? (
                    <ArrowUp size={12} className="text-status-success" />
                  ) : (
                    <ArrowDown size={12} className="text-status-danger" />
                  )}
                  <span className="text-text-secondary">
                    {TYPE_LABELS[m.movementType] || m.movementType}
                  </span>
                  {m.reason && (
                    <span
                      className={
                        m.reason === "Tìm thấy" ? "font-medium text-status-warning" : "text-text-muted"
                      }
                    >
                      {m.reason}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-text-muted">
                  <span
                    className={
                      m.quantityChange > 0
                        ? "text-status-success font-medium tabular-nums"
                        : "text-status-danger font-medium tabular-nums"
                    }
                  >
                    {m.quantityChange > 0 ? "+" : ""}
                    {m.quantityChange}
                  </span>
                  <span>Còn {m.quantityAfter}</span>
                  {m.referenceType === "order_found_stock" && m.referenceId && (
                    <span className="hidden max-w-[7rem] truncate sm:inline">Đơn {m.referenceId}</span>
                  )}
                  <span>
                    {new Date(m.createdAt).toLocaleTimeString("vi-VN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
              </div>
            ))
          )}
          {!isLoading && !error && movements.length === 0 && (
            <p className="py-4 text-center text-xs text-text-muted">Chưa có biến động</p>
          )}
        </div>
      </PaginatedListFrame>
    </Panel>
  );
}
