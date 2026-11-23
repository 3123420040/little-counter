import {
  CloseShiftSchema,
  CreateShiftCashMovementSchema,
  ForceCloseShiftSchema,
  ReceiveShiftHandoverSchema,
  RecordShiftStockCountSchema,
  ReviewShiftSchema,
  StartShiftSchema,
  type OperatingScope,
  type ReportScope,
  type ShiftAttributionMode,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { withScopedIdempotency } from "../db/idempotency";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import type { HeadersLike } from "../http/headers";
import { recordAuditEntry } from "../repositories/audit-repository";
import { emitExactOutbox } from "../repositories/outbox-repository";
import { id } from "../utils/id";
import type { OperatorContext } from "./auth-service";
import {
  buildExactShiftDiscrepancyAlertEvent,
  buildExactShiftLifecycleEvent,
} from "./exact-outbox-event-builders";

export const SHIFT_OPS = {
  receiveHandover: "shift.receive_handover",
  startShift: "shift.start",
  cashMovement: "shift.cash_movement",
  stockCount: "shift.stock_count",
  closeShift: "shift.close",
  reviewShift: "shift.review",
  forceCloseShift: "shift.force_close",
  updatePolicy: "shift.policy_update",
} as const;

type ShiftRow = Record<string, unknown>;
type ShiftSummary = Record<string, any>;
type ShiftPolicy = Record<string, any>;
type ShiftCashMovement = Record<string, any>;
type ShiftStockCount = Record<string, any>;
type ShiftReport = Record<string, any>;
type CloseShiftInput = unknown;
type CreateShiftCashMovementInput = unknown;
type ForceCloseShiftInput = unknown;
type ReceiveShiftHandoverInput = unknown;
type ReviewShiftInput = unknown;
type StartShiftInput = unknown;

interface SaleShiftAttributionInput {
  shiftId?: string;
  shiftOpenedAt?: string;
  shiftAttribution?: ShiftAttributionMode;
  queuedAt?: string;
}

export interface ShiftListFilters {
  status?: string;
  reviewStatus?: string;
  storeId?: string;
  operatorId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number | string;
  offset?: number | string;
}

export type UpdateShiftPolicyInput = Record<string, unknown>;

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedClient(fn);
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedTransaction(fn);
}

async function withActiveShiftTransaction<T>(scope: OperatingScope, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(async client => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
    return fn(client);
  });
}

async function withActiveReportShiftTransaction<T>(scope: ReportScope, shiftId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(async client => {
    const shift = await getShiftForReportScope(client, shiftId, scope);
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: String(shift.merchant_id), storeId: String(shift.store_id) });
    return fn(client);
  });
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function nullableText(value: unknown): string | null {
  const normalized = text(value);
  return normalized || null;
}

function requireReturned<T>(row: T | null | undefined, message: string): T {
  if (!row) throw new PlatformError("internal_error", message, 500);
  return row;
}

function moneyNumber(value: unknown): number {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.currencyCode === "vnd" && record.amountVnd !== undefined) return Number(record.amountVnd);
  }
  return Number(value ?? 0);
}

function nonNegativeMoney(value: unknown, field: string): number {
  const amount = Math.round(moneyNumber(value));
  if (!Number.isFinite(amount) || amount < 0) {
    throw new PlatformError("validation_error", `${field} must be a non-negative amount`, 400);
  }
  return amount;
}

function positiveMoney(value: unknown, field: string): number {
  const amount = nonNegativeMoney(value, field);
  if (amount <= 0) throw new PlatformError("validation_error", `${field} must be greater than zero`, 400);
  return amount;
}

function parseDate(value: unknown, field: string): string | null {
  const raw = text(value);
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new PlatformError("validation_error", `${field} must be a valid ISO date`, 400);
  return date.toISOString();
}

function durationMs(row: ShiftRow): number | undefined {
  const opened = new Date(String(row.opened_at || "")).getTime();
  if (!Number.isFinite(opened)) return undefined;
  const endValue = row.closed_at || row.force_closed_at || new Date();
  const ended = endValue instanceof Date ? endValue.getTime() : new Date(String(endValue)).getTime();
  if (!Number.isFinite(ended) || ended < opened) return undefined;
  return ended - opened;
}

function rowToShiftSummary(row: ShiftRow): ShiftSummary {
  return {
    id: String(row.id),
    merchantId: String(row.merchant_id),
    storeId: String(row.store_id),
    stockLocationId: String(row.stock_location_id),
    status: row.status as ShiftSummary["status"],
    reviewStatus: row.review_status as ShiftSummary["reviewStatus"],
    zNumber: row.z_number === null || row.z_number === undefined ? null : Number(row.z_number),
    openedBy: String(row.opened_by),
    openedAt: iso(row.opened_at),
    closedBy: row.closed_by ? String(row.closed_by) : null,
    closedAt: row.closed_at ? iso(row.closed_at) : null,
    forceClosedBy: row.force_closed_by ? String(row.force_closed_by) : null,
    forceClosedAt: row.force_closed_at ? iso(row.force_closed_at) : null,
    durationMs: durationMs(row),
    openingCashAmount: Number(row.opening_cash_amount || 0),
    expectedCashAmount: row.expected_cash_amount === null || row.expected_cash_amount === undefined ? null : Number(row.expected_cash_amount),
    blindCashCountAmount: row.blind_cash_count_amount === null || row.blind_cash_count_amount === undefined ? null : Number(row.blind_cash_count_amount),
    cashVarianceAmount: row.cash_variance_amount === null || row.cash_variance_amount === undefined ? null : Number(row.cash_variance_amount),
    outgoingHandoverNote: row.outgoing_handover_note ? String(row.outgoing_handover_note) : null,
  };
}

function rowToPolicy(scope: OperatingScope, row?: ShiftRow | null): ShiftPolicy {
  return {
    id: row?.id ? String(row.id) : undefined,
    merchantId: scope.merchantId,
    storeId: scope.storeId,
    stockLocationId: scope.stockLocationId,
    enabled: row ? row.enabled === true : false,
    enforceShiftOnPos: row ? row.enforce_shift_on_pos === true : false,
    allowOfflineCachedShift: row ? row.allow_offline_cached_shift !== false : true,
    blindCloseCash: row ? row.blind_close_cash !== false : true,
    requireHandoverAck: row ? row.require_handover_ack === true : false,
    quickStockCountRequired: row ? row.quick_stock_count_required === true : false,
    maxOpenDurationMinutes: Number(row?.max_open_duration_minutes || 960),
    staleAfterMinutes: Number(row?.stale_after_minutes || 1080),
    cashDiscrepancyAlertThreshold: Number(row?.cash_discrepancy_alert_threshold || 0),
    stockDiscrepancyAlertThreshold: Number(row?.stock_discrepancy_alert_threshold ?? 1),
    checklist: Array.isArray(row?.checklist) ? row?.checklist.map(String) : [],
  };
}

function rowToCashMovement(row: ShiftRow): ShiftCashMovement {
  return {
    id: String(row.id),
    shiftId: String(row.shift_id),
    merchantId: String(row.merchant_id),
    storeId: String(row.store_id),
    stockLocationId: String(row.stock_location_id),
    type: row.type as ShiftCashMovement["type"],
    amount: Number(row.amount || 0),
    reason: String(row.reason || ""),
    reasonCode: row.reason_code ? String(row.reason_code) : null,
    performedBy: String(row.performed_by),
    occurredAt: iso(row.occurred_at),
  };
}

function rowToStockCount(row: ShiftRow): ShiftStockCount {
  return {
    id: String(row.id),
    shiftId: String(row.shift_id),
    merchantId: String(row.merchant_id),
    storeId: String(row.store_id),
    stockLocationId: String(row.stock_location_id),
    countType: row.count_type as ShiftStockCount["countType"],
    inventoryItemId: String(row.inventory_item_id),
    productId: row.product_id ? String(row.product_id) : null,
    variantId: row.variant_id ? String(row.variant_id) : null,
    skuSnapshot: row.sku_snapshot ? String(row.sku_snapshot) : null,
    productTitleSnapshot: row.product_title_snapshot ? String(row.product_title_snapshot) : null,
    systemQuantity: Number(row.system_quantity || 0),
    countedQuantity: Number(row.counted_quantity || 0),
    discrepancyQuantity: Number(row.discrepancy_quantity || 0),
    reason: row.reason ? String(row.reason) : null,
    countedBy: String(row.counted_by),
    countedAt: iso(row.counted_at),
  };
}

