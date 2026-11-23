import { reviewedOfflineShiftPayload } from "../utils/offlineCheckoutReview";
import { useState, useCallback, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useClientOperatingScope, useProducts } from "../hooks/useProducts";
import { useProductCategories } from "../hooks/useProductCategories";
import { useCart } from "../hooks/useCart";
import { ProductCard } from "../components/ProductCard";
import { CartPanel } from "../components/CartPanel";
import { CustomerSearch } from "../components/CustomerSearch";
import { PaymentIntentDialog } from "../components/PaymentIntentDialog";
import { PaymentIntentCreationRecoveryPanel } from "../components/PaymentIntentCreationRecoveryPanel";
import { OfflineSalesReview } from "../components/OfflineSalesReview";
import { PaymentModal } from "../components/PaymentModal";
import { ReceiptModal } from "../components/ReceiptModal";
import { QuantityKeypad } from "../components/QuantityKeypad";
import { StaffScanDialog } from "../components/StaffScanDialog";
import { VisionScanDrawer, type VisionManualFallbackContext } from "../components/VisionScanDrawer";
import { StockShortageWarningModal, type StockShortageItem } from "../components/StockShortageWarningModal";
import { Button, Drawer, ScreenState, InlineError, PaginatedListFrame, loadedListPaginationMeta } from "@medusa-snus/ui";
import { Search, Loader2, Gift, Star, WifiOff, ShoppingCart, Plus, QrCode, Camera, Clock3 } from "lucide-react";
import { CartPaymentFeePreviewInputV1Schema, paymentIntentCreationKeyPrefixV1, permissions,
  type PaymentMethod, type OrderPaymentFeeFinancialSnapshotV1, type PaymentIntentFinancialViewV1 } from "@medusa-snus/contracts";
import type { SalesChannelValue } from "../config/salesChannels";
import {
  cancelPaymentIntent,
  completeSale,
  createPaymentIntent,
  createPaymentIntentFinancialV1,
  fetchPaymentIntentFinancialV1,
  resolvePaymentIntentFinancialV1,
  fetchAiRecommendations,
  fetchCrossSellRecommendations,
  fetchCurrentShift,
  fetchPaymentIntent,
  fetchSyncBootstrap,
  mockSettlePaymentIntent,
  recordCrossSellAcceptance,
  recordVisionScanCorrection,
  redeemScanGoCart,
  resolveProductScan,
  resolveScanGoCart,
  type CompleteSaleInput,
  type CrossSellRecommendation,
  type PaymentIntentResponse,
  type ProductScanResolution,
  type StaffScanGoCart,
  type VisionCartContext,
  type VisionCandidateView,
} from "../api/endpoints";
import { ApiError, getClientScopeSnapshot } from "../api/client";
import { TierUpgradeNotification } from "../components/TierUpgradeNotification";
import {
  enqueueSale, listQueuedSales, queuedSaleSummary,
  removeQueuedSale, saveBootstrapSnapshot, updateQueuedSale,
  type ScopeSnapshot, type QueuedSale,
} from "../utils/offlineQueue";
import { NO_DISCOUNT, cartTotalsForDisplay, type CartCommercialAdjustment, type CartPaymentFeePreviewState } from "../utils/cartTotals";
import { useCartPaymentFeePreview } from "../hooks/useCartPaymentFeePreview";
import { checkoutPaymentMethods, isPaymentIntentPaymentMethod, type PaymentProviderAvailability } from "../utils/paymentMethods";
import { isPaymentIntentCartLocked } from "../utils/paymentIntentState";
import { isScanGoCartPayload } from "../utils/scanPayload";
import { useI18n } from "../i18n";
import { orderFinancialMutationQueryKeys } from "../utils/scopeQueryInvalidation";
import { useAuth } from "../hooks/useAuth";
import { useAppAccessSnapshot } from "../hooks/useAppAccessSnapshot";
import { useCheckoutPolicy } from "../hooks/useCheckoutPolicy";
import { reconcileAccessibleScope } from "../utils/offlineBootstrapScope";
import { replayQueuedSale } from "../utils/offlineSaleReplay";
import { preservePaymentIntentCreation, listPendingPaymentIntentCreations, removePendingPaymentIntentCreation,
  type PendingPaymentIntentCreation } from "../utils/paymentIntentCreationRecovery";

// ── Types ──
interface ReceiptOrder {
  orderId?: string; orderNumber: string; total: number;
  subtotal: number; tax: number; discount: number; shippingFee: number; change: number;
  paymentMethod: string;
  items: Array<{ name: string; quantity: number; unitPrice: number; lineTotal: number }>;
  createdAt: string;
  financial?: OrderPaymentFeeFinancialSnapshotV1;
}

function normalizeStockShortages(details: unknown): StockShortageItem[] | null {
  const shortages = (details as { shortages?: unknown[] } | undefined)?.shortages;
  if (!Array.isArray(shortages) || shortages.length === 0) return null;
  return shortages.map((item) => {
    const row = item as Record<string, unknown>;
    return {
      variantId: String(row.variantId || ""),
      productId: row.productId ? String(row.productId) : undefined,
      productName: String(row.productName || "Sản phẩm"),
      sku: row.sku ? String(row.sku) : undefined,
      systemStock: Number(row.systemStock || 0),
      requestedQuantity: Number(row.requestedQuantity || 0),
      shortageQuantity: Number(row.shortageQuantity || 0),
      unitCost: row.unitCost === undefined ? undefined : Number(row.unitCost || 0),
    };
  }).filter((item) => item.variantId && item.shortageQuantity > 0);
}

type CheckoutAttempt = {
  saleIdempotencyKey: string;
  paymentIntentIdempotencyKey: string;
  confirmed?: { signature: string; payload: CompleteSaleInput };
};

function checkoutAttemptKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newCheckoutAttempt(intentOwner?: { operatorId: string; storeId: string }): CheckoutAttempt {
  return {
    saleIdempotencyKey: checkoutAttemptKey("sale"),
    paymentIntentIdempotencyKey: intentOwner
      ? paymentIntentCreationKeyPrefixV1(intentOwner.operatorId, intentOwner.storeId) + crypto.randomUUID()
      : checkoutAttemptKey("payment-intent"),
  };
}

function persuasionSignals(reason: string) {
  const parts = reason
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  const purchaseHistory = parts.find((part) => /^khách từng mua\s+\d+\s+lần$/i.test(part));
  const promotion = parts.find((part) => /^đang ưu tiên khuyến mãi\s+\d+$/i.test(part));

  // Only show information a cashier can use in a customer conversation.
  // Margin, lack of history and internal recommendation diagnostics stay out of the selling surface.
  return [
    purchaseHistory ? purchaseHistory.replace(/^khách/i, "Khách") : null,
    promotion ? "Đang có ưu đãi" : null,
  ].filter((signal): signal is string => Boolean(signal));
}

