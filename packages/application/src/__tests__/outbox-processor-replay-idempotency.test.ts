import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  client: { query: vi.fn() },
  ensurePlatformSchema: vi.fn(),
  insertJournalEntryForClient: vi.fn(),
  handleProductOnReadySchema: vi.fn(),
  journalExists: false,
  cancellationJournalExists: false,
  loyaltyExists: false,
  profileOrderCount: 0,
  profileTotal: 0,
}));

vi.mock("../db/schema", () => ({
  ensurePlatformSchema: harness.ensurePlatformSchema,
}));

vi.mock("../db/transaction", () => ({
  withConnectedTransaction: vi.fn(async (
    handler: (client: typeof harness.client) => Promise<unknown>,
  ) => handler(harness.client)),
}));

vi.mock("../services/accounting-service", () => ({
  insertJournalEntryForClient: harness.insertJournalEntryForClient,
}));

vi.mock("../services/ai-service", () => ({
  buildLoyaltyRecommendations: vi.fn(() => []),
  syncInventoryAlertForStockChange: vi.fn(),
  upsertAiActionForClient: vi.fn(),
}));

vi.mock("../services/customer-service", () => ({
  getLoyaltyTiersForClient: vi.fn(async () => []),
}));

vi.mock("../services/refund-accounting-service", () => ({
  handleRefundCreated: vi.fn(),
}));

vi.mock("../services/telegram-notification-service", () => ({
  handleTelegramNotificationRequested: vi.fn(),
}));

vi.mock("../services/telegram-notification-router-service", () => ({
  routeTelegramNotificationEvent: vi.fn(),
}));

vi.mock("../services/payment-service", () => ({
  paymentAccountForMethod: vi.fn(() => "1111"),
}));

vi.mock("../services/crypto-treasury-service", () => ({
  persistCryptoReceiptEvidenceFromSaleForClient: vi.fn(),
}));

vi.mock("../services/product-image-autofill-service", () => ({
  handleProductImageAutofillRequested: vi.fn(),
  handleProductImageAutofillRequestedOnReadySchema: harness.handleProductOnReadySchema,
  PRODUCT_IMAGE_AUTOFILL_EVENT: "product.image_autofill_requested",
}));

vi.mock("../services/vision-learning-service", () => ({
  handleVisionLearningFromSale: vi.fn(),
}));

import {
  processExactOutboxEvent,
  processOutboxEvent,
} from "../services/outbox-processor-service";

