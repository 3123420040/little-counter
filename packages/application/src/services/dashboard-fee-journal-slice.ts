import { z } from "zod";
import { CreatorSelectionV1Schema, DashboardFeeJournalSliceV1Schema, SUPPORTED_CURRENCY_REGISTRY_V1,
  type CreatorSelectionV1, type DashboardFeeJournalCurrencyV1, type DashboardFeeJournalSliceV1 } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { dashboardAccountingSourceCtes } from "./dashboard-accounting-slice";
import { readDashboardFeeNegativeEventEvidenceV1, type DashboardFeeNegativeEventEvidenceV1 } from "./dashboard-fee-negative-slice";
import { normalizeDashboardPaymentReadContext } from "./dashboard-recorded-collection-slice";
import type { DashboardSnapshotReadContext } from "./dashboard-report-foundation";
import { readRefundCommercialBasisV2, sumPriorRefundReversalsV2 } from "./refund-commercial-allocation-service";

const FEE_JOURNAL_SQL = `${dashboardAccountingSourceCtes("fee_revenue")}
  SELECT mapped.* FROM mapped_sources mapped
  JOIN store_windows windows ON windows.store_id=mapped.store_id
  WHERE ($6::text='all' OR mapped.selected_creator OR mapped.original_creator_id IS NULL)
    AND (mapped.source_at IS NULL OR (mapped.source_at >= windows.start_inclusive AND mapped.source_at < LEAST(windows.end_exclusive,$5::timestamptz)))
  ORDER BY mapped.currency_code,mapped.source_at,mapped.id
`;
type Row = Record<string, unknown>;
type Warning = DashboardFeeJournalCurrencyV1["warnings"][number];
function invalid(): never { throw new PlatformError("dashboard_fee_journal_data_quality", "Fee journal source identity is invalid", 422); }
function units(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") || !/^-?(0|[1-9]\d*)(?:\.0+)?$/.test(String(value))) return invalid();
  const n = Number(value); if (!Number.isSafeInteger(n)) return invalid(); return n;
}
function count(value: unknown): number { const n = units(value); if (n < 0) return invalid(); return n; }
function feeBasis(raw: unknown, row: Row, current: boolean): number {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  const c = raw as Record<string, unknown>;
  if (c.merchant_id !== row.merchant_id || c.store_id !== row.store_id || c.order_id !== row.order_id
    || c.currency_code !== row.currency_code || count(c.minor_unit_exponent) !== count(row.minor_unit_exponent)
    || (current && c.revision_id !== row.revision_id)) return invalid();
  const basis = readRefundCommercialBasisV2({ commercial_revision_id: c.revision_id, component_record: c });
  if (basis.unclassifiedMinor !== 0) return invalid(); return basis.capacities.paymentFeeRevenueMinor;
}
function qualify(row: Row, negatives: Map<string, DashboardFeeNegativeEventEvidenceV1>): { revenue: number } | Warning {
  if (!["order", "order_correction", "order_cancellation", "refund"].includes(String(row.reference_type))) return "unsupported_reference_type";
  if (row.source_order_found !== true || !row.order_id || !row.revision_id || !row.source_at || row.data_quality === "unavailable") return "missing_source_mapping";
  try {
    if (count(row.revision_count) !== count(row.revision_number) + 1 || count(row.invalid_revision_count) !== 0) return "missing_source_mapping";
    if (count(row.fractional_line_count) !== 0) return "fractional_minor_units";
    const revenue = units(row.payment_fee_revenue_minor), debit = units(row.debit_total), credit = units(row.credit_total);
    if (debit !== credit || debit <= 0) return "unbalanced_journal";
    if (!SUPPORTED_CURRENCY_REGISTRY_V1.some(c => c.currencyCode === row.currency_code && c.minorUnitExponent === count(row.minor_unit_exponent))) return "unsupported_currency";
    let expected: number;
    if (row.reference_type === "refund") {
      const proof = negatives.get(String(row.refund_event_id));
      if (!proof || typeof proof.proof === "string" || proof.amountMinor !== count(row.refund_event_amount_minor)
        || proof.currencyCode !== row.currency_code || proof.minorUnitExponent !== count(row.minor_unit_exponent)) return "unavailable_refund_evidence";
      expected = -proof.proof.fee;
    } else {
      const current = feeBasis(row.fee_components, row, true);
      if (row.reference_type === "order") { if (count(row.revision_number) !== 0) return "fee_lineage_mismatch"; expected = current; }
      else {
        if (count(row.revision_number) === 0) return "fee_lineage_mismatch";
        const previous = feeBasis(row.previous_fee_components, row, false);
        if (row.reference_type === "order_cancellation") {
          const priorRefunds = sumPriorRefundReversalsV2(z.array(z.record(z.string(), z.unknown())).parse(row.prior_refund_events));
          if (priorRefunds.paymentFeeRevenueMinor > previous) return "fee_lineage_mismatch";
          expected = -previous + priorRefunds.paymentFeeRevenueMinor;
        } else expected = current - previous;
      }
    }
    return revenue === expected ? { revenue } : "fee_lineage_mismatch";
  } catch {
    try { units(row.payment_fee_revenue_minor); units(row.debit_total); units(row.credit_total); }
    catch { return "unsafe_journal_units"; }
    return "fee_lineage_mismatch";
  }
}

