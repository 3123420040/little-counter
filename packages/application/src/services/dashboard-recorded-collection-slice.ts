import {
  DASHBOARD_METRIC_TIME_BASIS_V2,
  DashboardReportContextV1Schema,
  RecordedGrossCollectionCurrencyV2Schema, RecordedGrossCollectionSliceV2Schema,
  type RecordedGrossCollectionComponentsV2, type RecordedGrossCollectionCurrencyV2, type RecordedGrossCollectionSliceV2,
  RecordedGrossCollectionCurrencyV1Schema,
  RecordedGrossCollectionSliceV1Schema,
  type RecordedGrossCollectionCurrencyV1,
  type RecordedGrossCollectionSliceV1,
  CreatorSelectionV1Schema,
  type CreatorSelectionV1,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import {
  generateDashboardLocalDateLabels,
  withDashboardReadSnapshot,
  type DashboardSnapshotReadContext,
  type DashboardSnapshotRequest,
  type DashboardSnapshotResult,
} from "./dashboard-report-foundation";

export const DASHBOARD_RECORDED_COLLECTION_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: false,
});

type CollectionRow = Record<string, unknown>;

export type DashboardRecordedCollectionReadResultV1 =
  | { enabled: false; status: "disabled" }
  | { enabled: true; data: RecordedGrossCollectionSliceV1 };

export type DashboardRecordedCollectionReadResultV2 = { enabled: false; status: "disabled" } | { enabled: true; data: RecordedGrossCollectionSliceV2 };
type CollectionCurrency = RecordedGrossCollectionCurrencyV1 | RecordedGrossCollectionCurrencyV2;

export type DashboardRecordedCollectionSnapshotResultV1 =
  | { enabled: false; status: "disabled" }
  | {
      enabled: true;
      snapshot: DashboardSnapshotResult<RecordedGrossCollectionSliceV1>;
    };

export class DashboardRecordedCollectionDataQualityErrorV1 extends PlatformError {
  constructor(fields: string[]) {
    super(
      "dashboard_recorded_collection_data_quality",
      "Recorded collection data is unavailable or inconsistent",
      422,
      { fields: [...new Set(fields)].sort() },
    );
    this.name = "DashboardRecordedCollectionDataQualityErrorV1";
  }
}

