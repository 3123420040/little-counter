import type { ReactNode } from "react";
import type { StatusTone } from "./StatusPill";

export type MetricCellProps = {
  label: string;
  value: ReactNode;
  tone?: StatusTone;
  icon?: ReactNode;
  /** Optional: show delta/trend indicator (e.g., "+12%") */
  delta?: string;
};

const TONE_BORDER_TOP: Record<string, string> = {
  neutral: "border-t-border-default",
  success: "border-t-status-success",
  warning: "border-t-status-warning",
  danger:  "border-t-status-danger",
  info:    "border-t-status-info",
};

/**
 * KPI card used in dashboards and analytics.
 * Shows a label + large value with optional trend indicator.
 * Uses top-border accent (not left-border side-tab — that pattern is an AI tell).
 *
 * @example
 * <MetricCell label="Doanh thu hôm nay" value="12.5M" tone="success" delta="+15%" />
 */
export function MetricCell({ label, value, tone = "neutral", icon, delta }: MetricCellProps) {
  return (
    <div
      className={[
        "min-h-[68px] border border-border-default rounded-lg bg-surface-panel",
        "p-2.5 grid gap-1",
        "border-t-[3px]",
        TONE_BORDER_TOP[tone] || TONE_BORDER_TOP.neutral,
      ].join(" ")}
    >
      <div className="flex items-center gap-2">
        {icon && <span className="text-text-muted inline-flex">{icon}</span>}
        <span className="text-xs text-text-muted">{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <strong className="text-[22px] leading-7 font-bold tabular-nums text-text-primary">
          {value}
        </strong>
        {delta && <span className="text-xs text-text-muted">{delta}</span>}
      </div>
    </div>
  );
}
