import type { KeyboardEvent, ReactNode } from "react";
import { EmptyState } from "./EmptyState";

export type OperationalTableColumn = {
  key: string;
  label: string;
  align?: "left" | "center" | "right";
  width?: number | string;
  className?: string;
  sticky?: "left" | "right";
};

export type OperationalTableProps = {
  /** Column definitions */
  columns: Array<OperationalTableColumn | string>;
  /** Row data — array of objects OR array of arrays */
  rows: Array<Record<string, ReactNode> | ReactNode[]>;
  hoverable?: boolean;
  onRowClick?: (row: Record<string, ReactNode> | ReactNode[] | number, rowIndex?: number) => void;
  selectedRowIndex?: number | null;
  minWidth?: number;
  emptyTitle?: string;
  emptyBody?: string;
  empty?: ReactNode;
  ariaLabel?: string;
};

/**
 * Standard data table used across all list views.
 * Accepts rows as objects keyed by column key. Table CSS lives in app.css.
 *
 * @example
 * <OperationalTable
 *   columns={[{ key: "id", label: "Mã" }, { key: "name", label: "Tên" }]}
 *   rows={[{ id: "001", name: "Mint" }, { id: "002", name: "Citrus" }]}
 * />
 */
export function OperationalTable({
  columns,
  rows,
  onRowClick,
  selectedRowIndex,
  minWidth = 760,
  emptyTitle = "Không có dữ liệu",
  emptyBody = "Chưa có bản ghi nào phù hợp.",
  empty,
  ariaLabel,
}: OperationalTableProps) {
  const normalizedColumns = columns.map((col, index) =>
    typeof col === "string" ? { key: String(index), label: col } : col
  );
  const safeRows = Array.isArray(rows) ? rows : [];
  const columnClassName = (column: OperationalTableColumn) => [
    column.className,
    column.sticky === "left" ? "snus-table-sticky-left" : "",
    column.sticky === "right" ? "snus-table-sticky-right" : "",
  ].filter(Boolean).join(" ") || undefined;
  if (safeRows.length === 0) {
    if (empty) return <>{empty}</>;
    return <EmptyState title={emptyTitle} body={emptyBody} />;
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLTableRowElement>,
    row: Record<string, ReactNode> | ReactNode[],
    rowIdx: number,
  ) {
    if (!onRowClick) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onRowClick(row, rowIdx);
  }

  return (
    <div className="snus-table-wrap">
      <table className="snus-table" style={{ minWidth }} aria-label={ariaLabel}>
        <thead>
          <tr>
            {normalizedColumns.map((col) => (
              <th
                key={col.key}
                style={{ width: col.width, textAlign: col.align }}
                className={columnClassName(col)}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {safeRows.map((row, rowIdx) => (
            <tr
              key={rowIdx}
              data-clickable={!!onRowClick}
              data-selected={selectedRowIndex === rowIdx}
              aria-selected={selectedRowIndex === rowIdx ? "true" : undefined}
              role={onRowClick ? "button" : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(row, rowIdx) : undefined}
              onKeyDown={(event) => handleKeyDown(event, row, rowIdx)}
            >
              {normalizedColumns.map((col, cellIdx) => (
                <td
                  key={`${rowIdx}-${cellIdx}`}
                  style={{ textAlign: col.align }}
                  className={columnClassName(col)}
                >
                  {Array.isArray(row) ? row[cellIdx] : row[col.key] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
