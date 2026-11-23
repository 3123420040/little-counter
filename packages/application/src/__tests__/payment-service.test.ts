import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "../db/client";
import { PaymentEntryCompatibilityPolicyErrorV1 } from "../services/payment-entry-compatibility-policy";
import {
  getRefundablePaymentBalance,
  isExternalProviderPaymentMethod,
  paymentAccountForMethod,
  paymentStatusForChargeMethod,
  recordOrderRefund,
  recordSaleCharge,
} from "../services/payment-service";

function makeClient() {
  const query = vi.fn(async (_sql: string, _params: unknown[]) => ({
    rows: [{
      id: "2c9b5d2e-5a3d-4fd4-9e63-863ecf11a5e6",
      organization_id: "org_default",
      order_id: "order_1",
      direction: "charge",
      method: "cash",
      amount: "250000.00",
      currency_code: "vnd",
      status: "posted",
      reference: "ORD-1",
      reason: null,
      metadata: { source: "pos", orderNumber: "ORD-1" },
      created_by: "op_owner",
      created_at: "2026-06-14T00:00:00.000Z",
    }],
  }));
  return { query, client: { query } as unknown as PoolClient };
}

describe("payment service", () => {
  it("records a posted POS charge ledger entry for paid methods", async () => {
    const { client, query } = makeClient();

    const entry = await recordSaleCharge(client, {
      orderId: "order_1",
      orderNumber: "ORD-1",
      merchantId: "merchant_a",
      storeId: "store_a",
      method: "cash",
      amount: 250000,
      amountReceived: 300000,
      change: 50000,
      subtotal: 250000,
      discount: 0,
      tax: 22727,
      source: "pos",
      createdBy: "op_owner",
    }, {
      boundary: "order_created",
      canonicalCharge: {
        enabled: true,
        kind: "recorded",
        outcome: "inserted",
        obligationId: "00000000-0000-4000-8000-000000000201",
        paymentEventId: "00000000-0000-4000-8000-000000000301",
        amountMinor: 250000,
        status: "posted",
        method: "cash",
      },
    });

    expect(entry.amount).toBe(250000);
    expect(entry.status).toBe("posted");
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("INSERT INTO app.payment_entries");
    expect(params.slice(0, 10)).toEqual([
      "org_default",
      "order_1",
      "merchant_a",
      "store_a",
      "charge",
      "cash",
      250000,
      "vnd",
      "posted",
      "ORD-1",
    ]);
    expect(JSON.parse(String(params[11]))).toMatchObject({
      source: "pos",
      orderNumber: "ORD-1",
      amountReceived: 300000,
      change: 50000,
    });
  });

  it("keeps the legacy COD helper pending while canonical creation owns immediate posting", () => {
    expect(paymentStatusForChargeMethod("cod")).toBe("pending");
    expect(paymentStatusForChargeMethod("bank_transfer")).toBe("posted");
  });

  it("mirrors the canonical COD status and identity only when compatibility is enabled", async () => {
    const { client, query } = makeClient();
    await recordSaleCharge(client, {
      orderId: "order_1",
      orderNumber: "ORD-1",
      merchantId: "merchant_a",
      storeId: "store_a",
      method: "cod",
      amount: 250000,
      amountReceived: 0,
      change: 0,
      subtotal: 250000,
      discount: 0,
      tax: 22727,
      source: "remote",
      createdBy: "op_owner",
    }, {
      config: { enabled: true },
      boundary: "order_created",
      canonicalCharge: {
        enabled: true,
        kind: "recorded",
        outcome: "inserted",
        obligationId: "00000000-0000-4000-8000-000000000201",
        paymentEventId: "00000000-0000-4000-8000-000000000301",
        amountMinor: 250000,
        status: "posted",
        method: "cod",
      },
    });

    const [, params] = query.mock.calls[0];
    expect(params[8]).toBe("posted");
    expect(JSON.parse(String(params[11]))).toMatchObject({
      compatibilityVersion: 1,
      canonicalPaymentEventId: "00000000-0000-4000-8000-000000000301",
      financialAggregateSource: "app.payment_events",
    });
  });

  it("fails before legacy SQL if compatibility lacks canonical proof", async () => {
    const { client, query } = makeClient();
    await expect(recordSaleCharge(client, {
      orderId: "order_1",
      orderNumber: "ORD-1",
      merchantId: "merchant_a",
      storeId: "store_a",
      method: "cod",
      amount: 250000,
      amountReceived: 0,
      change: 0,
      subtotal: 250000,
      discount: 0,
      tax: 22727,
      source: "remote",
      createdBy: "op_owner",
    }, {
      config: { enabled: true },
      boundary: "order_created",
      canonicalCharge: { enabled: false, status: "disabled" },
    })).rejects.toThrow("canonical charge proof is required");
    expect(query).not.toHaveBeenCalled();
  });

  it("identifies external provider methods that must use payment intents", () => {
    expect(isExternalProviderPaymentMethod("sepay_va")).toBe(true);
    expect(isExternalProviderPaymentMethod("nowpayments")).toBe(true);
    expect(isExternalProviderPaymentMethod("cash")).toBe(false);
  });

  it("maps payment methods to accounting asset accounts explicitly", () => {
    expect(paymentAccountForMethod("cash")).toBe("1111");
    expect(paymentAccountForMethod("bank_transfer")).toBe("1121");
    expect(paymentAccountForMethod("sepay_va")).toBe("1121");
    expect(paymentAccountForMethod("nowpayments")).toBe("1121");
    expect(paymentAccountForMethod("crypto_usdc")).toBe("1122");
    expect(paymentAccountForMethod("crypto_usdt")).toBe("1122");
    expect(paymentAccountForMethod("cod")).toBe("1311");
    expect(paymentAccountForMethod("unknown")).toBe("1111");
  });

  it("records remote charge metadata for channel reconciliation", async () => {
    const { client, query } = makeClient();

    await recordSaleCharge(client, {
      orderId: "order_remote_1",
      orderNumber: "ORD-REMOTE-1",
      merchantId: "merchant_a",
      storeId: "store_a",
      method: "cod",
      amount: 480000,
      amountReceived: 0,
      change: 0,
      subtotal: 480000,
      discount: 0,
      tax: 43636,
      source: "remote",
      createdBy: "op_manager",
      metadata: {
        remoteStatus: "confirmed",
        channel: "telegram",
        channelUserId: "123456789",
      },
    }, {
      boundary: "order_created",
      canonicalCharge: {
        enabled: true,
        kind: "recorded",
        outcome: "inserted",
        obligationId: "00000000-0000-4000-8000-000000000202",
        paymentEventId: "00000000-0000-4000-8000-000000000302",
        amountMinor: 480000,
        status: "posted",
        method: "cod",
      },
    });

    const [, params] = query.mock.calls[0];
    expect(params[8]).toBe("posted");
    expect(JSON.parse(String(params[11]))).toMatchObject({
      source: "remote",
      remoteStatus: "confirmed",
      channel: "telegram",
      channelUserId: "123456789",
      canonicalPaymentEventId: "00000000-0000-4000-8000-000000000302",
      financialAggregateSource: "app.payment_events",
    });
  });

  it("rejects invalid payment amounts before writing", async () => {
    const { client, query } = makeClient();

    await expect(recordSaleCharge(client, {
      orderId: "order_1",
      orderNumber: "ORD-1",
      merchantId: "merchant_a",
      storeId: "store_a",
      method: "cash",
      amount: 0,
      amountReceived: 0,
      change: 0,
      subtotal: 0,
      discount: 0,
      tax: 0,
      source: "pos",
      createdBy: "op_owner",
    })).rejects.toBeInstanceOf(PaymentEntryCompatibilityPolicyErrorV1);

    expect(query).not.toHaveBeenCalled();
  });

  it("calculates refundable balance from posted charges and refunds", async () => {
    const query = vi.fn(async () => ({
      rows: [{ charged: "500000.00", refunded: "125000.00" }],
    }));
    const client = { query } as unknown as PoolClient;

    await expect(getRefundablePaymentBalance(client, "order_1")).resolves.toEqual({
      charged: 500000,
      refunded: 125000,
      refundable: 375000,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM app.payment_entries"), ["order_1"]);
  });

  it("records refunds as immutable posted ledger entries", async () => {
    const { client, query } = makeClient();

    await recordOrderRefund(client, {
      orderId: "order_1",
      orderNumber: "ORD-1",
      merchantId: "merchant_a",
      storeId: "store_a",
      amount: 125000,
      reason: "Customer returned one item",
      createdBy: "op_owner",
      metadata: { restock: false },
    });

    const [, params] = query.mock.calls[0];
    expect(params.slice(1, 11)).toEqual([
      "order_1",
      "merchant_a",
      "store_a",
      "refund",
      "refund",
      125000,
      "vnd",
      "posted",
      "ORD-1",
      "Customer returned one item",
    ]);
    expect(JSON.parse(String(params[11]))).toMatchObject({
      orderNumber: "ORD-1",
      restock: false,
    });
  });
});
