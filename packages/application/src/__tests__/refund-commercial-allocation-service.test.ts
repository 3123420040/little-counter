import { describe, expect, it, vi } from "vitest";
import {
  freezeRefundAccountingForClientV2,
  readPriorRefundReversalsForClientV2,
} from "../services/refund-commercial-allocation-service";

const scope = {
  merchantId: "merchant-a",
  storeId: "store-a",
  orderId: "order-a",
};
const revisionId = "00000000-0000-4000-8000-000000000001";
const obligationId = "00000000-0000-4000-8000-000000000002";
const component_record = {
  component_version: 2,
  tax_mode: "inclusive",
  merchandise_gross_minor: 240_000,
  discount_minor: 24_000,
  merchandise_net_minor: 216_000,
  shipping_minor: 20_000,
  merchandise_vat_minor: 19_636,
  shipping_vat_minor: 1_818,
  payment_fee_minor: 4_320,
  payment_fee_vat_minor: 393,
  vat_minor: 21_847,
  unclassified_minor: 0,
  total_minor: 240_320,
};
function payable(
  kind = "manual_refund",
  balance_minor = 120_160,
  suffix = "3",
) {
  return {
    payable_id: `00000000-0000-4000-8000-00000000000${suffix}`,
    payable_kind: kind,
    balance_minor,
    commercial_revision_id: revisionId,
    source_type: kind,
    source_id: `source-${suffix}`,
    component_record,
  };
}
const obligation = (refundable_minor: number) => ({
  obligation_id: obligationId,
  refundable_minor,
});

describe("V2 refund payable-linked frozen accounting", () => {
  it("classifies mixed payable FIFO portions instead of treating the whole payout as reversal", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const frozen = await freezeRefundAccountingForClientV2(
      client,
      scope,
      120_260,
      2,
      [
        payable("negative_correction", 100),
        payable("manual_refund", 120_160, "4"),
      ],
      [obligation(240_320)],
    );
    expect(frozen).toMatchObject({
      amountMinor: 120_260,
      settlementOnlyMinor: 100,
      reversalComponents: {
        merchandiseRevenueMinor: 98_182,
        shippingRevenueMinor: 9_091,
        paymentFeeRevenueMinor: 1_963,
        vatMinor: 10_924,
      },
      payableAllocations: [
        { payableKind: "negative_correction", amountMinor: 100 },
        { payableKind: "manual_refund", amountMinor: 120_160 },
      ],
      obligationAllocations: [{ obligationId, amountMinor: 120_260 }],
    });
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.query.mock.calls[0]![1]).toEqual([
      scope.merchantId,
      scope.storeId,
      scope.orderId,
    ]);
  });
  it("subtracts prior frozen reversals and gives the last refund exact remaining capacity", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const first = await freezeRefundAccountingForClientV2(
      client,
      scope,
      120_160,
      2,
      [payable()],
      [obligation(240_320)],
    );
    client.query.mockResolvedValue({
      rows: [
        {
          kind: "refund",
          amount_minor: 120_160,
          metadata: { refundAllocationV2: first },
        },
      ],
    });
    const second = await freezeRefundAccountingForClientV2(
      client,
      scope,
      120_160,
      2,
      [payable("manual_refund", 120_160, "4")],
      [obligation(120_160)],
    );
    expect(second?.reversalComponents).toEqual({
      merchandiseRevenueMinor: 98_182,
      shippingRevenueMinor: 9_091,
      paymentFeeRevenueMinor: 1_964,
      vatMinor: 10_923,
    });
  });
  it("continues rejecting unclassified capacities in the financial writer", async () => {
    const row = payable(); row.component_record = { ...component_record, unclassified_minor: 1, total_minor: 240321 };
    await expect(freezeRefundAccountingForClientV2({ query: vi.fn().mockResolvedValue({ rows: [] }) }, scope, 100, 2, [row], [obligation(100)]))
      .rejects.toMatchObject({ code: "financial_invariant_error", statusCode: 409 });
  });
  it("rejects an inconsistent legacy version before skipping metadata", async () => {
    const row = payable(); row.component_record = { ...component_record, component_version: 1, vat_minor: 21454, total_minor: 236000 };
    await expect(freezeRefundAccountingForClientV2({ query: vi.fn() }, scope, 100, 1, [row], [obligation(100)]))
      .rejects.toMatchObject({ code: "financial_invariant_error", statusCode: 409 });
  });
  it("leaves V1 payout metadata untouched and performs no new capacity read", async () => {
    const client = { query: vi.fn() };
    const row = payable();
    row.component_record = {
      ...component_record,
      component_version: 1,
      payment_fee_minor: 0,
      payment_fee_vat_minor: 0,
      vat_minor: 21_454,
      total_minor: 236_000,
    };
    expect(
      await freezeRefundAccountingForClientV2(
        client,
        scope,
        100,
        1,
        [row],
        [obligation(100)],
      ),
    ).toBeUndefined();
    expect(client.query).not.toHaveBeenCalled();
  });
  it("permits a proven legacy correction settlement before a V2 manual refund", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValue({
          rows: [
            {
              kind: "refund",
              amount_minor: 100,
              metadata: {},
              legacy_reversal: false,
              legacy_settlement_minor: 100,
            },
          ],
        }),
    };
    const frozen = await freezeRefundAccountingForClientV2(
      client,
      scope,
      120_160,
      2,
      [payable()],
      [obligation(240_320)],
    );
    expect(frozen?.reversalComponents.paymentFeeRevenueMinor).toBe(1_963);
  });
  it.each([
    {
      kind: "refund",
      amount_minor: 100,
      metadata: {},
      legacy_reversal: true,
      legacy_settlement_minor: 0,
    },
    {
      kind: "refund",
      amount_minor: 100,
      metadata: {},
      legacy_reversal: false,
      legacy_settlement_minor: 99,
    },
    {
      kind: "chargeback",
      amount_minor: 100,
      metadata: {},
      legacy_reversal: false,
      legacy_settlement_minor: 100,
    },
  ])(
    "does not infer unknown historical reversal capacities: %j",
    async (row) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [row] }) };
      await expect(
        readPriorRefundReversalsForClientV2(client, scope),
      ).rejects.toMatchObject({ code: "financial_invariant_error" });
    },
  );
});