async function getPolicyForClient(client: PoolClient, scope: OperatingScope): Promise<ShiftPolicy> {
  const row = await queryOne<ShiftRow>(client, `
    SELECT *
    FROM app.shift_policies
    WHERE merchant_id = $1
      AND store_id = $2
      AND stock_location_id = $3
    LIMIT 1
  `, [scope.merchantId, scope.storeId, scope.stockLocationId]);
  return rowToPolicy(scope, row);
}

async function getActiveShiftForClient(client: PoolClient, scope: OperatingScope, lock = false): Promise<ShiftRow | null> {
  return queryOne<ShiftRow>(client, `
    SELECT *
    FROM app.work_shifts
    WHERE merchant_id = $1
      AND store_id = $2
      AND stock_location_id = $3
      AND status IN ('open', 'closing')
    ORDER BY opened_at DESC
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
  `, [scope.merchantId, scope.storeId, scope.stockLocationId]);
}

async function getShiftForOperatingScope(
  client: PoolClient,
  shiftId: string,
  scope: OperatingScope,
  options: { lock?: boolean; activeOnly?: boolean } = {},
): Promise<ShiftRow> {
  const row = await queryOne<ShiftRow>(client, `
    SELECT *
    FROM app.work_shifts
    WHERE id = $1
      AND merchant_id = $2
      AND store_id = $3
      AND stock_location_id = $4
      ${options.activeOnly ? "AND status IN ('open', 'closing')" : ""}
    LIMIT 1
    ${options.lock ? "FOR UPDATE" : ""}
  `, [shiftId, scope.merchantId, scope.storeId, scope.stockLocationId]);
  if (!row) throw new PlatformError("resource_not_found", "Shift not found for active scope", 404);
  return row;
}

async function getShiftForReportScope(client: PoolClient, shiftId: string, scope: ReportScope, lock = false): Promise<ShiftRow> {
  const storeIds = scope.storeIds || [];
  const row = await queryOne<ShiftRow>(client, `
    SELECT *
    FROM app.work_shifts
    WHERE id = $1
      AND merchant_id = $2
      AND (cardinality($3::text[]) = 0 OR store_id = ANY($3::text[]))
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
  `, [shiftId, scope.merchantId, storeIds]);
  if (!row) throw new PlatformError("resource_not_found", "Shift not found for report scope", 404);
  return row;
}

async function getShiftForActorReportScope(client: PoolClient, shiftId: string, actor: OperatorContext, scope: ReportScope): Promise<ShiftRow> {
  const storeIds = scope.storeIds || [];
  const row = await queryOne<ShiftRow>(client, `
    SELECT *
    FROM app.work_shifts
    WHERE id = $1
      AND merchant_id = $2
      AND (cardinality($3::text[]) = 0 OR store_id = ANY($3::text[]))
      AND opened_by = $4
    LIMIT 1
  `, [shiftId, scope.merchantId, storeIds, actor.operatorId]);
  if (!row) throw new PlatformError("resource_not_found", "Shift not found for actor scope", 404);
  return row;
}

async function appendShiftEvent(
  client: PoolClient,
  input: {
    shiftId?: string | null;
    scope: { merchantId: string; storeId: string; stockLocationId?: string | null };
    eventType: string;
    actor: OperatorContext;
    reason?: string | null;
    before?: unknown;
    after?: unknown;
    metadata?: Record<string, unknown>;
  },
): Promise<{ eventId: string; sourceOccurredAt: Date | string }> {
  const eventId = id("shiftevt");
  const inserted = requireReturned(await queryOne<{ id: string; created_at: Date | string }>(client, `
    INSERT INTO app.shift_events (
      id, shift_id, merchant_id, store_id, stock_location_id, event_type, actor_id,
      reason, before, after, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)
    RETURNING id, created_at
  `, [
    eventId,
    input.shiftId || null,
    input.scope.merchantId,
    input.scope.storeId,
    input.scope.stockLocationId || null,
    input.eventType,
    input.actor.operatorId,
    input.reason || null,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    JSON.stringify(input.metadata || {}),
  ]), "Shift event insert did not return a row");
  return { eventId: String(inserted.id), sourceOccurredAt: inserted.created_at };
}

function reportWindowEnd(row: ShiftRow): string | null {
  if (row.closed_at) return iso(row.closed_at);
  if (row.force_closed_at) return iso(row.force_closed_at);
  return null;
}

