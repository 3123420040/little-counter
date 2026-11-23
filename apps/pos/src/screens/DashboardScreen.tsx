import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Button,
  FilterBar,
  InlineError,
  MetricCell,
  PageHeader,
  Panel,
  ResponsiveMetricGrid,
  ScreenState,
  StatusPill,
} from "@medusa-snus/ui";
import { fetchAiReviewQueue, fetchDashboard, fetchInventory, fetchPartialFinancialFeatureDashboard, type DashboardSummary } from "../api/endpoints";
import { ApiError, getClientScopeSnapshot } from "../api/client";
import { AlertTriangle, Bot, DollarSign, Package, ShoppingCart, TrendingUp, Users } from "lucide-react";
import { useI18n } from "../i18n";
import { ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1 } from "../config/orderFinancialFeature";
import { createPartialFinancialDashboardUiTaskV1 } from "../utils/orderFinancialFeatureUiIntegration";
import { buildDashboardOverviewPresentationV1 } from "../utils/dashboardOverviewPresentation";
import { DashboardOverviewSurface } from "../components/DashboardOverviewSurface";
import { CreatorSalesDashboardSurface } from "../components/CreatorSalesDashboardSurface";
import { useAppAccessSnapshot } from "../hooks/useAppAccessSnapshot";
import { useCreatorSalesDashboard } from "../hooks/useCreatorSalesDashboard";
import { buildPartitionedQueryKeyV1 } from "../utils/appAccessSnapshot";

function toIsoDate(date: Date) {
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

function formatMoney(value: number | null | undefined) {
  return `${Number(value || 0).toLocaleString("vi-VN")} ₫`;
}

function formatShortDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
}

function paymentLabel(method: string) {
  if (method === "cash") return "Tiền mặt";
  if (method === "bank") return "Chuyển khoản";
  if (method === "cod") return "COD";
  return method || "Khác";
}

function MetricSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-busy="true">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="h-[68px] rounded-lg bg-surface-subtle animate-pulse"
          style={{ animationDelay: `${i * 80}ms` }}
        />
      ))}
    </div>
  );
}

function RevenueOrdersChart({ data }: { data: DashboardSummary["daily"] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const safeData = data.length ? data : [{ date: toIsoDate(new Date()), revenue: 0, orders: 0 }];
  const width = 720;
  const height = 240;
  const padX = 44;
  const padTop = 20;
  const padBottom = 44;
  const chartWidth = width - padX * 2;
  const chartHeight = height - padTop - padBottom;
  const maxRevenue = Math.max(1, ...safeData.map((item) => item.revenue));
  const maxOrders = Math.max(1, ...safeData.map((item) => item.orders));
  const slot = chartWidth / safeData.length;
  const barWidth = Math.max(8, Math.min(36, slot * 0.52));
  const points = safeData.map((item, index) => {
    const x = padX + slot * index + slot / 2;
    const y = padTop + chartHeight - (item.orders / maxOrders) * chartHeight;
    return `${x},${y}`;
  }).join(" ");
  const hovered = hoveredIndex === null ? null : safeData[hoveredIndex] || null;
  const hoveredX = hoveredIndex === null ? 0 : padX + slot * hoveredIndex + slot / 2;
  const tooltipWidth = 174;
  const tooltipHeight = 68;
  const tooltipX = Math.max(8, Math.min(width - tooltipWidth - 8, hoveredX - tooltipWidth / 2));
  const tooltipY = 28;
  function updateHoverFromPointer(event: ReactMouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (width / rect.width);
    const y = (event.clientY - rect.top) * (height / rect.height);
    if (x < padX || x > width - padX || y < padTop || y > padTop + chartHeight + 28) {
      setHoveredIndex(null);
      return;
    }
    const index = Math.max(0, Math.min(safeData.length - 1, Math.floor((x - padX) / slot)));
    setHoveredIndex(index);
  }

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="min-w-[640px] text-text-muted"
        role="img"
        aria-label="Revenue and order trend"
        onMouseMove={updateHoverFromPointer}
        onMouseLeave={() => setHoveredIndex(null)}
      >
        <line x1={padX} y1={padTop + chartHeight} x2={width - padX} y2={padTop + chartHeight} stroke="currentColor" opacity="0.22" />
        <line x1={padX} y1={padTop} x2={padX} y2={padTop + chartHeight} stroke="currentColor" opacity="0.16" />
        {safeData.map((item, index) => {
          const x = padX + slot * index + slot / 2;
          const barHeight = (item.revenue / maxRevenue) * chartHeight;
          return (
            <g
              key={item.date}
              tabIndex={0}
              role="img"
              aria-label={`${formatShortDate(item.date)}: ${item.orders} đơn, doanh thu ${formatMoney(item.revenue)}`}
              onMouseEnter={() => setHoveredIndex(index)}
              onFocus={() => setHoveredIndex(index)}
              onBlur={() => setHoveredIndex(null)}
            >
              <title>{`${formatShortDate(item.date)} · ${item.orders} đơn · ${formatMoney(item.revenue)}`}</title>
              <rect
                x={padX + slot * index}
                y={padTop}
                width={slot}
                height={chartHeight + 26}
                fill="transparent"
              />
              <rect
                x={x - barWidth / 2}
                y={padTop + chartHeight - barHeight}
                width={barWidth}
                height={Math.max(2, barHeight)}
                rx="3"
                fill="rgb(15 118 110)"
                opacity={hoveredIndex === index ? "1" : "0.82"}
              />
              {(safeData.length <= 10 || index % Math.ceil(safeData.length / 8) === 0) && (
                <text x={x} y={height - 18} textAnchor="middle" fontSize="11" fill="currentColor">
                  {formatShortDate(item.date)}
                </text>
              )}
            </g>
          );
        })}
        <polyline points={points} fill="none" stroke="rgb(194 65 12)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        {safeData.map((item, index) => {
          const x = padX + slot * index + slot / 2;
          const y = padTop + chartHeight - (item.orders / maxOrders) * chartHeight;
          return (
            <circle
              key={`${item.date}-orders`}
              cx={x}
              cy={y}
              r={hoveredIndex === index ? "5" : "3.5"}
              fill="rgb(194 65 12)"
              onMouseEnter={() => setHoveredIndex(index)}
              onFocus={() => setHoveredIndex(index)}
              onBlur={() => setHoveredIndex(null)}
            />
          );
        })}
        {hovered && (
          <g pointerEvents="none">
            <line
              x1={hoveredX}
              y1={padTop}
              x2={hoveredX}
              y2={padTop + chartHeight}
              stroke="rgb(15 118 110)"
              strokeDasharray="4 4"
              opacity="0.5"
            />
            <rect
              x={tooltipX}
              y={tooltipY}
              width={tooltipWidth}
              height={tooltipHeight}
              rx="8"
              fill="white"
              stroke="rgb(214 211 209)"
            />
            <text x={tooltipX + 12} y={tooltipY + 20} fontSize="12" fontWeight="700" fill="rgb(28 25 23)">
              {formatShortDate(hovered.date)}
            </text>
            <text x={tooltipX + 12} y={tooltipY + 40} fontSize="11" fill="rgb(87 83 78)">
              {`Đơn: ${hovered.orders.toLocaleString("vi-VN")}`}
            </text>
            <text x={tooltipX + 12} y={tooltipY + 57} fontSize="11" fill="rgb(87 83 78)">
              {`Doanh thu: ${formatMoney(hovered.revenue)}`}
            </text>
          </g>
        )}
        <text x={padX} y="12" fontSize="11" fill="currentColor">Revenue</text>
        <text x={width - padX} y="12" textAnchor="end" fontSize="11" fill="currentColor">Orders</text>
      </svg>
      <div className="mt-2 flex flex-wrap gap-3 px-1 text-xs text-text-muted">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-4 rounded-sm bg-action-primary" /> Doanh thu</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-4 rounded-sm bg-status-warning" /> Tổng đơn</span>
      </div>
    </div>
  );
}

