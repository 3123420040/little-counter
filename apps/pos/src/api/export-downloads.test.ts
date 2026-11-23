// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ rawGet: vi.fn(), post: vi.fn() }));

vi.mock("./client", () => ({ api: client }));

import {
  csvDownloadEndpoint,
  applyImport,
  downloadCsvResource,
  downloadOrderExportCsv,
  downloadPurchaseOrderDetailCsv,
  downloadPurchaseOrderRecommendationCsv,
  importApplyIdempotencyKey,
} from "./endpoints";

describe("CSV export endpoint mapping", () => {
  beforeEach(() => {
    const body = "schema_version,order_id,payment_methods\r\n4,order-1,cash\r\n";
    const asOf = new Date(Math.floor(Date.now() / 1_000) * 1_000).toISOString();
    const downloadInstant = asOf.replace(/[-:]/g, "").replace(".000", "");
    client.rawGet.mockResolvedValue(new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="orders-effective-order-${downloadInstant}.csv"`,
        "Content-Length": String(new TextEncoder().encode(body).byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Order-Export-Contract": "orders.effective-order.v4",
        "X-Order-Export-Grain": "order",
        "X-Order-Export-As-Of": asOf,
        "X-Order-Export-Revision-SHA256": "a".repeat(64),
        "X-Order-Export-Order-Count": "1",
        "X-Order-Export-Row-Count": "1",
      },
    }));
    client.post.mockResolvedValue({ data: {} });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:csv"),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["products", "export", "/api/platform/admin/products/export"],
    ["products", "template", "/api/platform/admin/products/import-template"],
    ["categories", "export", "/api/platform/admin/product-categories/export"],
    ["categories", "template", "/api/platform/admin/product-categories/import-template"],
    ["inventory", "export", "/api/inventory/export"],
    ["inventory", "template", "/api/inventory/import-template"],
    ["purchaseOrders", "export", "/api/inventory/purchase-orders/export"],
    ["purchaseOrders", "template", "/api/inventory/purchase-orders/import-template"],
  ] as const)("maps %s %s to %s", (resource, kind, endpoint) => {
    expect(csvDownloadEndpoint(resource, kind).path).toBe(endpoint);
  });

  it("requests the mapped endpoint through the authenticated raw client", async () => {
    await downloadCsvResource("inventory", "template");

    expect(client.rawGet).toHaveBeenCalledWith("/api/inventory/import-template");
  });

  it("requests the order export endpoint with the active filter query", async () => {
    await downloadOrderExportCsv({
      dateFrom: "2026-06-01",
      dateTo: "2026-06-25",
      status: "completed",
      search: "ICEBERG black fury",
    });

    expect(client.rawGet).toHaveBeenCalledWith(
      "/api/platform/admin/orders/export-effective-v4?from=2026-06-01&to=2026-06-25&status=completed&search=ICEBERG+black+fury&grain=order",
    );
  });

  it("requests purchase order recommendation export with explicit boolean query", async () => {
    await downloadPurchaseOrderRecommendationCsv({ coverageDays: 30, includeZeroSuggestion: false });

    expect(client.rawGet).toHaveBeenCalledWith(
      "/api/inventory/purchase-orders/recommendation/export?coverageDays=30&includeZeroSuggestion=false",
    );
  });

  it("requests purchase order detail export with encoded id", async () => {
    await downloadPurchaseOrderDetailCsv("po/1");

    expect(client.rawGet).toHaveBeenCalledWith("/api/inventory/purchase-orders/po%2F1/export");
  });

  it.each([
    ["products", "/api/platform/admin/products/import/apply"],
    ["categories", "/api/platform/admin/product-categories/import/apply"],
    ["inventory", "/api/inventory/import/apply"],
    ["purchaseOrders", "/api/inventory/purchase-orders/import/apply"],
  ] as const)("binds %s apply to the preview identity", async (resource, endpoint) => {
    await applyImport(resource, "header\r\nvalue\r\n", "imp_preview_123");
    expect(client.post).toHaveBeenCalledWith(
      endpoint,
      { csv: "header\r\nvalue\r\n" },
      `import:${resource}:imp_preview_123`,
    );
  });

  it("normalizes ambiguous retries and rejects an empty preview identity", () => {
    expect(importApplyIdempotencyKey("inventory", " imp_retry_1 ")).toBe("import:inventory:imp_retry_1");
    expect(importApplyIdempotencyKey("inventory", "imp_retry_1")).toBe("import:inventory:imp_retry_1");
    expect(() => importApplyIdempotencyKey("inventory", " ")).toThrow("Import preview ID is required");
  });
});
