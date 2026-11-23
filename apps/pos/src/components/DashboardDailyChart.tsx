import { useEffect, useState } from "react";

export type DashboardDailyChartPoint = {
  localDate: string;
  activeOrderCount: number;
  currentOrderGrossValueMinor: number;
};

function shortDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
  });
}

function fullDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatMoney(minor: number, currencyCode: string, exponent: number) {
  return `${(minor / 10 ** exponent).toLocaleString("vi-VN")} ${currencyCode}`;
}

function compactMoney(minor: number, exponent: number) {
  return new Intl.NumberFormat("vi-VN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(minor / 10 ** exponent);
}

export function DashboardDailyChart({
  currencyCode,
  minorUnitExponent,
  points,
}: {
  currencyCode: string;
  minorUnitExponent: number;
  points: DashboardDailyChartPoint[];
}) {
  const identity = JSON.stringify([currencyCode, minorUnitExponent, points.map((point) => point.localDate)]);
  const [selection, setSelection] = useState<{ identity: string; date: string } | null>(null);
  const selectedIndex = selection?.identity === identity
    ? points.findIndex((point) => point.localDate === selection.date) : -1;
  const activeIndex = selectedIndex < 0 ? null : selectedIndex;
  const setActiveIndex = (index: number | null) => setSelection(index === null ? null : { identity, date: points[index].localDate });
  useEffect(() => {
    setSelection((current) => current?.identity === identity ? current : null);
  }, [identity]);
  if (points.length === 0) return null;

  const width = 760;
  const height = 300;
  const padLeft = 58;
  const padRight = 24;
  const padTop = 28;
  const padBottom = 54;
  const chartWidth = width - padLeft - padRight;
  const chartHeight = height - padTop - padBottom;
  const slot = chartWidth / points.length;
  const barWidth = Math.max(4, Math.min(24, slot * 0.42));
  const maxMoney = Math.max(
    1,
    ...points.map((point) => point.currentOrderGrossValueMinor),
  );
  const maxOrders = Math.max(
    1,
    ...points.map((point) => point.activeOrderCount),
  );
  const xAt = (index: number) => padLeft + slot * index + slot / 2;
  const moneyY = (value: number) =>
    padTop + chartHeight - (value / maxMoney) * chartHeight;
  const ordersY = (value: number) =>
    padTop + chartHeight - (value / maxOrders) * chartHeight;
  const orderPolyline = points
    .map((point, index) => `${xAt(index)},${ordersY(point.activeOrderCount)}`)
    .join(" ");
  const active = activeIndex === null ? null : points[activeIndex] || null;
  const activeX = activeIndex === null ? 0 : xAt(activeIndex);
  const tooltipWidth = 230;
  const tooltipHeight = 80;
  const tooltipX = Math.max(
    8,
    Math.min(width - tooltipWidth - 8, activeX - tooltipWidth / 2),
  );
  const tooltipY = 10;
  const labelEvery = points.length <= 10 ? 1 : Math.ceil(points.length / 7);

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-subtle p-3">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="min-w-[680px] text-text-muted"
          role="img"
          aria-label={`Giá trị đơn hàng và số đơn theo ngày cho ${currencyCode}`}
          onMouseLeave={() => setActiveIndex(null)}
        >
          <defs>
            <linearGradient
              id={`current-order-value-${currencyCode}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor="rgb(59 130 246)" />
              <stop offset="100%" stopColor="rgb(37 99 235)" />
            </linearGradient>
          </defs>

          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = padTop + chartHeight - ratio * chartHeight;
            return (
              <g key={ratio} aria-hidden="true">
                <line
                  x1={padLeft}
                  y1={y}
                  x2={width - padRight}
                  y2={y}
                  stroke="currentColor"
                  opacity={ratio === 0 ? "0.26" : "0.12"}
                  strokeDasharray={ratio === 0 ? undefined : "3 5"}
                />
                <text
                  x={padLeft - 9}
                  y={y + 4}
                  textAnchor="end"
                  fontSize="10"
                  fill="currentColor"
                >
                  {compactMoney(maxMoney * ratio, minorUnitExponent)}
                </text>
              </g>
            );
          })}

          {points.map((point, index) => {
            const x = xAt(index);
            const orderValueY = moneyY(point.currentOrderGrossValueMinor);
            const selected = activeIndex === index;
            return (
              <g
                key={point.localDate}
                data-chart-day={point.localDate}
                tabIndex={0}
                role="img"
                aria-label={`${fullDate(point.localDate)}: Giá trị đơn hàng ${formatMoney(point.currentOrderGrossValueMinor, currencyCode, minorUnitExponent)}, ${point.activeOrderCount} đơn trong ngày`}
                onClick={() => setActiveIndex(index)}
                onMouseEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onBlur={() => setActiveIndex(null)}
              >
                <title>{`${fullDate(point.localDate)} · Giá trị đơn hàng ${formatMoney(point.currentOrderGrossValueMinor, currencyCode, minorUnitExponent)} · ${point.activeOrderCount} đơn trong ngày`}</title>
                <rect
                  x={padLeft + slot * index}
                  y={padTop}
                  width={slot}
                  height={chartHeight + 32}
                  fill="transparent"
                />
                {selected ? (
                  <rect
                    x={padLeft + slot * index + 2}
                    y={padTop}
                    width={Math.max(0, slot - 4)}
                    height={chartHeight}
                    rx="6"
                    fill="currentColor"
                    opacity="0.06"
                  />
                ) : null}
                <rect
                  data-series="current-order-value"
                  x={x - barWidth / 2}
                  y={orderValueY}
                  width={barWidth}
                  height={Math.max(2, padTop + chartHeight - orderValueY)}
                  rx="4"
                  fill={`url(#current-order-value-${currencyCode})`}
                  opacity={activeIndex === null || selected ? "0.92" : "0.5"}
                />
                {index % labelEvery === 0 || index === points.length - 1 ? (
                  <text
                    x={x}
                    y={height - 22}
                    textAnchor="middle"
                    fontSize="10"
                    fill="currentColor"
                  >
                    {shortDate(point.localDate)}
                  </text>
                ) : null}
              </g>
            );
          })}

          <polyline
            points={orderPolyline}
            fill="none"
            stroke="rgb(217 119 6)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {points.map((point, index) => (
            <circle
              key={`${point.localDate}-orders`}
              cx={xAt(index)}
              cy={ordersY(point.activeOrderCount)}
              r={activeIndex === index ? "5" : "3.5"}
              fill="rgb(217 119 6)"
              stroke="white"
              strokeWidth="1.5"
              pointerEvents="none"
            />
          ))}

          {active ? (
            <g role="tooltip" pointerEvents="none">
              <line
                x1={activeX}
                y1={padTop}
                x2={activeX}
                y2={padTop + chartHeight}
                stroke="rgb(100 116 139)"
                strokeWidth="1"
                strokeDasharray="4 4"
                opacity="0.7"
              />
              <rect
                x={tooltipX}
                y={tooltipY}
                width={tooltipWidth}
                height={tooltipHeight}
                rx="10"
                fill="rgb(15 23 42)"
                opacity="0.96"
              />
              <text
                x={tooltipX + 14}
                y={tooltipY + 22}
                fontSize="12"
                fontWeight="700"
                fill="rgb(248 250 252)"
              >
                {fullDate(active.localDate)}
              </text>
              <text
                x={tooltipX + 14}
                y={tooltipY + 43}
                fontSize="11"
                fill="rgb(253 186 116)"
              >{`${active.activeOrderCount.toLocaleString("vi-VN")} đơn trong ngày`}</text>
              <text
                x={tooltipX + 14}
                y={tooltipY + 63}
                fontSize="11"
                fill="rgb(147 197 253)"
              >{`Giá trị đơn hàng: ${formatMoney(active.currentOrderGrossValueMinor, currencyCode, minorUnitExponent)}`}</text>
            </g>
          ) : null}
        </svg>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-text-muted">
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-4 rounded-sm bg-blue-600" />
          Giá trị đơn hàng
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-0.5 w-4 bg-status-warning" />
          Số đơn
        </span>
        <span className="ml-auto text-[11px]">
          Di chuột hoặc dùng Tab để xem từng ngày
        </span>
      </div>
    </div>
  );
}
