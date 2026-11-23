import type { ReactNode } from "react";

export type TopbarProps = {
  /** Page title */
  title: string;
  /** Status pills shown below title */
  statusIndicators?: ReactNode;
  /** Actions on the right side (search, buttons) */
  actions?: ReactNode;
};

/**
 * Page header with title, status row, and action buttons.
 *
 * @example
 * <Topbar
 *   title="Bán hàng"
 *   statusIndicators={<>
 *     <StatusPill label="KB active" tone="success" />
 *     <StatusPill label="AI draft-only" tone="info" />
 *   </>}
 *   actions={<>
 *     <SearchBox value={q} onChange={setQ} />
 *     <Button icon={<RefreshCcw size={15} />} variant="ghost" />
 *   </>}
 * />
 */
export function Topbar({ title, statusIndicators, actions }: TopbarProps) {
  return (
    <>
      <div className="min-w-0">
        <h1 className="text-lg font-bold text-text-primary">{title}</h1>
        {statusIndicators && (
          <div className="flex gap-1.5 flex-wrap mt-2">{statusIndicators}</div>
        )}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </>
  );
}
