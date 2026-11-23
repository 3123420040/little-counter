import { PlatformError } from "../errors/platform-error";

export interface RefundPayoutAmountPolicyInputV1 {
  channelActor: boolean;
  orderStatus: string;
  requestedAmount?: unknown;
  payableBalanceMinor: number;
  netCollectionsMinor: number;
}

function safeNonnegativeMinor(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PlatformError(
      "financial_invariant_error",
      `${field} is not a safe non-negative minor-unit amount`,
      409,
    );
  }
  return parsed;
}

/**
 * Every Web POS payout is an exact clearance action, not a free-form
 * partial-refund API. The server-owned open payable is authoritative for both
 * cancellation and negative-correction payables. Channel actors retain their
 * existing bounded partial-refund behavior for compatibility.
 */
export function resolveRefundPayoutAmountV1(
  raw: RefundPayoutAmountPolicyInputV1,
): number {
  const payableBalanceMinor = safeNonnegativeMinor(
    raw.payableBalanceMinor,
    "customer refund payable balance",
  );
  const netCollectionsMinor = safeNonnegativeMinor(
    raw.netCollectionsMinor,
    "net recorded collection",
  );
  const serverOwnedAmount = payableBalanceMinor;

  if (!raw.channelActor) {
    if (raw.requestedAmount !== undefined) {
      const requestedAmount = Number(raw.requestedAmount);
      if (
        !Number.isSafeInteger(requestedAmount)
        || requestedAmount !== serverOwnedAmount
      ) {
        throw new PlatformError(
          "refund_amount_must_equal_payable",
          "Refund amount must exactly equal the server-owned customer payable",
          409,
          { requested: raw.requestedAmount, payable: serverOwnedAmount },
        );
      }
    }
    if (serverOwnedAmount <= 0) {
      throw new PlatformError(
        "invalid_state_transition",
        "Order has no open customer refund payable",
        409,
      );
    }
    return serverOwnedAmount;
  }

  const amount = raw.requestedAmount === undefined
    ? serverOwnedAmount
    : Number(raw.requestedAmount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new PlatformError(
      "validation_error",
      "Refund amount must be a positive safe minor-unit integer",
      400,
    );
  }
  if (amount > netCollectionsMinor) {
    throw new PlatformError(
      "refund_amount_exceeds_balance",
      "Refund amount exceeds refundable payment balance",
      409,
      { requested: amount, refundable: netCollectionsMinor },
    );
  }
  return amount;
}
