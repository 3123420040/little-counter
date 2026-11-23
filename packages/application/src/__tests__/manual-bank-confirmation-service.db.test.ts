import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import {
  confirmInitialManualBankPaymentWithClientV1,
} from "../services/manual-bank-confirmation-service";
import { completeSale, refundOrder } from "../services/order-service";
import { getOrder } from "../services/order-service";
import { applyOrderCorrection, previewOrderCorrection } from "../services/order-correction-service";
import { confirmCorrectionManualBankPaymentWithClientV1 } from "../services/manual-bank-correction-confirmation-service";
import type { OperatorContext } from "../services/auth-service";
import { signJwt } from "../middleware/auth";
import { POST as confirmManualBankRoute } from "../../../../src/api/platform/admin/orders/[id]/manual-bank-confirmation/route";
import type { MedusaRequest, MedusaResponse } from "../../../../src/lib/http-types";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const scope = {
  scopeKind: "operating" as const,
  merchantId: "merchant_default",
  storeId: "store_default",
  stockLocationId: "sloc_default",
};
const actor: OperatorContext = {
  operatorId: "op_uat_financial_owner",
  role: "owner",
  displayName: "Financial UAT Owner",
  organizationId: "org_uat_financial",
  requestId: `db-manual-bank-${runId}`,
};

let client: PoolClient;
let variantId = "";
let inventoryLevelId = "";
let baselineStock = 0;
const originalManualBankFlag = process.env.MANUAL_BANK_CONFIRMATION_ENABLED;

function mockResponse() {
  let statusCode = 200;
  let payload: unknown;
  const res: MedusaResponse = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      payload = body;
    },
    send(body: unknown) {
      payload = body;
    },
    setHeader() {},
  };
  return {
    res,
    get statusCode() { return statusCode; },
    get payload() { return payload; },
  };
}

function authToken(operatorId: string, role: string, organizationId = "org_default") {
  return signJwt({
    operatorId,
    role,
    displayName: `${role} GAP-23 test`,
    organizationId,
    sessionVersion: 1,
    authState: "authenticated",
  });
}

beforeAll(async () => {
  process.env.MANUAL_BANK_CONFIRMATION_ENABLED = "true";
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  const variant = await client.query<{
    variant_id: string;
    inventory_level_id: string;
    stocked_quantity: string;
  }>(`
    SELECT variants.id AS variant_id,
           levels.id AS inventory_level_id,
           levels.stocked_quantity::text
    FROM app.stores stores
    JOIN public.inventory_level levels
      ON levels.location_id = stores.stock_location_id
     AND levels.deleted_at IS NULL
     AND levels.stocked_quantity >= 3
    JOIN public.product_variant_inventory_item links
      ON links.inventory_item_id = levels.inventory_item_id
     AND links.deleted_at IS NULL
    JOIN public.product_variant variants
      ON variants.id = links.variant_id
     AND variants.deleted_at IS NULL
    JOIN inventory.product_settings settings
      ON settings.variant_id = variants.id
     AND settings.merchant_id = stores.merchant_id
     AND settings.cost_price IS NOT NULL
    WHERE stores.merchant_id = $1
      AND stores.id = $2
      AND EXISTS (
        SELECT 1
        FROM public.product_variant_price_set variant_prices
        JOIN public.price prices ON prices.price_set_id = variant_prices.price_set_id
        WHERE variant_prices.variant_id = variants.id
          AND prices.amount > 0
      )
    ORDER BY variants.id
    LIMIT 1
  `, [scope.merchantId, scope.storeId]);
  variantId = String(variant.rows[0]?.variant_id || "");
  if (!variantId) throw new Error("manual-bank DB test requires one in-stock priced/costed UAT variant");
  inventoryLevelId = String(variant.rows[0]!.inventory_level_id);
  baselineStock = Number(variant.rows[0]!.stocked_quantity);
  await client.query(`
    UPDATE public.inventory_level
    SET stocked_quantity = $2, updated_at = now()
    WHERE id = $1
  `, [inventoryLevelId, baselineStock + 20]);
});