async function buildShiftReportForClient(
  client: PoolClient,
  shiftRow: ShiftRow,
  countedCashAmount?: number,
): Promise<ShiftReport & Record<string, unknown>> {
  const shift = rowToShiftSummary(shiftRow);
  const closedAt = reportWindowEnd(shiftRow);
  const cutoff = await queryOne<{ as_of: Date }>(client, "SELECT transaction_timestamp() AS as_of");
  const end = closedAt || iso(cutoff?.as_of);
  const savedPayload = shiftRow.z_report_payload as { report?: ShiftReport } | null;
  const savedReport = closedAt && savedPayload?.report ? savedPayload.report : null;
  const orders = await client.query<{
    id: string;
    order_number: string;
    created_at: Date;
    attribution: string;
    total: string;
  }>(`
    WITH latest_revision AS (
      SELECT DISTINCT ON (revision.merchant_id, revision.store_id, revision.order_id)
        revision.order_id,
        revision.commercial_state,
        components.total_minor
      FROM app.order_commercial_revisions revision
      JOIN app.order_commercial_revision_components components
        ON components.revision_id = revision.id
      WHERE revision.merchant_id = $2
        AND revision.store_id = $3
        AND revision.effective_at <= $5::timestamptz
        AND revision.recorded_at <= $5::timestamptz
      ORDER BY revision.merchant_id, revision.store_id, revision.order_id,
        revision.revision DESC, revision.recorded_at DESC, revision.id DESC
    )
    SELECT
      o.id::text AS id,
      COALESCE(o.custom_display_id, 'ORD-' || o.display_id::text) AS order_number,
      o.created_at,
      CASE
        WHEN o.metadata->>'shiftId' = $1 THEN COALESCE(o.metadata->>'shiftAttribution', 'online_open_shift')
        ELSE 'legacy_time_window'
      END AS attribution,
      CASE
        WHEN latest_revision.commercial_state = 'cancelled' THEN 0
        ELSE COALESCE(latest_revision.total_minor, 0)
      END::text AS total
    FROM public."order" o
    JOIN latest_revision ON latest_revision.order_id = o.id
    WHERE o.deleted_at IS NULL
      AND o.merchant_id = $2
      AND o.store_id = $3
      AND o.created_at <= $5::timestamptz
      AND (
        o.metadata->>'shiftId' = $1
        OR (
          COALESCE(o.metadata->>'shiftId', '') = ''
          AND o.created_at >= $4::timestamptz
          AND o.created_at <= COALESCE($5::timestamptz, now())
        )
      )
    ORDER BY o.created_at ASC, o.id ASC
  `, [shift.id, shift.merchantId, shift.storeId, shift.openedAt, end]);
  const orderIds = orders.rows.map((row) => row.id);

  const paymentSummary: ShiftReport["paymentSummary"] = {};
  let cashCharges = 0;
  let cashRefunds = 0;
  const outstandingObligations: Array<{
    currencyCode: string;
    minorUnitExponent: number;
    remainingAmountMinor: number;
    obligationCount: number;
  }> = [];
  {
    const payments = await client.query<{
      method: string;
      direction: string;
      amount: string;
      count: string;
    }>(`
      SELECT
        method,
        CASE WHEN kind = 'charge' THEN 'charge' ELSE 'refund' END AS direction,
        COALESCE(sum(amount_minor), 0)::numeric AS amount,
        count(*)::int AS count
      FROM app.payment_events
      WHERE merchant_id = $1
        AND store_id = $2
        AND source_occurred_at >= $3::timestamptz
        AND source_occurred_at <= COALESCE($4::timestamptz, now())
        AND recorded_at <= $4::timestamptz
        AND status = 'posted'
        AND kind IN ('charge', 'refund', 'reversal', 'chargeback')
      GROUP BY method, direction
      ORDER BY method ASC, direction ASC
    `, [shift.merchantId, shift.storeId, shift.openedAt, end]);
    for (const row of payments.rows) {
      const method = row.method || "unknown";
      const summary = paymentSummary[method] || { charges: 0, refunds: 0, net: 0, count: 0 };
      const amount = Number(row.amount || 0);
      const count = Number(row.count || 0);
      if (row.direction === "charge") summary.charges += amount;
      if (row.direction === "refund") summary.refunds += amount;
      summary.net = summary.charges - summary.refunds;
      summary.count += count;
      paymentSummary[method] = summary;
      if (method === "cash") {
        if (row.direction === "charge") cashCharges += amount;
        if (row.direction === "refund") cashRefunds += amount;
      }
    }

    const outstanding = await client.query<{
      currency_code: string;
      minor_unit_exponent: number;
      remaining_amount_minor: string;
      obligation_count: string;
    }>(`
      WITH touched_orders AS (
        SELECT obligations.order_id
        FROM app.commercial_obligations obligations
        WHERE obligations.merchant_id = $1 AND obligations.store_id = $2
          AND obligations.source_occurred_at >= $3::timestamptz
          AND obligations.source_occurred_at <= $4::timestamptz
          AND obligations.recorded_at <= $4::timestamptz
        UNION SELECT unnest($5::text[])
      ), latest_revision AS (
        SELECT DISTINCT ON (revision.order_id) revision.*
        FROM app.order_commercial_revisions revision
        JOIN touched_orders touched ON touched.order_id = revision.order_id
        WHERE revision.merchant_id = $1 AND revision.store_id = $2
          AND revision.effective_at <= $4::timestamptz
          AND revision.recorded_at <= $4::timestamptz
        ORDER BY revision.order_id, revision.revision DESC, revision.recorded_at DESC, revision.id DESC
      ), positions AS (
        SELECT revision.currency_code, revision.minor_unit_exponent,
          CASE WHEN revision.commercial_state = 'cancelled' THEN 0
            ELSE components.total_minor END AS amount_minor,
          coalesce(collections.amount_minor, 0) AS settled_amount_minor
        FROM latest_revision revision
        JOIN app.order_commercial_revision_components components ON components.revision_id = revision.id
        LEFT JOIN LATERAL (
          SELECT sum(CASE WHEN events.kind = 'charge' THEN events.amount_minor ELSE -events.amount_minor END) AS amount_minor
          FROM app.payment_events events
          WHERE events.merchant_id = revision.merchant_id AND events.store_id = revision.store_id
            AND events.order_id = revision.order_id AND events.currency_code = revision.currency_code
            AND events.minor_unit_exponent = revision.minor_unit_exponent
            AND events.status = 'posted' AND events.kind IN ('charge', 'refund', 'reversal', 'chargeback')
            AND events.source_occurred_at <= $4::timestamptz AND events.recorded_at <= $4::timestamptz
        ) collections ON true
      )
      SELECT currency_code, minor_unit_exponent,
        sum(greatest(amount_minor - settled_amount_minor, 0))::text AS remaining_amount_minor,
        count(*) FILTER (WHERE amount_minor > settled_amount_minor)::int AS obligation_count
      FROM positions
      GROUP BY currency_code, minor_unit_exponent
      HAVING sum(greatest(amount_minor - settled_amount_minor, 0)) > 0
      ORDER BY currency_code, minor_unit_exponent
    `, [shift.merchantId, shift.storeId, shift.openedAt, end, orderIds]);
    outstandingObligations.push(...outstanding.rows.map((row) => ({
      currencyCode: row.currency_code,
      minorUnitExponent: Number(row.minor_unit_exponent),
      remainingAmountMinor: Number(row.remaining_amount_minor || 0),
      obligationCount: Number(row.obligation_count || 0),
    })));
  }

  // Refund liabilities are independent of receipts and commercial receivables.
  // Both economic and recording timestamps use the same report cutoff.
  const refundPayables = await client.query<{
    currency_code: string; minor_unit_exponent: number; remaining_amount_minor: string; payable_count: number;
  }>(`
    WITH balances AS (
      SELECT payable.currency_code, payable.minor_unit_exponent,
        payable.amount_minor - coalesce(sum(clearance.amount_minor), 0) AS remaining_amount_minor
      FROM app.customer_refund_payables payable
      LEFT JOIN app.customer_refund_payable_events clearance ON clearance.payable_id = payable.id
        AND clearance.merchant_id = payable.merchant_id AND clearance.store_id = payable.store_id
        AND clearance.event_kind = 'clear'
        AND clearance.source_occurred_at <= $4::timestamptz AND clearance.recorded_at <= $4::timestamptz
      WHERE payable.merchant_id = $1 AND payable.store_id = $2
        AND (payable.source_occurred_at >= $3::timestamptz OR payable.order_id = ANY($5::text[]))
        AND payable.source_occurred_at <= $4::timestamptz AND payable.recorded_at <= $4::timestamptz
      GROUP BY payable.id
    )
    SELECT currency_code, minor_unit_exponent, sum(remaining_amount_minor)::text AS remaining_amount_minor,
      count(*)::int AS payable_count
    FROM balances WHERE remaining_amount_minor > 0
    GROUP BY currency_code, minor_unit_exponent ORDER BY currency_code, minor_unit_exponent
  `, [shift.merchantId, shift.storeId, shift.openedAt, end, orderIds]);
  const outstandingRefundPayables = refundPayables.rows.map((row) => ({
    currencyCode: row.currency_code, minorUnitExponent: Number(row.minor_unit_exponent),
    remainingAmountMinor: Number(row.remaining_amount_minor), payableCount: Number(row.payable_count),
  }));

  const cashMovementRows = await client.query<ShiftRow>(`
    SELECT *
    FROM app.shift_cash_movements
    WHERE shift_id = $1
      AND merchant_id = $2
      AND store_id = $3
    ORDER BY occurred_at ASC, id ASC
  `, [shift.id, shift.merchantId, shift.storeId]);
  const cashMovements = cashMovementRows.rows.map(rowToCashMovement);
  const cashMovementNet = cashMovements.reduce((sum, movement) => {
    if (movement.type === "pay_in" || movement.type === "cash_correction") return sum + movement.amount;
    return sum - movement.amount;
  }, 0);
  const cashExpected = shift.openingCashAmount + cashCharges - cashRefunds + cashMovementNet;

  const stockCountRows = await client.query<ShiftRow>(`
    SELECT *
    FROM app.shift_stock_counts
    WHERE shift_id = $1
      AND merchant_id = $2
      AND store_id = $3
    ORDER BY counted_at ASC, id ASC
  `, [shift.id, shift.merchantId, shift.storeId]);
  const stockCounts = stockCountRows.rows.map(rowToStockCount);
  const maxStockDiscrepancy = stockCounts.reduce((max, count) => Math.max(max, Math.abs(count.discrepancyQuantity)), 0);

  const productRows = orderIds.length > 0 ? await client.query<{
    product_id: string;
    variant_id: string;
    sku: string;
    product_title: string;
    quantity: string;
    gross_sales: string;
  }>(`
    WITH latest_revision AS (
      SELECT DISTINCT ON (revision.merchant_id, revision.store_id, revision.order_id)
        revision.id,
        revision.order_id,
        revision.commercial_state
      FROM app.order_commercial_revisions revision
      WHERE revision.merchant_id = $2
        AND revision.store_id = $3
        AND revision.order_id = ANY($1::text[])
        AND revision.effective_at <= $4::timestamptz
        AND revision.recorded_at <= $4::timestamptz
      ORDER BY revision.merchant_id, revision.store_id, revision.order_id,
        revision.revision DESC, revision.recorded_at DESC, revision.id DESC
    )
    SELECT
      line.product_id,
      line.variant_id,
      line.sku_snapshot AS sku,
      line.title_snapshot AS product_title,
      COALESCE(sum(line.quantity::numeric), 0)::numeric AS quantity,
      COALESCE(sum(line.line_total_minor::numeric), 0)::numeric AS gross_sales
    FROM latest_revision revision
    JOIN app.order_commercial_revision_lines line ON line.revision_id = revision.id
    WHERE revision.commercial_state = 'active'
    GROUP BY line.product_id, line.variant_id, line.sku_snapshot, line.title_snapshot
    ORDER BY quantity DESC, product_title ASC
  `, [orderIds, shift.merchantId, shift.storeId, end]) : { rows: [] };

  const manualReviewIntents = await client.query<{
    id: string;
    provider: string;
    manual_review_reason: string | null;
  }>(`
    SELECT id::text, provider, manual_review_reason
    FROM app.payment_intents
    WHERE merchant_id = $1
      AND store_id = $2
      AND status = 'manual_review'
      AND created_at >= $3::timestamptz
      AND created_at <= COALESCE($4::timestamptz, now())
    ORDER BY created_at DESC
    LIMIT 25
  `, [shift.merchantId, shift.storeId, shift.openedAt, end]);

  const postCloseAdjustments = closedAt ? (await client.query<Record<string, unknown>>(`
    SELECT
      id::text,
      inventory_item_id AS "inventoryItemId",
      product_id AS "productId",
      variant_id AS "variantId",
      movement_type AS "movementType",
      source_action AS "sourceAction",
      quantity_change AS "quantityChange",
      quantity_after AS "quantityAfter",
      reference_type AS "referenceType",
      reference_id AS "referenceId",
      reason,
      performed_by AS "performedBy",
      created_at AS "createdAt"
    FROM medusa.stock_movements
    WHERE merchant_id = $1
      AND store_id = $2
      AND stock_location_id = $3
      AND created_at > $4::timestamptz
    ORDER BY created_at DESC
    LIMIT 50
  `, [shift.merchantId, shift.storeId, shift.stockLocationId, end])).rows : [];

  const postCloseFinancialAdjustments = closedAt ? (await client.query(`
    SELECT events.id::text AS id, events.order_id AS "orderId", events.kind,
      events.amount_minor::text AS "amountMinor", events.currency_code AS "currencyCode",
      events.source_occurred_at AS "sourceOccurredAt", events.recorded_at AS "recordedAt"
    FROM app.payment_events events
    WHERE events.merchant_id = $1 AND events.store_id = $2 AND events.recorded_at > $3::timestamptz
      AND events.status = 'posted' AND events.kind IN ('charge', 'refund', 'reversal', 'chargeback')
      AND (events.order_id = ANY($4::text[]) OR (events.source_occurred_at >= $5::timestamptz AND events.source_occurred_at <= $3::timestamptz))
    UNION ALL
    SELECT revision.id::text, revision.order_id, 'commercial_revision', components.total_minor::text,
      revision.currency_code, revision.effective_at, revision.recorded_at
    FROM app.order_commercial_revisions revision
    JOIN app.order_commercial_revision_components components ON components.revision_id = revision.id
    WHERE revision.merchant_id = $1 AND revision.store_id = $2 AND revision.recorded_at > $3::timestamptz
      AND revision.order_id = ANY($4::text[])
    ORDER BY "recordedAt" DESC, id DESC LIMIT 50
  `, [shift.merchantId, shift.storeId, end, savedReport?.orderIds || orderIds, shift.openedAt])).rows : [];
  if (savedReport) {
    return { ...savedReport, shift, reportAsOf: savedReport.reportAsOf || end,
      outstandingRefundPayables: savedReport.outstandingRefundPayables || [],
      postCloseAdjustments, postCloseFinancialAdjustments };
  }

  const warnings: ShiftReport["warnings"] = [];
  const fallbackCount = orders.rows.filter((row) => row.attribution === "legacy_time_window").length;
  if (fallbackCount > 0) {
    warnings.push({
      code: "legacy_time_window_fallback",
      message: `${fallbackCount} order(s) were included by time-window fallback.`,
      severity: "warning",
    });
  }
  if (outstandingObligations.length > 0) {
    warnings.push({
      code: "outstanding_obligations",
      message: `${outstandingObligations.reduce((sum, item) => sum + item.obligationCount, 0)} obligation(s) remain unpaid at this shift's report-as-of time.`,
      severity: "warning",
    });
  }
  if (outstandingRefundPayables.length > 0) {
    warnings.push({ code: "outstanding_refund_payables", message: "Customer refunds remain payable at this report cutoff.", severity: "warning" });
  }
  if (manualReviewIntents.rows.length > 0) {
    warnings.push({
      code: "payment_intent_manual_review",
      message: `${manualReviewIntents.rows.length} payment intent(s) require manual review in this window.`,
      severity: "danger",
    });
  }
  if (maxStockDiscrepancy > 0) {
    warnings.push({
      code: "stock_discrepancy_recorded",
      message: `Largest quick-count stock discrepancy is ${maxStockDiscrepancy}.`,
      severity: "warning",
    });
  }

  const cashCount = countedCashAmount ?? shift.blindCashCountAmount ?? null;
  const cashVariance = cashCount === null ? null : cashCount - cashExpected;
  return {
    shift: {
      ...shift,
      expectedCashAmount: cashExpected,
      blindCashCountAmount: cashCount,
      cashVarianceAmount: cashVariance,
    },
    orderIds,
    paymentSummary,
    cashExpected,
    stockCounts,
    warnings,
    postCloseAdjustments,
    postCloseFinancialAdjustments,
    reportAsOf: end,
    outstandingRefundPayables,
    orders: orders.rows.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      createdAt: iso(row.created_at),
      attribution: row.attribution,
      total: Number(row.total || 0),
    })),
    productSold: productRows.rows.map((row) => ({
      productId: row.product_id,
      variantId: row.variant_id,
      sku: row.sku,
      productTitle: row.product_title,
      quantity: Number(row.quantity || 0),
      grossSales: Number(row.gross_sales || 0),
    })),
    cashMovements,
    outstandingObligations,
    manualReviewPaymentIntents: manualReviewIntents.rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      reason: row.manual_review_reason,
    })),
    cash: {
      openingCash: shift.openingCashAmount,
      cashCharges,
      cashRefunds,
      cashMovementNet,
      expectedCash: cashExpected,
      countedCash: cashCount,
      variance: cashVariance,
    },
  };
}