const DASHBOARD_RECORDED_COLLECTION_SQL = `
  WITH store_windows AS (
    SELECT
      windows.store_id,
      windows.start_inclusive,
      windows.end_exclusive,
      windows.time_zone
    FROM unnest(
      $2::text[],
      $3::timestamptz[],
      $4::timestamptz[],
      $6::text[]
    ) AS windows(store_id, start_inclusive, end_exclusive, time_zone)
  ), event_bundles AS (
    SELECT
      events.id,
      (events.source_occurred_at AT TIME ZONE windows.time_zone)::date::text AS local_date,
      events.currency_code,
      events.minor_unit_exponent,
      events.amount_minor,
      COALESCE(components.payment_event_id, deltas.payment_event_id) AS component_event_id,
      COALESCE(components.tax_mode, deltas.tax_mode) AS tax_mode,
      COALESCE((to_jsonb(components)->>'payment_fee_minor')::bigint, (to_jsonb(deltas)->>'payment_fee_delta_minor')::bigint, 0) AS payment_fee_minor,
      COALESCE((to_jsonb(components)->>'payment_fee_vat_minor')::bigint, (to_jsonb(deltas)->>'payment_fee_vat_delta_minor')::bigint, 0) AS payment_fee_vat_minor,
      COALESCE(components.merchandise_gross_minor, deltas.merchandise_gross_delta_minor)
        AS merchandise_gross_minor,
      COALESCE(components.discount_minor, deltas.discount_delta_minor) AS discount_minor,
      COALESCE(components.merchandise_net_minor, deltas.merchandise_net_delta_minor)
        AS merchandise_net_minor,
      COALESCE(components.shipping_minor, deltas.shipping_delta_minor) AS shipping_minor,
      COALESCE(components.merchandise_vat_minor, deltas.merchandise_vat_delta_minor)
        AS merchandise_vat_minor,
      COALESCE(components.shipping_vat_minor, deltas.shipping_vat_delta_minor)
        AS shipping_vat_minor,
      COALESCE(components.vat_minor, deltas.vat_delta_minor) AS vat_minor,
      COALESCE(components.unclassified_minor, deltas.unclassified_delta_minor)
        AS unclassified_minor,
      COALESCE(components.total_minor, deltas.total_delta_minor) AS total_minor,
      (
        SELECT COUNT(*)::bigint
        FROM app.payment_event_evidence evidence
        WHERE evidence.payment_event_id = events.id
          AND evidence.merchant_id = events.merchant_id
          AND evidence.store_id = events.store_id
          AND evidence.evidence_type = events.evidence_type
          AND evidence.evidence_fingerprint = events.evidence_fingerprint
          AND evidence.verification_status = 'verified'
          AND evidence.source_occurred_at = events.source_occurred_at
      ) AS exact_evidence_count,
      (
        SELECT COALESCE(SUM(allocations.amount_minor), 0)::bigint
        FROM app.payment_event_allocations allocations
        WHERE allocations.payment_event_id = events.id
          AND allocations.merchant_id = events.merchant_id
          AND allocations.store_id = events.store_id
          AND allocations.allocation_kind = 'collection'
          AND allocations.currency_code = events.currency_code
          AND allocations.minor_unit_exponent = events.minor_unit_exponent
      ) AS allocated_minor
    FROM app.payment_events events
    INNER JOIN store_windows windows ON windows.store_id = events.store_id
    LEFT JOIN app.payment_event_component_allocations components
      ON components.payment_event_id = events.id
      AND components.merchant_id = events.merchant_id
      AND components.store_id = events.store_id
      AND components.currency_code = events.currency_code
      AND components.minor_unit_exponent = events.minor_unit_exponent
    LEFT JOIN app.payment_correction_component_deltas deltas
      ON deltas.payment_event_id = events.id
      AND deltas.merchant_id = events.merchant_id
      AND deltas.store_id = events.store_id
      AND deltas.currency_code = events.currency_code
      AND deltas.minor_unit_exponent = events.minor_unit_exponent
    WHERE events.merchant_id = $1
      AND events.kind = 'charge'
      AND events.status = 'posted'
      AND events.source_occurred_at >= windows.start_inclusive
      AND events.source_occurred_at < LEAST(windows.end_exclusive, $5::timestamptz)
      AND events.recorded_at <= $5::timestamptz
      AND ($7::text = 'all' OR EXISTS (
        SELECT 1 FROM audit.events creator_event
        JOIN public."order" source_order ON source_order.id = creator_event.subject_id
          AND source_order.id = events.order_id
          AND source_order.merchant_id = events.merchant_id
          AND source_order.store_id = events.store_id
          AND source_order.deleted_at IS NULL
        WHERE creator_event.subject_type = 'order'
          AND creator_event.action IN ('order.created', 'order.remote_created', 'order.partner_created')
        GROUP BY creator_event.subject_id
        HAVING COUNT(*) = 1
          AND MAX(creator_event.actor_type) IN ('staff', 'manager', 'owner', 'accountant')
          AND MAX(creator_event.merchant_id) = events.merchant_id
          AND MAX(creator_event.store_id) = events.store_id
          AND MAX(creator_event.actor_id) = ANY($8::text[])
      ))
  )
  SELECT
    local_date,
    currency_code,
    minor_unit_exponent,
    COUNT(*)::bigint AS posted_event_count,
    COUNT(*) FILTER (WHERE payment_fee_minor <> 0 OR payment_fee_vat_minor <> 0)::bigint AS incompatible_fee_event_count,
    COALESCE(SUM(payment_fee_minor), 0)::bigint AS payment_fee_minor,
    COALESCE(SUM(payment_fee_vat_minor), 0)::bigint AS payment_fee_vat_minor,
    COALESCE(SUM(CASE WHEN tax_mode = 'inclusive' THEN payment_fee_vat_minor ELSE 0 END), 0)::bigint AS payment_fee_vat_included_in_price_minor,
    COALESCE(SUM(CASE WHEN tax_mode = 'exclusive' THEN payment_fee_vat_minor ELSE 0 END), 0)::bigint AS payment_fee_vat_added_to_price_minor,
    COUNT(*) FILTER (
      WHERE component_event_id IS NOT NULL
        AND exact_evidence_count = 1
        AND allocated_minor = amount_minor
        AND total_minor = amount_minor
    )::bigint AS valid_bundle_event_count,
    ARRAY_AGG(DISTINCT tax_mode ORDER BY tax_mode)
      FILTER (WHERE tax_mode IS NOT NULL) AS tax_modes,
    COALESCE(SUM(amount_minor), 0)::bigint AS recorded_gross_collections_minor,
    COALESCE(SUM(merchandise_gross_minor), 0)::bigint AS merchandise_gross_minor,
    COALESCE(SUM(discount_minor), 0)::bigint AS discount_minor,
    COALESCE(SUM(merchandise_net_minor), 0)::bigint AS merchandise_net_minor,
    COALESCE(SUM(shipping_minor), 0)::bigint AS shipping_minor,
    COALESCE(SUM(merchandise_vat_minor), 0)::bigint AS merchandise_vat_minor,
    COALESCE(SUM(shipping_vat_minor), 0)::bigint AS shipping_vat_minor,
    COALESCE(SUM(vat_minor), 0)::bigint AS vat_minor,
    COALESCE(SUM(CASE WHEN tax_mode = 'inclusive' THEN vat_minor ELSE 0 END), 0)::bigint
      AS vat_included_in_price_minor,
    COALESCE(SUM(CASE WHEN tax_mode = 'exclusive' THEN vat_minor ELSE 0 END), 0)::bigint
      AS vat_added_to_price_minor,
    COALESCE(SUM(unclassified_minor), 0)::bigint AS unclassified_minor,
    COALESCE(SUM(total_minor), 0)::bigint AS component_total_minor
  FROM event_bundles
  GROUP BY local_date, currency_code, minor_unit_exponent
  ORDER BY currency_code, local_date
`;

