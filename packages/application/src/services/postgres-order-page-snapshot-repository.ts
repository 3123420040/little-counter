import {
  EffectiveOrderCsvPaymentSummaryV3Schema,
  EffectiveOrderPageCurrencyAggregateV2Schema,
  EffectiveOrderPageCurrencyAggregateV5Schema,
  type EffectiveOrderPageCurrencyAggregateV5,
  OrderCursorFiltersV1Schema,
  OrderCursorScopeV1Schema,
  type OrderCollectionRevisionVectorV1,
  type OrderCursorFiltersV1,
  type OrderCursorScopeV1,
} from "@medusa-snus/contracts";
import type { EffectiveOrderCsvSnapshotTransactionV5, EffectiveOrderCsvSnapshotRepositoryV5 } from "./effective-order-csv-v4-snapshot-export-service";
import type { DashboardStoreStatusPolicy } from "./dashboard-report-foundation";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import {
  readEffectiveOrderCsvProjectionsV5,
  readEffectiveOrdersV1,
  readEffectiveOrdersV2,
  type EffectiveOrderProjectionBatchRequest,
} from "./effective-order-projection-service";
import type {
  EffectiveOrderPageAggregateRequestV2,
  EffectiveOrderPagePaymentRequestV2,
  EffectiveOrderPagePaymentSummaryV2,
  EffectiveOrderPageSnapshotRepositoryV2,
  EffectiveOrderPageSnapshotTransactionV2,
  EffectiveOrderPageSnapshotTransactionV5,
  EffectiveOrderPageSnapshotRepositoryV5,
  EffectiveOrderPageAggregateReadV4,
} from "./effective-order-page-service";
import type {
  EffectiveOrderCsvSnapshotRepositoryV3,
  EffectiveOrderCsvSnapshotTransactionV3,
} from "./effective-order-csv-snapshot-export-service";
import type {
  OrderPageCountRequestV1,
  OrderPageIdentityRowV1,
  OrderPageRowsRequestV1,
  OrderPageSnapshotRepositoryV1,
  OrderPageSnapshotTransactionV1,
} from "./order-page-snapshot-service";

export const ORDER_PAGE_SNAPSHOT_TIMEOUT_HARD_CAP_MS = 30_000;

type RevisionRow = {
  requested_store_id: unknown;
  owned_store_id: unknown;
  revision: unknown;
};

type IdentityRow = {
  merchant_id: unknown;
  store_id: unknown;
  order_id: unknown;
  order_number: unknown;
  order_status: unknown;
  currency_code: unknown;
  created_at: unknown;
  customer_id: unknown;
  customer_first_name: unknown;
  customer_last_name: unknown;
  customer_phone: unknown;
  customer_attribution: unknown;
};

function validTimeout(value: number): number {
  if (
    !Number.isInteger(value)
    || value < 1
    || value > ORDER_PAGE_SNAPSHOT_TIMEOUT_HARD_CAP_MS
  ) {
    throw new Error(
      `order page statement timeout must be between 1 and ${ORDER_PAGE_SNAPSHOT_TIMEOUT_HARD_CAP_MS}`,
    );
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`invalid ${field}`);
  return value;
}

function isoInstant(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(requiredString(value, field));
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid ${field}`);
  return date.toISOString();
}

function safeNonnegativeInteger(value: unknown, field: string): number {
  let parsed: number;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "bigint") parsed = Number(value);
  else if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) parsed = Number(value);
  else throw new Error(`invalid ${field}`);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid ${field}`);
  return parsed;
}

function normalizedRequest(
  scopeInput: OrderCursorScopeV1,
  filtersInput: OrderCursorFiltersV1,
): { scope: OrderCursorScopeV1; filters: OrderCursorFiltersV1 } {
  return {
    scope: OrderCursorScopeV1Schema.parse(scopeInput),
    filters: OrderCursorFiltersV1Schema.parse(filtersInput),
  };
}

function baseParams(scope: OrderCursorScopeV1, filters: OrderCursorFiltersV1): unknown[] {
  const creatorSelection = filters.creatorSelection || {
    mode: "all" as const,
    creatorOperatorIds: [] as string[],
  };
  return [
    scope.merchantId,
    scope.storeIds,
    JSON.stringify(filters.storeWindows.map((window) => ({
      store_id: window.storeId,
      start_inclusive: window.startInclusive,
      end_exclusive: window.endExclusive,
    }))),
    filters.search || null,
    filters.statusMode,
    filters.searchMode,
    creatorSelection.mode,
    creatorSelection.creatorOperatorIds,
  ];
}

