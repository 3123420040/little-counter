import { z } from "zod";
import { CreatorSelectionV1Schema, DashboardFeeNegativeSliceV1Schema, SUPPORTED_CURRENCY_REGISTRY_V1,
  type CreatorSelectionV1, type DashboardFeeNegativeCurrencyV1, type DashboardFeeNegativeSliceV1 } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import type { DashboardSnapshotReadContext } from "./dashboard-report-foundation";
import { assertNoHistoricalPaymentQuarantine, DASHBOARD_RECORDED_COLLECTION_DEFAULT_CONFIG_V1, normalizeDashboardPaymentReadContext } from "./dashboard-recorded-collection-slice";
import { readRefundCommercialBasisV2 } from "./refund-commercial-allocation-service";
import { readFrozenRefundAllocationV2, refundComponentKeysV2 } from "./refund-component-allocation";

const NEGATIVE_FEE_SQL = `
  /* dashboard_fee_negative_events */
  WITH store_windows AS (
    SELECT * FROM unnest($2::text[], $3::timestamptz[], $4::timestamptz[]) AS windows(store_id,start_inclusive,end_exclusive)
  )
  SELECT events.id::text, events.merchant_id, events.store_id, events.order_id, events.kind, events.currency_code,
    events.minor_unit_exponent, events.amount_minor::text, events.metadata, events.source_occurred_at, events.recorded_at,
    (SELECT count(*)::text FROM app.payment_event_evidence evidence
      WHERE evidence.payment_event_id=events.id AND evidence.merchant_id=events.merchant_id AND evidence.store_id=events.store_id
        AND evidence.evidence_type=events.evidence_type AND evidence.evidence_fingerprint=events.evidence_fingerprint
        AND evidence.verification_status='verified' AND evidence.source_occurred_at=events.source_occurred_at AND evidence.captured_at <= $5::timestamptz) AS exact_evidence_count,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('obligation_id', obligation.id::text, 'amount_minor', allocation.amount_minor::text,
      'commercial_revision_id', obligation.commercial_revision_id::text, 'component_record', to_jsonb(components)))
      FROM app.payment_event_allocations allocation
      JOIN app.commercial_obligations obligation ON obligation.id=allocation.obligation_id AND obligation.merchant_id=events.merchant_id
        AND obligation.store_id=events.store_id AND obligation.order_id=events.order_id AND obligation.currency_code=events.currency_code AND obligation.minor_unit_exponent=events.minor_unit_exponent
      JOIN app.order_commercial_revision_components components ON components.revision_id=obligation.commercial_revision_id
        AND components.merchant_id=events.merchant_id AND components.store_id=events.store_id AND components.order_id=events.order_id
        AND components.currency_code=events.currency_code AND components.minor_unit_exponent=events.minor_unit_exponent
      WHERE allocation.payment_event_id=events.id AND allocation.merchant_id=events.merchant_id AND allocation.store_id=events.store_id
        AND allocation.allocation_kind=events.kind AND allocation.currency_code=events.currency_code AND allocation.minor_unit_exponent=events.minor_unit_exponent
        AND allocation.recorded_at <= $5::timestamptz AND obligation.recorded_at <= $5::timestamptz AND components.recorded_at <= $5::timestamptz), '[]') AS obligation_allocations,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('payable_id', payable.id::text, 'payable_kind', payable.payable_kind,
      'commercial_revision_id', payable.commercial_revision_id::text, 'source_type', payable.source_type, 'source_id', payable.source_id,
      'amount_minor', allocation.amount_minor::text, 'component_record', to_jsonb(components)))
      FROM app.customer_refund_payout_allocations allocation
      JOIN app.customer_refund_payable_events clear_event ON clear_event.id=allocation.payable_event_id
        AND clear_event.payable_id=allocation.payable_id AND clear_event.payment_event_id=events.id
        AND clear_event.merchant_id=events.merchant_id AND clear_event.store_id=events.store_id AND clear_event.order_id=events.order_id
        AND clear_event.currency_code=events.currency_code AND clear_event.minor_unit_exponent=events.minor_unit_exponent
        AND clear_event.event_kind='clear' AND clear_event.clearance_kind='payout' AND clear_event.amount_minor=allocation.amount_minor
        AND clear_event.source_occurred_at=events.source_occurred_at AND clear_event.recorded_at <= $5::timestamptz
      JOIN app.customer_refund_payables payable ON payable.id=allocation.payable_id AND payable.merchant_id=events.merchant_id AND payable.store_id=events.store_id
        AND payable.order_id=events.order_id AND payable.currency_code=events.currency_code AND payable.minor_unit_exponent=events.minor_unit_exponent
      JOIN app.order_commercial_revision_components components ON components.revision_id=payable.commercial_revision_id
        AND components.merchant_id=events.merchant_id AND components.store_id=events.store_id AND components.order_id=events.order_id
        AND components.currency_code=events.currency_code AND components.minor_unit_exponent=events.minor_unit_exponent
      WHERE allocation.payment_event_id=events.id AND allocation.merchant_id=events.merchant_id AND allocation.store_id=events.store_id
        AND allocation.order_id=events.order_id AND allocation.currency_code=events.currency_code AND allocation.minor_unit_exponent=events.minor_unit_exponent
        AND allocation.recorded_at <= $5::timestamptz AND payable.recorded_at <= $5::timestamptz AND components.recorded_at <= $5::timestamptz), '[]') AS payable_allocations
  FROM app.payment_events events JOIN store_windows windows ON windows.store_id=events.store_id
  WHERE events.merchant_id=$1 AND events.kind IN ('refund','reversal','chargeback') AND events.status='posted'
    AND events.source_occurred_at >= windows.start_inclusive AND events.source_occurred_at < LEAST(windows.end_exclusive,$5::timestamptz)
    AND events.recorded_at <= $5::timestamptz
    AND ($6::text='all' OR EXISTS (
      SELECT 1 FROM public."order" source_order JOIN audit.events creator ON creator.subject_type='order' AND creator.subject_id=source_order.id
      WHERE source_order.id=events.order_id AND source_order.merchant_id=events.merchant_id AND source_order.store_id=events.store_id
        AND source_order.deleted_at IS NULL AND creator.action IN ('order.created','order.remote_created','order.partner_created')
      GROUP BY source_order.id HAVING COUNT(*)=1 AND MAX(creator.actor_type) IN ('staff','manager','owner','accountant')
        AND MAX(creator.merchant_id)=events.merchant_id AND MAX(creator.store_id)=events.store_id AND MAX(creator.actor_id)=ANY($7::text[])))
  ORDER BY events.currency_code,events.source_occurred_at,events.recorded_at,events.id
`;
type Warning = DashboardFeeNegativeCurrencyV1["warnings"][number];
type EventRow = Record<string, unknown>;
const basisRow = z.object({ commercial_revision_id: z.string().uuid(), component_record: z.record(z.string(), z.unknown()), amount_minor: z.unknown() });
const payableRow = basisRow.extend({ payable_id: z.string().uuid(), payable_kind: z.enum(["manual_refund", "negative_correction", "shipping_decrease", "order_cancellation"]),
  source_type: z.string().min(1), source_id: z.string().min(1) }).strict();
