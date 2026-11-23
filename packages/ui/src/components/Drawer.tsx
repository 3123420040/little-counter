import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./Button";

export type DrawerProps = {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  headerActions?: ReactNode;
  actions?: ReactNode;
  size?: "default" | "wide";
  onClose: () => void;
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Drawer({ open, title, subtitle, children, headerActions, actions, size = "default", onClose }: DrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousActiveRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    previousActiveRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousActiveRef.current?.focus?.();
      previousActiveRef.current = null;
    };
  }, [open]);

  if (!open) return null;
  const widthClass = size === "wide" ? "max-w-[var(--context-panel-width-wide)]" : "max-w-[var(--context-panel-width)]";

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex justify-end bg-black/40"
      onClick={onClose}
    >
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`${widthClass} h-full w-full overflow-auto border-l border-border-default bg-surface-panel animate-slide-up`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border-default bg-surface-panel p-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-bold text-text-primary">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-text-muted">{subtitle}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
            <Button
              ref={closeRef}
              variant="ghost"
              size="sm"
              icon={<X size={16} />}
              aria-label="Đóng"
              onClick={onClose}
            />
          </div>
        </div>
        <div className="p-4">{children}</div>
        {actions && (
          <div className="sticky bottom-0 flex justify-end gap-2 border-t border-border-default bg-surface-panel p-4">
            {actions}
          </div>
        )}
      </aside>
    </div>
  );
}
