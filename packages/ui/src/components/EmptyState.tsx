import type { ReactNode } from "react";

export type EmptyStateProps = {
  title: string;
  body?: string;
  description?: string;
  /** Optional icon component (e.g., from lucide-react) */
  icon?: ReactNode;
  /** Optional action button */
  action?: ReactNode;
};

/**
 * Placeholder shown when a list/table has no data.
 *
 * @example
 * <EmptyState
 *   title="Chưa có đơn hàng"
 *   body="Đơn hàng sẽ xuất hiện ở đây sau khi bán hàng."
 *   icon={<Package size={24} />}
 *   action={<button>Tạo đơn đầu tiên</button>}
 * />
 */
export function EmptyState({ title, body, description, icon, action }: EmptyStateProps) {
  const message = body ?? description;

  return (
    <div className="min-h-[140px] grid place-content-center justify-items-center gap-1 text-center py-4 px-4 text-text-muted">
      {icon && <div className="text-text-muted mb-2">{icon}</div>}
      <strong className="text-text-secondary text-sm">{title}</strong>
      {message && <span className="text-xs">{message}</span>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