async function recordStockCountsForClient(
  client: PoolClient,
  shift: ShiftRow,
  input: { countType?: "quick" | "close"; items: Array<{ inventoryItemId: string; countedQuantity: number; reason?: string }> },
  actor: OperatorContext,
): Promise<ShiftStockCount[]> {
  const parsed = RecordShiftStockCountSchema.parse(input);
  const inserted: ShiftStockCount[] = [];
  for (const item of parsed.items) {
    const inventory = await queryOne<{
      inventory_item_id: string;
      product_id: string | null;
      variant_id: string | null;
      sku: string | null;
      product_title: string | null;
      stocked_quantity: string;
    }>(client, `
      SELECT
        ii.id AS inventory_item_id,
        v.product_id,
        v.id AS variant_id,
        COALESCE(v.sku, ii.sku, '') AS sku,
        COALESCE(p.title, ii.title, '') AS product_title,
        COALESCE(il.stocked_quantity, 0)::numeric AS stocked_quantity
      FROM public.inventory_item ii
      LEFT JOIN public.product_variant_inventory_item vii ON vii.inventory_item_id = ii.id AND vii.deleted_at IS NULL
      LEFT JOIN public.product_variant v ON v.id = vii.variant_id AND v.deleted_at IS NULL
      LEFT JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
      LEFT JOIN public.inventory_level il ON il.inventory_item_id = ii.id AND il.deleted_at IS NULL AND il.location_id = $2
      WHERE ii.id = $1
        AND ii.deleted_at IS NULL
        AND (p.id IS NULL OR p.merchant_id = $3)
      LIMIT 1
    `, [item.inventoryItemId, String(shift.stock_location_id), String(shift.merchant_id)]);
    if (!inventory) throw new PlatformError("resource_not_found", "Inventory item not found for shift stock count", 404);
    const systemQuantity = Math.round(Number(inventory.stocked_quantity || 0));
    const countedQuantity = Math.round(Number(item.countedQuantity || 0));
    const discrepancyQuantity = countedQuantity - systemQuantity;
    const row = requireReturned(await queryOne<ShiftRow>(client, `
      INSERT INTO app.shift_stock_counts (
        id, shift_id, merchant_id, store_id, stock_location_id, count_type,
        inventory_item_id, product_id, variant_id, sku_snapshot, product_title_snapshot,
        system_quantity, counted_quantity, discrepancy_quantity, reason, counted_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (shift_id, inventory_item_id, count_type) DO UPDATE SET
        system_quantity = EXCLUDED.system_quantity,
        counted_quantity = EXCLUDED.counted_quantity,
        discrepancy_quantity = EXCLUDED.discrepancy_quantity,
        reason = EXCLUDED.reason,
        counted_by = EXCLUDED.counted_by,
        counted_at = now(),
        metadata = app.shift_stock_counts.metadata || jsonb_build_object('updatedAt', now())
      RETURNING *
    `, [
      id("shiftcnt"),
      String(shift.id),
      String(shift.merchant_id),
      String(shift.store_id),
      String(shift.stock_location_id),
      parsed.countType,
      inventory.inventory_item_id,
      inventory.product_id,
      inventory.variant_id,
      inventory.sku,
      inventory.product_title,
      systemQuantity,
      countedQuantity,
      discrepancyQuantity,
      item.reason || null,
      actor.operatorId,
    ]), "Shift stock count upsert did not return a row");
    if (row) inserted.push(rowToStockCount(row));
  }
  await appendShiftEvent(client, {
    shiftId: String(shift.id),
    scope: {
      merchantId: String(shift.merchant_id),
      storeId: String(shift.store_id),
      stockLocationId: String(shift.stock_location_id),
    },
    eventType: "shift.stock_count_recorded",
    actor,
    after: { countType: parsed.countType, itemCount: inserted.length },
  });
  return inserted;
}

