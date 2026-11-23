import { useCallback, useEffect, useMemo, useState } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { AppShell, Button, Sidebar, StatusPill, Topbar } from "@medusa-snus/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NavGroup } from "@medusa-snus/ui";
import { useAuth, AuthProvider } from "./hooks/useAuth";
import {
  Store, ShoppingCart, Package, Truck, Users, ClipboardList,
  Calculator, BarChart3, Bot, FileSearch, MoreHorizontal, Wifi, WifiOff,
  Settings, ShieldCheck, Camera, MessageSquare, UserRound, Clock3,
} from "lucide-react";
import LoginScreen from "./screens/LoginScreen";
import SignupScreen from "./screens/SignupScreen";
import PosScreen from "./screens/PosScreen";
import InventoryScreen from "./screens/InventoryScreen";
import ProductCategoriesScreen from "./screens/ProductCategoriesScreen";
import ProductResearchScreen from "./screens/ProductResearchScreen";
import ProductsScreen from "./screens/ProductsScreen";
import OrderHistoryScreen from "./screens/OrderHistoryScreen";
import CustomersScreen from "./screens/CustomersScreen";
import CustomerDetailScreen from "./screens/CustomerDetailScreen";
import VisionOpsScreen from "./screens/VisionOpsScreen";
import DashboardScreen from "./screens/DashboardScreen";
import PurchaseOrderScreen from "./screens/PurchaseOrderScreen";
import PurchaseOrderDetailScreen from "./screens/PurchaseOrderDetailScreen";
import AuditLogScreen from "./screens/AuditLogScreen";
import { I18nProvider, useI18n } from "./i18n";
import { fetchTelegramSalesDrafts } from "./api/endpoints";
import { endPlatformImpersonation, fetchMe, type MeResponse } from "./api/settings-endpoints";
import { getClientScopeSnapshot, SCOPE_CHANGED_EVENT, setToken } from "./api/client";
import { canAccessVisionOps } from "./utils/visionAccess";
import { shouldInvalidateOnScopeChange } from "./utils/scopeQueryInvalidation";
import { RuntimeCapabilitiesProvider, useRuntimeCapabilities } from "./hooks/useRuntimeCapabilities";
import { buildAppAccessSnapshotV1, canAccessAppRouteV1 } from "./utils/appAccessSnapshot";
import { hiddenModuleDestination, isHiddenPosModulePath, isPosModuleVisible } from "./utils/posModuleVisibility";
// Settings screens
import { SettingsLayout } from "./screens/settings/SettingsLayout";
import SettingsOverviewScreen from "./screens/settings/SettingsOverviewScreen";
import MerchantProfileScreen from "./screens/settings/MerchantProfileScreen";
import { StoreListScreen, StoreProfileScreen } from "./screens/settings/StoresScreen";
import TeamScreen from "./screens/settings/TeamScreen";
import PackageScreen from "./screens/settings/PackageScreen";
import IntegrationsScreen from "./screens/settings/IntegrationsScreen";
import TelegramNotificationsScreen from "./screens/settings/TelegramNotificationsScreen";
import SettingsAuditScreen from "./screens/settings/SettingsAuditScreen";
import RequiredPasswordChangeScreen from "./screens/account/RequiredPasswordChangeScreen";
import AccountLayout from "./screens/account/AccountLayout";
import AccountProfileScreen from "./screens/account/AccountProfileScreen";
import AccountPasswordScreen from "./screens/account/AccountPasswordScreen";
import AccountTelegramScreen from "./screens/account/AccountTelegramScreen";
// Platform admin screens
import { PlatformLayout } from "./screens/platform/PlatformLayout";
import PlatformMerchantsScreen from "./screens/platform/PlatformMerchantsScreen";
import PlatformStoresScreen from "./screens/platform/PlatformStoresScreen";
import PlatformEntityDetailScreen from "./screens/platform/PlatformEntityDetailScreen";
import PlatformBillingScreen from "./screens/platform/PlatformBillingScreen";
import PlatformIntegrationsScreen from "./screens/platform/PlatformIntegrationsScreen";
import PlatformPaymentExceptionsScreen from "./screens/platform/PlatformPaymentExceptionsScreen";
import PlatformSignupIdentityScreen from "./screens/platform/PlatformSignupIdentityScreen";
import PlatformAuditScreen from "./screens/platform/PlatformAuditScreen";
import PlatformOperatorsScreen from "./screens/platform/PlatformOperatorsScreen";

