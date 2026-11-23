import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Download, RefreshCw, SlidersHorizontal } from "lucide-react";
import { Button, Drawer, FilterBar, InlineError, PaginatedListFrame, OperationalTable, TableSkeleton } from "@medusa-snus/ui";
import { downloadStockMovementHistoryCsv, fetchStockMovements } from "../api/endpoints";
import type { InventoryItem, StockMovementFilters, StockMovementItem, StockMovementsResponse } from "../api/client";

interface StockHistoryDrawerProps {
  open: boolean;
  item: InventoryItem | null;
  onClose: () => void;
  onAdjust: (item: InventoryItem) => void;
}

const SOURCE_ACTION_LABELS: Record<string, string> = {
  pos_sale: "Bán tại quầy",
  remote_sale: "Bán từ xa",
  telegram_sale: "Bán qua Telegram",
  scan_go_checkout: "Scan & Go",
  stash_dash_sale: "Stash Dash",
  po_receive: "Nhận PO",
  manual_adjustment: "Điều chỉnh tay",
  csv_import: "Import CSV",
  cycle_count: "Kiểm kê",
  found_stock: "Tìm thấy tồn",
  order_cancel: "Hủy đơn",
  order_correction: "Sửa đơn",
};

const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  sale: "Bán hàng",
  purchase_receipt: "Nhập hàng",
  manual_adjustment: "Điều chỉnh",
  return: "Hoàn/khôi phục",
};

const ACTION_FILTERS = [
  { value: "all", label: "Tất cả action" },
  { value: "pos_sale", label: SOURCE_ACTION_LABELS.pos_sale },
  { value: "remote_sale", label: SOURCE_ACTION_LABELS.remote_sale },
  { value: "telegram_sale", label: SOURCE_ACTION_LABELS.telegram_sale },
  { value: "scan_go_checkout", label: SOURCE_ACTION_LABELS.scan_go_checkout },
  { value: "po_receive", label: SOURCE_ACTION_LABELS.po_receive },
  { value: "manual_adjustment", label: SOURCE_ACTION_LABELS.manual_adjustment },
  { value: "csv_import", label: SOURCE_ACTION_LABELS.csv_import },
  { value: "cycle_count", label: SOURCE_ACTION_LABELS.cycle_count },
  { value: "found_stock", label: SOURCE_ACTION_LABELS.found_stock },
  { value: "order_cancel", label: SOURCE_ACTION_LABELS.order_cancel },
  { value: "order_correction", label: SOURCE_ACTION_LABELS.order_correction },
];

function currentStock(item: InventoryItem | null): number {
  return Number(item?.location_levels?.[0]?.stocked_quantity ?? 0);
}

