import {
  DashboardAccountingSliceV1Schema,
  signedPercentageOneDecimalHalfUp,
  SUPPORTED_CURRENCY_REGISTRY_V1,
  type DashboardAccountingCurrencyV1,
  type DashboardAccountingProfitCoverageV1,
  type DashboardAccountingIssueV1,
  type DashboardAccountingSliceV1,
  CreatorSelectionV1Schema,
  type CreatorSelectionV1,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import type { DashboardSnapshotReadContext } from "./dashboard-report-foundation";

import { REFUND_REVERSAL_EVIDENCE_SELECT_V2 } from "./refund-commercial-allocation-service";

type AccountingRow = Record<string, unknown>;

export function dashboardAccountingSourceCtes(metric: "merchandise_profit" | "fee_revenue"): string {
  return `
  WITH store_windows AS (
    SELECT windows.store_id, windows.start_inclusive, windows.end_exclusive
    FROM unnest(
      $2::text[],
      $3::timestamptz[],
      $4::timestamptz[]
    ) AS windows(store_id, start_inclusive, end_exclusive)
  ), target_journals AS (
    SELECT
      je.id,
      je.reference_type,
      je.reference_id,
      je.merchant_id,
      je.store_id,
      ${metric === "fee_revenue" ? "COALESCE(SUM(CASE WHEN a.code = '5113' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0)::numeric AS payment_fee_revenue_minor," : ""}
      SUM(jl.debit_amount)::numeric AS debit_total,
      SUM(jl.credit_amount)::numeric AS credit_total,
      COUNT(*) FILTER (
        WHERE jl.debit_amount <> TRUNC(jl.debit_amount)
           OR jl.credit_amount <> TRUNC(jl.credit_amount)
      )::bigint AS fractional_line_count,
      COALESCE(SUM(
        CASE WHEN a.code = '5111'
          THEN jl.credit_amount - jl.debit_amount
          ELSE 0
        END
      ), 0)::numeric AS merchandise_revenue_minor,
      COALESCE(SUM(
        CASE WHEN a.code = '6321'
          THEN jl.debit_amount - jl.credit_amount
          ELSE 0
        END
      ), 0)::numeric AS cogs_recognized_minor
    FROM accounting.journal_entries je
    JOIN accounting.journal_lines jl
      ON jl.journal_entry_id = je.id
    JOIN accounting.accounts a
      ON a.id = jl.account_id
    WHERE je.merchant_id = $1
      AND je.store_id = ANY($2::text[])
      AND je.status = 'posted'
      AND je.created_at <= $5::timestamptz
      AND (je.posted_at IS NULL OR je.posted_at <= $5::timestamptz)
    GROUP BY je.id
    HAVING COUNT(*) FILTER (WHERE ${metric === "fee_revenue" ? "a.code = '5113'" : "a.code IN ('5111', '6321')"}) > 0
  ), source_order_candidates AS (
    SELECT
      journal.*,
      CASE
        WHEN journal.reference_type = 'order' THEN journal.reference_id
        WHEN journal.reference_type = 'order_correction' THEN correction.order_id
        WHEN journal.reference_type = 'order_cancellation' THEN journal.reference_id
        WHEN journal.reference_type = 'refund' THEN refund_entry.order_id
        ELSE NULL
      END AS order_id,
      refund_entry.metadata AS refund_entry_metadata
    FROM target_journals journal
    LEFT JOIN app.order_corrections correction
      ON journal.reference_type = 'order_correction'
     AND correction.id::text = journal.reference_id
    LEFT JOIN app.payment_entries refund_entry
      ON journal.reference_type = 'refund'
     AND refund_entry.id::text = journal.reference_id
     AND refund_entry.merchant_id = journal.merchant_id
     AND refund_entry.store_id = journal.store_id
  ), source_orders AS (
    SELECT source.*, source_order.id IS NOT NULL AS source_order_found,
      creator.actor_id AS original_creator_id,
      COALESCE(creator.actor_type IN ('staff', 'manager', 'owner', 'accountant')
        AND creator.actor_id = ANY($7::text[]), false) AS selected_creator
    FROM source_order_candidates source
    LEFT JOIN public."order" source_order ON source_order.id = source.order_id
      AND source_order.merchant_id = source.merchant_id AND source_order.store_id = source.store_id
      AND source_order.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT MAX(creator_event.actor_id) AS actor_id, MAX(creator_event.actor_type) AS actor_type
      FROM audit.events creator_event
      WHERE creator_event.subject_id = source_order.id AND creator_event.subject_type = 'order'
        AND creator_event.action IN ('order.created', 'order.remote_created', 'order.partner_created')
      HAVING COUNT(*) = 1
        AND MAX(creator_event.actor_type) IN ('staff', 'manager', 'owner', 'accountant', 'partner')
        AND MAX(creator_event.merchant_id) = source.merchant_id
        AND MAX(creator_event.store_id) = source.store_id
        AND NULLIF(BTRIM(MAX(creator_event.actor_id)), '') IS NOT NULL
    ) creator ON true
  ), mapped_sources AS (
    SELECT
      source.*,
      ${metric === "fee_revenue" ? `refund_event.id::text AS refund_event_id, refund_event.amount_minor AS refund_event_amount_minor,
      to_jsonb(fee_components) AS fee_components, to_jsonb(previous_fee_components) AS previous_fee_components,
      (SELECT COALESCE(jsonb_agg(to_jsonb(prior_refund)), '[]'::jsonb) FROM (
        ${REFUND_REVERSAL_EVIDENCE_SELECT_V2}
        WHERE source.reference_type='order_cancellation' AND events.merchant_id=source.merchant_id AND events.store_id=source.store_id AND events.order_id=source.order_id
          AND events.kind IN ('refund','reversal','chargeback') AND events.status='posted' AND events.recorded_at <= $5::timestamptz
          AND events.source_occurred_at <= revision.effective_at
      ) prior_refund) AS prior_refund_events,` : ""}
      revision.id AS revision_id,
      CASE
        WHEN source.reference_type = 'refund' THEN refund_event.currency_code
        ELSE revision.currency_code
      END AS currency_code,
      CASE
        WHEN source.reference_type = 'refund' THEN refund_event.minor_unit_exponent
        ELSE revision.minor_unit_exponent
      END AS minor_unit_exponent,
      CASE
        WHEN source.reference_type = 'refund' THEN refund_event.source_occurred_at
        ELSE revision.effective_at
      END AS source_at,
      revision.data_quality,
      lineage.revision_count,
      revision.revision AS revision_number,
      lineage.invalid_revision_count,
      lineage.complete_lineage,
      CASE source.reference_type
        WHEN 'order' THEN lineage.current_cogs
        WHEN 'order_correction' THEN lineage.current_cogs - lineage.previous_cogs
        WHEN 'order_cancellation' THEN -lineage.previous_cogs
        WHEN 'refund' THEN 0
      END AS expected_cogs_minor,
      COALESCE(lineage.unsafe_cost_count, 0) AS unsafe_cost_count,
      COALESCE(cost.total_lines, 0)::bigint AS total_cost_lines,
      COALESCE(cost.known_lines, 0)::bigint AS known_cost_lines
    FROM source_orders source
    LEFT JOIN LATERAL (
      SELECT event.*
      FROM app.payment_events event
      WHERE source.reference_type = 'refund'
        AND event.merchant_id = source.merchant_id
        AND event.store_id = source.store_id
        AND event.order_id = source.order_id
        AND event.kind = 'refund'
        AND event.status = 'posted'
        AND event.recorded_at <= $5::timestamptz
        AND event.source_occurred_at <= $5::timestamptz
        AND (
          event.id::text = NULLIF(
            source.refund_entry_metadata->>'canonicalPaymentEventId',
            ''
          )
          OR (
            event.source_type = 'historical_payment_entry'
            AND event.source_id = source.reference_id
          )
        )
      ORDER BY
        CASE
          WHEN event.id::text = NULLIF(
            source.refund_entry_metadata->>'canonicalPaymentEventId',
            ''
          ) THEN 0
          ELSE 1
        END,
        event.source_occurred_at DESC,
        event.id DESC
      LIMIT 1
    ) refund_event ON true
    LEFT JOIN LATERAL (
      SELECT candidate.*
      FROM app.order_commercial_revisions candidate
      WHERE candidate.merchant_id = source.merchant_id
        AND candidate.store_id = source.store_id
        AND candidate.order_id = source.order_id
        AND candidate.recorded_at <= $5::timestamptz
        AND candidate.effective_at <= $5::timestamptz
        AND (
          (
            source.reference_type = 'order'
            AND candidate.source_type = 'original_order'
            AND candidate.source_id = source.reference_id
          )
          OR (
            source.reference_type = 'order_correction'
            AND candidate.source_type = 'order_correction'
            AND candidate.source_id = source.reference_id
          )
          OR (
            source.reference_type = 'order_cancellation'
            AND candidate.source_type = 'order_cancellation'
          )
          OR (
            source.reference_type = 'refund'
            AND candidate.id = refund_event.commercial_revision_id
          )
        )
      ORDER BY candidate.revision DESC, candidate.effective_at DESC, candidate.id DESC
      LIMIT 1
    ) revision ON true
    ${metric === "fee_revenue" ? `LEFT JOIN app.order_commercial_revision_components fee_components
      ON fee_components.revision_id=revision.id AND fee_components.merchant_id=source.merchant_id AND fee_components.store_id=source.store_id
        AND fee_components.order_id=source.order_id AND fee_components.currency_code=revision.currency_code
        AND fee_components.minor_unit_exponent=revision.minor_unit_exponent AND fee_components.recorded_at <= $5::timestamptz
    LEFT JOIN app.order_commercial_revisions previous_fee_revision
      ON previous_fee_revision.merchant_id=source.merchant_id AND previous_fee_revision.store_id=source.store_id AND previous_fee_revision.order_id=source.order_id
        AND previous_fee_revision.revision=revision.revision-1 AND previous_fee_revision.currency_code=revision.currency_code
        AND previous_fee_revision.minor_unit_exponent=revision.minor_unit_exponent AND previous_fee_revision.recorded_at <= $5::timestamptz
        AND previous_fee_revision.effective_at <= $5::timestamptz
    LEFT JOIN app.order_commercial_revision_components previous_fee_components
      ON previous_fee_components.revision_id=previous_fee_revision.id AND previous_fee_components.merchant_id=source.merchant_id
        AND previous_fee_components.store_id=source.store_id AND previous_fee_components.order_id=source.order_id
        AND previous_fee_components.currency_code=revision.currency_code AND previous_fee_components.minor_unit_exponent=revision.minor_unit_exponent
        AND previous_fee_components.recorded_at <= $5::timestamptz` : ""}
    LEFT JOIN LATERAL (
      SELECT
        COUNT(lines.id)::bigint AS total_lines,
        COUNT(lines.id) FILTER (
          WHERE lines.cost_minor IS NOT NULL
            AND lines.cost_evidence_id IS NOT NULL
        )::bigint AS known_lines
      FROM app.order_commercial_revision_lines lines
      WHERE lines.revision_id = revision.id
    ) cost ON true
    LEFT JOIN LATERAL (
      -- Signed corrections and cancellations depend on all prior snapshots.
      -- Keep provenance outside the date filter; only the represented journal
      -- uses source_at for the period. This prevents a known latest snapshot
      -- from legitimizing a reversal of an unknown original cost.
      SELECT COUNT(*)::bigint AS revision_count,
        COUNT(*) FILTER (WHERE prior.currency_code <> revision.currency_code
          OR prior.minor_unit_exponent <> revision.minor_unit_exponent
          OR prior.data_quality = 'unavailable'
          OR (prior.data_quality <> 'complete' AND proof.known_lines = proof.total_lines)
          OR (prior.revision = 0 AND prior.source_type <> 'original_order')
        )::bigint AS invalid_revision_count,
        MAX(proof.known_cogs) FILTER (WHERE prior.revision = revision.revision) AS current_cogs,
        MAX(proof.known_cogs) FILTER (WHERE prior.revision = revision.revision - 1) AS previous_cogs,
        BOOL_AND(prior.data_quality = 'complete' AND proof.total_lines > 0
          AND proof.known_lines = proof.total_lines) AS complete_lineage,
        COALESCE(SUM(proof.unsafe_cost_count), 0) AS unsafe_cost_count
      FROM app.order_commercial_revisions prior
      CROSS JOIN LATERAL (
        SELECT COUNT(*) AS total_lines,
          COUNT(*) FILTER (WHERE line.cost_minor IS NOT NULL AND line.cost_evidence_id IS NOT NULL) AS known_lines,
          COALESCE(SUM(line.quantity::numeric * line.cost_minor), 0) AS known_cogs,
          COUNT(*) FILTER (WHERE ABS(line.quantity::numeric * line.cost_minor) > 9007199254740991) AS unsafe_cost_count
        FROM app.order_commercial_revision_lines line WHERE line.revision_id = prior.id
      ) proof
      WHERE prior.merchant_id = source.merchant_id
        AND prior.store_id = source.store_id AND prior.order_id = source.order_id
        AND prior.revision <= revision.revision
        AND prior.recorded_at <= $5::timestamptz
        AND prior.effective_at <= $5::timestamptz
    ) lineage ON true
  )`;
}

const DASHBOARD_ACCOUNTING_SQL = `${dashboardAccountingSourceCtes("merchandise_profit")}, global_source_quality AS (
    SELECT
      COUNT(*) FILTER (
        WHERE reference_type NOT IN (
          'order',
          'order_correction',
          'order_cancellation',
          'refund'
        )
      )::bigint AS unsupported_reference_count,
      COUNT(*) FILTER (
        WHERE reference_type IN (
          'order',
          'order_correction',
          'order_cancellation',
          'refund'
        )
          AND (
            NOT source_order_found
            OR ($6::text <> 'all' AND original_creator_id IS NULL)
            OR order_id IS NULL
            OR revision_id IS NULL
            OR source_at IS NULL
            OR revision_count <> revision_number + 1
            OR invalid_revision_count > 0
            OR (complete_lineage AND (expected_cogs_minor IS NULL OR expected_cogs_minor <> cogs_recognized_minor))
          )
      )::bigint AS unmapped_source_count
    FROM mapped_sources
    WHERE $6::text = 'all' OR selected_creator OR original_creator_id IS NULL
  ), selected_sources AS (
    SELECT mapped.*
    FROM mapped_sources mapped
    JOIN store_windows windows
      ON windows.store_id = mapped.store_id
    WHERE mapped.revision_id IS NOT NULL
      AND ($6::text = 'all' OR mapped.selected_creator)
      AND mapped.source_at >= windows.start_inclusive
      AND mapped.source_at < LEAST(windows.end_exclusive, $5::timestamptz)
  ), per_currency AS (
    SELECT
      UPPER(currency_code) AS currency_code,
      minor_unit_exponent,
      COUNT(*)::bigint AS posted_journal_count,
      COUNT(*) FILTER (
        WHERE debit_total = credit_total
          AND debit_total > 0
      )::bigint AS balanced_journal_count,
      COUNT(*) FILTER (
        WHERE revision_id IS NOT NULL
          AND source_at IS NOT NULL
      )::bigint AS mapped_source_count,
      COUNT(*) FILTER (
        WHERE complete_lineage
      )::bigint AS complete_cost_source_count,
      COUNT(*) FILTER (WHERE ABS(debit_total) > 9007199254740991
        OR ABS(credit_total) > 9007199254740991 OR unsafe_cost_count > 0)::bigint AS unsafe_journal_count,
      COALESCE(SUM(merchandise_revenue_minor) FILTER (WHERE complete_lineage), 0)::numeric AS verified_revenue_minor,
      COALESCE(SUM(cogs_recognized_minor) FILTER (WHERE complete_lineage), 0)::numeric AS verified_cogs_minor,
      COALESCE(SUM(fractional_line_count), 0)::bigint AS fractional_line_count,
      COALESCE(SUM(merchandise_revenue_minor), 0)::numeric
        AS merchandise_revenue_minor,
      COALESCE(SUM(cogs_recognized_minor), 0)::numeric
        AS cogs_recognized_minor
    FROM selected_sources
    GROUP BY UPPER(currency_code), minor_unit_exponent
  ), supported_currency(currency_code, minor_unit_exponent) AS (
    VALUES ('VND'::text, 0::smallint)
  ), currencies AS (
    SELECT currency_code, minor_unit_exponent FROM supported_currency
    UNION
    SELECT currency_code, minor_unit_exponent FROM per_currency
  )
  SELECT
    currencies.currency_code,
    currencies.minor_unit_exponent,
    COALESCE(per_currency.posted_journal_count, 0)::text AS posted_journal_count,
    COALESCE(per_currency.balanced_journal_count, 0)::text AS balanced_journal_count,
    COALESCE(per_currency.mapped_source_count, 0)::text AS mapped_source_count,
    COALESCE(per_currency.complete_cost_source_count, 0)::text
      AS complete_cost_source_count,
    COALESCE(per_currency.unsafe_journal_count, 0)::text AS unsafe_journal_count,
    COALESCE(per_currency.verified_revenue_minor, 0)::text AS verified_revenue_minor,
    COALESCE(per_currency.verified_cogs_minor, 0)::text AS verified_cogs_minor,
    COALESCE(per_currency.fractional_line_count, 0)::text AS fractional_line_count,
    COALESCE(quality.unsupported_reference_count, 0)::text
      AS unsupported_reference_count,
    COALESCE(quality.unmapped_source_count, 0)::text AS unmapped_source_count,
    COALESCE(per_currency.merchandise_revenue_minor, 0)::text
      AS merchandise_revenue_minor,
    COALESCE(per_currency.cogs_recognized_minor, 0)::text
      AS cogs_recognized_minor
  FROM currencies
  LEFT JOIN per_currency
    USING (currency_code, minor_unit_exponent)
  CROSS JOIN global_source_quality quality
  ORDER BY currencies.currency_code
`;

export class DashboardAccountingDataQualityErrorV1 extends PlatformError {
  constructor(fields: string[]) {
    super(
      "dashboard_accounting_data_quality",
      "Accounting dashboard dependency is invalid",
      422,
      { fields: [...new Set(fields)].sort() },
    );
    this.name = "DashboardAccountingDataQualityErrorV1";
  }
}

function invalid(field: string): never {
  throw new DashboardAccountingDataQualityErrorV1([field]);
}

function count(value: unknown, field: string): number {
  const text = typeof value === "bigint"
    ? value.toString()
    : typeof value === "number" || typeof value === "string"
      ? String(value)
      : "";
  if (!/^(0|[1-9]\d*)$/.test(text)) return invalid(field);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return invalid(field);
  return parsed;
}

function signedMinor(value: unknown, field: string): number {
  const text = typeof value === "bigint"
    ? value.toString()
    : typeof value === "number" || typeof value === "string"
      ? String(value)
      : "";
  if (!/^-?(0|[1-9]\d*)(?:\.0+)?$/.test(text)) return invalid(field);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return invalid(field);
  return parsed;
}

function normalizeCurrency(row: AccountingRow): DashboardAccountingCurrencyV1 {
  const currencyCode = String(row.currency_code || "").toUpperCase();
  const minorUnitExponent = count(row.minor_unit_exponent, "minor_unit_exponent");
  if (!/^[A-Z]{3}$/.test(currencyCode) || minorUnitExponent > 3) {
    return invalid("currency");
  }
  const postedJournalCount = count(row.posted_journal_count, "posted_journal_count");
  const balancedJournalCount = count(
    row.balanced_journal_count,
    "balanced_journal_count",
  );
  const mappedSourceCount = count(row.mapped_source_count, "mapped_source_count");
  const completeCostSourceCount = count(
    row.complete_cost_source_count,
    "complete_cost_source_count",
  );
  const fractionalLineCount = count(row.fractional_line_count, "fractional_line_count");
  const unsupportedReferenceCount = count(
    row.unsupported_reference_count,
    "unsupported_reference_count",
  );
  const unmappedSourceCount = count(row.unmapped_source_count, "unmapped_source_count");
  const issues: DashboardAccountingIssueV1[] = [];
  if (
    !SUPPORTED_CURRENCY_REGISTRY_V1.some((currency) => (
      currency.currencyCode === currencyCode
      && currency.minorUnitExponent === minorUnitExponent
    ))
  ) {
    issues.push("unsupported_currency");
  }
  if (unsupportedReferenceCount > 0) issues.push("unsupported_reference_type");
  if (
    unmappedSourceCount > 0
    || mappedSourceCount !== postedJournalCount
  ) {
    issues.push("missing_source_mapping");
  }
  if (balancedJournalCount !== postedJournalCount) issues.push("unbalanced_journal");
  if (fractionalLineCount > 0) issues.push("fractional_minor_units");
  if (completeCostSourceCount > postedJournalCount || balancedJournalCount > postedJournalCount || mappedSourceCount > postedJournalCount) return invalid("journal_counts");
  if (count(row.unsafe_journal_count ?? "0", "unsafe_journal_count") > 0) return invalid("unsafe_journal_units");
  // Validate total amounts even when only a subset can be displayed.
  if (fractionalLineCount === 0) {
    signedMinor(row.merchandise_revenue_minor, "merchandise_revenue_minor");
    signedMinor(row.cogs_recognized_minor, "cogs_recognized_minor");
  }
  if (completeCostSourceCount !== postedJournalCount) {
    issues.push("incomplete_cost_provenance");
  }
  if (issues.length > 0) {
    return {
      currencyCode,
      minorUnitExponent,
      status: "unavailable",
      dataQualityStatus: "unavailable",
      issues: [...new Set(issues)].sort(),
    };
  }
  const revenueExcludingVatMinor = signedMinor(
    row.merchandise_revenue_minor,
    "merchandise_revenue_minor",
  );
  const cogsRecognizedMinor = signedMinor(
    row.cogs_recognized_minor,
    "cogs_recognized_minor",
  );
  const grossProfitMinor = revenueExcludingVatMinor - cogsRecognizedMinor;
  if (!Number.isSafeInteger(grossProfitMinor)) return invalid("gross_profit_minor");
  return {
    currencyCode,
    minorUnitExponent,
    status: "available",
    dataQualityStatus: "complete",
    postedJournalCount,
    revenueExcludingVatMinor,
    cogsRecognizedMinor,
    grossProfitMinor,
    grossMarginPercent: signedPercentageOneDecimalHalfUp(
      grossProfitMinor,
      revenueExcludingVatMinor,
    ),
  };
}

function profitCoverage(row: AccountingRow, exact: DashboardAccountingCurrencyV1): DashboardAccountingProfitCoverageV1 {
  const totalJournalCount = count(row.posted_journal_count, "posted_journal_count");
  const coveredJournalCount = count(row.complete_cost_source_count, "complete_cost_source_count");
  const counts = { totalJournalCount, coveredJournalCount, excludedJournalCount: totalJournalCount - coveredJournalCount };
  if (exact.status === "unavailable" && (coveredJournalCount === 0 || exact.issues.some(issue => issue !== "incomplete_cost_provenance"))) {
    return { status: "unavailable", ...counts, issues: exact.issues,
      exactGrossProfitMinor: null, verifiedSubsetRevenueExcludingVatMinor: null,
      verifiedSubsetCogsRecognizedMinor: null, verifiedSubsetGrossProfitMinor: null };
  }
  const revenue = exact.status === "available" ? exact.revenueExcludingVatMinor : signedMinor(row.verified_revenue_minor, "verified_revenue_minor");
  const cogs = exact.status === "available" ? exact.cogsRecognizedMinor : signedMinor(row.verified_cogs_minor, "verified_cogs_minor");
  const gross = revenue - cogs;
  if (!Number.isSafeInteger(gross)) return invalid("verified_profit_minor");
  const verified = { ...counts, verifiedSubsetRevenueExcludingVatMinor: revenue,
    verifiedSubsetCogsRecognizedMinor: cogs, verifiedSubsetGrossProfitMinor: gross };
  return exact.status === "available"
    ? { ...verified, status: "exact", exactGrossProfitMinor: gross, issues: [] }
    : { ...verified, status: "partial", exactGrossProfitMinor: null, issues: ["incomplete_cost_provenance"] };
}

export async function readDashboardAccountingSliceV1(
  client: Pick<PoolClient, "query">,
  context: DashboardSnapshotReadContext,
  creatorSelectionInput?: CreatorSelectionV1,
): Promise<DashboardAccountingSliceV1> {
  const creatorSelection = CreatorSelectionV1Schema.parse(
    creatorSelectionInput || { mode: "all", creatorOperatorIds: [] },
  );
  const result = await client.query<AccountingRow>(
    DASHBOARD_ACCOUNTING_SQL,
    [
      context.normalizedScope.merchantId,
      context.storeTimeWindows.map((window) => window.storeId),
      context.storeTimeWindows.map((window) => window.startInclusive),
      context.storeTimeWindows.map((window) => window.endExclusive),
      context.reportAsOf,
      creatorSelection.mode,
      creatorSelection.creatorOperatorIds,
    ],
  );
  const currencies = result.rows.map(normalizeCurrency);
  const parsed = DashboardAccountingSliceV1Schema.safeParse({
    schemaVersion: 1,
    aggregateReadSource: "accounting.journal_entries",
    currencies,
    profitCoverage: currencies.map((currency, i) => ({
      currencyCode: currency.currencyCode, minorUnitExponent: currency.minorUnitExponent,
      coverage: profitCoverage(result.rows[i]!, currency),
    })),
  });
  if (!parsed.success) {
    throw new DashboardAccountingDataQualityErrorV1(
      parsed.error.issues.map((issue) => issue.path.join(".") || issue.message),
    );
  }
  return parsed.data;
}
