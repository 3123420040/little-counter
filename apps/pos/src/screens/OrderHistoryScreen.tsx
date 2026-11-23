import { useOffsetListPagination } from "../hooks/useOffsetListPagination";
import { useEffect, useRef, useState } from "react";
import {
  Button, Drawer, FilterBar, InlineError, PaginatedListFrame, loadedListPaginationMeta, localListPaginationMeta, MetricCell, OperationalTable,
  PageHeader, Panel, ResponsiveMetricGrid, SearchBox, StatusPill, TableSkeleton,
} from "@medusa-snus/ui";
import { Download } from "lucide-react";
import { CustomerSearch } from "../components/CustomerSearch";
import { PaymentIntentFinancialSummary } from "../components/PaymentIntentFinancialSummary";
import { OrderCorrectionDrawer } from "../components/OrderCorrectionDrawer";
import { PartnerDeliveryContactPanel } from "../components/PartnerDeliveryContactPanel";
import { OrderShippingAdjustmentPanel } from "../components/OrderShippingAdjustmentPanel";
import { ManualBankConfirmationDialog } from "../components/ManualBankConfirmationDialog";
import { SALES_CHANNELS, salesChannelLabel } from "../config/salesChannels";
import { downloadOrderExportCsv, emailReceipt, fetchReceiptPdf, fetchReceiptText } from "../api/endpoints";
import { useCancelOrder, useConfirmManualBankPayment, useEffectiveOrderFeatureDetail, useEffectiveOrderFeaturePage, useManualReviewPaymentIntents, useOrderCancellationQuote, useOrderCreatorOptions, useOrderDetail, useOrders, useRefundOrder, useUpdateOrder } from "../hooks/useOrders";
import type { OrderListItem } from "../api/endpoints";
import { OrderCancelDialog } from "../components/OrderCancelDialog";
import { OrderRefundDialog } from "../components/OrderRefundDialog";
import { OrderRecreateModal } from "../components/OrderRecreateModal";
import { OrderCreatorFilter } from "../components/OrderCreatorFilter";
import { useClientOperatingScope } from "../hooks/useProducts";
import { useAuth } from "../hooks/useAuth";
import { usePermission } from "../hooks/usePermissions";
import { useI18n } from "../i18n";
import { getOrderCorrectionEligibility } from "../utils/orderCorrectionEligibility";
import { ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1 } from "../config/orderFinancialFeature";
import { presentEffectiveOrderLivePagesV2, presentEffectiveOrderLivePagesV3 } from "../utils/effectiveOrderLiveListPresentation";
import { usePaymentFeeRuntimeBuild } from "../hooks/useRuntimeCapabilities";
import { useAppAccessSnapshot } from "../hooks/useAppAccessSnapshot";
import { bindOrderHistoryCapabilities } from "../utils/orderHistoryCapabilityBinding";
import { validateReceiptEmail } from "../utils/receiptEmail";
import { buildPartitionedQueryKeyV1 } from "../utils/appAccessSnapshot";

const ORDER_EXPORT_MAX_DAYS = 92;
const ORDER_PAGE_SIZE = 20;
const DETAIL_PAGE_SIZE = 20;

function formatMoney(value: number | string | null | undefined) {
  const amount = Number(value || 0);
  return `${amount.toLocaleString("vi-VN")} ₫`;
}

function formatMinorMoney(value: number, currencyCode: string, minorUnitExponent: number) {
  return `${(value / (10 ** minorUnitExponent)).toLocaleString("vi-VN", {
    minimumFractionDigits: minorUnitExponent,
    maximumFractionDigits: minorUnitExponent,
  })} ${currencyCode}`;
}

function formatMajorCurrency(
  value: number | string,
  currencyCode: string,
  minorUnitExponent: number,
) {
  return `${Number(value).toLocaleString("vi-VN", {
    minimumFractionDigits: minorUnitExponent,
    maximumFractionDigits: minorUnitExponent,
  })} ${currencyCode}`;
}

function formatQuantity(value: number | string | null | undefined) {
  const quantity = Number(value || 0);
  return Number.isInteger(quantity) ? String(quantity) : quantity.toLocaleString("vi-VN");
}

function toIsoDate(date: Date) {
  // Use the local calendar day (not UTC) so "Hôm nay" matches the day the
  // operator sees in Vietnam, even near the UTC midnight boundary.
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return toIsoDate(date);
}

