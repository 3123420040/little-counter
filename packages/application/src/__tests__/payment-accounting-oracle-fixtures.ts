/**
 * TEST-02 oracle only. This file deliberately imports no production payment,
 * order, journal, dashboard, repository, or schema implementation.
 */

export type OracleCurrencyCode = "USD" | "VND";
export type OraclePaymentMethod = "cash" | "cod" | "manual_bank" | "provider" | "unknown";
export type OraclePaymentEventKind =
  | "charge"
  | "refund"
  | "reversal"
  | "chargeback"
  | "customer_payable_open"
  | "customer_payable_clear";
export type OracleEvidence =
  | "cash_receipt"
  | "cod_order_created"
  | "manual_verified"
  | "provider_webhook_success"
  | "negative_collection_confirmed"
  | "customer_payable_confirmed";

export type OraclePaymentEvent = {
  id: string;
  idempotencyKey: string;
  kind: OraclePaymentEventKind;
  status: "posted" | "pending";
  method: OraclePaymentMethod;
  evidence?: OracleEvidence;
  currencyCode: OracleCurrencyCode;
  amountMinor: number;
  eventAt: string;
  orderUpdatedAt: string;
  shiftId: string;
};

export type OracleJournal = {
  id: string;
  kind:
    | "sale_revenue_vat"
    | "sale_cogs"
    | "customer_payable_open"
    | "customer_payable_clear";
  currencyCode: OracleCurrencyCode;
  debitMinor: number;
  creditMinor: number;
};

export type PaymentAccountingOracleInput = {
  rangeStart: string;
  rangeEndExclusive: string;
  events: OraclePaymentEvent[];
  journals: OracleJournal[];
};

export type CurrencyCollectionProjection = {
  currencyCode: OracleCurrencyCode;
  recordedGrossCollectionsMinor: number;
  refundsMinor: number;
  reversalsMinor: number;
  chargebacksMinor: number;
  negativeCollectionsMinor: number;
  netCollectionsMinor: number;
  customerPayableOpenedMinor: number;
  customerPayableClearedMinor: number;
  customerRefundPayableAsOfMinor: number;
};

export type PaymentAccountingOracleResult = {
  currencies: CurrencyCollectionProjection[];
  shifts: Array<{
    shiftId: string;
    currencyCode: OracleCurrencyCode;
    netCollectionsMinor: number;
  }>;
  countedEventIds: string[];
  ignoredPendingEventIds: string[];
  journals: OracleJournal[];
};

function exactNonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must use non-negative integer minor units`);
  }
  return value;
}

function eventSignature(event: OraclePaymentEvent): string {
  return JSON.stringify({
    kind: event.kind,
    status: event.status,
    method: event.method,
    evidence: event.evidence || null,
    currencyCode: event.currencyCode,
    amountMinor: event.amountMinor,
    eventAt: event.eventAt,
    shiftId: event.shiftId,
  });
}

function validatePostedEvidence(event: OraclePaymentEvent): void {
  if (event.status !== "posted") return;
  const allowed: Record<OraclePaymentEventKind, OracleEvidence[]> = {
    charge: event.method === "cash"
      ? ["cash_receipt"]
      : event.method === "cod"
        ? ["cod_order_created"]
        : event.method === "manual_bank"
          ? ["manual_verified"]
          : event.method === "provider"
            ? ["provider_webhook_success"]
            : [],
    refund: ["negative_collection_confirmed"],
    reversal: ["negative_collection_confirmed"],
    chargeback: ["negative_collection_confirmed"],
    customer_payable_open: ["customer_payable_confirmed"],
    customer_payable_clear: ["customer_payable_confirmed"],
  };
  if (!event.evidence || !allowed[event.kind].includes(event.evidence)) {
    throw new Error(`posted ${event.kind} lacks approved success evidence`);
  }
}

function emptyCurrency(currencyCode: OracleCurrencyCode): CurrencyCollectionProjection {
  return {
    currencyCode,
    recordedGrossCollectionsMinor: 0,
    refundsMinor: 0,
    reversalsMinor: 0,
    chargebacksMinor: 0,
    negativeCollectionsMinor: 0,
    netCollectionsMinor: 0,
    customerPayableOpenedMinor: 0,
    customerPayableClearedMinor: 0,
    customerRefundPayableAsOfMinor: 0,
  };
}

export function projectPaymentAccounting(
  input: PaymentAccountingOracleInput,
): PaymentAccountingOracleResult {
  const start = Date.parse(input.rangeStart);
  const end = Date.parse(input.rangeEndExclusive);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("invalid half-open payment event range");
  }

  for (const journal of input.journals) {
    exactNonnegativeInteger(journal.debitMinor, `${journal.id}.debitMinor`);
    exactNonnegativeInteger(journal.creditMinor, `${journal.id}.creditMinor`);
    if (journal.debitMinor !== journal.creditMinor) {
      throw new Error(`unbalanced journal ${journal.id}`);
    }
  }

  const seen = new Map<string, string>();
  const currencies = new Map<OracleCurrencyCode, CurrencyCollectionProjection>();
  const shifts = new Map<string, number>();
  const countedEventIds: string[] = [];
  const ignoredPendingEventIds: string[] = [];

  for (const event of input.events) {
    exactNonnegativeInteger(event.amountMinor, `${event.id}.amountMinor`);
    const occurredAt = Date.parse(event.eventAt);
    if (!Number.isFinite(occurredAt)) throw new Error(`invalid eventAt for ${event.id}`);
    if (occurredAt < start || occurredAt >= end) continue;

    const signature = eventSignature(event);
    const existing = seen.get(event.idempotencyKey);
    if (existing) {
      if (existing !== signature) throw new Error("conflicting payment event retry");
      continue;
    }
    seen.set(event.idempotencyKey, signature);

    if (event.status === "pending") {
      ignoredPendingEventIds.push(event.id);
      continue;
    }
    validatePostedEvidence(event);
    countedEventIds.push(event.id);

    const block = currencies.get(event.currencyCode) || emptyCurrency(event.currencyCode);
    let shiftDelta = 0;
    if (event.kind === "charge") {
      block.recordedGrossCollectionsMinor += event.amountMinor;
      shiftDelta = event.amountMinor;
    } else if (event.kind === "refund") {
      block.refundsMinor += event.amountMinor;
      shiftDelta = -event.amountMinor;
    } else if (event.kind === "reversal") {
      block.reversalsMinor += event.amountMinor;
      shiftDelta = -event.amountMinor;
    } else if (event.kind === "chargeback") {
      block.chargebacksMinor += event.amountMinor;
      shiftDelta = -event.amountMinor;
    } else if (event.kind === "customer_payable_open") {
      block.customerPayableOpenedMinor += event.amountMinor;
    } else {
      block.customerPayableClearedMinor += event.amountMinor;
    }
    currencies.set(event.currencyCode, block);

    if (shiftDelta !== 0) {
      const key = `${event.shiftId}\u0000${event.currencyCode}`;
      shifts.set(key, (shifts.get(key) || 0) + shiftDelta);
    }
  }

  for (const block of currencies.values()) {
    block.negativeCollectionsMinor = block.refundsMinor
      + block.reversalsMinor
      + block.chargebacksMinor;
    block.netCollectionsMinor = block.recordedGrossCollectionsMinor
      - block.negativeCollectionsMinor;
    block.customerRefundPayableAsOfMinor = block.customerPayableOpenedMinor
      - block.customerPayableClearedMinor;
    if (block.netCollectionsMinor < 0 || block.customerRefundPayableAsOfMinor < 0) {
      throw new Error(`negative derived balance for ${block.currencyCode}`);
    }
  }

  return {
    currencies: [...currencies.values()].sort((left, right) => (
      left.currencyCode.localeCompare(right.currencyCode)
    )),
    shifts: [...shifts.entries()]
      .map(([key, netCollectionsMinor]) => {
        const [shiftId, currencyCode] = key.split("\u0000") as [string, OracleCurrencyCode];
        return { shiftId, currencyCode, netCollectionsMinor };
      })
      .sort((left, right) => (
        left.shiftId.localeCompare(right.shiftId)
        || left.currencyCode.localeCompare(right.currencyCode)
      )),
    countedEventIds,
    ignoredPendingEventIds,
    journals: input.journals.map((journal) => ({ ...journal })),
  };
}

const baseEvents: OraclePaymentEvent[] = [
  {
    id: "evt-cash",
    idempotencyKey: "payment:cash:1",
    kind: "charge",
    status: "posted",
    method: "cash",
    evidence: "cash_receipt",
    currencyCode: "VND",
    amountMinor: 1_000,
    eventAt: "2026-08-04T08:00:00.000Z",
    orderUpdatedAt: "2026-08-10T08:00:00.000Z",
    shiftId: "shift-am",
  },
  {
    id: "evt-cod-created",
    idempotencyKey: "payment:cod:1",
    kind: "charge",
    status: "posted",
    method: "cod",
    evidence: "cod_order_created",
    currencyCode: "VND",
    amountMinor: 2_000,
    eventAt: "2026-08-04T08:10:00.000Z",
    orderUpdatedAt: "2026-08-04T08:10:00.000Z",
    shiftId: "shift-am",
  },
  {
    id: "evt-cod-created",
    idempotencyKey: "payment:cod:1",
    kind: "charge",
    status: "posted",
    method: "cod",
    evidence: "cod_order_created",
    currencyCode: "VND",
    amountMinor: 2_000,
    eventAt: "2026-08-04T08:10:00.000Z",
    orderUpdatedAt: "2026-08-11T08:10:00.000Z",
    shiftId: "shift-am",
  },
  {
    id: "evt-manual-posted",
    idempotencyKey: "payment:manual:1",
    kind: "charge",
    status: "posted",
    method: "manual_bank",
    evidence: "manual_verified",
    currencyCode: "VND",
    amountMinor: 3_000,
    eventAt: "2026-08-04T08:20:00.000Z",
    orderUpdatedAt: "2026-07-01T08:20:00.000Z",
    shiftId: "shift-am",
  },
  {
    id: "evt-provider-pending",
    idempotencyKey: "payment:provider:pending",
    kind: "charge",
    status: "pending",
    method: "provider",
    currencyCode: "VND",
    amountMinor: 4_000,
    eventAt: "2026-08-04T08:30:00.000Z",
    orderUpdatedAt: "2026-08-04T08:30:00.000Z",
    shiftId: "shift-am",
  },
  {
    id: "evt-provider-webhook-posted",
    idempotencyKey: "payment:provider:posted",
    kind: "charge",
    status: "posted",
    method: "provider",
    evidence: "provider_webhook_success",
    currencyCode: "VND",
    amountMinor: 5_000,
    eventAt: "2026-08-04T13:00:00.000Z",
    orderUpdatedAt: "2026-07-01T13:00:00.000Z",
    shiftId: "shift-pm",
  },
  {
    id: "evt-unknown-pending",
    idempotencyKey: "payment:unknown:pending",
    kind: "charge",
    status: "pending",
    method: "unknown",
    currencyCode: "VND",
    amountMinor: 9_000,
    eventAt: "2026-08-04T08:40:00.000Z",
    orderUpdatedAt: "2026-08-04T08:40:00.000Z",
    shiftId: "shift-am",
  },
  ...(["refund", "reversal", "chargeback"] as const).map((kind, index) => ({
    id: `evt-${kind}`,
    idempotencyKey: `payment:${kind}:1`,
    kind,
    status: "posted" as const,
    method: "manual_bank" as const,
    evidence: "negative_collection_confirmed" as const,
    currencyCode: "VND" as const,
    amountMinor: (index + 1) * 100,
    eventAt: `2026-08-04T08:${50 + index}:00.000Z`,
    orderUpdatedAt: "2026-08-12T00:00:00.000Z",
    shiftId: "shift-am",
  })),
  {
    id: "evt-payable-open",
    idempotencyKey: "payable:open:1",
    kind: "customer_payable_open",
    status: "posted",
    method: "manual_bank",
    evidence: "customer_payable_confirmed",
    currencyCode: "VND",
    amountMinor: 700,
    eventAt: "2026-08-04T09:00:00.000Z",
    orderUpdatedAt: "2026-08-04T09:00:00.000Z",
    shiftId: "shift-am",
  },
  {
    id: "evt-payable-clear",
    idempotencyKey: "payable:clear:1",
    kind: "customer_payable_clear",
    status: "posted",
    method: "manual_bank",
    evidence: "customer_payable_confirmed",
    currencyCode: "VND",
    amountMinor: 200,
    eventAt: "2026-08-04T09:10:00.000Z",
    orderUpdatedAt: "2026-08-04T09:10:00.000Z",
    shiftId: "shift-am",
  },
  {
    id: "evt-usd",
    idempotencyKey: "payment:usd:1",
    kind: "charge",
    status: "posted",
    method: "cash",
    evidence: "cash_receipt",
    currencyCode: "USD",
    amountMinor: 1_500,
    eventAt: "2026-08-04T13:10:00.000Z",
    orderUpdatedAt: "2026-08-04T13:10:00.000Z",
    shiftId: "shift-pm",
  },
  {
    id: "evt-outside-range",
    idempotencyKey: "payment:outside:1",
    kind: "charge",
    status: "posted",
    method: "cash",
    evidence: "cash_receipt",
    currencyCode: "VND",
    amountMinor: 999_999,
    eventAt: "2026-08-03T23:59:59.999Z",
    orderUpdatedAt: "2026-08-04T12:00:00.000Z",
    shiftId: "shift-am",
  },
];

export const PAYMENT_ACCOUNTING_FIXTURE: PaymentAccountingOracleInput = {
  rangeStart: "2026-08-04T00:00:00.000Z",
  rangeEndExclusive: "2026-08-05T00:00:00.000Z",
  events: baseEvents,
  journals: [
    {
      id: "jnl-sale-revenue-vat",
      kind: "sale_revenue_vat",
      currencyCode: "VND",
      debitMinor: 11_000,
      creditMinor: 11_000,
    },
    {
      id: "jnl-cogs",
      kind: "sale_cogs",
      currencyCode: "VND",
      debitMinor: 4_000,
      creditMinor: 4_000,
    },
    {
      id: "jnl-payable-open",
      kind: "customer_payable_open",
      currencyCode: "VND",
      debitMinor: 700,
      creditMinor: 700,
    },
    {
      id: "jnl-payable-clear",
      kind: "customer_payable_clear",
      currencyCode: "VND",
      debitMinor: 200,
      creditMinor: 200,
    },
  ],
};

export function conflictingRetryFixture(): PaymentAccountingOracleInput {
  return {
    ...PAYMENT_ACCOUNTING_FIXTURE,
    events: [
      ...PAYMENT_ACCOUNTING_FIXTURE.events,
      {
        ...PAYMENT_ACCOUNTING_FIXTURE.events[1]!,
        id: "evt-cod-conflict",
        amountMinor: 2_001,
      },
    ],
  };
}
