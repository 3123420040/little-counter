import { ensurePlatformSchema } from "../db/schema";
import { withConnectedReportClient } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import type { DashboardStoreTimeWindowV1, ReportScope } from "@medusa-snus/contracts";
import {
  normalizeDashboardLocalDateRange,
  resolveDashboardHistoryStoreWindows,
} from "./dashboard-report-foundation";

export interface DashboardFilters {
  date?: string;
  from?: string;
  to?: string;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizeRange(filters: DashboardFilters = {}) {
  const today = isoDate(new Date());
  const from = filters.from || filters.date || today;
  const to = filters.to || filters.date || from;
  return from > to ? { from: to, to: from } : { from, to };
}

function serializedStoreWindows(windows: DashboardStoreTimeWindowV1[]): string {
  return JSON.stringify(windows.map((window) => ({
    store_id: window.storeId,
    time_zone: window.timeZone,
    start_inclusive: window.startInclusive,
    end_exclusive: window.endExclusive,
  })));
}

function effectiveOrderCte(): string {
  return `
    WITH store_windows AS (
      SELECT
        requested.store_id,
        requested.time_zone,
        requested.start_inclusive::timestamptz AS start_inclusive,
        requested.end_exclusive::timestamptz AS end_exclusive
      FROM jsonb_to_recordset($3::jsonb) AS requested(
        store_id text,
        time_zone text,
        start_inclusive text,
        end_exclusive text
      )
    ), cohort_orders AS (
      SELECT
        o.id,
        (o.created_at AT TIME ZONE windows.time_zone)::date AS business_date
      FROM public."order" o
      JOIN store_windows windows ON windows.store_id = o.store_id
      WHERE o.deleted_at IS NULL
        AND o.merchant_id = $4
        AND o.created_at >= windows.start_inclusive
        AND o.created_at < windows.end_exclusive
        AND (o.created_at AT TIME ZONE windows.time_zone)::date BETWEEN $1::date AND $2::date
    ), latest_revisions AS (
      SELECT cohort.id AS order_id, cohort.business_date,
        revision.id AS revision_id, revision.commercial_state
      FROM cohort_orders cohort
      LEFT JOIN LATERAL (
        SELECT candidate.id, candidate.commercial_state
        FROM app.order_commercial_revisions candidate
        WHERE candidate.order_id = cohort.id
          AND candidate.effective_at <= transaction_timestamp()
        ORDER BY candidate.revision DESC, candidate.effective_at DESC, candidate.id DESC
        LIMIT 1
      ) revision ON true
    ), effective_orders AS (
      SELECT latest.order_id, latest.business_date, latest.revision_id,
        latest.commercial_state,
        components.tax_mode,
        components.merchandise_gross_minor,
        components.discount_minor,
        components.merchandise_net_minor,
        components.shipping_minor,
        components.merchandise_vat_minor,
        components.shipping_vat_minor,
        components.vat_minor,
        components.unclassified_minor,
        components.total_minor,
        COALESCE((to_jsonb(components)->>'payment_fee_minor')::bigint, 0) AS payment_fee_minor,
        COALESCE((to_jsonb(components)->>'payment_fee_vat_minor')::bigint, 0) AS payment_fee_vat_minor
      FROM latest_revisions latest
      JOIN app.order_commercial_revision_components components
        ON components.revision_id = latest.revision_id
    )
  `;
}

export async function getDashboard(scope: ReportScope, filters: DashboardFilters = {}) {
  if (!scope?.merchantId) {
    throw new PlatformError("scope_required", "getDashboard requires tenantId in ReportScope", 409);
  }
  await ensurePlatformSchema();

  return withConnectedReportClient(async (client) => {
    const { from, to } = normalizeRange(filters);
    const normalizedRange = normalizeDashboardLocalDateRange({ from, to });
    const cte = effectiveOrderCte();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
    const storeWindows = await resolveDashboardHistoryStoreWindows(client, scope, normalizedRange);
    const commonParams = [from, to, serializedStoreWindows(storeWindows), scope.merchantId];
    // A fee-bearing collection can fall outside the original order-created cohort.
    const orders = await client.query(`${cte}
      SELECT
        COUNT(*) FILTER (WHERE payment_fee_minor <> 0 OR payment_fee_vat_minor <> 0)::int AS incompatible_fee_order_count,
        EXISTS (
          SELECT 1 FROM app.payment_events events
          JOIN store_windows windows ON windows.store_id = events.store_id
          LEFT JOIN app.payment_event_component_allocations allocations
            ON allocations.payment_event_id = events.id AND allocations.merchant_id = events.merchant_id
            AND allocations.store_id = events.store_id AND allocations.currency_code = events.currency_code
            AND allocations.minor_unit_exponent = events.minor_unit_exponent
          LEFT JOIN app.payment_correction_component_deltas deltas
            ON deltas.payment_event_id = events.id AND deltas.merchant_id = events.merchant_id
            AND deltas.store_id = events.store_id AND deltas.currency_code = events.currency_code
            AND deltas.minor_unit_exponent = events.minor_unit_exponent
          WHERE events.merchant_id = $4 AND events.kind = 'charge' AND events.status = 'posted'
            AND events.source_occurred_at >= windows.start_inclusive AND events.source_occurred_at < windows.end_exclusive
            AND (events.source_occurred_at AT TIME ZONE windows.time_zone)::date BETWEEN $1::date AND $2::date
            AND (COALESCE((to_jsonb(allocations)->>'payment_fee_minor')::bigint,
                          (to_jsonb(deltas)->>'payment_fee_delta_minor')::bigint, 0) <> 0
              OR COALESCE((to_jsonb(allocations)->>'payment_fee_vat_minor')::bigint,
                          (to_jsonb(deltas)->>'payment_fee_vat_delta_minor')::bigint, 0) <> 0)
        ) AS incompatible_fee_collection,
        COUNT(*) FILTER (WHERE commercial_state = 'active')::int AS count,
        COALESCE(SUM(total_minor) FILTER (WHERE commercial_state = 'active'), 0)::numeric AS revenue,
        COALESCE(SUM(
          merchandise_net_minor + CASE WHEN tax_mode = 'exclusive' THEN merchandise_vat_minor ELSE 0 END
        ) FILTER (WHERE commercial_state = 'active'), 0)::numeric AS merchandise_revenue,
        COALESCE(SUM(
          merchandise_net_minor - CASE WHEN tax_mode = 'inclusive' THEN merchandise_vat_minor ELSE 0 END
        ) FILTER (WHERE commercial_state = 'active'), 0)::numeric AS merchandise_revenue_ex_vat,
        COALESCE(SUM(
          shipping_minor + CASE WHEN tax_mode = 'exclusive' THEN shipping_vat_minor ELSE 0 END
        ) FILTER (WHERE commercial_state = 'active'), 0)::numeric AS shipping_revenue,
        COUNT(*) FILTER (
          WHERE commercial_state = 'active'
            AND shipping_minor + CASE WHEN tax_mode = 'exclusive' THEN shipping_vat_minor ELSE 0 END > 0
        )::int AS shipping_order_count,
        COALESCE(SUM(discount_minor) FILTER (WHERE commercial_state = 'active'), 0)::numeric AS discount,
        COALESCE(SUM(vat_minor) FILTER (WHERE commercial_state = 'active'), 0)::numeric AS tax
      FROM effective_orders
    `, commonParams);
    if (Number(orders.rows[0]?.incompatible_fee_order_count || 0) > 0 || orders.rows[0]?.incompatible_fee_collection === true) {
      throw new PlatformError("unsupported_contract", "Update the client to read a dashboard with payment surcharges", 409);
    }
    const cancelledOrders = await client.query(`${cte}
      SELECT COUNT(*)::int AS count
      FROM effective_orders
      WHERE commercial_state = 'cancelled'
    `, commonParams);
    // Products, customers, and inventory are tenant-owned. The dashboard
    // counts the active merchant's catalog and customers. For products, the
    // strict equality (no NULL-leak fallback) is the same rule used by
    // listAdminProducts.
    const products = await client.query(
      "SELECT COUNT(*)::int AS count FROM public.product WHERE deleted_at IS NULL AND status = 'published' AND merchant_id = $1",
      [scope.merchantId],
    );
    const lowStock = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM public.inventory_level il
      JOIN public.product_variant_inventory_item vii ON vii.inventory_item_id = il.inventory_item_id AND vii.deleted_at IS NULL
      JOIN public.product_variant v ON v.id = vii.variant_id AND v.deleted_at IS NULL
      JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL AND p.merchant_id = $1
      JOIN app.stores s ON s.stock_location_id = il.location_id
        AND s.merchant_id = $1
        AND s.id = ANY($2::text[])
      LEFT JOIN inventory.product_settings ps ON ps.variant_id = vii.variant_id
      WHERE il.deleted_at IS NULL AND il.stocked_quantity <= COALESCE(ps.reorder_level, 5)
    `, [scope.merchantId, scope.storeIds]);

    const daily = await client.query(`${cte}, days AS (
        SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day
      ),
      order_daily AS (
        SELECT
          business_date AS day,
          COUNT(*)::int AS orders,
          COALESCE(SUM(total_minor), 0)::numeric AS revenue,
          COALESCE(SUM(
            shipping_minor + CASE WHEN tax_mode = 'exclusive' THEN shipping_vat_minor ELSE 0 END
          ), 0)::numeric AS shipping_revenue
        FROM effective_orders
        WHERE commercial_state = 'active'
        GROUP BY business_date
      )
      SELECT
        days.day::text AS date,
        COALESCE(order_daily.orders, 0)::int AS orders,
        COALESCE(order_daily.revenue, 0)::numeric AS revenue,
        COALESCE(order_daily.shipping_revenue, 0)::numeric AS "shippingRevenue"
      FROM days
      LEFT JOIN order_daily ON order_daily.day = days.day
      ORDER BY days.day
    `, commonParams);

    const itemSummary = await client.query(`${cte}
      SELECT
        COALESCE(SUM(lines.quantity), 0)::numeric AS item_quantity,
        CASE WHEN COUNT(*) FILTER (WHERE lines.cost_minor IS NULL) = 0
          THEN COALESCE(SUM(lines.cost_minor * lines.quantity), 0)::numeric
          ELSE NULL
        END AS cogs
      FROM effective_orders effective
      JOIN app.order_commercial_revision_lines lines
        ON lines.revision_id = effective.revision_id
      WHERE effective.commercial_state = 'active'
    `, commonParams);

    const topProducts = await client.query(`${cte}
      SELECT
        COALESCE(lines.product_id, '') AS "productId",
        lines.title_snapshot AS name,
        COALESCE(SUM(lines.quantity), 0)::numeric AS quantity,
        COALESCE(SUM(lines.line_total_minor), 0)::numeric AS revenue
      FROM effective_orders effective
      JOIN app.order_commercial_revision_lines lines
        ON lines.revision_id = effective.revision_id
      WHERE effective.commercial_state = 'active'
      GROUP BY lines.product_id, lines.variant_id, lines.title_snapshot
      ORDER BY revenue DESC, quantity DESC
      LIMIT 5
    `, commonParams);

    const paymentMix = await client.query(`
      WITH store_windows AS (
        SELECT
        requested.store_id,
          requested.time_zone,
          requested.start_inclusive::timestamptz AS start_inclusive,
          requested.end_exclusive::timestamptz AS end_exclusive
        FROM jsonb_to_recordset($3::jsonb) AS requested(
          store_id text,
          time_zone text,
          start_inclusive text,
          end_exclusive text
        )
      )
      SELECT
        events.method,
        COUNT(DISTINCT events.order_id)::int AS orders,
        COALESCE(SUM(events.amount_minor), 0)::numeric AS revenue
      FROM app.payment_events events
      JOIN store_windows windows ON windows.store_id = events.store_id
      WHERE events.merchant_id = $4
        AND events.kind = 'charge'
        AND events.status = 'posted'
        AND events.source_occurred_at >= windows.start_inclusive
        AND events.source_occurred_at < windows.end_exclusive
        AND (events.source_occurred_at AT TIME ZONE windows.time_zone)::date BETWEEN $1::date AND $2::date
        AND (
          SELECT COUNT(*)
          FROM app.payment_event_evidence evidence
          WHERE evidence.payment_event_id = events.id
            AND evidence.verification_status = 'verified'
            AND evidence.evidence_type = events.evidence_type
            AND evidence.evidence_fingerprint = events.evidence_fingerprint
        ) = 1
        AND (
          SELECT COALESCE(SUM(allocations.amount_minor), 0)
          FROM app.payment_event_allocations allocations
          WHERE allocations.payment_event_id = events.id
            AND allocations.allocation_kind = 'collection'
        ) = events.amount_minor
      GROUP BY events.method
      ORDER BY revenue DESC
    `, commonParams);

    const orderCount = Number(orders.rows[0]?.count || 0);
    const totalRevenue = Number(orders.rows[0]?.revenue || 0);
    const shippingRevenue = Number(orders.rows[0]?.shipping_revenue || 0);
    const merchandiseRevenue = Number(orders.rows[0]?.merchandise_revenue || Math.max(0, totalRevenue - shippingRevenue));
    const merchandiseRevenueExVat = Number(orders.rows[0]?.merchandise_revenue_ex_vat || 0);
    const shippingOrderCount = Number(orders.rows[0]?.shipping_order_count || 0);
    const cogsValue = itemSummary.rows[0]?.cogs;
    const cogs = cogsValue == null ? null : Number(cogsValue);
    const grossProfit = cogs === null ? null : merchandiseRevenueExVat - cogs;
    const result = {
      data: {
        from,
        to,
        orderCount,
        totalRevenue,
        merchandiseRevenue,
        merchandiseRevenueExVat,
        shippingRevenue,
        shippingOrderCount,
        averageShippingFee: shippingOrderCount ? Math.round(shippingRevenue / shippingOrderCount) : 0,
        shippingSharePercent: totalRevenue ? Number(((shippingRevenue / totalRevenue) * 100).toFixed(1)) : 0,
        discountTotal: Number(orders.rows[0]?.discount || 0),
        taxTotal: Number(orders.rows[0]?.tax || 0),
        // Customer rows do not carry store attribution. A multi-store local-day
        // count would be an estimate, so expose unavailable until the product
        // owns an explicit merchant customer-business-date contract.
        customersToday: null,
        newCustomers: null,
        products: Number(products.rows[0]?.count || 0),
        lowStock: Number(lowStock.rows[0]?.count || 0),
        canceledOrders: Number(cancelledOrders.rows[0]?.count || 0),
        itemQuantity: Number(itemSummary.rows[0]?.item_quantity || 0),
        averageOrderValue: orderCount ? Math.round(totalRevenue / orderCount) : 0,
        cogs,
        grossProfit,
        grossMarginPercent: grossProfit === null || !merchandiseRevenueExVat
          ? null
          : Number(((grossProfit / merchandiseRevenueExVat) * 100).toFixed(1)),
        daily: daily.rows.map((row) => ({
          date: String(row.date),
          orders: Number(row.orders || 0),
          revenue: Number(row.revenue || 0),
          shippingRevenue: Number(row.shippingRevenue || 0),
        })),
        topProducts: topProducts.rows.map((row) => ({
          productId: String(row.productId || ""),
          name: String(row.name || "Unknown product"),
          quantity: Number(row.quantity || 0),
          revenue: Number(row.revenue || 0),
        })),
        paymentMix: paymentMix.rows.map((row) => ({
          method: String(row.method || "unknown"),
          orders: Number(row.orders || 0),
          revenue: Number(row.revenue || 0),
        })),
      },
    };
    await client.query("COMMIT");
    return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}
