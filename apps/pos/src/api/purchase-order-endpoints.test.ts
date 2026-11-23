import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("./client", () => ({ api: client }));

import {
  createPurchaseOrder,
  fetchPurchaseOrderCatalog,
  fetchPurchaseOrderDetail,
  receivePurchaseOrder,
} from "./endpoints";

describe("purchase-order endpoint contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.get.mockResolvedValue({ data: [] });
    client.post.mockResolvedValue({ data: {} });
  });

  it("requests a deterministic bounded receipt-history page", async () => {
    await fetchPurchaseOrderDetail("po/31", { receiptLimit: 10, receiptOffset: 20 });

    expect(client.get).toHaveBeenCalledWith(
      "/api/inventory/purchase-orders/po%2F31?receiptLimit=10&receiptOffset=20",
    );
  });

  it("forwards catalog search, page and selected pins to the scoped server route", async () => {
    await fetchPurchaseOrderCatalog({
      q: "mint slim",
      limit: 25,
      offset: 100,
      selectedVariantIds: ["var_2", "var_1"],
    });

    expect(client.get).toHaveBeenCalledWith(
      "/api/inventory/purchase-orders/catalog?q=mint+slim&limit=25&offset=100&selectedVariantIds=var_2%2Cvar_1",
    );
  });

  it("uses the exact caller-owned receipt intent key on every retry", async () => {
    const body = { items: [{ purchaseOrderItemId: "poi_1", receivedQuantity: 1 }] };
    const intentKey = "po-receive-stable-intent";

    await receivePurchaseOrder("po_1", body, intentKey);
    await receivePurchaseOrder("po_1", body, intentKey);

    expect(client.post).toHaveBeenNthCalledWith(1, "/api/inventory/purchase-orders/po_1/receive", body, intentKey);
    expect(client.post).toHaveBeenNthCalledWith(2, "/api/inventory/purchase-orders/po_1/receive", body, intentKey);
  });

  it("uses the exact caller-owned create intent key on every retry", async () => {
    const body = {
      supplierName: "Stable supplier",
      items: [{
        variantId: "var_1",
        quantity: 2,
        unitCost: 100_000,
        unitCostQuality: "known" as const,
      }],
    };
    const intentKey = "po-create-stable-intent";

    await createPurchaseOrder(body, intentKey);
    await createPurchaseOrder(body, intentKey);

    expect(client.post).toHaveBeenNthCalledWith(1, "/api/inventory/purchase-orders", body, intentKey);
    expect(client.post).toHaveBeenNthCalledWith(2, "/api/inventory/purchase-orders", body, intentKey);
  });
});