function formatDelta(value: number): string {
  return `${value > 0 ? "+" : ""}${value}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function actionLabel(movement: StockMovementItem): string {
  return SOURCE_ACTION_LABELS[movement.sourceAction] || MOVEMENT_TYPE_LABELS[movement.movementType] || movement.sourceAction || movement.movementType;
}

function SummaryCell({ label, value, tone }: { label: string; value: string | number; tone?: "success" | "danger" | "warning" }) {
  const toneClass = tone === "success"
    ? "text-status-success"
    : tone === "danger"
    ? "text-status-danger"
    : tone === "warning"
    ? "text-status-warning"
    : "text-text-primary";
  return (
    <div className="min-w-[7rem] border-r border-border-subtle px-3 py-2 last:border-r-0">
      <p className="text-xs text-text-muted">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}

export function StockHistoryDrawer({ open, item, onClose, onAdjust }: StockHistoryDrawerProps) {
  const [direction, setDirection] = useState<"all" | "in" | "out">("all");
  const [sourceAction, setSourceAction] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [cursorsByPage, setCursorsByPage] = useState<Record<number, string | undefined>>({ 1: undefined });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const baseFilters = useMemo<StockMovementFilters>(() => ({
    inventoryItemId: item?.id,
    direction: direction === "all" ? undefined : direction,
    sourceAction: sourceAction === "all" ? undefined : sourceAction,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    limit: 50,
  }), [dateFrom, dateTo, direction, item?.id, sourceAction]);

  const filterKey = useMemo(() => JSON.stringify(baseFilters), [baseFilters]);
  const requestFilters = useMemo<StockMovementFilters>(() => ({
    ...baseFilters,
    cursor: cursorsByPage[page],
  }), [baseFilters, cursorsByPage, page]);

  const historyQuery = useQuery<StockMovementsResponse>({
    queryKey: ["stockMovementHistory", filterKey, page, cursorsByPage[page]],
    queryFn: () => fetchStockMovements(requestFilters),
    enabled: open && Boolean(item?.id),
    refetchInterval: open ? 15_000 : false,
  });

  useEffect(() => {
    setPage(1);
    setCursorsByPage({ 1: undefined });
  }, [filterKey]);

  useEffect(() => {
    if (!open) {
      setPage(1);
      setCursorsByPage({ 1: undefined });
      setExportError(null);
    }
  }, [open]);

  const summary = historyQuery.data?.summary;
  const pagination = historyQuery.data?.pagination;
  const rows = historyQuery.data?.data || [];
  const pageSize = baseFilters.limit || 50;
  const pageMeta = {
    page,
    start: rows.length === 0 ? 0 : (page - 1) * pageSize + 1,
    end: rows.length === 0 ? 0 : (page - 1) * pageSize + rows.length,
    hasPrevious: page > 1,
    hasNext: Boolean(pagination?.hasMore && pagination.nextCursor),
    totalKind: "unknown" as const,
  };
  const title = item?.title || item?.sku || "Sản phẩm";
  const sku = item?.sku || "";
  const reconciled = summary?.reconciledToCurrentStock;
  const stockNow = currentStock(item);

  async function handleExport() {
    if (!item?.id) return;
    setExporting(true);
    setExportError(null);
    try {
      await downloadStockMovementHistoryCsv({ ...baseFilters, cursor: undefined });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Không thể xuất lịch sử tồn kho.");
    } finally {
      setExporting(false);
    }
  }

  function clearFilters() {
    setDirection("all");
    setSourceAction("all");
    setDateFrom("");
    setDateTo("");
  }

  return (
    <Drawer
      open={open}
      size="wide"
      title={`Lịch sử tồn kho - ${title}`}
      subtitle={sku ? <span className="font-mono">SKU {sku}</span> : undefined}
      onClose={onClose}
      headerActions={
        <>
          <Button
            variant="secondary"
            size="sm"
            icon={<Download size={14} aria-hidden="true" />}
            onClick={handleExport}
            disabled={!item || exporting}
          >
            {exporting ? "Đang xuất" : "Xuất CSV"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<SlidersHorizontal size={14} aria-hidden="true" />}
            onClick={() => item && onAdjust(item)}
            disabled={!item}
          >
            Điều chỉnh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={14} aria-hidden="true" />}
            aria-label="Tải lại lịch sử tồn kho"
            onClick={() => void historyQuery.refetch()}
            disabled={historyQuery.isFetching}
          />
        </>
      }
    >
      <div className="space-y-4">
        <div className="overflow-hidden rounded-md border border-border-default">
          <div className="flex flex-wrap bg-surface-subtle">
            <SummaryCell label="Tồn hiện tại" value={stockNow} />
            <SummaryCell label="Tăng" value={`+${summary?.totalIn ?? 0}`} tone="success" />
            <SummaryCell label="Giảm" value={`-${summary?.totalOut ?? 0}`} tone="danger" />
            <SummaryCell
              label="Net"
              value={formatDelta(summary?.netChange ?? 0)}
              tone={(summary?.netChange ?? 0) < 0 ? "danger" : (summary?.netChange ?? 0) > 0 ? "success" : undefined}
            />
            <SummaryCell label="Số movement" value={summary?.movementCount ?? 0} />
            <SummaryCell
              label="Đối soát"
              value={reconciled === null || reconciled === undefined ? "Chưa có" : reconciled ? "Khớp" : "Lệch"}
              tone={reconciled === false ? "warning" : undefined}
            />
          </div>
        </div>

        {reconciled === false && (
          <InlineError
            message={`Cảnh báo đối soát: movement mới nhất không khớp tồn hiện tại. Latest movement ${summary?.latestQuantityAfter ?? "-"}, tồn hiện tại ${summary?.currentStock ?? stockNow}.`}
            stale
          />
        )}

        {exportError && <InlineError message={exportError} stale />}

        <FilterBar
          actions={
            <Button variant="secondary" size="sm" onClick={clearFilters}>
              Xóa lọc
            </Button>
          }
        >
          <select
            aria-label="Lọc chiều biến động"
            value={direction}
            onChange={(event) => setDirection(event.target.value as "all" | "in" | "out")}
            className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
          >
            <option value="all">Tăng và giảm</option>
            <option value="in">Chỉ tăng</option>
            <option value="out">Chỉ giảm</option>
          </select>
          <select
            aria-label="Lọc action tồn kho"
            value={sourceAction}
            onChange={(event) => setSourceAction(event.target.value)}
            className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
          >
            {ACTION_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <input
            aria-label="Từ ngày"
            type="date"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
            className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
          />
          <input
            aria-label="Đến ngày"
            type="date"
            value={dateTo}
            onChange={(event) => setDateTo(event.target.value)}
            className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
          />
        </FilterBar>

        <PaginatedListFrame
          label="Phân trang lịch sử tồn kho"
          rowNoun="movement"
          meta={pageMeta}
          busy={historyQuery.isFetching}
          onPageChange={(nextPage) => {
            if (nextPage < page) {
              setPage(nextPage);
              return;
            }
            if (!pagination?.nextCursor) return;
            setCursorsByPage((current) => ({
              ...current,
              [nextPage]: pagination.nextCursor || undefined,
            }));
            setPage(nextPage);
          }}
          showPagination={Boolean(!historyQuery.error)}
        >
          {historyQuery.isLoading && rows.length === 0 ? (
            <TableSkeleton rows={6} cols={6} />
          ) : historyQuery.error ? (
            <InlineError
              message="Không thể tải lịch sử tồn kho"
              onRetry={() => void historyQuery.refetch()}
              stale
            />
          ) : rows.length === 0 ? (
            <div className="rounded-md border border-border-default p-6 text-center text-sm text-text-muted">
              Chưa có movement phù hợp.
            </div>
          ) : (
            <OperationalTable
              ariaLabel="Lịch sử thay đổi tồn kho"
              minWidth={980}
              columns={[
                { key: "time", label: "Thời gian", width: 150 },
                { key: "action", label: "Action", width: 170 },
                { key: "delta", label: "Thay đổi", align: "right", width: 110 },
                { key: "stock", label: "Trước -> sau", align: "right", width: 130 },
                { key: "actor", label: "User", width: 170 },
                { key: "reference", label: "Nguồn", width: 190 },
                { key: "reason", label: "Lý do" },
              ]}
              rows={rows.map((movement) => ({
                time: (
                  <span className="text-xs text-text-secondary">
                    {formatDateTime(movement.createdAt)}
                  </span>
                ),
                action: (
                  <div className="flex items-center gap-2">
                    {movement.quantityChange > 0 ? (
                      <ArrowUp size={14} className="shrink-0 text-status-success" aria-hidden="true" />
                    ) : (
                      <ArrowDown size={14} className="shrink-0 text-status-danger" aria-hidden="true" />
                    )}
                    <span className="whitespace-normal break-words text-sm font-medium text-text-primary">
                      {actionLabel(movement)}
                    </span>
                  </div>
                ),
                delta: (
                  <span
                    className={
                      movement.quantityChange > 0
                        ? "font-semibold tabular-nums text-status-success"
                        : "font-semibold tabular-nums text-status-danger"
                    }
                  >
                    {formatDelta(movement.quantityChange)}
                  </span>
                ),
                stock: (
                  <span className="tabular-nums">
                    {movement.quantityBefore} -&gt; {movement.quantityAfter}
                  </span>
                ),
                actor: (
                  <div className="min-w-0">
                    <p className="truncate text-sm text-text-primary">
                      {movement.actorDisplayName || movement.performedBy || "-"}
                    </p>
                    {movement.actorRole && (
                      <p className="truncate text-xs text-text-muted">{movement.actorRole}</p>
                    )}
                  </div>
                ),
                reference: (
                  <div className="min-w-0">
                    <p className="truncate text-sm text-text-primary">
                      {movement.referenceDisplay || movement.referenceId || "-"}
                    </p>
                    {movement.referenceType && (
                      <p className="truncate text-xs text-text-muted">{movement.referenceType}</p>
                    )}
                  </div>
                ),
                reason: (
                  <span className="whitespace-normal break-words text-sm text-text-secondary">
                    {movement.reason || movement.reasonCode || "-"}
                  </span>
                ),
              }))}
            />
          )}
        </PaginatedListFrame>
      </div>
    </Drawer>
  );
}
