import { paginateListItems } from "@medusa-snus/ui";

export const DETAIL_PURCHASE_ORDER_PAGE_SIZE = 20;
export const RECEIVE_PURCHASE_ORDER_PAGE_SIZE = 10;

export type PurchaseOrderDetailLineFilter = "all" | "remaining" | "received";
export type PurchaseOrderReceiveLineFilter = "all" | "selected" | "unselected";

export interface PurchaseOrderSearchLine {
  id: string;
  sku?: string | null;
  variantId: string;
  productName?: string | null;
  categoryNames: string[];
  remainingQuantity: number;
  lineStatus: string;
}

export interface PurchaseOrderPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  start: number;
  end: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

function normalizeSearchValue(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLocaleLowerCase("vi-VN")
    .trim();
}

function positiveQuantity(raw?: string) {
  if (!raw?.trim()) return 0;
  const quantity = Number(raw);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
}

export function matchesPurchaseOrderLine(line: PurchaseOrderSearchLine, query: string) {
  const term = normalizeSearchValue(query);
  if (!term) return true;
  return normalizeSearchValue([
    line.sku || "",
    line.variantId,
    line.productName || "",
    ...line.categoryNames,
  ].join(" ")).includes(term);
}

export function filterPurchaseOrderDetailLines<T extends PurchaseOrderSearchLine>(
  lines: T[],
  query: string,
  filter: PurchaseOrderDetailLineFilter,
) {
  return lines.filter((line) => {
    if (!matchesPurchaseOrderLine(line, query)) return false;
    if (filter === "remaining") return line.remainingQuantity > 0;
    if (filter === "received") return line.remainingQuantity === 0;
    return true;
  });
}

export function filterPurchaseOrderReceiveLines<T extends PurchaseOrderSearchLine>(
  lines: T[],
  query: string,
  filter: PurchaseOrderReceiveLineFilter,
  quantities: Record<string, string>,
) {
  return lines.filter((line) => {
    if (line.remainingQuantity <= 0 || !matchesPurchaseOrderLine(line, query)) return false;
    const selected = positiveQuantity(quantities[line.id]) > 0;
    if (filter === "selected") return selected;
    if (filter === "unselected") return !selected;
    return true;
  });
}

export function paginatePurchaseOrderLines<T>(lines: T[], requestedPage: number, pageSize: number): PurchaseOrderPage<T> {
  return paginateListItems(lines, requestedPage, pageSize);
}

export function purchaseOrderReceiveSelectionSummary(
  lines: PurchaseOrderSearchLine[],
  quantities: Record<string, string>,
) {
  return lines.reduce((summary, line) => {
    if (line.remainingQuantity <= 0) return summary;
    const quantity = positiveQuantity(quantities[line.id]);
    if (quantity <= 0) return summary;
    return {
      selectedLineCount: summary.selectedLineCount + 1,
      selectedUnitCount: summary.selectedUnitCount + quantity,
    };
  }, { selectedLineCount: 0, selectedUnitCount: 0 });
}

export function fillPurchaseOrderPageRemaining<T extends PurchaseOrderSearchLine>(
  quantities: Record<string, string>,
  pageItems: T[],
) {
  const next = { ...quantities };
  for (const item of pageItems) {
    next[item.id] = item.remainingQuantity > 0 ? String(item.remainingQuantity) : "";
  }
  return next;
}

export function clearPurchaseOrderPageQuantities<T extends Pick<PurchaseOrderSearchLine, "id">>(
  quantities: Record<string, string>,
  pageItems: T[],
) {
  const next = { ...quantities };
  for (const item of pageItems) next[item.id] = "";
  return next;
}