afterAll(async () => {
  if (client && inventoryLevelId) {
    await client.query(`
      UPDATE public.inventory_level
      SET stocked_quantity = $2, updated_at = now()
      WHERE id = $1
    `, [inventoryLevelId, baselineStock]).catch(() => undefined);
  }
  if (originalManualBankFlag === undefined) delete process.env.MANUAL_BANK_CONFIRMATION_ENABLED;
  else process.env.MANUAL_BANK_CONFIRMATION_ENABLED = originalManualBankFlag;
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

async function createPendingBankOrder(label: string, quantity = 1) {
  const result = await completeSale({
    "idempotency-key": `db-test:${runId}:manual-bank-order:${label}`,
  }, {
    items: [{ variantId, quantity }],
    paymentMethod: "bank_transfer",
    amountReceived: 0,
    notes: `Manual bank confirmation DB test ${runId} ${label}`,
    salesChannel: "pos_counter",
  }, actor, scope);
  expect(result.statusCode).toBe(201);
  return {
    orderId: String(result.response.data.orderId),
    totalMinor: Number(result.response.data.total),
    createdAt: String(result.response.data.createdAt),
  };
}

async function confirmation(
  orderId: string,
  intentKey: string,
  sourceReference: string,
  confirmedAt: string,
) {
  const connection = await connectPlatformClient();
  try {
    return await confirmInitialManualBankPaymentWithClientV1(
      connection,
      { "idempotency-key": intentKey },
      orderId,
      { sourceReference, confirmedAt },
      actor,
      scope,
      { enabled: true },
    );
  } finally {
    connection.release();
  }
}

describe("GAP-23 real PostgreSQL manual-bank confirmation", () => {
  it("keeps order creation pending, posts once, replays exactly and reconciles audit/components", async () => {
    const order = await createPendingBankOrder("replay");
    const before = await client.query<{
      status: string;
      method: string;
      amount_minor: string;
      posted_count: number;
      allocation_count: number;
    }>(`
      SELECT pending.status,
             pending.method,
             pending.amount_minor::text,
             count(*) FILTER (WHERE all_events.status = 'posted')::int AS posted_count,
             count(allocations.id)::int AS allocation_count
      FROM app.payment_events pending
      LEFT JOIN app.payment_events all_events
        ON all_events.merchant_id = pending.merchant_id
       AND all_events.store_id = pending.store_id
       AND all_events.order_id = pending.order_id
      LEFT JOIN app.payment_event_allocations allocations
        ON allocations.payment_event_id = pending.id
      WHERE pending.merchant_id = $1
        AND pending.store_id = $2
        AND pending.order_id = $3
        AND pending.method = 'manual_bank'
        AND pending.status = 'pending'
      GROUP BY pending.id
    `, [scope.merchantId, scope.storeId, order.orderId]);
    expect(before.rows).toEqual([{
      status: "pending",
      method: "manual_bank",
      amount_minor: String(order.totalMinor),
      posted_count: 0,
      allocation_count: 0,
    }]);

    const intentKey = `manual-bank-confirmation:${runId}:replay`;
    const sourceReference = `uat-bank-slip-${runId}-replay`;
    const confirmedAt = new Date(Math.max(Date.now(), Date.parse(order.createdAt))).toISOString();
    const inserted = await confirmation(order.orderId, intentKey, sourceReference, confirmedAt);
    const replayed = await confirmation(order.orderId, intentKey, sourceReference, confirmedAt);
    expect(inserted).toMatchObject({ statusCode: 201, response: { data: { outcome: "inserted" } } });
    expect(replayed).toMatchObject({ statusCode: 200, response: { data: { outcome: "replayed" } } });
    expect(replayed.response.data.paymentEventId).toBe(inserted.response.data.paymentEventId);

    await expect(confirmation(
      order.orderId,
      intentKey,
      `${sourceReference}-changed`,
      confirmedAt,
    )).rejects.toMatchObject({ code: "manual_bank_confirmation_conflict", statusCode: 409 });

    const evidence = await client.query<{
      pending_count: number;
      posted_count: number;
      evidence_count: number;
      component_count: number;
      allocation_count: number;
      allocated_minor: string;
      audit_count: number;
      audit_actor: string;
    }>(`
      SELECT
        count(DISTINCT events.id) FILTER (WHERE events.status = 'pending')::int AS pending_count,
        count(DISTINCT events.id) FILTER (WHERE events.status = 'posted')::int AS posted_count,
        count(DISTINCT evidence.id)::int AS evidence_count,
        count(DISTINCT components.id)::int AS component_count,
        count(DISTINCT allocations.id)::int AS allocation_count,
        coalesce(max(allocations.amount_minor), 0)::text AS allocated_minor,
        count(DISTINCT audit.id)::int AS audit_count,
        max(audit.actor_id) AS audit_actor
      FROM app.payment_events events
      LEFT JOIN app.payment_event_evidence evidence
        ON evidence.payment_event_id = events.id
      LEFT JOIN app.payment_event_component_allocations components
        ON components.payment_event_id = events.id
      LEFT JOIN app.payment_event_allocations allocations
        ON allocations.payment_event_id = events.id
      LEFT JOIN audit.events audit
        ON audit.subject_type = 'order'
       AND audit.subject_id = events.order_id
       AND audit.action = 'payment.manual_bank_confirmed'
      WHERE events.merchant_id = $1
        AND events.store_id = $2
        AND events.order_id = $3
    `, [scope.merchantId, scope.storeId, order.orderId]);
    expect(evidence.rows).toEqual([{
      pending_count: 1,
      posted_count: 1,
      evidence_count: 1,
      component_count: 2,
      allocation_count: 1,
      allocated_minor: String(order.totalMinor),
      audit_count: 1,
      audit_actor: actor.operatorId,
    }]);

    const posted = await client.query<{ amount_minor: string; component_total_minor: string }>(`
      SELECT events.amount_minor::text,
             components.total_minor::text AS component_total_minor
      FROM app.payment_events events
      JOIN app.payment_event_component_allocations components
        ON components.payment_event_id = events.id
      WHERE events.id = $1
    `, [inserted.response.data.paymentEventId]);
    expect(posted.rows).toEqual([{
      amount_minor: String(order.totalMinor),
      component_total_minor: String(order.totalMinor),
    }]);
  });

  it("serializes concurrent identical confirmations into one insert and one exact replay", async () => {
    const order = await createPendingBankOrder("concurrent");
    const intentKey = `manual-bank-confirmation:${runId}:concurrent`;
    const sourceReference = `uat-bank-slip-${runId}-concurrent`;
    const confirmedAt = new Date(Math.max(Date.now(), Date.parse(order.createdAt))).toISOString();
    const outcomes = await Promise.all([
      confirmation(order.orderId, intentKey, sourceReference, confirmedAt),
      confirmation(order.orderId, intentKey, sourceReference, confirmedAt),
    ]);
    expect(outcomes.map((result) => result.response.data.outcome).sort())
      .toEqual(["inserted", "replayed"]);
    expect(new Set(outcomes.map((result) => result.response.data.paymentEventId)).size).toBe(1);

    const counts = await client.query<{ posted_count: number; audit_count: number }>(`
      SELECT
        count(DISTINCT events.id) FILTER (WHERE events.status = 'posted')::int AS posted_count,
        count(DISTINCT audit.id)::int AS audit_count
      FROM app.payment_events events
      LEFT JOIN audit.events audit
        ON audit.subject_type = 'order'
       AND audit.subject_id = events.order_id
       AND audit.action = 'payment.manual_bank_confirmed'
      WHERE events.merchant_id = $1
        AND events.store_id = $2
        AND events.order_id = $3
    `, [scope.merchantId, scope.storeId, order.orderId]);
    expect(counts.rows).toEqual([{ posted_count: 1, audit_count: 1 }]);
  });

  it("times out under lock contention without a partial payment or audit write", async () => {
    const order = await createPendingBankOrder("lock-timeout");
    const obligation = await client.query<{ id: string }>(`
      SELECT id::text
      FROM app.commercial_obligations
      WHERE merchant_id = $1
        AND store_id = $2
        AND order_id = $3
        AND obligation_kind = 'order_charge'
      LIMIT 1
    `, [scope.merchantId, scope.storeId, order.orderId]);
    const obligationId = String(obligation.rows[0]?.id || "");
    expect(obligationId).toBeTruthy();

    const holder = await connectPlatformClient();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`obligation:${scope.merchantId}:${scope.storeId}:${obligationId}`],
      );
      await expect(confirmation(
        order.orderId,
        `manual-bank-confirmation:${runId}:lock-timeout`,
        `uat-bank-slip-${runId}-lock-timeout`,
        new Date(Math.max(Date.now(), Date.parse(order.createdAt))).toISOString(),
      )).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }

    const residue = await client.query<{ posted_count: number; audit_count: number }>(`
      SELECT
        count(DISTINCT events.id) FILTER (WHERE events.status = 'posted')::int AS posted_count,
        count(DISTINCT audit.id)::int AS audit_count
      FROM app.payment_events events
      LEFT JOIN audit.events audit
        ON audit.subject_type = 'order'
       AND audit.subject_id = events.order_id
       AND audit.action = 'payment.manual_bank_confirmed'
      WHERE events.merchant_id = $1
        AND events.store_id = $2
        AND events.order_id = $3
    `, [scope.merchantId, scope.storeId, order.orderId]);
    expect(residue.rows).toEqual([{ posted_count: 0, audit_count: 0 }]);
  });

  it("cannot read or confirm an order through a different operating store", async () => {
    const order = await createPendingBankOrder("cross-store");
    const connection = await connectPlatformClient();
    try {
      await expect(confirmInitialManualBankPaymentWithClientV1(
        connection,
        { "idempotency-key": `manual-bank-confirmation:${runId}:cross-store` },
        order.orderId,
        {
          sourceReference: `uat-bank-slip-${runId}-cross-store`,
          confirmedAt: new Date(Math.max(Date.now(), Date.parse(order.createdAt))).toISOString(),
        },
        actor,
        { ...scope, storeId: "store_uat_a2", stockLocationId: "sloc_uat_a2" },
        { enabled: true },
      )).rejects.toMatchObject({
        code: "manual_bank_confirmation_unavailable",
        statusCode: 409,
      });
    } finally {
      connection.release();
    }
  });

  it("enforces accounting:write and server-side order target scope at the HTTP route", async () => {
    const deniedOrder = await createPendingBankOrder("route-denied");
    const denied = mockResponse();
    await confirmManualBankRoute({
      params: { id: deniedOrder.orderId },
      headers: {
        authorization: `Bearer ${authToken("op_staff1", "staff")}`,
        "x-operating-merchant-id": scope.merchantId,
        "x-operating-store-id": scope.storeId,
        "idempotency-key": `manual-bank-confirmation:${runId}:route-denied`,
      },
      body: {
        sourceReference: `uat-bank-slip-${runId}-route-denied`,
        confirmedAt: new Date(Math.max(Date.now(), Date.parse(deniedOrder.createdAt))).toISOString(),
      },
    } as unknown as MedusaRequest, denied.res);
    expect(denied.statusCode).toBe(403);
    expect(denied.payload).toMatchObject({ error: { code: "forbidden" } });

    const crossStore = mockResponse();
    await confirmManualBankRoute({
      params: { id: deniedOrder.orderId },
      headers: {
        authorization: `Bearer ${authToken("op_owner", "owner")}`,
        "x-operating-merchant-id": "merchant_default",
        "x-operating-store-id": "store_uat_a2",
        "idempotency-key": `manual-bank-confirmation:${runId}:route-cross-store`,
      },
      body: {
        sourceReference: `uat-bank-slip-${runId}-route-cross-store`,
        confirmedAt: new Date(Math.max(Date.now(), Date.parse(deniedOrder.createdAt))).toISOString(),
      },
    } as unknown as MedusaRequest, crossStore.res);
    expect(crossStore.statusCode).toBe(403);

    const allowedOrder = await createPendingBankOrder("route-allowed");
    const allowed = mockResponse();
    await confirmManualBankRoute({
      params: { id: allowedOrder.orderId },
      headers: {
        authorization: `Bearer ${authToken("op_owner", "owner")}`,
        "x-operating-merchant-id": scope.merchantId,
        "x-operating-store-id": scope.storeId,
        "idempotency-key": `manual-bank-confirmation:${runId}:route-allowed`,
      },
      body: {
        sourceReference: `uat-bank-slip-${runId}-route-allowed`,
        confirmedAt: new Date(Math.max(Date.now(), Date.parse(allowedOrder.createdAt))).toISOString(),
      },
    } as unknown as MedusaRequest, allowed.res);
    expect(allowed.statusCode).toBe(201);
    expect(allowed.payload).toMatchObject({
      data: {
        orderId: allowedOrder.orderId,
        outcome: "inserted",
        method: "manual_bank",
        status: "posted",
      },
    });
  });

  it("keeps a positive bank correction pending, then appends one exact signed-delta confirmation", async () => {
    const order = await createPendingBankOrder("positive-correction");
    const initialConfirmedAt = new Date(Math.max(Date.now(), Date.parse(order.createdAt))).toISOString();
    await confirmation(
      order.orderId,
      `manual-bank-confirmation:${runId}:positive-correction:initial`,
      `uat-bank-slip-${runId}-positive-correction-initial`,
      initialConfirmedAt,
    );

    const preview = await previewOrderCorrection(order.orderId, {
      baseRevision: 0,
      reason: "Bổ sung một hộp còn thiếu cho đơn chuyển khoản UAT.",
      items: [{ variantId, quantity: 2 }],
      settlement: { method: "bank_transfer", amountReceived: 0 },
    }, actor, scope);
    expect(preview.data.totalDelta).toBeGreaterThan(0);
    expect(preview.data.settlement).toMatchObject({
      method: "bank_transfer",
      status: "pending",
      direction: "collect",
    });

    const corrected = await applyOrderCorrection(
      { "idempotency-key": `db-test:${runId}:positive-bank-correction` },
      order.orderId,
      {
        baseRevision: 0,
        reason: "Bổ sung một hộp còn thiếu cho đơn chuyển khoản UAT.",
        items: [{ variantId, quantity: 2 }],
        settlement: {
          method: "bank_transfer",
          amountReceived: preview.data.totalDelta,
        },
      },
      actor,
      scope,
    );
    expect(corrected.response.data.correction).toMatchObject({
      revision: 1,
      totalDelta: preview.data.totalDelta,
      settlementStatus: "pending",
      canonicalPaymentEventId: expect.any(String),
      canonicalObligationId: expect.any(String),
    });

    const pending = await client.query<{
      status: string;
      method: string;
      evidence_type: string | null;
      delta_count: number;
      evidence_count: number;
      allocation_count: number;
    }>(`
      SELECT events.status,
             events.method,
             events.evidence_type,
             count(DISTINCT deltas.payment_event_id)::int AS delta_count,
             count(DISTINCT evidence.id)::int AS evidence_count,
             count(DISTINCT allocations.id)::int AS allocation_count
      FROM app.payment_events events
      LEFT JOIN app.payment_correction_component_deltas deltas
        ON deltas.payment_event_id = events.id
      LEFT JOIN app.payment_event_evidence evidence
        ON evidence.payment_event_id = events.id
      LEFT JOIN app.payment_event_allocations allocations
        ON allocations.payment_event_id = events.id
      WHERE events.id = $1::uuid
      GROUP BY events.id
    `, [corrected.response.data.correction.canonicalPaymentEventId]);
    expect(pending.rows).toEqual([{
      status: "pending",
      method: "manual_bank",
      evidence_type: null,
      delta_count: 1,
      evidence_count: 0,
      allocation_count: 0,
    }]);
    await expect(getOrder(order.orderId, {
      merchantId: scope.merchantId,
      storeIds: [scope.storeId],
    })).resolves.toMatchObject({
      order: {
        paymentStatus: "pending",
        correctionSummary: { hasPendingSettlement: true },
      },
    });

    const input = {
      sourceReference: `uat-bank-slip-${runId}-positive-correction-delta`,
      confirmedAt: new Date().toISOString(),
    };
    const intentKey = `manual-bank-confirmation:${runId}:positive-correction:delta`;
    const firstClient = await connectPlatformClient();
    const secondClient = await connectPlatformClient();
    let inserted;
    let replayed;
    try {
      inserted = await confirmCorrectionManualBankPaymentWithClientV1(
        firstClient,
        { "idempotency-key": intentKey },
        order.orderId,
        input,
        actor,
        scope,
      );
      replayed = await confirmCorrectionManualBankPaymentWithClientV1(
        secondClient,
        { "idempotency-key": intentKey },
        order.orderId,
        input,
        actor,
        scope,
      );
    } finally {
      firstClient.release();
      secondClient.release();
    }
    expect(inserted).toMatchObject({ statusCode: 201, response: { data: { outcome: "inserted" } } });
    expect(replayed).toMatchObject({ statusCode: 200, response: { data: { outcome: "replayed" } } });
    expect(replayed!.response.data.paymentEventId).toBe(inserted!.response.data.paymentEventId);

    const final = await client.query<{
      pending_count: number;
      posted_count: number;
      distinct_contracts: number;
      allocation_count: number;
      allocated_minor: string;
      audit_count: number;
    }>(`
      SELECT
        count(DISTINCT events.id) FILTER (WHERE events.status = 'pending')::int AS pending_count,
        count(DISTINCT events.id) FILTER (WHERE events.status = 'posted')::int AS posted_count,
        count(DISTINCT deltas.contract_fingerprint)::int AS distinct_contracts,
        count(DISTINCT allocations.id)::int AS allocation_count,
        coalesce(max(allocations.amount_minor), 0)::text AS allocated_minor,
        count(DISTINCT audit.id)::int AS audit_count
      FROM app.payment_events events
      LEFT JOIN app.payment_correction_component_deltas deltas
        ON deltas.payment_event_id = events.id
      LEFT JOIN app.payment_event_allocations allocations
        ON allocations.payment_event_id = events.id
      LEFT JOIN audit.events audit
        ON audit.subject_type = 'order'
       AND audit.subject_id = events.order_id
       AND audit.action = 'payment.manual_bank_correction_confirmed'
      WHERE events.merchant_id = $1
        AND events.store_id = $2
        AND events.order_id = $3
        AND events.commercial_revision_id = $4::uuid
    `, [
      scope.merchantId,
      scope.storeId,
      order.orderId,
      corrected.response.data.correction.commercialRevisionId,
    ]);
    expect(final.rows).toEqual([{
      pending_count: 1,
      posted_count: 1,
      distinct_contracts: 1,
      allocation_count: 1,
      allocated_minor: String(preview.data.totalDelta),
      audit_count: 1,
    }]);
    await expect(getOrder(order.orderId, {
      merchantId: scope.merchantId,
      storeIds: [scope.storeId],
    })).resolves.toMatchObject({
      order: {
        paymentStatus: "posted",
        correctionSummary: { hasPendingSettlement: false },
      },
    });
  });

  it("keeps a negative bank correction payable open until one evidenced payout clears it", async () => {
    const order = await createPendingBankOrder("negative-correction", 2);
    await confirmation(
      order.orderId,
      `manual-bank-confirmation:${runId}:negative-correction:initial`,
      `uat-bank-slip-${runId}-negative-correction-initial`,
      new Date(Math.max(Date.now(), Date.parse(order.createdAt))).toISOString(),
    );

    const draft = {
      baseRevision: 0,
      reason: "Giảm một hộp và hoàn lại phần chênh lệch qua ngân hàng.",
      items: [{ variantId, quantity: 1 }],
      settlement: { method: "bank_transfer" as const, amountReceived: 0 },
    };
    const preview = await previewOrderCorrection(order.orderId, draft, actor, scope);
    expect(preview.data.totalDelta).toBeLessThan(0);
    expect(preview.data.settlement).toMatchObject({
      method: "bank_transfer",
      status: "pending",
      direction: "refund",
    });
    const amountMinor = Math.abs(preview.data.totalDelta);
    const corrected = await applyOrderCorrection(
      { "idempotency-key": `db-test:${runId}:negative-bank-correction` },
      order.orderId,
      {
        ...draft,
        settlement: { method: "bank_transfer", amountReceived: amountMinor },
      },
      actor,
      scope,
    );
    expect(corrected.response.data.correction).toMatchObject({
      totalDelta: -amountMinor,
      settlementStatus: "pending",
      customerRefundPayableId: expect.any(String),
      canonicalRefundPaymentEventId: null,
    });
    await expect(getOrder(order.orderId, {
      merchantId: scope.merchantId,
      storeIds: [scope.storeId],
    })).resolves.toMatchObject({
      order: {
        paymentStatus: "posted",
        correctionSummary: { hasPendingSettlement: true },
        canonicalPaymentSummary: { customerRefundPayableMinor: amountMinor },
      },
    });

    const payoutBody = {
      amount: amountMinor,
      method: "bank_transfer" as const,
      sourceReference: `uat-bank-refund-${runId}-negative-correction`,
      paidAt: new Date().toISOString(),
      reason: "Đã hoàn phần chênh lệch qua ngân hàng cho khách.",
      confirmationToken: "",
    };
    const detail = await getOrder(order.orderId, {
      merchantId: scope.merchantId,
      storeIds: [scope.storeId],
    });
    payoutBody.confirmationToken = String(detail.order.orderNumber);
    const intentKey = `db-test:${runId}:negative-bank-correction-payout`;
    const inserted = await refundOrder(
      { "idempotency-key": intentKey },
      order.orderId,
      payoutBody,
      actor,
      { merchantId: scope.merchantId, storeId: scope.storeId },
    );
    const replayed = await refundOrder(
      { "idempotency-key": intentKey },
      order.orderId,
      payoutBody,
      actor,
      { merchantId: scope.merchantId, storeId: scope.storeId },
    );
    expect(inserted.response.data).toMatchObject({
      amount: amountMinor,
      canonicalPaymentEventId: expect.any(String),
      restock: false,
    });
    expect(replayed.response.data.canonicalPaymentEventId)
      .toBe(inserted.response.data.canonicalPaymentEventId);
    await expect(refundOrder(
      { "idempotency-key": intentKey },
      order.orderId,
      { ...payoutBody, sourceReference: `${payoutBody.sourceReference}-changed` },
      actor,
      { merchantId: scope.merchantId, storeId: scope.storeId },
    )).rejects.toMatchObject({ code: "idempotency_conflict", statusCode: 409 });

    const evidence = await client.query<{
      refund_count: number;
      evidence_count: number;
      payable_balance_minor: string;
      payout_audit_count: number;
    }>(`
      SELECT
        count(DISTINCT events.id) FILTER (
          WHERE events.kind = 'refund' AND events.status = 'posted'
        )::int AS refund_count,
        count(DISTINCT evidence.id) FILTER (
          WHERE events.kind = 'refund'
        )::int AS evidence_count,
        coalesce(max(payables.balance_minor), 0)::text AS payable_balance_minor,
        count(DISTINCT audit.id)::int AS payout_audit_count
      FROM app.payment_events events
      LEFT JOIN app.payment_event_evidence evidence
        ON evidence.payment_event_id = events.id
      LEFT JOIN app.customer_refund_payable_balances payables
        ON payables.merchant_id = events.merchant_id
       AND payables.store_id = events.store_id
       AND payables.order_id = events.order_id
      LEFT JOIN audit.events audit
        ON audit.subject_type = 'order'
       AND audit.subject_id = events.order_id
       AND audit.action = 'order.refunded'
      WHERE events.merchant_id = $1
        AND events.store_id = $2
        AND events.order_id = $3
    `, [scope.merchantId, scope.storeId, order.orderId]);
    expect(evidence.rows).toEqual([{
      refund_count: 1,
      evidence_count: 1,
      payable_balance_minor: "0",
      payout_audit_count: 1,
    }]);
    await expect(getOrder(order.orderId, {
      merchantId: scope.merchantId,
      storeIds: [scope.storeId],
    })).resolves.toMatchObject({
      order: {
        correctionSummary: { hasPendingSettlement: false },
        canonicalPaymentSummary: { customerRefundPayableMinor: 0 },
      },
    });
  });
});