const obligationRow = basisRow.extend({ obligation_id: z.string().uuid() }).strict();
function invalid(): never { throw new PlatformError("dashboard_fee_negative_data_quality", "Negative-event source identity or amount is invalid", 422); }
function minor(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "bigint" && typeof value !== "string") || !/^(0|[1-9]\d*)$/.test(String(value))) return invalid();
  const n = Number(value); if (!Number.isSafeInteger(n)) return invalid(); return n;
}
function add(left: number, right: number): number { return minor(left + right); }
function instant(value: unknown): number {
  const parsed = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) return invalid(); return parsed;
}
function readBasis(row: z.infer<typeof basisRow>, event: EventRow) {
  const c = row.component_record;
  if (c.merchant_id !== event.merchant_id || c.store_id !== event.store_id || c.order_id !== event.order_id || c.revision_id !== row.commercial_revision_id
    || c.currency_code !== event.currency_code || minor(c.minor_unit_exponent) !== minor(event.minor_unit_exponent)) return invalid();
  return readRefundCommercialBasisV2(row);
}
function attribution(event: EventRow): { fee: number; settlement: number } | Warning {
  try {
    const amount = minor(event.amount_minor);
    if (minor(event.exact_evidence_count) !== 1) return "evidence_unavailable";
    const obligations = z.array(obligationRow).parse(event.obligation_allocations), payables = z.array(payableRow).parse(event.payable_allocations);
    const obligationAmounts = new Map<string, number>();
    for (const row of obligations) { readBasis(row, event); obligationAmounts.set(row.obligation_id, add(obligationAmounts.get(row.obligation_id) ?? 0, minor(row.amount_minor))); }
    if (!obligations.length || [...obligationAmounts.values()].reduce(add, 0) !== amount) return "evidence_unavailable";
    const payableAmounts = new Map<string, number>();
    for (const row of payables) { readBasis(row, event); payableAmounts.set(row.payable_id, add(payableAmounts.get(row.payable_id) ?? 0, minor(row.amount_minor))); }
    const metadata = z.record(z.string(), z.unknown()).safeParse(event.metadata);
    if (!metadata.success) return "invalid_frozen_allocation";
    if (Object.hasOwn(metadata.data, "refundAllocationV2")) {
      let frozen;
      try { frozen = readFrozenRefundAllocationV2(metadata.data.refundAllocationV2); }
      catch { return "invalid_frozen_allocation"; }
      if (frozen.amountMinor !== amount || frozen.payableAllocations.length !== payableAmounts.size || frozen.obligationAllocations.length !== obligationAmounts.size
        || frozen.obligationAllocations.some(part => obligationAmounts.get(part.obligationId) !== part.amountMinor)) return "allocation_binding_mismatch";
      for (const part of frozen.payableAllocations) {
        const rows = payables.filter(row => row.payable_id === part.payableId);
        if (!rows.length || payableAmounts.get(part.payableId) !== part.amountMinor) return "allocation_binding_mismatch";
        for (const row of rows) {
          const basis = readBasis(row, event);
          if (basis.unclassifiedMinor !== 0 || part.payableKind !== row.payable_kind || part.commercialRevisionId !== basis.commercialRevisionId
            || part.componentVersion !== basis.componentVersion || part.basisFingerprint !== basis.basisFingerprint || part.sourceType !== row.source_type || part.sourceId !== row.source_id
            || (part.basisCapacities && refundComponentKeysV2.some(key => part.basisCapacities![key] !== basis.capacities[key]))) return "allocation_binding_mismatch";
        }
      }
      return { fee: frozen.reversalComponents.paymentFeeRevenueMinor, settlement: frozen.settlementOnlyMinor };
    }
    if (!payables.length) return obligations.every(row => { const basis = readBasis(row, event); return basis.unclassifiedMinor === 0 && basis.capacities.paymentFeeRevenueMinor === 0; })
      ? { fee: 0, settlement: 0 } : "ambiguous_legacy_basis";
    if ([...payableAmounts.values()].reduce(add, 0) !== amount) return "allocation_binding_mismatch";
    let settlement = 0;
    for (const row of payables) {
      if (row.payable_kind !== "manual_refund" && event.kind === "refund") settlement = add(settlement, minor(row.amount_minor));
      else {
        const basis = readBasis(row, event);
        if (basis.unclassifiedMinor !== 0 || basis.capacities.paymentFeeRevenueMinor !== 0) return "missing_frozen_allocation";
      }
    }
    return { fee: 0, settlement };
  } catch { return "allocation_binding_mismatch"; }
}