export async function readDashboardFeeJournalSliceV1(client: Pick<PoolClient, "query">, context: DashboardSnapshotReadContext,
  creatorInput?: CreatorSelectionV1): Promise<DashboardFeeJournalSliceV1> {
  const n = normalizeDashboardPaymentReadContext(context), creators = CreatorSelectionV1Schema.parse(creatorInput ?? { mode: "all", creatorOperatorIds: [] });
  const result = await client.query<Row>(FEE_JOURNAL_SQL, [n.merchantId, n.storeIds, n.startInclusive, n.endExclusive, n.reportAsOf, creators.mode, creators.creatorOperatorIds]);
  const negatives = new Map<string, DashboardFeeNegativeEventEvidenceV1>();
  if (result.rows.some(row => row.reference_type === "refund")) {
    for (const event of await readDashboardFeeNegativeEventEvidenceV1(client, context, creators)) negatives.set(event.paymentEventId, event);
  }
  const buckets = new Map<string, DashboardFeeJournalCurrencyV1>(SUPPORTED_CURRENCY_REGISTRY_V1.map(c => [c.currencyCode, {
    currencyCode: c.currencyCode, minorUnitExponent: c.minorUnitExponent, revenueExcludingVatMinor: 0, verifiedSubsetRevenueExcludingVatMinor: 0,
    coverage: { status: "available", totalJournalCount: 0, coveredJournalCount: 0, excludedJournalCount: 0 }, warnings: [],
  }])), seen = new Set<string>();
  for (const row of result.rows) {
    const window = context.storeTimeWindows.find(w => w.storeId === row.store_id);
    if (typeof row.id !== "string" || !row.id || seen.has(row.id) || row.merchant_id !== n.merchantId || !window) return invalid();
    seen.add(row.id);
    if (row.source_at !== null && row.source_at !== undefined) {
      const at = row.source_at instanceof Date ? row.source_at.getTime() : typeof row.source_at === "string" ? Date.parse(row.source_at) : NaN;
      if (!Number.isFinite(at) || at < Date.parse(window.startInclusive) || at >= Math.min(Date.parse(window.endExclusive), Date.parse(n.reportAsOf))) return invalid();
    }
    const code = typeof row.currency_code === "string" ? row.currency_code : "VND", exponent = row.minor_unit_exponent == null ? 0 : count(row.minor_unit_exponent);
    let bucket = buckets.get(code);
    if (!bucket) { bucket = { currencyCode: code, minorUnitExponent: exponent, revenueExcludingVatMinor: null, verifiedSubsetRevenueExcludingVatMinor: 0,
      coverage: { status: "available", totalJournalCount: 0, coveredJournalCount: 0, excludedJournalCount: 0 }, warnings: [] }; buckets.set(code, bucket); }
    if (bucket.minorUnitExponent !== exponent) return invalid();
    const proof = qualify(row, negatives);
    bucket.coverage.totalJournalCount = count(bucket.coverage.totalJournalCount + 1);
    if (typeof proof === "string") {
      bucket.coverage.excludedJournalCount = count(bucket.coverage.excludedJournalCount + 1); bucket.warnings = [...new Set([...bucket.warnings, proof])].sort();
    } else {
      bucket.coverage.coveredJournalCount = count(bucket.coverage.coveredJournalCount + 1);
      bucket.verifiedSubsetRevenueExcludingVatMinor = units(bucket.verifiedSubsetRevenueExcludingVatMinor + proof.revenue);
    }
    bucket.coverage.status = bucket.coverage.excludedJournalCount === 0 ? "available" : bucket.coverage.coveredJournalCount === 0 ? "unavailable" : "partial";
    bucket.revenueExcludingVatMinor = bucket.coverage.status === "available" ? bucket.verifiedSubsetRevenueExcludingVatMinor : null;
  }
  return DashboardFeeJournalSliceV1Schema.parse({ schemaVersion: 1, aggregateReadSource: "accounting.journal_entries", metricTimeBasis: "accounting_source_occurred_at",
    currencies: [...buckets.values()].sort((a, b) => a.currencyCode.localeCompare(b.currencyCode)) });
}
