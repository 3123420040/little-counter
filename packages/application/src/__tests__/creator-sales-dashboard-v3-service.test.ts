import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "../db/client";
import { DashboardCommercialSliceV2Schema, RecordedGrossCollectionSliceV2Schema } from "@medusa-snus/contracts";
import { creatorSalesDashboardFixture } from "./fixtures/creator-sales-dashboard";
const reads = vi.hoisted(() => ({ snapshot: vi.fn(), commercial: vi.fn(), collection: vi.fn(), payment: vi.fn(), operational: vi.fn(), accounting: vi.fn(),
  creators: vi.fn(), negatives: vi.fn(), journals: vi.fn() }));
vi.mock("../services/dashboard-report-foundation", () => ({ withDashboardReadSnapshot: reads.snapshot }));
vi.mock("../services/dashboard-commercial-slice", () => ({ readDashboardCommercialSliceV2: reads.commercial }));
vi.mock("../services/dashboard-recorded-collection-slice", () => ({ readDashboardRecordedCollectionSliceV2: reads.collection }));
vi.mock("../services/dashboard-payment-flow-slice", () => ({ readDashboardPaymentFlowSliceV1: reads.payment }));
vi.mock("../services/dashboard-operational-snapshot", () => ({ readDashboardOperationalSnapshotV1: reads.operational }));
vi.mock("../services/dashboard-accounting-slice", () => ({ readDashboardAccountingSliceV1: reads.accounting }));
vi.mock("../services/creator-sales-overview-service", () => ({ assertCreatorSelectionInScopeV1: reads.creators }));
vi.mock("../services/dashboard-fee-negative-slice", () => ({ readDashboardFeeNegativeSliceV1: reads.negatives }));
vi.mock("../services/dashboard-fee-journal-slice", () => ({ readDashboardFeeJournalSliceV1: reads.journals }));
import { readCreatorSalesDashboardV3 } from "../services/creator-sales-dashboard-v2-service";
const fixture = creatorSalesDashboardFixture("full"), db = {} as PoolClient;
const context = fixture.context, date = "2026-10-18";
const commercial = DashboardCommercialSliceV2Schema.parse({ schemaVersion: 2, dailyActiveOrderCountSeries: [{ localDate: date, activeOrderCount: 1 }],
  currencies: [{ currencyCode: "VND", minorUnitExponent: 0, validOrderCount: 1, cancelledOrderCohortCount: 0, activeOrdersWithShippingCount: 0,
    currentOrderGrossValueMinor: 1100, dailyCurrentOrderGrossValueSeries: [{ localDate: date, currentOrderGrossValueMinor: 1100 }],
    currentMerchandiseGrossValueMinor: 1000, currentDiscountMinor: 0, currentMerchandiseRevenueExVatMinor: 909, currentShippingRevenueExVatMinor: 0,
    currentShippingGrossValueMinor: 0, currentShippingSharePercent: 0, currentVatMinor: 100, currentUnclassifiedMinor: 0, effectiveItemQuantity: 2,
    averageCurrentOrderValueMinor: 1100, currentCogsMinor: 50, currentMerchandiseGrossProfitMinor: 859, currentContributionBeforeShippingCostMinor: 859,
    costCoverage: { knownLines: 1, totalLines: 1 }, dataQuality: { status: "complete", costCoverage: { knownLines: 1, totalLines: 1 }, warnings: [] }, topProducts: [],
    currentPaymentFeeMinor: 100, currentPaymentFeeVatMinor: 9, currentPaymentFeeCustomerTotalMinor: 100, currentPaymentFeeRevenueExVatMinor: 91 }] });
