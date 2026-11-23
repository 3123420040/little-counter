import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCheckoutPolicy } from "../hooks/useCheckoutPolicy";
import { useOffsetListPagination } from "../hooks/useOffsetListPagination";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  ConfirmDialog,
  InlineError,
  PaginatedListFrame,
  MutationBanner,
  PageHeader,
  Panel,
  SearchBox,
  StatusPill,
} from "@medusa-snus/ui";
import type { PaymentMethod } from "@medusa-snus/contracts";
import { ExternalLink, MessageSquare, Plus, RefreshCw, Search, X } from "lucide-react";
import { CartPanel } from "../components/CartPanel";
import { PaymentIntentDialog } from "../components/PaymentIntentDialog";
import { PaymentModal } from "../components/PaymentModal";
import {
  cancelPaymentIntent,
  checkoutTelegramSalesDraft,
  createPaymentIntent,
  fetchPaymentIntent,
  fetchProducts,
  fetchSyncBootstrap,
  fetchTelegramSalesDrafts,
  mockSettlePaymentIntent,
  rejectTelegramSalesDraft,
  type CompleteSaleInput,
  type PaymentIntentResponse,
  type TelegramSalesDraft,
} from "../api/endpoints";
import type { ProductItem } from "../api/client";
import { useCart, type CartItem } from "../hooks/useCart";
import { type SalesChannelValue } from "../config/salesChannels";
import { NO_DISCOUNT, type CartCommercialAdjustment } from "../utils/cartTotals";
import { checkoutPaymentMethods, isPaymentIntentPaymentMethod, type PaymentIntentPaymentMethod, type PaymentProviderAvailability } from "../utils/paymentMethods";
import { isPaymentIntentCartLocked } from "../utils/paymentIntentState";
import { orderFinancialMutationQueryKeys } from "../utils/scopeQueryInvalidation";

function formatMoney(value: number | string | null | undefined) {
  const amount = Number(value || 0);
  return `${amount.toLocaleString("vi-VN")} ₫`;
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
}

function statusTone(status: string): "success" | "warning" | "danger" | "info" {
  if (status === "converted") return "success";
  if (status === "rejected" || status === "cancelled" || status === "expired") return "danger";
  if (status === "pending" || status === "needs_review") return "warning";
  return "info";
}

function customerLabel(draft: TelegramSalesDraft) {
  return draft.telegramUsername ? `@${draft.telegramUsername}` : draft.telegramUserId;
}

function telegramChatHref(draft: TelegramSalesDraft) {
  const username = String(draft.telegramUsername || "").replace(/^@/, "").trim();
  if (username) return `https://t.me/${encodeURIComponent(username)}`;
  const userId = String(draft.telegramUserId || "").trim();
  return userId ? `tg://user?id=${encodeURIComponent(userId)}` : null;
}

type TelegramSalesLineItem = {
  productId?: string;
  variantId?: string;
  sku?: string;
  title?: string;
  quantity?: number;
  unitPrice?: number;
  lineTotal?: number;
  availability?: string;
  canFulfill?: boolean;
};

function lineItems(draft: TelegramSalesDraft): TelegramSalesLineItem[] {
  const quoted = Array.isArray(draft.quote?.items) ? draft.quote.items : [];
  if (quoted.length > 0) return quoted;
  return draft.items.map((item) => ({
    variantId: item.variantId,
    title: item.variantId,
    quantity: item.quantity,
  }));
}

function cartItemFromLine(item: TelegramSalesLineItem): CartItem | null {
  const variantId = String(item.variantId || "").trim();
  if (!variantId) return null;
  const quantity = Math.max(1, Number(item.quantity || 1));
  const unitPrice = Number(item.unitPrice || (item.lineTotal && quantity ? Number(item.lineTotal) / quantity : 0));
  return {
    variantId,
    productId: String(item.productId || variantId),
    productName: String(item.title || item.sku || variantId),
    sku: String(item.sku || ""),
    quantity,
    unitPrice: Number.isFinite(unitPrice) ? Math.round(unitPrice) : 0,
    stockLevel: item.canFulfill === false || item.availability === "out_of_stock" ? 0 : 999,
  };
}