type CanonicalDailySeriesPoint = {
  localDate: string;
  activeOrderCount: number;
  currentOrderGrossValueMinor: number;
  recordedGrossCollectionsMinor: number;
};

function CanonicalDailySeriesChart({
  currencyCode,
  minorUnitExponent,
  data,
}: {
  currencyCode: string;
  minorUnitExponent: number;
  data: CanonicalDailySeriesPoint[];
}) {
  const width = 760;
  const height = 260;
  const padX = 48;
  const padTop = 24;
  const padBottom = 50;
  const chartWidth = width - (padX * 2);
  const chartHeight = height - padTop - padBottom;
  const slot = chartWidth / data.length;
  const barWidth = Math.max(2, Math.min(18, slot * 0.3));
  const maxMoneyMinor = Math.max(
    1,
    ...data.flatMap((point) => [
      point.currentOrderGrossValueMinor,
      point.recordedGrossCollectionsMinor,
    ]),
  );
  const maxActiveOrders = Math.max(1, ...data.map((point) => point.activeOrderCount));
  const divisor = 10 ** minorUnitExponent;
  const money = (minor: number) => (
    `${(minor / divisor).toLocaleString("vi-VN")} ${currencyCode}`
  );
  const orderPoints = data.map((point, index) => {
    const x = padX + (slot * index) + (slot / 2);
    const y = padTop + chartHeight
      - ((point.activeOrderCount / maxActiveOrders) * chartHeight);
    return `${x},${y}`;
  }).join(" ");

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="min-w-[680px] text-text-muted"
        role="img"
        aria-label={`Diễn biến canonical theo ngày cho ${currencyCode}`}
      >
        <line
          x1={padX}
          y1={padTop + chartHeight}
          x2={width - padX}
          y2={padTop + chartHeight}
          stroke="currentColor"
          opacity="0.22"
        />
        {data.map((point, index) => {
          const x = padX + (slot * index) + (slot / 2);
          const currentHeight = (
            point.currentOrderGrossValueMinor / maxMoneyMinor
          ) * chartHeight;
          const collectionHeight = (
            point.recordedGrossCollectionsMinor / maxMoneyMinor
          ) * chartHeight;
          return (
            <g
              key={point.localDate}
              tabIndex={0}
              role="img"
              aria-label={[
                formatShortDate(point.localDate),
                `${point.activeOrderCount.toLocaleString("vi-VN")} đơn hiệu lực`,
                `giá trị đơn ${money(point.currentOrderGrossValueMinor)}`,
                `tiền thu ${money(point.recordedGrossCollectionsMinor)}`,
              ].join(", ")}
            >
              <title>
                {`${formatShortDate(point.localDate)} · ${point.activeOrderCount.toLocaleString("vi-VN")} đơn · ${money(point.currentOrderGrossValueMinor)} giá trị đơn · ${money(point.recordedGrossCollectionsMinor)} đã thu`}
              </title>
              <rect
                x={x - barWidth - 1}
                y={padTop + chartHeight - currentHeight}
                width={barWidth}
                height={Math.max(1, currentHeight)}
                rx="2"
                fill="rgb(15 118 110)"
              />
              <rect
                x={x + 1}
                y={padTop + chartHeight - collectionHeight}
                width={barWidth}
                height={Math.max(1, collectionHeight)}
                rx="2"
                fill="rgb(37 99 235)"
              />
              {(data.length <= 10 || index % Math.ceil(data.length / 8) === 0) && (
                <text
                  x={x}
                  y={height - 18}
                  textAnchor="middle"
                  fontSize="11"
                  fill="currentColor"
                >
                  {formatShortDate(point.localDate)}
                </text>
              )}
            </g>
          );
        })}
        <polyline
          points={orderPoints}
          fill="none"
          stroke="rgb(194 65 12)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {data.map((point, index) => {
          const x = padX + (slot * index) + (slot / 2);
          const y = padTop + chartHeight
            - ((point.activeOrderCount / maxActiveOrders) * chartHeight);
          return (
            <circle
              key={`${point.localDate}-active-orders`}
              cx={x}
              cy={y}
              r="3.5"
              fill="rgb(194 65 12)"
            />
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-4 px-1 text-xs text-text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-4 rounded-sm bg-action-primary" />
          Giá trị đơn hiện tại
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-4 rounded-sm bg-blue-600" />
          Tiền thu đã ghi nhận
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-0.5 w-4 bg-status-warning" />
          Tổng đơn hiệu lực
        </span>
      </div>
    </div>
  );
}