function filteredOrderCte(indexedCreatorLookup = false): string {
  return `
  requested_windows AS (
    SELECT requested_window.store_id, requested_window.start_inclusive, requested_window.end_exclusive
    FROM jsonb_to_recordset($3::jsonb) AS requested_window(
      store_id text,
      start_inclusive timestamptz,
      end_exclusive timestamptz
    )
  ), selected_creator_orders AS MATERIALIZED (
    SELECT creator_event.subject_id AS order_id
    FROM audit.events creator_event
    JOIN public."order" creator_order ON creator_order.id = creator_event.subject_id
    JOIN requested_windows creator_window ON creator_window.store_id = creator_order.store_id
    WHERE $7::text = 'selected'
      AND creator_order.merchant_id = $1
      AND creator_order.store_id = ANY($2::text[])
      AND creator_order.deleted_at IS NULL
      AND creator_order.created_at >= creator_window.start_inclusive
      AND creator_order.created_at < creator_window.end_exclusive
      AND creator_event.subject_type = 'order'
      AND creator_event.action IN ('order.created', 'order.remote_created', 'order.partner_created')
    GROUP BY creator_event.subject_id, creator_order.store_id
    /* Count every creation event before checking actor/scope, including conflicts. */
    HAVING COUNT(*) = 1
       AND MAX(creator_event.actor_type) IN ('staff', 'manager', 'owner', 'accountant')
       AND MAX(creator_event.merchant_id) = $1
       AND MAX(creator_event.store_id) = creator_order.store_id
       AND MAX(creator_event.actor_id) = ANY($8::text[])
  ), filtered_orders AS (
    SELECT
      o.merchant_id,
      o.store_id,
      o.id AS order_id,
      COALESCE(o.custom_display_id, 'ORD-' || o.display_id::text) AS order_number,
      o.status::text AS order_status,
      o.currency_code,
      o.created_at,
      c.id AS customer_id,
      c.first_name AS customer_first_name,
      c.last_name AS customer_last_name,
      c.phone AS customer_phone
      ,CASE
        WHEN c.id IS NOT NULL THEN 'linked'
        WHEN o.metadata->>'customerAttributionMode' = 'walk_in' THEN 'walk_in'
        ELSE 'unknown'
      END AS customer_attribution
    FROM public."order" o
    JOIN requested_windows requested_window ON requested_window.store_id = o.store_id
    LEFT JOIN public.customer c
      ON c.id = o.customer_id
     AND c.merchant_id = o.merchant_id
     AND c.deleted_at IS NULL
    WHERE o.deleted_at IS NULL
      AND o.merchant_id = $1
      AND o.store_id = ANY($2::text[])
      AND o.created_at >= requested_window.start_inclusive
      AND o.created_at < requested_window.end_exclusive
      AND (
        COALESCE($4::text, '') = ''
        OR POSITION($4 IN LOWER(o.id)) > 0
        OR POSITION($4 IN LOWER(COALESCE(o.custom_display_id, 'ORD-' || o.display_id::text))) > 0
        OR (
          $6::text = 'order_or_customer_identity'
          AND (
            POSITION($4 IN LOWER(COALESCE(c.id, ''))) > 0
            OR POSITION($4 IN LOWER(COALESCE(c.phone, ''))) > 0
            OR POSITION($4 IN LOWER(CONCAT_WS(' ', c.last_name, c.first_name))) > 0
            OR POSITION($4 IN LOWER(CONCAT_WS(' ', c.first_name, c.last_name))) > 0
          )
        )
      )
      AND (
        $5::text = 'all'
        OR ($5::text = 'completed' AND o.status::text = 'completed')
        OR ($5::text = 'other' AND o.status::text <> 'completed')
      )
      AND (
        $7::text = 'all'
        OR ${indexedCreatorLookup ? `EXISTS (
          SELECT 1 FROM audit.events creator_event
          WHERE creator_event.subject_type = 'order'
            AND creator_event.subject_id = o.id
            AND creator_event.action IN ('order.created', 'order.remote_created', 'order.partner_created')
          GROUP BY creator_event.subject_id
          HAVING COUNT(*) = 1
             AND MAX(creator_event.actor_type) IN ('staff', 'manager', 'owner', 'accountant')
             AND MAX(creator_event.merchant_id) = o.merchant_id
             AND MAX(creator_event.store_id) = o.store_id
             AND MAX(creator_event.actor_id) = ANY($8::text[])
        )` : 'o.id IN (SELECT order_id FROM selected_creator_orders)'}
      )
  )
`;
}

