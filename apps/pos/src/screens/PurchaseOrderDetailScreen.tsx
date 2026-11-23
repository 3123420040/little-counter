import { useMemo, useState } from "react";
import { useOffsetListPagination } from "../hooks/useOffsetListPagination";
import { useNavigate, useParams } from "react-router-dom";
import {
  Button, ConfirmDialog, Drawer, InlineError, MetricCell, MutationBanner,
  PaginatedListFrame, localListPaginationMeta, OperationalTable, PageHeader, Panel, ResponsiveMetricGrid, SearchBox, StatusPill, TableSkeleton,
} from "@medusa-snus/ui";
import {
  useCancelPurchaseOrder,
  useCloseShortPurchaseOrder,
  usePurchaseOrderDetail,
  useReceivePurchaseOrder,
  useSendPurchaseOrder,
} from "../hooks/useInventory";
import { createClientIdempotencyKey, downloadPurchaseOrderDetailCsv, type PurchaseOrderDetail } from "../api/endpoints";
import { ArrowLeft, CheckCircle2, Download, PackageCheck, Send, XCircle } from "lucide-react";
import {
  clearPurchaseOrderPageQuantities,
  DETAIL_PURCHASE_ORDER_PAGE_SIZE,
  fillPurchaseOrderPageRemaining,
  filterPurchaseOrderDetailLines,
  filterPurchaseOrderReceiveLines,
  paginatePurchaseOrderLines,
  purchaseOrderReceiveSelectionSummary,
  RECEIVE_PURCHASE_ORDER_PAGE_SIZE,
  type PurchaseOrderDetailLineFilter,
  type PurchaseOrderReceiveLineFilter,
} from "../utils/purchaseOrderReceivingUi";

type Notice = { tone: "success" | "error" | "pending"; message: string };
type ConfirmAction = "send" | "cancel" | "close_short";
const RECEIPT_ITEM_PAGE_SIZE = 10;

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  received: "success",
  partially_received: "warning",
  sent: "info",
  draft: "warning",
  cancelled: "danger",
  closed_short: "neutral",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Nháp",
  sent: "Đã gửi NCC",
  partially_received: "Nhận một phần",
  received: "Đã nhận đủ",
  cancelled: "Đã hủy",
  closed_short: "Đóng thiếu",
};

const LINE_STATUS_LABEL: Record<string, string> = {
  not_received: "Chưa nhận",
  pending: "Chưa nhận",
  partially_received: "Nhận một phần",
  received: "Đã nhận đủ",
  short_closed: "Đóng thiếu",
};

function formatVnd(amount?: number | null) {
  return `${Number(amount || 0).toLocaleString("vi-VN")} ₫`;
}

function formatQty(amount?: number | null) {
  return Number(amount || 0).toLocaleString("vi-VN");
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
}

function canReceiveStatus(status: string) {
  return status === "draft" || status === "sent" || status === "partially_received";
}

function receiveValidationError(detail: PurchaseOrderDetail | null, quantities: Record<string, string>) {
  if (!detail) return "Không có dữ liệu đơn.";
  let hasQuantity = false;
  for (const item of detail.items) {
    const raw = quantities[item.id]?.trim();
    if (!raw) continue;
    const qty = Number(raw);
    if (!Number.isInteger(qty) || qty <= 0) return "Số nhận phải là số nguyên dương.";
    if (qty > item.remainingQuantity) return `SKU ${item.sku} vượt số lượng còn lại.`;
    hasQuantity = true;
  }
  return hasQuantity ? "" : "Nhập số lượng nhận cho ít nhất một SKU.";
}

