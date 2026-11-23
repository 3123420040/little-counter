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
  type FilterBarProps,
} from "@medusa-snus/ui";
import {
  AlertTriangle,
  DollarSign,
  Package,
  ShoppingCart,
  Users,
} from "lucide-react";
import type { DashboardOverviewPresentationV1 } from "../utils/dashboardOverviewPresentation";
import { DashboardDailyChart } from "./DashboardDailyChart";

function money(minor: number, currencyCode: string, exponent: number) {
  return `${(minor / 10 ** exponent).toLocaleString("vi-VN")} ${currencyCode}`;
}

function unavailable(reason: string) {
  return <span title={reason}>Chưa khả dụng</span>;
}

export function DashboardOverviewSurface({
  presentation,
  from,
  to,
  today,
  loading,
  error,
  stale,
  onFrom,
  onTo,
  onPreset,
  onRetry,
  filters,
  selfOnly = false,
}: {
  presentation: DashboardOverviewPresentationV1 | null;
  from: string;
  to: string;
  today: string;
  loading: boolean;
  error: boolean;
  stale: boolean;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  onPreset: (days: number) => void;
  onRetry: () => void;
  filters?: FilterBarProps["children"];
  selfOnly?: boolean;
}) {
  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Tổng quan" />
      <FilterBar
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => onPreset(1)}>
              Hôm nay
            </Button>
            <Button variant="secondary" size="sm" onClick={() => onPreset(7)}>
              7 ngày
            </Button>
            <Button variant="secondary" size="sm" onClick={() => onPreset(30)}>
              30 ngày
            </Button>
          </div>
        }
      >
        <label className="flex items-center gap-2 text-xs text-text-muted">
          Từ
          <input
            aria-label="Ngày bắt đầu"
            type="date"
            value={from}
            max={to || today}
            onChange={(event) => onFrom(event.target.value)}
            className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-text-muted">
          Đến
          <input
            aria-label="Ngày kết thúc"
            type="date"
            value={to}
            min={from}
            max={today}
            onChange={(event) => onTo(event.target.value)}
            className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm"
          />
        </label>
        {filters}
      </FilterBar>

      {loading && !presentation ? (
        <ScreenState state="loading" title="Đang tải Tổng quan" />
      ) : null}
      {error && !presentation ? (
        <InlineError
          message="Không thể tải dữ liệu Tổng quan canonical."
          onRetry={onRetry}
        />
      ) : null}
      {stale && presentation ? (
        <InlineError
          message={`Đang hiển thị snapshot ${presentation.context.reportAsOf}; lần làm mới gần nhất thất bại.`}
          onRetry={onRetry}
          stale
        />
      ) : null}

      {presentation ? (
        <>
          <Panel title={selfOnly ? "Doanh số của tôi" : "Chỉ số chính"}>
            <div className="space-y-4 p-4">
              {presentation.currencyBlocks.map((block) => (
                <div
                  key={block.currencyCode}
                  className="space-y-3 rounded-lg border border-border-default p-3"
                >
                  <div className="text-xs font-semibold text-text-secondary">
                    {block.currencyCode}
                  </div>
                  <ResponsiveMetricGrid>
                    {block.metricCards.map((card) => (
                      <div key={card.id} className="min-w-0">
                      <MetricCell
                        label={card.label}
                        value={
                          card.status === "available"
                            ? money(
                                card.valueMinor,
                                block.currencyCode,
                                block.minorUnitExponent,
                              )
                            : "Chưa khả dụng"
                        }
                        icon={<DollarSign size={20} />}
                        tone={
                          card.status === "unavailable" ? "warning" : undefined
                        }
                      />
                      {card.status === "available" && card.coverage ? (
                        <details className="mt-2 text-xs text-text-secondary">
                          <summary className="cursor-pointer rounded p-1 focus-visible:outline" title={card.coverage.feeBasis
                            ? "Chỉ tính phụ phí có đủ bằng chứng nguồn và phân bổ; các nguồn chưa xác minh được không tính là 0."
                            : "Chỉ tính doanh thu và giá vốn của các bút toán có đầy đủ bằng chứng giá vốn, kể cả nguồn của điều chỉnh và đảo bút toán."}>
                            {card.coverage.feeBasis
                              ? `Đã xác minh ${card.coverage.covered}/${card.coverage.total} ${card.coverage.feeBasis === "event" ? "sự kiện" : "bút toán"} · Chưa đủ bằng chứng ${card.coverage.excluded} ${card.coverage.feeBasis === "event" ? "sự kiện" : "bút toán"}`
                              : `Đã xác minh ${card.coverage.covered}/${card.coverage.total} bút toán · Thiếu giá vốn ${card.coverage.excluded} bút toán`}
                          </summary>
                          <p className="mt-1">{card.coverage.feeBasis
                            ? "Phụ phí của phần đã xác minh, không phải doanh thu phí toàn kỳ. Các nguồn chưa đủ bằng chứng được loại khỏi phần này."
                            : "Lợi nhuận của phần đã xác minh, không phải lợi nhuận toàn kỳ. Chỉ tính doanh thu và giá vốn trên cùng các bút toán đủ bằng chứng. Không hiển thị biên lợi nhuận cho phần này."}</p>
                        </details>
                      ) : card.status === "unavailable" ? (
                        <details className="mt-2 text-xs text-text-secondary"><summary className="cursor-pointer">Lý do chưa khả dụng</summary><p>{card.reason}</p></details>
                      ) : null}
                      </div>
                    ))}
                  </ResponsiveMetricGrid>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Giá trị đơn hàng và số đơn">
            <div className="space-y-4 p-4">
              {presentation.currencyBlocks.map((block) => (
                <div key={block.currencyCode} className="space-y-2">
                  <div className="text-xs font-semibold text-text-secondary">
                    {block.currencyCode}
                  </div>
                  {block.dailyChart.status === "available" ? (
                    block.dailyChart.empty ? (
                      <ScreenState
                        state="empty"
                        title="Chưa có dữ liệu trong kỳ"
                      />
                    ) : (
                      <DashboardDailyChart
                        currencyCode={block.currencyCode}
                        minorUnitExponent={block.minorUnitExponent}
                        points={block.dailyChart.points}
                      />
                    )
                  ) : (
                    unavailable(block.dailyChart.reason)
                  )}
                </div>
              ))}
            </div>
          </Panel>

          <Panel title={selfOnly ? "Góc nhìn bán hàng của tôi" : "Góc nhìn chủ cửa hàng"}>
            <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
              {presentation.sharedOwnerInsight.rows.map((row) => (
                <div key={row.id} className="rounded-md border border-border-default p-3">
                  <div className="text-xs text-text-muted">{row.label}</div>
                  <div className="mt-1 text-lg font-semibold">
                    {row.status === "available" ? `${row.value.toLocaleString("vi-VN")} sản phẩm` : unavailable(row.reason)}
                  </div>
                  <details className="mt-2 text-xs text-text-muted">
                    <summary className="cursor-pointer">Cách tính số sản phẩm</summary>
                    Tổng đơn vị sản phẩm theo phiên bản đơn hiệu lực mới nhất; đã áp dụng điều chỉnh và loại đơn hủy, theo ngày kinh doanh gốc của đơn.
                  </details>
                </div>
              ))}
              {presentation.currencyBlocks.flatMap((block) =>
                block.ownerInsight.rows.map((row) => (
                  <div
                    key={`${block.currencyCode}-${row.id}`}
                    className="rounded-md border border-border-default p-3"
                  >
                    <div className="text-xs text-text-muted">
                      {row.label} · {block.currencyCode}
                    </div>
                    <div className="mt-1 text-lg font-semibold">
                      {row.status === "available"
                        ? `${row.value.toLocaleString("vi-VN")}${row.unit === "percent" ? "%" : row.unit === "count" ? " đơn" : ""}`
                        : unavailable(row.reason)}
                    </div>
                  </div>
                )),
              )}
            </div>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Sản phẩm nổi bật">
              <div className="space-y-3 p-4">
                {presentation.currencyBlocks.map((block) =>
                  block.topProducts.status === "available" ? (
                    <div key={block.currencyCode}>
                      <div className="mb-2 text-xs font-semibold text-text-secondary">
                        {block.currencyCode}
                      </div>
                      {block.topProducts.empty ? (
                        <p className="text-sm text-text-muted">
                          Chưa có sản phẩm bán ra.
                        </p>
                      ) : (
                        block.topProducts.items.map((item) => (
                          <div
                            key={`${item.productId}-${item.variantId}`}
                            className="flex justify-between gap-3 border-b border-border-subtle py-2 text-sm"
                          >
                            <span>{item.titleSnapshot}</span>
                            <span className="tabular-nums">
                              {item.quantity} ·{" "}
                              {money(
                                item.grossLineSalesBeforeDiscountMinor,
                                block.currencyCode,
                                block.minorUnitExponent,
                              )}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  ) : (
                    <p key={block.currencyCode}>
                      {unavailable(block.topProducts.reason)}
                    </p>
                  ),
                )}
              </div>
            </Panel>
            <Panel title="Phương thức thanh toán">
              <div className="space-y-3 p-4">
                {presentation.currencyBlocks.map((block) =>
                  block.paymentMix.status === "available" ? (
                    <div key={block.currencyCode}>
                      <div className="mb-2 text-xs font-semibold text-text-secondary">
                        {block.currencyCode}
                      </div>
                      {block.paymentMix.items.map((item) => (
                          <div
                            key={item.method}
                            className="flex justify-between gap-3 border-b border-border-subtle py-2 text-sm"
                          >
                            <span>{item.label}</span>
                            <span className="tabular-nums">
                              {item.postedChargeOrderCount} đơn ·{" "}
                              {money(
                                item.netMinor,
                                block.currencyCode,
                                block.minorUnitExponent,
                              )}
                            </span>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <p key={block.currencyCode}>
                      {unavailable(block.paymentMix.reason)}
                    </p>
                  ),
                )}
              </div>
            </Panel>
          </div>

          <Panel title="Toàn cửa hàng">
            <p className="px-4 pt-4 text-xs text-text-muted">Không áp dụng bộ lọc người tạo đơn. SKU, khách mới và AI tính toàn merchant; tồn kho tính trên các kho cửa hàng trong phạm vi báo cáo.</p>
            <div className="p-4">
              <ResponsiveMetricGrid>
                <MetricCell label="SKU đang bán" icon={<Package size={20} />}
                  value={presentation.sharedMetricCards.publishedSkuCount.status === "available" ? String(presentation.sharedMetricCards.publishedSkuCount.value) : "Chưa khả dụng"} />
                <MetricCell label="Khách mới" icon={<Users size={20} />}
                  value={presentation.sharedMetricCards.newCustomerCount.status === "available" ? String(presentation.sharedMetricCards.newCustomerCount.value) : "Chưa khả dụng"} />
              </ResponsiveMetricGrid>
            </div>
            <p className="px-4 text-sm font-semibold">Rủi ro vận hành</p>
            <div className="grid gap-3 p-4 sm:grid-cols-3">
              {(
                [
                  ["AI chờ xử lý", presentation.operationalRisk.aiPending],
                  ["Sắp hết hàng", presentation.operationalRisk.lowStock],
                  ["Hết hàng", presentation.operationalRisk.outOfStock],
                ] as const
              ).map(([label, state]) => (
                <div
                  key={label}
                  className="flex items-center justify-between rounded-md border border-border-default p-3"
                >
                  <span className="inline-flex items-center gap-2 text-sm">
                    <AlertTriangle size={16} />
                    {label}
                  </span>
                  {state.status === "available" ? (
                    <StatusPill
                      tone={state.value > 0 ? "warning" : "success"}
                      label={String(state.value)}
                    />
                  ) : (
                    unavailable(state.reason)
                  )}
                </div>
              ))}
            </div>
          </Panel>
        </>
      ) : null}
    </div>
  );
}
