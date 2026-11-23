import { describe, expect, it } from "vitest";
import {
  PAYMENT_ACCOUNTING_FIXTURE,
  conflictingRetryFixture,
  projectPaymentAccounting,
  type PaymentAccountingOracleInput,
} from "./payment-accounting-oracle-fixtures";

describe("TEST-02 independent payment/accounting oracle", () => {
  it("counts exact posted collections once, including COD at order creation", () => {
    const result = projectPaymentAccounting(PAYMENT_ACCOUNTING_FIXTURE);

    expect(result.currencies).toEqual([
      {
        currencyCode: "USD",
        recordedGrossCollectionsMinor: 1_500,
        refundsMinor: 0,
        reversalsMinor: 0,
        chargebacksMinor: 0,
        negativeCollectionsMinor: 0,
        netCollectionsMinor: 1_500,
        customerPayableOpenedMinor: 0,
        customerPayableClearedMinor: 0,
        customerRefundPayableAsOfMinor: 0,
      },
      {
        currencyCode: "VND",
        recordedGrossCollectionsMinor: 11_000,
        refundsMinor: 100,
        reversalsMinor: 200,
        chargebacksMinor: 300,
        negativeCollectionsMinor: 600,
        netCollectionsMinor: 10_400,
        customerPayableOpenedMinor: 700,
        customerPayableClearedMinor: 200,
        customerRefundPayableAsOfMinor: 500,
      },
    ]);
  });

  it("keeps provider and unknown methods pending without exact success evidence", () => {
    const result = projectPaymentAccounting(PAYMENT_ACCOUNTING_FIXTURE);

    expect(result.ignoredPendingEventIds).toEqual([
      "evt-provider-pending",
      "evt-unknown-pending",
    ]);
    expect(result.countedEventIds).toContain("evt-provider-webhook-posted");
  });

  it("uses immutable payment event time, not mutable order update time", () => {
    const result = projectPaymentAccounting(PAYMENT_ACCOUNTING_FIXTURE);

    expect(result.shifts).toEqual([
      { shiftId: "shift-am", currencyCode: "VND", netCollectionsMinor: 5_400 },
      { shiftId: "shift-pm", currencyCode: "USD", netCollectionsMinor: 1_500 },
      { shiftId: "shift-pm", currencyCode: "VND", netCollectionsMinor: 5_000 },
    ]);
  });

  it("requires every journal and every currency block to balance independently", () => {
    const result = projectPaymentAccounting(PAYMENT_ACCOUNTING_FIXTURE);

    expect(result.journals.every((journal) => journal.debitMinor === journal.creditMinor))
      .toBe(true);
    expect(result.journals.map((journal) => journal.kind)).toEqual([
      "sale_revenue_vat",
      "sale_cogs",
      "customer_payable_open",
      "customer_payable_clear",
    ]);
  });

  it("deduplicates exact retries and rejects conflicting reuse of an idempotency key", () => {
    const exactRetry = projectPaymentAccounting(PAYMENT_ACCOUNTING_FIXTURE);
    expect(exactRetry.countedEventIds.filter((id) => id === "evt-cod-created")).toHaveLength(1);

    expect(() => projectPaymentAccounting(conflictingRetryFixture())).toThrow(
      "conflicting payment event retry",
    );
  });

  it("fails closed on fractional minor units and unbalanced journals", () => {
    const fractional: PaymentAccountingOracleInput = {
      ...PAYMENT_ACCOUNTING_FIXTURE,
      events: PAYMENT_ACCOUNTING_FIXTURE.events.map((event, index) => (
        index === 0 ? { ...event, amountMinor: 0.5 } : event
      )),
    };
    expect(() => projectPaymentAccounting(fractional)).toThrow("integer minor units");

    const unbalanced: PaymentAccountingOracleInput = {
      ...PAYMENT_ACCOUNTING_FIXTURE,
      journals: PAYMENT_ACCOUNTING_FIXTURE.journals.map((journal, index) => (
        index === 0 ? { ...journal, creditMinor: journal.creditMinor + 1 } : journal
      )),
    };
    expect(() => projectPaymentAccounting(unbalanced)).toThrow("unbalanced journal");
  });
});
