import { beforeEach, describe, expect, it, vi } from "vitest";
import { creatorSalesDashboardFixture } from "./fixtures/creator-sales-dashboard";
import type { PoolClient } from "../db/client";
const reads = vi.hoisted(() => ({ snapshot: vi.fn(), commercial: vi.fn(), payment: vi.fn(), operational: vi.fn(), accounting: vi.fn(), creators: vi.fn(), collection: vi.fn(), compose: vi.fn() }));
vi.mock("../services/dashboard-report-foundation", () => ({ withDashboardReadSnapshot: reads.snapshot }));
vi.mock("../services/dashboard-commercial-slice", () => ({ readDashboardCommercialSliceV1: reads.commercial }));
vi.mock("../services/dashboard-payment-flow-slice", () => ({ readDashboardPaymentFlowSliceV1: reads.payment }));
vi.mock("../services/dashboard-operational-snapshot", () => ({ readDashboardOperationalSnapshotV1: reads.operational }));
vi.mock("../services/dashboard-accounting-slice", () => ({ readDashboardAccountingSliceV1: reads.accounting }));
vi.mock("../services/creator-sales-overview-service", () => ({ assertCreatorSelectionInScopeV1: reads.creators }));
vi.mock("../services/dashboard-recorded-collection-slice", () => ({ readDashboardRecordedCollectionSliceV1: reads.collection }));
vi.mock("../services/dashboard-partial-financial-model", () => ({ composeDashboardPartialFinancialModelV1: reads.compose }));
vi.mock("../services/dashboard-fee-journal-slice", () => ({ readDashboardFeeJournalSliceV1: vi.fn() }));
vi.mock("../services/dashboard-fee-negative-slice", () => ({ readDashboardFeeNegativeSliceV1: vi.fn() }));
import { readCreatorSalesDashboardV2 } from "../services/creator-sales-dashboard-v2-service";

const fixture = creatorSalesDashboardFixture("full");
const client = {} as PoolClient;
const request = {
  scope: fixture.context.normalizedScope, range: { from: "2026-10-18", to: "2026-10-18" },
  creatorSelection: fixture.creatorSelection, audience: "self" as const, selfOperatorId: "staff_a", statementTimeoutMs: 5000,
};
beforeEach(() => {
  vi.resetAllMocks();
  reads.snapshot.mockImplementation(async (_client, _request, read) => ({ data: await read(client, fixture.context), context: fixture.context }));
  reads.creators.mockResolvedValue([...fixture.creatorOptions, { operatorId: "staff_b", displayName: "Binh", status: "active" }]);
  const currency = fixture.currencies[0];
  reads.commercial.mockResolvedValue({
    schemaVersion: 1,
    dailyActiveOrderCountSeries: currency.dailySeries,
    currencies: [{ ...currency, validOrderCount: currency.activeOrderCount, cancelledOrderCohortCount: currency.orderCount - currency.activeOrderCount,
      dailyCurrentOrderGrossValueSeries: currency.dailySeries,
      currentCogsMinor: 600, currentMerchandiseGrossProfitMinor: 400,
      topProducts: currency.topProducts.map((product) => ({ ...product, currentCogsMinor: 600, costCoverage: { knownLines: 1, totalLines: 1 } })),
    }],
  });
  reads.payment.mockResolvedValue([{ ...currency, methods: currency.paymentMethods.map((method) => ({
    ...method, recordedGrossCollectionsMinor: method.grossMinor, recordedNegativeCollectionsMinor: method.negativeMinor, recordedNetCollectionsMinor: method.netMinor,
  })) }]);
  reads.operational.mockResolvedValue(fixture.operationalSnapshot);
  reads.accounting.mockResolvedValue(fixture.financial);
  reads.collection.mockResolvedValue({ enabled: true, data: { schemaVersion: 1, currencies: [] } });
});

describe("creator dashboard response projection", () => {
  it("returns the exact self selection and never reads or exposes accounting or nested cost", async () => {
    const result = await readCreatorSalesDashboardV2(client, request);
    expect(result.creatorOptions).toEqual(fixture.creatorOptions);
    expect(result.currencies[0]).toEqual(fixture.currencies[0]);
    expect(result.context).toEqual(fixture.context);
    expect(result.operationalSnapshot).toEqual(fixture.operationalSnapshot);
    expect(reads.accounting).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/cogs|costCoverage|profit|financial/i);
    expect(reads.commercial).toHaveBeenCalledWith(client, fixture.context, fixture.creatorSelection);
    expect(reads.payment).toHaveBeenCalledWith(client, fixture.context, fixture.creatorSelection);
    expect(reads.collection).toHaveBeenCalledWith(client, fixture.context, { enabled: true }, fixture.creatorSelection);
    expect(reads.compose).toHaveBeenCalled();
  });
  it("keeps full accounting scoped to the same creators and operational counts unfiltered", async () => {
    const result = await readCreatorSalesDashboardV2(client, { ...request, audience: "full" });
    expect(result.financial).toEqual(fixture.financial);
    expect(reads.accounting).toHaveBeenCalledWith(client, fixture.context, fixture.creatorSelection);
    expect(reads.operational).toHaveBeenCalledWith(client, fixture.context);
  });
  it.each([
    { mode: "all", creatorOperatorIds: [] },
    { mode: "selected", creatorOperatorIds: ["staff_b"] },
    { mode: "selected", creatorOperatorIds: ["staff_a", "staff_b"] },
  ] as const)("rejects a tampered self selection before reading any data: %j", async (selection) => {
    await expect(readCreatorSalesDashboardV2(client, { ...request, creatorSelection: structuredClone(selection) as typeof request.creatorSelection })).rejects.toMatchObject({ code: "forbidden" });
    expect(reads.snapshot).not.toHaveBeenCalled();
  });
});