class PostgresOrderPageSnapshotTransactionV1
  implements
    OrderPageSnapshotTransactionV1,
    EffectiveOrderPageSnapshotTransactionV5,
    EffectiveOrderCsvSnapshotTransactionV3, EffectiveOrderCsvSnapshotTransactionV5 {
  constructor(private readonly client: PoolClient, private readonly storeStatusPolicy: DashboardStoreStatusPolicy) {}

  async readAsOf(): Promise<string> {
    const result = await this.client.query<{ order_page_as_of: unknown }>(`
      SELECT transaction_timestamp() AS order_page_as_of
    `);
    return isoInstant(result.rows[0]?.order_page_as_of, "order_page_as_of");
  }

  async readStoreRevisionVector(
    scopeInput: OrderCursorScopeV1,
  ): Promise<OrderCollectionRevisionVectorV1> {
    const scope = OrderCursorScopeV1Schema.parse(scopeInput);
    const result = await this.client.query<RevisionRow>(`
      /* order_page_revision_vector */
      WITH requested AS (
        SELECT requested.store_id
        FROM unnest($2::text[]) AS requested(store_id)
      )
      SELECT
        requested.store_id AS requested_store_id,
        owned.id AS owned_store_id,
        vector.revision
      FROM requested
      LEFT JOIN app.stores owned
        ON owned.merchant_id = $1
       AND owned.id = requested.store_id
       AND (owned.status = 'active' OR ($3::boolean AND owned.status = 'suspended'))
      LEFT JOIN app.order_collection_revision_vector vector
        ON vector.merchant_id = $1
       AND vector.store_id = owned.id
      ORDER BY requested.store_id
    `, [scope.merchantId, scope.storeIds, this.storeStatusPolicy === "active_or_suspended"]);
    if (result.rows.length !== scope.storeIds.length) {
      throw new Error("order page revision vector is incomplete");
    }
    return result.rows.map((row, index) => {
      const requestedStoreId = requiredString(row.requested_store_id, "requested_store_id");
      const ownedStoreId = requiredString(row.owned_store_id, "owned_store_id");
      if (requestedStoreId !== scope.storeIds[index] || ownedStoreId !== requestedStoreId) {
        throw new Error("order page revision vector scope mismatch");
      }
      return {
        storeId: requestedStoreId,
        revision: safeNonnegativeInteger(row.revision, "revision"),
      };
    });
  }

  async readRows(input: OrderPageRowsRequestV1): Promise<OrderPageIdentityRowV1[]> {
    const { scope, filters } = normalizedRequest(input.scope, input.filters);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 201) {
      throw new Error("order page repository limit must be between 1 and 201");
    }
    const result = await this.client.query<IdentityRow>(`
      /* order_page_identity_rows */
      /* Keyset pages probe the provenance index only for visited rows. */
      WITH ${filteredOrderCte(true)}
      SELECT
        merchant_id,
        store_id,
        order_id,
        order_number,
        order_status,
        currency_code,
        created_at,
        customer_id,
        customer_first_name,
        customer_last_name,
        customer_phone
        ,customer_attribution
      FROM filtered_orders o
      WHERE (
        $9::timestamptz IS NULL
        OR o.created_at < $9::timestamptz
        OR (o.created_at = $9::timestamptz AND o.order_id <= $10::text)
      )
        AND (
          $11::timestamptz IS NULL
          OR o.created_at < $11::timestamptz
          OR (o.created_at = $11::timestamptz AND o.order_id < $12::text)
        )
      ORDER BY o.created_at DESC, o.order_id DESC
      LIMIT $13
    `, [
      ...baseParams(scope, filters),
      input.highWatermark?.createdAt || null,
      input.highWatermark?.id || null,
      input.after?.createdAt || null,
      input.after?.id || null,
      input.limit,
    ]);
    return result.rows.map((row) => ({
      merchantId: requiredString(row.merchant_id, "merchant_id"),
      storeId: requiredString(row.store_id, "store_id"),
      orderId: requiredString(row.order_id, "order_id"),
      orderNumber: requiredString(row.order_number, "order_number"),
      status: requiredString(row.order_status, "order_status").toLowerCase(),
      currencyCode: requiredString(row.currency_code, "currency_code").toUpperCase(),
      createdAt: isoInstant(row.created_at, "created_at"),
      customer: row.customer_id ? {
        id: requiredString(row.customer_id, "customer_id"),
        firstName: row.customer_first_name === null ? null : String(row.customer_first_name),
        lastName: row.customer_last_name === null ? null : String(row.customer_last_name),
        phone: row.customer_phone === null ? null : String(row.customer_phone),
      } : null,
      customerAttribution: requiredString(row.customer_attribution, "customer_attribution") as "linked" | "walk_in" | "unknown",
    }));
  }

  async countRows(input: OrderPageCountRequestV1): Promise<number> {
    const { scope, filters } = normalizedRequest(input.scope, input.filters);
    const result = await this.client.query<{ total_count: unknown }>(`
      /* order_page_total_count */
      WITH ${filteredOrderCte()}
      SELECT COUNT(*)::text AS total_count
      FROM filtered_orders
    `, baseParams(scope, filters));
    return safeNonnegativeInteger(result.rows[0]?.total_count, "total_count");
  }

  async readFeeAwareCsvOrders(input: EffectiveOrderProjectionBatchRequest) {
    return readEffectiveOrderCsvProjectionsV5(this.client, input);
  }

  async readEffectiveOrders(input: EffectiveOrderProjectionBatchRequest) {
    return readEffectiveOrdersV1(this.client, input);
  }

  async readFeeAwareEffectiveOrders(input: EffectiveOrderProjectionBatchRequest) {
    return readEffectiveOrdersV2(this.client, input);
  }

  async readPaymentSummaries(
    input: EffectiveOrderPagePaymentRequestV2,
  ): Promise<EffectiveOrderPagePaymentSummaryV2[]> {
    const scope = OrderCursorScopeV1Schema.parse(input.scope);
    const orderIds = input.orderIds.map((orderId) => requiredString(orderId, "order_id"));
    if (orderIds.length === 0 || orderIds.length > 200 || new Set(orderIds).size !== orderIds.length) {
      throw new Error("effective page payment order IDs must be unique and between 1 and 200");
    }
    const asOf = isoInstant(input.asOf, "payment_as_of");
    const result = await this.client.query<Record<string, unknown>>(`
      /* effective_order_page_payment_summaries */
      WITH requested AS (
        SELECT requested.order_id, requested.ordinality
        FROM unnest($3::text[]) WITH ORDINALITY AS requested(order_id, ordinality)
      ), scoped_orders AS (
        SELECT
          requested.order_id AS requested_order_id,
          requested.ordinality,
          o.id AS owned_order_id,
          UPPER(o.currency_code) AS currency_code
        FROM requested
        LEFT JOIN public."order" o
          ON o.id = requested.order_id
         AND o.merchant_id = $1
         AND o.store_id = ANY($2::text[])
         AND o.deleted_at IS NULL
      )
      SELECT
        scoped.requested_order_id,
        scoped.owned_order_id,
        scoped.currency_code,
        COUNT(events.id) FILTER (
          WHERE events.currency_code <> scoped.currency_code
        )::text AS currency_mismatch_count,
        (
          SELECT COUNT(*)::text
          FROM app.customer_refund_payable_events payable_event
          WHERE payable_event.merchant_id = $1
            AND payable_event.store_id = ANY($2::text[])
            AND payable_event.order_id = scoped.owned_order_id
            AND payable_event.source_occurred_at <= $4::timestamptz
            AND payable_event.currency_code <> scoped.currency_code
        ) AS payable_currency_mismatch_count,
        COALESCE(SUM(events.amount_minor) FILTER (
          WHERE events.kind = 'charge'
            AND events.currency_code = scoped.currency_code
        ), 0)::text AS recorded_gross_collections_minor,
        COALESCE(SUM(events.amount_minor) FILTER (
          WHERE events.kind = 'refund'
            AND events.currency_code = scoped.currency_code
        ), 0)::text AS refunds_minor,
        COALESCE(SUM(events.amount_minor) FILTER (
          WHERE events.kind = 'reversal'
            AND events.currency_code = scoped.currency_code
        ), 0)::text AS reversals_minor,
        COALESCE(SUM(events.amount_minor) FILTER (
          WHERE events.kind = 'chargeback'
            AND events.currency_code = scoped.currency_code
        ), 0)::text AS chargebacks_minor,
        COALESCE((
          SELECT SUM(
            CASE payable_event.event_kind
              WHEN 'open' THEN payable_event.amount_minor
              WHEN 'clear' THEN -payable_event.amount_minor
            END
          )
          FROM app.customer_refund_payable_events payable_event
          WHERE payable_event.merchant_id = $1
            AND payable_event.store_id = ANY($2::text[])
            AND payable_event.order_id = scoped.owned_order_id
            AND payable_event.source_occurred_at <= $4::timestamptz
            AND payable_event.currency_code = scoped.currency_code
        ), 0)::text AS customer_refund_payable_minor
        ,COALESCE(
          NULLIF(
            ARRAY_AGG(DISTINCT LOWER(events.method) ORDER BY LOWER(events.method))
              FILTER (WHERE events.kind = 'charge' AND events.method IS NOT NULL),
            ARRAY[]::text[]
          ),
          (
            SELECT ARRAY_AGG(DISTINCT evidence.method ORDER BY evidence.method)
            FROM (
              SELECT CASE LOWER(BTRIM(entry.method))
                WHEN 'cash' THEN 'cash' WHEN 'cod' THEN 'cod'
                WHEN 'bank_transfer' THEN 'manual_bank' WHEN 'manual_bank' THEN 'manual_bank'
                WHEN 'provider' THEN 'provider' WHEN 'mock' THEN 'provider'
                WHEN 'sepay_va' THEN 'provider' WHEN 'nowpayments' THEN 'provider'
                WHEN 'crypto_usdc' THEN 'provider' WHEN 'crypto_usdt' THEN 'provider'
                ELSE 'unknown' END AS method
              FROM app.payment_entries entry
              WHERE entry.order_id = scoped.owned_order_id
                AND entry.merchant_id = $1 AND entry.store_id = ANY($2::text[])
                AND UPPER(entry.currency_code) = scoped.currency_code
                AND entry.created_at <= $4::timestamptz
                AND entry.direction = 'charge' AND entry.status IN ('pending', 'posted')
            ) evidence
          ),
          (
            SELECT ARRAY['provider']::text[]
            FROM app.payment_intents intent
            WHERE intent.completed_order_id = scoped.owned_order_id
              AND intent.merchant_id = $1
              AND intent.store_id = ANY($2::text[])
              AND UPPER(intent.currency_code) = scoped.currency_code
              AND intent.created_at <= $4::timestamptz
              AND intent.status IN ('pending', 'paid', 'completed', 'manual_review')
            ORDER BY intent.created_at DESC
            LIMIT 1
          ),
          ARRAY['unknown']::text[]
        ) AS payment_methods
      FROM scoped_orders scoped
      LEFT JOIN app.payment_events events
        ON events.merchant_id = $1
       AND events.store_id = ANY($2::text[])
       AND events.order_id = scoped.owned_order_id
       AND events.status = 'posted'
       AND events.source_occurred_at <= $4::timestamptz
      GROUP BY
        scoped.ordinality,
        scoped.requested_order_id,
        scoped.owned_order_id,
        scoped.currency_code
      ORDER BY scoped.ordinality
    `, [scope.merchantId, scope.storeIds, orderIds, asOf]);
    if (result.rows.length !== orderIds.length) {
      throw new Error("effective page payment summary coverage is incomplete");
    }
    return result.rows.map((row, index) => {
      const orderId = requiredString(row.requested_order_id, "requested_order_id");
      if (orderId !== orderIds[index] || row.owned_order_id !== orderId) {
        throw new Error("effective page payment order scope mismatch");
      }
      if (safeNonnegativeInteger(row.currency_mismatch_count, "currency_mismatch_count") !== 0) {
        throw new Error("effective page payment currency mismatch");
      }
      if (
        safeNonnegativeInteger(
          row.payable_currency_mismatch_count,
          "payable_currency_mismatch_count",
        ) !== 0
      ) {
        throw new Error("effective page customer refund payable currency mismatch");
      }
      const recordedGrossCollectionsMinor = safeNonnegativeInteger(
        row.recorded_gross_collections_minor,
        "recorded_gross_collections_minor",
      );
      const refundsMinor = safeNonnegativeInteger(row.refunds_minor, "refunds_minor");
      const reversalsMinor = safeNonnegativeInteger(row.reversals_minor, "reversals_minor");
      const chargebacksMinor = safeNonnegativeInteger(row.chargebacks_minor, "chargebacks_minor");
      const customerRefundPayableMinor = safeNonnegativeInteger(
        row.customer_refund_payable_minor,
        "customer_refund_payable_minor",
      );
      const negativeCollectionsMinor = refundsMinor + reversalsMinor + chargebacksMinor;
      if (!Number.isSafeInteger(negativeCollectionsMinor)) {
        throw new Error("effective page payment negatives exceed safe integer");
      }
      return {
        orderId,
        ...EffectiveOrderCsvPaymentSummaryV3Schema.parse({
          currencyCode: requiredString(row.currency_code, "currency_code"),
          recordedGrossCollectionsMinor,
          refundsMinor,
          reversalsMinor,
          chargebacksMinor,
          negativeCollectionsMinor,
          netCollectionsMinor: recordedGrossCollectionsMinor - negativeCollectionsMinor,
        }),
        customerRefundPayableMinor,
        paymentMethods: Array.isArray(row.payment_methods)
          ? [...new Set(row.payment_methods.map((value) => requiredString(value, "payment_method").toLowerCase()))].sort()
          : ["unknown"],
      };
    });
  }

  async readCurrencyAggregates(input: EffectiveOrderPageAggregateRequestV2) {
    return this.readCurrencyAggregateVersion(input, false);
  }
  async readFeeAwareCurrencyAggregates(input: EffectiveOrderPageAggregateRequestV2) {
    return this.readCurrencyAggregateVersion(input, true);
  }
  private readCurrencyAggregateVersion(input: EffectiveOrderPageAggregateRequestV2, feeAware: false): Promise<EffectiveOrderPageAggregateReadV4[]>;
  private readCurrencyAggregateVersion(input: EffectiveOrderPageAggregateRequestV2, feeAware: true): Promise<EffectiveOrderPageCurrencyAggregateV5[]>;
  private async readCurrencyAggregateVersion(input: EffectiveOrderPageAggregateRequestV2, feeAware: boolean): Promise<Array<EffectiveOrderPageAggregateReadV4 | EffectiveOrderPageCurrencyAggregateV5>> {
    const { scope, filters } = normalizedRequest(input.scope, input.filters);
    const asOf = isoInstant(input.asOf, "aggregate_as_of");
    const result = await this.client.query<Record<string, unknown>>(`
      /* effective_order_page_currency_aggregates */
      WITH ${filteredOrderCte()}, scoped_revisions AS MATERIALIZED (
        SELECT revision.id, revision.merchant_id, revision.store_id, revision.order_id,
          revision.revision, revision.commercial_state, revision.currency_code,
          revision.minor_unit_exponent, revision.effective_at, components.total_minor, components.tax_mode,
          COALESCE((to_jsonb(components)->>'payment_fee_minor')::bigint, 0) AS payment_fee_minor,
          COALESCE((to_jsonb(components)->>'payment_fee_vat_minor')::bigint, 0) AS payment_fee_vat_minor
        FROM app.order_commercial_revisions revision
        LEFT JOIN app.order_commercial_revision_components components
          ON components.revision_id = revision.id
        WHERE revision.merchant_id = $1 AND revision.store_id = ANY($2::text[])
          AND revision.effective_at <= $9::timestamptz
          AND revision.order_id IN (SELECT order_id FROM filtered_orders)
      ), canonical_orders AS (
        SELECT DISTINCT ON (filtered.order_id)
          filtered.*,
          revisions.id AS revision_id,
          revisions.commercial_state,
          revisions.currency_code AS revision_currency_code,
          revisions.minor_unit_exponent,
          revisions.total_minor,
          revisions.tax_mode,
          revisions.payment_fee_minor,
          revisions.payment_fee_vat_minor,
          lines.effective_item_quantity
        FROM filtered_orders filtered
        LEFT JOIN scoped_revisions revisions
          ON revisions.merchant_id = filtered.merchant_id
         AND revisions.store_id = filtered.store_id
         AND revisions.order_id = filtered.order_id
        LEFT JOIN (
          SELECT line.revision_id, SUM(line.quantity)::text AS effective_item_quantity
          FROM app.order_commercial_revision_lines line
          WHERE line.merchant_id = $1 AND line.store_id = ANY($2::text[])
            AND line.revision_id IN (SELECT id FROM scoped_revisions)
          GROUP BY line.revision_id
        ) lines ON lines.revision_id = revisions.id
        ORDER BY filtered.order_id, revisions.revision DESC,
          revisions.effective_at DESC, revisions.id DESC
      ), payment_by_order AS (
        SELECT
          canonical.order_id,
          COUNT(events.id) FILTER (
            WHERE events.currency_code <> UPPER(canonical.currency_code)
          ) AS currency_mismatch_count,
          COALESCE(SUM(events.amount_minor) FILTER (
            WHERE events.kind = 'charge'
              AND events.currency_code = UPPER(canonical.currency_code)
          ), 0) AS recorded_gross_collections_minor,
          COALESCE(SUM(events.amount_minor) FILTER (
            WHERE events.kind = 'refund'
              AND events.currency_code = UPPER(canonical.currency_code)
          ), 0) AS refunds_minor,
          COALESCE(SUM(events.amount_minor) FILTER (
            WHERE events.kind = 'reversal'
              AND events.currency_code = UPPER(canonical.currency_code)
          ), 0) AS reversals_minor,
          COALESCE(SUM(events.amount_minor) FILTER (
            WHERE events.kind = 'chargeback'
              AND events.currency_code = UPPER(canonical.currency_code)
          ), 0) AS chargebacks_minor
        FROM canonical_orders canonical
        LEFT JOIN app.payment_events events
          ON events.merchant_id = canonical.merchant_id
         AND events.store_id = canonical.store_id
         AND events.order_id = canonical.order_id
         AND events.status = 'posted'
         AND events.source_occurred_at <= $9::timestamptz
        GROUP BY canonical.order_id
      )
      SELECT
        UPPER(canonical.currency_code) AS currency_code,
        canonical.minor_unit_exponent,
        COUNT(*)::text AS order_count,
        COUNT(canonical.revision_id)::text AS revision_count,
        COUNT(canonical.total_minor)::text AS component_count,
        COUNT(*) FILTER (WHERE canonical.payment_fee_minor <> 0 OR canonical.payment_fee_vat_minor <> 0)::text
          AS payment_fee_order_count,
        COUNT(*) FILTER (
          WHERE canonical.revision_currency_code <> UPPER(canonical.currency_code)
        )::text AS revision_currency_mismatch_count,
        COALESCE(SUM(payments.currency_mismatch_count), 0)::text
          AS payment_currency_mismatch_count,
        COUNT(*) FILTER (WHERE canonical.commercial_state = 'active')::text
          AS active_order_count,
        COUNT(*) FILTER (WHERE canonical.commercial_state = 'cancelled')::text
          AS cancelled_order_count,
        COALESCE(SUM(CASE
          WHEN canonical.commercial_state = 'active' THEN canonical.total_minor
          WHEN canonical.commercial_state = 'cancelled' THEN 0
          ELSE 0
        END), 0)::text AS current_order_gross_value_minor,
        COALESCE(SUM(CASE
          WHEN canonical.commercial_state = 'active'
            THEN COALESCE(canonical.effective_item_quantity::bigint, 0)
          ELSE 0
        END), 0)::text AS effective_item_quantity,
        COALESCE(SUM(CASE WHEN canonical.commercial_state = 'active' THEN canonical.payment_fee_minor ELSE 0 END), 0)::text AS payment_fee_minor,
        COALESCE(SUM(CASE WHEN canonical.commercial_state = 'active' THEN canonical.payment_fee_vat_minor ELSE 0 END), 0)::text AS payment_fee_vat_minor,
        COALESCE(SUM(CASE WHEN canonical.commercial_state = 'active' THEN canonical.payment_fee_minor
          + CASE WHEN canonical.tax_mode = 'exclusive' THEN canonical.payment_fee_vat_minor ELSE 0 END ELSE 0 END), 0)::text AS payment_fee_customer_total_minor,
        COALESCE(SUM(payments.recorded_gross_collections_minor), 0)::text
          AS recorded_gross_collections_minor,
        COALESCE(SUM(payments.refunds_minor), 0)::text AS refunds_minor,
        COALESCE(SUM(payments.reversals_minor), 0)::text AS reversals_minor,
        COALESCE(SUM(payments.chargebacks_minor), 0)::text AS chargebacks_minor
      FROM canonical_orders canonical
      LEFT JOIN payment_by_order payments ON payments.order_id = canonical.order_id
      GROUP BY UPPER(canonical.currency_code), canonical.minor_unit_exponent
      ORDER BY UPPER(canonical.currency_code)
    `, [...baseParams(scope, filters), asOf]);
    return result.rows.map((row) => {
      const orderCount = safeNonnegativeInteger(row.order_count, "order_count");
      if (!feeAware && safeNonnegativeInteger(row.payment_fee_order_count ?? 0, "payment_fee_order_count") > 0) {
        throw new PlatformError("unsupported_contract", "Update the client to read order aggregates with payment surcharges", 409);
      }
      if (
        safeNonnegativeInteger(row.revision_count, "revision_count") !== orderCount
        || safeNonnegativeInteger(row.component_count, "component_count") !== orderCount
        || safeNonnegativeInteger(
          row.revision_currency_mismatch_count,
          "revision_currency_mismatch_count",
        ) !== 0
        || safeNonnegativeInteger(
          row.payment_currency_mismatch_count,
          "payment_currency_mismatch_count",
        ) !== 0
      ) {
        throw new Error("effective page aggregate canonical coverage/currency mismatch");
      }
      const recordedGrossCollectionsMinor = safeNonnegativeInteger(
        row.recorded_gross_collections_minor,
        "recorded_gross_collections_minor",
      );
      const refundsMinor = safeNonnegativeInteger(row.refunds_minor, "refunds_minor");
      const reversalsMinor = safeNonnegativeInteger(row.reversals_minor, "reversals_minor");
      const chargebacksMinor = safeNonnegativeInteger(row.chargebacks_minor, "chargebacks_minor");
      const negativeCollectionsMinor = refundsMinor + reversalsMinor + chargebacksMinor;
      if (!Number.isSafeInteger(negativeCollectionsMinor)) {
        throw new Error("effective page aggregate negatives exceed safe integer");
      }
      const aggregate = EffectiveOrderPageCurrencyAggregateV2Schema.parse({
        currencyCode: requiredString(row.currency_code, "currency_code"),
        minorUnitExponent: safeNonnegativeInteger(
          row.minor_unit_exponent,
          "minor_unit_exponent",
        ),
        orderCount,
        activeOrderCount: safeNonnegativeInteger(row.active_order_count, "active_order_count"),
        cancelledOrderCount: safeNonnegativeInteger(
          row.cancelled_order_count,
          "cancelled_order_count",
        ),
        currentOrderGrossValueMinor: safeNonnegativeInteger(
          row.current_order_gross_value_minor,
          "current_order_gross_value_minor",
        ),
        recordedGrossCollectionsMinor,
        refundsMinor,
        reversalsMinor,
        chargebacksMinor,
        negativeCollectionsMinor,
        netCollectionsMinor: recordedGrossCollectionsMinor - negativeCollectionsMinor,
      });
      // Kept on the repository result for V4. V2/V3 callers parse through
      // their frozen schema and intentionally ignore this additive field.
      const result = {
        ...aggregate,
        effectiveItemQuantity: safeNonnegativeInteger(
          row.effective_item_quantity,
          "effective_item_quantity",
        ),
      };
      return feeAware ? EffectiveOrderPageCurrencyAggregateV5Schema.parse({ ...result,
        paymentFeeMinor: safeNonnegativeInteger(row.payment_fee_minor, "payment_fee_minor"),
        paymentFeeVatMinor: safeNonnegativeInteger(row.payment_fee_vat_minor, "payment_fee_vat_minor"),
        paymentFeeCustomerTotalMinor: safeNonnegativeInteger(row.payment_fee_customer_total_minor, "payment_fee_customer_total_minor"),
      }) : result;
    });
  }
}