const collection = RecordedGrossCollectionSliceV2Schema.parse({ schemaVersion: 2, aggregateReadSource: "app.payment_events", currencies: [{ currencyCode: "VND", minorUnitExponent: 0,
  postedChargeEventCount: 1, bundleCoverage: { validEvents: 1, totalEvents: 1 }, recordedGrossCollectionsMinor: 1100,
  dailyRecordedGrossCollectionsSeries: [{ localDate: date, recordedGrossCollectionsMinor: 1100 }], components: { taxModes: ["inclusive"], merchandiseGrossMinor: 1000,
    discountMinor: 0, merchandiseNetMinor: 1000, shippingMinor: 0, merchandiseVatMinor: 91, shippingVatMinor: 0, vatMinor: 100,
    vatIncludedInPriceMinor: 100, vatAddedToPriceMinor: 0, unclassifiedMinor: 0, totalMinor: 1100, paymentFeeMinor: 100,
    paymentFeeVatMinor: 9, paymentFeeVatIncludedInPriceMinor: 9, paymentFeeVatAddedToPriceMinor: 0 } }] });
const request = { scope: context.normalizedScope, range: { from: date, to: date }, creatorSelection: fixture.creatorSelection,
  audience: "self" as const, selfOperatorId: "staff_a", statementTimeoutMs: 5000 };