export async function resolveShiftAttributionForSale(
  client: PoolClient,
  input: SaleShiftAttributionInput,
  scope: OperatingScope,
): Promise<Record<string, unknown>> {
  const requestedShiftId = text(input.shiftId);
  const requestedAttribution = input.shiftAttribution;
  const queuedAt = parseDate(input.queuedAt, "queuedAt");
  const policy = await getPolicyForClient(client, scope);

  if (requestedShiftId) {
    const shift = await queryOne<ShiftRow>(client, `
      SELECT *
      FROM app.work_shifts
      WHERE id = $1
        AND merchant_id = $2
        AND store_id = $3
        AND stock_location_id = $4
      LIMIT 1
    `, [requestedShiftId, scope.merchantId, scope.storeId, scope.stockLocationId]);
    if (!shift) throw new PlatformError("invalid_shift", "Shift does not belong to the active scope", 409);
    const attribution = requestedAttribution === "offline_cached_shift" ? "offline_cached_shift" : "online_open_shift";
    if (attribution === "offline_cached_shift") {
      if (!policy.allowOfflineCachedShift) {
        throw new PlatformError("shift_offline_not_allowed", "Offline cached shift attribution is disabled", 409);
      }
      if (!queuedAt) throw new PlatformError("validation_error", "queuedAt is required for offline cached shift attribution", 400);
      const queued = new Date(queuedAt).getTime();
      const opened = new Date(iso(shift.opened_at)).getTime();
      const closedText = reportWindowEnd(shift);
      const closed = closedText ? new Date(closedText).getTime() : Date.now();
      if (queued < opened || queued > closed) {
        throw new PlatformError("invalid_shift", "Queued sale is outside the cached shift window", 409);
      }
    } else if (String(shift.status) !== "open") {
      throw new PlatformError("invalid_shift", "Online sale shift must be open", 409);
    }
    return {
      shiftId: String(shift.id),
      shiftOpenedAt: iso(shift.opened_at),
      shiftAttribution: attribution,
      ...(queuedAt ? { shiftQueuedAt: queuedAt } : {}),
    };
  }

  const active = await getActiveShiftForClient(client, scope);
  if (active) {
    return {
      shiftId: String(active.id),
      shiftOpenedAt: iso(active.opened_at),
      shiftAttribution: "online_open_shift",
    };
  }
  if (policy.enabled && policy.enforceShiftOnPos) {
    throw new PlatformError("shift_required", "A shift must be open before POS checkout", 409);
  }
  return {};
}

export async function getCurrentShift(scope: OperatingScope) {
  return withClient(async (client) => {
    const policy = await getPolicyForClient(client, scope);
    const active = await getActiveShiftForClient(client, scope);
    const previous = await queryOne<ShiftRow>(client, `
      SELECT *
      FROM app.work_shifts
      WHERE merchant_id = $1
        AND store_id = $2
        AND stock_location_id = $3
        AND status IN ('closed', 'force_closed')
      ORDER BY COALESCE(closed_at, force_closed_at, opened_at) DESC
      LIMIT 1
    `, [scope.merchantId, scope.storeId, scope.stockLocationId]);
    const pendingHandover = previous ? await queryOne<ShiftRow>(client, `
      SELECT *
      FROM app.shift_handover_acknowledgements
      WHERE previous_shift_id = $1
      ORDER BY acknowledged_at DESC
      LIMIT 1
    `, [String(previous.id)]) : null;
    return {
      data: active ? rowToShiftSummary(active) : null,
      policy,
      previousHandover: previous ? {
        shift: rowToShiftSummary(previous),
        acknowledged: Boolean(pendingHandover),
        acknowledgement: pendingHandover ? {
          id: String(pendingHandover.id),
          previousShiftId: String(pendingHandover.previous_shift_id),
          receivingShiftId: pendingHandover.receiving_shift_id ? String(pendingHandover.receiving_shift_id) : null,
          acknowledgedBy: String(pendingHandover.acknowledged_by),
          acknowledgedAt: iso(pendingHandover.acknowledged_at),
          acknowledgementNote: pendingHandover.acknowledgement_note ? String(pendingHandover.acknowledgement_note) : null,
        } : null,
      } : null,
    };
  });
}

export async function getShiftPolicy(scope: OperatingScope) {
  return withClient(async (client) => ({ data: await getPolicyForClient(client, scope) }));
}

export async function updateShiftPolicy(headers: HeadersLike, body: UpdateShiftPolicyInput, actor: OperatorContext, scope: OperatingScope) {
  return withActiveShiftTransaction(scope, async (client) => withScopedIdempotency(client, headers, body, scope.merchantId, SHIFT_OPS.updatePolicy, async () => {
    const merged = ShiftPolicySchemaPartial.parse(body || {});
    const current = await getPolicyForClient(client, scope);
    const policyId = current.id || id("shiftpol");
    const next: ShiftPolicy = { ...current, ...merged, id: policyId };
    const row = requireReturned(await queryOne<ShiftRow>(client, `
      INSERT INTO app.shift_policies (
        id, merchant_id, store_id, stock_location_id, enabled, enforce_shift_on_pos,
        allow_offline_cached_shift, blind_close_cash, require_handover_ack,
        quick_stock_count_required, max_open_duration_minutes, stale_after_minutes,
        cash_discrepancy_alert_threshold, stock_discrepancy_alert_threshold, checklist, updated_by, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $16)
      ON CONFLICT (merchant_id, store_id, stock_location_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        enforce_shift_on_pos = EXCLUDED.enforce_shift_on_pos,
        allow_offline_cached_shift = EXCLUDED.allow_offline_cached_shift,
        blind_close_cash = EXCLUDED.blind_close_cash,
        require_handover_ack = EXCLUDED.require_handover_ack,
        quick_stock_count_required = EXCLUDED.quick_stock_count_required,
        max_open_duration_minutes = EXCLUDED.max_open_duration_minutes,
        stale_after_minutes = EXCLUDED.stale_after_minutes,
        cash_discrepancy_alert_threshold = EXCLUDED.cash_discrepancy_alert_threshold,
        stock_discrepancy_alert_threshold = EXCLUDED.stock_discrepancy_alert_threshold,
        checklist = EXCLUDED.checklist,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING *
    `, [
      policyId,
      scope.merchantId,
      scope.storeId,
      scope.stockLocationId,
      next.enabled,
      next.enforceShiftOnPos,
      next.allowOfflineCachedShift,
      next.blindCloseCash,
      next.requireHandoverAck,
      next.quickStockCountRequired,
      next.maxOpenDurationMinutes,
      next.staleAfterMinutes,
      next.cashDiscrepancyAlertThreshold,
      next.stockDiscrepancyAlertThreshold,
      JSON.stringify(next.checklist || []),
      actor.operatorId,
    ]), "Shift policy upsert did not return a row");
    await recordAuditEntry(client, actor, "shift_policy.updated", "shift_policy", policyId, {
      before: current,
      after: rowToPolicy(scope, row),
      merchantId: scope.merchantId,
      storeId: scope.storeId,
    });
    return { data: rowToPolicy(scope, row) };
  }));
}

