import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { shutdownPlatformDb } from "../platform-db";
import { readDashboardPartialFinancialSnapshotV1 } from "../services/dashboard-partial-financial-model";

let client: PoolClient;

function localDate(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

beforeAll(async () => {
  client = await connectPlatformClient();
});

afterAll(async () => {
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("dashboard partial financial real PostgreSQL snapshot", () => {
  it("reconciles canonical commercial, payment methods and signed flow in one snapshot", async () => {
    const date = localDate(new Date());
    const result = await readDashboardPartialFinancialSnapshotV1(client, {
      scope: {
        scopeKind: "report",
        merchantId: "merchant_default",
        storeIds: ["store_default"],
      },
      range: { from: date, to: date },
      statementTimeoutMs: 10_000,
    }, { enabled: true });
    if (!result.enabled) throw new Error("expected enabled dashboard snapshot");
    expect(result.snapshot.context.normalizedScope).toEqual({
      scopeKind: "report",
      merchantId: "merchant_default",
      storeIds: ["store_default"],
    });
    expect(new Set(result.snapshot.data.currencies.map((item) => item.currencyCode)).size)
      .toBe(result.snapshot.data.currencies.length);
    for (const currency of result.snapshot.data.currencies) {
      expect(currency.currentOrder.commercialMetrics).toBeDefined();
      expect(currency.recordedCollection.recordedGrossCollectionsMinor
        - currency.paymentFlow!.negativeCollectionsMinor)
        .toBe(currency.paymentFlow!.netCollectionsMinor);
      const methodGross = (currency.paymentFlow!.methods || [])
        .reduce((sum, method) => sum + method.recordedGrossCollectionsMinor, 0);
      const methodNegative = (currency.paymentFlow!.methods || [])
        .reduce((sum, method) => sum + method.recordedNegativeCollectionsMinor, 0);
      expect(methodGross).toBe(currency.recordedCollection.recordedGrossCollectionsMinor);
      expect(methodNegative).toBe(currency.paymentFlow!.negativeCollectionsMinor);
    }
  });
});
