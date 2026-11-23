import { beforeEach, describe, expect, it, vi } from "vitest";
import { operationalOrderFixture } from "../../../../packages/contracts/src/__fixtures__/order-operational-detail";
const get = vi.hoisted(() => vi.fn());
vi.mock("./client", () => ({ api: { get } }));
import { fetchOrderOperationalDetailV1 } from "./endpoints";
const scope = { merchantId: "m-a", storeIds: ["s-a"] };
beforeEach(() => { get.mockReset();get.mockResolvedValue({ order: operationalOrderFixture }); });
describe("operational order transport", () => {
  it("uses the encoded versioned route, captured scope and abort signal", async () => {
    const controller = new AbortController();
    expect(await fetchOrderOperationalDetailV1("order/a", scope, controller.signal)).toEqual(operationalOrderFixture);
    expect(get).toHaveBeenCalledExactlyOnceWith("/api/platform/admin/orders/order%2Fa/operational-v1", { "x-report-merchant-id": "m-a", "x-report-store-ids": "s-a" }, controller.signal);
  });
  it.each(["id", "merchantId", "storeId"])("rejects mismatched %s without fallback", async field => {
    get.mockResolvedValue({ order: { ...operationalOrderFixture, [field]: "foreign" } });
    await expect(fetchOrderOperationalDetailV1("order/a", scope)).rejects.toThrow("không khớp");expect(get).toHaveBeenCalledOnce();
  });
  it.each([{ ...operationalOrderFixture, schemaVersion: 2 }, { ...operationalOrderFixture, paymentEntries: undefined }, { ...operationalOrderFixture, total: 1 }])("rejects a malformed response", async order => {
    get.mockResolvedValue({ order });await expect(fetchOrderOperationalDetailV1("order/a", scope)).rejects.toThrow();expect(get).toHaveBeenCalledOnce();
  });
  it("does not fall back to legacy detail after an HTTP error", async () => {
    const error = new Error("unsupported operational read");get.mockRejectedValue(error);
    await expect(fetchOrderOperationalDetailV1("order/a", scope)).rejects.toBe(error);expect(get).toHaveBeenCalledOnce();
  });
  it.each([{ merchantId: "", storeIds: ["s-a"] }, { merchantId: "m-a", storeIds: [] }])("requires a bounded report scope", async selected => {
    await expect(fetchOrderOperationalDetailV1("order/a", selected)).rejects.toThrow();expect(get).not.toHaveBeenCalled();
  });
});
