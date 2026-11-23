import {
  CreatorSelectionV1Schema,
  type CreatorSelectionV1,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import type { DashboardSnapshotReadContext } from "./dashboard-report-foundation";

export interface DashboardPaymentFlowCurrencyV1 {
  currencyCode: string;
  minorUnitExponent: number;
  postedRefundEventCount: number;
  postedReversalEventCount: number;
  postedChargebackEventCount: number;
  refundsMinor: number;
  reversalsMinor: number;
  chargebacksMinor: number;
  negativeCollectionsMinor: number;
  customerRefundPayableAsOfMinor: number;
  methods: Array<{
    method: string;
    postedChargeOrderCount: number;
    postedNegativeEventCount: number;
    recordedGrossCollectionsMinor: number;
    recordedNegativeCollectionsMinor: number;
    recordedNetCollectionsMinor: number;
  }>;
}

function nonnegative(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PlatformError(
      "dashboard_payment_flow_data_quality",
      `Dashboard payment flow ${field} is invalid`,
      422,
    );
  }
  return parsed;
}

export async function readDashboardPaymentFlowSliceV1(
  client: Pick<PoolClient, "query">,
  context: DashboardSnapshotReadContext,
  creatorSelectionInput?: CreatorSelectionV1,
): Promise<DashboardPaymentFlowCurrencyV1[]> {
  const creatorSelection = CreatorSelectionV1Schema.parse(
    creatorSelectionInput || { mode: "all", creatorOperatorIds: [] },
  );
  const parameters = [
    context.normalizedScope.merchantId,
    context.storeTimeWindows.map((window) => window.storeId),
    context.storeTimeWindows.map((window) => window.startInclusive),
    context.storeTimeWindows.map((window) => window.endExclusive),
    context.reportAsOf,
    creatorSelection.mode,
    creatorSelection.creatorOperatorIds,
  ];
  const result = await client.query<Record<string, unknown>>(`
    WITH store_windows AS (
      SELECT windows.store_id, windows.start_inclusive, windows.end_exclusive
      FROM unnest(
        $2::text[], $3::timestamptz[], $4::timestamptz[]
      ) AS windows(store_id, start_inclusive, end_exclusive)
    ), flow AS (
      SELECT events.currency_code, events.minor_unit_exponent,
        COUNT(*) FILTER (WHERE events.kind = 'refund') AS refund_count,
        COUNT(*) FILTER (WHERE events.kind = 'reversal') AS reversal_count,
        COUNT(*) FILTER (WHERE events.kind = 'chargeback') AS chargeback_count,
        COALESCE(SUM(events.amount_minor) FILTER (WHERE events.kind = 'refund'), 0)
          AS refunds_minor,
        COALESCE(SUM(events.amount_minor) FILTER (WHERE events.kind = 'reversal'), 0)
          AS reversals_minor,
        COALESCE(SUM(events.amount_minor) FILTER (WHERE events.kind = 'chargeback'), 0)
          AS chargebacks_minor
      FROM app.payment_events events
      JOIN store_windows windows ON windows.store_id = events.store_id
      WHERE events.merchant_id = $1
        AND events.status = 'posted'
        AND events.kind IN ('refund', 'reversal', 'chargeback')
        AND events.source_occurred_at >= windows.start_inclusive
        AND events.source_occurred_at < LEAST(windows.end_exclusive, $5::timestamptz)
        AND events.recorded_at <= $5::timestamptz
        AND (
          $6::text = 'all'
          OR EXISTS (
            SELECT 1
            FROM public."order" source_order
            JOIN audit.events creator_event
              ON creator_event.subject_type = 'order'
             AND creator_event.subject_id = source_order.id
            WHERE source_order.id = events.order_id
              AND source_order.merchant_id = events.merchant_id
              AND source_order.store_id = events.store_id
              AND creator_event.action IN ('order.created', 'order.remote_created', 'order.partner_created')
            GROUP BY source_order.id
            HAVING COUNT(*) = 1
               AND MAX(creator_event.actor_type) IN ('staff', 'manager', 'owner', 'accountant')
               AND MAX(creator_event.merchant_id) = events.merchant_id
               AND MAX(creator_event.store_id) = events.store_id
               AND MAX(creator_event.actor_id) = ANY($7::text[])
          )
        )
      GROUP BY events.currency_code, events.minor_unit_exponent
    ), payable AS (
      SELECT payables.currency_code, payables.minor_unit_exponent,
        GREATEST(0,
          SUM(payables.amount_minor) - COALESCE(SUM(clears.cleared_minor), 0)
        ) AS payable_minor
      FROM app.customer_refund_payables payables
      LEFT JOIN LATERAL (
        SELECT SUM(events.amount_minor) AS cleared_minor
        FROM app.customer_refund_payable_events events
        WHERE events.payable_id = payables.id
          AND events.event_kind = 'clear'
          AND events.source_occurred_at <= $5::timestamptz
          AND events.recorded_at <= $5::timestamptz
      ) clears ON true
      WHERE payables.merchant_id = $1
        AND payables.store_id = ANY($2::text[])
        AND payables.source_occurred_at <= $5::timestamptz
        AND payables.recorded_at <= $5::timestamptz
        AND (
          $6::text = 'all'
          OR EXISTS (
            SELECT 1
            FROM public."order" source_order
            JOIN audit.events creator_event
              ON creator_event.subject_type = 'order'
             AND creator_event.subject_id = source_order.id
            WHERE source_order.id = payables.order_id
              AND source_order.merchant_id = payables.merchant_id
              AND source_order.store_id = payables.store_id
              AND creator_event.action IN ('order.created', 'order.remote_created', 'order.partner_created')
            GROUP BY source_order.id
            HAVING COUNT(*) = 1
               AND MAX(creator_event.actor_type) IN ('staff', 'manager', 'owner', 'accountant')
               AND MAX(creator_event.merchant_id) = payables.merchant_id
               AND MAX(creator_event.store_id) = payables.store_id
               AND MAX(creator_event.actor_id) = ANY($7::text[])
          )
        )
      GROUP BY payables.currency_code, payables.minor_unit_exponent
    ), currencies AS (
      SELECT currency_code, minor_unit_exponent FROM flow
      UNION
      SELECT currency_code, minor_unit_exponent FROM payable
    )
    SELECT currencies.currency_code, currencies.minor_unit_exponent,
      COALESCE(flow.refund_count, 0)::text AS refund_count,
      COALESCE(flow.reversal_count, 0)::text AS reversal_count,
      COALESCE(flow.chargeback_count, 0)::text AS chargeback_count,
      COALESCE(flow.refunds_minor, 0)::text AS refunds_minor,
      COALESCE(flow.reversals_minor, 0)::text AS reversals_minor,
      COALESCE(flow.chargebacks_minor, 0)::text AS chargebacks_minor,
      COALESCE(payable.payable_minor, 0)::text AS payable_minor
    FROM currencies
    LEFT JOIN flow USING (currency_code, minor_unit_exponent)
    LEFT JOIN payable USING (currency_code, minor_unit_exponent)
    ORDER BY currencies.currency_code
  `, parameters);
  const methodResult = await client.query<Record<string, unknown>>(`
    WITH store_windows AS (
      SELECT windows.store_id, windows.start_inclusive, windows.end_exclusive
      FROM unnest(
        $2::text[], $3::timestamptz[], $4::timestamptz[]
      ) AS windows(store_id, start_inclusive, end_exclusive)
    )
    SELECT events.currency_code, events.minor_unit_exponent, events.method,
      COUNT(DISTINCT events.order_id) FILTER (WHERE events.kind = 'charge')::text
        AS charge_order_count,
      COUNT(*) FILTER (
        WHERE events.kind IN ('refund', 'reversal', 'chargeback')
      )::text AS negative_count,
      COALESCE(SUM(events.amount_minor) FILTER (
        WHERE events.kind = 'charge'
      ), 0)::text AS gross_minor,
      COALESCE(SUM(events.amount_minor) FILTER (
        WHERE events.kind IN ('refund', 'reversal', 'chargeback')
      ), 0)::text AS negative_minor
    FROM app.payment_events events
    JOIN store_windows windows ON windows.store_id = events.store_id
    WHERE events.merchant_id = $1
      AND events.status = 'posted'
      AND events.kind IN ('charge', 'refund', 'reversal', 'chargeback')
      AND events.source_occurred_at >= windows.start_inclusive
      AND events.source_occurred_at < LEAST(windows.end_exclusive, $5::timestamptz)
      AND events.recorded_at <= $5::timestamptz
      AND (
        $6::text = 'all'
        OR EXISTS (
          SELECT 1
          FROM public."order" source_order
          JOIN audit.events creator_event
            ON creator_event.subject_type = 'order'
           AND creator_event.subject_id = source_order.id
          WHERE source_order.id = events.order_id
            AND source_order.merchant_id = events.merchant_id
            AND source_order.store_id = events.store_id
            AND creator_event.action IN ('order.created', 'order.remote_created', 'order.partner_created')
          GROUP BY source_order.id
          HAVING COUNT(*) = 1
             AND MAX(creator_event.actor_type) IN ('staff', 'manager', 'owner', 'accountant')
             AND MAX(creator_event.merchant_id) = events.merchant_id
             AND MAX(creator_event.store_id) = events.store_id
             AND MAX(creator_event.actor_id) = ANY($7::text[])
        )
      )
    GROUP BY events.currency_code, events.minor_unit_exponent, events.method
    ORDER BY events.currency_code, events.method
  `, parameters);
  const methodsByCurrency = new Map<string, DashboardPaymentFlowCurrencyV1["methods"]>();
  for (const row of methodResult.rows) {
    const currencyCode = String(row.currency_code || "").toUpperCase();
    const minorUnitExponent = nonnegative(row.minor_unit_exponent, "method minor exponent");
    const method = String(row.method || "").trim();
    if (!/^[A-Z]{3}$/.test(currencyCode) || !method) {
      throw new PlatformError(
        "dashboard_payment_flow_data_quality",
        "Dashboard payment method identity is invalid",
        422,
      );
    }
    const gross = nonnegative(row.gross_minor, "method gross");
    const negative = nonnegative(row.negative_minor, "method negative");
    const net = gross - negative;
    if (!Number.isSafeInteger(net)) {
      throw new PlatformError(
        "dashboard_payment_flow_data_quality",
        "Dashboard payment method net exceeds safe integer",
        422,
      );
    }
    const key = `${currencyCode}:${minorUnitExponent}`;
    const methods = methodsByCurrency.get(key) || [];
    methods.push({
      method,
      postedChargeOrderCount: nonnegative(row.charge_order_count, "method charge order count"),
      postedNegativeEventCount: nonnegative(row.negative_count, "method negative count"),
      recordedGrossCollectionsMinor: gross,
      recordedNegativeCollectionsMinor: negative,
      recordedNetCollectionsMinor: net,
    });
    methodsByCurrency.set(key, methods);
  }
  const currencies = result.rows.map((row) => {
    const refundsMinor = nonnegative(row.refunds_minor, "refunds");
    const reversalsMinor = nonnegative(row.reversals_minor, "reversals");
    const chargebacksMinor = nonnegative(row.chargebacks_minor, "chargebacks");
    const negativeCollectionsMinor = refundsMinor + reversalsMinor + chargebacksMinor;
    if (!Number.isSafeInteger(negativeCollectionsMinor)) {
      throw new PlatformError(
        "dashboard_payment_flow_data_quality",
        "Dashboard negative collection exceeds safe integer",
        422,
      );
    }
    const currencyCode = String(row.currency_code || "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyCode)) {
      throw new PlatformError(
        "dashboard_payment_flow_data_quality",
        "Dashboard payment flow currency is invalid",
        422,
      );
    }
    return {
      currencyCode,
      minorUnitExponent: nonnegative(row.minor_unit_exponent, "minor exponent"),
      postedRefundEventCount: nonnegative(row.refund_count, "refund count"),
      postedReversalEventCount: nonnegative(row.reversal_count, "reversal count"),
      postedChargebackEventCount: nonnegative(row.chargeback_count, "chargeback count"),
      refundsMinor,
      reversalsMinor,
      chargebacksMinor,
      negativeCollectionsMinor,
      customerRefundPayableAsOfMinor: nonnegative(row.payable_minor, "payable"),
      methods: methodsByCurrency.get(`${currencyCode}:${nonnegative(row.minor_unit_exponent, "minor exponent")}`) || [],
    };
  });
  const existingKeys = new Set(
    currencies.map((currency) => `${currency.currencyCode}:${currency.minorUnitExponent}`),
  );
  for (const [key, methods] of methodsByCurrency) {
    if (existingKeys.has(key)) continue;
    const separator = key.lastIndexOf(":");
    const currencyCode = key.slice(0, separator);
    const minorUnitExponent = nonnegative(key.slice(separator + 1), "method minor exponent");
    currencies.push({
      currencyCode,
      minorUnitExponent,
      postedRefundEventCount: 0,
      postedReversalEventCount: 0,
      postedChargebackEventCount: 0,
      refundsMinor: 0,
      reversalsMinor: 0,
      chargebacksMinor: 0,
      negativeCollectionsMinor: 0,
      customerRefundPayableAsOfMinor: 0,
      methods,
    });
  }
  return currencies.sort((left, right) => (
    left.currencyCode.localeCompare(right.currencyCode)
    || left.minorUnitExponent - right.minorUnitExponent
  ));
}