function dateRangeDays(dateFrom: string, dateTo: string) {
  if (!dateFrom || !dateTo || dateFrom > dateTo) return 0;
  const from = Date.parse(`${dateFrom}T00:00:00.000Z`);
  const to = Date.parse(`${dateTo}T00:00:00.000Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.floor((to - from) / 86_400_000) + 1;
}

export default function OrderHistoryScreen() {
  const { t } = useI18n();
  const today = toIsoDate(new Date());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ordersPage, setOrdersPage] = useState(1);
  const [manualReviewPage, setManualReviewPage] = useState(1);
  const [detailItemsPage, setDetailItemsPage] = useState(1);
  const [paymentEntriesPage, setPaymentEntriesPage] = useState(1);
  const [stockAdjustmentsPage, setStockAdjustmentsPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | "completed" | "other">("all");
  // An empty selection deliberately means all creators, including orders whose
  // provenance is partner/unknown. Selected values are an OR set on the API.
  const [creatorOperatorIds, setCreatorOperatorIds] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [detailNotes, setDetailNotes] = useState("");
  const [detailSalesChannel, setDetailSalesChannel] = useState("pos_counter");
  const [receiptText, setReceiptText] = useState("");
  const [receiptEmail, setReceiptEmail] = useState("");
  const [receiptStatus, setReceiptStatus] = useState("");
  const [receiptError, setReceiptError] = useState("");
  const [receiptPending, setReceiptPending] = useState<"text" | "pdf" | "email" | null>(null);
  const receiptEmailValidation = validateReceiptEmail(receiptEmail);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [recreateOpen, setRecreateOpen] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [refundError, setRefundError] = useState("");
  const [manualBankOpen, setManualBankOpen] = useState(false);
  const [manualBankError, setManualBankError] = useState("");
  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState("");
  const { operator } = useAuth();
  const { snapshot: appAccess, runtime } = useAppAccessSnapshot();
  const feeBuild = usePaymentFeeRuntimeBuild();
  const feeAwareOrders = feeBuild?.paymentFeeCapabilities.ordersRead.includes("v5") === true;
  const feeAwareCsv = feeBuild?.paymentFeeCapabilities.csvRead.includes("v5") === true;
  const recreateAvailable = feeBuild?.paymentFeeCapabilities.orderRecreate.includes("v3") === true
    || (!feeAwareOrders && runtime.surfaces.orderRecreate === "enabled");
  const exportController = useRef<AbortController | null>(null);
  const cancellationScope = useClientOperatingScope();
  const accessPartition = appAccess ? JSON.stringify(buildPartitionedQueryKeyV1(appAccess, "orders")) : "";
  useEffect(() => {
    setCancelOpen(false); setCancelError(""); setSelectedId(null);
    setCreatorOperatorIds([]); setOrdersPage(1); setRecreateOpen(false);
  }, [operator?.id, cancellationScope.operatingMerchantId, cancellationScope.operatingStoreId, accessPartition]);
  const exportPartition = JSON.stringify([accessPartition, feeBuild?.sourceCommit, feeBuild?.releaseId, feeAwareCsv, dateFrom, dateTo, status, search, creatorOperatorIds]);
  useEffect(() => {
    setExportPending(false); setExportError("");
    return () => { exportController.current?.abort(); exportController.current = null; };
  }, [exportPartition]);
  const {
    effectivePageEnabled,
    legacyOrdersEnabled,
    capabilityPending,
    v2Compatibility,
    explicitUnavailable,
  } = bindOrderHistoryCapabilities(runtime, feeAwareOrders);
  const legacyOrders = useOrders({ dateFrom, dateTo, limit: 200 }, legacyOrdersEnabled);
  const effectivePages = useEffectiveOrderFeaturePage({
    from: dateFrom,
    to: dateTo,
    ...(search.trim() ? { search } : {}),
    status,
    ...(creatorOperatorIds.length ? { creatorOperatorIds } : {}),
    limit: ORDER_PAGE_SIZE,
  });
  const creatorOptions = useOrderCreatorOptions(effectivePageEnabled);
  const feePresentation = effectivePageEnabled && feeAwareOrders && effectivePages.data
    ? presentEffectiveOrderLivePagesV3(effectivePages.data.pages) : null;
  const effectivePresentation = feePresentation || (effectivePageEnabled && !feeAwareOrders && effectivePages.data
    ? presentEffectiveOrderLivePagesV2(effectivePages.data.pages)
    : null);
  const data = effectivePageEnabled
    ? effectivePresentation
      ? {
          orders: effectivePresentation.orders,
          totalCount: effectivePresentation.totalCount,
          completedCount: effectivePresentation.loadedCompletedCount,
          totalRevenue: 0,
        }
      : undefined
    : legacyOrders.data;
  const isLoading = effectivePageEnabled ? effectivePages.isLoading : legacyOrders.isLoading;
  const error = effectivePageEnabled ? effectivePages.error : legacyOrders.error;
  const refetch = effectivePageEnabled ? effectivePages.refetch : legacyOrders.refetch;
  const orders = data?.orders;
  // Headline metrics come from the server aggregate over the full date range,
  // not from the (limit-capped) page, so they stay correct on busy ranges.
  const totalOrderCount = data?.totalCount ?? 0;
  const totalRevenue = data?.totalRevenue ?? 0;
  const effectiveItemQuantity = effectivePresentation
    ? effectivePresentation.currencies.reduce((total, currency) => total + currency.effectiveItemQuantity, 0)
    : 0;
  const dateRangeInvalid = dateFrom > dateTo;
  const exportRangeDays = dateRangeDays(dateFrom, dateTo);
  const exportDateRangeTooLong = exportRangeDays > ORDER_EXPORT_MAX_DAYS;
  const manualReviewIntents = useManualReviewPaymentIntents(
    !capabilityPending && !explicitUnavailable,
    { limit: ORDER_PAGE_SIZE, offset: (manualReviewPage - 1) * ORDER_PAGE_SIZE },
  );
  const canReadPartnerContact = usePermission("partner:contact_read");
  const updateOrder = useUpdateOrder();
  const cancelOrderMutation = useCancelOrder();
  const refundOrderMutation = useRefundOrder();
  const manualBankMutation = useConfirmManualBankPayment();
  const cancellationQuote = useOrderCancellationQuote(selectedId, cancelOpen);

  const selectedSummary = selectedId ? orders?.find((o) => o.id === selectedId) : null;
  const operationalDetail = useOrderDetail(selectedId);
  const operationalOrder = operationalDetail.data as Partial<OrderListItem> | undefined;
  const selected = selectedSummary
    ? {
        ...(operationalOrder || {}),
        ...selectedSummary,
        paymentEntries: operationalOrder?.paymentEntries || selectedSummary.paymentEntries,
        paymentMethod: operationalOrder?.paymentMethod || selectedSummary.paymentMethod,
        paymentStatus: operationalOrder?.paymentStatus || selectedSummary.paymentStatus,
        canonicalPaymentSummary: operationalOrder?.canonicalPaymentSummary || selectedSummary.canonicalPaymentSummary,
        manualBankConfirmationEnabled: operationalOrder?.manualBankConfirmationEnabled === true,
        customer: operationalOrder?.customer || selectedSummary.customer,
        customerId: operationalOrder?.customerId || selectedSummary.customerId,
        customerAttribution: operationalOrder?.customerAttribution || selectedSummary.customerAttribution,
        createdBy: operationalOrder?.createdBy || selectedSummary.createdBy,
        notes: operationalOrder?.notes ?? selectedSummary.notes,
        correctionSummary: operationalOrder?.correctionSummary || selectedSummary.correctionSummary,
        corrections: operationalOrder?.corrections || selectedSummary.corrections,
        stockAdjustments: operationalOrder?.stockAdjustments || selectedSummary.stockAdjustments,
      } satisfies OrderListItem
    : null;
  const effectiveDetail = useEffectiveOrderFeatureDetail(selectedId);
  const effectiveDetailEnabled = effectiveDetail.contractVersion === "v3" || runtime.selected.orderDetail === "v2";
  const effectiveComponents = effectiveDetail.data?.components;
  const effectiveMoney = (value: number) => effectiveDetail.data
    ? formatMinorMoney(
        value,
        effectiveDetail.data.currencyCode,
        effectiveDetail.data.minorUnitExponent,
      )
    : "—";
  const selectedLineMoney = (value: number | string) => effectiveDetailEnabled
    ? effectiveMoney(Number(value))
    : formatMoney(value);
  const selectedCustomerName = selected?.customer
    ? `${selected.customer.last_name || ""} ${selected.customer.first_name || ""}`.trim() || "Khách đã liên kết"
    : selected?.customerAttribution === "walk_in"
      ? t("orders.walkIn")
      : "Chưa xác định";
  const selectedItems = effectiveDetailEnabled
    ? (effectiveDetail.data?.effectiveItems || []).map((item) => ({
        id: item.lineId,
        productId: item.productId,
        variantId: item.variantId,
        name: item.titleSnapshot,
        sku: item.skuSnapshot,
        quantity: item.quantity,
        unitPrice: item.unitPriceMinor,
        lineTotal: item.lineTotalMinor,
      }))
    : selected?.items || [];
  const selectedCreator = selected?.createdBy;
  const selectedCreatorName = selectedCreator?.displayName || selectedCreator?.operatorId || "Không rõ";
  const selectedStockAdjustments = selected?.stockAdjustments || [];
  const selectedPaymentEntries = selected?.paymentEntries || [];
  const selectedItemsMeta = localListPaginationMeta(selectedItems.length, detailItemsPage, DETAIL_PAGE_SIZE);
  const visibleSelectedItems = selectedItems.slice(
    (selectedItemsMeta.page - 1) * DETAIL_PAGE_SIZE,
    selectedItemsMeta.page * DETAIL_PAGE_SIZE,
  );
  const paymentEntriesMeta = localListPaginationMeta(selectedPaymentEntries.length, paymentEntriesPage, DETAIL_PAGE_SIZE);
  const visiblePaymentEntries = selectedPaymentEntries.slice(
    (paymentEntriesMeta.page - 1) * DETAIL_PAGE_SIZE,
    paymentEntriesMeta.page * DETAIL_PAGE_SIZE,
  );
  const stockAdjustmentsMeta = localListPaginationMeta(selectedStockAdjustments.length, stockAdjustmentsPage, DETAIL_PAGE_SIZE);
  const visibleStockAdjustments = selectedStockAdjustments.slice(
    (stockAdjustmentsMeta.page - 1) * DETAIL_PAGE_SIZE,
    stockAdjustmentsMeta.page * DETAIL_PAGE_SIZE,
  );
  const canCorrectOrder = operator?.role === "manager" || operator?.role === "owner";
  const correctionEligibility = selected
    ? getOrderCorrectionEligibility(selected)
    : { allowed: false };
  const canSendReceiptEmail = usePermission("customer:write")
    && !ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1.effectiveReceiptEnabled;
  const canRefundOrder = usePermission("order:refund");
  const canConfirmManualBank = usePermission("accounting:write");
  const canExportOrders = operator?.role === "manager" || operator?.role === "accountant" || operator?.role === "owner";
  const refundPayableCandidate = selected?.canonicalPaymentSummary?.customerRefundPayableMinor;
  const refundAmountMinor = Number.isSafeInteger(refundPayableCandidate)
    && Number(refundPayableCandidate) >= 0
    ? Number(refundPayableCandidate)
    : null;
  const hasPendingManualBank = Boolean(selected && !["canceled", "cancelled"].includes(selected.status) && (
    selectedPaymentEntries.some((entry) =>
      ["bank_transfer", "manual_bank"].includes(entry.method)
      && (entry.effectiveStatus ?? entry.status) === "pending"
      && ["charge", "in"].includes(entry.direction),
    )
  ));

  useEffect(() => {
    setDetailNotes(selected?.notes || "");
    setDetailSalesChannel(selected?.salesChannel || "pos_counter");
    setReceiptText("");
    setReceiptEmail("");
    setReceiptStatus("");
    setReceiptError("");
    setReceiptPending(null);
    setDetailItemsPage(1);
    setPaymentEntriesPage(1);
    setStockAdjustmentsPage(1);
  }, [selected?.id, selected?.notes, selected?.salesChannel]);

  useEffect(() => {
    setOrdersPage(1);
  }, [dateFrom, dateTo, search, status, creatorOperatorIds, effectivePageEnabled]);

  useEffect(() => {
    setExportError("");
    setSelectedId(null);
  }, [dateFrom, dateTo, search, status, creatorOperatorIds]);

  useEffect(() => {
    if (!selected) {
      setCorrectionOpen(false);
      setRefundOpen(false);
      setManualBankOpen(false);
    }
  }, [selected]);

  function saveOrderFields() {
    if (!selected) return;
    updateOrder.mutate({
      orderId: selected.id,
      input: {
        notes: detailNotes,
        ...(selected.salesChannelLocked ? {} : { salesChannel: detailSalesChannel }),
      },
    });
  }

  async function showReceiptText() {
    if (!selected) return;
    setReceiptPending("text");
    setReceiptError("");
    setReceiptStatus("");
    try {
      setReceiptText(await fetchReceiptText(selected.id));
      setReceiptStatus("Đã tải receipt text");
    } catch (error) {
      setReceiptError(error instanceof Error ? error.message : "Không thể tải receipt text");
    } finally {
      setReceiptPending(null);
    }
  }

  async function openReceiptPdf() {
    if (!selected) return;
    setReceiptPending("pdf");
    setReceiptError("");
    setReceiptStatus("");
    try {
      const blob = await fetchReceiptPdf(selected.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.download = `${selected.display_id || selected.id}-receipt.pdf`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setReceiptStatus("Đã tải receipt PDF");
    } catch (error) {
      setReceiptError(error instanceof Error ? error.message : "Không thể tải receipt PDF");
    } finally {
      setReceiptPending(null);
    }
  }

  async function sendReceipt() {
    if (!selected || !receiptEmailValidation.valid) return;
    setReceiptPending("email");
    setReceiptError("");
    setReceiptStatus("");
    try {
      await emailReceipt(selected.id, receiptEmailValidation.normalized);
      setReceiptStatus("Đã ghi nhận gửi email hóa đơn");
    } catch (error) {
      setReceiptError(error instanceof Error ? error.message : "Không thể gửi email hóa đơn");
    } finally {
      setReceiptPending(null);
    }
  }

  async function exportOrdersCsv() {
    if (!canExportOrders || dateRangeInvalid || exportDateRangeTooLong || exportController.current || (feeAwareCsv && !appAccess)) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExportPending(true);
    setExportError("");
    try {
      await downloadOrderExportCsv({
        dateFrom,
        dateTo,
        status,
        search,
        ...(creatorOperatorIds.length ? { creatorOperatorIds: [...creatorOperatorIds] } : {}),
      }, appAccess ? { scope: { scopeKind: "report", merchantId: appAccess.merchantId, storeIds: [...appAccess.storeIds] }, signal: controller.signal, feeAware: feeAwareCsv } : undefined);
    } catch (error) {
      if (!controller.signal.aborted && exportController.current === controller) setExportError(error instanceof Error ? error.message : "Không thể xuất CSV đơn hàng");
    } finally {
      if (exportController.current === controller) { exportController.current = null; setExportPending(false); }
    }
  }

  const filteredOrders = effectivePageEnabled ? (orders || []) : (orders || []).filter((order) => {
    const term = search.trim().toLowerCase();
    const customerName = order.customer
      ? `${order.customer.last_name || ""} ${order.customer.first_name || ""}`.trim().toLowerCase()
      : "";
    const matchesSearch = !term
      || String(order.display_id || order.id || "").toLowerCase().includes(term)
      || customerName.includes(term);
    const matchesStatus = status === "all"
      || (status === "completed" ? order.status === "completed" : order.status !== "completed");
    return matchesSearch && matchesStatus;
  });
  const loadedEffectivePageCount = effectivePresentation
    ? Math.ceil(effectivePresentation.loadedCount / ORDER_PAGE_SIZE)
    : 0;
  const ordersMeta = effectivePageEnabled
    ? {
        ...localListPaginationMeta(totalOrderCount, ordersPage, ORDER_PAGE_SIZE),
        // Cursor pagination is authoritative for continuation. The exact total
        // is useful for the page count, but must not let the UI advance past a
        // cursor boundary the server did not provide.
        hasNext: ordersPage < loadedEffectivePageCount || Boolean(effectivePresentation?.hasMore),
      }
    : loadedListPaginationMeta(filteredOrders.length, ordersPage, ORDER_PAGE_SIZE);
  const visibleOrders = filteredOrders.slice(
    (ordersMeta.page - 1) * ORDER_PAGE_SIZE,
    ordersMeta.page * ORDER_PAGE_SIZE,
  );
  const { meta: manualReviewMeta, correcting: correctingManualReviewPage } = useOffsetListPagination(
    manualReviewIntents.data?.count, manualReviewPage, ORDER_PAGE_SIZE, setManualReviewPage,
  );

  async function handleOrderPageChange(nextPage: number) {
    if (!effectivePageEnabled || nextPage <= loadedEffectivePageCount) {
      setOrdersPage(nextPage);
      return;
    }
    const result = await effectivePages.fetchNextPage();
    if (!result.isError) setOrdersPage(nextPage);
  }
  const orderExportButton = canExportOrders ? (
    <Button
      variant="secondary"
      size="sm"
      icon={<Download size={14} aria-hidden="true" />}
      onClick={() => void exportOrdersCsv()}
      disabled={exportPending || dateRangeInvalid || exportDateRangeTooLong || (feeAwareCsv && !appAccess)}
      title={
        exportDateRangeTooLong
          ? `Khoảng xuất tối đa ${ORDER_EXPORT_MAX_DAYS} ngày`
          : "Xuất toàn bộ dòng đơn hàng theo filter hiện tại"
      }
    >
      {exportPending ? "Đang xuất..." : "Xuất CSV"}
    </Button>
  ) : null;

  if (explicitUnavailable) {
    return (
      <div className="p-4">
        <InlineError
          message={`Không thể xác thực chế độ tương thích máy chủ (${runtime.handshakeState}). Danh sách đơn và các thao tác phụ thuộc runtime đã bị khóa.`}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <InlineError message="Không thể tải danh sách đơn hàng" onRetry={() => refetch()} stale />
      </div>
    );
  }

  if (capabilityPending) {
    return <div className="p-4"><TableSkeleton rows={8} cols={6} /></div>;
  }

  return (
    <div className="p-4 h-full">
      <div className="space-y-4 min-w-0">
        <PageHeader
          title={t("orders.title")}
          subtitle="Chọn khoảng thời gian, trạng thái hoặc mã đơn rồi xuất CSV để đối soát."
          actions={orderExportButton}
        />
        {v2Compatibility && (
          <div role="status" className="rounded-md border border-status-warning-border bg-status-warning-bg p-3 text-sm text-status-warning">
            Chế độ tương thích V2: thông tin khách thiếu được hiển thị là chưa xác định; thao tác phụ thuộc customer V3 bị khóa.
          </div>
        )}

        {/* Metrics */}
        <ResponsiveMetricGrid>
          <MetricCell label="Tổng đơn" value={String(totalOrderCount)} />
          {effectivePageEnabled ? (effectivePresentation?.currencies || []).map((currency) => (
            <MetricCell
              key={`${currency.currencyCode}-order-value`}
              label={`Giá trị đơn hiện tại (${currency.currencyCode})`}
              value={formatMinorMoney(currency.currentOrderGrossValueMinor, currency.currencyCode, currency.minorUnitExponent)}
            />
          )) : (
            <MetricCell label="Doanh thu" value={`${totalRevenue.toLocaleString("vi-VN")} ₫`} />
          )}
          {effectivePageEnabled && (
            <div title="Tổng số lượng ở phiên bản đơn hiệu lực mới nhất; đơn hủy đóng góp 0, kể cả đơn đang chờ xác minh thanh toán.">
              <MetricCell label="Số sản phẩm đã bán" value={formatQuantity(effectiveItemQuantity)} />
            </div>
          )}
          {feePresentation?.currencies.map((currency) => (
            <MetricCell key={`${currency.currencyCode}-payment-fee`} label={`Phí thanh toán trên đơn (${currency.currencyCode})`}
              value={formatMinorMoney(currency.paymentFeeCustomerTotalMinor, currency.currencyCode, currency.minorUnitExponent)} />
          ))}
        </ResponsiveMetricGrid>

        {manualReviewIntents.isError && <InlineError
          message="Không tải được danh sách thanh toán cần kiểm tra. Chưa thể kết luận không còn giao dịch cần xử lý."
          onRetry={() => manualReviewIntents.refetch()}
          stale={Boolean(manualReviewIntents.data)}
        />}
        {(manualReviewIntents.data?.count || 0) > 0 && (
          <Panel
            title="Đối soát cần xử lý"
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => manualReviewIntents.refetch()}
                disabled={manualReviewIntents.isFetching}
              >
                Tải lại
              </Button>
            }
          >
            <p className="text-sm text-text-muted mb-3">Toàn phạm vi cửa hàng được chọn để báo cáo; không áp dụng bộ lọc ngày hoặc người tạo đơn ở trên.</p>
<PaginatedListFrame
              label="Phân trang payment intents cần đối soát"
              rowNoun="payment intent"
              meta={manualReviewMeta}
              busy={manualReviewIntents.isFetching}
              loading={correctingManualReviewPage}
              showPagination={!correctingManualReviewPage}
              onPageChange={setManualReviewPage}
            >
            <OperationalTable
              ariaLabel="Payment intents cần manual review"
              columns={[
                { key: "reference", label: "Mã" },
                { key: "provider", label: "Provider" },
                { key: "amount", label: "Số tiền", align: "right" },
                { key: "reason", label: "Lý do" },
                { key: "updated", label: "Cập nhật" },
              ]}
              rows={(manualReviewIntents.data?.data || []).map((intent) => ({
                reference: (
                  <span className="font-mono text-xs font-medium text-text-primary">
                    {intent.referenceCode || intent.id.slice(0, 12)}
                  </span>
                ),
                provider: <StatusPill tone="warning" label={intent.provider} />,
                amount: (
                  <div className="tabular-nums font-medium text-text-primary">
                    {formatMoney(intent.amount)}
                    <PaymentIntentFinancialSummary financial={intent.financial} />
                  </div>
                ),
                reason: (
                  <span className="text-xs text-status-danger">
                    {intent.manualReviewReason || intent.status}
                  </span>
                ),
                updated: intent.updatedAt ? new Date(intent.updatedAt).toLocaleString("vi-VN") : "-",
              }))}
            />
            </PaginatedListFrame>
          </Panel>
        )}

        <FilterBar
          actions={
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setDateFrom(today); setDateTo(today); }}>
                Hôm nay
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { setDateFrom(daysAgo(6)); setDateTo(today); }}>
                7 ngày
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { setDateFrom(daysAgo(29)); setDateTo(today); }}>
                30 ngày
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setStatus("all");
                  setCreatorOperatorIds([]);
                  setDateFrom(today);
                  setDateTo(today);
                }}
              >
                Xóa lọc
              </Button>
            </div>
          }
        >
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder={effectivePageEnabled
              ? "Tìm mã đơn, tên hoặc SĐT khách hàng..."
              : "Tìm mã đơn hoặc khách hàng..."}
          />
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
            className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
          >
            <option value="all">Tất cả trạng thái</option>
            <option value="completed">Hoàn tất</option>
            <option value="other">Khác</option>
          </select>
          {effectivePageEnabled && (
            <OrderCreatorFilter options={creatorOptions.data || []} selectedIds={creatorOperatorIds} onChange={setCreatorOperatorIds} />
          )}
          <label className="flex items-center gap-2 text-xs text-text-muted">
            Từ
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm text-text-primary focus:border-action-primary focus:outline-none"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-text-muted">
            Đến
            <input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm text-text-primary focus:border-action-primary focus:outline-none"
            />
          </label>
        </FilterBar>

        {dateRangeInvalid && (
          <p className="text-xs text-status-danger" role="alert">
            "Từ ngày" không được sau "Đến ngày". Hãy điều chỉnh lại khoảng thời gian.
          </p>
        )}
        {canExportOrders && exportDateRangeTooLong && (
          <p className="text-xs text-status-danger" role="alert">
            Khoảng xuất CSV tối đa {ORDER_EXPORT_MAX_DAYS} ngày. Hãy chọn khoảng thời gian ngắn hơn.
          </p>
        )}
        {exportError && (
          <p className="text-xs text-status-danger" role="alert">
            {exportError}
          </p>
        )}

        {/* Orders Table */}
        <Panel title={t("orders.title")}>
          {isLoading ? (
            <TableSkeleton rows={8} cols={5} />
          ) : visibleOrders.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-sm text-text-muted">
                {(orders || []).length === 0
                  ? `Chưa có đơn hàng trong khoảng thời gian đã chọn`
                  : t("state.noResults")}
              </p>
            </div>
          ) : (
            <>
<PaginatedListFrame
              label="Phân trang đơn hàng"
              rowNoun="đơn hàng"
              meta={ordersMeta}
              busy={effectivePageEnabled && effectivePages.isFetchingNextPage}
              onPageChange={(nextPage) => void handleOrderPageChange(nextPage)}
            >
            <OperationalTable
              ariaLabel={t("orders.title")}
              selectedRowIndex={visibleOrders.findIndex((order) => order.id === selectedId)}
              columns={[
                { key: "displayId", label: "Mã ĐH" },
                { key: "customer", label: "KH" },
                { key: "salesChannel", label: "Kênh bán" },
                { key: "total", label: "Tổng", align: "right" },
                { key: "status", label: "Trạng thái" },
                { key: "date", label: "Ngày" },
              ]}
              rows={visibleOrders.map((o) => ({
                displayId: (
                  <span className="font-mono text-xs font-medium text-text-primary">
                    {o.display_id || o.id?.slice(0, 8)}
                  </span>
                ),
                customer: o.customer
                  ? `${o.customer.last_name || ""} ${o.customer.first_name || ""}`.trim() || "Khách đã liên kết"
                  : o.customerAttribution === "walk_in"
                    ? t("orders.walkIn")
                    : "Chưa xác định",
                salesChannel: o.salesChannelLabel || salesChannelLabel(o.salesChannel),
                total: (
                  <span className="tabular-nums font-medium">
                    {effectivePageEnabled && o.currencyCode !== undefined
                      ? formatMajorCurrency(o.total, o.currencyCode, o.minorUnitExponent || 0)
                      : formatMoney(o.total)}
                  </span>
                ),
                status: (
                  <StatusPill
                    tone={o.status === "completed" ? "success" : "warning"}
                    label={o.status}
                  />
                ),
                date: o.created_at
                  ? new Date(o.created_at).toLocaleDateString("vi-VN")
                  : "-",
              }))}
              onRowClick={(_, idx) => {
                const order = idx === undefined ? undefined : visibleOrders[idx];
                if (order) setSelectedId(order.id);
              }}
            />
            </PaginatedListFrame>
            </>
          )}
        </Panel>
      </div>

      {/* ── Detail Panel ── */}
      <Drawer
        open={!!selected}
        title={`Chi tiết ${selected?.display_id || selected?.id?.slice(0, 8) || ""}`}
        onClose={() => setSelectedId(null)}
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-text-muted">Trạng thái</span>
              <StatusPill
                tone={selected.status === "completed" ? "success" : "warning"}
                label={selected.status}
              />
            </div>
            {canCorrectOrder && (
              <div className="flex flex-col gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  onClick={() => setCorrectionOpen(true)}
                  disabled={!correctionEligibility.allowed}
                  aria-describedby={!correctionEligibility.allowed ? "order-correction-disabled-reason" : undefined}
                  title={correctionEligibility.reason}
                >
                  Điều chỉnh đơn
                </Button>
                {!correctionEligibility.allowed && correctionEligibility.reason && (
                  <p id="order-correction-disabled-reason" className="text-xs text-text-muted">
                    {correctionEligibility.reason}
                  </p>
                )}

                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  onClick={() => setRecreateOpen(true)}
                  disabled={!recreateAvailable}
                  title={!recreateAvailable ? "Máy chủ chưa xác nhận hỗ trợ tạo lại đơn ở phiên bản hiện tại." : undefined}
                >
                  Tạo lại đơn
                </Button>
              </div>
            )}
            {operationalOrder?.cancellationAccess?.allowed && (
              <Button variant="secondary" size="sm" className="w-full" disabled={selected.status === "canceled"}
                onClick={() => { setCancelError(""); setCancelOpen(true); }}>Hủy đơn</Button>
            )}
            {operationalOrder?.cancellationAccess?.reasonCode === "order_creator_provenance_unavailable" && (
              <p className="text-xs text-text-muted">Đơn này thiếu bằng chứng người tạo hoặc cửa hàng. Nhờ quản lý kiểm tra và hủy đơn.</p>
            )}
            {canRefundOrder && (selected.status === "canceled" || (refundAmountMinor ?? 0) > 0) && (
              <div className="rounded-lg border border-status-warning-border bg-status-warning-bg p-3">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-text-secondary">Số còn phải hoàn khách</span>
                  <strong className="tabular-nums text-text-primary">
                    {refundAmountMinor === null
                      ? "Chưa khả dụng"
                      : formatMinorMoney(
                          refundAmountMinor,
                          selected.currencyCode || "VND",
                          selected.minorUnitExponent ?? 0,
                        )}
                  </strong>
                </div>
                {refundAmountMinor === null ? (
                  <p className="mt-2 text-xs text-status-warning">
                    Chưa có bằng chứng số dư phải hoàn trong snapshot hiện tại. Không thể ghi nhận payout.
                  </p>
                ) : refundAmountMinor > 0 ? (
                  <Button
                    variant="danger"
                    size="sm"
                    className="mt-3 w-full"
                    onClick={() => {
                      setRefundError("");
                      setRefundOpen(true);
                    }}
                  >
                    Ghi nhận đã hoàn tiền
                  </Button>
                ) : (
                  <p className="mt-2 text-xs text-status-success">
                    Không còn khoản phải hoàn chưa thanh toán.
                  </p>
                )}
              </div>
            )}
            {selected.manualBankConfirmationEnabled === true
              && canConfirmManualBank
              && hasPendingManualBank
              && selected.status !== "canceled" && (
              <div className="rounded-lg border border-status-warning-border bg-status-warning-bg p-3">
                <div className="text-xs font-semibold text-text-primary">
                  Chuyển khoản đang chờ xác nhận
                </div>
                <p className="mt-1 text-xs text-text-secondary">
                  Chỉ xác nhận sau khi đã kiểm tra tiền thực nhận trong tài khoản ngân hàng.
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  className="mt-3 w-full"
                  onClick={() => {
                    setManualBankError("");
                    setManualBankOpen(true);
                  }}
                >
                  Xác nhận đã nhận chuyển khoản
                </Button>
              </div>
            )}
            <div className="rounded-lg border border-border-default bg-surface-panel p-3">
              <div className="mb-2 text-xs font-medium text-text-secondary">Hóa đơn</div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={showReceiptText} disabled={receiptPending !== null}>
                  {receiptPending === "text" ? "Đang tải..." : "Xem receipt text"}
                </Button>
                <Button variant="secondary" size="sm" onClick={openReceiptPdf} disabled={receiptPending !== null}>
                  {receiptPending === "pdf" ? "Đang tải..." : "Tải receipt PDF"}
                </Button>
              </div>
              {receiptText && (
                <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-border-subtle bg-surface-subtle p-2 text-xs text-text-primary">
                  {receiptText}
                </pre>
              )}
              {canSendReceiptEmail && (
                <div className="mt-3 space-y-1">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      type="email"
                      aria-label="Email nhận hóa đơn"
                      aria-invalid={!receiptEmailValidation.valid && receiptEmail.trim().length > 0}
                      placeholder="customer@example.com"
                      value={receiptEmail}
                      maxLength={320}
                      onChange={(event) => {
                        setReceiptEmail(event.target.value);
                        setReceiptStatus("");
                        setReceiptError("");
                      }}
                      className="h-9 min-w-0 flex-1 rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={sendReceipt}
                      disabled={receiptPending !== null || !receiptEmailValidation.valid}
                    >
                      {receiptPending === "email" ? "Đang gửi..." : "Gửi email hóa đơn"}
                    </Button>
                  </div>
                  {!receiptEmailValidation.valid && receiptEmail.trim().length > 0 ? (
                    <p className="text-xs text-status-danger" role="alert">{receiptEmailValidation.error}</p>
                  ) : null}
                </div>
              )}
              {ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1.effectiveReceiptEnabled && (
                <p className="mt-3 text-xs text-text-muted">
                  Email receipt được giữ tắt trong gói feature-only để không gửi nội dung legacy.
                </p>
              )}
              {receiptStatus && <p className="mt-2 text-xs text-status-success">{receiptStatus}</p>}
              {receiptError && <p className="mt-2 text-xs text-status-danger" role="alert">{receiptError}</p>}
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-text-muted">Tổng</span>
              <span className="font-bold tabular-nums text-text-primary">
                {effectiveDetailEnabled
                  ? effectiveDetail.data
                    ? effectiveMoney(effectiveDetail.data.currentOrderGrossValueMinor)
                    : "—"
                  : formatMoney(selected.total)}
              </span>
            </div>
            <div className="rounded-lg border border-border-default bg-surface-panel p-3">
              <div className="mb-2 text-xs font-medium text-text-secondary">Tổng tiền</div>
              {effectiveDetailEnabled && effectiveDetail.isLoading ? (
                <p className="text-xs text-text-muted">Đang tải giá trị đơn hàng hiệu lực…</p>
              ) : effectiveDetailEnabled && (effectiveDetail.error || !effectiveComponents) ? (
                <p className="text-xs text-status-danger" role="alert">
                  Không thể xác nhận giá trị đơn hàng hiệu lực; dữ liệu cũ không được dùng thay thế.
                </p>
              ) : (
              <div className="space-y-1 text-xs">
                <div className="flex justify-between gap-3">
                  <span className="text-text-muted">Tạm tính hàng hóa</span>
                  <span className="tabular-nums text-text-primary">
                    {effectiveComponents
                      ? effectiveMoney(effectiveComponents.merchandiseGrossMinor)
                      : formatMoney(selected.subtotal)}
                  </span>
                </div>
                {Number(effectiveComponents?.discountMinor ?? selected.discount ?? 0) > 0 && (
                  <div className="flex justify-between gap-3">
                    <span className="text-text-muted">Giảm giá</span>
                    <span className="tabular-nums text-status-danger">
                      -{effectiveComponents
                        ? effectiveMoney(effectiveComponents.discountMinor)
                        : formatMoney(selected.discount)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between gap-3">
                  <span className="text-text-muted">Phí vận chuyển</span>
                  <span className="tabular-nums text-text-primary">
                    {effectiveComponents
                      ? effectiveMoney(effectiveComponents.shippingMinor)
                      : formatMoney(selected.shippingFee)}
                  </span>
                </div>
                {effectiveDetail.data?.schemaVersion === 3 && effectiveDetail.data.componentVersion === 2 && (
                  <div className="flex justify-between gap-3">
                    <span className="text-text-muted">Phí thanh toán</span>
                    <span className="tabular-nums text-text-primary">
                      {effectiveMoney(effectiveDetail.data.components.paymentFeeMinor)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between gap-3">
                  <span className="text-text-muted">{effectiveComponents?.taxMode === "exclusive" ? "VAT" : "VAT đã gồm"}</span>
                  <span className="tabular-nums text-text-primary">
                    {effectiveComponents
                      ? effectiveMoney(effectiveComponents.vatMinor)
                      : formatMoney(selected.tax)}
                  </span>
                </div>
                {effectiveComponents && effectiveComponents.unclassifiedMinor > 0 && (
                  <div className="flex justify-between gap-3">
                    <span className="text-text-muted">Khoản tính thêm khác</span>
                    <span className="tabular-nums text-text-primary">
                      {effectiveMoney(effectiveComponents.unclassifiedMinor)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between gap-3 border-t border-border-subtle pt-2 text-sm font-bold">
                  <span className="text-text-primary">
                    {effectiveDetail.data?.commercialState === "cancelled"
                      ? "Snapshot thương mại trước hủy"
                      : "Tổng thanh toán"}
                  </span>
                  <span className="tabular-nums text-text-primary">
                    {effectiveComponents
                      ? effectiveMoney(effectiveComponents.totalMinor)
                      : formatMoney(selected.total)}
                  </span>
                </div>
                {effectiveDetail.data?.commercialState === "cancelled" && (
                  <div className="flex justify-between gap-3 pt-1 text-sm font-bold">
                    <span className="text-text-primary">Giá trị đơn hiện tại</span>
                    <span className="tabular-nums text-text-primary">
                      {effectiveMoney(effectiveDetail.data.currentOrderGrossValueMinor)}
                    </span>
                  </div>
                )}
              </div>
              )}
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-text-muted">Ngày</span>
              <span className="text-right">
                {selected.created_at
                  ? new Date(selected.created_at).toLocaleString("vi-VN")
                  : "-"}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-text-muted">Người lên đơn</span>
              <span className="text-right font-medium text-text-primary">
                {selectedCreatorName}
                {selectedCreator?.role && (
                  <span className="block text-xs font-normal text-text-muted">
                    {selectedCreator.role}
                  </span>
                )}
              </span>
            </div>
            {selected.customer && (
              <div className="flex justify-between gap-3">
                <span className="text-text-muted">Khách hàng</span>
                <span className="text-right font-medium text-text-primary">
                  {selectedCustomerName}
                </span>
              </div>
            )}
            <div className="flex justify-between gap-3">
              <span className="text-text-muted">Kênh bán</span>
              <span className="text-right font-medium text-text-primary">
                {selected.salesChannelLabel || salesChannelLabel(selected.salesChannel)}
              </span>
            </div>

            <div className="rounded-lg border border-border-default bg-surface-panel p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-text-secondary">Thanh toán</span>
                <StatusPill
                  tone={selected.paymentStatus === "posted" ? "success" : "warning"}
                  label={selected.paymentStatus || selected.paymentMethod || "unknown"}
                />
              </div>
              {operationalDetail.isError ? (
                <div role="alert" className="space-y-2">
                  <p className="text-xs text-status-danger-text">Không tải được thông tin thanh toán và vận hành của đơn.</p>
                  <Button variant="secondary" size="sm" onClick={() => void operationalDetail.refetch()}>Thử lại</Button>
                </div>
              ) : !operationalOrder ? (
                <p role="status" className="text-xs text-text-muted">Đang tải lịch sử thanh toán…</p>
              ) : <PaginatedListFrame
                  label="Phân trang lịch sử thanh toán"
                  rowNoun="payment entry"
                  meta={paymentEntriesMeta}
                  onPageChange={setPaymentEntriesPage}
                >
              {selectedPaymentEntries.length > 0 ? (
                <div className="space-y-2">
                  {visiblePaymentEntries.map((payment) => (
                    <div key={payment.id} className="rounded-md border border-border-subtle bg-surface-subtle p-2 text-xs">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-text-primary">{payment.method}</span>
                        <span className="tabular-nums text-text-primary">{formatMoney(payment.amount)}</span>
                      </div>
                      <div className="mt-1 grid grid-cols-1 gap-1 text-text-secondary sm:grid-cols-2">
                        <span>Trạng thái: <b>{payment.effectiveStatus ?? payment.status}</b>
                          {payment.effectiveStatus && payment.effectiveStatus !== payment.status && <small className="ml-2 text-text-muted">(ghi nhận ban đầu: {payment.status})</small>}
                          {payment.effectiveStatus === "partially_collected" && <small className="ml-2">Còn phải thu: {(payment.remainingAmountMinor || 0).toLocaleString("vi-VN") + " ₫"}</small>}
                        </span>
                        <span>Loại: <b>{payment.direction}</b></span>
                        {payment.referenceCode && <span>Mã đối soát: <b>{payment.referenceCode}</b></span>}
                        {payment.paymentProvider && <span>Provider: <b>{payment.paymentProvider}</b></span>}
                        {payment.providerReference && <span>Provider ref: <b>{payment.providerReference}</b></span>}
                        {payment.providerNetwork && <span>Mạng: <b>{payment.providerNetwork}</b></span>}
                        {payment.providerPayCurrency && <span>Đồng nhận: <b>{payment.providerPayCurrency}</b></span>}
                        {payment.providerTransactionHash && <span className="sm:col-span-2">Tx hash: <b className="break-all">{payment.providerTransactionHash}</b></span>}
                        {payment.providerTransactionId && <span>Tx id: <b>{payment.providerTransactionId}</b></span>}
                        {payment.paymentIntentId && <span>Intent: <b>{payment.paymentIntentId.slice(0, 16)}...</b></span>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-text-muted">Chưa có payment entry.</p>
              )}
</PaginatedListFrame>}
            </div>

            <div className="rounded-lg border border-border-default bg-surface-panel">
              <div className="border-b border-border-subtle px-3 py-2 text-xs font-medium text-text-secondary">
                Hàng đã bán
              </div>
<PaginatedListFrame
                  label="Phân trang hàng đã bán"
                  rowNoun="dòng hàng"
                  meta={selectedItemsMeta}
                  onPageChange={setDetailItemsPage}
                >
              <div className="divide-y divide-border-subtle">
                {selectedItems.length > 0 ? visibleSelectedItems.map((item, index) => (
                  <div
                    key={`${item.variantId || item.productId || item.name}-${index}`}
                    className="flex items-start justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="whitespace-normal break-words font-medium leading-5 text-text-primary">{item.name}</p>
                      <p className="mt-0.5 text-xs text-text-muted">
                        SL: {formatQuantity(item.quantity)} x {selectedLineMoney(item.unitPrice)}
                      </p>
                    </div>
                    <span className="shrink-0 tabular-nums font-medium text-text-primary">
                      {selectedLineMoney(item.lineTotal)}
                    </span>
                  </div>
                )) : (
                  <p className="px-3 py-3 text-xs text-text-muted">
                    Chưa có chi tiết hàng bán.
                  </p>
                )}
              </div>
</PaginatedListFrame>
            </div>

            {selectedStockAdjustments.length > 0 && (
              <div className="rounded-lg border border-status-warning-border bg-status-warning-bg p-3">
                <div className="text-xs font-semibold text-text-primary">Điều chỉnh tồn kho khi bán</div>
<PaginatedListFrame
                  label="Phân trang điều chỉnh tồn kho"
                  rowNoun="điều chỉnh"
                  meta={stockAdjustmentsMeta}
                  onPageChange={setStockAdjustmentsPage}
                >
                <div className="mt-2 space-y-2">
                  {visibleStockAdjustments.map((adjustment, index) => (
                    <div
                      key={`${adjustment.variantId || adjustment.sku || index}`}
                      className="rounded-md border border-border-default bg-surface-panel p-2 text-xs"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="whitespace-normal break-words font-medium leading-5 text-text-primary">
                            {adjustment.productName || adjustment.sku || adjustment.variantId || "Sản phẩm"}
                          </p>
                          {adjustment.sku && <p className="text-text-muted">{adjustment.sku}</p>}
                        </div>
                        <StatusPill tone="warning" label={adjustment.reason || "Tìm thấy"} />
                      </div>
                      <div className="mt-2 grid grid-cols-1 gap-1 text-text-secondary sm:grid-cols-2">
                        <span>Tồn hệ thống trước bán: <b>{formatQuantity(adjustment.systemStockBefore)}</b></span>
                        <span>Đã tìm thấy thêm: <b>{formatQuantity(adjustment.adjustedQuantity)}</b></span>
                        <span>Người xác nhận: <b>{adjustment.performedBy || selectedCreatorName}</b></span>
                        <span>Giá trị kiểm kê: <b>{formatMoney(adjustment.inventoryValue)}</b></span>
                      </div>
                    </div>
                  ))}
                </div>
                </PaginatedListFrame>
              </div>
            )}

            <div className="rounded-lg border border-border-default bg-surface-subtle p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-text-secondary">Cập nhật khách hàng</span>
                {updateOrder.isPending && (
                  <span className="text-xs text-text-muted">Đang lưu...</span>
                )}
              </div>
              <CustomerSearch
                onSelect={(customer) => {
                  updateOrder.mutate({ orderId: selected.id, input: { customerId: customer.id } });
                }}
                onClear={() => {
                  updateOrder.mutate({ orderId: selected.id, input: { customerId: null } });
                }}
                selectedPhone={selected.customer?.phone}
              />
              <p className="mt-2 text-xs text-text-muted">
                Hiện tại:{" "}
                <span className="font-medium text-text-primary">
                  {selectedCustomerName}
                </span>
              </p>
              {updateOrder.error && (
                <p className="mt-2 text-xs text-status-danger">
                  {updateOrder.error instanceof Error
                    ? updateOrder.error.message
                    : "Không cập nhật được đơn hàng"}
                </p>
              )}
            </div>

            {selected.sourceFlow === "partner_api_v1" && <PartnerDeliveryContactPanel
              key={selected.id} orderId={selected.id} canRead={canReadPartnerContact}
            />}

            <div className="rounded-lg border border-border-default bg-surface-subtle p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-text-secondary">Phí vận chuyển</span>
              </div>
              <OrderShippingAdjustmentPanel
                key={selected.id}
                orderId={selected.id}
                currentShippingFee={Number(selected.shippingFee || 0)}
                currentTotal={Number(selected.total || 0)}
                paymentMethod={selected.paymentMethod || "cash"}
              />
            </div>

            <div className="rounded-lg border border-border-default bg-surface-subtle p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-text-secondary">Ghi chú và kênh bán</span>
                {updateOrder.isPending && (
                  <span className="text-xs text-text-muted">Đang lưu...</span>
                )}
              </div>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-text-muted">Kênh bán</label>
                  {selected.salesChannelLocked ? (
                    <div className="rounded-md border border-status-info-border bg-status-info-bg px-3 py-2 text-sm text-status-info">
                      <span className="font-semibold">{selected.salesChannelLabel || salesChannelLabel(selected.salesChannel)}</span>
                      <span className="mt-0.5 block text-xs">
                        Kênh bán đã khóa để tracking Stash Dash.
                      </span>
                    </div>
                  ) : (
                    <select
                      value={detailSalesChannel}
                      onChange={(event) => setDetailSalesChannel(event.target.value)}
                      className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
                    >
                      {SALES_CHANNELS.map((channel) => (
                        <option key={channel.value} value={channel.value}>{channel.label}</option>
                      ))}
                    </select>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-xs text-text-muted">Ghi chú</label>
                  <textarea
                    value={detailNotes}
                    onChange={(event) => setDetailNotes(event.target.value)}
                    maxLength={1000}
                    rows={4}
                    className="w-full resize-none rounded-md border border-border-default bg-surface-panel px-3 py-2 text-sm focus:border-action-primary focus:outline-none"
                    placeholder="Ghi chú cho đơn hàng"
                  />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={saveOrderFields}
                  disabled={updateOrder.isPending}
                >
                  Lưu ghi chú
                </Button>
              </div>
            </div>
          </div>
        )}
      </Drawer>
      <OrderCorrectionDrawer
        open={correctionOpen}
        order={selected || null}
        onClose={() => setCorrectionOpen(false)}
      />
      {selected && (
        <>
          <OrderCancelDialog
            open={cancelOpen}
            orderNumber={String(selected.display_id || selected.id || "")}
            orderId={selected.id}
            status={selected.status}
            blockedReason={undefined}
            actor={operator}
            pending={cancelOrderMutation.isPending}
            quote={cancellationQuote.data}
            quotePending={cancellationQuote.isLoading || cancellationQuote.isFetching}
            errorMessage={
              cancelError
              || (cancellationQuote.error instanceof Error ? cancellationQuote.error.message : undefined)
              || (cancelOrderMutation.error instanceof Error ? cancelOrderMutation.error.message : undefined)
            }
            onConfirm={(reason) => {
              if (!operationalOrder?.cancellationAccess?.allowed) {
                setCancelError("Quyền hủy đơn chưa được xác minh trong cửa hàng hiện tại."); return;
              }
              if (!cancellationQuote.data) {
                setCancelError("Báo giá hủy đơn chưa sẵn sàng. Vui lòng thử lại.");
                return;
              }
              cancelOrderMutation.mutate(
                { orderId: selected.id, reason, quote: cancellationQuote.data },
                {
                  onSuccess: () => {
                    setCancelOpen(false);
                    setCancelError("");
                    setSelectedId(null);
                  },
                  onError: (err) => {
                    setCancelError(err instanceof Error ? err.message : "Không thể hủy đơn.");
                  },
                },
              );
            }}
            onCancel={() => {
              setCancelOpen(false);
              setCancelError("");
            }}
          />
          <OrderRefundDialog
            open={refundOpen}
            orderNumber={String(selected.display_id || selected.id || "")}
            orderId={selected.id}
            amountMinor={refundAmountMinor ?? 0}
            currencyCode={selected.currencyCode || "VND"}
            minorUnitExponent={selected.minorUnitExponent || 0}
            pending={refundOrderMutation.isPending}
            errorMessage={
              refundError
              || (refundOrderMutation.error instanceof Error
                ? refundOrderMutation.error.message
                : undefined)
            }
            onConfirm={(input, intentKey) => {
              refundOrderMutation.mutate(
                {
                  orderId: selected.id,
                  input,
                  intentKey,
                },
                {
                  onSuccess: () => {
                    setRefundOpen(false);
                    setRefundError("");
                  },
                  onError: (error) => {
                    setRefundError(error instanceof Error
                      ? error.message
                      : "Không thể ghi nhận hoàn tiền.");
                  },
                },
              );
            }}
            onCancel={() => {
              setRefundOpen(false);
              setRefundError("");
            }}
          />
          <ManualBankConfirmationDialog
            open={manualBankOpen}
            orderNumber={String(selected.display_id || selected.id || "")}
            pending={manualBankMutation.isPending}
            errorMessage={
              manualBankError
              || (manualBankMutation.error instanceof Error
                ? manualBankMutation.error.message
                : undefined)
            }
            onConfirm={(input, intentKey) => {
              manualBankMutation.mutate(
                { orderId: selected.id, input, intentKey },
                {
                  onSuccess: () => {
                    setManualBankOpen(false);
                    setManualBankError("");
                  },
                  onError: (error) => {
                    setManualBankError(error instanceof Error
                      ? error.message
                      : "Không thể ghi nhận chuyển khoản.");
                  },
                },
              );
            }}
            onCancel={() => {
              if (manualBankMutation.isPending) return;
              setManualBankOpen(false);
              setManualBankError("");
            }}
          />
          <OrderRecreateModal
            open={recreateOpen}
            orderId={selected.id}
            orderNumber={String(selected.display_id || selected.id || "")}
            onClose={() => setRecreateOpen(false)}
          />
        </>
      )}
    </div>
  );
}