export interface DashboardFeeNegativeEventEvidenceV1 {
  paymentEventId: string; amountMinor: number; currencyCode: string; minorUnitExponent: number;
  proof: { fee: number; settlement: number } | Warning;
}
export async function readDashboardFeeNegativeEventEvidenceV1(client: Pick<PoolClient, "query">, context: DashboardSnapshotReadContext,
  creatorInput?: CreatorSelectionV1): Promise<DashboardFeeNegativeEventEvidenceV1[]> {
  const n = normalizeDashboardPaymentReadContext(context), creators = CreatorSelectionV1Schema.parse(creatorInput ?? { mode: "all", creatorOperatorIds: [] });
  await assertNoHistoricalPaymentQuarantine(client, n, creators);
  const result = await client.query<EventRow>(NEGATIVE_FEE_SQL, [n.merchantId, n.storeIds, n.startInclusive, n.endExclusive, n.reportAsOf, creators.mode, creators.creatorOperatorIds]);
  const seen = new Set<string>();
  return result.rows.map(event => {
    const window = context.storeTimeWindows.find(row => row.storeId === event.store_id), occurred = instant(event.source_occurred_at);
    const currency = SUPPORTED_CURRENCY_REGISTRY_V1.find(row => row.currencyCode === event.currency_code), amount = minor(event.amount_minor);
    if (typeof event.id !== "string" || !event.id || seen.has(event.id) || event.merchant_id !== n.merchantId || !window || !currency
      || minor(event.minor_unit_exponent) !== currency.minorUnitExponent || !["refund", "reversal", "chargeback"].includes(String(event.kind))
      || occurred < Date.parse(window.startInclusive) || occurred >= Math.min(Date.parse(window.endExclusive), Date.parse(n.reportAsOf)) || instant(event.recorded_at) > Date.parse(n.reportAsOf)) invalid();
    seen.add(event.id);
    return { paymentEventId: String(event.id), amountMinor: amount, currencyCode: currency.currencyCode, minorUnitExponent: currency.minorUnitExponent, proof: attribution(event) };
  });
}

