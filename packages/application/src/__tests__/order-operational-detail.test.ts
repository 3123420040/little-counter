import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderOperationalDetailV1Schema } from "@medusa-snus/contracts";
import { operationalOrderFixture } from "../../../contracts/src/__fixtures__/order-operational-detail";
const getOrder = vi.hoisted(() => vi.fn());
vi.mock("../services/order-service", () => ({ getOrder }));
import { getOrderOperationalDetailV1 } from "../services/order-operational-detail-service";
const scope = { scopeKind: "report" as const, merchantId: "m-a", storeIds: ["s-a"] };
beforeEach(() => { getOrder.mockReset(); getOrder.mockResolvedValue({ order: operationalOrderFixture }); });

describe("versioned operational order detail", () => {
  it("reuses scoped payment/correction history and removes competing totals and unlisted metadata", async () => {
    getOrder.mockResolvedValue({ order: { ...operationalOrderFixture, total: 240320, items: [], metadata: { secret: "never-return" },
      stockAdjustments: [{ ...operationalOrderFixture.stockAdjustments[0], privateField: "never-return" }],
      corrections: [{ ...operationalOrderFixture.corrections[0], beforeTotals: { paymentFee: 4320 }, afterTotals: {}, privateField: "never-return" }] } });
    expect(await getOrderOperationalDetailV1("order/a", scope)).toEqual(operationalOrderFixture);
    expect(getOrder).toHaveBeenCalledExactlyOnceWith("order/a", scope, undefined, "orders.payment-fee.v1");
  });
  it("preserves cancellation access from the existing actual actor/operating scope check", async () => {
    const context = { actor: { operatorId: "owner-a", role: "owner", organizationId: "org-a" },
      scope: { scopeKind: "operating" as const, merchantId: "m-a", storeId: "s-a", stockLocationId: "l-a" } };
    await getOrderOperationalDetailV1("order/a", scope, context);
    expect(getOrder).toHaveBeenCalledExactlyOnceWith("order/a", scope, context, "orders.payment-fee.v1");
  });
  it.each([{ ...scope, merchantId: "" }, { ...scope, storeIds: [] }])("refuses an empty read scope before querying", async selected => {
    await expect(getOrderOperationalDetailV1("order/a", selected)).rejects.toThrow();expect(getOrder).not.toHaveBeenCalled();
  });
  it.each(["resource_not_found", "forbidden"])("preserves %s from the existing scoped read", async code => {
    const error = Object.assign(new Error(code), { code });getOrder.mockRejectedValue(error);
    await expect(getOrderOperationalDetailV1("order/a", scope)).rejects.toBe(error);
  });
  it.each([
    { ...operationalOrderFixture, schemaVersion: 2 }, { ...operationalOrderFixture, paymentEntries: undefined },
    { ...operationalOrderFixture, total: 240320 },
    { ...operationalOrderFixture, paymentEntries: [{ ...operationalOrderFixture.paymentEntries[0], amount: -1 }] },
    { ...operationalOrderFixture, paymentEntries: [{ ...operationalOrderFixture.paymentEntries[0], amount: Number.NaN }] },
    { ...operationalOrderFixture, paymentEntries: [{ ...operationalOrderFixture.paymentEntries[0], secret: "bad" }] },
  ])("refuses an unversioned or malformed transport DTO", value => {
    expect(OrderOperationalDetailV1Schema.safeParse(value).success).toBe(false);
  });
  it("preserves decimal amounts in the existing NUMERIC(14,2) legacy payment mirror", () => {
    const value = { ...operationalOrderFixture, paymentEntries: [{ ...operationalOrderFixture.paymentEntries[0], amount: 1.5 }] };
    expect(OrderOperationalDetailV1Schema.parse(value).paymentEntries[0]!.amount).toBe(1.5);
  });
});
