import { describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import {
  PostgresOrderPageSnapshotRepositoryV1,
} from "../services/postgres-order-page-snapshot-repository";
import { normalizeOrderCursorFiltersV1 } from "../services/order-cursor-service";

const scope = { merchantId: "merchant-a", storeIds: ["store-a", "store-b"] };
const filters = normalizeOrderCursorFiltersV1({
  search: "ord-100%_literal",
  statusMode: "other",
  storeWindows: [
    {
      storeId: "store-a",
      startInclusive: "2026-08-01T00:00:00.000Z",
      endExclusive: "2026-08-02T00:00:00.000Z",
    },
    {
      storeId: "store-b",
      startInclusive: "2026-07-31T17:00:00.000Z",
      endExclusive: "2026-08-01T17:00:00.000Z",
    },
  ],
});

class FakeClient {
  calls: Array<{ sql: string; params?: unknown[] }> = [];
  failRevisions = false;
  paymentCurrencyMismatch = false;
  payableCurrencyMismatch = false;
  aggregateCoverageMismatch = false;
  feeBearingCohort = false;
  activeFeeCohort = false;

  async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.includes("order_page_as_of")) {
      return { rows: [{ order_page_as_of: new Date("2026-08-05T00:00:00.000Z") }] as T[] };
    }
    if (sql.includes("order_page_revision_vector")) {
      const rows = this.failRevisions ? [{
        requested_store_id: "store-a",
        owned_store_id: "store-a",
        revision: "17",
      }] : [
        { requested_store_id: "store-a", owned_store_id: "store-a", revision: "17" },
        { requested_store_id: "store-b", owned_store_id: "store-b", revision: "9" },
      ];
      return { rows: rows as T[] };
    }
    if (sql.includes("order_page_identity_rows")) {
      return { rows: [{
        merchant_id: "merchant-a",
        store_id: "store-b",
        order_id: "order-100",
        order_number: "ORD-100%_LITERAL",
        order_status: "cancelled",
        currency_code: "vnd",
        created_at: new Date("2026-08-01T12:00:00.000Z"),
        customer_id: "customer-a",
        customer_first_name: "An",
        customer_last_name: "Nguyen",
        customer_phone: "0900000000",
        customer_attribution: "linked",
      }] as T[] };
    }
    if (sql.includes("order_page_total_count")) {
      return { rows: [{ total_count: "1" }] as T[] };
    }
    if (sql.includes("effective_order_page_payment_summaries")) {
      return { rows: [{
        requested_order_id: "order-100",
        owned_order_id: "order-100",
        currency_code: "VND",
        currency_mismatch_count: this.paymentCurrencyMismatch ? "1" : "0",
        payable_currency_mismatch_count: this.payableCurrencyMismatch ? "1" : "0",
        recorded_gross_collections_minor: "2650",
        refunds_minor: "100",
        reversals_minor: "0",
        chargebacks_minor: "50",
        customer_refund_payable_minor: "230",
        payment_methods: ["cash", "manual_bank"],
      }] as T[] };
    }
    if (sql.includes("effective_order_page_currency_aggregates")) {
      return { rows: [{
        currency_code: "VND",
        minor_unit_exponent: "0",
        order_count: "1",
        revision_count: "1",
        component_count: this.aggregateCoverageMismatch ? "0" : "1",
        payment_fee_order_count: this.feeBearingCohort ? "1" : "0",
        revision_currency_mismatch_count: "0",
        payment_currency_mismatch_count: "0",
        active_order_count: this.activeFeeCohort ? "1" : "0",
        cancelled_order_count: this.activeFeeCohort ? "0" : "1",
        current_order_gross_value_minor: this.activeFeeCohort ? "1000" : "0",
        payment_fee_minor: this.activeFeeCohort ? "100" : "0",
        payment_fee_vat_minor: this.activeFeeCohort ? "10" : "0",
        payment_fee_customer_total_minor: this.activeFeeCohort ? "110" : "0",
        effective_item_quantity: "0",
        recorded_gross_collections_minor: "2650",
        refunds_minor: "100",
        reversals_minor: "0",
        chargebacks_minor: "50",
      }] as T[] };
    }
    return { rows: [] as T[] };
  }
}