function cartItemFromProduct(product: ProductItem): CartItem | null {
  const variant = product.variants?.[0];
  if (!variant) return null;
  return {
    variantId: variant.id,
    productId: product.id,
    productName: product.title,
    sku: variant.sku || "",
    quantity: 1,
    unitPrice: Number(variant.prices?.[0]?.amount || 0),
    stockLevel: Number(variant.inventory_quantity || 0),
  };
}

function orderNotes(draft: TelegramSalesDraft, operatorNotes: string) {
  return [
    draft.customerMessage ? `Tin nhan khach: ${draft.customerMessage}` : "",
    draft.delivery?.address ? `Dia chi: ${draft.delivery.address}` : "",
    draft.delivery?.note ? `Ghi chu giao hang: ${draft.delivery.note}` : "",
    operatorNotes.trim() ? `Ghi chu nhan vien: ${operatorNotes.trim()}` : "",
  ].filter(Boolean).join("\n");
}

function useCompactViewport() {
  const [compact, setCompact] = useState(() => (
    typeof window !== "undefined" ? window.matchMedia("(max-width: 767px)").matches : false
  ));

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return compact;
}

export default function TelegramSalesInboxScreen() {
  const qc = useQueryClient();
  const checkoutPolicy = useCheckoutPolicy();
  const compactViewport = useCompactViewport();
  const {
    items,
    selectedIndex,
    subtotal,
    itemCount,
    addItem,
    removeItem,
    updateQty,
    selectItem,
    clearCart,
  } = useCart();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState("pending");
  const [search, setSearch] = useState("");
  const [inboxPage, setInboxPage] = useState(1);
  const [draftsById, setDraftsById] = useState<Record<string, TelegramSalesDraft>>({});
  const [operatorNotes, setOperatorNotes] = useState("");
  const [cartAdjustment, setCartAdjustment] = useState<CartCommercialAdjustment>(NO_DISCOUNT);
  const [selectedCustomer, setSelectedCustomer] = useState<{ id: string; phone: string; name: string } | null>(null);
  const [productSearch, setProductSearch] = useState("");
  const [showPayment, setShowPayment] = useState(false);
  const [saleError, setSaleError] = useState("");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "pending"; message: string } | null>(null);
  const [featureEntitlements, setFeatureEntitlements] = useState<Set<string>>(new Set());
  const [paymentProviders, setPaymentProviders] = useState<PaymentProviderAvailability>({});
  const [paymentIntent, setPaymentIntent] = useState<PaymentIntentResponse["data"] | null>(null);
  const [paymentIntentDraft, setPaymentIntentDraft] = useState<{
    provider: PaymentIntentPaymentMethod;
    order: Omit<CompleteSaleInput, "idempotencyKey">;
  } | null>(null);
  const [paymentIntentBusy, setPaymentIntentBusy] = useState(false);
  const checkoutKeyRef = useRef<string | null>(null);
  const paymentIntentKeyRef = useRef<string | null>(null);
  const completedIntentRef = useRef<string | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["telegramSalesDrafts", status, search, inboxPage],
    queryFn: () => fetchTelegramSalesDrafts({ status, q: search, limit: 20, offset: (inboxPage - 1) * 20 }),
    refetchInterval: status === "pending" ? 5_000 : 15_000,
    refetchOnWindowFocus: true,
  });
  const pendingCountQuery = useQuery({
    queryKey: ["telegramSalesDrafts", "pending-count", search],
    queryFn: () => fetchTelegramSalesDrafts({ status: "pending", q: search, limit: 1 }),
    refetchInterval: status === "pending" ? 5_000 : 15_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    void fetchSyncBootstrap()
      .then((res) => {
        const features = res.data.entitlements?.data?.features || res.data.entitlements?.features || [];
        setFeatureEntitlements(new Set(features));
        setPaymentProviders(res.data.paymentProviders || {});
      })
      .catch(() => undefined);
  }, []);

  const drafts = data?.data || [];
  const { meta: inboxPageMeta, correcting: inboxCorrecting } = useOffsetListPagination(
    error ? undefined : data?.count, inboxPage, 20, setInboxPage,
  );
  const visibleDrafts = drafts;
  const selected = selectedId ? drafts.find((draft) => draft.id === selectedId) || draftsById[selectedId] || null : null;
  const actionable = selected?.status === "pending" || selected?.status === "needs_review";
  const selectedTelegramHref = selected ? telegramChatHref(selected) : null;

  const { data: productResults = [], isFetching: productLoading } = useQuery({
    queryKey: ["telegramSalesProductSearch", productSearch],
    queryFn: () => fetchProducts({ q: productSearch, limit: 2 }),
    enabled: Boolean(actionable),
  });

  const refreshSaleDependentQueries = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["telegramSalesDrafts"] }),
      ...orderFinancialMutationQueryKeys().map((queryKey) =>
        qc.invalidateQueries({ queryKey }),
      ),
      qc.invalidateQueries({ queryKey: ["inventory"] }),
    ]);
  }, [qc]);

  const buildTelegramSalePayload = useCallback((
    paymentMethod: PaymentMethod,
    amountReceived: number,
    adjustment: CartCommercialAdjustment,
    notes: string,
    salesChannel: SalesChannelValue,
    customerMode: "linked" | "walk_in",
    bankTransferSettlementAcknowledgment?: CompleteSaleInput["bankTransferSettlementAcknowledgment"],
  ): Omit<CompleteSaleInput, "idempotencyKey"> => {
    if (!selected) throw new Error("Chưa chọn Telegram request.");
    return {
      items: items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
      customerId: selectedCustomer?.id,
      paymentMethod,
      amountReceived,
      customerMode,
      ...(bankTransferSettlementAcknowledgment ? { bankTransferSettlementAcknowledgment } : {}),
      discountType: adjustment.discountType,
      discountValue: adjustment.discountValue,
      shippingFee: adjustment.shippingFee,
      notes: notes || orderNotes(selected, operatorNotes),
      salesChannel,
      sourceFlow: "telegram_sales",
      salesChannelLocked: true,
      customerNickname: selected.telegramUsername ? `@${selected.telegramUsername}` : selected.telegramUserId,
      customerContactType: "telegram",
      telegramSalesDraftId: selected.id,
      telegramSalesOperatorNotes: operatorNotes,
    };
  }, [items, operatorNotes, selected, selectedCustomer?.id]);

  useEffect(() => {
    if (isLoading || isFetching || selectedId || drafts.length === 0) return;
    setSelectedId(drafts[0].id);
  }, [drafts, isFetching, isLoading, selectedId]);

  useEffect(() => {
    if (!drafts.length) return;
    setDraftsById((current) => ({
      ...current,
      ...Object.fromEntries(drafts.map((draft) => [draft.id, draft])),
    }));
  }, [drafts]);

  useEffect(() => {
    setInboxPage(1);
    setSelectedId(null);
  }, [search, status]);

  useEffect(() => {
    clearCart();
    setOperatorNotes(selected?.operatorNotes || "");
    setRejectReason("");
    setRejectOpen(false);
    setShowPayment(false);
    setSaleError("");
    setSelectedCustomer(null);
    checkoutKeyRef.current = null;
    paymentIntentKeyRef.current = null;
    completedIntentRef.current = null;
    setPaymentIntent(null);
    setPaymentIntentDraft(null);
    setPaymentIntentBusy(false);
    const shippingFee = Number(selected?.quote?.shippingFee || 0);
    setCartAdjustment({ ...NO_DISCOUNT, shippingFee });
    if (!selected) return;
    lineItems(selected).forEach((line) => {
      const item = cartItemFromLine(line);
      if (item) addItem(item);
    });
  }, [addItem, clearCart, selected?.id, selected?.operatorNotes, selected?.quote?.shippingFee]);

  const checkoutMutation = useMutation({
    mutationFn: async ({
      paymentMethod,
      amountReceived,
      adjustment,
      notes,
      salesChannel,
      customerMode,
      bankTransferSettlementAcknowledgment,
    }: {
      paymentMethod: PaymentMethod;
      amountReceived: number;
      adjustment: CartCommercialAdjustment;
      notes: string;
      salesChannel: SalesChannelValue;
      customerMode: "linked" | "walk_in";
      bankTransferSettlementAcknowledgment?: CompleteSaleInput["bankTransferSettlementAcknowledgment"];
    }) => {
      if (!selected) throw new Error("Chưa chọn Telegram request.");
      if (!checkoutKeyRef.current) {
        checkoutKeyRef.current = `telegram-sales-checkout-${selected.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }
      const payload = buildTelegramSalePayload(paymentMethod, amountReceived, adjustment, notes, salesChannel, customerMode, bankTransferSettlementAcknowledgment);
      return checkoutTelegramSalesDraft(selected.id, {
        ...payload,
        operatorNotes,
        idempotencyKey: checkoutKeyRef.current,
      });
    },
    onMutate: () => {
      setSaleError("");
      setNotice({ tone: "pending", message: "Đang thanh toán và chuyển request thành đơn hàng..." });
    },
    onSuccess: (result) => {
      void refreshSaleDependentQueries();
      setShowPayment(false);
      setSelectedId(null);
      checkoutKeyRef.current = null;
      const order = result.data.order;
      setNotice({
        tone: "success",
        message: order ? `Đã tạo đơn ${String(order.orderNumber || order.display_id || order.id || "")}.` : "Request đã được xử lý.",
      });
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Không thể thanh toán request Telegram.";
      setSaleError(message);
      setNotice({ tone: "error", message });
    },
  });

  useEffect(() => {
    if (!paymentIntent || !isPaymentIntentCartLocked(paymentIntent.status)) return undefined;
    const interval = window.setInterval(() => {
      void fetchPaymentIntent(paymentIntent.id)
        .then(async (result) => {
          setPaymentIntent(result.data);
          if (
            result.data.status === "completed"
            && result.data.completedOrderId
            && completedIntentRef.current !== result.data.id
          ) {
            completedIntentRef.current = result.data.id;
            await refreshSaleDependentQueries();
            setShowPayment(false);
            clearCart();
            setSelectedCustomer(null);
            setSelectedId(null);
            setNotice({ tone: "success", message: `Đã tạo đơn ${result.data.completedOrderId}.` });
          }
        })
        .catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(interval);
  }, [clearCart, paymentIntent, refreshSaleDependentQueries]);

  const handleCompleteTelegramSale = useCallback(async (
    paymentMethod: PaymentMethod,
    amountReceived: number,
    adjustment: CartCommercialAdjustment,
    notes: string,
    salesChannel: SalesChannelValue,
    customerMode: "linked" | "walk_in",
    bankTransferSettlementAcknowledgment?: CompleteSaleInput["bankTransferSettlementAcknowledgment"],
  ) => {
    if (!selected) throw new Error("Chưa chọn Telegram request.");
    const order = buildTelegramSalePayload(paymentMethod, amountReceived, adjustment, notes, salesChannel, customerMode, bankTransferSettlementAcknowledgment);
    if (isPaymentIntentPaymentMethod(paymentMethod)) {
      setSaleError("");
      setNotice({ tone: "pending", message: "Đang tạo mã thanh toán và khóa request Telegram..." });
      if (!paymentIntentKeyRef.current) {
        paymentIntentKeyRef.current = `telegram-sales-payment-intent-${selected.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }
      try {
        const intent = await createPaymentIntent({
          provider: paymentMethod,
          order,
          idempotencyKey: paymentIntentKeyRef.current,
        });
        setPaymentIntentDraft({ provider: paymentMethod, order });
        setPaymentIntent(intent.data);
        setShowPayment(false);
        completedIntentRef.current = null;
        setNotice({ tone: "pending", message: "Đã tạo mã thanh toán. Chờ provider xác nhận tiền vào." });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Không tạo được mã thanh toán.";
        setSaleError(message);
        setNotice({ tone: "error", message });
      }
      return;
    }
    await checkoutMutation.mutateAsync({
      paymentMethod,
      amountReceived,
      adjustment,
      notes,
      salesChannel,
      customerMode,
      bankTransferSettlementAcknowledgment,
    });
  }, [buildTelegramSalePayload, checkoutMutation, selected]);

  const handleMockSettleIntent = useCallback(async () => {
    if (!paymentIntent) return;
    setPaymentIntentBusy(true);
    setSaleError("");
    setNotice({ tone: "pending", message: "Đang settle payment intent local..." });
    try {
      const result = await mockSettlePaymentIntent(paymentIntent.id);
      setPaymentIntent(result.data);
      if (result.order) {
        await refreshSaleDependentQueries();
        setShowPayment(false);
        clearCart();
        setSelectedCustomer(null);
        setSelectedId(null);
        setNotice({ tone: "success", message: `Đã tạo đơn ${String(result.order.orderNumber || result.order.display_id || result.order.id || "")}.` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Lỗi xác nhận thanh toán";
      setSaleError(message);
      setNotice({ tone: "error", message });
    } finally {
      setPaymentIntentBusy(false);
    }
  }, [clearCart, paymentIntent, refreshSaleDependentQueries]);

  const handleCancelPaymentIntent = useCallback(async () => {
    if (!paymentIntent || paymentIntent.status !== "pending") return;
    setPaymentIntentBusy(true);
    setSaleError("");
    setNotice({ tone: "pending", message: "Đang hủy mã thanh toán..." });
    try {
      const result = await cancelPaymentIntent(paymentIntent.id);
      setPaymentIntent(result.data);
      paymentIntentKeyRef.current = null;
      setNotice({ tone: "success", message: "Đã hủy mã thanh toán. Có thể đổi phương thức hoặc tạo mã mới." });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Lỗi hủy payment intent";
      setSaleError(message);
      setNotice({ tone: "error", message });
    } finally {
      setPaymentIntentBusy(false);
    }
  }, [paymentIntent]);

  const handleRenewPaymentIntent = useCallback(async () => {
    if (!paymentIntentDraft) return;
    setPaymentIntentBusy(true);
    setSaleError("");
    setNotice({ tone: "pending", message: "Đang tạo mã thanh toán mới..." });
    try {
      const intent = await createPaymentIntent({
        provider: paymentIntentDraft.provider,
        order: paymentIntentDraft.order,
        idempotencyKey: `telegram-sales-payment-intent-renew-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      completedIntentRef.current = null;
      setPaymentIntent(intent.data);
      setNotice({ tone: "pending", message: "Đã tạo mã thanh toán mới." });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Lỗi tạo mã thanh toán mới";
      setSaleError(message);
      setNotice({ tone: "error", message });
    } finally {
      setPaymentIntentBusy(false);
    }
  }, [paymentIntentDraft]);

  const handleChangePaymentMethodFromIntent = useCallback(() => {
    if (isPaymentIntentCartLocked(paymentIntent?.status)) return;
    setPaymentIntent(null);
    paymentIntentKeyRef.current = null;
    setShowPayment(true);
  }, [paymentIntent]);

  const handleClosePaymentIntent = useCallback(() => {
    if (isPaymentIntentCartLocked(paymentIntent?.status)) return;
    setPaymentIntent(null);
  }, [paymentIntent]);

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => rejectTelegramSalesDraft(id, reason),
    onMutate: () => setNotice({ tone: "pending", message: "Đang từ chối request..." }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["telegramSalesDrafts"] });
      setSelectedId(null);
      setRejectOpen(false);
      setRejectReason("");
      setNotice({ tone: "success", message: "Đã từ chối request." });
    },
    onError: (err) => {
      setNotice({ tone: "error", message: err instanceof Error ? err.message : "Không thể từ chối request." });
    },
  });

  const totals = useMemo(() => ({
    requests: data?.count || drafts.length,
    pending: pendingCountQuery.data?.count || 0,
  }), [data?.count, drafts.length, pendingCountQuery.data?.count]);
  const paymentIntentLocksCart = isPaymentIntentCartLocked(paymentIntent?.status);
  const canRenewPaymentIntent = Boolean(
    paymentIntentDraft
    && paymentIntent
    && ["expired", "cancelled", "manual_review", "failed"].includes(paymentIntent.status),
  );

  function addProductToCart(product: ProductItem) {
    if (!actionable || paymentIntentLocksCart) return;
    const item = cartItemFromProduct(product);
    if (!item) return;
    addItem(item);
  }

  const requestSummary = selected ? (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-text-primary">{customerLabel(selected)}</p>
            <StatusPill tone={statusTone(selected.status)} label={selected.status} />
          </div>
          <p className="mt-1 text-[11px] text-text-muted">
            ID {selected.telegramUserId} · {formatDate(selected.createdAt)}
          </p>
        </div>
        {selectedTelegramHref && (
          <a
            href={selectedTelegramHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 shrink-0 items-center rounded-md border border-border-default px-2 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            <MessageSquare size={13} className="mr-1" />
            Chat
            <ExternalLink size={12} className="ml-1" />
          </a>
        )}
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <div className="rounded-md border border-border-default bg-surface-subtle px-3 py-2">
          <p className="text-[11px] font-medium text-text-muted">Tin nhắn</p>
          <p className="mt-1 max-h-16 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-text-primary">
            {selected.customerMessage || "-"}
          </p>
        </div>
        <div className="rounded-md border border-border-default bg-surface-subtle px-3 py-2">
          <p className="text-[11px] font-medium text-text-muted">Giao hàng</p>
          <p className="mt-1 break-words text-xs font-medium leading-5 text-text-primary">
            {selected.delivery?.address || "Chưa có địa chỉ"}
          </p>
          {selected.delivery?.note && (
            <p className="mt-0.5 max-h-10 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-4 text-text-muted">
              {selected.delivery.note}
            </p>
          )}
        </div>
      </div>

      <label className="block">
        <span className="text-[11px] font-medium text-text-muted">Ghi chú nhân viên</span>
        <textarea
          value={operatorNotes}
          onChange={(event) => setOperatorNotes(event.target.value)}
          className="mt-1.5 h-16 w-full rounded-md border border-border-default bg-surface-panel p-2.5 text-xs focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
          placeholder="Ghi chú nội bộ..."
          disabled={!actionable}
        />
      </label>

      {selected.convertedOrderId && (
        <div className="rounded-md bg-status-success-bg px-3 py-2 text-xs text-status-success">
          Đã tạo order: {selected.convertedOrderId}
        </div>
      )}
    </div>
  ) : null;

  if (error) {
    return (
      <div className="p-4">
        <InlineError message="Không thể tải Telegram sales inbox" onRetry={() => refetch()} stale />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3 md:gap-4 md:p-4 xl:flex-row">
      <div className="w-full shrink-0 space-y-3 xl:w-[360px]">
        <PageHeader title="Telegram Sales" subtitle="Request từ bot được mở như giỏ hàng để nhân viên tiếp tục thanh toán." />
        {notice && (
          <MutationBanner
            tone={notice.tone}
            message={notice.message}
            actionLabel={notice.tone === "error" ? "Đóng" : undefined}
            onAction={() => setNotice(null)}
          />
        )}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border border-border-default bg-surface-panel p-3">
            <p className="text-xs text-text-muted">Tổng request</p>
            <p className="mt-1 text-xl font-semibold text-text-primary">{totals.requests}</p>
          </div>
          <div className="rounded-md border border-border-default bg-surface-panel p-3">
            <p className="text-xs text-text-muted">Cần xử lý</p>
            <p className="mt-1 text-xl font-semibold text-text-primary">{totals.pending}</p>
          </div>
        </div>
        <Panel title="Inbox">
          <div className="space-y-3 p-3">
            <div className="flex gap-2">
              <SearchBox value={search} onChange={setSearch} placeholder="Tìm user, ghi chú..." />
              <Button variant="secondary" size="sm" onClick={() => refetch()} aria-label="Tải lại">
                <RefreshCw size={14} />
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {[
                ["pending", "Chờ xử lý"],
                ["converted", "Đã lên đơn"],
                ["rejected", "Từ chối"],
                ["all", "Tất cả"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setStatus(value)}
                  className={[
                    "rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
                    status === value
                      ? "border-action-primary bg-surface-selected text-action-primary"
                      : "border-border-default text-text-secondary hover:bg-surface-hover",
                  ].join(" ")}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <PaginatedListFrame
            label="Phân trang Telegram inbox"
            rowNoun="request"
            meta={inboxPageMeta}
            onPageChange={setInboxPage}
            busy={isFetching}
            loading={inboxCorrecting}
            loadingContent={<div className="p-3 text-sm text-text-muted">Đang tải trang phù hợp...</div>}
            showPagination={Boolean(data && !isLoading && !error && !inboxCorrecting)}
          >
            {isLoading ? (
              <div className="space-y-2 p-3">
                {Array.from({ length: 5 }).map((_, index) => (
                  <div key={index} className="h-20 rounded-md bg-surface-subtle animate-pulse" />
                ))}
              </div>
            ) : drafts.length === 0 ? (
              <div className="p-8 text-center text-sm text-text-muted">
                <MessageSquare size={28} className="mx-auto mb-2" />
                Không có request phù hợp.
              </div>
            ) : (
              <div className="space-y-1 p-2">
                {visibleDrafts.map((draft) => (
                  <button
                    key={draft.id}
                    type="button"
                    onClick={() => setSelectedId(draft.id)}
                    className={[
                      "w-full rounded-md border px-3 py-2 text-left transition-colors",
                      selected?.id === draft.id
                        ? "border-action-primary bg-surface-selected"
                        : "border-border-default hover:bg-surface-hover",
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-text-primary">
                        {customerLabel(draft)}
                      </p>
                      <StatusPill tone={statusTone(draft.status)} label={draft.status} />
                    </div>
                    <p className="mt-1 truncate text-xs text-text-secondary">
                      {draft.customerMessage ||
                        lineItems(draft)
                          .map((item) => item.title || item.variantId)
                          .join(", ")}
                    </p>
                    <div className="mt-2 flex items-center justify-between text-xs text-text-muted">
                      <span>{formatDate(draft.createdAt)}</span>
                      <span>{formatMoney(draft.quote?.total)}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </PaginatedListFrame>
          {isFetching && !isLoading && <div className="border-t border-border-default px-3 py-2 text-xs text-text-muted">Đang làm mới...</div>}
        </Panel>
      </div>

      <div className="min-w-0 flex-1">
        {selected ? (
          <div className="mx-auto w-full max-w-5xl space-y-3 md:space-y-4">
            <Panel title="Chi tiết request">
              <div className="p-3 md:p-4">{requestSummary}</div>
            </Panel>
            <Panel title="Giỏ hàng từ Telegram">
              <div className="min-h-0 overflow-hidden">
                <CartPanel
                  key={selected.id}
                  paginateItems
                  items={items}
                  selectedIndex={selectedIndex}
                  subtotal={subtotal}
                  itemCount={itemCount}
                  adjustment={cartAdjustment}
                  onAdjustmentChange={actionable && !paymentIntentLocksCart ? setCartAdjustment : () => undefined}
                  onUpdateQty={actionable && !paymentIntentLocksCart ? updateQty : () => undefined}
                  onRemove={actionable && !paymentIntentLocksCart ? removeItem : () => undefined}
                  onSelectItem={selectItem}
                  onClear={actionable && !paymentIntentLocksCart ? clearCart : () => undefined}
                  onCheckout={() => actionable && !paymentIntentLocksCart && items.length > 0 && setShowPayment(true)}
                  customerName={customerLabel(selected)}
                  saleError={saleError}
                  onDismissError={() => setSaleError("")}
                  mobileOptimized={compactViewport}
                  readOnly={!actionable || paymentIntentLocksCart}
                  beforeFooter={!actionable || paymentIntentLocksCart ? (
                    <div className="p-3 text-xs text-text-secondary">
                      <div className="rounded-md bg-surface-subtle p-2">
                        {!actionable
                          ? "Request này đã được xử lý nên giỏ hàng chỉ dùng để xem lại."
                          : "Đã tạo mã thanh toán. Hủy mã hiện tại nếu cần đổi sản phẩm, giảm giá hoặc phí giao hàng."}
                      </div>
                    </div>
                  ) : undefined}
                />
              </div>
              <div className="border-t border-border-default p-3">
                <Button
                  variant="secondary"
                  disabled={!actionable || paymentIntentLocksCart || checkoutMutation.isPending || rejectMutation.isPending}
                  onClick={() => setRejectOpen(true)}
                >
                  <X size={14} className="mr-1" /> Từ chối
                </Button>
              </div>
            </Panel>

            <Panel title="Thêm sản phẩm">
              <div className="space-y-2.5 p-3">
                <div className="flex items-center gap-2 rounded-md border border-border-default px-3">
                  <Search size={15} className="text-text-muted" />
                  <input
                    value={productSearch}
                    onChange={(event) => setProductSearch(event.target.value)}
                    disabled={!actionable || paymentIntentLocksCart}
                    className="h-10 min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
                    placeholder="Tìm sản phẩm để thêm..."
                  />
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {productResults.slice(0, 2).map((product) => {
                    const variant = product.variants?.[0];
                    if (!variant) return null;
                    return (
                      <button
                        key={variant.id}
                        type="button"
                        disabled={!actionable || paymentIntentLocksCart}
                        onClick={() => addProductToCart(product)}
                        className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border-default px-3 py-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-text-primary">{product.title}</span>
                          <span className="mt-0.5 block truncate text-xs text-text-muted">
                            {variant.sku || "No SKU"} · {formatMoney(variant.prices?.[0]?.amount || 0)}
                          </span>
                        </span>
                        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border-default text-action-primary">
                          <Plus size={15} />
                        </span>
                      </button>
                    );
                  })}
                </div>
                {productLoading && <p className="text-xs text-text-muted">Đang tải sản phẩm...</p>}
                {!productLoading && productResults.length === 0 && (
                  <p className="text-xs text-text-muted">Không có sản phẩm phù hợp.</p>
                )}
              </div>
            </Panel>
          </div>
        ) : (
          <div className="flex h-full min-h-[420px] flex-col items-center justify-center text-text-muted">
            <MessageSquare size={36} className="mb-3" />
            <p className="text-sm font-medium">Chọn một Telegram request để xử lý.</p>
          </div>
        )}
      </div>

      {showPayment && selected && (
        <PaymentModal
          subtotal={subtotal}
          adjustment={cartAdjustment}
          selectedCustomer={selectedCustomer}
          enabledPaymentMethods={checkoutPaymentMethods(paymentProviders, featureEntitlements)}
          onCustomerSelect={setSelectedCustomer}
          onCustomerClear={() => setSelectedCustomer(null)}
          onComplete={handleCompleteTelegramSale}
          isSubmitting={checkoutMutation.isPending}
          onClose={() => setShowPayment(false)}
          completeLabel="Thanh toán"
          bankSettlementPolicy={checkoutPolicy}
          onPolicyRefresh={checkoutPolicy.refreshPolicy}
          forcedSalesChannel="telegram"
          salesChannelLocked
          salesChannelLockReason="Request bắt đầu từ Telegram bot, giữ kênh Telegram cho báo cáo và chăm sóc khách."
        />
      )}

      {paymentIntent && (
        <PaymentIntentDialog
          intent={paymentIntent}
          busy={checkoutMutation.isPending || paymentIntentBusy}
          canRenew={canRenewPaymentIntent}
          onClose={handleClosePaymentIntent}
          onChangePaymentMethod={handleChangePaymentMethodFromIntent}
          onRenew={handleRenewPaymentIntent}
          onCancel={handleCancelPaymentIntent}
          onMockSettle={handleMockSettleIntent}
        />
      )}

      <ConfirmDialog
        open={rejectOpen && !!selected}
        title="Từ chối Telegram request?"
        confirmLabel="Từ chối"
        danger
        pending={rejectMutation.isPending}
        onCancel={() => { setRejectOpen(false); setRejectReason(""); }}
        onConfirm={() => {
          if (!selected) return;
          rejectMutation.mutate({ id: selected.id, reason: rejectReason || "Không thể xử lý request" });
        }}
      >
        <textarea
          value={rejectReason}
          onChange={(event) => setRejectReason(event.target.value)}
          className="h-20 w-full rounded-md border border-border-default bg-surface-panel p-3 text-sm focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
          placeholder="Lý do từ chối..."
          autoFocus
        />
      </ConfirmDialog>
    </div>
  );
}