function dataQuality(fields: string[]): never {
  throw new DashboardRecordedCollectionDataQualityErrorV1(fields);
}

function safeInteger(value: unknown, field: string): number {
  const text = typeof value === "bigint"
    ? value.toString()
    : typeof value === "number" || typeof value === "string"
      ? String(value)
      : "";
  if (!/^(0|[1-9]\d*)$/.test(text)) return dataQuality([field]);
  const result = Number(text);
  if (!Number.isSafeInteger(result) || result < 0) return dataQuality([field]);
  return result;
}

function signedInteger(value: unknown, field: string): number {
  const text = typeof value === "bigint"
    ? value.toString()
    : typeof value === "number" || typeof value === "string"
      ? String(value)
      : "";
  if (!/^-?(0|[1-9]\d*)$/.test(text)) return dataQuality([field]);
  const result = Number(text);
  if (!Number.isSafeInteger(result)) return dataQuality([field]);
  return result;
}

function safeAdd(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) return dataQuality([field]);
  return result;
}

export function normalizeDashboardPaymentReadContext(context: DashboardSnapshotReadContext) {
  const parsed = DashboardReportContextV1Schema.safeParse({
    schemaVersion: 1,
    normalizedScope: context.normalizedScope,
    localDateRange: context.localDateRange,
    storeTimeWindows: context.storeTimeWindows,
    reportAsOf: context.reportAsOf,
    generatedAt: context.reportAsOf,
    metricTimeBasis: context.metricTimeBasis,
    freshness: {
      databaseSnapshot: { status: "fresh", asOf: context.reportAsOf },
    },
  });
  if (
    !parsed.success
    || JSON.stringify(parsed.data.metricTimeBasis)
      !== JSON.stringify(DASHBOARD_METRIC_TIME_BASIS_V2)
  ) {
    return dataQuality(["context"]);
  }
  return {
    merchantId: parsed.data.normalizedScope.merchantId,
    storeIds: parsed.data.storeTimeWindows.map((window) => window.storeId),
    startInclusive: parsed.data.storeTimeWindows.map((window) => window.startInclusive),
    endExclusive: parsed.data.storeTimeWindows.map((window) => window.endExclusive),
    timeZones: parsed.data.storeTimeWindows.map((window) => window.timeZone),
    reportAsOf: parsed.data.reportAsOf,
    localDateLabels: generateDashboardLocalDateLabels(parsed.data.localDateRange),
  };
}

