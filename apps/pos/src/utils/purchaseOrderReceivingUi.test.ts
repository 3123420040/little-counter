import { describe, expect, it } from "vitest";
import {
  clearPurchaseOrderPageQuantities,
  DETAIL_PURCHASE_ORDER_PAGE_SIZE,
  fillPurchaseOrderPageRemaining,
  filterPurchaseOrderDetailLines,
  filterPurchaseOrderReceiveLines,
  paginatePurchaseOrderLines,
  purchaseOrderReceiveSelectionSummary,
  RECEIVE_PURCHASE_ORDER_PAGE_SIZE,
} from "./purchaseOrderReceivingUi";

function line(index: number, overrides: Partial<ReturnType<typeof baseLine>> = {}) {
  return { ...baseLine(index), ...overrides };
}

function baseLine(index: number) {
  return {
    id: `poi-${index}`,
    sku: `SKU-${String(index).padStart(2, "0")}`,
    variantId: `variant-${index}`,
    productName: index === 2 ? "Cà phê sữa" : `Product ${index}`,
    categoryNames: index % 2 === 0 ? ["Nhóm Đặc Biệt"] : ["General"],
    remainingQuantity: index % 5 === 0 ? 0 : 20,
    lineStatus: index % 5 === 0 ? "received" : "not_received",
  };
}

describe("large purchase-order receiving presentation", () => {
  const lines = Array.from({ length: 31 }, (_, index) => line(index + 1));

  it("searches SKU, product and category case/accent-insensitively", () => {
    expect(filterPurchaseOrderDetailLines(lines, "sku-03", "all").map((item) => item.id)).toEqual(["poi-3"]);
    expect(filterPurchaseOrderDetailLines(lines, "CA PHE SUA", "all").map((item) => item.id)).toEqual(["poi-2"]);
    expect(filterPurchaseOrderDetailLines(lines, "nhom dac biet", "all").length).toBe(15);
  });

  it("filters remaining and fully received lines exactly", () => {
    const remaining = filterPurchaseOrderDetailLines(lines, "", "remaining");
    const received = filterPurchaseOrderDetailLines(lines, "", "received");

    expect(remaining).toHaveLength(25);
    expect(remaining.every((item) => item.remainingQuantity > 0)).toBe(true);
    expect(received).toHaveLength(6);
    expect(received.every((item) => item.remainingQuantity === 0)).toBe(true);
  });

  it("paginates 31 lines without omission or duplication and clamps invalid pages", () => {
    const first = paginatePurchaseOrderLines(lines, 1, DETAIL_PURCHASE_ORDER_PAGE_SIZE);
    const second = paginatePurchaseOrderLines(lines, 2, DETAIL_PURCHASE_ORDER_PAGE_SIZE);
    const clamped = paginatePurchaseOrderLines(lines, 99, DETAIL_PURCHASE_ORDER_PAGE_SIZE);

    expect(first).toMatchObject({ page: 1, pageCount: 2, total: 31, start: 1, end: 20, hasPrevious: false, hasNext: true });
    expect(second).toMatchObject({ page: 2, pageCount: 2, total: 31, start: 21, end: 31, hasPrevious: true, hasNext: false });
    expect(clamped.page).toBe(2);
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(lines.map((item) => item.id));
  });

  it("keeps receive selection global while filtering selected and unselected work", () => {
    const quantities = { "poi-1": "2", "poi-12": "3", "poi-25": "4" };
    const selected = filterPurchaseOrderReceiveLines(lines, "", "selected", quantities);
    const unselected = filterPurchaseOrderReceiveLines(lines, "", "unselected", quantities);
    const summary = purchaseOrderReceiveSelectionSummary(lines, quantities);

    expect(selected.map((item) => item.id)).toEqual(["poi-1", "poi-12"]);
    expect(unselected).toHaveLength(23);
    expect(summary).toEqual({ selectedLineCount: 2, selectedUnitCount: 5 });
  });

  it("uses ten-line receive pages and fill/clear changes only the visible page", () => {
    const remaining = filterPurchaseOrderReceiveLines(lines, "", "all", {});
    const first = paginatePurchaseOrderLines(remaining, 1, RECEIVE_PURCHASE_ORDER_PAGE_SIZE);
    const second = paginatePurchaseOrderLines(remaining, 2, RECEIVE_PURCHASE_ORDER_PAGE_SIZE);
    let quantities = fillPurchaseOrderPageRemaining({ "poi-13": "7" }, first.items);

    expect(first).toMatchObject({ page: 1, pageCount: 3, start: 1, end: 10 });
    expect(second).toMatchObject({ page: 2, pageCount: 3, start: 11, end: 20 });
    expect(first.items.every((item) => quantities[item.id] === "20")).toBe(true);
    expect(quantities["poi-13"]).toBe("7");

    quantities = clearPurchaseOrderPageQuantities(quantities, first.items);
    expect(first.items.every((item) => quantities[item.id] === "")).toBe(true);
    expect(quantities["poi-13"]).toBe("7");
  });
});
