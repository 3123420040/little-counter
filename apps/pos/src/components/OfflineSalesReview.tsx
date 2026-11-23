import { useState } from "react";
import { Button, Drawer, InlineError, PaginatedListFrame, localListPaginationMeta } from "@medusa-snus/ui";
import type { QueuedSale } from "../utils/offlineQueue";

export function OfflineSalesReview({ sales, ready, onClose, onRetry }: {
  sales: QueuedSale[];
  ready: (sale: QueuedSale) => boolean;
  onClose: () => void;
  onRetry: (sale: QueuedSale) => Promise<void>;
}) {
  const [page, setPage] = useState(1);
  const meta = localListPaginationMeta(sales.length, page, 20);
  const visibleSales = sales.slice((meta.page - 1) * 20, meta.page * 20);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  return <Drawer open title="Đơn chờ đồng bộ" onClose={onClose}>
    <div className="space-y-4 p-4">
      {error && <InlineError message={error} onRetry={() => setError("")} />}
      {!sales.length && <p>Không còn đơn chờ xử lý trong phiên bán hàng này.</p>}
      <PaginatedListFrame label="Phân trang đơn chờ đồng bộ" rowNoun="đơn" meta={meta} onPageChange={setPage} busy={Boolean(busy)}>
      {visibleSales.map((sale) => <div key={sale.id} className="rounded border border-border-default p-3 space-y-2">
        <p>{new Date(sale.createdAt).toLocaleString("vi-VN")} · {sale.payload.items.length} dòng sản phẩm</p>
        <p className="text-sm">Cửa hàng: {sale.scope?.storeId || "Chưa xác định"} · {sale.payload.paymentMethod} · Số tiền nhập: {(sale.payload.amountReceived || 0).toLocaleString("vi-VN")} ₫</p>
        <details><summary>Chi tiết sản phẩm đã lưu</summary>{sale.payload.items.map((item) => <p key={item.variantId}>{item.variantId} · số lượng {item.quantity}</p>)}</details>
        <p className="text-sm">{sale.lastError || "Đang chờ gửi đến cửa hàng đã lưu đơn."}</p>
        <p className="text-sm">Chọn lại đúng cửa hàng đã lưu đơn và kiểm tra tồn kho trước khi thử lại. Giữ đơn này cho đến khi có kết quả từ server; không tạo đơn thay thế khi chưa kiểm tra lịch sử.</p>
        <Button disabled={Boolean(busy) || !ready(sale)} onClick={async () => {
          setBusy(sale.id); setError("");
          try { await onRetry(sale); }
          catch (failure) { setError(failure instanceof Error ? failure.message : "Chưa thể đồng bộ, đơn vẫn được giữ lại."); }
          finally { setBusy(null); }
        }}>{busy === sale.id ? "Đang kiểm tra…" : "Kiểm tra và thử đồng bộ lại"}</Button>
      </div>)}
      </PaginatedListFrame>
    </div>
  </Drawer>;
}