function taxModes(value: unknown): Array<"exclusive" | "inclusive"> {
  if (!Array.isArray(value)) return dataQuality(["tax_modes"]);
  if (value.some((entry) => entry !== "exclusive" && entry !== "inclusive")) {
    return dataQuality(["tax_modes"]);
  }
  return [...value] as Array<"exclusive" | "inclusive">;
}

function normalizeRow(
  row: CollectionRow,
  localDateLabels: string[],
  version: 1 | 2,
): { localDate: string; currency: CollectionCurrency } {
  const localDate = typeof row.local_date === "string" ? row.local_date : "";
  if (!localDateLabels.includes(localDate)) return dataQuality(["local_date"]);
  const postedChargeEventCount = safeInteger(row.posted_event_count, "posted_event_count");
  const candidate = {
    currencyCode: row.currency_code,
    minorUnitExponent: safeInteger(row.minor_unit_exponent, "minor_unit_exponent"),
    postedChargeEventCount,
    bundleCoverage: {
      validEvents: safeInteger(row.valid_bundle_event_count, "valid_bundle_event_count"),
      totalEvents: postedChargeEventCount,
    },
    recordedGrossCollectionsMinor: safeInteger(
      row.recorded_gross_collections_minor,
      "recorded_gross_collections_minor",
    ),
    dailyRecordedGrossCollectionsSeries: [{
      localDate,
      recordedGrossCollectionsMinor: safeInteger(
        row.recorded_gross_collections_minor,
        "recorded_gross_collections_minor",
      ),
    }],
    components: {
      ...(version === 2 ? {
        paymentFeeMinor: signedInteger(row.payment_fee_minor ?? 0, "payment_fee_minor"),
        paymentFeeVatMinor: signedInteger(row.payment_fee_vat_minor ?? 0, "payment_fee_vat_minor"),
        paymentFeeVatIncludedInPriceMinor: signedInteger(row.payment_fee_vat_included_in_price_minor ?? 0, "payment_fee_vat_included_in_price_minor"),
        paymentFeeVatAddedToPriceMinor: signedInteger(row.payment_fee_vat_added_to_price_minor ?? 0, "payment_fee_vat_added_to_price_minor"),
      } : {}),
      taxModes: taxModes(row.tax_modes),
      merchandiseGrossMinor: signedInteger(row.merchandise_gross_minor, "merchandise_gross_minor"),
      discountMinor: signedInteger(row.discount_minor, "discount_minor"),
      merchandiseNetMinor: signedInteger(row.merchandise_net_minor, "merchandise_net_minor"),
      shippingMinor: signedInteger(row.shipping_minor, "shipping_minor"),
      merchandiseVatMinor: signedInteger(row.merchandise_vat_minor, "merchandise_vat_minor"),
      shippingVatMinor: signedInteger(row.shipping_vat_minor, "shipping_vat_minor"),
      vatMinor: signedInteger(row.vat_minor, "vat_minor"),
      vatIncludedInPriceMinor: signedInteger(
        row.vat_included_in_price_minor,
        "vat_included_in_price_minor",
      ),
      vatAddedToPriceMinor: signedInteger(row.vat_added_to_price_minor, "vat_added_to_price_minor"),
      unclassifiedMinor: signedInteger(row.unclassified_minor, "unclassified_minor"),
      totalMinor: safeInteger(row.component_total_minor, "component_total_minor"),
    },
  };
  const parsed = version === 2 ? RecordedGrossCollectionCurrencyV2Schema.safeParse(candidate) : RecordedGrossCollectionCurrencyV1Schema.safeParse(candidate);
  if (!parsed.success) {
    return dataQuality(parsed.error.issues.map((issue) => issue.path.join(".") || issue.message));
  }
  return { localDate, currency: parsed.data };
}

type CollectionAccumulator = {
  currencyCode: string;
  minorUnitExponent: number;
  postedChargeEventCount: number;
  validBundleEventCount: number;
  recordedGrossCollectionsMinor: number;
  dailyRecordedGrossCollectionsMinor: Map<string, number>;
  taxModes: Set<"exclusive" | "inclusive">;
  components: Omit<RecordedGrossCollectionComponentsV2, "taxModes">;
  seenLocalDates: Set<string>;
};