const ShiftPolicySchemaPartial = {
  parse(value: UpdateShiftPolicyInput): UpdateShiftPolicyInput {
    const current = value || {};
    const parsed: UpdateShiftPolicyInput = {};
    if ("enabled" in current) parsed.enabled = current.enabled === true;
    if ("enforceShiftOnPos" in current) parsed.enforceShiftOnPos = current.enforceShiftOnPos === true;
    if ("allowOfflineCachedShift" in current) parsed.allowOfflineCachedShift = current.allowOfflineCachedShift !== false;
    if ("blindCloseCash" in current) parsed.blindCloseCash = current.blindCloseCash !== false;
    if ("requireHandoverAck" in current) parsed.requireHandoverAck = current.requireHandoverAck === true;
    if ("quickStockCountRequired" in current) parsed.quickStockCountRequired = current.quickStockCountRequired === true;
    if ("maxOpenDurationMinutes" in current) {
      const valueNumber = Number(current.maxOpenDurationMinutes);
      if (!Number.isInteger(valueNumber) || valueNumber <= 0) throw new PlatformError("validation_error", "maxOpenDurationMinutes must be positive", 400);
      parsed.maxOpenDurationMinutes = valueNumber;
    }
    if ("staleAfterMinutes" in current) {
      const valueNumber = Number(current.staleAfterMinutes);
      if (!Number.isInteger(valueNumber) || valueNumber <= 0) throw new PlatformError("validation_error", "staleAfterMinutes must be positive", 400);
      parsed.staleAfterMinutes = valueNumber;
    }
    if ("cashDiscrepancyAlertThreshold" in current) parsed.cashDiscrepancyAlertThreshold = nonNegativeMoney(current.cashDiscrepancyAlertThreshold, "cashDiscrepancyAlertThreshold");
    if ("stockDiscrepancyAlertThreshold" in current) {
      const valueNumber = Number(current.stockDiscrepancyAlertThreshold);
      if (!Number.isInteger(valueNumber) || valueNumber < 0) throw new PlatformError("validation_error", "stockDiscrepancyAlertThreshold must be non-negative", 400);
      parsed.stockDiscrepancyAlertThreshold = valueNumber;
    }
    if ("checklist" in current) {
      if (!Array.isArray(current.checklist)) throw new PlatformError("validation_error", "checklist must be an array", 400);
      parsed.checklist = current.checklist.map((item) => text(item)).filter(Boolean).slice(0, 50);
    }
    return parsed;
  },
};

export async function receiveShiftHandover(headers: HeadersLike, body: ReceiveShiftHandoverInput, actor: OperatorContext, scope: OperatingScope) {
  const parsed = ReceiveShiftHandoverSchema.parse(body || {});
  return withActiveShiftTransaction(scope, async (client) => withScopedIdempotency(client, headers, parsed, scope.merchantId, SHIFT_OPS.receiveHandover, async () => {
    const previous = await getShiftForOperatingScope(client, parsed.previousShiftId, scope);
    if (!["closed", "force_closed"].includes(String(previous.status))) {
      throw new PlatformError("invalid_shift_state", "Only a closed shift can be acknowledged for handover", 409);
    }
    const ackId = id("shiftack");
    const row = requireReturned(await queryOne<ShiftRow>(client, `
      INSERT INTO app.shift_handover_acknowledgements (
        id, merchant_id, store_id, stock_location_id, previous_shift_id, acknowledged_by,
        acknowledgement_note, received_opening_cash_amount, acknowledged_items, snapshot_payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
      RETURNING *
    `, [
      ackId,
      scope.merchantId,
      scope.storeId,
      scope.stockLocationId,
      parsed.previousShiftId,
      actor.operatorId,
      nullableText(parsed.acknowledgementNote),
      parsed.receivedOpeningCashAmount === undefined ? null : nonNegativeMoney(parsed.receivedOpeningCashAmount, "receivedOpeningCashAmount"),
      JSON.stringify(parsed.acknowledgedItems || []),
      JSON.stringify({
        previousShift: rowToShiftSummary(previous),
        outgoingHandoverNote: previous.outgoing_handover_note || null,
        acknowledgedAt: new Date().toISOString(),
      }),
    ]), "Shift handover acknowledgement insert did not return a row");
    await appendShiftEvent(client, {
      shiftId: parsed.previousShiftId,
      scope,
      eventType: "shift.handover_acknowledged",
      actor,
      after: { acknowledgementId: ackId },
    });
    await recordAuditEntry(client, actor, "shift.handover_acknowledged", "shift", parsed.previousShiftId, {
      after: { acknowledgementId: ackId, acknowledgementNote: parsed.acknowledgementNote || null },
      merchantId: scope.merchantId,
      storeId: scope.storeId,
    });
    return { data: row };
  }));
}

export async function startShift(headers: HeadersLike, body: StartShiftInput, actor: OperatorContext, scope: OperatingScope) {
  const parsed = StartShiftSchema.parse(body || {});
  return withActiveShiftTransaction(scope, async (client) => withScopedIdempotency(client, headers, parsed, scope.merchantId, SHIFT_OPS.startShift, async () => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`shift:${scope.merchantId}:${scope.storeId}:${scope.stockLocationId}`]);
    const existing = await getActiveShiftForClient(client, scope, true);
    if (existing) throw new PlatformError("shift_already_open", "A shift is already open for this store", 409, { shiftId: existing.id });
    const policy = await getPolicyForClient(client, scope);
    const previous = await queryOne<ShiftRow>(client, `
      SELECT *
      FROM app.work_shifts
      WHERE merchant_id = $1
        AND store_id = $2
        AND stock_location_id = $3
        AND status IN ('closed', 'force_closed')
      ORDER BY COALESCE(closed_at, force_closed_at, opened_at) DESC
      LIMIT 1
    `, [scope.merchantId, scope.storeId, scope.stockLocationId]);
    if (policy.requireHandoverAck && previous && !parsed.handoverAcknowledgementId) {
      throw new PlatformError("handover_ack_required", "Previous shift handover must be acknowledged before opening a new shift", 409, {
        previousShiftId: previous.id,
      });
    }
    if (parsed.handoverAcknowledgementId) {
      const ack = await queryOne<ShiftRow>(client, `
        SELECT *
        FROM app.shift_handover_acknowledgements
        WHERE id = $1
          AND merchant_id = $2
          AND store_id = $3
          AND stock_location_id = $4
        FOR UPDATE
      `, [parsed.handoverAcknowledgementId, scope.merchantId, scope.storeId, scope.stockLocationId]);
      if (!ack) throw new PlatformError("resource_not_found", "Handover acknowledgement not found", 404);
      if (previous && String(ack.previous_shift_id) !== String(previous.id)) {
        throw new PlatformError("handover_ack_mismatch", "Handover acknowledgement does not match the previous shift", 409);
      }
    }
    const nextZ = await queryOne<{ next_z: number }>(client, `
      SELECT COALESCE(max(z_number), 0)::int + 1 AS next_z
      FROM app.work_shifts
      WHERE merchant_id = $1
        AND store_id = $2
    `, [scope.merchantId, scope.storeId]);
    const shiftId = id("shift");
    const row = requireReturned(await queryOne<ShiftRow>(client, `
      INSERT INTO app.work_shifts (
        id, organization_id, merchant_id, store_id, stock_location_id, status, review_status,
        z_number, opened_by, opening_cash_amount, opening_note, metadata
      )
      VALUES ($1, $2, $3, $4, $5, 'open', 'pending', $6, $7, $8, $9, $10::jsonb)
      RETURNING *
    `, [
      shiftId,
      actor.organizationId || "org_default",
      scope.merchantId,
      scope.storeId,
      scope.stockLocationId,
      Number(nextZ?.next_z || 1),
      actor.operatorId,
      nonNegativeMoney(parsed.openingCashAmount, "openingCashAmount"),
      nullableText(parsed.openingNote),
      JSON.stringify({
        handoverAcknowledgementId: parsed.handoverAcknowledgementId || null,
        policySnapshot: policy,
      }),
    ]), "Shift insert did not return a row");
    if (parsed.handoverAcknowledgementId) {
      await client.query(`
        UPDATE app.shift_handover_acknowledgements
        SET receiving_shift_id = $2
        WHERE id = $1
          AND (receiving_shift_id IS NULL OR receiving_shift_id = $2)
      `, [parsed.handoverAcknowledgementId, shiftId]);
    }
    const shiftEvent = await appendShiftEvent(client, {
      shiftId,
      scope,
      eventType: "shift.opened",
      actor,
      after: rowToShiftSummary(row),
    });
    await emitExactOutbox(client, buildExactShiftLifecycleEvent({
      shiftId,
      merchantId: scope.merchantId,
      storeId: scope.storeId,
      stockLocationId: scope.stockLocationId,
      eventType: "shift.opened",
      shiftEventId: shiftEvent.eventId,
      sourceOccurredAt: shiftEvent.sourceOccurredAt,
    }));
    await recordAuditEntry(client, actor, "shift.opened", "shift", shiftId, {
      after: rowToShiftSummary(row),
      correlationId: shiftEvent.eventId,
      merchantId: scope.merchantId,
      storeId: scope.storeId,
    });
    return { data: rowToShiftSummary(row) };
  }));
}

