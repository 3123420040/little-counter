import type { ReactNode } from "react";
import { ListPagination, type ListPaginationProps } from "./ListPagination";

export type PaginatedListFrameProps = ListPaginationProps & {
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  showPagination?: boolean;
  loading?: boolean;
  loadingContent?: ReactNode;
  errorContent?: ReactNode;
};

/** Shared body/footer composition. Fetching, filtering and draft state stay with the caller. */
export function PaginatedListFrame({
  children,
  className,
  bodyClassName,
  showPagination = true,
  loading = false,
  loadingContent,
  errorContent,
  busy = false,
  ...pagination
}: PaginatedListFrameProps) {
  const navigationBusy = busy || loading || Boolean(errorContent);
  return (
    <div className={["min-w-0", className].filter(Boolean).join(" ")} aria-busy={navigationBusy} data-paginated-list-frame="">
      <div className={["min-w-0", bodyClassName].filter(Boolean).join(" ")} data-list-body="">
        {errorContent ?? (loading && loadingContent !== undefined ? loadingContent : children)}
      </div>
      {showPagination && <ListPagination {...pagination} busy={navigationBusy} />}
    </div>
  );
}
