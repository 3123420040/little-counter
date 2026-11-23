import type { ReactNode } from "react";

export type PageHeaderProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
};

/**
 * Consistent page header: title on the left, actions on the right.
 * Used at the top of every back-office screen.
 */
export function PageHeader({ title, subtitle, status, actions }: PageHeaderProps) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-bold text-text-primary">{title}</h1>
        {subtitle && (
          <p className="mt-0.5 text-sm text-text-muted">{subtitle}</p>
        )}
        {status && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">{status}</div>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </div>
  );
}
