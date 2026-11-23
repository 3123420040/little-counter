import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./Button";

export type ListPaginationMeta = {
  page: number;
  start: number;
  end: number;
  hasPrevious: boolean;
  hasNext: boolean;
} & (
  | { totalKind: "exact"; total: number; pageCount: number }
  | { totalKind: "loaded"; loadedCount: number; pageCount: number; limited?: boolean }
  | { totalKind: "unknown" }
);

export type ExactListPaginationMeta = Extract<ListPaginationMeta, { totalKind: "exact" }> & { pageSize: number };

export type ListPaginationProps = {
  label: string;
  rowNoun: string;
  meta: ListPaginationMeta;
  busy?: boolean;
  onPageChange: (page: number) => void;
};

function wholeNumber(value: number, fallback: number, minimum: number) {
  return Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}

export function localListPaginationMeta(
  total: number,
  requestedPage: number,
  pageSize: number,
): ExactListPaginationMeta {
  const safeTotal = wholeNumber(total, 0, 0);
  const safePageSize = wholeNumber(pageSize, 1, 1);
  const pageCount = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const page = Math.min(pageCount, wholeNumber(requestedPage, 1, 1));
  const start = safeTotal === 0 ? 0 : (page - 1) * safePageSize + 1;
  const end = safeTotal === 0 ? 0 : Math.min(safeTotal, page * safePageSize);
  return {
    page,
    pageSize: safePageSize,
    start,
    end,
    hasPrevious: page > 1,
    hasNext: page < pageCount,
    totalKind: "exact",
    total: safeTotal,
    pageCount,
  };
}

/** Slice only a complete local array. Server responses must not be sliced again. */
export function paginateListItems<T>(items: readonly T[], requestedPage: number, pageSize: number) {
  const meta = localListPaginationMeta(items.length, requestedPage, pageSize);
  const offset = (meta.page - 1) * meta.pageSize;
  return { ...meta, items: items.slice(offset, offset + meta.pageSize) };
}

/**
 * Presentation metadata for a locally paged window whose upstream contract may
 * be capped. It deliberately does not turn the loaded-row count into a
 * purported global total.
 */
export function loadedListPaginationMeta(
  loadedCount: number,
  requestedPage: number,
  pageSize: number,
  limited = true,
): ListPaginationMeta & { pageSize: number } {
  const exact = localListPaginationMeta(loadedCount, requestedPage, pageSize);
  return {
    page: exact.page,
    pageSize: exact.pageSize,
    start: exact.start,
    end: exact.end,
    hasPrevious: exact.hasPrevious,
    hasNext: exact.hasNext,
    totalKind: "loaded",
    loadedCount: exact.total,
    pageCount: exact.pageCount,
    limited,
  };
}

export function ListPagination({
  label,
  rowNoun,
  meta,
  busy = false,
  onPageChange,
}: ListPaginationProps) {
  const range = meta.start === 0
    ? `Không có ${rowNoun} phù hợp`
    : meta.totalKind === "exact"
      ? `Hiển thị ${meta.start}–${meta.end} / ${meta.total} ${rowNoun}`
      : meta.totalKind === "loaded"
        ? `Hiển thị ${meta.start}–${meta.end} trong ${meta.loadedCount} ${rowNoun} đã tải${meta.limited ? " (kết quả bị giới hạn)" : ""}`
        : `Hiển thị ${meta.start}–${meta.end} ${rowNoun}`;
  const pageLabel = meta.totalKind === "unknown"
    ? `Trang ${meta.page}`
    : `Trang ${meta.page} / ${meta.pageCount}`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-default px-3.5 py-3 text-xs text-text-secondary" aria-label={label}>
      <span>{range}</span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" icon={<ChevronLeft size={14} aria-hidden="true" />} aria-label="Trang trước" disabled={busy || !meta.hasPrevious} onClick={() => onPageChange(meta.page - 1)}>Trước</Button>
        <span className="min-w-20 text-center tabular-nums" aria-live="polite">{pageLabel}</span>
        <Button variant="secondary" size="sm" icon={<ChevronRight size={14} aria-hidden="true" />} aria-label="Trang tiếp" disabled={busy || !meta.hasNext} onClick={() => onPageChange(meta.page + 1)}>Tiếp</Button>
      </div>
    </div>
  );
}
