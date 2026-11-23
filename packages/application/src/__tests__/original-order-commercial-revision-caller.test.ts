import { describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import {
  ORIGINAL_ORDER_COMMERCIAL_REVISION_CALLER_DEFAULT_CONFIG_V1,
  OriginalOrderCommercialRevisionCallerValidationErrorV1,
  recordOriginalOrderCommercialRevisionFromOrderCreateV1,
  recordOriginalOrderCommercialRevisionFromOrderCreateV2,
  type OriginalOrderCommercialRevisionCallerInputV1,
  type OriginalOrderCommercialRevisionCallerInputV2,
} from "../services/original-order-commercial-revision-caller";
import { calculateOrderTotals, calculateOrderTotalsV2 } from "../services/order-total-service";

const revisionId = "00000000-0000-4000-8000-000000000101";

function input(
  taxMode: "inclusive" | "exclusive" = "inclusive",
): OriginalOrderCommercialRevisionCallerInputV1 {
  const commercialContext = { taxMode, vatRate: 0.1 } as const;
  return {
    merchantId: "merchant-a",
    storeId: "store-a",
    orderId: "order-a",
    orderCreatedAt: "2026-08-05T04:00:00.000Z",
    currencyCode: "VND",
    minorUnitExponent: 0,
    commercialContext,
    totals: calculateOrderTotals(110_000, {}, 11_000, commercialContext),
    lines: [{
      orderLineItemId: "ordli-a",
      productId: "product-a",
      variantId: "variant-a",
      skuSnapshot: "SKU-A",
      titleSnapshot: "Product A",
      quantity: 1,
      unitPriceMinor: 110_000,
      unitCostMinor: 50_000,
      costEvidenceSource: "inventory.product_settings",
      costEvidenceUpdatedAt: "2026-08-05T03:59:00.000Z",
    }],
  };
}

class FakeClient {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = [];
  failMarker: string | null = null;

  async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (this.failMarker && sql.includes(this.failMarker)) {
      throw new Error(`forced failure at ${this.failMarker}`);
    }
    if (sql.includes("original_order_commercial_revision_existing")) {
      return { rows: [] as T[] };
    }
    if (sql.includes("insert_revision")) return { rows: [{ id: revisionId }] as T[] };
    if (sql.includes("insert_components")) return { rows: [{ id: revisionId }] as T[] };
    if (sql.includes("insert_line")) {
      return { rows: [{ id: "00000000-0000-4000-8000-000000000201" }] as T[] };
    }
    return { rows: [] as T[] };
  }
}

function execute(
  fake: FakeClient,
  value: OriginalOrderCommercialRevisionCallerInputV1 = input(),
  enabled = true,
) {
  return recordOriginalOrderCommercialRevisionFromOrderCreateV1({
    client: fake as unknown as PoolClient,
    config: { enabled },
    transactionContext: {
      ownership: "caller",
      orderCreatedInCurrentTransaction: true,
    },
    repositoryOptions: { statementTimeoutMs: 5_000, lockTimeoutMs: 1_000 },
  }, value);
}

function feeInput(): OriginalOrderCommercialRevisionCallerInputV2 {
  const base = input();
  const commercialContext = { taxMode: "inclusive" as const, vatRatePpm: 100_000 };
  return { ...base, commercialContext,
    totals: calculateOrderTotalsV2(240_000, { discountPercent: 10, paymentFeeType: "percent", paymentFeeValue: 2 }, 20_000, commercialContext),
    lines: [{ ...base.lines[0]!, unitPriceMinor: 240_000 }],
  };
}
function executeFee(fake: FakeClient, value = feeInput(), enabled = true) {
  return recordOriginalOrderCommercialRevisionFromOrderCreateV2({ client: fake as unknown as PoolClient,
    config: { enabled }, transactionContext: { ownership: "caller", orderCreatedInCurrentTransaction: true },
    repositoryOptions: { statementTimeoutMs: 5_000, lockTimeoutMs: 1_000 },
  }, value);
}
describe("original V2 caller from actual calculator", () => {
  it("maps O1 and keeps the surrounding transaction owned by the caller", async () => {
    const fake = new FakeClient();
    expect(await executeFee(fake)).toMatchObject({ enabled: true, kind: "recorded", outcome: "inserted", revisionId });
    const components = fake.calls.find((call) => call.sql.includes("insert_components"));
    expect(components?.params?.slice(-2)).toEqual([4_320, 393]);
    const revision = fake.calls.find((call) => call.sql.includes("insert_revision"));
    expect(JSON.parse(String(revision?.params?.at(-1)))).toMatchObject({ bundleVersion: 2, commercialCalculationVersion: 2,
      paymentFee: { paymentFeeType: "percent", paymentFeeValue: 2, paymentFeeBasisMinor: 216_000 } });
    expect(fake.calls.some((call) => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql.trim()))).toBe(false);
  });
  it("rejects tampered resolved totals before any SQL", async () => {
    const fake = new FakeClient(), value = feeInput();
    value.totals.paymentFeeMinor += 1;
    await expect(executeFee(fake, value)).rejects.toThrow("calculator policy");
    expect(fake.calls).toEqual([]);
  });
  it("rejects a mismatched tax context before any SQL", async () => {
    const fake = new FakeClient(), value = feeInput();
    value.commercialContext.vatRatePpm = 0;
    await expect(executeFee(fake, value)).rejects.toThrow("calculator policy");
    expect(fake.calls).toEqual([]);
  });
  it("retains an explicit disabled no-SQL seam", async () => {
    const fake = new FakeClient();
    expect(await executeFee(fake, feeInput(), false)).toEqual({ enabled: false, status: "disabled" });
    expect(fake.calls).toEqual([]);
  });
});