export async function readDashboardFeeNegativeSliceV1(client: Pick<PoolClient, "query">, context: DashboardSnapshotReadContext,
  config: { enabled: boolean } = DASHBOARD_RECORDED_COLLECTION_DEFAULT_CONFIG_V1, creatorInput?: CreatorSelectionV1):
  Promise<{ enabled: false; status: "disabled" } | { enabled: true; data: DashboardFeeNegativeSliceV1 }> {
  if (config.enabled !== true) return { enabled: false, status: "disabled" };
  const buckets = new Map<string, DashboardFeeNegativeCurrencyV1>();
  for (const event of await readDashboardFeeNegativeEventEvidenceV1(client, context, creatorInput)) {
    const currency = event, amount = event.amountMinor;
    let bucket = buckets.get(currency.currencyCode);
    if (!bucket) { bucket = { currencyCode: currency.currencyCode, minorUnitExponent: currency.minorUnitExponent, feeRevenueReversedExVatMinor: null,
      verifiedSubsetFeeRevenueReversedExVatMinor: 0, verifiedSubsetSettlementOnlyMinor: 0, coverage: { status: "available", totalEventCount: 0, coveredEventCount: 0,
        excludedEventCount: 0, totalNegativeMinor: 0, coveredNegativeMinor: 0, excludedNegativeMinor: 0 }, warnings: [] }; buckets.set(currency.currencyCode, bucket); }
    const proof = event.proof;
    bucket.coverage.totalEventCount = add(bucket.coverage.totalEventCount, 1); bucket.coverage.totalNegativeMinor = add(bucket.coverage.totalNegativeMinor, amount);
    if (typeof proof === "string") {
      bucket.coverage.excludedEventCount = add(bucket.coverage.excludedEventCount, 1); bucket.coverage.excludedNegativeMinor = add(bucket.coverage.excludedNegativeMinor, amount);
      bucket.warnings = [...new Set([...bucket.warnings, proof])].sort();
    } else {
      bucket.coverage.coveredEventCount = add(bucket.coverage.coveredEventCount, 1); bucket.coverage.coveredNegativeMinor = add(bucket.coverage.coveredNegativeMinor, amount);
      bucket.verifiedSubsetFeeRevenueReversedExVatMinor = add(bucket.verifiedSubsetFeeRevenueReversedExVatMinor, proof.fee);
      bucket.verifiedSubsetSettlementOnlyMinor = add(bucket.verifiedSubsetSettlementOnlyMinor, proof.settlement);
    }
    bucket.coverage.status = bucket.coverage.excludedEventCount === 0 ? "available" : bucket.coverage.coveredEventCount === 0 ? "unavailable" : "partial";
    bucket.feeRevenueReversedExVatMinor = bucket.coverage.status === "available" ? bucket.verifiedSubsetFeeRevenueReversedExVatMinor : null;
  }
  return { enabled: true, data: DashboardFeeNegativeSliceV1Schema.parse({ schemaVersion: 1, aggregateReadSource: "app.payment_events",
    currencies: [...buckets.values()].sort((a, b) => a.currencyCode.localeCompare(b.currencyCode)) }) };
}
