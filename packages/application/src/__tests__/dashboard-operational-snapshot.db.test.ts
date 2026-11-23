import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { shutdownPlatformDb } from "../platform-db";
import { readDashboardOperationalSnapshotV1 } from "../services/dashboard-operational-snapshot";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const merchantId = `dash-customer-merchant-${runId}`;
const otherMerchantId = `dash-customer-other-${runId}`;
const storeId = `dash-customer-store-${runId}`;
const stockLocationId = `dash-customer-sloc-${runId}`;
const customerIds = [
  `dash-customer-start-${runId}`,
  `dash-customer-end-${runId}`,
  `dash-customer-before-${runId}`,
  `dash-customer-after-${runId}`,
  `dash-customer-other-${runId}`,
];

let client: PoolClient;

beforeAll(async () => {
  client = await connectPlatformClient();
  await client.query(`
    INSERT INTO app.merchants (
      id, display_name, legacy_organization_id, status, metadata
    ) VALUES
      ($1, $1, $3, 'active', '{}'::jsonb),
      ($2, $2, $4, 'active', '{}'::jsonb)
  `, [
    merchantId,
    otherMerchantId,
    `org-${merchantId}`,
    `org-${otherMerchantId}`,
  ]);
  await client.query(`
    INSERT INTO public.stock_location (id, name)
    VALUES ($1, $1)
  `, [stockLocationId]);
  await client.query(`
    INSERT INTO app.stores (
      id, merchant_id, display_name, stock_location_id,
      is_primary, status, metadata
    ) VALUES (
      $1, $2, $1, $3, true, 'active', '{}'::jsonb
    )
  `, [storeId, merchantId, stockLocationId]);
  await client.query(`
    INSERT INTO public.customer (id, merchant_id, created_at)
    VALUES
      ($1, $6, '2026-08-16T17:00:00.000Z'::timestamptz),
      ($2, $6, '2026-08-17T16:59:59.000Z'::timestamptz),
      ($3, $6, '2026-08-16T16:59:59.999Z'::timestamptz),
      ($4, $6, '2026-08-17T17:00:00.000Z'::timestamptz),
      ($5, $7, '2026-08-17T04:00:00.000Z'::timestamptz)
  `, [
    customerIds[0],
    customerIds[1],
    customerIds[2],
    customerIds[3],
    customerIds[4],
    merchantId,
    otherMerchantId,
  ]);
});

afterAll(async () => {
  await client?.query(
    "DELETE FROM public.customer WHERE id = ANY($1::text[])",
    [customerIds],
  ).catch(() => undefined);
  await client?.query(
    "DELETE FROM app.stores WHERE id = $1",
    [storeId],
  ).catch(() => undefined);
  await client?.query(
    "DELETE FROM public.stock_location WHERE id = $1",
    [stockLocationId],
  ).catch(() => undefined);
  await client?.query(
    "DELETE FROM app.merchants WHERE id = ANY($1::text[])",
    [[merchantId, otherMerchantId]],
  ).catch(() => undefined);
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("dashboard merchant customer acquisition PostgreSQL boundary", () => {
  it("counts exact merchant-owned customer records on Asia/Ho_Chi_Minh local dates", async () => {
    const snapshot = await readDashboardOperationalSnapshotV1(client, {
      normalizedScope: {
        scopeKind: "report",
        merchantId,
        storeIds: [storeId],
      },
      localDateRange: {
        from: "2026-08-17",
        to: "2026-08-17",
        inclusiveDays: 1,
      },
      storeTimeWindows: [{
        storeId,
        timeZone: "Asia/Ho_Chi_Minh",
        startInclusive: "2026-08-16T17:00:00.000Z",
        endExclusive: "2026-08-17T17:00:00.000Z",
      }],
      reportAsOf: "2026-08-17T16:59:59.999Z",
      metricTimeBasis: {
        recordedGrossCollectionsMinor: "payment_event_at",
        refundsMinor: "payment_event_at",
        reversalsMinor: "payment_event_at",
        chargebacksMinor: "payment_event_at",
        currentOrderGrossValueMinor: "effective_order_created_at",
        commercialOutstandingAsOfMinor: "as_of_effective_order_and_payment_events",
        customerRefundPayableAsOfMinor: "as_of_payment_events",
        revenueExcludingVatMinor: "accounting_source_occurred_at",
        vatLiabilityMinor: "accounting_source_occurred_at",
        cogsRecognizedMinor: "accounting_source_occurred_at",
      },
    });

    expect(snapshot.reportMerchantCustomerAcquisition).toEqual({
      status: "available",
      dataQualityStatus: "complete",
      attributionScope: "report_merchant",
      businessTimeZone: "Asia/Ho_Chi_Minh",
      newCustomerCount: 2,
    });
  });
});