type TranslationKey = Parameters<ReturnType<typeof useI18n>["t"]>[0];

function useCurrentRouteId() {
  const location = useLocation();
  const mapping: Record<string, string> = {
    "/pos": "pos", "/shifts": "shifts", "/products": "products", "/categories": "categories", "/inventory": "inventory", "/purchase-orders": "purchase-orders",
    "/customers": "customers", "/orders": "orders", "/accounting": "accounting",
    "/telegram-sales": "telegramSales", "/ai": "ai", "/vision": "vision", "/dashboard": "dashboard", "/audit": "audit",
    "/partner-operations": "partnerOperations",
    "/settings": "settings", "/settings/merchant": "settings", "/settings/stores": "settings", "/settings/stores/": "settings",
    "/settings/team": "settings", "/settings/package": "settings", "/settings/integrations": "settings",
    "/settings/telegram-notifications": "settings", "/settings/audit": "settings",
    "/account": "account",
    "/platform/merchants": "platform", "/platform/operators": "platform", "/platform/stores": "platform", "/platform/packages-billing": "platform",
    "/platform/integrations": "platform", "/platform/payment-exceptions": "platform",
    "/platform/signup-identity": "platform", "/platform/audit": "platform",
  };
  for (const [path, id] of Object.entries(mapping)) {
    if (location.pathname.startsWith(path)) return id;
  }
  return "pos";
}

const pathMap: Record<string, string> = {
  pos: "/pos", shifts: "/shifts", products: "/products", categories: "/categories", inventory: "/inventory", "purchase-orders": "/purchase-orders",
  customers: "/customers", orders: "/orders", accounting: "/accounting",
  telegramSales: "/telegram-sales", ai: "/ai", vision: "/vision", dashboard: "/dashboard", audit: "/audit", partnerOperations: "/partner-operations",
  settings: "/settings", merchant: "/settings/merchant", stores: "/settings/stores",
  team: "/settings/team", package: "/settings/package", integrations: "/settings/integrations",
  telegramNotifications: "/settings/telegram-notifications", settingsAudit: "/settings/audit",
  account: "/account",
  platform: "/platform/merchants",
};

const routeTitleKey: Record<string, TranslationKey> = {
  pos: "nav.pos",
  shifts: "nav.shifts",
  products: "nav.products",
  categories: "nav.categories",
  inventory: "nav.inventory",
  "purchase-orders": "nav.purchaseOrders",
  customers: "nav.customers",
  orders: "nav.orders",
  telegramSales: "nav.telegramSales",
  accounting: "nav.accounting",
  ai: "nav.ai",
  vision: "nav.vision",
  dashboard: "nav.dashboard",
  audit: "nav.audit",
  settings: "nav.settings",
  account: "nav.account",
  platform: "nav.platform",
};

type StoreScopeOption = MeResponse["stores"][number];

function selectPreferredOperatingStoreId(stores: StoreScopeOption[], merchantId?: string) {
  const scopedStores = merchantId ? stores.filter((store) => store.merchantId === merchantId) : stores;
  const candidates = scopedStores.length ? scopedStores : stores;
  return candidates.find((store) => store.storeId === "store_default")?.storeId
    || candidates.find((store) => store.isPrimary)?.storeId
    || candidates[0]?.storeId
    || "";
}

function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);
  return isOnline;
}

function useLightThemeOnly() {
  useEffect(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
    window.localStorage.removeItem("snus_theme");
  }, []);
}