export default function DashboardScreen() {
  const { t } = useI18n();
  const { snapshot: appAccess, runtime } = useAppAccessSnapshot();
  const navigate = useNavigate();
  const today = toIsoDate(new Date());
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(today);
  const [creatorOperatorIds, setCreatorOperatorIds] = useState<string[]>([]);
  const accessPartition = appAccess ? JSON.stringify(buildPartitionedQueryKeyV1(appAccess, "dashboard")) : "";
  useEffect(() => { setCreatorOperatorIds([]); }, [accessPartition]);
  const reportScope = getClientScopeSnapshot();
  const canonicalFinancialSelected =
    ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1.partialFinancialDashboardEnabled;
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dashboard", from, to],
    queryFn: () => fetchDashboard({ from, to }),
    enabled: !canonicalFinancialSelected,
    refetchInterval: 60_000,
  });
  const { data: inventory } = useQuery({
    queryKey: [
      "dashboardInventoryRisk",
      reportScope.operatingMerchantId,
      reportScope.operatingStoreId,
    ],
    queryFn: fetchInventory,
    enabled: !canonicalFinancialSelected,
    refetchInterval: 60_000,
  });
  const { data: aiQueue } = useQuery({
    queryKey: ["dashboardAiQueue", reportScope.reportMerchantId],
    queryFn: fetchAiReviewQueue,
    enabled: !canonicalFinancialSelected,
    refetchInterval: 60_000,
  });
  const {
    data: partialFinancial,
    isLoading: partialFinancialLoading,
    error: partialFinancialError,
    refetch: refetchPartialFinancial,
  } = useQuery({
    queryKey: appAccess
      ? buildPartitionedQueryKeyV1(appAccess, "dashboardPartialFinancialV1", { from, to })
      : ["dashboardPartialFinancialV1", "access-pending", { from, to }],
    enabled: !canonicalFinancialSelected
      && ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1.partialFinancialDashboardEnabled
      && Boolean(appAccess)
      && runtime.surfaces.dashboardRead === "enabled",
    queryFn: async () => {
      if (!appAccess) throw new Error("Dashboard access snapshot is unavailable");
      const task = createPartialFinancialDashboardUiTaskV1(
        fetchPartialFinancialFeatureDashboard,
        {
          from,
          to,
          nowEpochSeconds: Math.floor(Date.now() / 1_000),
          requestId: `dashboard-${Date.now()}`,
          scope: {
            ...reportScope,
            reportMerchantId: appAccess.merchantId,
            reportStoreIds: appAccess.storeIds,
          },
        },
        ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1,
      );
      if (!task.enabled) return null;
      const result = await task.execute();
      if (result.kind !== "ready") throw new Error(result.message);
      return result;
    },
    refetchInterval: 60_000,
  });

  const creatorSalesDashboard = useCreatorSalesDashboard({ from, to, ...(creatorOperatorIds.length ? { creatorOperatorIds } : {}) }, canonicalFinancialSelected);

  const d = data?.data;
  const canonicalFinancialEnabled = partialFinancial?.presentation.enabled === true;
  const overviewPresentation = useMemo(() => (
    partialFinancial?.response
      ? buildDashboardOverviewPresentationV1(partialFinancial.response)
      : null
  ), [partialFinancial?.response]);
  const lowStock = (inventory || []).filter((item) => {
    const qty = item.location_levels?.[0]?.stocked_quantity ?? 0;
    return qty > 0 && qty <= Number(item.reorder_level ?? 5);
  });
  const outOfStock = (inventory || []).filter((item) => (item.location_levels?.[0]?.stocked_quantity ?? 0) === 0);
  const aiPending = aiQueue?.data?.length ?? 0;
  const bestProduct = d?.topProducts?.[0];
  const cancelRate = d && d.orderCount + d.canceledOrders > 0
    ? (d.canceledOrders / (d.orderCount + d.canceledOrders)) * 100
    : 0;
  const itemsPerOrder = d?.orderCount ? d.itemQuantity / d.orderCount : 0;

  const insightRows = useMemo(() => {
    if (!d) return [];
    return [
      {
        label: "Biên hàng hóa theo cost snapshot",
        value: d.grossMarginPercent === null
          ? "Chưa đủ cost"
          : `${d.grossMarginPercent.toLocaleString("vi-VN")}%`,
        tone: d.grossMarginPercent === null
          ? "warning"
          : d.grossMarginPercent >= 25 ? "success" : d.grossMarginPercent > 0 ? "warning" : "danger",
      },
      {
        label: "Tỷ lệ hủy đơn",
        value: `${cancelRate.toFixed(1)}%`,
        tone: cancelRate <= 2 ? "success" : cancelRate <= 5 ? "warning" : "danger",
      },
      {
        label: "Sản phẩm / đơn",
        value: itemsPerOrder.toFixed(1),
        tone: itemsPerOrder >= 2 ? "success" : "info",
      },
      {
        label: "Đơn có phí vận chuyển",
        value: `${d.shippingOrderCount.toLocaleString("vi-VN")} đơn`,
        tone: d.shippingOrderCount > 0 ? "info" : "warning",
      },
      {
        label: "Tỷ trọng phí vận chuyển",
        value: `${d.shippingSharePercent.toLocaleString("vi-VN")}%`,
        tone: d.shippingSharePercent <= 15 ? "success" : "info",
      },
    ] as const;
  }, [cancelRate, d, itemsPerOrder]);

  if (canonicalFinancialSelected) {
    return (
      <CreatorSalesDashboardSurface
        dashboard={creatorSalesDashboard.data || null}
        from={from}
        to={to}
        today={today}
        creatorOperatorIds={creatorOperatorIds}
        loading={(!creatorSalesDashboard.feeAware && runtime.surfaces.dashboardRead === "skeleton") || creatorSalesDashboard.isLoading}
        error={(!creatorSalesDashboard.feeAware && (runtime.surfaces.dashboardRead === "unavailable" || runtime.selected.dashboardRead !== "v2"))
          || Boolean(creatorSalesDashboard.error)}
        onFrom={setFrom}
        onTo={setTo}
        onPreset={(days) => {
          setFrom(daysAgo(days - 1));
          setTo(today);
        }}
        onCreatorOperatorIds={setCreatorOperatorIds}
        onRetry={() => void creatorSalesDashboard.refetch()}
      />
    );
  }

  if (
    !canonicalFinancialSelected
    && error instanceof ApiError
    && error.status === 403
  ) {
    return (
      <div className="p-4">
        <PageHeader title={t("dashboard.title")} />
        <div className="mt-4">
          <ScreenState
            state="empty"
            title="Không có quyền xem Tổng quan"
            body="Tài khoản hiện tại không có quyền xem báo cáo và chỉ số quản trị."
            actionLabel="Quay lại Bán hàng"
            onAction={() => navigate("/pos")}
          />
        </div>
      </div>
    );
  }

  if (!canonicalFinancialSelected && error) {
    return (
      <div className="p-4">
        <InlineError message="Không thể tải tổng quan" onRetry={() => refetch()} stale />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader title={t("dashboard.title")} />

      <FilterBar
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => { setFrom(today); setTo(today); }}>
              Hôm nay
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { setFrom(daysAgo(6)); setTo(today); }}>
              7 ngày
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { setFrom(daysAgo(29)); setTo(today); }}>
              30 ngày
            </Button>
          </div>
        }
      >
        <label className="flex items-center gap-2 text-xs text-text-muted">
          Từ
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm text-text-primary focus:border-action-primary focus:outline-none"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-text-muted">
          Đến
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm text-text-primary focus:border-action-primary focus:outline-none"
          />
        </label>
      </FilterBar>

      {!canonicalFinancialSelected && (isLoading || !d ? (
        <MetricSkeleton />
      ) : (
        <ResponsiveMetricGrid>
          <MetricCell label="Tổng đơn" value={String(d.orderCount)} icon={<ShoppingCart size={20} />} />
          <MetricCell label="Tổng doanh thu" value={formatMoney(d.totalRevenue)} icon={<DollarSign size={20} />} />
          <MetricCell label="Doanh thu hàng hóa" value={formatMoney(d.merchandiseRevenue)} icon={<Package size={20} />} />
          <MetricCell label="Phí vận chuyển" value={formatMoney(d.shippingRevenue)} icon={<DollarSign size={20} />} />
          <MetricCell label="Giá trị đơn TB" value={formatMoney(d.averageOrderValue)} icon={<TrendingUp size={20} />} />
          <MetricCell
            label="Lợi nhuận gộp"
            value={d.grossProfit === null ? "Chưa đủ cost" : formatMoney(d.grossProfit)}
            icon={<DollarSign size={20} />}
            tone={d.grossProfit === null ? "warning" : d.grossProfit >= 0 ? "success" : "danger"}
          />
          <MetricCell label="Sản phẩm bán ra" value={String(d.itemQuantity)} icon={<Package size={20} />} />
          <MetricCell
            label="Khách mới"
            value={d.newCustomers === null ? "Chưa có nguồn chính xác" : String(d.newCustomers)}
            icon={<Users size={20} />}
            tone={d.newCustomers === null ? "warning" : undefined}
          />
          <MetricCell label="Đơn đã hủy" value={String(d.canceledOrders)} tone={d.canceledOrders ? "warning" : "success"} />
          <MetricCell label="SKU đang bán" value={String(d.products)} icon={<Package size={20} />} />
        </ResponsiveMetricGrid>
      ))}

      {canonicalFinancialSelected && partialFinancialLoading && <MetricSkeleton />}

      {canonicalFinancialSelected && partialFinancialError && (
        <InlineError
          message="Không thể xác nhận số liệu tài chính canonical; dashboard cũ không được dùng thay thế."
          onRetry={() => refetchPartialFinancial()}
          stale
        />
      )}

      {canonicalFinancialSelected && !partialFinancialLoading && !partialFinancialError && !canonicalFinancialEnabled && (
        <InlineError
          message="Dữ liệu tài chính canonical không sẵn sàng; dashboard cũ không được dùng thay thế."
          onRetry={() => refetchPartialFinancial()}
          stale
        />
      )}

      {partialFinancial?.presentation.enabled && (
        <Panel title="Tổng quan tài chính canonical">
          <div className="space-y-4 p-4">
            <div className="rounded-md border border-border-default bg-surface-subtle p-3 text-xs text-text-secondary">
              <div>{`reportAsOf: ${partialFinancial.context.reportAsOf}`}</div>
              <div>{`generatedAt: ${partialFinancial.context.generatedAt}`}</div>
              <div>{`Scope báo cáo: ${partialFinancial.context.normalizedScope.storeIds.join(", ")}`}</div>
            </div>
            {partialFinancial.presentation.operational && (
              <div className="space-y-3">
                <div className="text-xs font-semibold text-text-secondary">
                  Snapshot catalog và tồn kho canonical
                </div>
                <ResponsiveMetricGrid>
                  <MetricCell
                    label="AI chờ xử lý (merchant)"
                    value={
                      partialFinancial.presentation.operational
                        .reportMerchantAiReviewQueue?.status === "available"
                        ? String(
                            partialFinancial.presentation.operational
                              .reportMerchantAiReviewQueue
                              .pendingOrReviewRequiredCount,
                          )
                        : "Chưa đủ bằng chứng"
                    }
                    icon={<Bot size={20} />}
                    tone={
                      partialFinancial.presentation.operational
                        .reportMerchantAiReviewQueue?.status === "available"
                        && partialFinancial.presentation.operational
                          .reportMerchantAiReviewQueue
                          .pendingOrReviewRequiredCount > 0
                        ? "warning"
                        : undefined
                    }
                  />
                  <MetricCell
                    label="SKU đang bán (merchant)"
                    value={String(
                      partialFinancial.presentation.operational
                        .reportMerchantCatalog.publishedSkuCount,
                    )}
                    icon={<Package size={20} />}
                  />
                  <MetricCell
                    label="Khách mới (merchant)"
                    value={
                      partialFinancial.presentation.operational
                        .reportMerchantCustomerAcquisition?.status === "available"
                        ? String(
                            partialFinancial.presentation.operational
                              .reportMerchantCustomerAcquisition
                              .newCustomerCount,
                          )
                        : "Chưa đủ bằng chứng"
                    }
                    icon={<Users size={20} />}
                  />
                  <MetricCell
                    label="Sắp hết (store báo cáo, theo reorder level)"
                    value={
                      partialFinancial.presentation.operational
                        .selectedReportStoresInventory.status === "available"
                        ? String(
                            partialFinancial.presentation.operational
                              .selectedReportStoresInventory
                              .lowStockVariantLocationCount,
                          )
                        : "Chưa đủ bằng chứng"
                    }
                    icon={<AlertTriangle size={20} />}
                    tone="warning"
                  />
                  <MetricCell
                    label="Hết hàng (store báo cáo)"
                    value={
                      partialFinancial.presentation.operational
                        .selectedReportStoresInventory.status === "available"
                        ? String(
                            partialFinancial.presentation.operational
                              .selectedReportStoresInventory
                              .outOfStockVariantLocationCount,
                          )
                        : "Chưa đủ bằng chứng"
                    }
                    tone="danger"
                  />
                </ResponsiveMetricGrid>
              </div>
            )}
            {partialFinancial.presentation.currencies.map((currency) => {
              const divisor = 10 ** currency.minorUnitExponent;
              const money = (minor: number) => `${(minor / divisor).toLocaleString("vi-VN")} ${currency.currencyCode}`;
              return (
                <div key={currency.currencyCode} className="space-y-3 rounded-lg border border-border-default p-3">
                  <div className="text-xs font-semibold text-text-secondary">{currency.currencyCode}</div>
                  <p className="text-xs text-text-muted">
                    {`Đơn có commercial revision hợp lệ trong kỳ: ${currency.validOrderCount.toLocaleString("vi-VN")}`}
                  </p>
                  <ResponsiveMetricGrid>
                    {currency.headlines.map((headline) => (
                      <MetricCell
                        key={headline.key}
                        label={headline.label}
                        value={money(headline.valueMinor)}
                        icon={<DollarSign size={20} />}
                      />
                    ))}
                  </ResponsiveMetricGrid>
                  {currency.commercial.status === "available" && (
                    <div className="space-y-3 border-t border-border-subtle pt-3">
                      <div className="text-xs font-semibold text-text-secondary">
                        Giá trị thương mại theo revision hiệu lực
                      </div>
                      <ResponsiveMetricGrid>
                        <MetricCell
                          label="Tổng đơn hiệu lực"
                          value={String(currency.validOrderCount)}
                          icon={<ShoppingCart size={20} />}
                        />
                        <MetricCell
                          label="Hàng hóa hiện tại chưa VAT"
                          value={money(currency.commercial.currentMerchandiseRevenueExVatMinor || 0)}
                          icon={<Package size={20} />}
                        />
                        <MetricCell
                          label="Vận chuyển hiện tại chưa VAT"
                          value={money(currency.commercial.currentShippingRevenueExVatMinor ?? 0)}
                          icon={<DollarSign size={20} />}
                        />
                        <MetricCell
                          label="Vận chuyển khách phải trả (gross)"
                          value={money(currency.commercial.currentShippingGrossValueMinor ?? 0)}
                          icon={<DollarSign size={20} />}
                        />
                        <MetricCell
                          label="Đơn có phí vận chuyển"
                          value={String(currency.commercial.activeOrdersWithShippingCount ?? 0)}
                          icon={<ShoppingCart size={20} />}
                          tone={(currency.commercial.activeOrdersWithShippingCount ?? 0) > 0
                            ? "info"
                            : "success"}
                        />
                        <MetricCell
                          label="Tỷ trọng phí vận chuyển"
                          value={currency.commercial.currentShippingSharePercent === null
                            ? "Không có mẫu số"
                            : `${currency.commercial.currentShippingSharePercent?.toLocaleString("vi-VN")}%`}
                          tone={currency.commercial.currentShippingSharePercent === null
                            ? "warning"
                            : (currency.commercial.currentShippingSharePercent ?? 0) <= 15
                              ? "success"
                              : "info"}
                        />
                        <MetricCell
                          label="VAT trong giá trị đơn hiện tại"
                          value={money(currency.commercial.currentVatMinor || 0)}
                          icon={<DollarSign size={20} />}
                        />
                        <MetricCell
                          label="Giảm giá hiện tại"
                          value={money(currency.commercial.currentDiscountMinor || 0)}
                          icon={<DollarSign size={20} />}
                        />
                        <MetricCell
                          label="Giá trị đơn hiệu lực TB"
                          value={currency.commercial.averageCurrentOrderValueMinor === null
                            ? "Không có đơn"
                            : money(currency.commercial.averageCurrentOrderValueMinor || 0)}
                          icon={<TrendingUp size={20} />}
                        />
                        <MetricCell
                          label="Sản phẩm bán ra hiệu lực"
                          value={String(currency.commercial.effectiveItemQuantity || 0)}
                          icon={<Package size={20} />}
                        />
                        <MetricCell
                          label="Đơn đã hủy trong cohort"
                          value={String(currency.commercial.cancelledOrderCohortCount || 0)}
                          tone={(currency.commercial.cancelledOrderCohortCount || 0) > 0 ? "warning" : "success"}
                        />
                        <MetricCell
                          label="Cost snapshot thương mại (không phải COGS kế toán)"
                          value={currency.commercial.currentCogsMinor === null
                            ? "Chưa đủ bằng chứng"
                            : money(currency.commercial.currentCogsMinor || 0)}
                          tone={currency.commercial.currentCogsMinor === null ? "warning" : undefined}
                        />
                      </ResponsiveMetricGrid>
                    </div>
                  )}
                  {currency.accounting?.status === "available" && (
                    <div className="space-y-3 border-t border-border-subtle pt-3">
                      <div className="text-xs font-semibold text-text-secondary">
                        Kế toán đã posted theo immutable source time
                      </div>
                      <p className="text-xs text-text-muted">
                        {`Journal đủ bằng chứng trong kỳ: ${currency.accounting.postedJournalCount?.toLocaleString("vi-VN")}`}
                      </p>
                      <ResponsiveMetricGrid>
                        <MetricCell
                          label="Doanh thu hàng hóa kế toán chưa VAT"
                          value={money(currency.accounting.revenueExcludingVatMinor || 0)}
                          icon={<DollarSign size={20} />}
                        />
                        <MetricCell
                          label="COGS kế toán"
                          value={money(currency.accounting.cogsRecognizedMinor || 0)}
                          icon={<DollarSign size={20} />}
                        />
                        <MetricCell
                          label="Lợi nhuận gộp kế toán"
                          value={money(currency.accounting.grossProfitMinor || 0)}
                          icon={<DollarSign size={20} />}
                          tone={(currency.accounting.grossProfitMinor || 0) >= 0
                            ? "success"
                            : "danger"}
                        />
                        <MetricCell
                          label="Biên lợi nhuận gộp kế toán"
                          value={currency.accounting.grossMarginPercent === null
                            ? "Không có mẫu số dương"
                            : `${currency.accounting.grossMarginPercent?.toLocaleString("vi-VN")}%`}
                          tone={currency.accounting.grossMarginPercent === null
                            ? "warning"
                            : (currency.accounting.grossMarginPercent || 0) >= 0
                              ? "success"
                              : "danger"}
                        />
                      </ResponsiveMetricGrid>
                    </div>
                  )}
                  {currency.accounting?.status === "unavailable" && (
                    <p className="border-t border-border-subtle pt-3 text-xs text-status-warning">
                      {`Profit/margin kế toán unavailable: ${currency.accounting.issues?.join(", ")}`}
                    </p>
                  )}
                  {currency.collectionBreakdown && (
                    <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
                      {currency.collectionBreakdown.map((item) => (
                        <div key={item.key} className="flex justify-between gap-3 rounded-md bg-surface-subtle p-2">
                          <span className="text-text-muted">{item.label}</span>
                          <span className="tabular-nums text-text-primary">{money(item.valueMinor)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {currency.collectionStateLabel && (
                    <p className="text-xs text-text-muted">{currency.collectionStateLabel}</p>
                  )}
                  <p className="text-xs text-status-warning">{currency.unavailable.label}</p>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {canonicalFinancialEnabled && partialFinancial?.presentation.enabled && (
        <Panel title="Diễn biến đơn và dòng tiền canonical theo ngày">
          <div className="grid gap-4 p-4 xl:grid-cols-2">
            {partialFinancial.presentation.currencies.map((currency) => (
              <div
                key={currency.currencyCode}
                className="space-y-3 rounded-lg border border-border-default p-3"
              >
                <div className="text-xs font-semibold text-text-secondary">
                  {currency.currencyCode}
                </div>
                {currency.dailySeries ? (
                  <CanonicalDailySeriesChart
                    currencyCode={currency.currencyCode}
                    minorUnitExponent={currency.minorUnitExponent}
                    data={currency.dailySeries}
                  />
                ) : (
                  <ScreenState
                    state="empty"
                    title={`Daily series ${currency.currencyCode} chưa đủ bằng chứng`}
                    body="Không hiển thị số 0 thay thế và không dùng dashboard legacy."
                  />
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {canonicalFinancialEnabled && (
        <Panel title="Trạng thái 27 factor dashboard">
          <div className="grid gap-2 p-4 text-xs sm:grid-cols-2 lg:grid-cols-3">
            {partialFinancial?.presentation.enabled && partialFinancial.presentation.factorStates.map((factor) => (
              <div key={factor.factorId} className="rounded-md border border-border-default p-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="break-all font-mono text-text-primary">{factor.factorId}</span>
                  <StatusPill
                    tone={factor.status === "available" ? "success" : "warning"}
                    label={factor.status}
                  />
                </div>
                <p className="mt-1 text-text-muted">{factor.reason}</p>
                <p className="mt-1 text-text-muted">
                  {factor.targetSources.join(", ")} · {factor.targetScope}
                </p>
                <details className="mt-1 text-text-muted">
                  <summary className="cursor-pointer">Formula và quality contract</summary>
                  <p className="mt-1">{factor.formula}</p>
                  <p className="mt-1">
                    {factor.timeBasis.join(", ")} · {factor.currencyBehavior} ·
                    {" "}{factor.runtimeDataQualityStatus}
                  </p>
                  <p className="mt-1">{factor.freshnessBehavior}</p>
                  <p className="mt-1">{factor.dataQualityBehavior}</p>
                </details>
              </div>
            ))}
            <p className="sm:col-span-2 lg:col-span-3 text-status-warning">
              Factor unavailable không được hiển thị thành 0 và không được fallback sang
              metadata/line gốc hoặc request khác scope/clock.
            </p>
          </div>
        </Panel>
      )}

      {!canonicalFinancialSelected && d && (
        <Panel title="Chỉ số thương mại và vận hành theo đơn hiệu lực">
          <div className="p-4">
            <ResponsiveMetricGrid>
              <MetricCell label="Đơn hiệu lực" value={String(d.orderCount)} icon={<ShoppingCart size={20} />} />
              <MetricCell label="Giá trị hàng hóa hiện tại (gồm VAT)" value={formatMoney(d.merchandiseRevenue)} icon={<Package size={20} />} />
              <MetricCell label="Phí vận chuyển hiện tại (gồm VAT)" value={formatMoney(d.shippingRevenue)} icon={<DollarSign size={20} />} />
              <MetricCell label="VAT của đơn hiện tại" value={formatMoney(d.taxTotal)} icon={<DollarSign size={20} />} />
              <MetricCell label="Giá trị đơn hiệu lực TB" value={formatMoney(d.averageOrderValue)} icon={<TrendingUp size={20} />} />
              <MetricCell label="Sản phẩm bán ra hiệu lực" value={String(d.itemQuantity)} icon={<Package size={20} />} />
              <MetricCell
                label="Khách mới (merchant)"
                value={d.newCustomers === null ? "Chưa có nguồn chính xác" : String(d.newCustomers)}
                icon={<Users size={20} />}
                tone={d.newCustomers === null ? "warning" : undefined}
              />
              <MetricCell label="Đơn đã hủy" value={String(d.canceledOrders)} tone={d.canceledOrders ? "warning" : "success"} />
              <MetricCell label="SKU đang bán" value={String(d.products)} icon={<Package size={20} />} />
              <MetricCell label="Giảm giá hiện tại" value={formatMoney(d.discountTotal)} icon={<DollarSign size={20} />} />
            </ResponsiveMetricGrid>
          </div>
        </Panel>
      )}

      {!canonicalFinancialSelected && d && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <Panel title="Doanh thu và số đơn theo ngày">
            <div className="p-4">
              <RevenueOrdersChart data={d.daily || []} />
            </div>
          </Panel>

          <Panel title="Góc nhìn chủ doanh nghiệp">
            <div className="space-y-3 p-4 text-sm">
              {insightRows.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-3">
                  <span className="text-text-muted">{item.label}</span>
                  <StatusPill tone={item.tone} label={item.value} />
                </div>
              ))}
              <div className="rounded-lg border border-border-default bg-surface-subtle p-3 text-xs leading-5 text-text-muted">
                {bestProduct
                  ? `Sản phẩm đóng góp doanh thu cao nhất là ${bestProduct.name} với ${formatMoney(bestProduct.revenue)} trong kỳ.`
                  : "Chưa có sản phẩm bán ra trong khoảng thời gian này."}
              </div>
              <StatusPill tone="info" label="Dữ liệu tự làm mới mỗi 60 giây" />
            </div>
          </Panel>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Top sản phẩm theo doanh thu">
          <div className="space-y-2 p-4 text-sm">
            {canonicalFinancialSelected
              ? partialFinancial?.presentation.enabled
                ? partialFinancial.presentation.currencies.flatMap((currency) => (
                  currency.commercial.status === "available"
                    ? (currency.commercial.topProducts || []).map((item) => (
                      <div key={`${currency.currencyCode}-${item.productId}-${item.variantId}-${item.skuSnapshot}`} className="rounded-lg border border-border-default p-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="truncate font-medium text-text-primary">{item.titleSnapshot}</span>
                          <span className="tabular-nums text-action-primary">
                            {`${item.grossLineSalesBeforeDiscountMinor.toLocaleString("vi-VN")} ${currency.currencyCode}`}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-text-muted">
                          {`${item.quantity.toLocaleString("vi-VN")} sản phẩm · gross line trước phân bổ discount`}
                        </div>
                      </div>
                    ))
                    : []
                ))
                : <ScreenState state="empty" title="Top sản phẩm unavailable" />
              : d?.topProducts?.length ? d.topProducts.map((item) => (
              <div key={`${item.productId}-${item.name}`} className="rounded-lg border border-border-default p-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-medium text-text-primary">{item.name}</span>
                  <span className="tabular-nums text-action-primary">{formatMoney(item.revenue)}</span>
                </div>
                <div className="mt-1 text-xs text-text-muted">{item.quantity.toLocaleString("vi-VN")} sản phẩm</div>
              </div>
            )) : (
              <ScreenState state="empty" title="Chưa có dữ liệu bán hàng" />
            )}
          </div>
        </Panel>

        <Panel title="Phương thức thanh toán">
          <div className="space-y-2 p-4 text-sm">
            {canonicalFinancialSelected ? (
              partialFinancial?.presentation.enabled
                ? partialFinancial.presentation.currencies.flatMap((currency) => (
                  currency.paymentMethods.map((item) => (
                    <div key={`${currency.currencyCode}-${item.method}`} className="rounded-lg border border-border-default p-2">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-medium text-text-primary">{paymentLabel(item.method)}</p>
                          <p className="mt-0.5 text-xs text-text-muted">
                            {`${item.postedChargeOrderCount} đơn có thu · ${item.postedNegativeEventCount} chi/đảo`}
                          </p>
                        </div>
                        <span className="tabular-nums text-text-primary">
                          {`${item.netMinor.toLocaleString("vi-VN")} ${currency.currencyCode}`}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-text-muted">
                        {`Gross ${item.grossMinor.toLocaleString("vi-VN")} · Negative ${item.negativeMinor.toLocaleString("vi-VN")}`}
                      </p>
                    </div>
                  ))
                ))
                : <ScreenState state="empty" title="Payment mix unavailable" />
            ) : d?.paymentMix?.length ? d.paymentMix.map((item) => (
              <div key={item.method} className="flex items-center justify-between gap-3 rounded-lg border border-border-default p-2">
                <div>
                  <p className="font-medium text-text-primary">{paymentLabel(item.method)}</p>
                  <p className="mt-0.5 text-xs text-text-muted">{item.orders} đơn</p>
                </div>
                <span className="tabular-nums text-text-primary">{formatMoney(item.revenue)}</span>
              </div>
            )) : (
              <ScreenState state="empty" title="Chưa có thanh toán" />
            )}
          </div>
        </Panel>

        {!canonicalFinancialSelected && (
          <Panel title="Rủi ro vận hành">
            <div className="space-y-3 p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-text-muted">
                  <AlertTriangle size={14} className="text-status-warning" />
                  Sắp hết (store đang vận hành, theo reorder level)
                </span>
                <span className="font-semibold tabular-nums text-status-warning">{lowStock.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-text-muted">Hết hàng (store đang vận hành)</span>
                <span className="font-semibold tabular-nums text-status-danger">{outOfStock.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-text-muted">
                  <Bot size={14} />
                  AI chờ xử lý (merchant)
                </span>
                <span className="font-semibold tabular-nums text-text-primary">{aiPending}</span>
              </div>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
