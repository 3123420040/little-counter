import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DASHBOARD_METRIC_TIME_BASIS_V2, type CreatorSelectionV1 } from "@medusa-snus/contracts";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { seedCreatorSalesOracle, type CreatorSalesOracle } from "./helpers/creator-sales-oracle-fixture";
import { readDashboardCommercialSliceV1 } from "../services/dashboard-commercial-slice";
import { readDashboardPaymentFlowSliceV1 } from "../services/dashboard-payment-flow-slice";
import type { DashboardSnapshotReadContext } from "../services/dashboard-report-foundation";
import { readDashboardRecordedCollectionSliceV1 } from "../services/dashboard-recorded-collection-slice";

interface ExpectedSelection {
  orderListCount: number; soldItemQuantity: number; currentOrderGrossValueMinor: number;
  refundPayableAsOfMinor: number;
  dashboardPaymentMixVnd: Record<string, { postedChargeOrderCount: number; grossMinor: number; negativeMinor: number; netMinor: number }>;
}
const oracle = JSON.parse(readFileSync("packages/application/src/__tests__/fixtures/creator-sales.expected.json", "utf8")) as CreatorSalesOracle & { expected: Record<string, ExpectedSelection> };
let pool: Pool, client: PoolClient;
let scoped: (id: string) => string;
let context: DashboardSnapshotReadContext;
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString }); client = await pool.connect();
  await assertSafeTestDatabaseSentinel(client, target);
  await client.query("BEGIN");
  ({ scoped } = await seedCreatorSalesOracle(client, oracle, `cs-oracle-${randomUUID()}`));
  const store = scoped("uat_store_1");
  context = {
    normalizedScope: { scopeKind: "report", merchantId: scoped("uat_merchant_1"), storeIds: [store] },
    localDateRange: { from: "2026-10-18", to: "2026-10-18", inclusiveDays: 1 },
    storeTimeWindows: [{ storeId: store, timeZone: "Asia/Ho_Chi_Minh", startInclusive: "2026-10-17T17:00:00Z", endExclusive: "2026-10-18T17:00:00Z" }],
    reportAsOf: "2026-10-18T09:00:00Z", metricTimeBasis: DASHBOARD_METRIC_TIME_BASIS_V2,
  };
});
afterAll(async () => { await client?.query("ROLLBACK"); client?.release(); await pool?.end(); });
describe("approved independent creator-sales fixture oracle", () => {
  it.each([["A1", true, false], ["B1", false, false], ["U1", true, false], ["P1", false, false], ["A1", true, true]] as const)("quarantine source %s, blocks A=%s, conflicting creation=%s", async (order, blocks, conflict) => {
    await client.query("SAVEPOINT quarantine_branch");
    try {
      const runId = randomUUID(), hash = runId.replaceAll("-", "").repeat(2);
      if (conflict) await client.query(`INSERT INTO audit.events
        (actor_type,actor_id,action,subject_type,subject_id,correlation_id,merchant_id,store_id)
        VALUES('staff',$1,'order.created','order',$2,$2,$3,$4)`,
      [scoped("uat_staff_B"),scoped(order),scoped("uat_merchant_1"),scoped("uat_store_1")]);
      await client.query(`INSERT INTO app.historical_reconciliation_runs
        (id,schema_id,run_kind,source_snapshot_id,manifest_sha256,quarantine_sha256,classifier_source_sha256,
         classifier_artifact_sha256,source_application_sha,database_schema_sha256,custom_migration_ledger_sha256,
         medusa_migration_ledger_sha256,source_preservation_inventory_sha256,candidate_count,accepted_count,
         quarantine_count,no_op_count,actor,reason,started_at,committed_at)
        VALUES($1,'snus-historical-foundation-manifest/v1','classification','synthetic',$2,$2,$2,$2,$2,$2,$2,$2,$2,
         1,0,1,0,'synthetic','Creator quarantine UAT','2026-10-18T04:00:00Z','2026-10-18T04:01:00Z')`, [runId,hash]);
      await client.query(`INSERT INTO app.historical_reconciliation_items
        (run_id,manifest_row_number,merchant_id,store_id,order_id,currency_code,source_table,source_id,
         source_occurred_at,source_payload_sha256,target_fact_kind,target_idempotency_key,component_amounts_minor,
         decision,reason_code,recorded_at)
        VALUES($1::uuid,1,$2,$3,$4,'VND','app.payment_entries',$1::text,'2026-10-18T04:00:00Z',$5,
         'recorded_collection',$1::text,'{"amount_minor":100000}','quarantine','synthetic_ambiguous_payment','2026-10-18T04:01:00Z')`,
      [runId,scoped("uat_merchant_1"),scoped("uat_store_1"),scoped(order),hash]);
      const read = readDashboardRecordedCollectionSliceV1(client, context, { enabled: true },
        { mode: "selected", creatorOperatorIds: [scoped("uat_staff_A")] });
      if (blocks) await expect(read).rejects.toMatchObject({ code: "dashboard_recorded_collection_data_quality" });
      else await expect(read).resolves.toMatchObject({ enabled: true });
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT quarantine_branch");
      await client.query("RELEASE SAVEPOINT quarantine_branch");
    }
  });
  it.each(["all", "A", "B", "A_B", "C"])("matches commercial and payment event totals for %s", async (key) => {
    const expected = oracle.expected[key]!;
    const ids = key === "all" ? [] : key.split("_").map((suffix) => scoped(suffix === "C" ? "uat_former_C" : `uat_staff_${suffix}`));
    const selection: CreatorSelectionV1 = { mode: key === "all" ? "all" : "selected", creatorOperatorIds: ids };
    const commercial = await readDashboardCommercialSliceV1(client, context, selection);
    expect(commercial.currencies[0]).toMatchObject({
      effectiveItemQuantity: expected.soldItemQuantity, currentOrderGrossValueMinor: expected.currentOrderGrossValueMinor,
    });
    expect(commercial.currencies[0]!.validOrderCount + commercial.currencies[0]!.cancelledOrderCohortCount).toBe(expected.orderListCount);
    const payments = await readDashboardPaymentFlowSliceV1(client, context, selection);
    expect(payments[0]!.customerRefundPayableAsOfMinor).toBe(expected.refundPayableAsOfMinor);
    for (const [method, totals] of Object.entries(expected.dashboardPaymentMixVnd)) {
      const actual = payments[0]!.methods.find((row) => row.method === method);
      if (!actual && Object.values(totals).every((value) => value === 0)) continue;
      expect(actual).toMatchObject({
        postedChargeOrderCount: totals.postedChargeOrderCount, recordedGrossCollectionsMinor: totals.grossMinor,
        recordedNegativeCollectionsMinor: totals.negativeMinor, recordedNetCollectionsMinor: totals.netMinor,
      });
    }
  });
});