export class PostgresOrderPageSnapshotRepositoryV1
  implements
    OrderPageSnapshotRepositoryV1,
    EffectiveOrderPageSnapshotRepositoryV2,
    EffectiveOrderPageSnapshotRepositoryV5,
    EffectiveOrderCsvSnapshotRepositoryV3, EffectiveOrderCsvSnapshotRepositoryV5 {
  private readonly statementTimeoutMs: number;

  constructor(
    private readonly client: PoolClient,
    statementTimeoutMs: number,
    private readonly storeStatusPolicy: DashboardStoreStatusPolicy = "active",
  ) {
    if (!["active", "active_or_suspended"].includes(storeStatusPolicy)) throw new Error("Invalid order history store read policy");
    this.statementTimeoutMs = validTimeout(statementTimeoutMs);
  }

  async withRepeatableReadSnapshot<T>(
    read: (snapshot: PostgresOrderPageSnapshotTransactionV1) => Promise<T>,
  ): Promise<T> {
    let transactionStarted = false;
    try {
      await this.client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      transactionStarted = true;
      await this.client.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [`${this.statementTimeoutMs}ms`],
      );
      const result = await read(new PostgresOrderPageSnapshotTransactionV1(this.client, this.storeStatusPolicy));
      await this.client.query("COMMIT");
      return result;
    } catch (error) {
      if (transactionStarted) await this.client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}
