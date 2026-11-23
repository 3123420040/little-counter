import { useEffect } from "react";
import { localListPaginationMeta } from "@medusa-snus/ui";

/** Reconcile a requested server page only after its authoritative count arrives. */
export function useOffsetListPagination(
  total: number | undefined,
  requestedPage: number,
  pageSize: number,
  onPageChange: (page: number) => void,
) {
  const meta = localListPaginationMeta(total ?? 0, requestedPage, pageSize);
  const correcting = total !== undefined && requestedPage !== meta.page;
  useEffect(() => {
    if (correcting) onPageChange(meta.page);
  }, [correcting, meta.page, onPageChange]);
  return { meta, correcting };
}
