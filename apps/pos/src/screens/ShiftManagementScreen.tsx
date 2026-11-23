import { useEffect, useMemo, useState } from "react";
import { useOffsetListPagination } from "../hooks/useOffsetListPagination";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  InlineError,
  PaginatedListFrame,
  loadedListPaginationMeta,
  localListPaginationMeta,
} from "@medusa-snus/ui";
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  Clock3,
  Flag,
  Lock,
  RefreshCw,
} from "lucide-react";
import {
  closeShift,
  fetchCurrentShift,
  fetchInventory,
  fetchMyShiftReport,
  fetchMyShifts,
  fetchShiftReport,
  fetchShifts,
  forceCloseShift,
  previewCloseShift,
  receiveShiftHandover,
  recordShiftCashMovement,
  recordShiftStockCount,
  reviewShift,
  startShift,
  vnd,
  type ShiftReportResponse,
  type ShiftSummaryView,
} from "../api/endpoints";
import { hasClientOperatingScope } from "../api/client";
import { fetchMe } from "../api/settings-endpoints";
import { useAuth } from "../hooks/useAuth";
import { useClientOperatingScope } from "../hooks/useProducts";

function money(value: unknown): string {
  return `${Math.round(Number(value || 0)).toLocaleString("vi-VN")} VND`;
}

function time(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });
}

function statusLabel(status?: string): string {
  if (status === "open") return "Đang mở";
  if (status === "closed") return "Đã đóng";
  if (status === "force_closed") return "Đóng cưỡng bức";
  if (status === "closing") return "Đang đóng";
  return status || "";
}

function reviewLabel(status?: string): string {
  if (status === "approved") return "Đã duyệt";
  if (status === "flagged") return "Cần xem lại";
  if (status === "pending") return "Chờ duyệt";
  if (status === "not_required") return "Không cần duyệt";
  return status || "";
}

function warningText(warning: { code: string; message: string }): string {
  const count = warning.message.match(/\d+/)?.[0] || "";
  if (warning.code === "legacy_time_window_fallback")
    return `${count} đơn được tính bằng khung thời gian dự phòng.`;
  if (warning.code === "pending_payment_entries")
    return `${count} nhóm thanh toán chưa được ghi nhận hoàn tất.`;
  if (warning.code === "payment_intent_manual_review")
    return `${count} giao dịch thanh toán cần kiểm tra thủ công.`;
  if (warning.code === "stock_discrepancy_recorded")
    return `Chênh lệch kiểm nhanh lớn nhất là ${count}.`;
  return warning.message;
}

function ReviewBadge({ shift }: { shift: ShiftSummaryView }) {
  const tone =
    shift.reviewStatus === "approved"
      ? "border-status-success-border bg-status-success-bg text-status-success"
      : shift.reviewStatus === "flagged"
        ? "border-status-danger-border bg-status-danger-bg text-status-danger"
        : "border-status-warning-border bg-status-warning-bg text-status-warning";
  return (
    <span className={`rounded border px-2 py-0.5 text-xs ${tone}`}>
      {reviewLabel(shift.reviewStatus)}
    </span>
  );
}

function fieldText(
  row: Record<string, unknown>,
  keys: string[],
  fallback = "-",
): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "")
      return String(value);
  }
  return fallback;
}

function moneyField(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "")
      return money(value);
  }
  return money(0);
}