function emptyCollectionComponents(): Omit<RecordedGrossCollectionComponentsV2, "taxModes"> {
  return {
    paymentFeeMinor: 0, paymentFeeVatMinor: 0, paymentFeeVatIncludedInPriceMinor: 0, paymentFeeVatAddedToPriceMinor: 0,
    merchandiseGrossMinor: 0,
    discountMinor: 0,
    merchandiseNetMinor: 0,
    shippingMinor: 0,
    merchandiseVatMinor: 0,
    shippingVatMinor: 0,
    vatMinor: 0,
    vatIncludedInPriceMinor: 0,
    vatAddedToPriceMinor: 0,
    unclassifiedMinor: 0,
    totalMinor: 0,
  };
}

function aggregateRows(
  rows: CollectionRow[],
  localDateLabels: string[],
  version: 1 | 2,
): CollectionCurrency[] {
  const buckets = new Map<string, CollectionAccumulator>();
  for (const row of rows) {
    const normalized = normalizeRow(row, localDateLabels, version);
    const current = normalized.currency;
    let bucket = buckets.get(current.currencyCode);
    if (!bucket) {
      bucket = {
        currencyCode: current.currencyCode,
        minorUnitExponent: current.minorUnitExponent,
        postedChargeEventCount: 0,
        validBundleEventCount: 0,
        recordedGrossCollectionsMinor: 0,
        dailyRecordedGrossCollectionsMinor: new Map(
          localDateLabels.map((localDate) => [localDate, 0]),
        ),
        taxModes: new Set(),
        components: emptyCollectionComponents(),
        seenLocalDates: new Set(),
      };
      buckets.set(current.currencyCode, bucket);
    }
    if (bucket.minorUnitExponent !== current.minorUnitExponent) {
      return dataQuality(["minor_unit_exponent"]);
    }
    if (bucket.seenLocalDates.has(normalized.localDate)) {
      return dataQuality(["duplicate_currency_local_date"]);
    }
    bucket.seenLocalDates.add(normalized.localDate);
    bucket.postedChargeEventCount = safeAdd(
      bucket.postedChargeEventCount,
      current.postedChargeEventCount,
      "posted_event_count",
    );
    bucket.validBundleEventCount = safeAdd(
      bucket.validBundleEventCount,
      current.bundleCoverage.validEvents,
      "valid_bundle_event_count",
    );
    bucket.recordedGrossCollectionsMinor = safeAdd(
      bucket.recordedGrossCollectionsMinor,
      current.recordedGrossCollectionsMinor,
      "recorded_gross_collections_minor",
    );
    bucket.dailyRecordedGrossCollectionsMinor.set(
      normalized.localDate,
      current.recordedGrossCollectionsMinor,
    );
    if (version === 2) {
      const fee = RecordedGrossCollectionCurrencyV2Schema.parse(current).components;
      for (const field of ["paymentFeeMinor", "paymentFeeVatMinor", "paymentFeeVatIncludedInPriceMinor", "paymentFeeVatAddedToPriceMinor"] as const) {
        bucket.components[field] = safeAdd(bucket.components[field], fee[field], field);
      }
    }
    for (const mode of current.components.taxModes) bucket.taxModes.add(mode);
    for (const field of [
      "merchandiseGrossMinor",
      "discountMinor",
      "merchandiseNetMinor",
      "shippingMinor",
      "merchandiseVatMinor",
      "shippingVatMinor",
      "vatMinor",
      "vatIncludedInPriceMinor",
      "vatAddedToPriceMinor",
      "unclassifiedMinor",
      "totalMinor",
    ] as const) {
      bucket.components[field] = safeAdd(
        bucket.components[field],
        current.components[field],
        field,
      );
    }
  }

  return [...buckets.values()]
    .sort((left, right) => left.currencyCode.localeCompare(right.currencyCode))
    .map((bucket) => {
      const { paymentFeeMinor, paymentFeeVatMinor, paymentFeeVatIncludedInPriceMinor, paymentFeeVatAddedToPriceMinor, ...legacyComponents } = bucket.components;
      const candidate = {
        currencyCode: bucket.currencyCode,
        minorUnitExponent: bucket.minorUnitExponent,
        postedChargeEventCount: bucket.postedChargeEventCount,
        bundleCoverage: {
          validEvents: bucket.validBundleEventCount,
          totalEvents: bucket.postedChargeEventCount,
        },
        recordedGrossCollectionsMinor: bucket.recordedGrossCollectionsMinor,
        dailyRecordedGrossCollectionsSeries: localDateLabels.map((localDate) => ({
          localDate,
          recordedGrossCollectionsMinor:
            bucket.dailyRecordedGrossCollectionsMinor.get(localDate) ?? 0,
        })),
        components: {
          taxModes: [...bucket.taxModes].sort(),
          ...legacyComponents,
          ...(version === 2 ? { paymentFeeMinor, paymentFeeVatMinor, paymentFeeVatIncludedInPriceMinor, paymentFeeVatAddedToPriceMinor } : {}),
        },
      };
      const parsed = version === 2 ? RecordedGrossCollectionCurrencyV2Schema.safeParse(candidate) : RecordedGrossCollectionCurrencyV1Schema.safeParse(candidate);
      if (!parsed.success) {
        return dataQuality(
          parsed.error.issues.map((issue) => issue.path.join(".") || issue.message),
        );
      }
      return parsed.data;
    });
}

