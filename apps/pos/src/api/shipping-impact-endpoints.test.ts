import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn() }));
vi.mock("./client", () => ({ api: client }));

import { previewOrderShipping, updateOrderShipping } from "./endpoints";

describe("shipping impact endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.post.mockResolvedValue({ data: {} });
    client.patch.mockResolvedValue({ order: {} });
  });

  it("previews through the scoped route without an idempotency mutation key", async () => {
    const input = {
      shippingFee: 50_000,
      reason: "Bổ sung phí giao hàng theo xác nhận của khách.",
      paymentMethod: "cash",
    };
    await previewOrderShipping("order/1", input);
    expect(client.post).toHaveBeenCalledWith(
      "/api/platform/admin/orders/order%2F1/shipping/preview",
      input,
    );
  });

  it("binds apply idempotency to the reviewed confirmation token", async () => {
    const input = {
      shippingFee: 50_000,
      reason: "Bổ sung phí giao hàng theo xác nhận của khách.",
      paymentMethod: "cash",
      confirmationToken: "shipping-token-1",
    };
    await updateOrderShipping("order/1", input);
    expect(client.patch).toHaveBeenCalledWith(
      "/api/platform/admin/orders/order%2F1/shipping",
      input,
      "order-shipping:shipping-token-1",
    );
  });
});