function ShiftReportReadout({
  report,
}: {
  report: ShiftReportResponse["data"];
}) {
  const PAGE_SIZE = 20;
  const payments = Object.entries(report.paymentSummary || {});
  const outstandingObligations = report.outstandingObligations || [];
  const outstandingRefundPayables = report.outstandingRefundPayables || [];
  const products = report.productSold || [];
  const cashMovements = report.cashMovements || [];
  const stockCounts = report.stockCounts || [];
  const [productsPage, setProductsPage] = useState(1);
  const [cashMovementsPage, setCashMovementsPage] = useState(1);
  const [stockCountsPage, setStockCountsPage] = useState(1);
  const productsMeta = localListPaginationMeta(
    products.length,
    productsPage,
    PAGE_SIZE,
  );
  const cashMovementsMeta = localListPaginationMeta(
    cashMovements.length,
    cashMovementsPage,
    PAGE_SIZE,
  );
  const stockCountsMeta = localListPaginationMeta(
    stockCounts.length,
    stockCountsPage,
    PAGE_SIZE,
  );
  const visibleProducts = products.slice(
    (productsMeta.page - 1) * PAGE_SIZE,
    productsMeta.page * PAGE_SIZE,
  );
  const visibleCashMovements = cashMovements.slice(
    (cashMovementsMeta.page - 1) * PAGE_SIZE,
    cashMovementsMeta.page * PAGE_SIZE,
  );
  const visibleStockCounts = stockCounts.slice(
    (stockCountsMeta.page - 1) * PAGE_SIZE,
    stockCountsMeta.page * PAGE_SIZE,
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded border border-border-default bg-surface-subtle p-3">
          <div className="text-xs text-text-muted">Tiền kỳ vọng</div>
          <div className="font-semibold text-text-primary">
            {money(report.cashExpected)}
          </div>
        </div>
        <div className="rounded border border-border-default bg-surface-subtle p-3">
          <div className="text-xs text-text-muted">Chênh lệch tiền</div>
          <div className="font-semibold text-text-primary">
            {money(report.shift.cashVarianceAmount)}
          </div>
        </div>
        <div className="rounded border border-border-default bg-surface-subtle p-3">
          <div className="text-xs text-text-muted">Đơn hàng</div>
          <div className="font-semibold text-text-primary">
            {report.orderIds?.length || 0}
          </div>
        </div>
        <div className="rounded border border-border-default bg-surface-subtle p-3">
          <div className="text-xs text-text-muted">Review</div>
          <div className="font-semibold text-text-primary">
            {reviewLabel(report.shift.reviewStatus)}
          </div>
        </div>
      </div>

      {report.warnings.length > 0 ? (
        <div className="rounded border border-status-warning-border bg-status-warning-bg p-3 text-xs text-status-warning">
          {report.warnings.map((warning) => (
            <div key={warning.code}>{warningText(warning)}</div>
          ))}
        </div>
      ) : null}

      <div className="rounded border border-border-default">
        <div className="border-b border-border-default bg-surface-subtle px-3 py-2 text-xs font-semibold text-text-secondary">
          Thanh toán
        </div>
        <div className="divide-y divide-border-default">
          {payments.length ? (
            payments.map(([method, summary]) => (
              <div
                key={method}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-text-primary">
                    {method}
                  </div>
                  <div className="text-text-muted">
                    Thu {money(summary.charges)} · Hoàn {money(summary.refunds)}{" "}
                    · {summary.count} dòng
                  </div>
                </div>
                <div className="font-semibold text-text-primary">
                  {money(summary.net)}
                </div>
              </div>
            ))
          ) : (
            <div className="px-3 py-3 text-xs text-text-muted">
              Chưa có thanh toán.
            </div>
          )}
        </div>
      </div>

      <div className="rounded border border-border-default">
        <div className="border-b border-border-default bg-surface-subtle px-3 py-2 text-xs font-semibold text-text-secondary">
          Còn phải thu
        </div>
        <div className="divide-y divide-border-default">
          {outstandingObligations.length ? (
            outstandingObligations.map((item) => (
              <div
                key={`${item.currencyCode}-${item.minorUnitExponent}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-text-primary">
                    {item.currencyCode}
                  </div>
                  <div className="text-text-muted">
                    {item.obligationCount} nghĩa vụ chưa thu
                  </div>
                </div>
                <div className="font-semibold text-text-primary">
                  {money(item.remainingAmountMinor)}
                </div>
              </div>
            ))
          ) : (
            <div className="px-3 py-3 text-xs text-text-muted">
              Không còn nghĩa vụ phải thu trong ca.
            </div>
          )}
        </div>
      </div>

      <div className="rounded border border-border-default p-3 space-y-2">
        <h3 className="text-sm font-semibold">Còn phải hoàn cho khách</h3>
        {outstandingRefundPayables.length ? outstandingRefundPayables.map((item) => (
          <p key={`${item.currencyCode}-${item.minorUnitExponent}`} className="text-sm">
            {item.payableCount} khoản · {(item.remainingAmountMinor / 10 ** item.minorUnitExponent).toLocaleString("vi-VN")} {item.currencyCode}
          </p>
        )) : <p className="text-xs text-text-muted">Không còn khoản phải hoàn trong ca.</p>}
      </div>
      {Boolean(report.postCloseFinancialAdjustments?.length) && (
        <div className="rounded border border-status-warning-border p-3 text-sm">
          <p className="font-semibold">Phát sinh được ghi nhận sau khi đóng ca</p>
          <p>{report.postCloseFinancialAdjustments?.length} phát sinh mới; số liệu chốt ca được giữ nguyên.</p>
        </div>
      )}

      <div className="rounded border border-border-default">
        <div className="border-b border-border-default bg-surface-subtle px-3 py-2 text-xs font-semibold text-text-secondary">
          Sản phẩm bán
        </div>
        <PaginatedListFrame
          label="Phân trang sản phẩm bán trong ca"
          rowNoun="sản phẩm"
          meta={productsMeta}
          onPageChange={setProductsPage}
          showPagination={Boolean(products.length > 0)}
        >
          <div className="divide-y divide-border-default">
            {products.length ? (
              visibleProducts.map((item, index) => (
                <div
                  key={`${item.variantId}-${index}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="break-words font-semibold text-text-primary">
                      {String(item.productTitle || item.sku || item.variantId)}
                    </div>
                    <div className="text-text-muted">
                      SL {Number(item.quantity || 0)}
                    </div>
                  </div>
                  <div className="font-semibold text-text-primary">
                    {money(item.grossSales)}
                  </div>
                </div>
              ))
            ) : (
              <div className="px-3 py-3 text-xs text-text-muted">
                Chưa có sản phẩm bán.
              </div>
            )}
          </div>
        </PaginatedListFrame>
      </div>

      <div className="rounded border border-border-default">
        <div className="border-b border-border-default bg-surface-subtle px-3 py-2 text-xs font-semibold text-text-secondary">
          Tiền mặt trong ca
        </div>
        <PaginatedListFrame
          label="Phân trang phát sinh tiền mặt"
          rowNoun="phát sinh"
          meta={cashMovementsMeta}
          onPageChange={setCashMovementsPage}
          showPagination={Boolean(cashMovements.length > 0)}
        >
          <div className="divide-y divide-border-default">
            {cashMovements.length ? (
              visibleCashMovements.map((movement, index) => {
                const row = movement as Record<string, unknown>;
                return (
                  <div
                    key={String(row.id || index)}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-text-primary">
                        {fieldText(row, ["type", "movementType"])}
                      </div>
                      <div className="break-words text-text-muted">
                        {fieldText(row, ["reason", "note"], "Không ghi chú")}
                      </div>
                    </div>
                    <div className="font-semibold text-text-primary">
                      {moneyField(row, ["amount", "amountVnd"])}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="px-3 py-3 text-xs text-text-muted">
                Không có phát sinh tiền mặt.
              </div>
            )}
          </div>
        </PaginatedListFrame>
      </div>

      <div className="rounded border border-border-default">
        <div className="border-b border-border-default bg-surface-subtle px-3 py-2 text-xs font-semibold text-text-secondary">
          Kiểm nhanh tồn
        </div>
        <PaginatedListFrame
          label="Phân trang kiểm nhanh tồn"
          rowNoun="dòng kiểm"
          meta={stockCountsMeta}
          onPageChange={setStockCountsPage}
          showPagination={Boolean(stockCounts.length > 0)}
        >
          <div className="divide-y divide-border-default">
            {stockCounts.length ? (
              visibleStockCounts.map((count, index) => {
                const row = count as Record<string, unknown>;
                return (
                  <div
                    key={String(row.id || index)}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="break-words font-semibold text-text-primary">
                        {fieldText(row, [
                          "productTitle",
                          "sku",
                          "inventoryItemId",
                        ])}
                      </div>
                      <div className="break-words text-text-muted">
                        {fieldText(row, ["reason", "note"], "Không ghi chú")}
                      </div>
                    </div>
                    <div className="text-right font-semibold text-text-primary">
                      {fieldText(row, ["countedQuantity", "countedQty"])}
                      <div className="text-text-muted">
                        Lệch {fieldText(row, ["discrepancy", "delta"], "0")}
                      </div>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="px-3 py-3 text-xs text-text-muted">
                Chưa ghi nhận kiểm nhanh.
              </div>
            )}
          </div>
        </PaginatedListFrame>
      </div>

      {report.shift.outgoingHandoverNote ? (
        <div className="rounded border border-border-default bg-surface-subtle p-3 text-xs">
          <div className="font-semibold text-text-secondary">Bàn giao</div>
          <div className="mt-1 break-words text-text-primary">
            {report.shift.outgoingHandoverNote}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function ShiftManagementScreen() {
  const SHIFT_PAGE_SIZE = 25;
  const queryClient = useQueryClient();
  const { operator } = useAuth();
  const scope = useClientOperatingScope();
  const operatingScopeReady = hasClientOperatingScope(scope);
  const reportScopeReady = Boolean(
    scope.reportMerchantId && scope.reportStoreIds.length,
  );
  const operatingScopeKey = `${scope.operatingMerchantId}:${scope.operatingStoreId}`;
  const reportScopeKey = `${scope.reportMerchantId}:${scope.reportStoreIds.join(",")}`;
  const [openingCash, setOpeningCash] = useState("0");
  const [openingNote, setOpeningNote] = useState("");
  const [receivedOpeningCash, setReceivedOpeningCash] = useState("");
  const [handoverAckNote, setHandoverAckNote] = useState("");
  const [handoverAck, setHandoverAck] = useState<{
    previousShiftId: string;
    id: string;
  } | null>(null);
  const [cashType, setCashType] = useState<
    "pay_in" | "pay_out" | "cash_drop" | "cash_correction"
  >("pay_in");
  const [cashAmount, setCashAmount] = useState("");
  const [cashReason, setCashReason] = useState("");
  const [countItemId, setCountItemId] = useState("");
  const [countedQty, setCountedQty] = useState("");
  const [countReason, setCountReason] = useState("");
  const [closeCash, setCloseCash] = useState("");
  const [closeReason, setCloseReason] = useState("");
  const [handoverNote, setHandoverNote] = useState("");
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [selectedMyShiftId, setSelectedMyShiftId] = useState<string | null>(
    null,
  );
  const [shiftsPage, setShiftsPage] = useState(1);
  const [myShiftsPage, setMyShiftsPage] = useState(1);
  const [stockCountPage, setStockCountPage] = useState(1);
  const [reviewReason, setReviewReason] = useState("");
  const [forceReason, setForceReason] = useState("");
  const [preview, setPreview] = useState<ShiftReportResponse["data"] | null>(
    null,
  );
  const [mobileTab, setMobileTab] = useState<
    "current" | "cash" | "stock" | "close" | "history" | "manage"
  >("current");
  const [closeStep, setCloseStep] = useState<"count" | "stock" | "handover">(
    "count",
  );

  useEffect(() => {
    setShiftsPage(1);
    setMyShiftsPage(1);
  }, [reportScopeKey]);

  const accessQuery = useQuery({
    queryKey: ["me", operator?.id],
    queryFn: fetchMe,
    enabled: Boolean(operator?.id),
    staleTime: 60_000,
  });
  const permissionIds = accessQuery.data?.permissionIds || [];
  const role = accessQuery.data?.role || operator?.role || "";
  const canManageShiftReports =
    permissionIds.includes("shift:report") ||
    ["owner", "manager", "admin", "platform_admin", "platform"].includes(role);
  const canReviewShifts =
    permissionIds.includes("shift:review") ||
    ["owner", "manager", "admin", "platform_admin", "platform"].includes(role);
  const canForceCloseShifts =
    permissionIds.includes("shift:manage") ||
    ["owner", "manager", "admin", "platform_admin", "platform"].includes(role);

  const currentQuery = useQuery({
    queryKey: ["currentShift", operatingScopeKey],
    queryFn: fetchCurrentShift,
    enabled: operatingScopeReady,
    refetchInterval: operatingScopeReady ? 30_000 : false,
  });
  const inventoryQuery = useQuery({
    queryKey: ["inventory", operatingScopeKey],
    queryFn: fetchInventory,
    enabled: operatingScopeReady,
  });
  const shiftsQuery = useQuery({
    queryKey: ["shifts", "history", reportScopeKey, shiftsPage],
    queryFn: () =>
      fetchShifts({
        limit: SHIFT_PAGE_SIZE,
        offset: (shiftsPage - 1) * SHIFT_PAGE_SIZE,
      }),
    enabled: reportScopeReady && canManageShiftReports,
  });
  const myShiftsQuery = useQuery({
    queryKey: ["shifts", "mine", reportScopeKey, myShiftsPage],
    queryFn: () =>
      fetchMyShifts({
        limit: SHIFT_PAGE_SIZE,
        offset: (myShiftsPage - 1) * SHIFT_PAGE_SIZE,
      }),
    enabled: reportScopeReady,
  });
  const selectedReportQuery = useQuery({
    queryKey: ["shiftReport", selectedShiftId, reportScopeKey],
    queryFn: () => fetchShiftReport(selectedShiftId!),
    enabled:
      Boolean(selectedShiftId) && reportScopeReady && canManageShiftReports,
  });
  const selectedMyReportQuery = useQuery({
    queryKey: ["shiftReport", "mine", selectedMyShiftId, reportScopeKey],
    queryFn: () => fetchMyShiftReport(selectedMyShiftId!),
    enabled: Boolean(selectedMyShiftId) && reportScopeReady,
  });

  const currentShift = currentQuery.data?.data || null;
  const policy = currentQuery.data?.policy;
  const previousHandover = currentQuery.data?.previousHandover || null;
  const previousShiftId = previousHandover?.shift?.id || "";
  const existingHandoverAckId =
    typeof previousHandover?.acknowledgement?.id === "string"
      ? previousHandover.acknowledgement.id
      : "";
  const effectiveHandoverAckId =
    existingHandoverAckId ||
    (handoverAck?.previousShiftId === previousShiftId ? handoverAck.id : "");
  const inventory = inventoryQuery.data || [];
  const stockCountPageMeta = loadedListPaginationMeta(
    inventory.length,
    stockCountPage,
    20,
  );
  const visibleStockCountItems = inventory.slice(
    (stockCountPageMeta.page - 1) * 20,
    stockCountPageMeta.page * 20,
  );
  const selectedCountItem = useMemo(
    () => inventory.find((item) => item.id === countItemId),
    [countItemId, inventory],
  );

  useEffect(() => {
    setStockCountPage(1);
  }, [operatingScopeKey]);
  const selectedReport = selectedReportQuery.data?.data || null;
  const selectedMyReport = selectedMyReportQuery.data?.data || null;
  const { meta: shiftsMeta, correcting: shiftsCorrecting } =
    useOffsetListPagination(
      shiftsQuery.error ? undefined : shiftsQuery.data?.count,
      shiftsPage,
      SHIFT_PAGE_SIZE,
      setShiftsPage,
    );
  const { meta: myShiftsMeta, correcting: myShiftsCorrecting } =
    useOffsetListPagination(
      myShiftsQuery.error ? undefined : myShiftsQuery.data?.count,
      myShiftsPage,
      SHIFT_PAGE_SIZE,
      setMyShiftsPage,
    );

  function invalidateShiftQueries() {
    void queryClient.invalidateQueries({ queryKey: ["currentShift"] });
    void queryClient.invalidateQueries({ queryKey: ["shifts"] });
    void queryClient.invalidateQueries({ queryKey: ["shiftReport"] });
  }

  const startMutation = useMutation({
    mutationFn: () =>
      startShift({
        openingCashAmount: vnd(openingCash),
        openingNote: openingNote || undefined,
        handoverAcknowledgementId: effectiveHandoverAckId || undefined,
      }),
    onSuccess: () => {
      setOpeningNote("");
      setHandoverAck(null);
      setHandoverAckNote("");
      setReceivedOpeningCash("");
      invalidateShiftQueries();
    },
  });
  const handoverAckMutation = useMutation({
    mutationFn: () =>
      receiveShiftHandover({
        previousShiftId,
        acknowledgementNote: handoverAckNote || undefined,
        receivedOpeningCashAmount: receivedOpeningCash
          ? vnd(receivedOpeningCash)
          : undefined,
      }),
    onSuccess: (result) => {
      const ackId = typeof result.data?.id === "string" ? result.data.id : "";
      if (ackId) setHandoverAck({ previousShiftId, id: ackId });
      setHandoverAckNote("");
      invalidateShiftQueries();
    },
  });
  const cashMutation = useMutation({
    mutationFn: () =>
      recordShiftCashMovement({
        type: cashType,
        amount: vnd(cashAmount),
        reason: cashReason,
      }),
    onSuccess: () => {
      setCashAmount("");
      setCashReason("");
      invalidateShiftQueries();
    },
  });
  const countMutation = useMutation({
    mutationFn: () =>
      recordShiftStockCount({
        countType: "quick",
        items: [
          {
            inventoryItemId: countItemId,
            countedQuantity: Number(countedQty || 0),
            reason: countReason || undefined,
          },
        ],
      }),
    onSuccess: () => {
      setCountedQty("");
      setCountReason("");
      invalidateShiftQueries();
    },
  });
  const previewMutation = useMutation({
    mutationFn: () =>
      previewCloseShift({
        countedCashAmount: closeCash ? vnd(closeCash) : undefined,
      }),
    onSuccess: (result) => setPreview(result.data),
  });
  const closeMutation = useMutation({
    mutationFn: () =>
      closeShift({
        countedCashAmount: vnd(closeCash),
        discrepancyReason: closeReason || undefined,
        outgoingHandoverNote: handoverNote || undefined,
      }),
    onSuccess: (result) => {
      setPreview(result.data);
      setCloseCash("");
      setCloseReason("");
      setHandoverNote("");
      setCloseStep("count");
      setMobileTab("current");
      invalidateShiftQueries();
    },
  });
  const reviewMutation = useMutation({
    mutationFn: ({
      id,
      status,
    }: {
      id: string;
      status: "approved" | "flagged";
    }) =>
      reviewShift(id, {
        reviewStatus: status,
        reason: status === "flagged" ? reviewReason : undefined,
      }),
    onSuccess: () => {
      setReviewReason("");
      invalidateShiftQueries();
    },
  });
  const forceCloseMutation = useMutation({
    mutationFn: (id: string) => forceCloseShift(id, { reason: forceReason }),
    onSuccess: (result) => {
      setPreview(result.data);
      setForceReason("");
      invalidateShiftQueries();
    },
  });

  const activeError = operatingScopeReady
    ? currentQuery.error || inventoryQuery.error
    : null;
  const handoverAckRequired = Boolean(
    policy?.requireHandoverAck &&
    previousHandover?.shift &&
    !effectiveHandoverAckId,
  );
  const busy =
    startMutation.isPending ||
    handoverAckMutation.isPending ||
    cashMutation.isPending ||
    countMutation.isPending ||
    closeMutation.isPending ||
    previewMutation.isPending;
  const mobileTabs = [
    {
      id: "current" as const,
      label: currentShift
        ? "Hiện tại"
        : previousHandover?.shift
          ? "Bàn giao"
          : "Mở ca",
    },
    { id: "cash" as const, label: "Tiền mặt" },
    { id: "stock" as const, label: "Kiểm tồn" },
    { id: "close" as const, label: "Đóng ca" },
    { id: "history" as const, label: "Lịch sử" },
    ...(canManageShiftReports
      ? [{ id: "manage" as const, label: "Quản lý" }]
      : []),
  ];
  const mobileSectionClass = (tab: typeof mobileTab, base: string) =>
    [mobileTab === tab ? "block" : "hidden md:block", base].join(" ");
  const mobileSideVisible = mobileTab === "history" || mobileTab === "manage";
  const shouldShowManagerPanel =
    canManageShiftReports &&
    (mobileTab === "manage" || mobileTab !== "history");

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-base">
      <div className="border-b border-border-default px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">
              Ca làm & bàn giao
            </h1>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void currentQuery.refetch();
              void shiftsQuery.refetch();
            }}
          >
            <RefreshCw size={14} /> Làm mới
          </Button>
        </div>
      </div>

      {activeError ? (
        <div className="px-4 pt-4">
          <InlineError
            message={
              activeError instanceof Error
                ? activeError.message
                : "Không thể tải dữ liệu ca"
            }
            onRetry={() => {
              void currentQuery.refetch();
              void shiftsQuery.refetch();
            }}
            stale
          />
        </div>
      ) : null}
      {!operatingScopeReady ? (
        <div className="px-4 pt-4 text-sm text-text-muted">
          Đang xác định cửa hàng thao tác...
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-2 border-b border-border-default px-4 py-2 md:hidden">
        {mobileTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setMobileTab(tab.id)}
            className={[
              "h-9 rounded border px-2 text-xs font-medium",
              mobileTab === tab.id
                ? "border-action-primary bg-surface-selected text-action-primary"
                : "border-border-default bg-surface-base text-text-secondary",
            ].join(" ")}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto pb-24 md:pb-0 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
        <div className="min-h-0 border-r border-border-default">
          <section
            className={mobileSectionClass(
              "current",
              "border-b border-border-default px-4 py-4",
            )}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <Clock3 size={16} />
                Ca hiện tại
              </div>
              {policy?.enforceShiftOnPos ? (
                <span className="rounded border border-status-warning-border bg-status-warning-bg px-2 py-0.5 text-xs text-status-warning">
                  Bắt buộc mở ca
                </span>
              ) : null}
            </div>

            {currentShift ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded border border-border-default bg-surface-subtle p-3">
                  <div className="text-xs text-text-muted">Trạng thái</div>
                  <div className="mt-1 text-sm font-semibold text-text-primary">
                    {statusLabel(currentShift.status)}
                  </div>
                  <div className="mt-1 text-xs text-text-muted">
                    Z {currentShift.zNumber || "-"}
                  </div>
                </div>
                <div className="rounded border border-border-default bg-surface-subtle p-3">
                  <div className="text-xs text-text-muted">Mở lúc</div>
                  <div className="mt-1 text-sm font-semibold text-text-primary">
                    {time(currentShift.openedAt)}
                  </div>
                  <div className="mt-1 text-xs text-text-muted">
                    {currentShift.openedBy}
                  </div>
                </div>
                <div className="rounded border border-border-default bg-surface-subtle p-3">
                  <div className="text-xs text-text-muted">Tiền đầu ca</div>
                  <div className="mt-1 text-sm font-semibold text-text-primary">
                    {money(currentShift.openingCashAmount)}
                  </div>
                  <div className="mt-1 text-xs text-text-muted">
                    Ngăn tiền mặt
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {previousHandover?.shift ? (
                  <div className="rounded border border-border-default bg-surface-subtle p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-text-primary">
                          Nhận bàn giao ca Z{" "}
                          {previousHandover.shift.zNumber || "-"}
                        </div>
                        <div className="mt-1 text-xs text-text-muted">
                          Đóng lúc {time(previousHandover.shift.closedAt)} ·
                          Chênh lệch{" "}
                          {money(previousHandover.shift.cashVarianceAmount)}
                        </div>
                        {previousHandover.shift.outgoingHandoverNote ? (
                          <div className="mt-2 text-xs text-text-secondary">
                            {previousHandover.shift.outgoingHandoverNote}
                          </div>
                        ) : null}
                      </div>
                      {effectiveHandoverAckId ? (
                        <span className="rounded border border-status-success-border bg-status-success-bg px-2 py-0.5 text-xs text-status-success">
                          Đã nhận
                        </span>
                      ) : null}
                    </div>
                    {!effectiveHandoverAckId ? (
                      <div className="mt-3 grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)_auto]">
                        <label className="text-xs text-text-muted">
                          Tiền nhận
                          <input
                            value={receivedOpeningCash}
                            onChange={(event) =>
                              setReceivedOpeningCash(event.target.value)
                            }
                            className="mt-1 h-10 w-full rounded border border-border-default bg-surface-base px-3 text-sm text-text-primary"
                            inputMode="numeric"
                          />
                        </label>
                        <label className="text-xs text-text-muted">
                          Ghi chú nhận ca
                          <input
                            value={handoverAckNote}
                            onChange={(event) =>
                              setHandoverAckNote(event.target.value)
                            }
                            className="mt-1 h-10 w-full rounded border border-border-default bg-surface-base px-3 text-sm text-text-primary"
                          />
                        </label>
                        <Button
                          variant="secondary"
                          disabled={
                            !previousShiftId || handoverAckMutation.isPending
                          }
                          onClick={() => handoverAckMutation.mutate()}
                          className="self-end w-full sm:w-auto"
                        >
                          Nhận ca
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)_auto]">
                  <label className="text-xs text-text-muted">
                    Tiền đầu ca
                    <input
                      value={openingCash}
                      onChange={(event) => setOpeningCash(event.target.value)}
                      className="mt-1 h-10 w-full rounded border border-border-default bg-surface-base px-3 text-sm text-text-primary"
                      inputMode="numeric"
                    />
                  </label>
                  <label className="text-xs text-text-muted">
                    Ghi chú mở ca
                    <input
                      value={openingNote}
                      onChange={(event) => setOpeningNote(event.target.value)}
                      className="mt-1 h-10 w-full rounded border border-border-default bg-surface-base px-3 text-sm text-text-primary"
                    />
                  </label>
                  <Button
                    disabled={
                      !operatingScopeReady ||
                      handoverAckRequired ||
                      startMutation.isPending
                    }
                    onClick={() => startMutation.mutate()}
                    className="self-end w-full sm:w-auto"
                  >
                    <Lock size={14} /> Mở ca
                  </Button>
                </div>
              </div>
            )}
            {startMutation.error ? (
              <div className="mt-3">
                <InlineError message={(startMutation.error as Error).message} />
              </div>
            ) : null}
            {handoverAckMutation.error ? (
              <div className="mt-3">
                <InlineError
                  message={(handoverAckMutation.error as Error).message}
                />
              </div>
            ) : null}
          </section>

          <section
            className={mobileSectionClass(
              "cash",
              "border-b border-border-default px-4 py-4",
            )}
          >
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Banknote size={16} />
              Tiền mặt trong ca
            </div>
            <div className="grid gap-3 sm:grid-cols-[150px_160px_minmax(0,1fr)_auto]">
              <label className="text-xs text-text-muted">
                Loại
                <select
                  value={cashType}
                  onChange={(event) =>
                    setCashType(event.target.value as typeof cashType)
                  }
                  className="mt-1 h-10 w-full rounded border border-border-default bg-surface-base px-3 text-sm text-text-primary"
                >
                  <option value="pay_in">Nộp tiền</option>
                  <option value="pay_out">Rút tiền</option>
                  <option value="cash_drop">Nộp két</option>
                  <option value="cash_correction">Điều chỉnh</option>
                </select>
              </label>
              <label className="text-xs text-text-muted">
                Số tiền
                <input
                  value={cashAmount}
                  onChange={(event) => setCashAmount(event.target.value)}
                  className="mt-1 h-10 w-full rounded border border-border-default bg-surface-base px-3 text-sm text-text-primary"
                  inputMode="numeric"
                />
              </label>
              <label className="text-xs text-text-muted">
                Lý do
                <input
                  value={cashReason}
                  onChange={(event) => setCashReason(event.target.value)}
                  className="mt-1 h-10 w-full rounded border border-border-default bg-surface-base px-3 text-sm text-text-primary"
                />
              </label>
              <Button
                disabled={
                  !currentShift ||
                  cashMutation.isPending ||
                  !cashAmount ||
                  !cashReason
                }
                onClick={() => cashMutation.mutate()}
                className="self-end w-full sm:w-auto"
              >
                Ghi nhận
              </Button>
            </div>
            {cashMutation.error ? (
              <div className="mt-3">
                <InlineError message={(cashMutation.error as Error).message} />
              </div>
            ) : null}
          </section>

          <section
            className={mobileSectionClass(
              "stock",
              "border-b border-border-default px-4 py-4",
            )}
          >
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
              <AlertTriangle size={16} />
              Kiểm nhanh tồn
            </div>
            <PaginatedListFrame
              label="Phân trang sản phẩm kiểm tồn"
              rowNoun="sản phẩm đã tải"
              meta={stockCountPageMeta}
              onPageChange={setStockCountPage}
            >
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px_minmax(0,1fr)_auto]">
                <label className="text-xs text-text-muted">
                  Sản phẩm
                  <select
                    value={countItemId}
                    onChange={(event) => setCountItemId(event.target.value)}
                    className="mt-1 h-10 w-full rounded border border-border-default bg-surface-base px-3 text-sm text-text-primary"
                  >
                    <option value="">Chọn sản phẩm</option>
                    {selectedCountItem &&
                    !visibleStockCountItems.some(
                      (item) => item.id === selectedCountItem.id,
                    ) ? (
                      <option value={selectedCountItem.id}>
                        {selectedCountItem.sku} · {selectedCountItem.title}
                      </option>
                    ) : null}
                    {visibleStockCountItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.sku} · {item.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-text-muted">
                  Đếm được
                  <input
                    value={countedQty}
                    onChange={(event) => setCountedQty(event.target.value)}
                    className="mt-1 h-10 w-full rounded border border-border-default bg-surface-base px-3 text-sm text-text-primary"
                    inputMode="numeric"
                  />
                </label>
                <label className="text-xs text-text-muted">
                  Ghi chú
                  <input
                    value={countReason}
                    onChange={(event) => setCountReason(event.target.value)}
                    className="mt-1 h-10 w-full rounded border border-border-default bg-surface-base px-3 text-sm text-text-primary"
                  />
                </label>
                <Button
                  disabled={
                    !currentShift ||
                    !countItemId ||
                    !countedQty ||
                    countMutation.isPending
                  }
                  onClick={() => countMutation.mutate()}
                  className="self-end w-full sm:w-auto"
                >
                  Lưu count
                </Button>
              </div>
            </PaginatedListFrame>
            {selectedCountItem ? (
              <div className="mt-2 text-xs text-text-muted">
                Tồn hệ thống:{" "}
                {selectedCountItem.location_levels?.[0]?.stocked_quantity ?? 0}
              </div>
            ) : null}
            {countMutation.error ? (
              <div className="mt-3">
                <InlineError message={(countMutation.error as Error).message} />
              </div>
            ) : null}
          </section>

          <section className={mobileSectionClass("close", "px-4 py-4")}>
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
              <CheckCircle2 size={16} />
              Đóng ca
            </div>
            <div className="mb-3 flex gap-2 md:hidden">
              {[
                { id: "count" as const, label: "1. Đếm tiền" },
                { id: "stock" as const, label: "2. Kiểm tồn" },
                { id: "handover" as const, label: "3. Bàn giao" },
              ].map((step) => (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => setCloseStep(step.id)}
                  className={[
                    "h-9 flex-1 rounded border px-2 text-xs font-medium",
                    closeStep === step.id
                      ? "border-action-primary bg-surface-selected text-action-primary"
                      : "border-border-default bg-surface-base text-text-secondary",
                  ].join(" ")}
                >
                  {step.label}
                </button>
              ))}
            </div>
            <div
              className={[
                closeStep === "count" ? "grid" : "hidden md:grid",
                "gap-3 sm:grid-cols-[160px_minmax(0,1fr)_auto]",
              ].join(" ")}
            >
              <label className="text-xs text-text-muted">
                Tiền đếm thực tế
                <input
                  value={closeCash}
                  onChange={(event) => setCloseCash(event.target.value)}
                  className="mt-1 h-10 w-full rounded border border-border-default bg-surface-base px-3 text-sm text-text-primary"
                  inputMode="numeric"
                />
              </label>
              <label className="text-xs text-text-muted">
                Lý do lệch
                <input
                  value={closeReason}
                  onChange={(event) => setCloseReason(event.target.value)}
                  className="mt-1 h-10 w-full rounded border border-border-default bg-surface-base px-3 text-sm text-text-primary"
                />
              </label>
              <Button
                variant="secondary"
                disabled={!currentShift || previewMutation.isPending}
                onClick={() => previewMutation.mutate()}
                className="self-end w-full sm:w-auto"
              >
                X-report
              </Button>
            </div>
            <div
              className={[
                closeStep === "stock" ? "block" : "hidden md:block",
                "mt-3 rounded border border-border-default bg-surface-subtle p-3 text-xs text-text-secondary",
              ].join(" ")}
            >
              Kiểm nhanh tồn chỉ ghi nhận chênh lệch để đối soát ca, không tự
              điều chỉnh tồn kho.
              <Button
                variant="secondary"
                size="sm"
                className="mt-2 w-full md:w-auto"
                onClick={() => setMobileTab("stock")}
              >
                Mở kiểm nhanh tồn
              </Button>
            </div>
            <div
              className={[
                closeStep === "handover" ? "grid" : "hidden md:grid",
                "mt-3 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]",
              ].join(" ")}
            >
              <label className="text-xs text-text-muted">
                Bàn giao
                <input
                  value={handoverNote}
                  onChange={(event) => setHandoverNote(event.target.value)}
                  className="mt-1 h-10 w-full rounded border border-border-default bg-surface-base px-3 text-sm text-text-primary"
                />
              </label>
              <Button
                disabled={
                  !currentShift || !closeCash || closeMutation.isPending
                }
                onClick={() => closeMutation.mutate()}
                className="self-end w-full sm:w-auto"
              >
                Đóng ca
              </Button>
            </div>
            {preview || closeMutation.data?.data ? (
              <div
                className={[
                  closeStep === "count" ? "grid" : "hidden md:grid",
                  "mt-3 gap-2 text-sm sm:grid-cols-3",
                ].join(" ")}
              >
                <div className="rounded border border-border-default bg-surface-subtle p-3">
                  <div className="text-xs text-text-muted">Tiền kỳ vọng</div>
                  <div className="font-semibold text-text-primary">
                    {money((preview || closeMutation.data?.data)?.cashExpected)}
                  </div>
                </div>
                <div className="rounded border border-border-default bg-surface-subtle p-3">
                  <div className="text-xs text-text-muted">Chênh lệch</div>
                  <div className="font-semibold text-text-primary">
                    {money(
                      (preview || closeMutation.data?.data)?.shift
                        ?.cashVarianceAmount,
                    )}
                  </div>
                </div>
                <div className="rounded border border-border-default bg-surface-subtle p-3">
                  <div className="text-xs text-text-muted">Đơn hàng</div>
                  <div className="font-semibold text-text-primary">
                    {(preview || closeMutation.data?.data)?.orderIds?.length ||
                      0}
                  </div>
                </div>
              </div>
            ) : null}
            {previewMutation.error || closeMutation.error ? (
              <div className="mt-3">
                <InlineError
                  message={
                    ((previewMutation.error || closeMutation.error) as Error)
                      .message
                  }
                />
              </div>
            ) : null}
          </section>
        </div>

        <div
          className={[
            mobileSideVisible ? "block" : "hidden md:block",
            "min-h-0 overflow-auto",
          ].join(" ")}
        >
          {shouldShowManagerPanel ? (
            <>
              <section className="border-b border-border-default px-4 py-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-text-primary">
                    Quản lý ca
                  </div>
                  {shiftsQuery.isFetching ? (
                    <span className="text-xs text-text-muted">Đang tải...</span>
                  ) : null}
                </div>
                <PaginatedListFrame
                  label="Phân trang quản lý ca"
                  rowNoun="ca"
                  meta={shiftsMeta}
                  busy={shiftsQuery.isFetching}
                  onPageChange={setShiftsPage}
                  loading={shiftsQuery.isLoading || shiftsCorrecting}
                  loadingContent={
                    <div className="p-3 text-sm text-text-muted">
                      Đang tải danh sách ca...
                    </div>
                  }
                  showPagination={Boolean(
                    shiftsQuery.data && !shiftsQuery.error && !shiftsCorrecting,
                  )}
                >
                  <div className="space-y-2">
                    {shiftsQuery.error ? (
                      <InlineError
                        message={(shiftsQuery.error as Error).message}
                        onRetry={() => shiftsQuery.refetch()}
                        stale
                      />
                    ) : null}
                    {!reportScopeReady ? (
                      <div className="text-sm text-text-muted">
                        Đang xác định phạm vi báo cáo...
                      </div>
                    ) : null}
                    {(shiftsQuery.data?.data || []).map((shift) => (
                      <button
                        key={shift.id}
                        type="button"
                        onClick={() => setSelectedShiftId(shift.id)}
                        className={[
                          "w-full rounded border p-3 text-left transition-colors",
                          selectedShiftId === shift.id
                            ? "border-action-primary bg-surface-selected"
                            : "border-border-default bg-surface-base hover:bg-surface-hover",
                        ].join(" ")}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-text-primary">
                              Z {shift.zNumber || "-"} ·{" "}
                              {statusLabel(shift.status)}
                            </div>
                            <div className="mt-1 text-xs text-text-muted">
                              {time(shift.openedAt)}
                              {shift.closedAt
                                ? ` - ${time(shift.closedAt)}`
                                : ""}
                            </div>
                          </div>
                          <ReviewBadge shift={shift} />
                        </div>
                      </button>
                    ))}
                    {shiftsQuery.data?.data?.length === 0 ? (
                      <div className="text-sm text-text-muted">Chưa có ca.</div>
                    ) : null}
                  </div>
                </PaginatedListFrame>
              </section>

              <section className="px-4 py-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <Flag size={16} />
                  Chi tiết review
                </div>
                {!selectedShiftId ? (
                  <div className="text-sm text-text-muted">
                    Chọn một ca để xem X-report.
                  </div>
                ) : selectedReportQuery.isLoading ? (
                  <div className="text-sm text-text-muted">
                    Đang tải X-report...
                  </div>
                ) : selectedReport ? (
                  <div className="space-y-3">
                    <ShiftReportReadout report={selectedReport} />
                    {canReviewShifts ? (
                      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                        <input
                          value={reviewReason}
                          onChange={(event) =>
                            setReviewReason(event.target.value)
                          }
                          placeholder="Lý do flag"
                          className="h-10 rounded border border-border-default bg-surface-base px-3 text-sm text-text-primary"
                        />
                        <Button
                          className="w-full sm:w-auto"
                          variant="secondary"
                          disabled={reviewMutation.isPending}
                          onClick={() =>
                            reviewMutation.mutate({
                              id: selectedShiftId,
                              status: "flagged",
                            })
                          }
                        >
                          Gắn cờ
                        </Button>
                        <Button
                          className="w-full sm:w-auto"
                          disabled={reviewMutation.isPending}
                          onClick={() =>
                            reviewMutation.mutate({
                              id: selectedShiftId,
                              status: "approved",
                            })
                          }
                        >
                          Duyệt
                        </Button>
                      </div>
                    ) : null}
                    {canForceCloseShifts &&
                    (selectedReport.shift.status === "open" ||
                      selectedReport.shift.status === "closing") ? (
                      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                        <input
                          value={forceReason}
                          onChange={(event) =>
                            setForceReason(event.target.value)
                          }
                          placeholder="Lý do force close"
                          className="h-10 rounded border border-border-default bg-surface-base px-3 text-sm text-text-primary"
                        />
                        <Button
                          className="w-full sm:w-auto"
                          variant="danger"
                          disabled={
                            !forceReason || forceCloseMutation.isPending
                          }
                          onClick={() =>
                            forceCloseMutation.mutate(selectedShiftId)
                          }
                        >
                          Đóng cưỡng bức
                        </Button>
                      </div>
                    ) : null}
                    {reviewMutation.error ||
                    forceCloseMutation.error ||
                    selectedReportQuery.error ? (
                      <InlineError
                        message={
                          (
                            (reviewMutation.error ||
                              forceCloseMutation.error ||
                              selectedReportQuery.error) as Error
                          ).message
                        }
                      />
                    ) : null}
                  </div>
                ) : (
                  <div className="text-sm text-text-muted">
                    Không có dữ liệu.
                  </div>
                )}
              </section>
            </>
          ) : (
            <>
              <section className="border-b border-border-default px-4 py-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-text-primary">
                    Lịch sử của tôi
                  </div>
                  {myShiftsQuery.isFetching ? (
                    <span className="text-xs text-text-muted">Đang tải...</span>
                  ) : null}
                </div>
                <PaginatedListFrame
                  label="Phân trang lịch sử ca của tôi"
                  rowNoun="ca"
                  meta={myShiftsMeta}
                  busy={myShiftsQuery.isFetching}
                  onPageChange={setMyShiftsPage}
                  loading={myShiftsQuery.isLoading || myShiftsCorrecting}
                  loadingContent={
                    <div className="p-3 text-sm text-text-muted">
                      Đang tải lịch sử ca...
                    </div>
                  }
                  showPagination={Boolean(
                    myShiftsQuery.data &&
                    !myShiftsQuery.error &&
                    !myShiftsCorrecting,
                  )}
                >
                  <div className="space-y-2">
                    {myShiftsQuery.error ? (
                      <InlineError
                        message={(myShiftsQuery.error as Error).message}
                        onRetry={() => myShiftsQuery.refetch()}
                        stale
                      />
                    ) : null}
                    {!reportScopeReady ? (
                      <div className="text-sm text-text-muted">
                        Đang xác định phạm vi báo cáo...
                      </div>
                    ) : null}
                    {(myShiftsQuery.data?.data || []).map((shift) => (
                      <button
                        key={shift.id}
                        type="button"
                        onClick={() => setSelectedMyShiftId(shift.id)}
                        className={[
                          "w-full rounded border p-3 text-left transition-colors",
                          selectedMyShiftId === shift.id
                            ? "border-action-primary bg-surface-selected"
                            : "border-border-default bg-surface-base hover:bg-surface-hover",
                        ].join(" ")}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-text-primary">
                              Z {shift.zNumber || "-"} ·{" "}
                              {statusLabel(shift.status)}
                            </div>
                            <div className="mt-1 text-xs text-text-muted">
                              {time(shift.openedAt)}
                              {shift.closedAt
                                ? ` - ${time(shift.closedAt)}`
                                : ""}
                            </div>
                          </div>
                          <ReviewBadge shift={shift} />
                        </div>
                      </button>
                    ))}
                    {myShiftsQuery.data?.data?.length === 0 ? (
                      <div className="text-sm text-text-muted">
                        Chưa có ca của bạn.
                      </div>
                    ) : null}
                  </div>
                </PaginatedListFrame>
              </section>

              <section className="px-4 py-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <Flag size={16} />
                  Chi tiết ca của tôi
                </div>
                {!selectedMyShiftId ? (
                  <div className="text-sm text-text-muted">
                    Chọn một ca để xem đầy đủ chi tiết.
                  </div>
                ) : selectedMyReportQuery.isLoading ? (
                  <div className="text-sm text-text-muted">
                    Đang tải chi tiết ca...
                  </div>
                ) : selectedMyReport ? (
                  <ShiftReportReadout report={selectedMyReport} />
                ) : (
                  <div className="text-sm text-text-muted">
                    Không có dữ liệu.
                  </div>
                )}
                {selectedMyReportQuery.error ? (
                  <div className="mt-3">
                    <InlineError
                      message={(selectedMyReportQuery.error as Error).message}
                    />
                  </div>
                ) : null}
              </section>
            </>
          )}
        </div>
      </div>

      {busy ? (
        <div className="fixed bottom-[calc(64px+env(safe-area-inset-bottom))] left-1/2 z-50 -translate-x-1/2 rounded border border-border-default bg-surface-base px-3 py-2 text-xs text-text-muted shadow md:bottom-3">
          Đang xử lý...
        </div>
      ) : null}
    </div>
  );
}
