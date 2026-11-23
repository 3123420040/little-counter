import type { ReactNode } from "react";

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

export type StatusPillProps = {
  label: string;
  tone?: StatusTone;
  icon?: ReactNode;
  className?: string;
};

const TONES: Record<StatusTone, string> = {
  neutral: "border-border-default bg-surface-subtle text-text-secondary",
  success: "border-status-success-border bg-status-success-bg text-status-success",
  warning: "border-status-warning-border bg-status-warning-bg text-status-warning",
  danger:  "border-status-danger-border bg-status-danger-bg text-status-danger",
  info:    "border-status-info-border bg-status-info-bg text-status-info",
};

/**
 * Inline status indicator — the most reused component in the system.
 * Used in tables, dashboards, detail views, and anywhere a status needs to be shown.
 *
 * @example
 * <StatusPill label="Active" tone="success" />
 * <StatusPill label="Pending" tone="warning" />
 */
export function StatusPill({ label, tone = "neutral", icon, className }: StatusPillProps) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1 max-w-full px-2 py-0.5",
        "rounded-full text-xs leading-4 whitespace-nowrap border",
        "min-h-[22px]",
        TONES[tone] || TONES.neutral,
        className ?? "",
      ].filter(Boolean).join(" ")}
    >
      {icon}
      {label}
    </span>
  );
}