export default function PurchaseOrderDetailScreen() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [receiptPage, setReceiptPage] = useState(1);
  const [expandedReceiptId, setExpandedReceiptId] = useState<string | null>(null);
  const [receiptItemPages, setReceiptItemPages] = useState<Record<string, number>>({});
  const { data: detailData, isLoading, error, refetch } = usePurchaseOrderDetail(id, receiptPage, 10);
  const receiveMutation = useReceivePurchaseOrder();
  const sendMutation = useSendPurchaseOrder();
  const cancelMutation = useCancelPurchaseOrder();
  const closeShortMutation = useCloseShortPurchaseOrder();

  const [notice, setNotice] = useState<Notice | null>(null);
  const [csvPending, setCsvPending] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveQuantities, setReceiveQuantities] = useState<Record<string, string>>({});
  const [receiveNote, setReceiveNote] = useState("");
  const [detailSearch, setDetailSearch] = useState("");
  const [detailFilter, setDetailFilter] = useState<PurchaseOrderDetailLineFilter>("all");
  const [detailPage, setDetailPage] = useState(1);
  const [receiveSearch, setReceiveSearch] = useState("");
  const [receiveFilter, setReceiveFilter] = useState<PurchaseOrderReceiveLineFilter>("all");
  const [receivePage, setReceivePage] = useState(1);
  const [receiveIntentKey, setReceiveIntentKey] = useState("");
  const [receiveInlineError, setReceiveInlineError] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [actionText, setActionText] = useState("");

  const detail = detailData?.data || null;
  const { meta: receiptMeta, correcting: receiptCorrecting } = useOffsetListPagination(
    error ? undefined : detail?.receiptPage.total, receiptPage, detail?.receiptPage.limit || 10, setReceiptPage,
  );
  const remainingLines = useMemo(
    () => (detail?.items || []).filter((item) => item.remainingQuantity > 0),
    [detail],
  );
  const filteredDetailLines = useMemo(
    () => filterPurchaseOrderDetailLines(detail?.items || [], detailSearch, detailFilter),
    [detail, detailFilter, detailSearch],
  );
  const detailLinesPage = useMemo(
    () => paginatePurchaseOrderLines(filteredDetailLines, detailPage, DETAIL_PURCHASE_ORDER_PAGE_SIZE),
    [detailPage, filteredDetailLines],
  );
  const filteredReceiveLines = useMemo(
    () => filterPurchaseOrderReceiveLines(detail?.items || [], receiveSearch, receiveFilter, receiveQuantities),
    [detail, receiveFilter, receiveQuantities, receiveSearch],
  );
  const receiveLinesPage = useMemo(
    () => paginatePurchaseOrderLines(filteredReceiveLines, receivePage, RECEIVE_PURCHASE_ORDER_PAGE_SIZE),
    [filteredReceiveLines, receivePage],
  );
  const receiveSelection = useMemo(
    () => purchaseOrderReceiveSelectionSummary(detail?.items || [], receiveQuantities),
    [detail, receiveQuantities],
  );
  const receiveError = useMemo(
    () => receiveValidationError(detail, receiveQuantities),
    [detail, receiveQuantities],
  );
  const selectedReceiveItems = useMemo(() => {
    if (!detail) return [];
    return detail.items
      .map((item) => ({ purchaseOrderItemId: item.id, receivedQuantity: Number(receiveQuantities[item.id] || 0) }))
      .filter((item) => item.receivedQuantity > 0);
  }, [detail, receiveQuantities]);

  if (error) {
    return (
      <div className="p-4">
        <InlineError message="Không thể tải chi tiết đơn đặt hàng" onRetry={() => refetch()} stale />
      </div>
    );
  }

  function openReceiveDrawer(itemId?: string) {
    if (!detail) return;
    const requestedItem = itemId ? detail.items.find((item) => item.id === itemId) : undefined;
    const next: Record<string, string> = {};
    for (const item of detail.items) {
      if (requestedItem && item.id === requestedItem.id && item.remainingQuantity > 0) {
        next[item.id] = String(item.remainingQuantity);
      } else {
        next[item.id] = "";
      }
    }
    setReceiveQuantities(next);
    setReceiveNote("");
    setReceiveSearch(requestedItem?.sku || requestedItem?.productName || "");
    setReceiveFilter(requestedItem ? "selected" : "all");
    setReceivePage(1);
    setReceiveIntentKey(createClientIdempotencyKey("po-receive"));
    setReceiveInlineError("");
    setReceiveOpen(true);
  }

  function abandonReceiveIntent() {
    if (receiveMutation.isPending) return;
    setReceiveOpen(false);
    setReceiveIntentKey("");
    setReceiveInlineError("");
  }

  function fillVisibleRemainingQuantities() {
    setReceiveQuantities((current) => fillPurchaseOrderPageRemaining(current, receiveLinesPage.items));
  }

  function clearVisibleQuantities() {
    setReceiveQuantities((current) => clearPurchaseOrderPageQuantities(current, receiveLinesPage.items));
  }

  function openConfirmAction(action: ConfirmAction) {
    setActionText("");
    setConfirmAction(action);
  }

  async function handleReceive() {
    if (!detail || receiveError || !receiveIntentKey) return;
    setReceiveInlineError("");
    setNotice({ tone: "pending", message: "Đang ghi nhận hàng nhận..." });
    try {
      const result = await receiveMutation.mutateAsync({
        poId: detail.id,
        data: {
          note: receiveNote.trim() || undefined,
          items: selectedReceiveItems,
        },
        intentKey: receiveIntentKey,
      });
      const receiptId = result.data.receipt?.id;
      const receivedAt = formatDateTime(new Date().toISOString());
      setNotice({
        tone: "success",
        message: receiptId
          ? `Đã ghi nhận receipt ${receiptId} lúc ${receivedAt}.`
          : `Đã ghi nhận receipt nhập kho lúc ${receivedAt}.`,
      });
      setReceiveOpen(false);
      setReceiveNote("");
      setReceiveQuantities({});
      setReceiveSearch("");
      setReceiveFilter("all");
      setReceivePage(1);
      setReceiveIntentKey("");
      setReceiveInlineError("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không thể ghi nhận hàng nhận.";
      setReceiveInlineError(message);
      setNotice({
        tone: "error",
        message,
      });
    }
  }

  async function handleDownloadDetailCsv() {
    if (!detail) return;
    setCsvPending(true);
    setNotice({ tone: "pending", message: "Đang xuất chi tiết đơn đặt hàng..." });
    try {
      await downloadPurchaseOrderDetailCsv(detail.id);
      setNotice({ tone: "success", message: "Đã tải CSV chi tiết đơn đặt hàng." });
    } catch (err) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể xuất chi tiết đơn đặt hàng.",
      });
    } finally {
      setCsvPending(false);
    }
  }

  async function handleConfirmAction() {
    if (!detail || !confirmAction) return;
    setNotice({ tone: "pending", message: "Đang cập nhật trạng thái đơn đặt hàng..." });
    try {
      if (confirmAction === "send") {
        await sendMutation.mutateAsync({ poId: detail.id, data: { note: actionText.trim() || undefined } });
        setNotice({ tone: "success", message: "Đã chuyển đơn sang trạng thái đã gửi nhà cung cấp." });
      } else if (confirmAction === "cancel") {
        await cancelMutation.mutateAsync({ poId: detail.id, data: { reason: actionText.trim() } });
        setNotice({ tone: "success", message: "Đã hủy đơn đặt hàng." });
      } else {
        await closeShortMutation.mutateAsync({ poId: detail.id, data: { reason: actionText.trim() } });
        setNotice({ tone: "success", message: "Đã đóng thiếu đơn đặt hàng." });
      }
      setConfirmAction(null);
      setActionText("");
    } catch (err) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể cập nhật trạng thái.",
      });
    }
  }

  const confirmMeta = confirmAction === "send"
    ? {
      title: "Chuyển sang đã gửi?",
      message: "Trạng thái này ghi nhận thời điểm gửi đơn cho nhà cung cấp.",
      label: "Đã gửi NCC",
      textareaLabel: "Ghi chú",
      danger: false,
      disabled: false,
      pending: sendMutation.isPending,
    }
    : confirmAction === "cancel"
      ? {
        title: "Hủy đơn đặt hàng?",
        message: "Chỉ hủy đơn khi chưa nhận hàng.",
        label: "Hủy đơn",
        textareaLabel: "Lý do hủy",
        danger: true,
        disabled: !actionText.trim(),
        pending: cancelMutation.isPending,
      }
      : {
        title: "Đóng thiếu đơn đặt hàng?",
        message: "Dùng khi đã nhận một phần và không tiếp tục chờ phần còn lại.",
        label: "Đóng thiếu",
        textareaLabel: "Lý do đóng thiếu",
        danger: false,
        disabled: !actionText.trim(),
        pending: closeShortMutation.isPending,
      };

  const canReceive = !!detail && canReceiveStatus(detail.status) && remainingLines.length > 0;
  const canCancel = !!detail && (detail.status === "draft" || detail.status === "sent") && (detail.totals?.receivedQuantity || 0) === 0;
  const canCloseShort = !!detail && detail.status === "partially_received" && (detail.totals?.remainingQuantity || 0) > 0;

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title={detail ? `Đơn nhập ${detail.id}` : "Chi tiết đơn nhập"}
        subtitle={detail ? detail.supplierName : undefined}
        status={detail ? <StatusPill tone={STATUS_TONE[detail.status] || "info"} label={STATUS_LABEL[detail.status] || detail.status} /> : undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="md" icon={<ArrowLeft size={15} aria-hidden="true" />} onClick={() => navigate("/purchase-orders")}>
              Danh sách
            </Button>
            {detail && (
              <Button
                variant="secondary"
                size="md"
                icon={<Download size={15} aria-hidden="true" />}
                disabled={csvPending}
                onClick={() => void handleDownloadDetailCsv()}
              >
                {csvPending ? "Đang xuất..." : "Xuất chi tiết CSV"}
              </Button>
            )}
            {detail?.status === "draft" && (
              <Button variant="secondary" size="md" icon={<Send size={15} aria-hidden="true" />} onClick={() => openConfirmAction("send")}>
                Đã gửi NCC
              </Button>
            )}
            {canReceive && (
              <Button variant="primary" size="md" icon={<PackageCheck size={15} aria-hidden="true" />} onClick={() => openReceiveDrawer()}>
                Ghi nhận hàng
              </Button>
            )}
            {canCloseShort && (
              <Button variant="secondary" size="md" icon={<CheckCircle2 size={15} aria-hidden="true" />} onClick={() => openConfirmAction("close_short")}>
                Đóng thiếu
              </Button>
            )}
            {canCancel && (
              <Button variant="danger" size="md" icon={<XCircle size={15} aria-hidden="true" />} onClick={() => openConfirmAction("cancel")}>
                Hủy đơn
              </Button>
            )}
          </div>
        }
      />

      {notice && (
        <MutationBanner
          tone={notice.tone}
          message={notice.message}
          actionLabel={notice.tone === "error" ? "Đóng" : undefined}
          onAction={() => setNotice(null)}
        />
      )}

      {isLoading || !detail ? (
        <Panel title="Tổng quan">
          <div className="p-4">
            <TableSkeleton rows={4} cols={4} />
          </div>
        </Panel>
      ) : (
        <>
          <ResponsiveMetricGrid>
            <MetricCell label="SKU" value={formatQty(detail.totals.lineCount)} tone="info" />
            <MetricCell label="Đã nhận / đặt" value={`${formatQty(detail.totals.receivedQuantity)} / ${formatQty(detail.totals.orderedQuantity)}`} tone={detail.totals.remainingQuantity > 0 ? "warning" : "success"} />
            <MetricCell label="Còn lại" value={formatQty(detail.totals.remainingQuantity)} tone={detail.totals.remainingQuantity > 0 ? "warning" : "success"} />
            <MetricCell
              label="Giá trị đã nhận"
              value={detail.totals.valueAvailable
                ? formatVnd(detail.totals.receivedValue)
                : `Không khả dụng · ${detail.totals.unknownCostLineCount} SKU chưa rõ giá`}
              tone="success"
            />
          </ResponsiveMetricGrid>

          <Panel title="Thông tin đơn">
            <div className="grid grid-cols-1 gap-3 p-4 text-sm md:grid-cols-3">
              <div>
                <div className="text-xs text-text-muted">Nhà cung cấp</div>
                <div className="mt-1 font-medium text-text-primary">{detail.supplierName}</div>
              </div>
              <div>
                <div className="text-xs text-text-muted">Ngày tạo</div>
                <div className="mt-1 text-text-primary">{formatDateTime(detail.createdAt)}</div>
              </div>
              <div>
                <div className="text-xs text-text-muted">Dự kiến</div>
                <div className="mt-1 text-text-primary">{formatDateTime(detail.expectedDate)}</div>
              </div>
              <div>
                <div className="text-xs text-text-muted">Nguồn tạo</div>
                <div className="mt-1 text-text-primary">{detail.source || "-"}</div>
              </div>
              <div>
                <div className="text-xs text-text-muted">Gửi NCC</div>
                <div className="mt-1 text-text-primary">{formatDateTime(detail.sentAt)}</div>
              </div>
              <div>
                <div className="text-xs text-text-muted">Cập nhật</div>
                <div className="mt-1 text-text-primary">{formatDateTime(detail.updatedAt)}</div>
              </div>
              {(detail.cancelledAt || detail.cancelReason) && (
                <div>
                  <div className="text-xs text-text-muted">Hủy đơn</div>
                  <div className="mt-1 text-text-primary">{formatDateTime(detail.cancelledAt)}</div>
                  {detail.cancelReason && <div className="mt-1 break-words text-xs text-text-secondary">{detail.cancelReason}</div>}
                </div>
              )}
              {(detail.closedAt || detail.closeReason) && (
                <div>
                  <div className="text-xs text-text-muted">Đóng thiếu</div>
                  <div className="mt-1 text-text-primary">{formatDateTime(detail.closedAt)}</div>
                  {detail.closeReason && <div className="mt-1 break-words text-xs text-text-secondary">{detail.closeReason}</div>}
                </div>
              )}
            </div>
          </Panel>

          <Panel title="SKU trong đơn">
            <div className="flex flex-wrap items-center gap-2 border-b border-border-default bg-surface-subtle p-3">
              <SearchBox
                value={detailSearch}
                onChange={(value) => {
                  setDetailSearch(value);
                  setDetailPage(1);
                }}
                aria-label="Tìm SKU trong đơn"
                placeholder="Tìm SKU, sản phẩm, danh mục..."
              />
              <select
                value={detailFilter}
                onChange={(event) => {
                  setDetailFilter(event.target.value as PurchaseOrderDetailLineFilter);
                  setDetailPage(1);
                }}
                aria-label="Lọc trạng thái SKU trong đơn"
                className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm text-text-primary focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
              >
                <option value="all">Tất cả trạng thái</option>
                <option value="remaining">Còn phải nhận</option>
                <option value="received">Đã nhận đủ</option>
              </select>
              {(detailSearch || detailFilter !== "all") && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDetailSearch("");
                    setDetailFilter("all");
                    setDetailPage(1);
                  }}
                >
                  Xóa bộ lọc
                </Button>
              )}
            </div>
            <PaginatedListFrame
              label="Phân trang SKU trong đơn"
              rowNoun="SKU"
              meta={localListPaginationMeta(
                detailLinesPage.total,
                detailLinesPage.page,
                DETAIL_PURCHASE_ORDER_PAGE_SIZE,
              )}
              onPageChange={setDetailPage}
            >
              {filteredDetailLines.length === 0 ? (
                <div className="p-6 text-center text-sm text-text-muted">
                  Không tìm thấy SKU phù hợp. Hãy đổi từ khóa hoặc trạng thái.
                </div>
              ) : (
                <OperationalTable
                  ariaLabel="SKU trong đơn đặt hàng"
                  minWidth={1080}
                  columns={[
                    { key: "sku", label: "SKU", width: 220, sticky: "left" },
                    { key: "product", label: "Sản phẩm" },
                    { key: "category", label: "Danh mục" },
                    { key: "ordered", label: "Đặt", align: "right" },
                    { key: "received", label: "Đã nhận", align: "right" },
                    { key: "remaining", label: "Còn lại", align: "right" },
                    { key: "stock", label: "Tồn hiện tại", align: "right" },
                    { key: "status", label: "Line status" },
                    { key: "actions", label: "", align: "right", width: 128, sticky: "right" },
                  ]}
                  rows={detailLinesPage.items.map((item) => ({
                    sku: <span className="font-medium text-text-primary">{item.sku || item.variantId}</span>,
                    product: <span className="break-words">{item.productName || item.variantId}</span>,
                    category: (
                      <span className="text-sm text-text-secondary">
                        {item.categoryNames.length ? item.categoryNames.join(", ") : "-"}
                      </span>
                    ),
                    ordered: <span className="tabular-nums">{formatQty(item.quantity)}</span>,
                    received: <span className="tabular-nums">{formatQty(item.receivedQuantity)}</span>,
                    remaining: <span className="tabular-nums">{formatQty(item.remainingQuantity)}</span>,
                    stock: <span className="tabular-nums">{formatQty(item.currentStock)}</span>,
                    status: (
                      <StatusPill
                        tone={
                          item.lineStatus === "received"
                            ? "success"
                            : item.lineStatus === "partially_received" || item.lineStatus === "short_closed"
                              ? "warning"
                              : "neutral"
                        }
                        label={LINE_STATUS_LABEL[item.lineStatus] || item.lineStatus}
                      />
                    ),
                    actions:
                      item.remainingQuantity > 0 && canReceive ? (
                        <Button variant="secondary" size="sm" onClick={() => openReceiveDrawer(item.id)}>
                          Nhận dòng
                        </Button>
                      ) : null,
                  }))}
                />
              )}
            </PaginatedListFrame>
          </Panel>

          <Panel title="Lịch sử nhận hàng">
            <PaginatedListFrame
              label="Phân trang lịch sử nhận hàng"
              rowNoun="receipt"
              meta={receiptMeta}
              loading={receiptCorrecting}
              loadingContent={
                <div className="p-3 text-sm text-text-muted">Đang tải trang receipt phù hợp...</div>
              }
              onPageChange={setReceiptPage}
              showPagination={!receiptCorrecting}
            >
              {detail.receipts.length === 0 ? (
                <div className="p-4 text-sm text-text-muted">Chưa có receipt nhập kho.</div>
              ) : (
                <OperationalTable
                  ariaLabel="Lịch sử nhận hàng"
                  minWidth={900}
                  columns={[
                    { key: "time", label: "Thời gian nhận" },
                    { key: "receipt", label: "Receipt" },
                    { key: "items", label: "SKU nhận" },
                    { key: "quantity", label: "Số lượng", align: "right" },
                    { key: "value", label: "Giá trị", align: "right" },
                    { key: "note", label: "Ghi chú" },
                  ]}
                  rows={detail.receipts.map((receipt) => {
                    const receiptItemPage = receiptItemPages[receipt.id] || 1;
                    const receiptItemsMeta = localListPaginationMeta(
                      receipt.items.length,
                      receiptItemPage,
                      RECEIPT_ITEM_PAGE_SIZE,
                    );
                    const visibleReceiptItems = receipt.items.slice(
                      (receiptItemsMeta.page - 1) * RECEIPT_ITEM_PAGE_SIZE,
                      receiptItemsMeta.page * RECEIPT_ITEM_PAGE_SIZE,
                    );
                    const expanded = expandedReceiptId === receipt.id;
                    return {
                      time: (
                        <span className="text-sm text-text-secondary">
                          {formatDateTime(receipt.receivedAt)}
                        </span>
                      ),
                      receipt: <span className="font-medium text-text-primary">{receipt.id}</span>,
                      items: (
                        <div className="space-y-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setExpandedReceiptId((current) => (current === receipt.id ? null : receipt.id))
                            }
                            aria-expanded={expanded}
                          >
                            {expanded ? "Ẩn dòng receipt" : `Xem ${formatQty(receipt.items.length)} SKU`}
                          </Button>
                          <PaginatedListFrame
                            label={`Phân trang SKU receipt ${receipt.id}`}
                            rowNoun="SKU"
                            meta={receiptItemsMeta}
                            onPageChange={(nextPage) =>
                              setReceiptItemPages((current) => ({ ...current, [receipt.id]: nextPage }))
                            }
                            showPagination={Boolean(
                              expanded && receipt.items.length > RECEIPT_ITEM_PAGE_SIZE,
                            )}
                          >
                            {expanded &&
                              visibleReceiptItems.map((item) => (
                                <div key={`${receipt.id}-${item.purchaseOrderItemId}`} className="text-sm">
                                  <span className="font-medium text-text-primary">{item.sku}</span>
                                  <span className="text-text-muted">
                                    {" "}
                                    · {formatQty(item.quantityReceived)} {item.productName}
                                  </span>
                                </div>
                              ))}
                          </PaginatedListFrame>
                        </div>
                      ),
                      quantity: <span className="tabular-nums">{formatQty(receipt.totalQuantity)}</span>,
                      value: (
                        <span className="tabular-nums">
                          {receipt.valueAvailable ? formatVnd(receipt.inventoryValue) : "Không khả dụng"}
                        </span>
                      ),
                      note: <span className="text-sm text-text-secondary">{receipt.note || "-"}</span>,
                    };
                  })}
                />
              )}
            </PaginatedListFrame>
          </Panel>
        </>
      )}

      <Drawer
        open={receiveOpen}
        title="Ghi nhận hàng nhận"
        subtitle={detail?.id}
        size="wide"
        onClose={abandonReceiveIntent}
        actions={
          <>
            <Button
              variant="primary"
              onClick={() => void handleReceive()}
              disabled={!!receiveError || receiveMutation.isPending}
            >
              {receiveMutation.isPending ? "Đang ghi nhận..." : "Xác nhận nhận hàng"}
            </Button>
            <Button variant="secondary" disabled={receiveMutation.isPending} onClick={abandonReceiveIntent}>Hủy</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-3 rounded-lg border border-border-default bg-surface-subtle p-3">
            <div className="flex flex-wrap items-center gap-2">
              <SearchBox
                value={receiveSearch}
                onChange={(value) => {
                  setReceiveSearch(value);
                  setReceivePage(1);
                }}
                aria-label="Tìm SKU để nhận"
                placeholder="Tìm SKU, sản phẩm, danh mục..."
              />
              <select
                value={receiveFilter}
                onChange={(event) => {
                  setReceiveFilter(event.target.value as PurchaseOrderReceiveLineFilter);
                  setReceivePage(1);
                }}
                aria-label="Lọc dòng nhận hàng"
                className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm text-text-primary focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
              >
                <option value="all">Tất cả SKU còn lại</option>
                <option value="selected">Đã nhập số lượng</option>
                <option value="unselected">Chưa nhập số lượng</option>
              </select>
              {(receiveSearch || receiveFilter !== "all") && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setReceiveSearch("");
                    setReceiveFilter("all");
                    setReceivePage(1);
                  }}
                >
                  Xóa bộ lọc
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm text-text-secondary" aria-live="polite">
                Đã chọn <strong className="text-text-primary">{formatQty(receiveSelection.selectedLineCount)} SKU</strong>
                {" · "}<strong className="text-text-primary">{formatQty(receiveSelection.selectedUnitCount)} đơn vị</strong>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={fillVisibleRemainingQuantities}
                  disabled={receiveLinesPage.items.length === 0}
                >
                  Điền còn lại trang này
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearVisibleQuantities}
                  disabled={receiveLinesPage.items.length === 0}
                >
                  Xóa số lượng trang này
                </Button>
              </div>
            </div>
          </div>
          <PaginatedListFrame
            label="Phân trang SKU nhận hàng"
            rowNoun="SKU"
            meta={localListPaginationMeta(
              receiveLinesPage.total,
              receiveLinesPage.page,
              RECEIVE_PURCHASE_ORDER_PAGE_SIZE,
            )}
            onPageChange={setReceivePage}
          >
            {filteredReceiveLines.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border-default p-6 text-center text-sm text-text-muted">
                Không có SKU phù hợp với bộ lọc hiện tại.
              </div>
            ) : (
              <div className="space-y-2">
                {receiveLinesPage.items.map((item) => (
                  <div
                    key={item.id}
                    className="grid grid-cols-1 gap-2 rounded-lg border border-border-default bg-surface-panel p-3 md:grid-cols-[minmax(0,1fr)_140px_160px]"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-text-primary">{item.sku}</div>
                      <div className="text-sm text-text-secondary break-words">{item.productName}</div>
                      <div className="mt-1 text-xs text-text-muted">
                        Còn lại {formatQty(item.remainingQuantity)} / đặt {formatQty(item.quantity)}
                      </div>
                    </div>
                    <div>
                      <label
                        htmlFor={`receive-${item.id}`}
                        className="mb-1 block text-xs font-medium text-text-secondary"
                      >
                        Thực nhận
                      </label>
                      <input
                        id={`receive-${item.id}`}
                        type="number"
                        min={0}
                        max={item.remainingQuantity}
                        step={1}
                        value={receiveQuantities[item.id] || ""}
                        onChange={(event) =>
                          setReceiveQuantities((current) => ({ ...current, [item.id]: event.target.value }))
                        }
                        className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm tabular-nums
                                       focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
                      />
                    </div>
                    <div>
                      <div className="mb-1 text-xs font-medium text-text-secondary">Đơn giá nhập</div>
                      <div className="flex h-10 items-center rounded-md border border-border-default bg-surface-subtle px-3 text-sm tabular-nums text-text-primary">
                        {item.unitCostQuality === "unknown"
                          ? "Chưa rõ giá"
                          : item.unitCostQuality === "free"
                            ? "0 ₫ · miễn phí"
                            : formatVnd(item.unitCost)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </PaginatedListFrame>
          <div>
            <label htmlFor="receive-note" className="mb-1 block text-xs font-medium text-text-secondary">
              Ghi chú receipt
            </label>
            <textarea
              id="receive-note"
              value={receiveNote}
              onChange={(event) => setReceiveNote(event.target.value)}
              rows={3}
              className="w-full rounded-md border border-border-default bg-surface-panel px-3 py-2 text-sm
                         focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
            />
          </div>
          {receiveError && (
            <div className="rounded-md border border-status-warning-border bg-status-warning-bg px-3 py-2 text-sm text-status-warning">
              {receiveError}
            </div>
          )}
          {receiveInlineError && (
            <div className="rounded-md border border-status-danger-border bg-status-danger-bg px-3 py-2 text-sm text-status-danger" role="alert">
              <div className="font-medium">Không thể hoàn tất receipt</div>
              <div className="mt-1 break-words">{receiveInlineError}</div>
              <div className="mt-1 text-xs">Dữ liệu đang nhập và mã retry được giữ nguyên. Hãy thử lại; chỉ bấm Hủy khi muốn bỏ intent này.</div>
            </div>
          )}
        </div>
      </Drawer>

      <ConfirmDialog
        open={!!confirmAction}
        title={confirmMeta.title}
        message={confirmMeta.message}
        confirmLabel={confirmMeta.label}
        danger={confirmMeta.danger}
        pending={confirmMeta.pending}
        confirmDisabled={confirmMeta.disabled}
        onConfirm={() => void handleConfirmAction()}
        onCancel={() => { setConfirmAction(null); setActionText(""); }}
      >
        <label htmlFor="po-action-note" className="mb-1 block text-xs font-medium text-text-secondary">
          {confirmMeta.textareaLabel}
        </label>
        <textarea
          id="po-action-note"
          value={actionText}
          onChange={(event) => setActionText(event.target.value)}
          rows={3}
          className="w-full rounded-md border border-border-default bg-surface-panel px-3 py-2 text-sm
                     focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
          autoFocus
        />
      </ConfirmDialog>
    </div>
  );
}