export async function assertNoHistoricalPaymentQuarantine(
  client: Pick<PoolClient, "query">,
  normalized: ReturnType<typeof normalizeDashboardPaymentReadContext>,
  creatorSelection: CreatorSelectionV1,
): Promise<void> {
  const foundation = await client.query<{ present: unknown }>(`
    SELECT to_regclass('app.historical_reconciliation_items') IS NOT NULL AS present
  `);
  if (foundation.rows[0]?.present !== true) return;
  const quarantine = await client.query<Record<string, unknown>>(`
    WITH store_windows AS (
      SELECT windows.store_id, windows.start_inclusive, windows.end_exclusive
      FROM unnest(
        $2::text[], $3::timestamptz[], $4::timestamptz[]
      ) AS windows(store_id, start_inclusive, end_exclusive)
    )
    SELECT count(*)::text AS quarantined_count,
      COALESCE(sum((items.component_amounts_minor->>'amount_minor')::bigint),0)::text
        AS quarantined_minor
    FROM app.historical_reconciliation_items items
    JOIN store_windows windows ON windows.store_id=items.store_id
    LEFT JOIN public."order" source_order ON source_order.id=items.order_id
      AND source_order.merchant_id=items.merchant_id AND source_order.store_id=items.store_id
      AND source_order.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT MAX(event.actor_id) AS actor_id, MAX(event.actor_type) AS actor_type
      FROM audit.events event
      WHERE event.subject_type='order' AND event.subject_id=source_order.id
        AND event.action IN ('order.created','order.remote_created','order.partner_created')
      HAVING COUNT(*)=1
        AND MAX(event.actor_type) IN ('staff','manager','owner','accountant','partner')
        AND MAX(event.merchant_id)=items.merchant_id AND MAX(event.store_id)=items.store_id
        AND NULLIF(BTRIM(MAX(event.actor_id)),'') IS NOT NULL
    ) creator ON true
    WHERE items.merchant_id=$1
      AND items.source_table='app.payment_entries'
      AND items.decision='quarantine'
      AND items.source_occurred_at >= windows.start_inclusive
      AND items.source_occurred_at < LEAST(windows.end_exclusive,$5::timestamptz)
      AND items.recorded_at <= $5::timestamptz
      AND ($6::text='all' OR creator.actor_id IS NULL
        OR (creator.actor_type IN ('staff','manager','owner','accountant')
          AND creator.actor_id=ANY($7::text[])))
  `, [normalized.merchantId, normalized.storeIds, normalized.startInclusive,
    normalized.endExclusive, normalized.reportAsOf, creatorSelection.mode, creatorSelection.creatorOperatorIds]);
  const count = safeInteger(quarantine.rows[0]?.quarantined_count, "historical_payment_quarantine_count");
  const amount = safeInteger(quarantine.rows[0]?.quarantined_minor, "historical_payment_quarantine_minor");
  if (count > 0 || amount > 0) {
    return dataQuality([
      `historical_payment_quarantine_count:${count}`,
      `historical_payment_quarantine_minor:${amount}`,
    ]);
  }
}