export async function recordShiftCashMovement(
  headers: HeadersLike,
  body: CreateShiftCashMovementInput,
  actor: OperatorContext,
  scope: OperatingScope,
  shiftId?: string,
) {
  const parsed = CreateShiftCashMovementSchema.parse(body || {});
  return withActiveShiftTransaction(scope, async (client) => withScopedIdempotency(client, headers, { ...parsed, shiftId: shiftId || null }, scope.merchantId, SHIFT_OPS.cashMovement, async () => {
    const shift = shiftId
      ? await getShiftForOperatingScope(client, shiftId, scope, { lock: true, activeOnly: true })
      : await getActiveShiftForClient(client, scope, true);
    if (!shift) throw new PlatformError("shift_required", "An open shift is required for cash movement", 409);
    const movementId = id("shiftcash");
    const row = requireReturned(await queryOne<ShiftRow>(client, `
      INSERT INTO app.shift_cash_movements (
        id, shift_id, merchant_id, store_id, stock_location_id, type, amount,
        reason, reason_code, performed_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [
      movementId,
      String(shift.id),
      scope.merchantId,
      scope.storeId,
      scope.stockLocationId,
      parsed.type,
      positiveMoney(parsed.amount, "amount"),
      parsed.reason,
      nullableText(parsed.reasonCode),
      actor.operatorId,
    ]), "Shift cash movement insert did not return a row");
    await appendShiftEvent(client, {
      shiftId: String(shift.id),
      scope,
      eventType: "shift.cash_movement_recorded",
      actor,
      reason: parsed.reason,
      after: rowToCashMovement(row),
    });
    await recordAuditEntry(client, actor, "shift.cash_movement_recorded", "shift", String(shift.id), {
      after: rowToCashMovement(row),
      reason: parsed.reason,
      merchantId: scope.merchantId,
      storeId: scope.storeId,
    });
    return { data: rowToCashMovement(row) };
  }));
}

export async function recordShiftStockCount(headers: HeadersLike, body: unknown, actor: OperatorContext, scope: OperatingScope, shiftId?: string) {
  const parsed = RecordShiftStockCountSchema.parse(body || {});
  return withActiveShiftTransaction(scope, async (client) => withScopedIdempotency(client, headers, { ...parsed, shiftId: shiftId || null }, scope.merchantId, SHIFT_OPS.stockCount, async () => {
    const shift = shiftId
      ? await getShiftForOperatingScope(client, shiftId, scope, { lock: true, activeOnly: true })
      : await getActiveShiftForClient(client, scope, true);
    if (!shift) throw new PlatformError("shift_required", "An open shift is required for stock count", 409);
    const rows = await recordStockCountsForClient(client, shift, parsed, actor);
    await recordAuditEntry(client, actor, "shift.stock_count_recorded", "shift", String(shift.id), {
      after: { countType: parsed.countType, itemCount: rows.length },
      merchantId: scope.merchantId,
      storeId: scope.storeId,
    });
    return { data: rows };
  }));
}

export async function previewCloseShift(body: unknown, scope: OperatingScope, shiftId?: string) {
  const countedCashAmount = body && typeof body === "object" && "countedCashAmount" in body
    ? nonNegativeMoney((body as { countedCashAmount?: unknown }).countedCashAmount, "countedCashAmount")
    : undefined;
  return withClient(async (client) => {
    const shift = shiftId
      ? await getShiftForOperatingScope(client, shiftId, scope, { activeOnly: true })
      : await getActiveShiftForClient(client, scope);
    if (!shift) throw new PlatformError("shift_required", "An open shift is required for close preview", 409);
    return { data: await buildShiftReportForClient(client, shift, countedCashAmount) };
  });
}

async function maybeEmitDiscrepancyAlert(
  client: PoolClient,
  shift: ShiftRow,
  policy: ShiftPolicy,
  report: ShiftReport & Record<string, unknown>,
  actor: OperatorContext,
  sourceShiftEvent: { eventId: string; sourceOccurredAt: Date | string },
): Promise<void> {
  const variance = Math.abs(Number(report.shift.cashVarianceAmount || 0));
  const stockCounts = Array.isArray(report.stockCounts) ? report.stockCounts : [];
  const maxStockDiscrepancy = stockCounts.reduce((max, count) => Math.max(max, Math.abs(Number(count.discrepancyQuantity || 0))), 0);
  const cashTriggered = variance > 0 && variance >= policy.cashDiscrepancyAlertThreshold;
  const stockTriggered = maxStockDiscrepancy > 0 && maxStockDiscrepancy >= policy.stockDiscrepancyAlertThreshold;
  if (!cashTriggered && !stockTriggered) return;
  await emitExactOutbox(client, buildExactShiftDiscrepancyAlertEvent({
    shiftId: String(shift.id),
    zNumber: shift.z_number || null,
    merchantId: String(shift.merchant_id),
    storeId: String(shift.store_id),
    stockLocationId: String(shift.stock_location_id),
    operatorId: actor.operatorId,
    cashVarianceAmount: Number(report.shift.cashVarianceAmount || 0),
    maxStockDiscrepancy,
    cashTriggered,
    stockTriggered,
    shiftEventId: sourceShiftEvent.eventId,
    sourceOccurredAt: sourceShiftEvent.sourceOccurredAt,
  }));
}

export async function closeShift(headers: HeadersLike, body: CloseShiftInput, actor: OperatorContext, scope: OperatingScope, shiftId?: string) {
  const parsed = CloseShiftSchema.parse(body || {});
  return withActiveShiftTransaction(scope, async (client) => withScopedIdempotency(client, headers, { ...parsed, shiftId: shiftId || null }, scope.merchantId, SHIFT_OPS.closeShift, async () => {
    const shift = shiftId
      ? await getShiftForOperatingScope(client, shiftId, scope, { lock: true, activeOnly: true })
      : await getActiveShiftForClient(client, scope, true);
    if (!shift) throw new PlatformError("shift_required", "An open shift is required to close", 409);
    if (String(shift.status) !== "open" && String(shift.status) !== "closing") {
      throw new PlatformError("invalid_shift_state", "Only an open shift can be closed", 409);
    }
    const policy = await getPolicyForClient(client, scope);
    if (parsed.stockCounts.length > 0) {
      await recordStockCountsForClient(client, shift, { countType: "close", items: parsed.stockCounts }, actor);
    }
    if (policy.quickStockCountRequired) {
      const count = await queryOne<{ count: number }>(client, `
        SELECT count(*)::int AS count
        FROM app.shift_stock_counts
        WHERE shift_id = $1
      `, [String(shift.id)]);
      if (!count || Number(count.count || 0) === 0) {
        throw new PlatformError("stock_count_required", "Quick stock count is required before closing this shift", 409);
      }
    }
    const countedCashAmount = nonNegativeMoney(parsed.countedCashAmount, "countedCashAmount");
    const preCloseReport = await buildShiftReportForClient(client, shift, countedCashAmount);
    const variance = Number(preCloseReport.shift.cashVarianceAmount || 0);
    const zPayload = {
      calculatedAt: new Date().toISOString(),
      closeType: "operator_close",
      report: preCloseReport,
      checklist: parsed.checklist,
      discrepancyReason: parsed.discrepancyReason || null,
    };
    const closed = requireReturned(await queryOne<ShiftRow>(client, `
      UPDATE app.work_shifts
      SET status = 'closed',
          close_started_at = COALESCE(close_started_at, now()),
          closed_by = $2,
          closed_at = now(),
          blind_cash_count_amount = $3,
          expected_cash_amount = $4,
          cash_variance_amount = $5,
          closing_note = $6,
          outgoing_handover_note = $7,
          z_report_payload = $8::jsonb,
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('checklist', $9::jsonb),
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `, [
      String(shift.id),
      actor.operatorId,
      countedCashAmount,
      preCloseReport.cashExpected,
      variance,
      nullableText(parsed.discrepancyReason),
      nullableText(parsed.outgoingHandoverNote),
      JSON.stringify(zPayload),
      JSON.stringify(parsed.checklist),
    ]), "Shift close update did not return a row");
    const finalReport = await buildShiftReportForClient(client, closed, countedCashAmount);
    const shiftEvent = await appendShiftEvent(client, {
      shiftId: String(closed.id),
      scope,
      eventType: "shift.closed",
      actor,
      reason: parsed.discrepancyReason || null,
      before: rowToShiftSummary(shift),
      after: rowToShiftSummary(closed),
    });
    await emitExactOutbox(client, buildExactShiftLifecycleEvent({
      shiftId: String(closed.id),
      merchantId: scope.merchantId,
      storeId: scope.storeId,
      stockLocationId: scope.stockLocationId,
      eventType: "shift.closed",
      shiftEventId: shiftEvent.eventId,
      sourceOccurredAt: shiftEvent.sourceOccurredAt,
    }));
    await maybeEmitDiscrepancyAlert(client, closed, policy, finalReport, actor, shiftEvent);
    await recordAuditEntry(client, actor, "shift.closed", "shift", String(closed.id), {
      before: rowToShiftSummary(shift),
      after: rowToShiftSummary(closed),
      reason: parsed.discrepancyReason,
      merchantId: scope.merchantId,
      storeId: scope.storeId,
    });
    return { data: finalReport };
  }));
}

export async function forceCloseShift(headers: HeadersLike, shiftId: string, body: ForceCloseShiftInput, actor: OperatorContext, scope: ReportScope) {
  const parsed = ForceCloseShiftSchema.parse(body || {});
  return withActiveReportShiftTransaction(scope, shiftId, async (client) => withScopedIdempotency(client, headers, { shiftId, ...parsed }, scope.merchantId, SHIFT_OPS.forceCloseShift, async () => {
    const shift = await getShiftForReportScope(client, shiftId, scope, true);
    if (!["open", "closing"].includes(String(shift.status))) {
      throw new PlatformError("invalid_shift_state", "Only an open shift can be force closed", 409);
    }
    const operatingScope: OperatingScope = {
      scopeKind: "operating",
      merchantId: String(shift.merchant_id),
      storeId: String(shift.store_id),
      stockLocationId: String(shift.stock_location_id),
    };
    const policy = await getPolicyForClient(client, operatingScope);
    const openedAt = new Date(iso(shift.opened_at)).getTime();
    const staleMs = policy.staleAfterMinutes * 60_000;
    if (Date.now() - openedAt < staleMs) {
      throw new PlatformError("shift_not_stale", "Only stale shifts can be force closed", 409, {
        staleAfterMinutes: policy.staleAfterMinutes,
      });
    }
    const countedCashAmount = parsed.countedCashAmount === undefined
      ? undefined
      : nonNegativeMoney(parsed.countedCashAmount, "countedCashAmount");
    const preCloseReport = await buildShiftReportForClient(client, shift, countedCashAmount);
    const variance = countedCashAmount === undefined ? null : Number(preCloseReport.shift.cashVarianceAmount || 0);
    const row = requireReturned(await queryOne<ShiftRow>(client, `
      UPDATE app.work_shifts
      SET status = 'force_closed',
          force_closed_by = $2,
          force_closed_at = now(),
          closed_by = COALESCE(closed_by, $2),
          closed_at = COALESCE(closed_at, now()),
          blind_cash_count_amount = COALESCE($3, blind_cash_count_amount),
          expected_cash_amount = $4,
          cash_variance_amount = $5,
          closing_note = $6,
          outgoing_handover_note = $7,
          z_report_payload = $8::jsonb,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `, [
      shiftId,
      actor.operatorId,
      countedCashAmount ?? null,
      preCloseReport.cashExpected,
      variance,
      parsed.reason,
      nullableText(parsed.outgoingHandoverNote),
      JSON.stringify({ calculatedAt: new Date().toISOString(), closeType: "force_close", report: preCloseReport, reason: parsed.reason }),
    ]), "Shift force-close update did not return a row");
    const finalReport = await buildShiftReportForClient(client, row, countedCashAmount);
    const shiftEvent = await appendShiftEvent(client, {
      shiftId,
      scope: operatingScope,
      eventType: "shift.force_closed",
      actor,
      reason: parsed.reason,
      before: rowToShiftSummary(shift),
      after: rowToShiftSummary(row),
    });
    await emitExactOutbox(client, buildExactShiftLifecycleEvent({
      shiftId,
      merchantId: operatingScope.merchantId,
      storeId: operatingScope.storeId,
      stockLocationId: operatingScope.stockLocationId,
      eventType: "shift.force_closed",
      shiftEventId: shiftEvent.eventId,
      sourceOccurredAt: shiftEvent.sourceOccurredAt,
    }));
    await maybeEmitDiscrepancyAlert(client, row, policy, finalReport, actor, shiftEvent);
    await recordAuditEntry(client, actor, "shift.force_closed", "shift", shiftId, {
      before: rowToShiftSummary(shift),
      after: rowToShiftSummary(row),
      reason: parsed.reason,
      merchantId: operatingScope.merchantId,
      storeId: operatingScope.storeId,
    });
    return { data: finalReport };
  }));
}

export async function reviewShift(headers: HeadersLike, shiftId: string, body: ReviewShiftInput, actor: OperatorContext, scope: ReportScope) {
  const parsed = ReviewShiftSchema.parse(body || {});
  if (parsed.reviewStatus === "flagged" && !text(parsed.reason)) {
    throw new PlatformError("validation_error", "reason is required when flagging a shift", 400);
  }
  return withActiveReportShiftTransaction(scope, shiftId, async (client) => withScopedIdempotency(client, headers, { shiftId, ...parsed }, scope.merchantId, SHIFT_OPS.reviewShift, async () => {
    const shift = await getShiftForReportScope(client, shiftId, scope, true);
    if (!["closed", "force_closed"].includes(String(shift.status))) {
      throw new PlatformError("invalid_shift_state", "Only a closed shift can be reviewed", 409);
    }
    const row = requireReturned(await queryOne<ShiftRow>(client, `
      UPDATE app.work_shifts
      SET review_status = $2,
          reviewed_by = $3,
          reviewed_at = now(),
          review_reason = $4,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `, [shiftId, parsed.reviewStatus, actor.operatorId, nullableText(parsed.reason)]), "Shift review update did not return a row");
    const operatingScope = {
      merchantId: String(row.merchant_id),
      storeId: String(row.store_id),
      stockLocationId: String(row.stock_location_id),
    };
    await appendShiftEvent(client, {
      shiftId,
      scope: operatingScope,
      eventType: parsed.reviewStatus === "approved" ? "shift.review_approved" : "shift.review_flagged",
      actor,
      reason: parsed.reason || null,
      before: rowToShiftSummary(shift),
      after: rowToShiftSummary(row),
    });
    await recordAuditEntry(client, actor, `shift.${parsed.reviewStatus}`, "shift", shiftId, {
      before: rowToShiftSummary(shift),
      after: rowToShiftSummary(row),
      reason: parsed.reason,
      merchantId: String(row.merchant_id),
      storeId: String(row.store_id),
    });
    return { data: rowToShiftSummary(row) };
  }));
}

export async function listShifts(scope: ReportScope, filters: ShiftListFilters = {}) {
  return withClient(async (client) => {
    const limit = Math.min(100, Math.max(1, Number(filters.limit || 25)));
    const offset = Math.max(0, Number(filters.offset || 0));
    const clauses = ["merchant_id = $1", "(cardinality($2::text[]) = 0 OR store_id = ANY($2::text[]))"];
    const values: unknown[] = [scope.merchantId, scope.storeIds || []];
    const add = (clause: string, value: unknown) => {
      values.push(value);
      clauses.push(clause.replace(/\?/g, `$${values.length}`));
    };
    if (filters.status) add("status = ?", text(filters.status));
    if (filters.reviewStatus) add("review_status = ?", text(filters.reviewStatus));
    if (filters.storeId) add("store_id = ?", text(filters.storeId));
    if (filters.operatorId) add("opened_by = ?", text(filters.operatorId));
    const dateFrom = parseDate(filters.dateFrom, "dateFrom");
    if (dateFrom) add("opened_at >= ?::timestamptz", dateFrom);
    const dateTo = parseDate(filters.dateTo, "dateTo");
    if (dateTo) add("opened_at <= ?::timestamptz", dateTo);
    const where = clauses.join(" AND ");
    const rows = await client.query<ShiftRow>(`
      SELECT *
      FROM app.work_shifts
      WHERE ${where}
      ORDER BY opened_at DESC, id DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `, [...values, limit, offset]);
    const count = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM app.work_shifts
      WHERE ${where}
    `, values);
    return {
      data: rows.rows.map(rowToShiftSummary),
      count: Number(count.rows[0]?.count || 0),
      limit,
      offset,
    };
  });
}

export async function listMyShifts(actor: OperatorContext, scope: ReportScope, filters: ShiftListFilters = {}) {
  return listShifts(scope, { ...filters, operatorId: actor.operatorId });
}

export async function getShiftReport(shiftId: string, scope: ReportScope) {
  return withClient(async (client) => {
    const shift = await getShiftForReportScope(client, shiftId, scope);
    return { data: await buildShiftReportForClient(client, shift) };
  });
}

export async function getMyShiftReport(shiftId: string, actor: OperatorContext, scope: ReportScope) {
  return withClient(async (client) => {
    const shift = await getShiftForActorReportScope(client, shiftId, actor, scope);
    return { data: await buildShiftReportForClient(client, shift) };
  });
}