function CrossSellPanel({
  items,
  onAccept,
  compact = false,
}: {
  items: CrossSellRecommendation[];
  onAccept: (item: CrossSellRecommendation) => void;
  compact?: boolean;
}) {
  if (items.length === 0) return null;
  if (compact) {
    return (
      <details className="px-3 py-2" aria-label="Đề xuất bán kèm">
        <summary className="mb-1.5 flex cursor-pointer list-none items-center gap-2 text-[11px] font-semibold text-text-secondary">
          <Gift size={13} aria-hidden="true" />
          Gợi ý bán kèm
        </summary>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {items.slice(0, 2).map((item) => {
            const lowStock = item.stock <= 5;
            return (
              <div
                key={item.variantId}
                data-testid={`cross-sell-card-${item.variantId}`}
                className="flex min-w-[190px] max-w-[220px] items-center gap-2 rounded-md border border-border-default bg-surface-panel px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-semibold text-text-primary">{item.name}</p>
                  <p className="mt-0.5 text-[11px] tabular-nums text-text-muted">
                    {item.price.toLocaleString("vi-VN")} ₫
                    {lowStock ? ` · Còn ${item.stock}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onAccept(item)}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border-default text-action-primary hover:bg-action-primary/10"
                  aria-label={`Thêm ${item.name}`}
                >
                  <Plus size={15} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      </details>
    );
  }
  return (
    <details className="border-t border-border-default p-3" aria-label="Đề xuất bán kèm">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold text-text-secondary">
        <Gift size={14} aria-hidden="true" />
        Gợi ý bán kèm
      </summary>
      <div className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1">
        {items.slice(0, 2).map((item) => {
          const signals = persuasionSignals(item.reason);
          const lowStock = item.stock <= 5;
          return (
            <div key={item.variantId} data-testid={`cross-sell-card-${item.variantId}`} className="rounded-md border border-border-default bg-surface-panel px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="whitespace-normal break-words text-xs font-semibold leading-4 text-text-primary">{item.name}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="font-medium tabular-nums text-text-primary">{item.price.toLocaleString("vi-VN")} ₫</span>
                    {lowStock && <span className="text-status-warning">Còn {item.stock}</span>}
                  </div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => onAccept(item)}>
                  <Plus size={14} className="mr-1" />
                  Thêm
                </Button>
              </div>
              {signals.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {signals.map((signal) => (
                    <span key={signal} className="rounded border border-status-info-border bg-status-info-bg px-1.5 py-0.5 text-[10px] text-status-info">
                      {signal}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

// ── Product Grid Skeleton ──
function ProductGridSkeleton() {
  return (
    <div
      className="grid gap-2 p-3 sm:gap-3 sm:p-4"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, var(--pos-product-card-size)), 1fr))" }}
      aria-busy="true"
    >
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="h-[120px] rounded-lg bg-surface-subtle animate-pulse"
          style={{ animationDelay: `${i * 80}ms` }}
        />
      ))}
    </div>
  );
}

// ── Main ──
export default function PosScreen() {
  const { t } = useI18n();
  const { operator } = useAuth();
  const { snapshot: appAccess, operatingSnapshot, runtime } = useAppAccessSnapshot();
  const checkoutPolicy = useCheckoutPolicy();
  const selectedScope = useClientOperatingScope();
  const { operatingMerchantId, operatingStoreId } = selectedScope;
  const queryClient = useQueryClient();
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [scanSearch, setScanSearch] = useState("");
  const [categoryId, setCategoryId] = useState("all");
  const [productPage, setProductPage] = useState(1);
  const [searchFlash, setSearchFlash] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine) and (min-width: 768px)").matches) {
      searchRef.current?.focus();
    }
  }, []);

  const { data: products, isLoading, error, refetch } = useProducts(
    search || categoryId !== "all"
      ? {
          q: search || undefined,
          categoryId: categoryId !== "all" ? categoryId : undefined,
        }
      : undefined,
  );
  const { data: categoriesData } = useProductCategories({ status: "active", includeProductCounts: true });
  const categories = categoriesData?.product_categories || [];
  const productPageMeta = loadedListPaginationMeta((products || []).length, productPage, 20);
  const visibleProducts = (products || []).slice(
    (productPageMeta.page - 1) * 20,
    productPageMeta.page * 20,
  );

  useEffect(() => setProductPage(1), [search, categoryId]);
  const {
    items, selectedIndex, subtotal, itemCount,
    addItem, removeItem, updateQty, selectItem, clearCart,
  } = useCart();

  const location = useLocation();
  const prefillAppliedRef = useRef(false);
  const [recreateSource, setRecreateSource] = useState<{ orderId: string; orderNumber: string } | null>(() => {
    const prefill = location.state?.prefillCart;
    if (!prefill?.sourceOrderId || !prefill?.sourceOrderNumber) return null;
    return {
      orderId: String(prefill.sourceOrderId),
      orderNumber: String(prefill.sourceOrderNumber),
    };
  });

  // Handle recreate-from-order cart prefill. A one-shot navigation from
  // OrderHistory sets location.state.prefillCart. We populate the cart
  // exactly once and then clear the state so a manual refresh does not
  // double-load items.
  useEffect(() => {
    const prefill = location.state?.prefillCart as Record<string, unknown> | undefined;
    if (!prefill || prefillAppliedRef.current) return;
    prefillAppliedRef.current = true;
    const sourceScope = prefill.sourceScope;
    if (sourceScope !== undefined && (!sourceScope || typeof sourceScope !== "object"
      || !("merchantId" in sourceScope) || sourceScope.merchantId !== operatingMerchantId
      || !("storeId" in sourceScope) || sourceScope.storeId !== operatingStoreId)) {
      setRecreateSource(null);
      setSaleError("Đã đổi cửa hàng. Hãy mở lại đơn gốc để tạo giỏ hàng mới.");
      window.history.replaceState({}, "");
      return;
    }
    if (prefill.sourceOrderId && prefill.sourceOrderNumber) {
      setRecreateSource({
        orderId: String(prefill.sourceOrderId),
        orderNumber: String(prefill.sourceOrderNumber),
      });
    }

    // Clear any existing cart before preloading recreate items.
    clearCart();
    setCartAdjustment(NO_DISCOUNT);
    setSelectedCustomer(null);

    const rawItems = (Array.isArray(prefill.items) ? prefill.items : []) as Array<Record<string, unknown>>;
    const validItems = rawItems.filter(
      (item) => typeof item.variantId === "string" && Number(item.quantity || 0) > 0,
    );
    for (const item of validItems) {
      addItem({
        variantId: String(item.variantId),
        productId: String(item.productId || ""),
        productName: String(item.productName || ""),
        sku: String(item.sku || ""),
        quantity: Number(item.quantity || 1),
        unitPrice: Number(item.unitPrice || 0),
        stockLevel: Number(item.stockLevel || 0),
      });
    }

    if (prefill.customer && typeof prefill.customer === "object") {
      const c = prefill.customer as Record<string, unknown>;
      setSelectedCustomer({
        id: String(c.id || ""),
        phone: String(c.phone || ""),
        name: String(c.name || ""),
      });
    }

    // Remove the state so a browser refresh won't re-apply.
    window.history.replaceState({}, "");
  }, [location.state, addItem, clearCart, operatingMerchantId, operatingStoreId]);

  const [selectedCustomer, setSelectedCustomer] = useState<{
    id: string; phone: string; name: string;
  } | null>(null);
  const [showPayment, setShowPayment] = useState(false);
  const [cartAdjustment, setCartAdjustment] = useState<CartCommercialAdjustment>(NO_DISCOUNT);
  const [receipt, setReceipt] = useState<ReceiptOrder | null>(null);
  const [completing, setCompleting] = useState(false);
  const [saleError, setSaleError] = useState("");
  const [recommendations, setRecommendations] = useState<string[]>([]);
  const [crossSellResult, setCrossSellResult] = useState<{ scopeKey: string; items: CrossSellRecommendation[] } | null>(null);
  const [featureEntitlements, setFeatureEntitlements] = useState<Set<string>>(new Set());
  const [paymentProviders, setPaymentProviders] = useState<PaymentProviderAvailability>({});
  const [resolvedOperatingScope, setOperatingScope] = useState<ScopeSnapshot | null>(null);
  const operatingScope = resolvedOperatingScope?.merchantId === operatingMerchantId
    && resolvedOperatingScope?.storeId === operatingStoreId ? resolvedOperatingScope : null;
  const latestCheckoutAccessRef = useRef(appAccess);
  latestCheckoutAccessRef.current = appAccess;
  const cartFee = useCartPaymentFeePreview(items.length ? {
    items: items.map(({ variantId, quantity }) => ({ variantId, quantity })),
    discountType: cartAdjustment.discountType, discountValue: cartAdjustment.discountValue, shippingFee: cartAdjustment.shippingFee,
    paymentFeeType: cartAdjustment.paymentFeeType ?? "percent", paymentFeeValue: cartAdjustment.paymentFeeValue ?? 0,
  } : null, Boolean(operatingScope));
  const paymentFeePreview: CartPaymentFeePreviewState | undefined = !cartFee.compatible ? undefined
    : cartFee.canConfirm && cartFee.data ? { status: "ready", preview: cartFee.data }
      : cartFee.inputError || cartFee.isError ? { status: "unavailable", message: cartFee.inputError || "Không cập nhật được giá và phụ phí. Vui lòng thử lại." }
        : { status: "pending" };
  const cartDisplay = cartTotalsForDisplay(subtotal, cartAdjustment, paymentFeePreview);
  const cartPayableLabel = cartDisplay.discountError ? "—" : `${cartDisplay.payable.toLocaleString("vi-VN")} ₫`;
  const scopeIsCurrent = useCallback(() => {
    const current = getClientScopeSnapshot();
    return Boolean(operatingScope && current.operatingMerchantId === operatingScope.merchantId
      && current.operatingStoreId === operatingScope.storeId && appAccess?.operatorId && appAccess?.accessEpoch
      && latestCheckoutAccessRef.current?.operatorId === appAccess.operatorId
      && latestCheckoutAccessRef.current?.accessEpoch === appAccess.accessEpoch);
  }, [operatingScope, appAccess?.operatorId, appAccess?.accessEpoch]);
  const crossSellScopeKey = JSON.stringify([operator?.id, appAccess?.accessEpoch, operatingMerchantId, operatingStoreId]);
  const crossSell = items.length > 0 && operatingScope && crossSellResult?.scopeKey === crossSellScopeKey
    ? crossSellResult.items : [];
  const [accessibleScope, setAccessibleScope] = useState<{ merchantIds: string[]; storeIds: string[] }>({
    merchantIds: ["merchant_default"],
    storeIds: ["store_default"],
  });
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const { data: currentShiftState } = useQuery({
    queryKey: ["currentShift", operatingScope?.merchantId, operatingScope?.storeId],
    queryFn: async () => {
      if (!scopeIsCurrent()) throw new Error("Operating scope changed");
      const result = await fetchCurrentShift();
      if (!scopeIsCurrent()) throw new Error("Operating scope changed");
      return result;
    },
    enabled: Boolean(operatingScope) && isOnline,
    staleTime: 30_000,
    refetchInterval: isOnline ? 60_000 : false,
  });
  const currentShift = operatingScope ? currentShiftState?.data || null : null;
  const currentShiftPolicy = currentShiftState?.policy;

  const onlineShiftPayload = useCallback((): Partial<CompleteSaleInput> => {
    if (!currentShift) return {};
    return {
      shiftId: currentShift.id,
      shiftOpenedAt: currentShift.openedAt,
      shiftAttribution: "online_open_shift",
    };
  }, [currentShift]);

  const offlineScopeSnapshot = useCallback((payload: CompleteSaleInput): ScopeSnapshot | undefined => {
    if (
      !operatingScope
      || !operator?.id
      || !appAccess
      || appAccess.operatorId !== operator.id
      || !runtime.selected.checkoutWrite
    ) return undefined;
    return {
      ...operatingScope,
      operatorId: appAccess.operatorId,
      accessEpoch: appAccess.accessEpoch,
      capabilityVersion: `checkoutWrite:${runtime.selected.checkoutWrite}`,
      shiftId: payload.shiftId,
      shiftOpenedAt: payload.shiftOpenedAt,
    };
  }, [appAccess, operatingScope, operator?.id, runtime.selected.checkoutWrite]);
  const [paymentIntent, setPaymentIntent] = useState<PaymentIntentResponse["data"] | null>(null);
  const [paymentIntentDraft, setPaymentIntentDraft] = useState<{
    provider: "sepay_va" | "nowpayments";
    order: CompleteSaleInput;
  } | null>(null);
  const completedIntentRef = useRef<string | null>(null);
  const paymentIntentScopeRef = useRef<ScopeSnapshot | null>(null);
  const creationReceiptRef = useRef<{ record: PendingPaymentIntentCreation; intentId: string | null } | null>(null);
  const intentCommandKeysRef = useRef<{ id: string; cancel: string; settle: string } | null>(null);
  const intentCommandKey = (id: string, action: "cancel" | "settle") => {
    if (intentCommandKeysRef.current?.id !== id) intentCommandKeysRef.current = { id, cancel: checkoutAttemptKey("intent-cancel"), settle: checkoutAttemptKey("intent-settle") };
    return intentCommandKeysRef.current[action];
  };
  const intentScopeIsCurrent = useCallback((scope = paymentIntentScopeRef.current) => {
    const current = getClientScopeSnapshot();
    return Boolean(scope && scope === paymentIntentScopeRef.current
      && scope.merchantId === current.operatingMerchantId && scope.storeId === current.operatingStoreId
      && scope.operatorId && scope.accessEpoch && scope.operatorId === latestCheckoutAccessRef.current?.operatorId
      && scope.accessEpoch === latestCheckoutAccessRef.current?.accessEpoch);
  }, []);
  const acknowledgeIntentCreation = useCallback(() => {
    const saved = creationReceiptRef.current;
    if (saved?.record && saved.intentId === paymentIntent?.id && intentScopeIsCurrent()) {
      removePendingPaymentIntentCreation(saved.record);
      creationReceiptRef.current = null;
    }
  }, [paymentIntent?.id, intentScopeIsCurrent]);
  const [tierUpgrade, setTierUpgrade] = useState<{
    oldTier: string; newTier: string; points: number;
  } | null>(null);
  const [queuedSaleRows, setQueuedSaleRows] = useState<QueuedSale[]>([]);
  const [showQueueReview, setShowQueueReview] = useState(false);
  const [offlineSummary, setOfflineSummary] = useState({ queued: 0, needsReview: 0 });
  const [showConfirmed, setShowConfirmed] = useState(false);
  const [showMobileCart, setShowMobileCart] = useState(false);
  const [unifiedScanOpen, setUnifiedScanOpen] = useState(false);
  const [visionScanOpen, setVisionScanOpen] = useState(false);
  const [pendingVisionManualFallback, setPendingVisionManualFallback] = useState<VisionManualFallbackContext | null>(null);
  const scanSearchTerm = scanSearch.trim();
  const {
    data: scanSearchProducts = [],
    isLoading: scanSearchLoading,
    error: scanSearchError,
  } = useProducts(
    { q: scanSearchTerm || undefined, limit: 8 },
    { enabled: unifiedScanOpen && scanSearchTerm.length > 0 },
  );
  const [importedScanGoCart, setImportedScanGoCart] = useState<StaffScanGoCart | null>(null);
  const [importedScanGoToken, setImportedScanGoToken] = useState<string | null>(null);
  const [pendingCheckout, setPendingCheckout] = useState<CompleteSaleInput | null>(null);
  const [stockWarning, setStockWarning] = useState<StockShortageItem[] | null>(null);
  const checkoutInFlightRef = useRef<symbol | null>(null);
  const checkoutAttemptRef = useRef<CheckoutAttempt | null>(null);
  const itemsRef = useRef(items);
  const importedScanGoCartRef = useRef<StaffScanGoCart | null>(null);
  const importingScanGoRef = useRef(false);

  const reviewChangedCartQuote = useCallback(async () => {
    const saved = creationReceiptRef.current;
    if (saved?.record && saved.record.idempotencyKey === checkoutAttemptRef.current?.paymentIntentIdempotencyKey
      && saved.record.operatorId === appAccess?.operatorId) {
      try { removePendingPaymentIntentCreation(saved.record); }
      catch { setSaleError("Chưa xác minh được mã thanh toán đã lưu. Giữ nguyên yêu cầu để kiểm tra."); return; }
      creationReceiptRef.current = null;
    }
    checkoutAttemptRef.current = null;
    setPendingCheckout(null); setStockWarning(null);
    setPaymentIntent(null); setPaymentIntentDraft(null);
    setShowPayment(true);
    setSaleError("Giá, VAT hoặc phụ phí đã thay đổi. Kiểm tra tổng mới và xác nhận lại.");
    await cartFee.refetch();
  }, [cartFee.refetch, appAccess?.operatorId]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    importedScanGoCartRef.current = importedScanGoCart;
  }, [importedScanGoCart]);

  // ── Offline Sync ──
  const refreshSaleDependentQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["products"] }),
      queryClient.invalidateQueries({ queryKey: ["inventory"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboardInventoryRisk"] }),
      ...orderFinancialMutationQueryKeys().map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
      queryClient.invalidateQueries({ queryKey: ["currentShift"] }),
    ]);
  }, [queryClient]);

  const refreshOfflineSummary = useCallback(async () => {
    setOfflineSummary(await queuedSaleSummary());
    setQueuedSaleRows(await listQueuedSales());
  }, []);

  const syncInFlight = useRef(false);
  const syncOfflineSales = useCallback(async (alreadyLocked = false) => {
    if (!navigator.onLine || !appAccess || !runtime.selected.checkoutWrite || !scopeIsCurrent()) return;
    if (syncInFlight.current && !alreadyLocked) return;
    syncInFlight.current = true;
    try {
    const queuedSales = await listQueuedSales();
    let syncedSale = false;
    for (const sale of queuedSales) {
      if (!scopeIsCurrent()) break;
      if (sale.status === "needs_review") continue;
      await updateQueuedSale(sale.id, { status: "syncing", lastError: undefined });
      const result = await replayQueuedSale(sale, {
        operatorId: appAccess.operatorId,
        accessEpoch: appAccess.accessEpoch,
        capabilityVersion: `checkoutWrite:${runtime.selected.checkoutWrite}`,
        merchantIds: accessibleScope.merchantIds,
        storeIds: accessibleScope.storeIds,
        selectedMerchantId: operatingScope?.merchantId,
        selectedStoreId: operatingScope?.storeId,
      }, completeSale);
      if (result.accepted) {
        await removeQueuedSale(sale.id);
        syncedSale = true;
      } else {
        await updateQueuedSale(sale.id, {
          status: result.review ? "needs_review" : "queued",
          lastError: result.message, lastErrorCode: result.code, lastErrorDetails: result.details,
        });
        if (!result.review) break;
      }
    }
    if (syncedSale) await refreshSaleDependentQueries();
    await refreshOfflineSummary();
    } finally { syncInFlight.current = false; }
  }, [accessibleScope, appAccess, operatingScope, refreshOfflineSummary, refreshSaleDependentQueries, runtime.selected.checkoutWrite, scopeIsCurrent]);

  const beginCheckout = useCallback(() => {
      if (runtime.surfaces.checkoutWrite !== "enabled" || !appAccess || !operatingScope || !scopeIsCurrent()
      || isPaymentIntentCartLocked(paymentIntent?.status)) {
      setSaleError("Chưa xác minh được quyền và capability checkout. Vui lòng kết nối lại rồi thử lại.");
      return;
    }
    if (cartDisplay.discountError) { setSaleError(cartDisplay.discountError); return; }
    setSaleError("");
    setShowPayment(true);
  }, [appAccess, runtime.surfaces.checkoutWrite, scopeIsCurrent, paymentIntent?.status, cartDisplay.discountError]);

  useEffect(() => {
    if (items.length === 0 || !featureEntitlements.has("smart_cross_sell") || !scopeIsCurrent()) {
      setCrossSellResult(null);
      return;
    }
    let current = true;
    const timeout = window.setTimeout(() => {
      if (!current || !scopeIsCurrent()) return;
      void fetchCrossSellRecommendations({
        items: items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
        customerId: selectedCustomer?.id,
        limit: 2,
      })
        .then((res) => {
          if (current && scopeIsCurrent()) setCrossSellResult({ scopeKey: crossSellScopeKey, items: res.data || [] });
        })
        .catch(() => {
          if (current && scopeIsCurrent()) setCrossSellResult(null);
        });
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timeout);
    };
  }, [items, selectedCustomer?.id, featureEntitlements, crossSellScopeKey, scopeIsCurrent]);

  const finishCompletedSale = useCallback(async (body: Awaited<ReturnType<typeof completeSale>>) => {
    await refreshSaleDependentQueries();
    if (!scopeIsCurrent()) return;
    const d = body.data;
    setReceipt({
      orderId: d.orderId, orderNumber: d.orderNumber,
      total: d.total, subtotal: d.subtotal, tax: d.tax || 0, discount: d.discount || 0,
      shippingFee: d.shippingFee || 0,
      change: d.change, paymentMethod: d.paymentMethod,
      items: d.items.map((i: Record<string, unknown>) => ({
        name: String(i.name || ""), quantity: Number(i.quantity),
        unitPrice: Number(i.unitPrice), lineTotal: Number(i.lineTotal),
      })),
      createdAt: d.createdAt,
      financial: d.financial,
    });
    setCartAdjustment(NO_DISCOUNT);
    setShowPayment(false);
    setStockWarning(null);
    setPendingCheckout(null);
    if (selectedCustomer?.id) {
      try {
        const recRes = await fetchAiRecommendations(selectedCustomer.id);
        setRecommendations((recRes?.data || []) as string[]);
      } catch { /* ignore */ }
    }
  }, [refreshSaleDependentQueries, selectedCustomer?.id, scopeIsCurrent]);

  useEffect(() => {
    let active = true;
    setOperatingScope(null);
    setFeatureEntitlements(new Set());
    setPaymentProviders({});
    void refreshOfflineSummary();
    if (!operatingSnapshot || !operatingMerchantId || !operatingStoreId) return;
    void fetchSyncBootstrap()
      .then((res) => {
        const current = getClientScopeSnapshot();
        if (!active || current.operatingMerchantId !== operatingMerchantId
          || current.operatingStoreId !== operatingStoreId) return;
        const scope = res.data.activeOperatingScope;
        if (!scope || scope.merchantId !== operatingMerchantId || scope.storeId !== operatingStoreId) return;
        const features = res.data.entitlements?.data?.features || res.data.entitlements?.features || [];
        setFeatureEntitlements(new Set(features));
        setOperatingScope(scope);
        setAccessibleScope((previous) => reconcileAccessibleScope(previous, {
          merchantIds: (res.data.accessibleMerchants || []).map((m: { id: string }) => m.id),
          storeIds: (res.data.accessibleStores || []).map((s: { id: string }) => s.id),
        }));
        setPaymentProviders(res.data.paymentProviders || {});
        return saveBootstrapSnapshot({
          generatedAt: res.data.generatedAt,
          permissionVersion: res.data.permissionVersion,
          operatorId: res.data.operatorId,
          sessionVersion: res.data.sessionVersion,
          snapshotAuthorizationExpiresAt: res.data.snapshotAuthorizationExpiresAt,
          products: res.data.products,
          customers: res.data.customers as never,
          loyaltyTiers: res.data.loyaltyTiers,
        }, operatingSnapshot, scope);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [operatingMerchantId, operatingStoreId, operatingSnapshot, refreshOfflineSummary]);

  const previousSelection = useRef({ operatingMerchantId, operatingStoreId, operatorId: appAccess?.operatorId, accessEpoch: appAccess?.accessEpoch });
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { operatingMerchantId, operatingStoreId, operatorId: appAccess?.operatorId, accessEpoch: appAccess?.accessEpoch };
    if (previous.operatingMerchantId === operatingMerchantId && previous.operatingStoreId === operatingStoreId
      && previous.operatorId === appAccess?.operatorId && previous.accessEpoch === appAccess?.accessEpoch) return;
    clearCart();
    setSelectedCustomer(null);
    setShowPayment(false);
    setStockWarning(null);
    setPendingCheckout(null);
    setRecreateSource(null);
    setImportedScanGoCart(null);
    setImportedScanGoToken(null);
    setReceipt(null);
    checkoutAttemptRef.current = null;
    checkoutInFlightRef.current = null;
    setCompleting(false);
    setSaleError("Đã đổi cửa hàng hoặc quyền truy cập. Giỏ hàng đã được làm mới; thanh toán đang chờ cần kiểm tra trong phạm vi ban đầu.");
  }, [clearCart, operatingMerchantId, operatingStoreId, appAccess?.operatorId, appAccess?.accessEpoch]);

  // Queue retry depends on resolved access, independently of bootstrap requests.
  useEffect(() => {
    const onOnline = () => { setIsOnline(true); void syncOfflineSales(); };
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    if (navigator.onLine) void syncOfflineSales();
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [syncOfflineSales]);

  useEffect(() => {
    if (!paymentIntent || !isPaymentIntentCartLocked(paymentIntent.status) || !intentScopeIsCurrent()) return;
    let active = true;
    const controller = new AbortController();
    const capturedScope = paymentIntentScopeRef.current!;
    const interval = window.setInterval(() => {
      void (paymentIntent.financial ? fetchPaymentIntentFinancialV1(paymentIntent.id, {
        scopeKind: "report", merchantId: capturedScope.merchantId, storeIds: [capturedScope.storeId],
      }, controller.signal) : fetchPaymentIntent(paymentIntent.id))
        .then(async (result) => {
          if (!active || !intentScopeIsCurrent()) return;
          setPaymentIntent(result.data);
          if (
            result.data.status === "completed"
            && result.data.completedOrderId
            && completedIntentRef.current !== result.data.id
          ) {
            completedIntentRef.current = result.data.id;
            await refreshSaleDependentQueries();
            if (!active || !intentScopeIsCurrent()) return;
            clearCart();
            setRecreateSource(null);
            setImportedScanGoCart(null);
            setImportedScanGoToken(null);
            setSelectedCustomer(null);
          }
        })
        .catch(() => undefined);
    }, 2500);
    return () => { active = false; controller.abort(); window.clearInterval(interval); };
  }, [clearCart, paymentIntent, refreshSaleDependentQueries, intentScopeIsCurrent, operatingMerchantId, operatingStoreId]);

  // ── Product Selection ──
  const recordPendingVisionManualFallback = useCallback((variantId: string): VisionCartContext | undefined => {
    const pending = pendingVisionManualFallback;
    if (!pending) return undefined;
    setPendingVisionManualFallback(null);
    void recordVisionScanCorrection(pending.scanId, {
      detectionId: pending.detectionId,
      selectedVariantId: variantId,
      previousVariantId: pending.previousVariantId,
      correctionType: "manual_search_selected",
      metadata: { source: "pos_manual_search_fallback" },
    }).catch((err) => {
      const message = err instanceof Error ? err.message : "Không ghi được manual fallback cho AI Vision.";
      setSaleError(`Đã thêm sản phẩm, nhưng chưa ghi được feedback AI: ${message}`);
    });
    return {
      scanEventId: pending.scanId,
      detectionId: pending.detectionId,
      candidateSource: "manual_search_after_scan",
      provider: "manual_search_after_scan",
    };
  }, [pendingVisionManualFallback]);

  const handleSelectProduct = useCallback((variantId: string) => {
    const product = products?.find((p) => p.variants.some((v) => v.id === variantId));
    const variant = product?.variants.find((v) => v.id === variantId);
    if (!product || !variant) return;
    const visionContext = recordPendingVisionManualFallback(variant.id);
    addItem({
      variantId: variant.id,
      productId: product.id,
      productName: product.title,
      sku: variant.sku || "",
      quantity: 1,
      unitPrice: variant.prices?.[0]?.amount || 0,
      stockLevel: variant.inventory_quantity ?? 0,
      visionContexts: visionContext ? [visionContext] : undefined,
    });
  }, [products, addItem, recordPendingVisionManualFallback]);

  const handleSelectScanSearchProduct = useCallback((variantId: string) => {
    const product = scanSearchProducts.find((p) => p.variants.some((v) => v.id === variantId));
    const variant = product?.variants.find((v) => v.id === variantId);
    if (!product || !variant) return;
    addItem({
      variantId: variant.id,
      productId: product.id,
      productName: product.title,
      sku: variant.sku || "",
      quantity: 1,
      unitPrice: variant.prices?.[0]?.amount || 0,
      stockLevel: variant.inventory_quantity ?? 0,
    });
    setScanSearch("");
    setSaleError("");
    setUnifiedScanOpen(false);
  }, [addItem, scanSearchProducts]);

  const handleAcceptCrossSell = useCallback((item: CrossSellRecommendation) => {
    void recordCrossSellAcceptance({
      acceptedVariantId: item.variantId,
      acceptedProductId: item.productId,
      cartVariantIds: items.map((cartItem) => cartItem.variantId),
      customerId: selectedCustomer?.id,
      source: "pos",
      metadata: {
        score: item.score,
        reason: item.reason,
      },
    }).catch(() => undefined);
    addItem({
      variantId: item.variantId,
      productId: item.productId,
      productName: item.name,
      sku: item.sku,
      quantity: 1,
      unitPrice: item.price,
      stockLevel: item.stock,
    });
  }, [addItem, items, selectedCustomer?.id]);

  const handleResolvedProductScan = useCallback((resolution: ProductScanResolution) => {
    addItem({
      variantId: resolution.variantId,
      productId: resolution.productId,
      productName: resolution.title,
      sku: resolution.sku,
      quantity: 1,
      unitPrice: resolution.price,
      stockLevel: resolution.stock,
    });
    setSearch("");
    setSaleError("");
  }, [addItem]);

  const handleImportScanGoCart = useCallback(async (tokenOrPayload: string) => {
    if (importingScanGoRef.current) return false;
    importingScanGoRef.current = true;
    try {
      const result = await resolveScanGoCart({ tokenOrPayload });
      const cart = result.data;
      const currentImportedCart = importedScanGoCartRef.current;
      const shouldReplaceCurrentCart = itemsRef.current.length > 0 || Boolean(currentImportedCart);
      if (shouldReplaceCurrentCart) {
      const confirmed = window.confirm(
        currentImportedCart
          ? "Thay Stash Dash hiện tại bằng QR tổng mới? Giỏ hiện tại sẽ bị xóa để giữ tracking đúng."
          : "POS đang có sản phẩm trong giỏ. Nhập Stash Dash sẽ thay toàn bộ giỏ hiện tại để tracking đúng. Tiếp tục?",
      );
      if (!confirmed) return false;
    }
      if (shouldReplaceCurrentCart) clearCart();
      for (const line of cart.lines) {
        addItem({
          variantId: line.variantId,
          productId: line.productId,
          productName: line.title,
          sku: line.sku,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          stockLevel: line.stockLevel,
        });
      }
      setImportedScanGoCart(cart);
      setImportedScanGoToken(tokenOrPayload);
      setRecreateSource(null);
      setSelectedCustomer(null);
      setShowMobileCart(false);
      setSaleError(cart.warnings.length > 0 ? `Stash Dash có ${cart.warnings.length} cảnh báo cần kiểm tra trước khi thu tiền.` : "");
      return true;
    } finally {
      importingScanGoRef.current = false;
    }
  }, [addItem, clearCart]);

  const handleUnifiedScanCode = useCallback(async (rawCode: string) => {
    if (isScanGoCartPayload(rawCode)) {
      return handleImportScanGoCart(rawCode);
    }

    const result = await resolveProductScan({ code: rawCode, context: "pos_add_to_cart" });
    handleResolvedProductScan(result.data);
  }, [handleImportScanGoCart, handleResolvedProductScan]);

  const handleVisionCandidateAccepted = useCallback((candidate: VisionCandidateView, context?: VisionCartContext) => {
    addItem({
      variantId: candidate.variantId,
      productId: candidate.productId,
      productName: candidate.title,
      sku: candidate.sku,
      quantity: 1,
      unitPrice: candidate.price,
      stockLevel: candidate.stock,
      visionContexts: context ? [context] : undefined,
    });
    setSearch("");
    setSaleError("");
    setShowMobileCart(false);
  }, [addItem]);

  const confirmClearImportedScanGoCart = useCallback(() => {
    if (!importedScanGoCart) return true;
    return window.confirm("Giỏ này được nhập từ Stash Dash. Xóa giỏ sẽ bỏ khóa kênh Stash Dash và cần scan lại QR tổng nếu muốn tiếp tục. Xóa giỏ?");
  }, [importedScanGoCart]);

  // ── Keypad Handlers ──
  const selectedItem = selectedIndex !== null ? items[selectedIndex] : null;

  const handleKeypadNumber = useCallback((n: number) => {
    if (selectedItem) {
      updateQty(selectedItem.variantId, n);
    } else if (items.length > 0) {
      setSearchFlash(true);
      setTimeout(() => setSearchFlash(false), 1000);
    }
  }, [selectedItem, items, updateQty]);

  const handleKeypadIncrement = useCallback((n: number) => {
    if (selectedItem) {
      updateQty(selectedItem.variantId, selectedItem.quantity + n);
    } else if (items.length > 0) {
      const lastItem = items[items.length - 1];
      updateQty(lastItem.variantId, lastItem.quantity + n);
    }
  }, [selectedItem, items, updateQty]);

  const handleRemoveCartItem = useCallback((variantId: string) => {
    if (items.length === 1 && !confirmClearImportedScanGoCart()) return;
    removeItem(variantId);
    if (items.length === 1) {
      setRecreateSource(null);
      setImportedScanGoCart(null);
      setImportedScanGoToken(null);
    }
  }, [confirmClearImportedScanGoCart, items.length, removeItem]);

  const handleKeypadDelete = useCallback(() => {
    if (selectedItem) {
      handleRemoveCartItem(selectedItem.variantId);
    } else if (items.length > 0) {
      handleRemoveCartItem(items[items.length - 1].variantId);
    }
  }, [selectedItem, items, handleRemoveCartItem]);

  const handleKeypadClear = useCallback(() => {
    if (items.length > 0) {
      if (!confirmClearImportedScanGoCart()) return;
      clearCart();
      setImportedScanGoCart(null);
      setImportedScanGoToken(null);
    }
    setRecreateSource(null);
  }, [clearCart, confirmClearImportedScanGoCart, items.length]);

  useEffect(() => {
    if (items.length === 0) {
      setCartAdjustment(NO_DISCOUNT);
      setImportedScanGoCart(null);
      setImportedScanGoToken(null);
      checkoutAttemptRef.current = null;
      checkoutInFlightRef.current = null;
    }
  }, [items.length]);

  // ── Scanner: Enter triggers lookup ──
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && search.trim()) {
      // Barcode scanners append Enter. The search value is already set.
      // Products will filter automatically via the useProducts query.
    }
  }, [search]);

  // ── Checkout ──
  const handleCompleteSale = useCallback(async (
    paymentMethod: PaymentMethod,
    amountReceived: number,
    adjustment: CartCommercialAdjustment,
    notes: string,
    salesChannel: SalesChannelValue,
    customerMode: "linked" | "walk_in",
    bankTransferSettlementAcknowledgment?: { policyVersion: number; acknowledgmentVersion: number },
  ) => {
    if (checkoutInFlightRef.current) return;
    const flight = Symbol("checkout");
    checkoutInFlightRef.current = flight;
    const attemptIsCurrent = () => checkoutInFlightRef.current === flight && scopeIsCurrent();
    setCompleting(true);
    setSaleError("");
    let payload: CompleteSaleInput | null = null;
    let saleDispatched = false;
    try {
      if (runtime.surfaces.checkoutWrite !== "enabled" || !appAccess || !operatingScope || !attemptIsCurrent()
      || isPaymentIntentCartLocked(paymentIntent?.status)) {
        throw new Error("Không thể xác minh capability checkout và quyền truy cập hiện tại.");
      }
      if (customerMode === "linked" && !selectedCustomer?.id) {
        throw new Error("Khách hàng chưa được chọn hoặc tạo hợp lệ.");
      }
      const checkoutAttempt = checkoutAttemptRef.current || newCheckoutAttempt(cartFee.compatible ? { operatorId: appAccess.operatorId, storeId: operatingScope.storeId } : undefined);
      checkoutAttemptRef.current = checkoutAttempt;
      if (listPendingPaymentIntentCreations({ operatorId: appAccess.operatorId, merchantId: operatingScope.merchantId, storeId: operatingScope.storeId })
        .some(record => record.idempotencyKey !== checkoutAttempt.paymentIntentIdempotencyKey)) {
        throw new Error("Còn yêu cầu thanh toán đã lưu cần kiểm tra. Xác minh kết quả trước khi tạo đơn thay thế.");
      }
      const signature = JSON.stringify({
        items: items.map(({ variantId, quantity, visionContexts }) => ({ variantId, quantity, visionContexts })),
        customerId: customerMode === "linked" ? selectedCustomer?.id : undefined, customerMode, paymentMethod, amountReceived,
        adjustment: { ...adjustment, paymentFeeType: adjustment.paymentFeeType ?? "percent", paymentFeeValue: adjustment.paymentFeeValue ?? 0 },
        notes, salesChannel, sourceOrderId: recreateSource?.orderId, scanGoCartId: importedScanGoCart?.cartId,
        bankTransferSettlementAcknowledgment,
      });
      if (checkoutAttempt.confirmed && checkoutAttempt.confirmed.signature !== signature) {
        throw new Error("Lần xác nhận trước chưa xác định kết quả. Giữ nguyên thông tin đã xác nhận để thử lại, tránh tạo trùng giao dịch.");
      }
      if (checkoutAttempt.confirmed) {
        payload = checkoutAttempt.confirmed.payload;
      } else {
        if (cartFee.compatible) {
          const confirmed = CartPaymentFeePreviewInputV1Schema.parse({ items: items.map(({ variantId, quantity }) => ({ variantId, quantity })),
            discountType: adjustment.discountType, discountValue: adjustment.discountValue, shippingFee: adjustment.shippingFee,
            paymentFeeType: adjustment.paymentFeeType ?? "percent", paymentFeeValue: adjustment.paymentFeeValue ?? 0 });
          if (!cartFee.canConfirm || !cartFee.data || JSON.stringify(confirmed) !== JSON.stringify(cartFee.data.data.input)) {
            throw new Error("Giỏ hàng hoặc phụ phí đã thay đổi. Đợi bản tính mới trước khi xác nhận.");
          }
        } else if (adjustment.paymentFeeType !== undefined || adjustment.paymentFeeValue !== undefined) {
          throw new Error("Chức năng phụ phí chưa sẵn sàng trên máy chủ hiện tại.");
        }
        const usesPaymentIntent = isPaymentIntentPaymentMethod(paymentMethod);
        let scanGoCartForCheckout = importedScanGoCart;
        if (importedScanGoCart && importedScanGoCart.status !== "redeemed" && !usesPaymentIntent) {
          if (!importedScanGoToken) {
            throw new Error("Thiếu token Stash Dash. Vui lòng scan lại QR tổng của khách.");
          }
          const redeemed = await redeemScanGoCart({ tokenOrPayload: importedScanGoToken });
          scanGoCartForCheckout = redeemed.data;
          setImportedScanGoCart(redeemed.data);
        }
        if (importedScanGoCart && importedScanGoCart.status !== "redeemed" && usesPaymentIntent && !importedScanGoToken) {
          throw new Error("Thiếu token Stash Dash. Vui lòng scan lại QR tổng của khách.");
        }
        const scanGoOrderMetadata = scanGoCartForCheckout
          ? {
              sourceFlow: "customer_scan_go",
              scanGoCartId: scanGoCartForCheckout.cartId,
              scanGoRedeemedAt: scanGoCartForCheckout.redeemedAt,
              salesChannelLocked: true,
              customerNickname: scanGoCartForCheckout.customerNickname,
              customerContactType: scanGoCartForCheckout.contactType,
              redeemedByOperatorId: scanGoCartForCheckout.redeemedByOperatorId,
              ...(usesPaymentIntent && scanGoCartForCheckout.status !== "redeemed"
                ? { scanGoCheckoutToken: importedScanGoToken || undefined }
                : {}),
            }
          : {};
        payload = {
          items: items.map((i) => ({
            variantId: i.variantId,
            quantity: i.quantity,
            visionContexts: i.visionContexts,
            vision: i.visionContexts?.[0],
          })),
          customerId: customerMode === "linked" ? selectedCustomer?.id : undefined,
          customerMode,
          paymentMethod,
          amountReceived,
          discountType: adjustment.discountType,
          discountValue: adjustment.discountValue,
          shippingFee: adjustment.shippingFee,
          ...(cartFee.compatible ? { paymentFeeType: adjustment.paymentFeeType ?? "percent", paymentFeeValue: adjustment.paymentFeeValue ?? 0,
            cartConfirmationToken: cartFee.data!.data.confirmationToken } : {}),
          notes: notes || undefined,
          salesChannel: scanGoCartForCheckout ? "stash_dash" : salesChannel,
          ...scanGoOrderMetadata,
          ...onlineShiftPayload(),
          sourceOrderId: recreateSource?.orderId,
          idempotencyKey: checkoutAttempt.saleIdempotencyKey,
          ...(bankTransferSettlementAcknowledgment ? { bankTransferSettlementAcknowledgment } : {}),
        };
      }
      if (isPaymentIntentPaymentMethod(payload.paymentMethod)) {
        if (runtime.surfaces.paymentWrite !== "enabled") {
          throw new Error("Không thể xác minh capability thanh toán online hiện tại.");
        }
        if (!attemptIsCurrent()) throw new Error("Cửa hàng đã thay đổi. Vui lòng tạo lại giỏ hàng.");
        if (cartFee.compatible) checkoutAttempt.confirmed ??= { signature, payload };
        const capturedIntentScope = offlineScopeSnapshot(payload);
        if (!capturedIntentScope) throw new Error("Không thể xác minh người thao tác và phạm vi thanh toán.");
        paymentIntentScopeRef.current = capturedIntentScope;
        const request = {
          provider: payload.paymentMethod,
          order: payload,
          idempotencyKey: checkoutAttempt.paymentIntentIdempotencyKey,
        };
        if (cartFee.compatible) {
          const record = await preservePaymentIntentCreation(request, capturedIntentScope);
          if (!attemptIsCurrent()) return;
          creationReceiptRef.current = { record, intentId: null };
        }
        const intent = cartFee.compatible ? await createPaymentIntentFinancialV1(request, capturedIntentScope) : await createPaymentIntent(request);
        if (!attemptIsCurrent()) return;
        if (creationReceiptRef.current?.record?.idempotencyKey === request.idempotencyKey) creationReceiptRef.current.intentId = intent.data.id;
        setPaymentIntentDraft({ provider: request.provider, order: payload });
        setPaymentIntent(intent.data);
        setSaleError("");
        checkoutAttemptRef.current = null;
        return;
      }
      if (!attemptIsCurrent()) throw new Error("Cửa hàng đã thay đổi. Vui lòng tạo lại giỏ hàng.");
      if (cartFee.compatible) checkoutAttempt.confirmed ??= { signature, payload };
      saleDispatched = true;
      const body = await completeSale(payload, operatingScope || undefined);
      if (!attemptIsCurrent()) return;
      await finishCompletedSale(body);
      checkoutAttemptRef.current = null;
    } catch (err) {
      if (!attemptIsCurrent()) {
        const message = err instanceof Error ? err.message : "";
        if (saleDispatched && payload && (!navigator.onLine || /failed to fetch|network|load failed/i.test(message))) {
          const snapshot = offlineScopeSnapshot(payload);
          if (snapshot) {
            const queued = await enqueueSale(payload, snapshot);
            await updateQueuedSale(queued.id, { status: "needs_review", lastError: "Cửa hàng đã đổi khi chờ kết quả checkout. Kiểm tra đơn tại cửa hàng ban đầu trước khi thử lại." });
            await refreshOfflineSummary();
          }
        }
        return;
      }
      if (err instanceof ApiError && err.code === "cart_quote_changed") { await reviewChangedCartQuote(); return; }
      if (payload && err instanceof ApiError && err.code === "stock_shortage_requires_confirmation") {
        const shortages = normalizeStockShortages(err.details);
        if (shortages?.length) {
          setPendingCheckout(payload);
          setStockWarning(shortages);
          return;
        }
      }
      if (!attemptIsCurrent()) return;
      const message = err instanceof Error ? err.message : "";
      const networkFailure = !navigator.onLine || /failed to fetch|network|load failed/i.test(message);
      if (networkFailure && payload) {
        const paymentIntentPayload = isPaymentIntentPaymentMethod(payload.paymentMethod);
        if (paymentIntentPayload) {
          setSaleError("QR thanh toán cần kết nối online để tạo intent và đối soát. Vui lòng thử lại khi có mạng.");
          return;
        }
        const cachedShortage = items.some((item) => item.quantity > item.stockLevel);
        // The server may already have committed: preserve the exact dispatched body.
        const offlinePayload = payload;
        const scopeSnapshot = offlineScopeSnapshot(offlinePayload);
        if (!scopeSnapshot) {
          setSaleError("Không thể lưu đơn offline vì thiếu snapshot quyền, scope hoặc capability hợp lệ.");
          return;
        }
        const queued = await enqueueSale(offlinePayload, scopeSnapshot);
        if (cachedShortage) {
          await updateQueuedSale(queued.id, {
            status: "needs_review",
            lastError: "Offline sale exceeds cached stock; online confirmation required.",
          });
        }
        await refreshOfflineSummary();
        setShowPayment(false);
        clearCart();
        setRecreateSource(null);
        setImportedScanGoCart(null);
        setImportedScanGoToken(null);
        setSelectedCustomer(null);
        setSaleError(cachedShortage ? "Đơn offline vượt tồn cache cần xác nhận online trước khi đồng bộ." : t("pos.savedOffline"));
        checkoutAttemptRef.current = null;
      } else {
        setSaleError(message || "Lỗi thanh toán");
      }
    } finally {
      if (checkoutInFlightRef.current === flight) {
        checkoutInFlightRef.current = null;
        setCompleting(false);
      }
    }
  }, [
    appAccess,
    cartFee.compatible,
    cartFee.canConfirm,
    cartFee.data,
    reviewChangedCartQuote,
    scopeIsCurrent,
    paymentIntent?.status,
    clearCart,
    finishCompletedSale,
    importedScanGoCart,
    importedScanGoToken,
    items,
    offlineScopeSnapshot,
    onlineShiftPayload,
    operatingScope,
    recreateSource?.orderId,
    refreshOfflineSummary,
    runtime.surfaces.checkoutWrite,
    runtime.surfaces.paymentWrite,
    selectedCustomer?.id,
    t,
  ]);

  const handleMockSettleIntent = useCallback(async () => {
    if (!paymentIntent || !intentScopeIsCurrent()) return;
    const capturedScope = paymentIntentScopeRef.current!;
    setCompleting(true);
    setSaleError("");
    try {
      const result = paymentIntent.financial
        ? await resolvePaymentIntentFinancialV1(paymentIntent.id, "mock-settle", intentCommandKey(paymentIntent.id, "settle"), capturedScope)
        : await mockSettlePaymentIntent(paymentIntent.id);
      if (!intentScopeIsCurrent(capturedScope)) return;
      setPaymentIntent(result.data);
      if (result.order) {
        await refreshSaleDependentQueries();
        if (!intentScopeIsCurrent(capturedScope)) return;
        setShowPayment(false);
        clearCart();
        setRecreateSource(null);
        setImportedScanGoCart(null);
        setImportedScanGoToken(null);
        setSelectedCustomer(null);
      }
    } catch (err) {
      if (!intentScopeIsCurrent(capturedScope)) return;
      setSaleError(err instanceof Error ? err.message : "Lỗi xác nhận thanh toán");
    } finally {
      if (intentScopeIsCurrent(capturedScope)) setCompleting(false);
    }
  }, [clearCart, paymentIntent, refreshSaleDependentQueries, intentScopeIsCurrent]);

  const handleCancelPaymentIntent = useCallback(async () => {
    if (!paymentIntent || paymentIntent.status !== "pending" || !intentScopeIsCurrent()) return;
    const capturedScope = paymentIntentScopeRef.current!;
    setCompleting(true);
    setSaleError("");
    try {
      const result = paymentIntent.financial
        ? await resolvePaymentIntentFinancialV1(paymentIntent.id, "cancel", intentCommandKey(paymentIntent.id, "cancel"), capturedScope)
        : await cancelPaymentIntent(paymentIntent.id);
      if (!intentScopeIsCurrent(capturedScope)) return;
      setPaymentIntent(result.data);
    } catch (err) {
      if (!intentScopeIsCurrent(capturedScope)) return;
      setSaleError(err instanceof Error ? err.message : "Lỗi hủy payment intent");
    } finally {
      if (intentScopeIsCurrent(capturedScope)) setCompleting(false);
    }
  }, [paymentIntent, intentScopeIsCurrent]);

  const handleRenewPaymentIntent = useCallback(async () => {
    if (!paymentIntentDraft || !intentScopeIsCurrent() || isPaymentIntentCartLocked(paymentIntent?.status)) return;
    const capturedScope = paymentIntentScopeRef.current!;
    setCompleting(true);
    setSaleError("");
    try {
      acknowledgeIntentCreation();
      const attempt = checkoutAttemptRef.current || newCheckoutAttempt(paymentIntentDraft.order.paymentFeeType !== undefined
        ? { operatorId: capturedScope.operatorId!, storeId: capturedScope.storeId } : undefined);
      checkoutAttemptRef.current = attempt;
      if (listPendingPaymentIntentCreations({ operatorId: capturedScope.operatorId!, merchantId: capturedScope.merchantId, storeId: capturedScope.storeId })
        .some(record => record.idempotencyKey !== attempt.paymentIntentIdempotencyKey)) throw new Error("Còn yêu cầu thanh toán đã lưu cần kiểm tra trước khi tạo QR mới.");
      const request = {
        provider: paymentIntentDraft.provider,
        order: paymentIntentDraft.order,
        idempotencyKey: attempt.paymentIntentIdempotencyKey,
      };
      if (paymentIntentDraft.order.paymentFeeType !== undefined) {
        const record = await preservePaymentIntentCreation(request, capturedScope);
        if (!intentScopeIsCurrent(capturedScope)) return;
        creationReceiptRef.current = { record, intentId: null };
      }
      const intent = paymentIntentDraft.order.paymentFeeType !== undefined
        ? await createPaymentIntentFinancialV1(request, capturedScope) : await createPaymentIntent(request);
      if (!intentScopeIsCurrent(capturedScope)) return;
      if (creationReceiptRef.current?.record?.idempotencyKey === request.idempotencyKey) creationReceiptRef.current.intentId = intent.data.id;
      checkoutAttemptRef.current = null;
      completedIntentRef.current = null;
      setPaymentIntent(intent.data);
    } catch (err) {
      if (!intentScopeIsCurrent(capturedScope)) return;
      if (err instanceof ApiError && err.code === "cart_quote_changed") { await reviewChangedCartQuote(); return; }
      setSaleError(err instanceof Error ? err.message : "Lỗi tạo QR mới");
    } finally {
      if (intentScopeIsCurrent(capturedScope)) setCompleting(false);
    }
  }, [paymentIntentDraft, paymentIntent?.status, intentScopeIsCurrent, reviewChangedCartQuote, acknowledgeIntentCreation]);

  const handleChangePaymentMethodFromIntent = useCallback(() => {
    if (!intentScopeIsCurrent() || isPaymentIntentCartLocked(paymentIntent?.status)) return;
    try { acknowledgeIntentCreation(); }
    catch { setSaleError("Chưa xác minh được mã thanh toán đã lưu. Kiểm tra trước khi đổi phương thức."); return; }
    setPaymentIntent(null);
    setShowPayment(true);
  }, [paymentIntent, intentScopeIsCurrent, acknowledgeIntentCreation]);

  const handleClosePaymentIntent = useCallback(() => {
    if (!intentScopeIsCurrent() || isPaymentIntentCartLocked(paymentIntent?.status)) return;
    try { acknowledgeIntentCreation(); }
    catch { setSaleError("Chưa xác minh được mã thanh toán đã lưu. Kiểm tra trước khi đóng."); return; }
    setPaymentIntent(null);
  }, [paymentIntent, intentScopeIsCurrent, acknowledgeIntentCreation]);

  const handleRecoverPaymentIntent = useCallback((record: PendingPaymentIntentCreation, intent: PaymentIntentFinancialViewV1) => {
    if (completing || !scopeIsCurrent() || !appAccess || !operatingScope || record.operatorId !== appAccess.operatorId
      || record.merchantId !== operatingScope.merchantId || record.storeId !== operatingScope.storeId
      || intent.merchantId !== record.merchantId || intent.storeId !== record.storeId) return;
    if (items.length && !window.confirm("Giỏ hàng hiện tại sẽ được làm mới để xem thanh toán cũ. Tiếp tục?")) return;
    clearCart(); setCartAdjustment(NO_DISCOUNT); setSelectedCustomer(null); setRecreateSource(null);
    setImportedScanGoCart(null); setImportedScanGoToken(null); setPendingCheckout(null); setStockWarning(null); setShowPayment(false);
    checkoutAttemptRef.current = null;
    paymentIntentScopeRef.current = { ...operatingScope, operatorId: appAccess.operatorId, accessEpoch: appAccess.accessEpoch };
    creationReceiptRef.current = { record, intentId: intent.id };
    setPaymentIntentDraft(null); setPaymentIntent(intent);
  }, [completing, scopeIsCurrent, appAccess, operatingScope, items.length, clearCart]);

  const handleConfirmFoundStock = useCallback(async () => {
    if (!pendingCheckout || !stockWarning?.length || !scopeIsCurrent()) return;
    if (checkoutInFlightRef.current) return;
    const flight = Symbol("checkout");
    checkoutInFlightRef.current = flight;
    const attemptIsCurrent = () => checkoutInFlightRef.current === flight && scopeIsCurrent();
    setCompleting(true);
    setSaleError("");
    let confirmedCheckout = pendingCheckout;
    try {
      if (!pendingCheckout.foundStockConfirmation?.confirmed) {
        const foundStockEnabled = await checkoutPolicy.refreshFoundStockPolicy();
        if (!attemptIsCurrent()) return;
        if (!foundStockEnabled) throw new Error("Merchant không cho phép xác nhận tìm thấy hàng. Đơn chưa được bán.");
        confirmedCheckout = { ...pendingCheckout, foundStockConfirmation: {
          confirmed: true, reasonCode: "found_stock", reasonLabel: "Tìm thấy",
          acknowledgedShortages: stockWarning.map(({ variantId, shortageQuantity }) => ({ variantId, shortageQuantity })),
        } };
        // Keep the exact dispatched payload for a receipt lost after commit.
        setPendingCheckout(confirmedCheckout);
      }
      const body = await completeSale(confirmedCheckout, operatingScope || undefined);
      if (!attemptIsCurrent()) return;
      await finishCompletedSale(body);
      checkoutAttemptRef.current = null;
    } catch (err) {
      if (!attemptIsCurrent()) {
        const message = err instanceof Error ? err.message : "";
        if (confirmedCheckout.foundStockConfirmation?.confirmed && (!navigator.onLine || /failed to fetch|network|load failed/i.test(message))) {
          const snapshot = offlineScopeSnapshot(confirmedCheckout);
          if (snapshot) {
            const queued = await enqueueSale(confirmedCheckout, snapshot);
            await updateQueuedSale(queued.id, { status: "needs_review", lastError: "Phạm vi hoặc phiên thao tác đã đổi khi chờ xác nhận tìm thấy hàng. Kiểm tra đơn trong phạm vi ban đầu trước khi thử lại." });
            await refreshOfflineSummary();
          }
        }
        return;
      }
      if (err instanceof ApiError && err.code === "stock_shortage_requires_confirmation") {
        const shortages = normalizeStockShortages(err.details);
        if (shortages?.length) {
          setStockWarning(shortages);
          setPendingCheckout({
            ...pendingCheckout,
            foundStockConfirmation: undefined,
          });
          return;
        }
      }
      if (err instanceof ApiError && err.code === "cart_quote_changed") { await reviewChangedCartQuote(); return; }
      setSaleError(err instanceof Error ? err.message : "Lỗi thanh toán");
    } finally {
      if (checkoutInFlightRef.current === flight) {
        checkoutInFlightRef.current = null;
        setCompleting(false);
      }
    }
  }, [finishCompletedSale, pendingCheckout, stockWarning, operatingScope, scopeIsCurrent, checkoutPolicy, reviewChangedCartQuote, offlineScopeSnapshot, refreshOfflineSummary]);

  const handleBackFromStockWarning = useCallback(() => {
    if (pendingCheckout?.foundStockConfirmation?.confirmed) {
      setSaleError("Đã gửi xác nhận tìm thấy hàng nhưng chưa có kết quả. Kiểm tra lại cùng đơn trước khi thay đổi giỏ hàng.");
      return;
    }
    checkoutAttemptRef.current = null;
    setStockWarning(null);
    setPendingCheckout(null);
  }, [pendingCheckout]);

  const handleCloseReceipt = useCallback(() => {
    setReceipt(null);
    clearCart();
    setRecreateSource(null);
    setImportedScanGoCart(null);
    setImportedScanGoToken(null);
    setSelectedCustomer(null);
    setRecommendations([]);
    setShowConfirmed(true);
    setTimeout(() => setShowConfirmed(false), 2500);
  }, [clearCart]);

  // ── Computed ──
  const isOffline = !isOnline || offlineSummary.queued > 0 || offlineSummary.needsReview > 0;
  const paymentIntentLocksCart = isPaymentIntentCartLocked(paymentIntent?.status);
  const canUseVisionScan = featureEntitlements.has("vision_pos_input");
  const canRenewPaymentIntent = Boolean(
    paymentIntentDraft
    && paymentIntent
    && ["expired", "cancelled", "manual_review", "failed"].includes(paymentIntent.status),
  );
  const renderCartBeforeFooter = (compact = false) => (importedScanGoCart || crossSell.length > 0 ? (
    <>
      {importedScanGoCart && (
        <div className={[
          "border-status-info-border bg-status-info-bg text-status-info",
          compact ? "border-t px-3 py-2 text-[11px]" : "border-t p-3 text-xs",
        ].join(" ")}>
          <div className="flex items-start gap-2">
            <QrCode size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Stash Dash · kênh bán đã khóa</p>
              <p className={compact ? "mt-0.5 truncate" : "mt-1 leading-5"}>
                Xác minh tuổi/ID trước khi thu tiền. Cart{" "}
                <span className="font-mono">{importedScanGoCart.cartId}</span>
                {importedScanGoCart.customerNickname ? ` · ${importedScanGoCart.customerNickname}` : ""}
              </p>
              {!compact && importedScanGoCart.warnings.length > 0 && (
                <ul className="mt-2 space-y-1 text-status-warning">
                  {importedScanGoCart.warnings.slice(0, 3).map((warning) => (
                    <li key={warning} className="leading-4">• {warning}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
      {crossSell.length > 0 && <CrossSellPanel items={crossSell} onAccept={handleAcceptCrossSell} compact={compact} />}
    </>
  ) : undefined);

  // ── Render ──
  return (
    <div className="flex h-[calc(100dvh-var(--pos-workspace-offset))] min-h-0 flex-col pb-[calc(72px+env(safe-area-inset-bottom))] md:pb-0">
      {/* ── Offline / Queue Banner ── */}
      {appAccess && operatingScope && <PaymentIntentCreationRecoveryPanel scope={{ operatorId: appAccess.operatorId, accessEpoch: appAccess.accessEpoch,
        merchantId: operatingScope.merchantId, storeId: operatingScope.storeId }}
        canClose={Boolean(operatingSnapshot?.permissionIds?.includes(permissions.paymentIntentCreate))}
        activeRequestKey={paymentIntent && intentScopeIsCurrent() ? creationReceiptRef.current?.record?.idempotencyKey : undefined}
        onRecover={handleRecoverPaymentIntent} />}
      {/* Recreate-from-order prefill banner */}
      {recreateSource && (
        <div className="flex items-center gap-2 bg-status-info-bg border-b border-status-info-border px-4 py-2 text-xs text-status-info">
          <ShoppingCart size={14} />
          <span>
            Đang tạo đơn mới từ đơn{" "}
            <span className="font-mono font-medium">{recreateSource.orderNumber}</span>.
            Đơn cũ không bị thay đổi.
          </span>
          <button
            type="button"
            className="ml-auto text-xs font-medium text-action-primary hover:underline"
            onClick={handleKeypadClear}
          >
            Hủy tạo lại
          </button>
        </div>
      )}
      {showQueueReview && (
        <OfflineSalesReview
          sales={queuedSaleRows.filter((sale) => sale.scope?.operatorId === appAccess?.operatorId)}
          onClose={() => setShowQueueReview(false)}
          ready={(sale) => isOnline && runtime.surfaces.checkoutWrite === "enabled"
            && sale.scope?.merchantId === operatingScope?.merchantId
            && sale.scope?.storeId === operatingScope?.storeId}
          onRetry={async (sale) => {
            if (syncInFlight.current) throw new Error("Đang đồng bộ. Vui lòng chờ kết quả rồi thử lại.");
            syncInFlight.current = true;
            try {
            if (!appAccess || !sale.scope || sale.scope.operatorId !== appAccess.operatorId
              || sale.scope.merchantId !== operatingScope?.merchantId || sale.scope.storeId !== operatingScope?.storeId
              || !accessibleScope.merchantIds.includes(sale.scope.merchantId) || !accessibleScope.storeIds.includes(sale.scope.storeId)) {
              throw new Error("Cần đăng nhập người lưu đơn và chọn đúng cửa hàng còn được cấp quyền.");
            }
            if (sale.lastErrorCode === "invalid_shift" && sale.payload.shiftAttribution === "online_open_shift"
              && !window.confirm("Server đã từ chối ghi đơn vào ca hiện tại. Gửi lại đơn theo ca đã lưu và thời điểm lưu offline?")) return;
            const payload = { ...reviewedOfflineShiftPayload(sale) };
            const policyRejected = sale.lastErrorCode === "checkout_policy_refresh_required"
              || sale.lastErrorCode === "checkout_bank_acknowledgment_required";
            if (policyRejected) {
              // Explicit repair is allowed only after an authoritative refusal,
              // never after an uncertain response that may already have committed.
              const policy = await checkoutPolicy.refreshPolicy();
              if (policy.status !== "ready") throw new Error("Chưa đọc được chính sách mới. Đơn vẫn được giữ lại.");
              if (policy.mode === "confirm_on_booking") {
                if (!window.confirm("Bạn xác nhận đã nhận đủ tiền chuyển khoản cho toàn bộ đơn đang chờ này theo chính sách cửa hàng hiện tại?")) return;
                payload.bankTransferSettlementAcknowledgment = { policyVersion: policy.policyVersion, acknowledgmentVersion: policy.acknowledgmentVersion };
              } else {
                if (!policy.manualConfirmationEnabled) throw new Error("Xác nhận chuyển khoản thủ công chưa khả dụng. Liên hệ chủ cửa hàng bật capability trước khi đồng bộ.");
                delete payload.bankTransferSettlementAcknowledgment;
              }
            }
            if (sale.lastErrorCode === "stock_shortage_requires_confirmation") {
              if (!await checkoutPolicy.refreshFoundStockPolicy()) throw new Error("Merchant không cho phép xác nhận tìm thấy hàng. Đơn vẫn được giữ lại.");
              if (!scopeIsCurrent()) throw new Error("Cửa hàng đã thay đổi. Đơn vẫn được giữ lại.");
              const shortages = normalizeStockShortages(sale.lastErrorDetails);
              if (!shortages?.length) throw new Error("Thiếu thông tin tồn kho để xác nhận. Thử đồng bộ lại để nhận cảnh báo mới.");
              if (!window.confirm(`Đã kiểm tra và tìm thấy đủ hàng còn thiếu? ${shortages.map((item) => `${item.productName}: ${item.shortageQuantity}`).join("; ")}`)) return;
              payload.foundStockConfirmation = { confirmed: true, reasonCode: "found_stock", reasonLabel: "Tìm thấy",
                acknowledgedShortages: shortages.map(({ variantId, shortageQuantity }) => ({ variantId, shortageQuantity })) };
            }
            await updateQueuedSale(sale.id, { payload, status: "queued", lastError: undefined,
              // Current access is refreshed only by this explicit, same-operator/scope review.
              scope: { ...sale.scope, accessEpoch: appAccess.accessEpoch, capabilityVersion: `checkoutWrite:${runtime.selected.checkoutWrite}` } });
            await syncOfflineSales(true);
            await refreshOfflineSummary();
            } finally { syncInFlight.current = false; }
          }}
        />
      )}
      {isOffline && (
        <div className="flex items-center gap-2 bg-status-warning-bg border-b border-status-warning-border px-4 py-2 text-xs text-status-warning">
          <WifiOff size={14} />
          {!isOnline && <span>{t("pos.offline")}</span>}
          {offlineSummary.queued > 0 && (
            <span>{offlineSummary.queued} {t("pos.offlineQueued")}</span>
          )}
          {offlineSummary.needsReview > 0 && (
            <span className="text-status-danger font-medium">
              {offlineSummary.needsReview} {t("pos.needsReview")}
              <button type="button" className="ml-2 underline" onClick={() => setShowQueueReview(true)}>Xem và xử lý</button>
            </span>
          )}
        </div>
      )}
      {(currentShift || currentShiftPolicy?.enforceShiftOnPos) && (
        <div className={[
          "flex items-center gap-2 border-b px-4 py-2 text-xs",
          currentShift
            ? "border-status-info-border bg-status-info-bg text-status-info"
            : "border-status-danger-border bg-status-danger-bg text-status-danger",
        ].join(" ")}>
          <Clock3 size={14} />
          {currentShift ? (
            <span>
              Ca {currentShift.zNumber ? `#${currentShift.zNumber}` : currentShift.id} đang mở từ{" "}
              {new Date(currentShift.openedAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}
            </span>
          ) : (
            <span>Chưa mở ca. Thanh toán sẽ bị chặn theo chính sách cửa hàng.</span>
          )}
          {currentShift && currentShiftPolicy?.allowOfflineCachedShift && (
            <span className="ml-auto hidden sm:inline">Offline sẽ dùng mã ca đã lưu</span>
          )}
        </div>
      )}

      {/* ── POS: Product (left) + Cart (right) ── */}
      <div className="flex min-h-0 flex-1">
        {/* ── Product Panel ── */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-border-default">
          {/* Search Bar */}
          <div className={[
            "flex items-center gap-2 border-b border-border-default px-3 py-2 transition-colors duration-300 sm:px-4 sm:py-3",
            searchFlash ? "bg-status-warning-bg" : "",
          ].join(" ")}>
            <Search size={16} className="text-text-muted shrink-0" />
            <input
              ref={searchRef}
              aria-label={t("pos.searchPlaceholder")}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={t("pos.searchPlaceholder")}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            />
            <Button
              size="sm"
              variant={importedScanGoCart ? "primary" : "secondary"}
              icon={<QrCode size={20} aria-hidden="true" />}
              onClick={() => setUnifiedScanOpen(true)}
              disabled={paymentIntentLocksCart}
              title={paymentIntentLocksCart ? "Giỏ đang khóa bởi payment intent" : "Scan QR sản phẩm hoặc QR tổng Stash Dash"}
              aria-label="Scan QR"
              className="h-11 shrink-0 px-3 sm:h-[var(--button-height-sm)]"
            >
              <span className="hidden sm:inline">Scan</span>
            </Button>
            {canUseVisionScan && (
              <Button
                size="sm"
                variant="secondary"
                icon={<Camera size={15} aria-hidden="true" />}
                onClick={() => {
                  setPendingVisionManualFallback(null);
                  setVisionScanOpen(true);
                }}
                disabled={paymentIntentLocksCart}
                title={paymentIntentLocksCart ? "Giỏ đang khóa bởi payment intent" : "Scan ảnh sản phẩm bằng AI"}
              >
                Ảnh
              </Button>
            )}
            {showConfirmed && (
              <span className="text-xs text-status-success font-medium animate-fade-in shrink-0">
                ✓ {t("pos.saleConfirmed")}
              </span>
            )}
          </div>

          {categories.length > 0 && (
            <div className="border-b border-border-default px-3 py-2 sm:px-4">
              <div className="flex gap-2 overflow-x-auto pb-1">
                <Button
                  size="sm"
                  variant={categoryId === "all" ? "primary" : "secondary"}
                  onClick={() => setCategoryId("all")}
                >
                  Tất cả
                </Button>
                {categories.map((category) => (
                  <Button
                    key={category.id}
                    size="sm"
                    variant={categoryId === category.id ? "primary" : "secondary"}
                    onClick={() => setCategoryId(category.id)}
                  >
                    {category.name}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Product Grid / States */}
          <PaginatedListFrame className="min-h-0 flex-1 flex flex-col" bodyClassName="min-h-0 flex-1 overflow-auto"
            label="Phân trang sản phẩm bán hàng" rowNoun="sản phẩm đã tải" meta={productPageMeta}
            onPageChange={setProductPage} busy={isLoading} showPagination={!isLoading && !error && Boolean(products?.length)}>
            {isLoading ? (
              <ProductGridSkeleton />
            ) : error ? (
              <div className="p-4">
                <InlineError
                  message="Không thể tải sản phẩm"
                  onRetry={() => refetch()}
                  stale
                />
              </div>
            ) : (products || []).length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-text-muted">
                <Search size={32} className="mb-3" />
                <p className="text-sm font-medium">
                  {(search || categoryId !== "all") ? t("pos.noSearchResults") : t("pos.noProducts")}
                </p>
                {(search || categoryId !== "all") && (
                  <button
                    onClick={() => {
                      setSearch("");
                      setCategoryId("all");
                    }}
                    className="mt-2 text-xs text-action-primary hover:underline"
                  >
                    {t("pos.clearSearch")}
                  </button>
                )}
              </div>
            ) : (
              <>
                <div
                  className="grid gap-2 p-3 sm:p-4"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, var(--pos-product-card-size)), 1fr))" }}
                >
                  {visibleProducts.map((p) => {
                    const v = p.variants?.[0];
                    if (!v) return null;
                    return (
                      <ProductCard
                        key={p.id}
                        id={p.id}
                        title={p.title}
                        price={v.prices?.[0]?.amount || 0}
                        stockLevel={v.inventory_quantity ?? 0}
                        variantId={v.id}
                        sku={v.sku || ""}
                        imageUrl={p.imageUrl || ""}
                        onSelect={handleSelectProduct}
                      />
                    );
                  })}
                </div>
              </>
            )}
          </PaginatedListFrame>

          {/* ── Compact Quantity Keypad ── */}
          <div className="hidden md:block">
            <QuantityKeypad
              onNumber={handleKeypadNumber}
              onIncrement={handleKeypadIncrement}
              onDelete={handleKeypadDelete}
              onClear={handleKeypadClear}
              selectedItemName={selectedItem?.productName}
            />
          </div>
        </div>

        {/* ── Cart Column ── */}
        <div className="hidden min-h-0 shrink-0 flex-col overflow-hidden border-l border-border-default md:flex" style={{ width: "var(--pos-cart-width)" }}>
          {/* Customer Search */}
          <div className="px-4 py-2 border-b border-border-default">
            <CustomerSearch
              onSelect={setSelectedCustomer}
              onClear={() => setSelectedCustomer(null)}
              selectedPhone={selectedCustomer?.phone}
            />
          </div>

          {/* Cart Panel */}
          <CartPanel
            items={items}
            selectedIndex={selectedIndex}
            subtotal={subtotal}
            itemCount={itemCount}
            adjustment={cartAdjustment}
            paymentFeePreview={paymentFeePreview}
            onAdjustmentChange={setCartAdjustment}
            onUpdateQty={updateQty}
            onRemove={handleRemoveCartItem}
            onSelectItem={selectItem}
            onClear={handleKeypadClear}
            onCheckout={() => items.length > 0 && beginCheckout()}
            onScan={paymentIntentLocksCart ? undefined : () => {
              setShowMobileCart(false);
              setUnifiedScanOpen(true);
            }}
            customerName={selectedCustomer?.name}
            customerLoyalty={selectedCustomer ? { tier: "silver", points: 0 } : undefined}
            saleError={saleError}
            onDismissError={() => setSaleError("")}
            beforeFooter={renderCartBeforeFooter(false)}
          />
        </div>
      </div>

      {/* ── Mobile Cart Bar ── */}
      <div className="fixed left-0 right-0 z-[var(--z-topbar)] border-t border-border-default bg-surface-panel p-2 md:hidden" style={{ bottom: "calc(56px + env(safe-area-inset-bottom))" }}>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            icon={<ShoppingCart size={16} />}
            onClick={() => setShowMobileCart(true)}
          >
            {itemCount} · {cartPayableLabel}
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            disabled={items.length === 0 || Boolean(cartDisplay.discountError) || paymentIntentLocksCart}
            onClick={() => {
              setShowMobileCart(false);
              beginCheckout();
            }}
          >
            {t("pos.checkout")}
          </Button>
        </div>
      </div>

      <Drawer
        open={showMobileCart}
        title={t("pos.cart")}
        subtitle={`${itemCount} mặt hàng · ${cartPayableLabel}`}
        headerActions={paymentIntentLocksCart ? undefined : (
          <Button
            variant="secondary"
            size="sm"
            icon={<QrCode size={18} aria-hidden="true" />}
            aria-label="Scan QR"
            title="Scan QR sản phẩm hoặc QR tổng Stash Dash"
            onClick={() => {
              setShowMobileCart(false);
              setUnifiedScanOpen(true);
            }}
          />
        )}
        onClose={() => setShowMobileCart(false)}
      >
        <div className="-m-4 flex h-[calc(100dvh-88px)] min-h-0 overflow-hidden">
          <CartPanel
            items={items}
            selectedIndex={selectedIndex}
            subtotal={subtotal}
            itemCount={itemCount}
            adjustment={cartAdjustment}
            paymentFeePreview={paymentFeePreview}
            onAdjustmentChange={setCartAdjustment}
            onUpdateQty={updateQty}
            onRemove={handleRemoveCartItem}
            onSelectItem={selectItem}
            onClear={handleKeypadClear}
            onCheckout={() => {
              if (items.length === 0) return;
              setShowMobileCart(false);
              beginCheckout();
            }}
            onScan={paymentIntentLocksCart ? undefined : () => setUnifiedScanOpen(true)}
            customerName={selectedCustomer?.name}
            customerLoyalty={selectedCustomer ? { tier: "silver", points: 0 } : undefined}
            saleError={saleError}
            onDismissError={() => setSaleError("")}
            showHeader={false}
            mobileOptimized
            beforeFooter={renderCartBeforeFooter(true)}
          />
        </div>
      </Drawer>

      {/* ── Modals ── */}
      {showPayment && (
        <PaymentModal
          subtotal={subtotal}
          adjustment={cartAdjustment}
            paymentFeePreview={paymentFeePreview}
          selectedCustomer={selectedCustomer}
          enabledPaymentMethods={checkoutPaymentMethods(paymentProviders, featureEntitlements)}
          onCustomerSelect={setSelectedCustomer}
          onCustomerClear={() => setSelectedCustomer(null)}
          onComplete={handleCompleteSale}
          isSubmitting={completing}
          onClose={() => setShowPayment(false)}
          forcedSalesChannel={importedScanGoCart ? "stash_dash" : undefined}
          salesChannelLocked={Boolean(importedScanGoCart)}
          salesChannelLockReason={importedScanGoCart ? "Cart được khách tự tạo qua QR, giữ Stash Dash để tracking." : undefined}
          bankSettlementPolicy={checkoutPolicy}
          onPolicyRefresh={checkoutPolicy.refreshPolicy}
        />
      )}

      <StaffScanDialog
        open={unifiedScanOpen}
        title="Scan QR"
        autoStartCamera
        cameraFirst
        manualEntry
        inputLabel="QR URL, token Stash Dash, SKU hoặc barcode"
        placeholder="Dán QR URL, token Stash Dash, SKU hoặc barcode..."
        submitLabel="Xử lý mã"
        productSearch={{
          value: scanSearch,
          products: scanSearchProducts,
          isLoading: scanSearchLoading,
          error: Boolean(scanSearchError),
          onChange: setScanSearch,
          onSelectVariant: handleSelectScanSearchProduct,
        }}
        onRawCode={handleUnifiedScanCode}
        onClose={() => {
          setUnifiedScanOpen(false);
          setScanSearch("");
        }}
      />

      <VisionScanDrawer
        open={visionScanOpen}
        onClose={() => setVisionScanOpen(false)}
        onAcceptCandidate={handleVisionCandidateAccepted}
        onManualFallback={(context) => {
          setPendingVisionManualFallback(context || null);
          searchRef.current?.focus();
        }}
        onViewCart={() => {
          setVisionScanOpen(false);
          setShowMobileCart(true);
        }}
      />

      {paymentIntent && intentScopeIsCurrent() && (
        <PaymentIntentDialog
          intent={paymentIntent}
          busy={completing}
          canRenew={canRenewPaymentIntent}
          onClose={handleClosePaymentIntent}
          onChangePaymentMethod={handleChangePaymentMethodFromIntent}
          onRenew={handleRenewPaymentIntent}
          onCancel={handleCancelPaymentIntent}
          onMockSettle={handleMockSettleIntent}
        />
      )}

      {stockWarning && (checkoutPolicy.foundStockEnabled || pendingCheckout?.foundStockConfirmation?.confirmed) && (
        <StockShortageWarningModal
          shortages={stockWarning}
          isSubmitting={completing}
          errorMessage={saleError}
          onConfirm={handleConfirmFoundStock}
          onBack={handleBackFromStockWarning}
        />
      )}

      {stockWarning && !checkoutPolicy.foundStockEnabled && !pendingCheckout?.foundStockConfirmation?.confirmed && (
        <ScreenState state="error" title="Không thể xác nhận tìm thấy hàng" body="Merchant đang tắt chức năng hoặc chưa đọc được cấu hình. Đơn chưa được bán."
          actionLabel="Quay lại giỏ hàng" onAction={handleBackFromStockWarning} />
      )}

      {receipt && (
        <ReceiptModal order={receipt} onClose={handleCloseReceipt} />
      )}

      {/* ── Completing Overlay ── */}
      {completing && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/20">
          <div className="flex flex-col items-center gap-2">
            <Loader2 size={32} className="animate-spin text-action-primary" />
            <span className="text-sm text-text-secondary">Đang xử lý...</span>
          </div>
        </div>
      )}

      {/* ── AI Recommendations ── */}
      {receipt && recommendations.length > 0 && (
        <div className="fixed bottom-24 right-4 z-[var(--z-toast)] w-72 animate-slide-up rounded-xl border border-status-info-border bg-surface-panel p-4 shadow-lg">
          <div className="flex items-center gap-2 mb-2">
            <Gift size={18} className="text-status-info" />
            <span className="text-sm font-semibold text-text-primary">Gợi ý cho khách</span>
          </div>
          <div className="space-y-1">
            {recommendations.map((r, i) => (
              <p key={i} className="flex items-start gap-1.5 text-xs text-text-secondary">
                <Star size={10} className="mt-0.5 shrink-0 text-status-warning" />
                {r}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* ── Tier Upgrade ── */}
      {tierUpgrade && (
        <TierUpgradeNotification
          oldTier={tierUpgrade.oldTier}
          newTier={tierUpgrade.newTier}
          points={tierUpgrade.points}
          onClose={() => setTierUpgrade(null)}
        />
      )}
    </div>
  );
}