describe("outbox processor replay idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.journalExists = false;
    harness.cancellationJournalExists = false;
    harness.loyaltyExists = false;
    harness.profileOrderCount = 0;
    harness.profileTotal = 0;
    harness.ensurePlatformSchema.mockResolvedValue(undefined);
    harness.insertJournalEntryForClient.mockImplementation(async (_client, input) => {
      if (input.referenceType === "order_cancellation") {
        harness.cancellationJournalExists = true;
      } else {
        harness.journalExists = true;
      }
      return { id: `journal_${input.referenceType}` };
    });
    harness.client.query.mockImplementation(async (statement: string, params?: unknown[]) => {
      const sql = statement.replace(/\s+/g, " ").trim();
      if (sql.includes("FROM accounting.journal_entries") && sql.includes("order_shipping_adjustment")) {
        return { rows: harness.journalExists ? [{ id: "journal_shipping_adjustment" }] : [] };
      }
      if (sql.includes("FROM accounting.journal_entries") && sql.includes("reference_type = 'order'")) {
        return { rows: harness.journalExists ? [{ id: "journal_sale" }] : [] };
      }
      if (sql.includes("FROM accounting.journal_entries") && sql.includes("order_cancellation")) {
        return { rows: harness.cancellationJournalExists ? [{ id: "journal_cancellation" }] : [] };
      }
      if (sql.includes("FROM accounting.journal_entries je") && sql.includes("Reverse")) {
        return { rows: [] };
      }
      if (sql.includes("FROM accounting.journal_entries je") && sql.includes("je.status = 'posted'")) {
        return {
          rows: [
            { code: "1111", debit_amount: 100_000, credit_amount: 0, description: "Payment" },
            { code: "5111", debit_amount: 0, credit_amount: 90_000, description: "Revenue" },
            { code: "3331", debit_amount: 0, credit_amount: 10_000, description: "VAT" },
          ],
        };
      }
      if (sql.includes("FROM ai_module.loyalty_records") && sql.includes("source_event_id")) {
        return { rows: harness.loyaltyExists ? [{ id: "loyalty_record" }] : [] };
      }
      if (sql.includes("SUM(points_earned - points_redeemed)")) {
        return { rows: [{ points: "0" }] };
      }
      if (sql.includes("SUM(points_earned)")) {
        return { rows: [{ points: "10" }] };
      }
      if (sql.includes("INSERT INTO ai_module.customer_profiles")) {
        if (sql.includes("total_spent - $2")) {
          harness.profileTotal = Math.max(0, harness.profileTotal - Number(params?.[1] || 0));
        } else {
          harness.profileTotal += Number(params?.[1] || 0);
        }
        if (sql.includes("VALUES ($1, $2, 1")) harness.profileOrderCount += 1;
        if (sql.includes("order_count - 1")) {
          harness.profileOrderCount = Math.max(0, harness.profileOrderCount - 1);
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO ai_module.loyalty_records")) {
        harness.loyaltyExists = true;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  it("applies one shipping journal and one tenant-scoped customer total delta when the same event is replayed", async () => {
    const event = {
      id: "11111111-1111-4111-8111-111111111111",
      eventType: "order.shipping_adjusted",
      payload: {
        merchantId: "merchant_a",
        storeId: "store_a",
        orderId: "order_a",
        customerId: "customer_a",
        paymentEntryId: "payment_entry_a",
        paymentMethod: "cash",
        delta: 20_000,
        shippingRevenueDelta: 18_182,
        shippingTaxDelta: 1_818,
      },
    };

    await processOutboxEvent(event);
    await processOutboxEvent(event);

    expect(harness.insertJournalEntryForClient).toHaveBeenCalledTimes(1);
    expect(harness.profileTotal).toBe(20_000);

    const profileMutation = harness.client.query.mock.calls.find(([statement]) =>
      String(statement).includes("INSERT INTO ai_module.customer_profiles"),
    );
    expect(String(profileMutation?.[0])).toContain("merchant_id");
    expect(profileMutation?.[1]).toEqual(["customer_a", 20_000, "merchant_a"]);
  });

  it("serializes same-event handlers with a transaction-scoped advisory lock", async () => {
    const event = {
      id: "22222222-2222-4222-8222-222222222222",
      eventType: "order.shipping_adjusted",
      payload: {
        merchantId: "merchant_a",
        storeId: "store_a",
        orderId: "order_b",
        paymentEntryId: "payment_entry_b",
        paymentMethod: "cash",
        delta: 10_000,
        shippingRevenueDelta: 9_091,
        shippingTaxDelta: 909,
      },
    };

    await processOutboxEvent(event);

    expect(harness.client.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_xact_lock(hashtextextended($1, 0))"),
      ["exact-outbox-handler\u001f22222222-2222-4222-8222-222222222222"],
    );
  });

  it("keeps the sale journal, customer total and loyalty mutation single-applied across replay", async () => {
    const event = {
      id: "55555555-5555-4555-8555-555555555555",
      eventType: "sale.created",
      payload: {
        merchantId: "merchant_a",
        storeId: "store_a",
        orderId: "order_sale",
        orderNumber: "ORD-SALE",
        customerId: "customer_sale",
        paymentMethod: "cod",
        merchandiseRevenue: 90_000,
        tax: 10_000,
        total: 100_000,
        loyaltyBase: 90_000,
      },
    };

    await processExactOutboxEvent(event);
    await processExactOutboxEvent(event);

    expect(harness.insertJournalEntryForClient).toHaveBeenCalledTimes(1);
    expect(harness.profileTotal).toBe(100_000);
    expect(harness.loyaltyExists).toBe(true);
  });

  it("posts fee revenue separately from merchandise, shipping and provider expense exactly once",async()=>{
    const event={id:"88888888-8888-4888-8888-888888888888",eventType:"sale.created",payload:{merchantId:"merchant_a",storeId:"store_a",
      orderId:"fee-order",paymentMethod:"cod",commercialCalculationVersion:2,taxMode:"inclusive",vatRatePpm:100_000,
      subtotal:240_000,discount:24_000,merchandisePayable:216_000,shippingFee:20_000,merchandiseTax:19_636,shippingTax:1_818,
      merchandiseRevenue:196_364,shippingRevenue:18_182,paymentFeeType:"percent",paymentFeeValue:2,paymentFeeBasisMinor:216_000,
      paymentFeeMinor:4_320,paymentFeeVatMinor:393,paymentFeeRevenueMinor:3_927,tax:21_847,total:240_320,loyaltyBase:216_000,cogs:50_000}};
    await processExactOutboxEvent(event);await processExactOutboxEvent(event);
    expect(harness.insertJournalEntryForClient).toHaveBeenCalledTimes(1);
    const lines=harness.insertJournalEntryForClient.mock.calls[0][1].lines;
    expect(lines).toContainEqual({accountCode:"5113",debitAmount:0,creditAmount:3_927,description:"Payment fee revenue"});
    expect(lines.find((line:{accountCode:string})=>line.accountCode==="5111")?.creditAmount).toBe(196_364);
    expect(lines.some((line:{accountCode:string})=>line.accountCode==="6423")).toBe(false);
    expect(lines.reduce((s:number,l:{debitAmount:number;creditAmount:number})=>s+l.debitAmount-l.creditAmount,0)).toBe(0);
    harness.journalExists=false;harness.insertJournalEntryForClient.mockClear();
    await expect(processExactOutboxEvent({...event,payload:{...event.payload,paymentFeeRevenueMinor:3_928}})).rejects.toThrow(/fee/);
    expect(harness.insertJournalEntryForClient).not.toHaveBeenCalled();
  });

  it.each([
    [{ loyaltyBase: 0 }, 0], [{ loyaltyBase: 10_000 }, 1], [{}, 3], [{ loyaltyBase: null }, 3],
  ])("preserves explicit loyalty base %j and uses fallback only when absent/null", async (base, expectedPoints) => {
    const event = { id: "77777777-7777-4777-8777-777777777777", eventType: "sale.created", payload: {
      merchantId: "merchant_a", storeId: "store_a", orderId: "order_zero_loyalty", customerId: "customer_a",
      paymentMethod: "cod", total: 30_000, tax: 2_727, shippingRevenue: 18_182, merchandiseRevenue: 0, ...base,
    } };
    await processExactOutboxEvent(event);
    await processExactOutboxEvent(event);
    const mutations = harness.client.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO ai_module.loyalty_records"));
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.[1]?.[3]).toBe(expectedPoints);
    expect(harness.profileOrderCount).toBe(1);
  });

  it("reverses customer total and order count once when a sale cancellation is replayed", async () => {
    harness.journalExists = true;
    harness.profileTotal = 100_000;
    harness.profileOrderCount = 1;

    const event = {
      id: "66666666-6666-4666-8666-666666666666",
      eventType: "sale.cancelled",
      payload: {
        merchantId: "merchant_a",
        storeId: "store_a",
        orderId: "order_cancelled",
        customerId: "customer_cancelled",
        total: 100_000,
      },
    };

    await processExactOutboxEvent(event);
    await processExactOutboxEvent(event);

    expect(harness.insertJournalEntryForClient).toHaveBeenCalledTimes(1);
    expect(harness.profileTotal).toBe(0);
    expect(harness.profileOrderCount).toBe(0);
    expect(harness.client.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE order_id = $1 AND merchant_id = $2"),
      ["order_cancelled", "merchant_a"],
    );
  });

  it("processes exact-runtime events without invoking the DDL-capable schema initializer", async () => {
    await processExactOutboxEvent({
      id: "33333333-3333-4333-8333-333333333333",
      eventType: "order.shipping_adjusted",
      payload: {
        merchantId: "merchant_a",
        storeId: "store_a",
        orderId: "order_c",
        paymentEntryId: "payment_entry_c",
        paymentMethod: "cash",
        delta: 5_000,
        shippingRevenueDelta: 4_545,
        shippingTaxDelta: 455,
      },
    });

    expect(harness.ensurePlatformSchema).not.toHaveBeenCalled();
  });

  it("serializes the external product autofill handler by exact event identity", async () => {
    const eventId = "44444444-4444-4444-8444-444444444444";

    await processExactOutboxEvent({
      id: eventId,
      eventType: "product.image_autofill_requested",
      payload: { merchantId: "merchant_a", productId: "product_a" },
    });

    expect(harness.client.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_xact_lock(hashtextextended($1, 0))"),
      [`exact-outbox-handler\u001f${eventId}`],
    );
    expect(harness.handleProductOnReadySchema).toHaveBeenCalledOnce();
    expect(harness.ensurePlatformSchema).not.toHaveBeenCalled();
  });
});