describe("ORD-CALL-01 original-order commercial revision caller", () => {
  it("is default-on and retains an explicit disabled no-SQL seam", async () => {
    const fake = new FakeClient();
    expect(ORIGINAL_ORDER_COMMERCIAL_REVISION_CALLER_DEFAULT_CONFIG_V1).toEqual({
      enabled: true,
    });
    expect(Object.isFrozen(ORIGINAL_ORDER_COMMERCIAL_REVISION_CALLER_DEFAULT_CONFIG_V1)).toBe(true);
    await expect(execute(fake, { ...input(), merchantId: "" }, false)).resolves.toEqual({
      enabled: false,
      status: "disabled",
    });
    expect(fake.calls).toEqual([]);
  });

  it("requires explicit caller-owned same-transaction provenance before SQL", async () => {
    const fake = new FakeClient();
    await expect(recordOriginalOrderCommercialRevisionFromOrderCreateV1({
      client: fake as unknown as PoolClient,
      config: { enabled: true },
      transactionContext: {
        ownership: "repository" as never,
        orderCreatedInCurrentTransaction: true,
      },
      repositoryOptions: { statementTimeoutMs: 5_000, lockTimeoutMs: 1_000 },
    }, input())).rejects.toThrow("caller-owned order transaction context");
    expect(fake.calls).toEqual([]);
  });

  it("maps an exact inclusive calculator result without adding VAT again", async () => {
    const fake = new FakeClient();
    await expect(execute(fake)).resolves.toMatchObject({
      enabled: true,
      kind: "recorded",
      outcome: "inserted",
      revision: 0,
      orderId: "order-a",
      revisionId,
    });
    const componentInsert = fake.calls.find((call) => call.sql.includes("insert_components"));
    expect(componentInsert?.params).toEqual([
      revisionId,
      "merchant-a",
      "store-a",
      "order-a",
      "inclusive",
      110_000,
      0,
      110_000,
      11_000,
      10_000,
      1_000,
      11_000,
      0,
      121_000,
    ]);
    expect(fake.calls.some((call) => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql.trim()))).toBe(false);
  });

  it("maps an exact exclusive calculator result and adds VAT once", async () => {
    const fake = new FakeClient();
    await expect(execute(fake, input("exclusive"))).resolves.toMatchObject({
      enabled: true,
      kind: "recorded",
      outcome: "inserted",
    });
    const componentInsert = fake.calls.find((call) => call.sql.includes("insert_components"));
    expect(componentInsert?.params?.slice(-6)).toEqual([
      11_000,
      11_000,
      1_100,
      12_100,
      0,
      133_100,
    ]);
  });

  it("rejects calculator/context/lineage drift before SQL", async () => {
    const cases: OriginalOrderCommercialRevisionCallerInputV1[] = [
      { ...input(), totals: { ...input().totals, total: 132_000 } },
      { ...input(), commercialContext: { taxMode: "exclusive", vatRate: 0.1 } },
      { ...input(), commercialContext: { taxMode: "inclusive", vatRate: 0.1000001 } },
      { ...input(), lines: [{ ...input().lines[0]!, costEvidenceUpdatedAt: "" }] },
      { ...input(), lines: [{ ...input().lines[0]!, unitPriceMinor: 109_999 }] },
    ];
    for (const value of cases) {
      const fake = new FakeClient();
      await expect(execute(fake, value)).rejects.toBeInstanceOf(
        OriginalOrderCommercialRevisionCallerValidationErrorV1,
      );
      expect(fake.calls).toEqual([]);
    }
  });

  it("propagates repository failure to the outer transaction without transaction control", async () => {
    const fake = new FakeClient();
    fake.failMarker = "insert_components";
    await expect(execute(fake)).rejects.toThrow("forced failure at insert_components");
    expect(fake.calls.some((call) => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql.trim()))).toBe(false);
  });
});