async function readCollectionSlice(
  client: Pick<PoolClient, "query">,
  context: DashboardSnapshotReadContext,
  config: { enabled: boolean } = DASHBOARD_RECORDED_COLLECTION_DEFAULT_CONFIG_V1,
  creatorSelectionInput?: CreatorSelectionV1,
  version: 1 | 2 = 1,
): Promise<{ enabled: false; status: "disabled" } | { enabled: true; data: RecordedGrossCollectionSliceV1 | RecordedGrossCollectionSliceV2 }> {
  if (config.enabled !== true) return { enabled: false, status: "disabled" };
  const normalized = normalizeDashboardPaymentReadContext(context);
  const creatorSelection = CreatorSelectionV1Schema.parse(creatorSelectionInput || { mode: "all", creatorOperatorIds: [] });
  await assertNoHistoricalPaymentQuarantine(client, normalized, creatorSelection);
  const result = await client.query<CollectionRow>(DASHBOARD_RECORDED_COLLECTION_SQL, [
    normalized.merchantId,
    normalized.storeIds,
    normalized.startInclusive,
    normalized.endExclusive,
    normalized.reportAsOf,
    normalized.timeZones,
    creatorSelection.mode,
    creatorSelection.creatorOperatorIds,
  ]);
  if (version === 1 && result.rows.some(row => safeInteger(row.incompatible_fee_event_count ?? 0, "incompatible_fee_event_count") !== 0)) {
    throw new PlatformError("unsupported_contract", "Update the client to read collections with payment surcharges", 409);
  }
  const payload = {
    schemaVersion: version,
    aggregateReadSource: "app.payment_events",
    currencies: aggregateRows(result.rows, normalized.localDateLabels, version),
  };
  const parsed = version === 2 ? RecordedGrossCollectionSliceV2Schema.safeParse(payload) : RecordedGrossCollectionSliceV1Schema.safeParse(payload);
  if (!parsed.success) {
    return dataQuality(parsed.error.issues.map((issue) => issue.path.join(".") || issue.message));
  }
  return { enabled: true, data: parsed.data };
}

export async function readDashboardRecordedCollectionSnapshotV1(
  client: PoolClient,
  request: DashboardSnapshotRequest,
  config: { enabled: boolean } = DASHBOARD_RECORDED_COLLECTION_DEFAULT_CONFIG_V1,
): Promise<DashboardRecordedCollectionSnapshotResultV1> {
  if (config.enabled !== true) return { enabled: false, status: "disabled" };
  const snapshot = await withDashboardReadSnapshot(client, request, async (
    snapshotClient,
    context,
  ) => {
    const result = await readDashboardRecordedCollectionSliceV1(
      snapshotClient,
      context,
      { enabled: true },
    );
    if (!result.enabled) return dataQuality(["reader_disabled_inside_snapshot"]);
    return result.data;
  });
  return { enabled: true, snapshot };
}

export async function readDashboardRecordedCollectionSliceV1(client: Pick<PoolClient, "query">, context: DashboardSnapshotReadContext,
  config: { enabled: boolean } = DASHBOARD_RECORDED_COLLECTION_DEFAULT_CONFIG_V1, creators?: CreatorSelectionV1): Promise<DashboardRecordedCollectionReadResultV1> {
  const result = await readCollectionSlice(client, context, config, creators, 1);
  return result.enabled ? { enabled: true, data: RecordedGrossCollectionSliceV1Schema.parse(result.data) } : result;
}
export async function readDashboardRecordedCollectionSliceV2(client: Pick<PoolClient, "query">, context: DashboardSnapshotReadContext,
  config: { enabled: boolean } = DASHBOARD_RECORDED_COLLECTION_DEFAULT_CONFIG_V1, creators?: CreatorSelectionV1): Promise<DashboardRecordedCollectionReadResultV2> {
  const result = await readCollectionSlice(client, context, config, creators, 2);
  return result.enabled ? { enabled: true, data: RecordedGrossCollectionSliceV2Schema.parse(result.data) } : result;
}
