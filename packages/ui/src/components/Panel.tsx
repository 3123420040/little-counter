import type { ReactNode } from "react";

export type PanelProps = {
  /** Panel title shown in the header */
  title: string;
  /** Optional action element (button, link) placed in the header right */
  action?: ReactNode;
  /** Panel content */
  children: ReactNode;
  /** Optional className for the panel wrapper */
  className?: string;
};

/**
 * Standard content container with header + body.
 * Used for every card/section in the system — tables, forms, detail views, dashboards.
 *
 * @example
 * <Panel title="Order Board" action={<button>New</button>}>
 *   <OperationalTable ... />
 * </Panel>
 */
export function Panel({ title, action, children, className }: PanelProps) {
  return (
    <section
      className={[
        "bg-surface-panel border border-border-default rounded-lg overflow-hidden",
        className ?? "",
      ].filter(Boolean).join(" ")}
      aria-label={title}
    >
      <div className="min-h-[48px] px-3.5 py-3 flex justify-between items-center border-b border-border-default">
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