describe("PAGE-01C PostgreSQL snapshot repository", () => {
  it("allows V5 fee-aware aggregate hydration while preserving legacy refusal for the same cohort", async () => {
    const fake = new FakeClient(); fake.feeBearingCohort = true; fake.activeFeeCohort = true;
    const repository = new PostgresOrderPageSnapshotRepositoryV1(fake as unknown as PoolClient, 1_000);
    const input = { scope, filters, asOf: "2026-08-05T00:00:00.000Z" };
    const result = await repository.withRepeatableReadSnapshot((snapshot) => snapshot.readFeeAwareCurrencyAggregates(input));
    expect(result).toMatchObject([{ currentOrderGrossValueMinor: 1_000, paymentFeeMinor: 100,
      paymentFeeVatMinor: 10, paymentFeeCustomerTotalMinor: 110 }]);
    await expect(repository.withRepeatableReadSnapshot((snapshot) => snapshot.readCurrencyAggregates(input)))
      .rejects.toMatchObject({ code: "unsupported_contract" });
  });
  it("refuses legacy aggregates when the full filtered cohort contains a fee outside the current page", async () => {
    const fake = new FakeClient();
    fake.feeBearingCohort = true;
    const repository = new PostgresOrderPageSnapshotRepositoryV1(fake as unknown as PoolClient, 1_000);
    await expect(repository.withRepeatableReadSnapshot((snapshot) => snapshot.readCurrencyAggregates({
      scope, filters, asOf: "2026-08-05T00:00:00.000Z",
    }))).rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 });
    expect(fake.calls.at(-1)!.sql).toBe("ROLLBACK");
  });
  it("uses one bounded repeatable-read/read-only transaction and parameterized filters", async () => {
    const fake = new FakeClient();
    const repository = new PostgresOrderPageSnapshotRepositoryV1(
      fake as unknown as PoolClient,
      12_000,
    );
    const result = await repository.withRepeatableReadSnapshot(async (snapshot) => {
      const asOf = await snapshot.readAsOf();
      const revisions = await snapshot.readStoreRevisionVector(scope);
      const rows = await snapshot.readRows({
        scope,
        filters,
        highWatermark: { createdAt: "2026-08-04T12:00:00.000Z", id: "order-z" },
        after: { createdAt: "2026-08-04T11:00:00.000Z", id: "order-m" },
        limit: 51,
      });
      const count = await snapshot.countRows({ scope, filters });
      const payments = await snapshot.readPaymentSummaries({
        scope,
        orderIds: ["order-100"],
        asOf,
      });
      const aggregates = await snapshot.readCurrencyAggregates({ scope, filters, asOf });
      return { asOf, revisions, rows, count, payments, aggregates };
    });

    expect(result).toEqual({
      asOf: "2026-08-05T00:00:00.000Z",
      revisions: [
        { storeId: "store-a", revision: 17 },
        { storeId: "store-b", revision: 9 },
      ],
      rows: [{
        merchantId: "merchant-a",
        storeId: "store-b",
        orderId: "order-100",
        orderNumber: "ORD-100%_LITERAL",
        status: "cancelled",
        currencyCode: "VND",
        createdAt: "2026-08-01T12:00:00.000Z",
        customerAttribution: "linked",
        customer: {
          id: "customer-a",
          firstName: "An",
          lastName: "Nguyen",
          phone: "0900000000",
        },
      }],
      count: 1,
      payments: [{
        orderId: "order-100",
        currencyCode: "VND",
        recordedGrossCollectionsMinor: 2_650,
        refundsMinor: 100,
        reversalsMinor: 0,
        chargebacksMinor: 50,
        negativeCollectionsMinor: 150,
        netCollectionsMinor: 2_500,
        customerRefundPayableMinor: 230,
        paymentMethods: ["cash", "manual_bank"],
      }],
      aggregates: [{
        currencyCode: "VND",
        minorUnitExponent: 0,
        orderCount: 1,
        activeOrderCount: 0,
        cancelledOrderCount: 1,
        currentOrderGrossValueMinor: 0,
        effectiveItemQuantity: 0,
        recordedGrossCollectionsMinor: 2_650,
        refundsMinor: 100,
        reversalsMinor: 0,
        chargebacksMinor: 50,
        negativeCollectionsMinor: 150,
        netCollectionsMinor: 2_500,
      }],
    });
    expect(fake.calls[0]!.sql).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(fake.calls[1]).toEqual({
      sql: "SELECT set_config('statement_timeout', $1, true)",
      params: ["12000ms"],
    });
    expect(fake.calls.at(-1)!.sql).toBe("COMMIT");

    const rowCall = fake.calls.find((call) => call.sql.includes("order_page_identity_rows"))!;
    expect(rowCall.sql).toContain("POSITION($4 IN LOWER(o.id)) > 0");
    expect(rowCall.sql).toContain("o.created_at < $9::timestamptz");
    expect(rowCall.sql).toContain("o.created_at < $11::timestamptz");
    expect(rowCall.sql).toContain("ORDER BY o.created_at DESC, o.order_id DESC");
    expect(rowCall.sql).not.toMatch(/\bwindow\./);
    expect(rowCall.sql).toContain("requested_window.start_inclusive");
    expect(rowCall.sql).toContain("LEFT JOIN public.customer c");
    expect(rowCall.sql).not.toMatch(/order_item|order_line_item/i);
    expect(rowCall.params).toEqual([
      "merchant-a",
      ["store-a", "store-b"],
      JSON.stringify(filters.storeWindows.map((window) => ({
        store_id: window.storeId,
        start_inclusive: window.startInclusive,
        end_exclusive: window.endExclusive,
      }))),
      "ord-100%_literal",
      "other",
      "order_identity",
      "all", [],
      "2026-08-04T12:00:00.000Z",
      "order-z",
      "2026-08-04T11:00:00.000Z",
      "order-m",
      51,
    ]);

    const paymentCall = fake.calls.find((call) =>
      call.sql.includes("effective_order_page_payment_summaries"))!;
    expect(paymentCall.sql.match(/\bFROM requested\b/g)).toHaveLength(1);
    expect(paymentCall.sql).toContain('LEFT JOIN public."order" o');
  });

  it("binds customer identity search and validates a phone-only match", async () => {
    const fake = new FakeClient();
    const repository = new PostgresOrderPageSnapshotRepositoryV1(
      fake as unknown as PoolClient,
      1_000,
    );
    const customerFilters = {
      ...filters,
      searchMode: "order_or_customer_identity" as const,
      search: "0900000000",
    };
    const rows = await repository.withRepeatableReadSnapshot((snapshot) => snapshot.readRows({
      scope,
      filters: customerFilters,
      limit: 1,
    }));

    expect(rows[0]?.customer?.id).toBe("customer-a");
    const rowCall = fake.calls.find((call) => call.sql.includes("order_page_identity_rows"))!;
    expect(rowCall.sql).toContain("POSITION($4 IN LOWER(COALESCE(c.phone, ''))) > 0");
    expect(rowCall.params?.[5]).toBe("order_or_customer_identity");
  });

  it("rolls back and fails closed when the revision vector is incomplete", async () => {
    const fake = new FakeClient();
    fake.failRevisions = true;
    const repository = new PostgresOrderPageSnapshotRepositoryV1(
      fake as unknown as PoolClient,
      1_000,
    );
    await expect(repository.withRepeatableReadSnapshot((snapshot) =>
      snapshot.readStoreRevisionVector(scope))).rejects.toThrow();
    expect(fake.calls.at(-1)!.sql).toBe("ROLLBACK");
    expect(fake.calls.some((call) => call.sql === "COMMIT")).toBe(false);
  });

  it("fails closed for payment/payable currency or canonical aggregate coverage drift", async () => {
    for (const mode of ["payment", "payable", "aggregate"] as const) {
      const fake = new FakeClient();
      fake.paymentCurrencyMismatch = mode === "payment";
      fake.payableCurrencyMismatch = mode === "payable";
      fake.aggregateCoverageMismatch = mode === "aggregate";
      const repository = new PostgresOrderPageSnapshotRepositoryV1(
        fake as unknown as PoolClient,
        1_000,
      );
      await expect(repository.withRepeatableReadSnapshot(async (snapshot) => {
        if (mode === "payment" || mode === "payable") {
          return snapshot.readPaymentSummaries({
            scope,
            orderIds: ["order-100"],
            asOf: "2026-08-05T00:00:00.000Z",
          });
        }
        return snapshot.readCurrencyAggregates({
          scope,
          filters,
          asOf: "2026-08-05T00:00:00.000Z",
        });
      })).rejects.toThrow();
      expect(fake.calls.at(-1)!.sql).toBe("ROLLBACK");
    }
  });

  it("rejects unsafe statement timeouts before opening a transaction", () => {
    const fake = new FakeClient();
    expect(() => new PostgresOrderPageSnapshotRepositoryV1(
      fake as unknown as PoolClient,
      0,
    )).toThrow();
    expect(() => new PostgresOrderPageSnapshotRepositoryV1(
      fake as unknown as PoolClient,
      30_001,
    )).toThrow();
    expect(fake.calls).toEqual([]);
  });
});