function ScopeControls() {
  const queryClient = useQueryClient();
  const { operator } = useAuth();
  const { data } = useQuery({
    queryKey: ["me", operator?.id],
    queryFn: fetchMe,
    staleTime: 60_000,
    enabled: !!operator?.id,
  });
  const stores = data?.stores || [];
  const readableStores = useMemo(() => [...new Map([...(data?.stores || []),
    ...(data?.historicalStores || [])].map(store => [store.storeId, store])).values()], [data]);
  const [operatingStoreId, setOperatingStoreId] = useState(() => sessionStorage.getItem("snus_operating_store_id") || "");
  const [reportMerchantId, setReportMerchantId] = useState(() => sessionStorage.getItem("snus_report_merchant_id") || "");
  const [reportStoreIds, setReportStoreIds] = useState<string[]>(() => {
    try {
      const raw = sessionStorage.getItem("snus_report_store_ids");
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const selectedOperatingStore = useMemo(
    () => stores.find((store) => store.storeId === operatingStoreId) || null,
    [operatingStoreId, stores],
  );
  const operatingMerchantId = selectedOperatingStore?.merchantId || "";
  const reportStores = useMemo(
    () => readableStores.filter((store) => store.merchantId === reportMerchantId),
    [readableStores, reportMerchantId],
  );

  useEffect(() => {
    if (!data) return;
    const storeIds = stores.map((store) => store.storeId);
    setOperatingStoreId((current) => (
      storeIds.includes(current)
        ? current
        : selectPreferredOperatingStoreId(stores, data?.merchant?.merchantId)
    ));
  }, [data?.merchant?.merchantId, stores]);

  useEffect(() => {
    if (!data) return;
    setReportMerchantId(current => readableStores.some(store => store.merchantId === current)
      ? current : operatingMerchantId || readableStores[0]?.merchantId || "");
  }, [data, operatingMerchantId, readableStores]);

  useEffect(() => {
    if (operatingMerchantId) setReportMerchantId(operatingMerchantId);
  }, [operatingMerchantId]);

  useEffect(() => {
    if (!data) return;
    const storeIds = reportStores.map((store) => store.storeId);
    setReportStoreIds((current) => {
      const scoped = current.filter((id) => storeIds.includes(id));
      const next = scoped.length ? scoped : storeIds;
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [data, reportStores]);

  const invalidateScopedQueries = useCallback(() => {
    void queryClient.invalidateQueries({
      predicate: (query) => shouldInvalidateOnScopeChange(query.queryKey),
    });
  }, [queryClient]);

  useEffect(() => {
    if (!data) return;
    if (operatingStoreId) sessionStorage.setItem("snus_operating_store_id", operatingStoreId);
    else sessionStorage.removeItem("snus_operating_store_id");
    if (operatingMerchantId) {
      sessionStorage.setItem("snus_operating_merchant_id", operatingMerchantId);
    } else sessionStorage.removeItem("snus_operating_merchant_id");
    window.dispatchEvent(new CustomEvent(SCOPE_CHANGED_EVENT));
    invalidateScopedQueries();
  }, [data, invalidateScopedQueries, operatingMerchantId, operatingStoreId]);

  useEffect(() => {
    if (!data) return;
    if (reportMerchantId) sessionStorage.setItem("snus_report_merchant_id", reportMerchantId);
    else sessionStorage.removeItem("snus_report_merchant_id");
    sessionStorage.setItem("snus_report_store_ids", JSON.stringify(reportStoreIds));
    window.dispatchEvent(new CustomEvent(SCOPE_CHANGED_EVENT));
    invalidateScopedQueries();
  }, [data, invalidateScopedQueries, reportMerchantId, reportStoreIds]);

  if (stores.length <= 1 && !data?.historicalStores?.length) return null;

  return (
    <div className="scope-controls" aria-label="Phạm vi thao tác và báo cáo">
      {stores.length ? <label className="scope-control scope-control--operating">
        <span>Store thao tác</span>
        <select
          value={operatingStoreId}
          onChange={(event) => setOperatingStoreId(event.target.value)}
          aria-label="Chọn cửa hàng thao tác cho mutation POS"
        >
          {stores.map((store) => (
            <option key={store.storeId} value={store.storeId}>
              {store.merchantDisplayName ? `${store.merchantDisplayName} · ${store.displayName}` : store.displayName}
            </option>
          ))}
        </select>
      </label> : <span>Chỉ xem lịch sử</span>}
      <details className="scope-control scope-control--report">
        <summary>Báo cáo: {reportStoreIds.length}/{reportStores.length}</summary>
        <div className="scope-report-options">
          <label>Merchant báo cáo
            <select value={reportMerchantId} onChange={event => setReportMerchantId(event.target.value)}>
              {[...new Map(readableStores.map(store => [store.merchantId, store.merchantDisplayName || store.merchantId])).entries()]
                .map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          {reportStores.map((store) => (
            <label key={store.storeId}>
              <input
                type="checkbox"
                checked={reportStoreIds.includes(store.storeId)}
                onChange={(event) => {
                  setReportStoreIds((current) => event.target.checked
                    ? Array.from(new Set([...current, store.storeId]))
                    : current.filter((id) => id !== store.storeId));
                }}
              />
              <span>{store.displayName}</span>
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}

/* ── Mobile Bottom Tab Bar ── */
function BottomTabs({ activeId, onSelect, historyOnly = false }: { activeId: string; onSelect: (id: string) => void; historyOnly?: boolean }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const tabs = [
    { id: "pos", icon: ShoppingCart, label: "Quầy" },
    { id: "inventory", icon: Package, label: "Kho" },
    { id: "customers", icon: Users, label: "KH" },
    { id: "accounting", icon: Calculator, label: "TC" },
  ].filter((item) => isPosModuleVisible(item.id) && !historyOnly);
  const moreItems = [
    { id: "shifts", icon: Clock3, label: "Ca làm" },
    { id: "products", icon: Package, label: "Sản phẩm" },
    { id: "categories", icon: ClipboardList, label: "Danh mục" },
    { id: "purchase-orders", icon: Truck, label: "Đặt hàng" },
    { id: "orders", icon: ClipboardList, label: "Đơn hàng" },
    { id: "telegramSales", icon: MessageSquare, label: "Telegram" },
    { id: "dashboard", icon: BarChart3, label: "Tổng quan" },
    { id: "ai", icon: Bot, label: "AI Review" },
    { id: "audit", icon: FileSearch, label: "Lịch sử" },
    { id: "account", icon: UserRound, label: "Tài khoản" },
  ].filter((item) => isPosModuleVisible(item.id) && (!historyOnly || ["orders", "dashboard", "account"].includes(item.id)));
  const moreActive = moreItems.some((item) => item.id === activeId);

  return (
    <>
      {moreOpen && (
        <div className="snus-mobile-more" role="menu" aria-label="Điều hướng khác">
          {moreItems.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`snus-mobile-more-item${activeId === item.id ? " snus-mobile-more-item--active" : ""}`}
              onClick={() => {
                setMoreOpen(false);
                onSelect(item.id);
              }}
            >
              <item.icon size={16} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="snus-bottom-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`snus-bottom-tab${activeId === tab.id ? " snus-bottom-tab--active" : ""}`}
            onClick={() => {
              setMoreOpen(false);
              onSelect(tab.id);
            }}
            aria-label={tab.label}
          >
            <tab.icon size={20} />
            <span>{tab.label}</span>
          </button>
        ))}
        <button
          type="button"
          className={`snus-bottom-tab${moreActive || moreOpen ? " snus-bottom-tab--active" : ""}`}
          onClick={() => setMoreOpen((current) => !current)}
          aria-label="Mở thêm điều hướng"
          aria-expanded={moreOpen}
        >
          <MoreHorizontal size={20} />
          <span>Thêm</span>
        </button>
      </div>
    </>
  );
}

/* ── Main App Shell ── */
function AppShellShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const activeId = useCurrentRouteId();
  const { operator, logout } = useAuth();
  const { locale, setLocale, t } = useI18n();
  const isOnline = useOnlineStatus();
  const canManageTeam = operator?.role === "owner" || operator?.role === "manager";
  const { data: currentAccess, isPending: currentAccessPending } = useQuery({
    queryKey: ["me", operator?.id],
    queryFn: fetchMe,
    staleTime: 60_000,
    enabled: !!operator?.id,
  });
  const runtime = useRuntimeCapabilities();
  const reportScope = getClientScopeSnapshot();
  const appAccess = currentAccess ? buildAppAccessSnapshotV1(currentAccess, {
    merchantId: reportScope.reportMerchantId || reportScope.operatingMerchantId,
    storeIds: reportScope.reportStoreIds.length
      ? reportScope.reportStoreIds
      : [reportScope.operatingStoreId].filter(Boolean),
    capabilities: runtime.selected,
  }) : null;
  const routeAllowed = (path: string) => Boolean(appAccess && canAccessAppRouteV1(appAccess, path));
  const historyOnly = !currentAccess?.stores.length && Boolean(currentAccess?.historicalStores?.length);
  const historyPathAllowed = ["/orders", "/dashboard", "/account", "/platform"].some(prefix =>
    location.pathname === prefix || location.pathname.startsWith(`${prefix}/`));
  const canReadPartnerOperations = Boolean(currentAccess?.permissionIds?.includes("partner:logs_read"));
  const { data: telegramSalesPending } = useQuery({
    queryKey: ["telegramSalesDrafts", "nav", "pending"],
    queryFn: () => fetchTelegramSalesDrafts({ status: "pending", limit: 1 }),
    enabled: !!operator?.id && isPosModuleVisible("telegramSales"),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
  const hasPlatformGrant = Boolean(currentAccess?.isPlatformAdmin || operator?.role === "platform_admin" || operator?.role === "admin" || operator?.role === "platform");
  const hiddenDestination = hiddenModuleDestination({
    canUsePos: Boolean(currentAccess?.stores.length) && runtime.surfaces.checkoutWrite === "enabled",
    canReadOrders: routeAllowed("/orders"),
    canReadDashboard: routeAllowed("/dashboard"),
    canReadPlatform: Boolean(currentAccess?.permissionIds?.includes("platform:read")),
  });
  const canShowVisionOps = canAccessVisionOps({
    featureEntitlements: currentAccess?.featureEntitlements,
    permissionIds: currentAccess?.permissionIds,
  });
  const telegramSalesPendingCount = Number(telegramSalesPending?.count || 0);
  const telegramSalesBadge = telegramSalesPendingCount > 0
    ? telegramSalesPendingCount > 99 ? "99+" : telegramSalesPendingCount
    : undefined;
  const impersonation = currentAccess?.impersonation;
  const currentDisplayName = currentAccess?.displayName || operator?.displayName || operator?.id || "Operator";

  useEffect(() => {
    const content = document.querySelector<HTMLElement>(".snus-content");
    content?.scrollTo({ top: 0, left: 0 });
  }, [location.pathname, location.search]);

  async function endImpersonation() {
    await endPlatformImpersonation({ sessionId: impersonation?.sessionId, reason: "ended_by_operator" });
    const adminToken = sessionStorage.getItem("snus_admin_token_during_impersonation");
    sessionStorage.removeItem("snus_admin_token_during_impersonation");
    if (adminToken) setToken(adminToken);
    await queryClient.invalidateQueries({ queryKey: ["me"] });
    navigate("/platform/operators");
  }

  const navGroups = useMemo<NavGroup[]>(() => [
    {
      label: "Quầy",
      items: [
        { id: "pos", label: t("nav.pos"), icon: ShoppingCart },
        { id: "shifts", label: t("nav.shifts"), icon: Clock3 },
        { id: "telegramSales", label: t("nav.telegramSales"), icon: MessageSquare, badge: telegramSalesBadge },
      ],
    },
    {
      label: "Kho",
      items: [
        { id: "products", label: t("nav.products"), icon: Package },
        { id: "categories", label: t("nav.categories"), icon: ClipboardList },
        { id: "inventory", label: t("nav.inventory"), icon: Package },
        { id: "purchase-orders", label: t("nav.purchaseOrders"), icon: Truck },
      ],
    },
    {
      label: "Khách hàng",
      items: [
        ...(routeAllowed("/customers") ? [{ id: "customers", label: t("nav.customers"), icon: Users }] : []),
        ...(routeAllowed("/orders") ? [{ id: "orders", label: t("nav.orders"), icon: ClipboardList }] : []),
      ],
    },
    {
      label: "Tài chính",
      items: [
        ...(routeAllowed("/accounting") ? [{ id: "accounting", label: t("nav.accounting"), icon: Calculator }] : []),
        ...(routeAllowed("/dashboard") ? [{ id: "dashboard", label: t("nav.dashboard"), icon: BarChart3 }] : []),
      ],
    },
    {
      label: "Kiểm soát",
      items: [
        ...(canShowVisionOps ? [{ id: "vision", label: t("nav.vision"), icon: Camera }] : []),
        { id: "ai", label: t("nav.ai"), icon: Bot },
        { id: "audit", label: t("nav.audit"), icon: FileSearch },
        ...(canReadPartnerOperations ? [{ id: "partnerOperations", label: "Vận hành đối tác", icon: BarChart3 }] : []),
      ],
    },
    {
      label: "Hệ thống",
      items: [
        { id: "account", label: t("nav.account"), icon: UserRound },
        { id: "settings", label: t("nav.settings"), icon: Settings },
        ...(hasPlatformGrant ? [{ id: "platform", label: t("nav.platform"), icon: ShieldCheck }] : []),
      ],
    },
  ].map((group) => ({ ...group, items: group.items.filter((item) => isPosModuleVisible(item.id)
    && (!historyOnly || ["orders", "dashboard", "account", "platform"].includes(item.id))) }))
    .filter((group) => group.items.length > 0),
  [appAccess?.accessEpoch, canShowVisionOps, canReadPartnerOperations, hasPlatformGrant, historyOnly, t, telegramSalesBadge]);

  return (
    <AppShell
      topbar={
        <Topbar
          title={activeId === "partnerOperations" ? "Vận hành đối tác" : t(routeTitleKey[activeId] || "nav.pos")}
          statusIndicators={
            <>
              <StatusPill
                tone={isOnline ? "success" : "warning"}
                label={isOnline ? "Online" : "Offline"}
                icon={isOnline ? <Wifi size={12} /> : <WifiOff size={12} />}
              />
              <ScopeControls />
              <StatusPill tone="info" label={currentDisplayName} />
            </>
          }
          actions={
            <>
              {(["vi", "en"] as const).map((item) => (
                <Button
                  key={item}
                  variant={locale === item ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => setLocale(item)}
                >
                  {item.toUpperCase()}
                </Button>
              ))}
              <Button variant="secondary" size="sm" onClick={() => navigate("/account")}>
                Tài khoản
              </Button>
              <Button variant="ghost" size="sm" onClick={logout}>
                {t("auth.logout")}
              </Button>
            </>
          }
        />
      }
      sidebar={
        <Sidebar
          brand={{ label: "Snus Ops", icon: Store }}
          groups={navGroups}
          activeId={activeId}
          onSelect={(id) => navigate(pathMap[id] || "/pos")}
          footer={
            <div className="space-y-2 text-xs text-text-muted">
              <div className="font-medium text-text-secondary">
                {currentDisplayName}
              </div>
              <div className="flex gap-1.5">
                {(["vi", "en"] as const).map((item) => (
                  <button
                    key={item}
                    onClick={() => setLocale(item)}
                    className={[
                      "border rounded px-1.5 py-0.5 text-[11px] cursor-pointer transition-colors",
                      locale === item
                        ? "border-action-primary bg-surface-selected text-action-primary"
                        : "border-border-default text-text-muted hover:bg-surface-hover",
                    ].join(" ")}
                  >
                    {item.toUpperCase()}
                  </button>
                ))}
              </div>
              <button
                onClick={logout}
                className="text-text-muted hover:text-status-danger text-[11px] transition-colors bg-transparent border-0 p-0 cursor-pointer"
              >
                {t("auth.logout")}
              </button>
            </div>
          }
        />
      }
    >
      {impersonation ? (
        <div className="sticky top-0 z-[var(--z-sticky)] flex min-h-11 flex-wrap items-center justify-between gap-2 border border-status-warning-border bg-status-warning-bg px-4 py-2 text-sm text-status-warning">
          <div className="min-w-0">
            <span className="font-semibold">PHIÊN HỖ TRỢ CHỈ XEM</span>
            <span className="ml-2">Đang xem như {impersonation.effectiveOperatorId}. Người bắt đầu: {impersonation.actualOperatorId}.</span>
          </div>
          <Button variant="secondary" size="sm" onClick={endImpersonation}>Kết thúc</Button>
        </div>
      ) : null}
      {location.state?.hiddenModuleNotice ? (
        <div role="status" className="border-b border-border-default px-4 py-2 text-sm text-text-secondary">
          Mục này hiện đang được ẩn. Bạn đã được chuyển đến trang có quyền truy cập.
        </div>
      ) : null}
      {historyOnly ? <div role="status" className="border-b border-border-default px-4 py-2 text-sm text-text-secondary">
        Chỉ xem lịch sử. Merchant hoặc cửa hàng hiện đang tạm ngưng giao dịch.
      </div> : null}
      {currentAccessPending ? <div className="p-6 text-sm text-text-muted">Đang tải quyền truy cập...</div>
        : isHiddenPosModulePath(location.pathname) || (historyOnly && !historyPathAllowed) ? (
        <Navigate to={hiddenDestination} replace state={{ hiddenModuleNotice: true }} />
      ) : <Routes>
        <Route path="/" element={<Navigate to="/pos" replace />} />
        <Route path="/pos" element={<PosScreen />} />
        <Route path="/products" element={<ProductsScreen />} />
        <Route path="/products/:id/research" element={<ProductResearchScreen />} />
        <Route path="/categories" element={<ProductCategoriesScreen />} />
        <Route path="/inventory" element={<InventoryScreen />} />
        <Route path="/purchase-orders" element={<PurchaseOrderScreen />} />
        <Route path="/purchase-orders/:id" element={<PurchaseOrderDetailScreen />} />
        <Route path="/orders" element={currentAccessPending ? <div className="p-6 text-sm text-text-muted">Đang tải quyền truy cập...</div> : routeAllowed("/orders") ? <OrderHistoryScreen /> : <Navigate to="/pos" replace />} />
        <Route path="/customers" element={currentAccessPending ? <div className="p-6 text-sm text-text-muted">Đang tải quyền truy cập...</div> : routeAllowed("/customers") ? <CustomersScreen /> : <Navigate to="/pos" replace />} />
        <Route path="/customers/:id" element={currentAccessPending ? <div className="p-6 text-sm text-text-muted">Đang tải quyền truy cập...</div> : routeAllowed("/customers") ? <CustomerDetailScreen /> : <Navigate to="/pos" replace />} />
        <Route path="/vision" element={
          currentAccessPending
            ? <div className="p-6 text-sm text-text-muted">Đang tải quyền truy cập...</div>
            : canShowVisionOps
              ? <VisionOpsScreen />
              : <Navigate to="/pos" replace />
        } />
        <Route path="/dashboard" element={currentAccessPending ? <div className="p-6 text-sm text-text-muted">Đang tải quyền truy cập...</div> : routeAllowed("/dashboard") ? <DashboardScreen /> : <Navigate to="/pos" replace />} />
        <Route path="/audit" element={<AuditLogScreen />} />

        <Route path="/account" element={
          <AccountLayout>
            <AccountProfileScreen />
          </AccountLayout>
        } />
        <Route path="/account/password" element={
          <AccountLayout>
            <AccountPasswordScreen />
          </AccountLayout>
        } />
        <Route path="/account/telegram" element={
          <AccountLayout>
            <AccountTelegramScreen />
          </AccountLayout>
        } />

        {/* ── Settings ── */}
        <Route path="/settings" element={
          <SettingsLayout isOwner={operator?.role === "owner"} canManageTeam={canManageTeam}>
            <SettingsOverviewScreen />
          </SettingsLayout>
        } />
        <Route path="/settings/merchant" element={
          <SettingsLayout isOwner={operator?.role === "owner"} canManageTeam={canManageTeam}>
            <MerchantProfileScreen />
          </SettingsLayout>
        } />
        <Route path="/settings/stores" element={
          <SettingsLayout isOwner={operator?.role === "owner"} canManageTeam={canManageTeam}>
            <StoreListScreen />
          </SettingsLayout>
        } />
        <Route path="/settings/stores/:storeId" element={
          <SettingsLayout isOwner={operator?.role === "owner"} canManageTeam={canManageTeam}>
            <StoreProfileScreen />
          </SettingsLayout>
        } />
        <Route path="/settings/team" element={
          <SettingsLayout isOwner={operator?.role === "owner"} canManageTeam={canManageTeam}>
            <TeamScreen />
          </SettingsLayout>
        } />
        <Route path="/settings/package" element={
          <SettingsLayout isOwner={operator?.role === "owner"} canManageTeam={canManageTeam}>
            <PackageScreen />
          </SettingsLayout>
        } />
        <Route path="/settings/integrations" element={
          <SettingsLayout isOwner={operator?.role === "owner"} canManageTeam={canManageTeam}>
            <IntegrationsScreen />
          </SettingsLayout>
        } />
        <Route path="/settings/telegram-notifications" element={
          <SettingsLayout isOwner={operator?.role === "owner"} canManageTeam={canManageTeam}>
            <TelegramNotificationsScreen />
          </SettingsLayout>
        } />
        <Route path="/settings/audit" element={
          <SettingsLayout isOwner={operator?.role === "owner"} canManageTeam={canManageTeam}>
            <SettingsAuditScreen />
          </SettingsLayout>
        } />

        {/* ── Platform Admin ── */}
        <Route path="/platform/merchants/:merchantId" element={<PlatformLayout><PlatformEntityDetailScreen kind="merchant"/></PlatformLayout>}/>
        <Route path="/platform/stores/:storeId" element={<PlatformLayout><PlatformEntityDetailScreen kind="store"/></PlatformLayout>}/>
        <Route path="/platform/merchants" element={
          <PlatformLayout>
            <PlatformMerchantsScreen />
          </PlatformLayout>
        } />
        <Route path="/platform/operators" element={
          <PlatformLayout>
            <PlatformOperatorsScreen />
          </PlatformLayout>
        } />
        <Route path="/platform/stores" element={
          <PlatformLayout>
            <PlatformStoresScreen />
          </PlatformLayout>
        } />
        <Route path="/platform/packages-billing" element={
          <PlatformLayout>
            <PlatformBillingScreen />
          </PlatformLayout>
        } />
        <Route path="/platform/integrations" element={
          <PlatformLayout>
            <PlatformIntegrationsScreen />
          </PlatformLayout>
        } />
        <Route path="/platform/payment-exceptions" element={
          <PlatformLayout>
            <PlatformPaymentExceptionsScreen />
          </PlatformLayout>
        } />
        <Route path="/platform/signup-identity" element={
          <PlatformLayout>
            <PlatformSignupIdentityScreen />
          </PlatformLayout>
        } />
        <Route path="/platform/audit" element={
          <PlatformLayout>
            <PlatformAuditScreen />
          </PlatformLayout>
        } />
      </Routes>}
      <BottomTabs activeId={activeId} historyOnly={historyOnly} onSelect={(id) => navigate(pathMap[id] || "/pos")} />
    </AppShell>
  );
}

function AuthenticatedLoginRedirect() {
  const [target] = useState(() => {
    const returnTo = sessionStorage.getItem("snus_return_to");
    return returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/pos";
  });

  useEffect(() => {
    if (target !== "/pos") sessionStorage.removeItem("snus_return_to");
  }, [target]);

  return <Navigate to={target} replace />;
}

function AppRoutes() {
  const { isAuthenticated, requiresPasswordChange, sessionExpired, acknowledgeSessionExpired } = useAuth();
  const location = useLocation();
  useLightThemeOnly();
  if (location.pathname.startsWith("/signup")) return <SignupScreen />;
  if (isAuthenticated && requiresPasswordChange) {
    if (location.pathname !== "/account/required-password-change") {
      return <Navigate to="/account/required-password-change" replace />;
    }
    return <RequiredPasswordChangeScreen />;
  }
  if (isAuthenticated && location.pathname === "/login") return <AuthenticatedLoginRedirect />;
  if (!isAuthenticated) return (
    <>
      <LoginScreen />
      {sessionExpired && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40 p-4" role="alertdialog" aria-modal="true" aria-labelledby="session-expired-title">
          <div className="w-full max-w-sm rounded-lg bg-surface-panel p-5 shadow-lg">
            <h2 id="session-expired-title" className="text-base font-semibold text-text-primary">Phiên đăng nhập đã hết hạn</h2>
            <p className="mt-2 text-sm leading-6 text-text-secondary">Để bảo vệ dữ liệu, bạn cần đăng nhập lại để tiếp tục.</p>
            <Button className="mt-4 w-full" variant="primary" onClick={acknowledgeSessionExpired}>Đăng nhập lại</Button>
          </div>
        </div>
      )}
    </>
  );
  return <AppShellShell />;
}

export default function App() {
  return (
    <I18nProvider>
      <RuntimeCapabilitiesProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </RuntimeCapabilitiesProvider>
    </I18nProvider>
  );
}