beforeEach(() => {
  vi.resetAllMocks();
  reads.snapshot.mockImplementation(async (_db, _input, read) => ({ data: await read(db, context), context }));
  reads.commercial.mockResolvedValue(structuredClone(commercial)); reads.collection.mockResolvedValue({ enabled: true, data: structuredClone(collection) });
  reads.creators.mockResolvedValue([...fixture.creatorOptions, { operatorId: "staff_b", displayName: "Other", status: "active" }]);
  reads.payment.mockResolvedValue([{ currencyCode: "VND", minorUnitExponent: 0, negativeCollectionsMinor: 0, methods: [{ method: "cash", postedChargeOrderCount: 1,
    postedNegativeEventCount: 0, recordedGrossCollectionsMinor: 1100, recordedNegativeCollectionsMinor: 0, recordedNetCollectionsMinor: 1100 }] }]);
  reads.operational.mockResolvedValue(fixture.operationalSnapshot); reads.accounting.mockResolvedValue(fixture.financial);
  reads.negatives.mockResolvedValue({ enabled: true, data: { schemaVersion: 1, aggregateReadSource: "app.payment_events", currencies: [] } });
  reads.journals.mockResolvedValue({ schemaVersion: 1, aggregateReadSource: "accounting.journal_entries", metricTimeBasis: "accounting_source_occurred_at",
    currencies: [{ currencyCode: "VND", minorUnitExponent: 0, revenueExcludingVatMinor: 91, verifiedSubsetRevenueExcludingVatMinor: 91,
      coverage: { status: "available", totalJournalCount: 1, coveredJournalCount: 1, excludedJournalCount: 0 }, warnings: [] }] });
});
describe("DashboardV3 snapshot and response allowlists", () => {
  it("returns self customer fee amounts and never reads or exposes owner financial sources", async () => {
    const result = await readCreatorSalesDashboardV3(db, request);
    expect(result).toMatchObject({ schemaVersion: 3, audience: "self", creatorOptions: fixture.creatorOptions,
      currencies: [{ currentPaymentFeeMinor: 100, currentPaymentFeeVatMinor: 9, currentPaymentFeeCustomerTotalMinor: 100,
        recordedGrossCollectionsMinor: 1100, recordedPaymentFeeCustomerTotalMinor: 100 }] });
    expect(JSON.stringify(result)).not.toMatch(/cogs|costCoverage|profit|financial|paymentFeeRevenue|feeRevenue|journal/i);
    expect(reads.accounting).not.toHaveBeenCalled(); expect(reads.negatives).not.toHaveBeenCalled(); expect(reads.journals).not.toHaveBeenCalled();
    expect(reads.snapshot).toHaveBeenCalledTimes(1); expect(reads.operational).toHaveBeenCalledWith(db, context);
  });
  it("keeps full sources and all reads on the same snapshot and creator selection", async () => {
    const result = await readCreatorSalesDashboardV3(db, { ...request, audience: "full" });
    expect(result).toMatchObject({ schemaVersion: 3, audience: "full", feeFinancial: { currencies: [{ currentPaymentFeeRevenueExVatMinor: 91,
      recordedPaymentFeeRevenueExVatMinor: 91 }], journals: { currencies: [{ revenueExcludingVatMinor: 91 }] } } });
    expect(reads.negatives).toHaveBeenCalledWith(db, context, { enabled: true }, request.creatorSelection);
    expect(reads.journals).toHaveBeenCalledWith(db, context, request.creatorSelection);
    expect(reads.accounting).toHaveBeenCalledWith(db, context, request.creatorSelection);
    expect(reads.operational).toHaveBeenCalledWith(db, context);
  });
  it("rejects daily alignment drift instead of dropping the old composer validation", async () => {
    const changed = structuredClone(collection); changed.currencies[0]!.dailyRecordedGrossCollectionsSeries![0]!.localDate = "2026-10-19";
    reads.collection.mockResolvedValue({ enabled: true, data: changed });
    await expect(readCreatorSalesDashboardV3(db, request)).rejects.toMatchObject({ code: "dashboard_partial_financial_invalid" });
  });
  it("rejects negative-event count/amount mismatch against the same payment flows", async () => {
    reads.payment.mockResolvedValue([{ currencyCode: "VND", minorUnitExponent: 0, negativeCollectionsMinor: 1, methods: [] }]);
    reads.negatives.mockResolvedValue({ enabled: true, data: { schemaVersion: 1, aggregateReadSource: "app.payment_events", currencies: [{ currencyCode: "VND",
      minorUnitExponent: 0, feeRevenueReversedExVatMinor: 0, verifiedSubsetFeeRevenueReversedExVatMinor: 0, verifiedSubsetSettlementOnlyMinor: 0,
      coverage: { status: "available", coveredEventCount: 1, excludedEventCount: 0, totalEventCount: 1, coveredNegativeMinor: 2, excludedNegativeMinor: 0, totalNegativeMinor: 2 }, warnings: [] }] } });
    await expect(readCreatorSalesDashboardV3(db, { ...request, audience: "full" })).rejects.toMatchObject({ code: "dashboard_response_invalid" });
  });
  it("rejects equal negative amounts with a different number of events", async () => {
    reads.payment.mockResolvedValue([{ currencyCode: "VND", minorUnitExponent: 0, negativeCollectionsMinor: 2,
      methods: [{ method: "cash", postedChargeOrderCount: 1, postedNegativeEventCount: 2,
        recordedGrossCollectionsMinor: 1100, recordedNegativeCollectionsMinor: 2, recordedNetCollectionsMinor: 1098 }] }]);
    reads.negatives.mockResolvedValue({ enabled: true, data: { schemaVersion: 1, aggregateReadSource: "app.payment_events", currencies: [{ currencyCode: "VND",
      minorUnitExponent: 0, feeRevenueReversedExVatMinor: 0, verifiedSubsetFeeRevenueReversedExVatMinor: 0, verifiedSubsetSettlementOnlyMinor: 0,
      coverage: { status: "available", coveredEventCount: 1, excludedEventCount: 0, totalEventCount: 1, coveredNegativeMinor: 2, excludedNegativeMinor: 0, totalNegativeMinor: 2 }, warnings: [] }] } });
    await expect(readCreatorSalesDashboardV3(db, { ...request, audience: "full" })).rejects.toMatchObject({ code: "dashboard_response_invalid" });
  });
  it.each([{ mode: "all", creatorOperatorIds: [] }, { mode: "selected", creatorOperatorIds: ["staff_b"] }])("rejects tampered self selection before snapshot: %j", async selection => {
    await expect(readCreatorSalesDashboardV3(db, { ...request, creatorSelection: selection })).rejects.toMatchObject({ code: "forbidden" });
    expect(reads.snapshot).not.toHaveBeenCalled();
  });
});
