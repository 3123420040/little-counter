import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import { cancelOrder, completeSale, getOrder, listOrders, prepareOrderRecreatePrefill, previewOrderShippingFee, quoteOrderCancellation, refundOrder, updateOrder, updateOrderCustomer, updateOrderShippingFee } from "../services/order-service";
import { applyOrderCorrection, previewOrderCorrection } from "../services/order-correction-service";
import type { OperatorContext } from "../services/auth-service";
import { getReceiptPdfBuffer, getReceiptText } from "../services/receipt-service";
import { processOutboxEvent } from "../services/outbox-processor-service";
import { updateMerchantCheckoutPolicy } from "../services/merchant-checkout-policy-service";
import { getEffectiveOrderFeatureRecreateV1, getEffectiveOrderFeatureRecreateV2, getEffectiveOrderFeatureReceiptTextV1, getEffectiveOrderFeatureReceiptPdfV1 } from "../services/order-financial-feature-route-service";
import { signJwt } from "../middleware/auth";
import { GET as getAdminDashboard } from "../../../../src/api/admin/dashboard/route";
import type { MedusaRequest, MedusaResponse } from "../../../../src/lib/http-types";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const variantId = "var_mint_20";
const emptyStoreId = `store_pos_empty_${runId}`;
const emptyStockLocationId = `sloc_pos_empty_${runId}`;
const actor: OperatorContext = {
  operatorId: "op_owner",
  role: "owner",
  displayName: "DB Test Owner",
  organizationId: "org_default",
};
const operatingScope = {
  scopeKind: "operating" as const,
  merchantId: "merchant_default",
  storeId: "store_default",
  stockLocationId: "sloc_default",
};
const reportScope = {
  scopeKind: "report" as const,
  merchantId: operatingScope.merchantId,
  storeIds: [operatingScope.storeId],
};

const packageEnvKeys = [
  "APP_PACKAGE_KEY",
  "FEATURE_FLAGS",
  "SEPAY_PAYMENTS_ENABLED",
  "SEPAY_LIVE_ENABLED",
  "CRYPTO_PAYMENTS_ENABLED",
  "NOWPAYMENTS_LIVE_ENABLED",
  "CRYPTO_PROVIDER",
] as const;

let client: PoolClient;
let baselineStock = 0;

async function stockForVariant(): Promise<number> {
  const row = await queryOne<{ stocked_quantity: string }>(client, `
    SELECT il.stocked_quantity::numeric AS stocked_quantity
    FROM public.product_variant_inventory_item vii
    JOIN public.inventory_level il ON il.inventory_item_id = vii.inventory_item_id AND il.deleted_at IS NULL
    WHERE vii.variant_id = $1
      AND il.location_id = $2
      AND vii.deleted_at IS NULL
    LIMIT 1
  `, [variantId, operatingScope.stockLocationId]);
  return Number(row?.stocked_quantity || 0);
}

async function ensureStockAtLeast(quantity: number): Promise<void> {
  const current = await stockForVariant();
  if (current >= quantity) return;
  await client.query(`
    UPDATE public.inventory_level il
    SET stocked_quantity = $2, updated_at = now()
    FROM public.product_variant_inventory_item vii
    WHERE vii.inventory_item_id = il.inventory_item_id
      AND vii.variant_id = $1
      AND il.location_id = $3
      AND il.deleted_at IS NULL
      AND vii.deleted_at IS NULL
  `, [variantId, quantity, operatingScope.stockLocationId]);
}

async function setStock(quantity: number): Promise<void> {
  await client.query(`
    UPDATE public.inventory_level il
    SET stocked_quantity = $2, updated_at = now()
    FROM public.product_variant_inventory_item vii
    WHERE vii.inventory_item_id = il.inventory_item_id
      AND vii.variant_id = $1
      AND il.location_id = $3
      AND il.deleted_at IS NULL
      AND vii.deleted_at IS NULL
  `, [variantId, quantity, operatingScope.stockLocationId]);
}

async function setCostPrice(costPrice: number): Promise<void> {
  await client.query(`
    UPDATE inventory.product_settings
    SET cost_price = $2, updated_at = now()
    WHERE variant_id = $1
  `, [variantId, costPrice]);
}

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
    get statusCode() {
      return statusCode;
    },
    get payload() {
      return payload;
    },
  };
}

function snapshotPackageEnv() {
  return Object.fromEntries(packageEnvKeys.map((key) => [key, process.env[key]])) as Record<(typeof packageEnvKeys)[number], string | undefined>;
}

function restorePackageEnv(snapshot: Record<(typeof packageEnvKeys)[number], string | undefined>) {
  for (const key of packageEnvKeys) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await client.query(`
    INSERT INTO public.stock_location (id, name)
    VALUES ($1, $2)
  `, [emptyStockLocationId, `POS Empty Store ${runId}`]);
  await client.query(`
    INSERT INTO app.stores (
      id, merchant_id, display_name, stock_location_id, is_primary, status, metadata
    )
    VALUES (
      $1, $2, $3, $4, false, 'active',
      '{"ownerSettings":{"timezone":"Asia/Ho_Chi_Minh"}}'::jsonb
    )
  `, [emptyStoreId, operatingScope.merchantId, `POS Empty Store ${runId}`, emptyStockLocationId]);
  await client.query("UPDATE public.customer SET merchant_id = 'merchant_default' WHERE id = 'cus_demo' AND merchant_id IS NULL");
  await client.query("UPDATE ai_module.customer_profiles SET merchant_id = 'merchant_default' WHERE customer_id = 'cus_demo' AND merchant_id IS NULL");
  const owner = await client.query("SELECT password_hash FROM medusa.staff_users WHERE operator_id = 'op_owner' LIMIT 1");
  for (const role of ["staff", "manager", "accountant", "owner"] as const) {
    const operatorId = `op_${role}_route_test`;
    await client.query(`
      INSERT INTO medusa.staff_users (operator_id, password_hash, display_name, role, is_active, organization_id)
      VALUES ($1, $2, $3, $4, true, 'org_default')
      ON CONFLICT (operator_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        role = EXCLUDED.role,
        is_active = true,
        organization_id = 'org_default'
    `, [operatorId, owner.rows[0]?.password_hash || "test-password-hash", `${role} route test`, role]);
    await client.query(`
      INSERT INTO app.operator_memberships (
        operator_id, scope_type, merchant_id, store_id, role_key, status, granted_by
      ) VALUES ($1, 'store', $2, $3, $4, 'active', 'db-test')
    `, [operatorId, operatingScope.merchantId, emptyStoreId, role]);
  }
  baselineStock = await stockForVariant();
  await ensureStockAtLeast(5);
});

afterAll(async () => {
  await client?.query(`
    UPDATE public.inventory_level il
    SET stocked_quantity = GREATEST(stocked_quantity, $2), updated_at = now()
    FROM public.product_variant_inventory_item vii
    WHERE vii.inventory_item_id = il.inventory_item_id
      AND vii.variant_id = $1
      AND il.location_id = $3
      AND il.deleted_at IS NULL
      AND vii.deleted_at IS NULL
  `, [variantId, baselineStock, operatingScope.stockLocationId]).catch(() => undefined);
  await client?.query(
    "DELETE FROM app.operator_memberships WHERE operator_id IN ('op_staff_route_test', 'op_manager_route_test', 'op_accountant_route_test', 'op_owner_route_test')",
  ).catch(() => undefined);
  await client?.query("DELETE FROM medusa.staff_users WHERE operator_id IN ('op_staff_route_test', 'op_manager_route_test', 'op_accountant_route_test', 'op_owner_route_test')").catch(() => undefined);
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("POS order PostgreSQL integration", () => {
  it("reads real linked/walk-in recreate and receipts with missing timezone without commercial mutations", async () => {
    await ensureStockAtLeast(6);
    const originalMetadata = (await client.query("SELECT metadata FROM app.stores WHERE id=$1", [operatingScope.storeId])).rows[0].metadata;
    const orders: string[] = [];
    for (const customerMode of ["linked", "walk_in"] as const) {
      const sale = await completeSale({ "idempotency-key": `receipt-timezone-${runId}-${customerMode}` }, {
        items: [{ variantId, quantity: 1 }], paymentMethod: "cash", amountReceived: 2000000,
        customerMode, ...(customerMode === "linked" ? { customerId: "cus_demo" } : {}),
      }, actor, operatingScope);
      orders.push(sale.response.data.orderId);
    }
    async function counters() {
      return (await client.query(`SELECT
        (SELECT count(*)::int FROM public."order" WHERE id=ANY($1::text[])) AS orders,
        (SELECT count(*)::int FROM app.order_commercial_revisions WHERE order_id=ANY($1::text[])) AS revisions,
        (SELECT count(*)::int FROM app.payment_events WHERE order_id=ANY($1::text[])) AS payments,
        (SELECT sum(amount_minor)::text FROM app.payment_events WHERE order_id=ANY($1::text[])) AS amount,
        (SELECT stocked_quantity::text FROM public.inventory_level level JOIN public.product_variant_inventory_item link
          ON link.inventory_item_id=level.inventory_item_id AND link.deleted_at IS NULL
          WHERE link.variant_id=$2 AND level.location_id=$3 AND level.deleted_at IS NULL LIMIT 1) AS stock`,
      [orders,variantId,operatingScope.stockLocationId])).rows[0];
    }
    const before = await counters();
    try {
      for (const timezone of [undefined, null, "", "  ", "UTC", "Asia/Tokyo"]) {
        const settings: Record<string, unknown> = { ...originalMetadata?.ownerSettings };
        delete settings.timezone;
        if (timezone !== undefined) settings.timezone = timezone;
        await client.query("UPDATE app.stores SET metadata=$2::jsonb WHERE id=$1", [operatingScope.storeId, JSON.stringify({ ...originalMetadata, ownerSettings: settings })]);
        for (const [index, orderId] of orders.entries()) {
          const request = { scope: operatingScope, orderId };
          const recreated = await getEffectiveOrderFeatureRecreateV2(request);
          expect(recreated.customerAttribution).toBe(index === 0 ? "linked" : "walk_in");
          expect(recreated.customer?.id ?? null).toBe(index === 0 ? "cus_demo" : null);
          expect(recreated.commercialPrefill.sourceOrder.storeTimeZone).toBe(timezone?.trim() || "Asia/Ho_Chi_Minh");
          expect((await getEffectiveOrderFeatureRecreateV1(request)).sourceOrder.orderId).toBe(orderId);
          expect(await getEffectiveOrderFeatureReceiptTextV1({ scope: reportScope, orderId })).toContain(recreated.commercialPrefill.sourceOrder.orderNumber);
          if (index === 0 && timezone === undefined) expect((await getEffectiveOrderFeatureReceiptPdfV1({ scope: reportScope, orderId })).subarray(0,4).toString()).toBe("%PDF");
          await expect(getEffectiveOrderFeatureRecreateV2({ ...request, scope: { ...operatingScope, storeId: emptyStoreId } }))
            .rejects.toMatchObject({ code: "resource_not_found" });
        }
      }
      await client.query("UPDATE app.stores SET metadata=jsonb_build_object('ownerSettings',jsonb_build_object('timezone','Invalid/Zone')) WHERE id=$1", [operatingScope.storeId]);
      await expect(getEffectiveOrderFeatureRecreateV2({ scope: operatingScope, orderId: orders[0]! })).rejects.toMatchObject({ statusCode: 422 });
      expect(await counters()).toEqual(before);
    } finally {
      await client.query("UPDATE app.stores SET metadata=$2::jsonb WHERE id=$1", [operatingScope.storeId,JSON.stringify(originalMetadata)]);
    }
  });
  it("binds own cancellation keys to actor/order and rejects legacy receipt reuse for another target", async () => {
    await ensureStockAtLeast(6);
    const staff = { ...actor, operatorId: "op_staff1", role: "staff" };
    const body = { items: [{ variantId, quantity: 1 }], paymentMethod: "cash", amountReceived: 2000000 };
    const first = (await completeSale({ "idempotency-key": `bound-first-${runId}` }, body, staff, operatingScope)).response.data.id;
    const second = (await completeSale({ "idempotency-key": `bound-second-${runId}` }, body, staff, operatingScope)).response.data.id;
    const quote = (await quoteOrderCancellation(first, operatingScope, staff)).quote;
    const cancellation = { reason: "Staff incorrect entry binding", quoteId: quote.quoteId,
      effectiveRevision: quote.effectiveRevision, quoteGeneratedAt: quote.generatedAt };
    const headers = { "idempotency-key": `bound-own-${runId}` };
    await cancelOrder(headers, first, cancellation, staff, operatingScope);
    await expect(cancelOrder(headers, second, cancellation, staff, operatingScope)).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(cancelOrder(headers, first, cancellation, { ...staff, operatorId: "op_staff_other" }, operatingScope))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(cancelOrder(headers, first, cancellation, staff, { ...operatingScope, storeId: emptyStoreId }))
      .rejects.toMatchObject({ code: "forbidden" });
    const managerQuote = (await quoteOrderCancellation(second, operatingScope, actor)).quote;
    const managerBody = { reason: "Manager receipt target binding", quoteId: managerQuote.quoteId,
      effectiveRevision: managerQuote.effectiveRevision, quoteGeneratedAt: managerQuote.generatedAt };
    const managerHeaders = { "idempotency-key": `bound-manager-${runId}` };
    await cancelOrder(managerHeaders, second, managerBody, actor, operatingScope);
    await expect(cancelOrder(managerHeaders, first, managerBody, actor, operatingScope))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("serializes staff and manager cancellation with different keys and preserves scoped replay", async () => {
    await ensureStockAtLeast(5);
    const stockBefore = await stockForVariant();
    const staff = { ...actor, operatorId: "op_staff1", role: "staff" };
    const sale = await completeSale({ "idempotency-key": `race-sale-${runId}` }, {
      items: [{ variantId, quantity: 1 }], paymentMethod: "cash", amountReceived: 2000000,
    }, staff, operatingScope);
    const orderId = sale.response.data.id;
    const { quote } = await quoteOrderCancellation(orderId, operatingScope, staff);
    const body = { reason: "Incorrect staff order race", quoteId: quote.quoteId,
      effectiveRevision: quote.effectiveRevision, quoteGeneratedAt: quote.generatedAt };
    const results = await Promise.allSettled([
      cancelOrder({ "idempotency-key": `race-staff-${runId}` }, orderId, body, staff, operatingScope),
      cancelOrder({ "idempotency-key": `race-manager-${runId}` }, orderId, body, actor, operatingScope),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((results.find((x) => x.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "invalid_state_transition" });
    expect(await stockForVariant()).toBe(stockBefore);
    const restored = await client.query("SELECT count(*)::int AS n FROM medusa.stock_movements WHERE reference_id=$1 AND movement_type='return'", [orderId]);
    expect(restored.rows[0].n).toBe(1);
  });

  it("blocks forged found-stock when OFF without changing business aggregates, preserves normal sale", async () => {
    const metadata = (await client.query("SELECT metadata FROM app.merchants WHERE id=$1", [operatingScope.merchantId])).rows[0].metadata;
    try {
      await client.query("UPDATE app.merchants SET metadata=metadata - 'foundStockCheckout' WHERE id=$1", [operatingScope.merchantId]);
      await updateMerchantCheckoutPolicy(operatingScope.merchantId, { enabled: false, expectedVersion: 0 }, actor);
      await setStock(0);
      const before = await client.query(`SELECT (SELECT count(*) FROM public."order") AS orders,
        (SELECT count(*) FROM medusa.stock_movements) AS movements,
        (SELECT count(*) FROM app.payment_entries) AS payments`);
      await expect(completeSale({ "idempotency-key": `policy-off-${runId}` }, {
        items: [{ variantId, quantity: 2 }], paymentMethod: "cash", amountReceived: 2000000,
        foundStockConfirmation: { confirmed: true, acknowledgedShortages: [{ variantId, shortageQuantity: 2 }] },
      }, actor, operatingScope)).rejects.toMatchObject({ code: "insufficient_stock" });
      expect((await client.query(`SELECT (SELECT count(*) FROM public."order") AS orders,
        (SELECT count(*) FROM medusa.stock_movements) AS movements,
        (SELECT count(*) FROM app.payment_entries) AS payments`)).rows).toEqual(before.rows);
      expect(await stockForVariant()).toBe(0);
      await setStock(3);
      expect((await completeSale({ "idempotency-key": `policy-in-stock-${runId}` }, {
        items: [{ variantId, quantity: 1 }], paymentMethod: "cash", amountReceived: 2000000,
      }, actor, operatingScope)).statusCode).toBe(201);
    } finally {
      await client.query("UPDATE app.merchants SET metadata=$2::jsonb WHERE id=$1", [operatingScope.merchantId, JSON.stringify(metadata)]);
      await ensureStockAtLeast(5);
    }
  });

  it("returns a committed found-stock receipt after OFF and cancels it once as its staff creator", async () => {
    const metadata = (await client.query("SELECT metadata FROM app.merchants WHERE id=$1", [operatingScope.merchantId])).rows[0].metadata;
    const staff = { ...actor, operatorId: "op_staff1", role: "staff" };
    try {
      await client.query("UPDATE app.merchants SET metadata=metadata - 'foundStockCheckout' WHERE id=$1", [operatingScope.merchantId]);
      await setStock(0);
      const payload = { items: [{ variantId, quantity: 2 }], paymentMethod: "cash", amountReceived: 2000000,
        foundStockConfirmation: { confirmed: true, acknowledgedShortages: [{ variantId, shortageQuantity: 2 }] } };
      const headers = { "idempotency-key": `policy-replay-${runId}` };
      const created = await completeSale(headers, payload, staff, operatingScope);
      await updateMerchantCheckoutPolicy(operatingScope.merchantId, { enabled: false, expectedVersion: 0 }, actor);
      expect((await completeSale(headers, payload, staff, operatingScope)).response).toEqual(created.response);
      expect(await stockForVariant()).toBe(0);
      const orderId = created.response.data.id;
      await expect(quoteOrderCancellation(orderId, operatingScope, { ...staff, operatorId: "op_staff_other" }))
        .rejects.toMatchObject({ statusCode: 403 });
      const { quote } = await quoteOrderCancellation(orderId, operatingScope, staff);
      const cancelBody = { reason: "Staff entered wrong quantity", quoteId: quote.quoteId,
        effectiveRevision: quote.effectiveRevision, quoteGeneratedAt: quote.generatedAt };
      const key = { "idempotency-key": `own-cancel-${runId}` };
      const canceled = await cancelOrder(key, orderId, cancelBody, staff, operatingScope);
      expect(canceled.response.financial.customerRefundPayableMinor).toBeGreaterThan(0);
      expect((await cancelOrder(key, orderId, cancelBody, staff, operatingScope)).response).toEqual(canceled.response);
      expect(await stockForVariant()).toBe(2);
      const movements = await client.query("SELECT reason, count(*)::int AS n FROM medusa.stock_movements WHERE reference_id=$1 GROUP BY reason", [orderId]);
      expect(movements.rows.every((r) => r.n === 1)).toBe(true);
    } finally {
      await client.query("UPDATE app.merchants SET metadata=$2::jsonb WHERE id=$1", [operatingScope.merchantId, JSON.stringify(metadata)]);
      await ensureStockAtLeast(5);
    }
  });

  it("denies staff dashboard API while manager, accountant, and owner are allowed", async () => {
    async function requestDashboard(role: "staff" | "manager" | "accountant" | "owner") {
      const token = signJwt({
        operatorId: `op_${role}_route_test`,
        role,
        displayName: role,
        organizationId: "org_default",
        sessionVersion: 1,
        authState: "authenticated",
      });
      const response = mockResponse();
      await getAdminDashboard({
        headers: {
          authorization: `Bearer ${token}`,
          "x-report-merchant-id": operatingScope.merchantId,
          "x-report-store-ids": emptyStoreId,
        },
        query: { from: "2026-01-01", to: "2026-01-01" },
      } as MedusaRequest, response.res);
      return response;
    }

    const staff = await requestDashboard("staff");
    expect(staff.statusCode).toBe(403);
    expect(staff.payload).toMatchObject({
      error: { code: "forbidden" },
    });

    await expect(requestDashboard("manager")).resolves.toMatchObject({ statusCode: 200 });
    await expect(requestDashboard("accountant")).resolves.toMatchObject({ statusCode: 200 });
    await expect(requestDashboard("owner")).resolves.toMatchObject({ statusCode: 200 });
  });

  it("completes a POS sale idempotently and records ledger, audit, stock, and outbox effects", async () => {
    const stockBefore = await stockForVariant();
    const body = {
      customerId: "cus_demo",
      customerMode: "linked" as const,
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
      notes: `DB POS sale ${runId}`,
      salesChannel: "zalo",
    };
    const headers = { "idempotency-key": `db-test:${runId}:pos-sale` };

    const created = await completeSale(headers, body, actor, operatingScope);
    const replay = await completeSale(headers, body, actor, operatingScope);

    expect(created.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.response).toEqual(created.response);

    const order = created.response.data;
    expect(order).toMatchObject({
      status: "completed",
      paymentMethod: "cash",
      customerId: "cus_demo",
      notes: `DB POS sale ${runId}`,
      salesChannel: "zalo",
      salesChannelLabel: "Zalo",
    });
    expect(order.createdAt).toBe(order.created_at);
    expect(new Date(String(order.createdAt)).toString()).not.toBe("Invalid Date");
    expect(order.createdBy).toMatchObject({
      operatorId: actor.operatorId,
      role: actor.role,
    });
    expect(order.createdBy.displayName).toBeTruthy();
    expect(order.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        variantId,
        name: expect.any(String),
      }),
    ]));
    const soldItem = order.items.find((item: { variantId: string }) => item.variantId === variantId);
    expect(Number(soldItem?.quantity)).toBe(1);
    expect(Number(soldItem?.lineTotal)).toBeGreaterThan(0);
    await expect(stockForVariant()).resolves.toBe(stockBefore - 1);

    const payments = await client.query(`
      SELECT direction, method, amount::numeric AS amount, status, merchant_id, store_id, metadata
      FROM app.payment_entries
      WHERE order_id = $1
      ORDER BY created_at ASC
    `, [order.orderId]);
    expect(payments.rows).toHaveLength(1);
    expect(payments.rows[0]).toMatchObject({
      direction: "charge",
      method: "cash",
      status: "posted",
      merchant_id: "merchant_default",
      store_id: "store_default",
      metadata: expect.objectContaining({
        source: "pos",
        amountReceived: 1000000,
      }),
    });

    const audit = await client.query(`
      SELECT action, channel, channel_user_id, after
      FROM audit.events
      WHERE subject_type = 'order' AND subject_id = $1
      ORDER BY created_at ASC
    `, [order.orderId]);
    expect(audit.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "order.created",
        channel: null,
        channel_user_id: null,
        after: expect.objectContaining({
          customerId: "cus_demo",
          customerMode: "linked",
        }),
      }),
    ]));

    const outbox = await client.query(`
      SELECT event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1
      ORDER BY created_at ASC
    `, [order.orderId]);
    expect(outbox.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: "sale.created",
        payload: expect.objectContaining({
          source: "pos",
          customerId: "cus_demo",
          paymentStatus: "posted",
        }),
      }),
    ]));

    const receiptByNumber = await getReceiptText(String(order.orderNumber), reportScope);
    const receiptById = await getReceiptText(String(order.orderId), reportScope);
    expect(receiptByNumber).toContain(String(order.orderNumber));
    expect(receiptById).toContain(String(order.orderNumber));
    expect(receiptByNumber).toContain("Total:");

    const receiptPdf = await getReceiptPdfBuffer(String(order.orderNumber), reportScope);
    expect(receiptPdf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("posts one fully allocated bank receipt only after the current POS policy acknowledgment", async () => {
    const before = await queryOne<{ metadata: Record<string, unknown> }>(client, `
      SELECT metadata
      FROM app.stores
      WHERE id = $1 AND merchant_id = $2
    `, [operatingScope.storeId, operatingScope.merchantId]);
    const policy = {
      mode: "confirm_on_booking",
      version: 1,
      updatedAt: "2026-09-06T00:00:00.000Z",
      updatedBy: actor.operatorId,
    };
    await client.query(`
      UPDATE app.stores
      SET metadata = COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object('bankTransferSettlementPolicy', $2::jsonb)
      WHERE id = $1
    `, [operatingScope.storeId, JSON.stringify(policy)]);
    try {
      const headers = { "idempotency-key": `db-test:${runId}:bank-confirm-on-booking` };
      const body = {
        customerId: "cus_demo",
        customerMode: "linked" as const,
        items: [{ variantId, quantity: 1 }],
        paymentMethod: "bank_transfer",
        amountReceived: 0,
        salesChannel: "pos_counter",
        bankTransferSettlementAcknowledgment: {
          policyVersion: 1,
          acknowledgmentVersion: 1,
        },
      };
      const created = await completeSale(headers, body, actor, operatingScope);
      const replay = await completeSale(headers, body, actor, operatingScope);
      expect(created.statusCode).toBe(201);
      expect(replay.statusCode).toBe(200);
      expect(replay.response).toEqual(created.response);
      expect(created.response.data.paymentStatus).toBe("posted");

      const orderId = created.response.data.orderId;
      const receipt = await queryOne<{ status: string; evidence_type: string; amount_minor: string }>(client, `
        SELECT status, evidence_type, amount_minor::text
        FROM app.payment_events
        WHERE merchant_id = $1 AND store_id = $2 AND order_id = $3
          AND kind = 'charge'
        ORDER BY recorded_at ASC
        LIMIT 1
      `, [operatingScope.merchantId, operatingScope.storeId, orderId]);
      expect(receipt).toMatchObject({ status: "posted", evidence_type: "manual_verified" });

      const allocated = await queryOne<{ amount_minor: string }>(client, `
        SELECT COALESCE(sum(amount_minor), 0)::text AS amount_minor
        FROM app.payment_event_allocations
        WHERE merchant_id = $1 AND store_id = $2 AND payment_event_id = (
          SELECT id FROM app.payment_events
          WHERE merchant_id = $1 AND store_id = $2 AND order_id = $3
            AND kind = 'charge'
          LIMIT 1
        )
      `, [operatingScope.merchantId, operatingScope.storeId, orderId]);
      expect(Number(allocated?.amount_minor)).toBe(Number(receipt?.amount_minor));

      const mirror = await queryOne<{ status: string }>(client, `
        SELECT status FROM app.payment_entries
        WHERE order_id = $1 AND direction = 'charge'
        LIMIT 1
      `, [orderId]);
      expect(mirror?.status).toBe("posted");
      const saleOutbox = await client.query(`
        SELECT id FROM outbox.events
        WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'sale.created'
      `, [orderId]);
      expect(saleOutbox.rows).toHaveLength(1);
    } finally {
      await client.query("UPDATE app.stores SET metadata = $2::jsonb WHERE id = $1", [
        operatingScope.storeId,
        JSON.stringify(before?.metadata || {}),
      ]);
    }
  });

  it("links redeemed Scan & Go carts to Stash Dash orders and rejects fake cart ids", async () => {
    await ensureStockAtLeast(3);
    const validCartId = `sgc_db_${runId}_valid`;
    await client.query(`
      INSERT INTO app.scan_go_carts (
        id, merchant_id, store_id, status, merchant_slug, store_slug,
        age_acknowledged_at, token_hash, token_generated_at, token_expires_at,
        redeemed_at, redeemed_by_operator_id
      )
      VALUES ($1, $2, $3, 'redeemed', 'default', 'main', now(), $4, now(), now() + interval '30 minutes', now(), $5)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        redeemed_at = EXCLUDED.redeemed_at,
        redeemed_by_operator_id = EXCLUDED.redeemed_by_operator_id,
        redeemed_order_id = NULL,
        updated_at = now()
    `, [validCartId, operatingScope.merchantId, operatingScope.storeId, `${validCartId}_hash`, actor.operatorId]);

    const stockBefore = await stockForVariant();
    const created = await completeSale({ "idempotency-key": `db-test:${runId}:stash-dash-valid` }, {
      customerId: "cus_demo",
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
      salesChannel: "stash_dash",
      sourceFlow: "customer_scan_go",
      scanGoCartId: validCartId,
      scanGoRedeemedAt: new Date().toISOString(),
      salesChannelLocked: true,
      customerNickname: "Tommy",
      customerContactType: "whatsapp",
      redeemedByOperatorId: actor.operatorId,
    }, actor, operatingScope);

    const orderId = String(created.response.data.orderId);
    expect(created.statusCode).toBe(201);
    expect(created.response.data).toMatchObject({
      salesChannel: "stash_dash",
      salesChannelLabel: "Stash Dash",
      salesChannelLocked: true,
      sourceFlow: "customer_scan_go",
      scanGoCartId: validCartId,
    });
    await expect(stockForVariant()).resolves.toBe(stockBefore - 1);

    const linkedCart = await queryOne<{ redeemed_order_id: string; metadata: Record<string, unknown> }>(client, `
      SELECT redeemed_order_id, metadata
      FROM app.scan_go_carts
      WHERE id = $1
    `, [validCartId]);
    expect(linkedCart).toMatchObject({
      redeemed_order_id: orderId,
      metadata: expect.objectContaining({ redeemedOrderId: orderId }),
    });

    const stockBeforeInvalid = await stockForVariant();
    await expect(completeSale({ "idempotency-key": `db-test:${runId}:stash-dash-fake` }, {
      customerId: "cus_demo",
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
      salesChannel: "stash_dash",
      sourceFlow: "customer_scan_go",
      scanGoCartId: `sgc_db_${runId}_missing`,
      salesChannelLocked: true,
    }, actor, operatingScope)).rejects.toMatchObject({ code: "scan_go_cart_not_redeemed" });
    await expect(stockForVariant()).resolves.toBe(stockBeforeInvalid);

    await expect(completeSale({ "idempotency-key": `db-test:${runId}:stash-dash-missing-cart` }, {
      customerId: "cus_demo",
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
      salesChannel: "stash_dash",
      sourceFlow: "customer_scan_go",
      salesChannelLocked: true,
    }, actor, operatingScope)).rejects.toMatchObject({ code: "scan_go_cart_required" });
  });

  it("keeps Basic cash checkout working when all paid 1.1.2 package and provider flags are off", async () => {
    const envSnapshot = snapshotPackageEnv();
    try {
      process.env.APP_PACKAGE_KEY = "basic";
      delete process.env.FEATURE_FLAGS;
      process.env.SEPAY_PAYMENTS_ENABLED = "false";
      process.env.SEPAY_LIVE_ENABLED = "false";
      process.env.CRYPTO_PAYMENTS_ENABLED = "false";
      process.env.NOWPAYMENTS_LIVE_ENABLED = "false";
      process.env.CRYPTO_PROVIDER = "nowpayments";

      await ensureStockAtLeast(2);
      const stockBefore = await stockForVariant();
      const result = await completeSale({ "idempotency-key": `db-test:${runId}:basic-cash` }, {
        customerId: "cus_demo",
        items: [{ variantId, quantity: 1 }],
        paymentMethod: "cash",
        amountReceived: 300000,
        notes: `Basic cash checkout ${runId}`,
        salesChannel: "pos_counter",
      }, actor, operatingScope);

      expect(result.statusCode).toBe(201);
      expect(result.response.data).toMatchObject({
        status: "completed",
        paymentMethod: "cash",
        notes: `Basic cash checkout ${runId}`,
      });
      await expect(stockForVariant()).resolves.toBe(stockBefore - 1);

      const payments = await client.query(`
        SELECT direction, method, status, metadata
        FROM app.payment_entries
        WHERE order_id = $1
      `, [result.response.data.orderId]);
      expect(payments.rows).toHaveLength(1);
      expect(payments.rows[0]).toMatchObject({
        direction: "charge",
        method: "cash",
        status: "posted",
      });
      expect(payments.rows[0].metadata).not.toHaveProperty("paymentIntentId");
    } finally {
      restorePackageEnv(envSnapshot);
    }
  });

  it("returns a structured found-stock warning without mutating order or stock", async () => {
    await setStock(2);
    const stockBefore = await stockForVariant();
    const orderCountBefore = await client.query("SELECT COUNT(*)::int AS count FROM public.\"order\"");
    const movementCountBefore = await client.query("SELECT COUNT(*)::int AS count FROM medusa.stock_movements");

    await expect(completeSale({ "idempotency-key": `db-test:${runId}:found-warning` }, {
      items: [{ variantId, quantity: 5 }],
      paymentMethod: "cash",
      amountReceived: 2000000,
      notes: `DB found warning ${runId}`,
    }, actor, operatingScope)).rejects.toMatchObject({
      code: "stock_shortage_requires_confirmation",
      statusCode: 409,
      details: {
        shortages: [
          expect.objectContaining({
            variantId,
            systemStock: 2,
            requestedQuantity: 5,
            shortageQuantity: 3,
            unitCost: expect.any(Number),
          }),
        ],
      },
    });

    await expect(stockForVariant()).resolves.toBe(stockBefore);
    const orderCountAfter = await client.query("SELECT COUNT(*)::int AS count FROM public.\"order\"");
    const movementCountAfter = await client.query("SELECT COUNT(*)::int AS count FROM medusa.stock_movements");
    expect(orderCountAfter.rows[0].count).toBe(orderCountBefore.rows[0].count);
    expect(movementCountAfter.rows[0].count).toBe(movementCountBefore.rows[0].count);
  });

  it("treats a missing store inventory level as zero stock and completes after found-stock confirmation", async () => {
    const emptyStoreScope = {
      scopeKind: "operating" as const,
      merchantId: operatingScope.merchantId,
      storeId: emptyStoreId,
      stockLocationId: emptyStockLocationId,
    };
    const inventoryLevelBefore = await client.query(`
      SELECT il.id
      FROM public.inventory_level il
      JOIN public.product_variant_inventory_item vii
        ON vii.inventory_item_id = il.inventory_item_id
       AND vii.deleted_at IS NULL
      WHERE vii.variant_id = $1
        AND il.location_id = $2
        AND il.deleted_at IS NULL
    `, [variantId, emptyStockLocationId]);
    expect(inventoryLevelBefore.rows).toHaveLength(0);

    await expect(completeSale({ "idempotency-key": `db-test:${runId}:empty-store-warning` }, {
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
      notes: `DB empty store warning ${runId}`,
    }, actor, emptyStoreScope)).rejects.toMatchObject({
      code: "stock_shortage_requires_confirmation",
      statusCode: 409,
      details: {
        shortages: [
          expect.objectContaining({
            variantId,
            systemStock: 0,
            requestedQuantity: 1,
            shortageQuantity: 1,
          }),
        ],
      },
    });

    const rolledBackLevel = await client.query(`
      SELECT il.id
      FROM public.inventory_level il
      JOIN public.product_variant_inventory_item vii
        ON vii.inventory_item_id = il.inventory_item_id
       AND vii.deleted_at IS NULL
      WHERE vii.variant_id = $1
        AND il.location_id = $2
        AND il.deleted_at IS NULL
    `, [variantId, emptyStockLocationId]);
    expect(rolledBackLevel.rows).toHaveLength(0);

    const created = await completeSale({ "idempotency-key": `db-test:${runId}:empty-store-confirmed` }, {
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
      notes: `DB empty store confirmed ${runId}`,
      foundStockConfirmation: {
        confirmed: true,
        reasonCode: "found_stock",
        reasonLabel: "Tìm thấy",
        acknowledgedShortages: [{ variantId, shortageQuantity: 1 }],
      },
    }, actor, emptyStoreScope);
    expect(created.statusCode).toBe(201);

    const finalLevel = await client.query(`
      SELECT il.stocked_quantity::numeric AS stocked_quantity
      FROM public.inventory_level il
      JOIN public.product_variant_inventory_item vii
        ON vii.inventory_item_id = il.inventory_item_id
       AND vii.deleted_at IS NULL
      WHERE vii.variant_id = $1
        AND il.location_id = $2
        AND il.deleted_at IS NULL
    `, [variantId, emptyStockLocationId]);
    expect(finalLevel.rows).toEqual([{ stocked_quantity: "0" }]);

    const movements = await client.query(`
      SELECT movement_type, quantity_change::numeric AS quantity_change, stock_location_id
      FROM medusa.stock_movements
      WHERE reference_id = $1
      ORDER BY created_at ASC
    `, [created.response.data.orderId]);
    expect(movements.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        movement_type: "manual_adjustment",
        quantity_change: "1",
        stock_location_id: emptyStockLocationId,
      }),
      expect.objectContaining({
        movement_type: "sale",
        quantity_change: "-1",
        stock_location_id: emptyStockLocationId,
      }),
    ]));
  });

  it("confirms found-stock checkout with one adjustment, order, audit, accounting, and idempotency replay", async () => {
    await setStock(2);
    const body = {
      items: [{ variantId, quantity: 5 }],
      paymentMethod: "cash",
      amountReceived: 2000000,
      notes: `DB found confirmed ${runId}`,
      foundStockConfirmation: {
        confirmed: true,
        reasonCode: "found_stock",
        reasonLabel: "Tìm thấy",
        acknowledgedShortages: [{ variantId, shortageQuantity: 3 }],
      },
    };
    const headers = { "idempotency-key": `db-test:${runId}:found-confirmed` };

    const created = await completeSale(headers, body, actor, operatingScope);
    const replay = await completeSale(headers, body, actor, operatingScope);

    expect(created.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.response).toEqual(created.response);
    await expect(stockForVariant()).resolves.toBe(0);

    const order = created.response.data;
    expect(order.stockAdjustments).toEqual([
      expect.objectContaining({
        type: "found_stock",
        reason: "Tìm thấy",
        variantId,
        systemStockBefore: 2,
        requestedQuantity: 5,
        adjustedQuantity: 3,
        performedBy: actor.operatorId,
      }),
    ]);

    const movements = await client.query(`
      SELECT
        movement_type,
        source_action,
        quantity_change::numeric AS quantity_change,
        (quantity_after - quantity_change)::int AS quantity_before,
        quantity_after,
        reference_type,
        reference_id,
        reason,
        performed_by,
        actor_display_name_snapshot,
        metadata
      FROM medusa.stock_movements
      WHERE reference_id = $1
      ORDER BY created_at ASC
    `, [order.orderId]);
    expect(movements.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        movement_type: "manual_adjustment",
        source_action: "found_stock",
        quantity_change: "3",
        quantity_before: 2,
        quantity_after: 5,
        reference_type: "order_found_stock",
        reason: "Tìm thấy",
        performed_by: actor.operatorId,
        actor_display_name_snapshot: actor.displayName,
      }),
      expect.objectContaining({
        movement_type: "sale",
        source_action: "pos_sale",
        quantity_change: "-5",
        quantity_before: 5,
        quantity_after: 0,
        reference_type: "order",
        performed_by: actor.operatorId,
        actor_display_name_snapshot: actor.displayName,
      }),
    ]));
    expect(movements.rows.every((row) => row.metadata?.historyQuality === "native")).toBe(true);

    const audit = await client.query(`
      SELECT action, reason
      FROM audit.events
      WHERE subject_type = 'order' AND subject_id = $1
      ORDER BY created_at ASC
    `, [order.orderId]);
    expect(audit.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "stock.found_adjusted_for_sale", reason: "Tìm thấy" }),
    ]));

    const foundEvent = await queryOne<{ id: string; event_type: string; payload: Record<string, unknown> }>(client, `
      SELECT id::text, event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'stock.found'
      ORDER BY created_at ASC
      LIMIT 1
    `, [order.orderId]);
    expect(foundEvent?.payload).toMatchObject({
      orderId: order.orderId,
      inventoryValue: expect.any(Number),
      items: [expect.objectContaining({ variantId, quantity: 3 })],
    });
    await processOutboxEvent({ id: foundEvent!.id, eventType: foundEvent!.event_type, payload: foundEvent!.payload });

    const foundJournal = await client.query(`
      SELECT a.code, jl.debit_amount::numeric AS debit, jl.credit_amount::numeric AS credit,
             je.merchant_id, je.store_id
      FROM accounting.journal_entries je
      JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
      JOIN accounting.accounts a ON a.id = jl.account_id
      WHERE je.reference_type = 'stock_found' AND je.reference_id = $1
      ORDER BY a.code
    `, [order.orderId]);
    expect(foundJournal.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "1561",
        debit: expect.any(String),
        credit: "0.00",
        merchant_id: operatingScope.merchantId,
        store_id: operatingScope.storeId,
      }),
      expect.objectContaining({
        code: "7111",
        debit: "0.00",
        credit: expect.any(String),
        merchant_id: operatingScope.merchantId,
        store_id: operatingScope.storeId,
      }),
    ]));

    const incomeStatement = await client.query(`
      SELECT COALESCE(SUM(CASE WHEN a.code = '7111' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0)::numeric AS other_income
      FROM accounting.journal_entries je
      JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
      JOIN accounting.accounts a ON a.id = jl.account_id
      WHERE je.reference_type = 'stock_found' AND je.reference_id = $1
    `, [order.orderId]);
    expect(Number(incomeStatement.rows[0].other_income)).toBeGreaterThan(0);

    const receipt = await getReceiptText(String(order.orderNumber), reportScope);
    expect(receipt).not.toContain("Tìm thấy");
  });

  it("recomputes found-stock shortage on confirmation and does not over-adjust", async () => {
    await setStock(4);
    const sale = await completeSale({ "idempotency-key": `db-test:${runId}:found-recompute` }, {
      items: [{ variantId, quantity: 5 }],
      paymentMethod: "cash",
      amountReceived: 2000000,
      notes: `DB found recompute ${runId}`,
      foundStockConfirmation: {
        confirmed: true,
        reasonCode: "found_stock",
        reasonLabel: "Tìm thấy",
        acknowledgedShortages: [{ variantId, shortageQuantity: 3 }],
      },
    }, actor, operatingScope);

    expect(sale.statusCode).toBe(201);
    await expect(stockForVariant()).resolves.toBe(0);
    expect(sale.response.data.stockAdjustments).toEqual([
      expect.objectContaining({ adjustedQuantity: 1, systemStockBefore: 4, requestedQuantity: 5 }),
    ]);
  });

  it("fails found-stock checkout clearly when cost price is missing", async () => {
    const currentCost = await queryOne<{ cost_price: string }>(client, "SELECT cost_price::numeric AS cost_price FROM inventory.product_settings WHERE variant_id = $1", [variantId]);
    await setStock(2);
    await setCostPrice(0);
    try {
      await expect(completeSale({ "idempotency-key": `db-test:${runId}:found-missing-cost` }, {
        items: [{ variantId, quantity: 5 }],
        paymentMethod: "cash",
        amountReceived: 2000000,
        notes: `DB found missing cost ${runId}`,
        foundStockConfirmation: {
          confirmed: true,
          reasonCode: "found_stock",
          reasonLabel: "Tìm thấy",
          acknowledgedShortages: [{ variantId, shortageQuantity: 3 }],
        },
      }, actor, operatingScope)).rejects.toMatchObject({
        code: "missing_cost_price",
        statusCode: 409,
        details: expect.objectContaining({ variantId, unitCost: 0 }),
      });
      await expect(stockForVariant()).resolves.toBe(2);
    } finally {
      await setCostPrice(Number(currentCost?.cost_price || 175000));
    }
  });

  it("records shipping fee on sale and posts shipping adjustment accounting separately", async () => {
    await ensureStockAtLeast(3);
    const sale = await completeSale({ "idempotency-key": `db-test:${runId}:shipping-sale` }, {
      customerId: "cus_demo",
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 300000,
      shippingFee: 30000,
      notes: `DB POS shipping ${runId}`,
    }, actor, operatingScope);
    expect(sale.statusCode).toBe(201);

    const order = sale.response.data;
    expect(order.shippingFee).toBe(30000);
    expect(order.merchandisePayable).toBe(order.subtotal);
    expect(order.total).toBe(order.subtotal + 30000);
    expect(order.tax).toBeGreaterThan(0);
    expect(order.loyaltyBase).toBe(order.subtotal);

    const payments = await client.query(`
      SELECT direction, method, amount::numeric AS amount, status, metadata
      FROM app.payment_entries
      WHERE order_id = $1
      ORDER BY created_at ASC
    `, [order.orderId]);
    expect(payments.rows).toHaveLength(1);
    expect(Number(payments.rows[0].amount)).toBe(order.total);
    expect(payments.rows[0].metadata).toMatchObject({
      shippingFee: 30000,
      shippingRevenue: expect.any(Number),
      shippingTax: expect.any(Number),
    });

    const saleEvent = await queryOne<{ id: string; event_type: string; payload: Record<string, unknown> }>(client, `
      SELECT id::text, event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'sale.created'
      ORDER BY created_at ASC
      LIMIT 1
    `, [order.orderId]);
    expect(saleEvent?.payload).toMatchObject({
      shippingFee: 30000,
      shippingRevenue: expect.any(Number),
      loyaltyBase: order.subtotal,
    });
    await processOutboxEvent({ id: saleEvent!.id, eventType: saleEvent!.event_type, payload: saleEvent!.payload });

    const saleJournal = await client.query(`
      SELECT a.code, jl.debit_amount::numeric AS debit, jl.credit_amount::numeric AS credit
      FROM accounting.journal_entries je
      JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
      JOIN accounting.accounts a ON a.id = jl.account_id
      WHERE je.reference_type = 'order' AND je.reference_id = $1
      ORDER BY a.code
    `, [order.orderId]);
    expect(saleJournal.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "5112" }),
    ]));

    await expect(updateOrderShippingFee(
      { "idempotency-key": `db-test:${runId}:shipping-adjust-without-preview` },
      String(order.orderId),
      { shippingFee: 50000, reason: "DB shipping adjustment test", paymentMethod: "cash", amountReceived: 20000 },
      actor,
      operatingScope,
    )).rejects.toMatchObject({
      code: "shipping_preview_required",
      statusCode: 409,
    });

    const shippingInput = {
      shippingFee: 50000,
      reason: "DB shipping adjustment test",
      paymentMethod: "cash",
      amountReceived: 20000,
    };
    const shippingPreview = await previewOrderShippingFee(
      String(order.orderId),
      shippingInput,
      actor,
      operatingScope,
    );
    expect(shippingPreview.data).toMatchObject({
      orderId: order.orderId,
      before: { shippingFee: 30000, total: order.total },
      after: { shippingFee: 50000, total: order.total + 20000 },
      shippingFeeDelta: 20000,
      totalDelta: 20000,
      settlement: { direction: "collect", method: "cash", amount: 20000, change: 0 },
      effects: {
        orderTotals: "update",
        paymentEntry: "charge",
        auditEvent: "append",
        outboxEvent: "append",
        accountingJournal: "after_outbox_processing",
        inventory: "none",
      },
      confirmationToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(updateOrderShippingFee(
      { "idempotency-key": `db-test:${runId}:shipping-adjust-stale` },
      String(order.orderId),
      { ...shippingInput, shippingFee: 60000, confirmationToken: shippingPreview.data.confirmationToken },
      actor,
      operatingScope,
    )).rejects.toMatchObject({
      code: "shipping_preview_stale",
      statusCode: 409,
    });

    const updated = await updateOrderShippingFee(
      { "idempotency-key": `db-test:${runId}:shipping-adjust` },
      String(order.orderId),
      { ...shippingInput, confirmationToken: shippingPreview.data.confirmationToken },
      actor,
      operatingScope,
    );
    expect(updated.statusCode).toBe(200);
    expect(updated.response.order).toMatchObject({
      orderId: order.orderId,
      shippingFee: 50000,
      total: order.total + 20000,
    });

    const adjustmentEvent = await queryOne<{ id: string; event_type: string; payload: Record<string, unknown> }>(client, `
      SELECT id::text, event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'order.corrected'
      ORDER BY created_at DESC
      LIMIT 1
    `, [order.orderId]);
    expect(adjustmentEvent?.payload).toMatchObject({
      beforeTotals: expect.objectContaining({ shippingFee: 30000 }),
      afterTotals: expect.objectContaining({ shippingFee: 50000 }),
      totalDelta: 20000,
      reason: "DB shipping adjustment test",
    });
    await processOutboxEvent({
      id: adjustmentEvent!.id,
      eventType: adjustmentEvent!.event_type,
      payload: adjustmentEvent!.payload,
    });

    const adjustmentJournal = await client.query(`
      SELECT a.code, jl.debit_amount::numeric AS debit, jl.credit_amount::numeric AS credit
      FROM accounting.journal_entries je
      JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
      JOIN accounting.accounts a ON a.id = jl.account_id
      WHERE je.reference_type = 'order_correction'
        AND je.reference_id = $1
      ORDER BY a.code
    `, [String(adjustmentEvent?.payload.correctionId || "")]);
    expect(adjustmentJournal.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "1111" }),
      expect.objectContaining({ code: "5112" }),
    ]));

    const receipt = await getReceiptText(String(order.orderNumber), reportScope);
    expect(receipt).toContain("Shipping:");
  });

  it("records a fixed VND discount sale with normalized commercial metadata", async () => {
    await ensureStockAtLeast(2);
    const stockBefore = await stockForVariant();
    const sale = await completeSale({ "idempotency-key": `db-test:${runId}:fixed-discount-sale` }, {
      customerId: "cus_demo",
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 300000,
      discountType: "amount",
      discountValue: 20000,
      shippingFee: 0,
      notes: `DB POS fixed discount ${runId}`,
    }, actor, operatingScope);
    expect(sale.statusCode).toBe(201);

    const order = sale.response.data;
    expect(order.discount).toBe(20000);
    expect(order.total).toBe(order.subtotal - 20000);
    expect(order.merchandisePayable).toBe(order.subtotal - 20000);
    expect(order.loyaltyBase).toBe(order.merchandisePayable);

    const orderRow = await queryOne<{ metadata: Record<string, unknown> }>(client, `
      SELECT metadata FROM public."order" WHERE id = $1
    `, [order.orderId]);
    expect(orderRow?.metadata).toMatchObject({
      commercialAdjustmentVersion: 1,
      discountType: "amount",
      discountValue: 20000,
      discountPercent: 0,
      discount: 20000,
    });

    const payments = await client.query(`
      SELECT amount::numeric AS amount FROM app.payment_entries WHERE order_id = $1
    `, [order.orderId]);
    expect(Number(payments.rows[0].amount)).toBe(order.total);
    await expect(stockForVariant()).resolves.toBe(stockBefore - 1);

    const receipt = await getReceiptText(String(order.orderNumber), reportScope);
    expect(receipt).toContain("Discount:");
  });

  it("records normalized discountPercent metadata for the explicit percent contract", async () => {
    await ensureStockAtLeast(2);
    const sale = await completeSale({ "idempotency-key": `db-test:${runId}:percent-discount-sale` }, {
      customerId: "cus_demo",
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 300000,
      discountType: "percent",
      discountValue: 10,
      shippingFee: 0,
      notes: `DB POS percent discount ${runId}`,
    }, actor, operatingScope);
    expect(sale.statusCode).toBe(201);

    const order = sale.response.data;
    const expectedDiscount = Math.round(order.subtotal * 0.1);
    expect(order.discount).toBe(expectedDiscount);
    expect(order.total).toBe(order.subtotal - expectedDiscount);

    const orderRow = await queryOne<{ metadata: Record<string, unknown> }>(client, `
      SELECT metadata FROM public."order" WHERE id = $1
    `, [order.orderId]);
    expect(orderRow?.metadata).toMatchObject({
      discountType: "percent",
      discountValue: 10,
      discountPercent: 10,
    });
  });

  it("rejects a fixed discount exceeding subtotal", async () => {
    await ensureStockAtLeast(1);
    await expect(completeSale({ "idempotency-key": `db-test:${runId}:discount-reject` }, {
      customerId: "cus_demo",
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
      discountType: "amount",
      discountValue: 999999999,
      shippingFee: 0,
      notes: `DB POS discount reject ${runId}`,
    }, actor, operatingScope)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("cancels a POS sale idempotently and restores stock with audit and outbox evidence", async () => {
    await ensureStockAtLeast(2);
    const stockBefore = await stockForVariant();
    const saleBody = {
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
      notes: `DB POS cancel ${runId}`,
    };
    const sale = await completeSale({ "idempotency-key": `db-test:${runId}:sale-to-cancel` }, saleBody, actor, operatingScope);
    const orderId = String(sale.response.data.orderId);
    await expect(stockForVariant()).resolves.toBe(stockBefore - 1);

    await expect(cancelOrder(
      { "idempotency-key": `db-test:${runId}:cancel-without-reason` },
      orderId,
      { reason: "   " },
      actor,
      operatingScope,
    )).rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    await expect(stockForVariant()).resolves.toBe(stockBefore - 1);
    const beforeValidCancel = await getOrder(orderId, { merchantId: operatingScope.merchantId, storeIds: [operatingScope.storeId] });
    expect(beforeValidCancel.order.status).not.toBe("canceled");

    const { quote } = await quoteOrderCancellation(orderId, operatingScope, actor);
    const cancelBody = {
      reason: "DB integration cancel",
      quoteId: quote.quoteId,
      effectiveRevision: quote.effectiveRevision,
      quoteGeneratedAt: quote.generatedAt,
    };
    const headers = { "idempotency-key": `db-test:${runId}:cancel` };
    const canceled = await cancelOrder(headers, orderId, cancelBody, actor, operatingScope);
    const replay = await cancelOrder(headers, orderId, cancelBody, actor, operatingScope);

    expect(canceled.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.response).toEqual(canceled.response);
    expect(canceled.response.order).toMatchObject({
      id: orderId,
      orderId,
      status: "canceled",
    });
    await expect(stockForVariant()).resolves.toBe(stockBefore);

    const movements = await client.query(`
      SELECT
        movement_type,
        source_action,
        quantity_change::numeric AS quantity_change,
        (quantity_after - quantity_change)::int AS quantity_before,
        quantity_after,
        reference_id,
        reason,
        performed_by,
        actor_display_name_snapshot
      FROM medusa.stock_movements
      WHERE reference_type = 'order' AND reference_id = $1
      ORDER BY created_at ASC
    `, [orderId]);
    expect(movements.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        movement_type: "sale",
        source_action: "pos_sale",
        quantity_change: "-1",
        quantity_before: stockBefore,
        quantity_after: stockBefore - 1,
        performed_by: actor.operatorId,
        actor_display_name_snapshot: actor.displayName,
      }),
      expect.objectContaining({
        movement_type: "return",
        source_action: "order_cancel",
        quantity_change: "1",
        quantity_before: stockBefore - 1,
        quantity_after: stockBefore,
        reason: cancelBody.reason,
        performed_by: actor.operatorId,
        actor_display_name_snapshot: actor.displayName,
      }),
    ]));

    const audit = await client.query(`
      SELECT action, reason
      FROM audit.events
      WHERE subject_type = 'order' AND subject_id = $1
      ORDER BY created_at ASC
    `, [orderId]);
    expect(audit.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "order.cancelled", reason: cancelBody.reason }),
    ]));

    const outbox = await client.query(`
      SELECT event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1
      ORDER BY created_at ASC
    `, [orderId]);
    expect(outbox.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: "sale.cancelled",
        payload: expect.objectContaining({
          orderId,
          reason: cancelBody.reason,
        }),
      }),
    ]));
  });

  it("recreates from a scoped order and persists source provenance in metadata, outbox, and audit", async () => {
    await ensureStockAtLeast(4);
    const sourceSale = await completeSale({ "idempotency-key": `db-test:${runId}:recreate-source` }, {
      customerId: "cus_demo",
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
      notes: `DB recreate source ${runId}`,
    }, actor, operatingScope);
    const sourceOrderId = String(sourceSale.response.data.orderId);
    const sourceOrderNumber = String(sourceSale.response.data.orderNumber);

    const prefill = await prepareOrderRecreatePrefill(sourceOrderId, operatingScope);
    expect(prefill).toMatchObject({
      sourceOrderId,
      sourceOrderNumber,
      unavailableCount: 0,
      items: [expect.objectContaining({ variantId, quantity: 1, unavailable: false })],
    });
    await client.query(
      "UPDATE public.product SET status = 'draft' WHERE id = (SELECT product_id FROM public.product_variant WHERE id = $1)",
      [variantId],
    );
    try {
      const unavailablePrefill = await prepareOrderRecreatePrefill(sourceOrderId, operatingScope);
      expect(unavailablePrefill).toMatchObject({
        unavailableCount: 1,
        warningCount: 1,
        items: [expect.objectContaining({ variantId, unavailable: true })],
      });
    } finally {
      await client.query(
        "UPDATE public.product SET status = 'published' WHERE id = (SELECT product_id FROM public.product_variant WHERE id = $1)",
        [variantId],
      );
    }
    await expect(prepareOrderRecreatePrefill(sourceOrderId, {
      ...operatingScope,
      storeId: emptyStoreId,
      stockLocationId: emptyStockLocationId,
    })).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });

    const recreated = await completeSale({ "idempotency-key": `db-test:${runId}:recreated-sale` }, {
      customerId: "cus_demo",
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
      sourceOrderId,
      notes: `DB recreated sale ${runId}`,
    }, actor, operatingScope);
    const recreatedOrderId = String(recreated.response.data.orderId);
    expect(recreatedOrderId).not.toBe(sourceOrderId);

    const orderRow = await queryOne<{ metadata: Record<string, unknown> }>(client, `
      SELECT metadata FROM public."order" WHERE id = $1
    `, [recreatedOrderId]);
    expect(orderRow?.metadata).toMatchObject({
      recreatedFromOrderId: sourceOrderId,
      recreatedFromOrderNumber: sourceOrderNumber,
    });
    const outbox = await queryOne<{ payload: Record<string, unknown> }>(client, `
      SELECT payload FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'sale.created'
      ORDER BY created_at DESC LIMIT 1
    `, [recreatedOrderId]);
    expect(outbox?.payload).toMatchObject({
      recreatedFromOrderId: sourceOrderId,
      recreatedFromOrderNumber: sourceOrderNumber,
    });
    const audit = await queryOne<{ after: Record<string, unknown> }>(client, `
      SELECT after FROM audit.events
      WHERE subject_type = 'order' AND subject_id = $1 AND action = 'order.created'
      ORDER BY created_at DESC LIMIT 1
    `, [recreatedOrderId]);
    expect(audit?.after).toMatchObject({ recreatedFromOrderId: sourceOrderId });
  });

  it("cancels a corrected order using effective quantities without inventory drift", async () => {
    await ensureStockAtLeast(5);
    const stockBeforeSale = await stockForVariant();
    const sale = await completeSale({ "idempotency-key": `db-test:${runId}:correct-then-cancel-sale` }, {
      customerId: "cus_demo",
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
      notes: `DB correct then cancel ${runId}`,
    }, actor, operatingScope);
    const orderId = String(sale.response.data.orderId);
    const saleEvent = await queryOne<{ id: string; event_type: string; payload: Record<string, unknown> }>(client, `
      SELECT id::text, event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'sale.created'
      ORDER BY created_at DESC LIMIT 1
    `, [orderId]);
    await processOutboxEvent({ id: saleEvent!.id, eventType: saleEvent!.event_type, payload: saleEvent!.payload });

    const correctionInput = {
      baseRevision: 0,
      reason: "Tăng số lượng trước khi hủy để kiểm tra hoàn kho chính xác.",
      items: [{ variantId, quantity: 2 }],
      settlement: { method: "cash", amountReceived: 0 },
    };
    const preview = await previewOrderCorrection(orderId, correctionInput, actor, operatingScope);
    const corrected = await applyOrderCorrection(
      { "idempotency-key": `db-test:${runId}:correct-before-cancel` },
      orderId,
      { ...correctionInput, settlement: { method: "cash", amountReceived: preview.data.totalDelta } },
      actor,
      operatingScope,
    );
    await expect(stockForVariant()).resolves.toBe(stockBeforeSale - 2);
    const correctionEvent = await queryOne<{ id: string; event_type: string; payload: Record<string, unknown> }>(client, `
      SELECT id::text, event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'order.corrected'
      ORDER BY created_at DESC LIMIT 1
    `, [orderId]);
    await processOutboxEvent({
      id: correctionEvent!.id,
      eventType: correctionEvent!.event_type,
      payload: correctionEvent!.payload,
    });

    const { quote } = await quoteOrderCancellation(orderId, operatingScope, actor);
    const canceled = await cancelOrder(
      { "idempotency-key": `db-test:${runId}:cancel-corrected-order` },
      orderId,
      {
        reason: "Hủy đơn đã điều chỉnh để hoàn đúng tồn kho.",
        quoteId: quote.quoteId,
        effectiveRevision: quote.effectiveRevision,
        quoteGeneratedAt: quote.generatedAt,
      },
      actor,
      operatingScope,
    );
    const effectiveTotal = Number(corrected.response.data.correction.afterTotals.total);
    expect(canceled.response.financial).toMatchObject({
      commercialRevisionId: expect.any(String),
      customerRefundPayableId: expect.any(String),
      customerRefundPayableMinor: effectiveTotal,
      customerRefundPayableStatus: "open",
    });
    await expect(stockForVariant()).resolves.toBe(stockBeforeSale);

    const returnMovement = await queryOne<{ quantity_change: string }>(client, `
      SELECT quantity_change::numeric AS quantity_change
      FROM medusa.stock_movements
      WHERE reference_type = 'order' AND reference_id = $1 AND movement_type = 'return'
      ORDER BY created_at DESC LIMIT 1
    `, [orderId]);
    expect(returnMovement?.quantity_change).toBe("2");

    const openPayable = await queryOne<{ balance_minor: string; status: string }>(client, `
      SELECT balance_minor::text, status
      FROM app.customer_refund_payable_balances
      WHERE payable_id = $1::uuid
    `, [canceled.response.financial.customerRefundPayableId]);
    expect(openPayable).toEqual({ balance_minor: String(effectiveTotal), status: "open" });

    const cancellationEvent = await queryOne<{ id: string; event_type: string; payload: Record<string, unknown> }>(client, `
      SELECT id::text, event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'sale.cancelled'
      ORDER BY created_at DESC LIMIT 1
    `, [orderId]);
    await processOutboxEvent({
      id: cancellationEvent!.id,
      eventType: cancellationEvent!.event_type,
      payload: cancellationEvent!.payload,
    });

    await expect(refundOrder(
      { "idempotency-key": `db-test:${runId}:refund-corrected-cancel-invalid-confirmation` },
      orderId,
      {
        method: "cash",
        reason: "Chi hoàn tiền cho đơn đã điều chỉnh và hủy.",
        confirmationToken: "WRONG-ORDER-NUMBER",
      },
      actor,
      { merchantId: operatingScope.merchantId, storeId: operatingScope.storeId },
    )).rejects.toMatchObject({
      code: "validation_error",
      statusCode: 400,
    });

    await expect(refundOrder(
      { "idempotency-key": `db-test:${runId}:refund-corrected-cancel-partial-amount` },
      orderId,
      {
        amount: 1,
        method: "cash",
        reason: "Không cho phép client tự chọn một phần khoản phải hoàn.",
        confirmationToken: String(sale.response.data.orderNumber),
      },
      actor,
      { merchantId: operatingScope.merchantId, storeId: operatingScope.storeId },
    )).rejects.toMatchObject({
      code: "refund_amount_must_equal_payable",
      statusCode: 409,
      details: { requested: 1, payable: effectiveTotal },
    });

    const refunded = await refundOrder(
      { "idempotency-key": `db-test:${runId}:refund-corrected-cancel` },
      orderId,
      {
        method: "cash",
        reason: "Chi hoàn tiền cho đơn đã điều chỉnh và hủy.",
        confirmationToken: String(sale.response.data.orderNumber),
      },
      actor,
      { merchantId: operatingScope.merchantId, storeId: operatingScope.storeId },
    );
    expect(refunded.response.data).toMatchObject({
      status: "refunded",
      amount: effectiveTotal,
      canonicalPaymentEventId: expect.any(String),
    });
    const clearedPayable = await queryOne<{ balance_minor: string; status: string }>(client, `
      SELECT balance_minor::text, status
      FROM app.customer_refund_payable_balances
      WHERE payable_id = $1::uuid
    `, [canceled.response.financial.customerRefundPayableId]);
    expect(clearedPayable).toEqual({ balance_minor: "0", status: "cleared" });

    const refundEvent = await queryOne<{ id: string; event_type: string; payload: Record<string, unknown> }>(client, `
      SELECT id::text, event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'refund.created'
      ORDER BY created_at DESC LIMIT 1
    `, [orderId]);
    await processOutboxEvent({
      id: refundEvent!.id,
      eventType: refundEvent!.event_type,
      payload: refundEvent!.payload,
    });

    const accounting = await client.query(`
      SELECT je.reference_type, a.code,
             jl.debit_amount::numeric AS debit, jl.credit_amount::numeric AS credit
      FROM accounting.journal_entries je
      JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
      JOIN accounting.accounts a ON a.id = jl.account_id
      WHERE (je.reference_type = 'order_cancellation' AND je.reference_id = $1)
         OR (je.reference_type = 'customer_refund_payout' AND je.reference_id = $2)
      ORDER BY je.reference_type, a.code
    `, [orderId, refunded.response.data.canonicalPaymentEventId]);
    expect(accounting.rows.map((row) => row.code)).toEqual(expect.arrayContaining([
      "CUSTOMER_REFUND_PAYABLE",
      "1111",
      "5111",
    ]));
    for (const referenceType of ["order_cancellation", "customer_refund_payout"]) {
      const rows = accounting.rows.filter((row) => row.reference_type === referenceType);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.reduce((sum, row) => sum + Number(row.debit || 0), 0)).toBe(
        rows.reduce((sum, row) => sum + Number(row.credit || 0), 0),
      );
    }
  });

  it("updates an order customer after a walk-in sale idempotently", async () => {
    await ensureStockAtLeast(2);
    const sale = await completeSale({ "idempotency-key": `db-test:${runId}:walk-in-sale` }, {
      items: [{ variantId, quantity: 1 }],
      customerMode: "walk_in",
      paymentMethod: "cash",
      amountReceived: 1000000,
      notes: `DB POS customer update ${runId}`,
    }, actor, operatingScope);
    const orderId = String(sale.response.data.orderId);

    expect(sale.response.data.customerId).toBeNull();

    const headers = { "idempotency-key": `db-test:${runId}:order-customer` };
    const updated = await updateOrderCustomer(headers, orderId, { customerId: "cus_demo" }, actor, operatingScope);
    const replay = await updateOrderCustomer(headers, orderId, { customerId: "cus_demo" }, actor, operatingScope);

    expect(updated.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.response).toEqual(updated.response);
    expect(updated.response.order).toMatchObject({
      id: orderId,
      customerId: "cus_demo",
      customer: expect.objectContaining({ id: "cus_demo" }),
    });

    const cleared = await updateOrderCustomer(
      { "idempotency-key": `db-test:${runId}:order-customer-clear` },
      orderId,
      { customerId: null },
      actor,
      operatingScope,
    );
    expect(cleared.response.order?.customerId).toBeNull();
    expect(cleared.response.order?.customer).toBeUndefined();

    const audit = await client.query(`
      SELECT action
      FROM audit.events
      WHERE subject_type = 'order' AND subject_id = $1
      ORDER BY created_at ASC
    `, [orderId]);
    expect(audit.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "order.customer_updated" }),
    ]));
  });

  it("updates order notes and sales channel idempotently without mutating customer", async () => {
    await ensureStockAtLeast(2);
    const sale = await completeSale({ "idempotency-key": `db-test:${runId}:note-channel-sale` }, {
      customerId: "cus_demo",
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
      notes: `Original order note ${runId}`,
      salesChannel: "pos_counter",
    }, actor, operatingScope);
    const orderId = String(sale.response.data.orderId);

    const headers = { "idempotency-key": `db-test:${runId}:note-channel-update` };
    const body = {
      notes: `Updated order note ${runId}`,
      salesChannel: "instagram",
    };
    const updated = await updateOrder(headers, orderId, body, actor, operatingScope);
    const replay = await updateOrder(headers, orderId, body, actor, operatingScope);

    expect(updated.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.response).toEqual(updated.response);
    expect(updated.response.order).toMatchObject({
      id: orderId,
      customerId: "cus_demo",
      notes: body.notes,
      salesChannel: "instagram",
      salesChannelLabel: "Instagram",
    });

    const dbOrder = await queryOne<{ sales_channel_id: string; metadata: Record<string, unknown> }>(client, `
      SELECT sales_channel_id, metadata
      FROM public."order"
      WHERE id = $1
    `, [orderId]);
    expect(dbOrder?.sales_channel_id).toBe("sc_remote");
    expect(dbOrder?.metadata).toMatchObject({
      notes: body.notes,
      salesChannel: "instagram",
      salesChannelLabel: "Instagram",
    });

    const audit = await client.query(`
      SELECT action
      FROM audit.events
      WHERE subject_type = 'order' AND subject_id = $1
      ORDER BY created_at ASC
    `, [orderId]);
    expect(audit.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "order.updated" }),
    ]));
  });

  it("applies an idempotent order correction with stock, payment, audit, accounting, and loyalty deltas", async () => {
    await ensureStockAtLeast(5);
    const stockBeforeSale = await stockForVariant();
    const sale = await completeSale({ "idempotency-key": `db-test:${runId}:correction-sale` }, {
      customerId: "cus_demo",
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
      notes: `DB order correction ${runId}`,
    }, actor, operatingScope);
    const orderId = String(sale.response.data.orderId);
    const stockAfterSale = await stockForVariant();
    expect(stockAfterSale).toBe(stockBeforeSale - 1);

    const saleEvent = await queryOne<{ id: string; event_type: string; payload: Record<string, unknown> }>(client, `
      SELECT id::text, event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'sale.created'
      ORDER BY created_at DESC
      LIMIT 1
    `, [orderId]);
    await processOutboxEvent({ id: saleEvent!.id, eventType: saleEvent!.event_type, payload: saleEvent!.payload });

    const correctionBody = {
      baseRevision: 0,
      reason: "Nhân viên nhập thiếu một hộp trong đơn bán tại quầy.",
      items: [{ variantId, quantity: 2 }],
      settlement: { method: "cash", amountReceived: Number(sale.response.data.total) },
    };
    const preview = await previewOrderCorrection(orderId, {
      ...correctionBody,
      settlement: { method: "cash", amountReceived: 0 },
    }, actor, operatingScope);
    expect(preview.data).toMatchObject({
      baseRevision: 0,
      totalDelta: Number(sale.response.data.total),
      settlement: { amount: Number(sale.response.data.total), direction: "collect" },
    });
    const headers = { "idempotency-key": `db-test:${runId}:correction-apply` };
    const corrected = await applyOrderCorrection(headers, orderId, correctionBody, actor, operatingScope);
    const replay = await applyOrderCorrection(headers, orderId, correctionBody, actor, operatingScope);

    expect(corrected.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.response).toEqual(corrected.response);
    expect(corrected.response.data.correction).toMatchObject({ revision: 1, totalDelta: Number(sale.response.data.total) });
    await expect(stockForVariant()).resolves.toBe(stockAfterSale - 1);

    const correction = corrected.response.data.correction;
    const correctionItems = await client.query(`
      SELECT quantity_before, quantity_after, quantity_delta, stock_delta
      FROM app.order_correction_items
      WHERE correction_id = $1
    `, [correction.id]);
    expect(correctionItems.rows).toEqual([
      expect.objectContaining({ quantity_before: 1, quantity_after: 2, quantity_delta: 1, stock_delta: -1 }),
    ]);

    const correctionMovement = await client.query(`
      SELECT
        movement_type,
        source_action,
        quantity_change::numeric AS quantity_change,
        (quantity_after - quantity_change)::int AS quantity_before,
        quantity_after,
        reference_type,
        reference_id,
        reference_display,
        actor_display_name_snapshot,
        metadata
      FROM medusa.stock_movements
      WHERE reference_type = 'order_correction'
        AND reference_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [correction.id]);
    expect(correctionMovement.rows[0]).toMatchObject({
      movement_type: "manual_adjustment",
      source_action: "order_correction",
      quantity_change: "-1",
      quantity_before: stockAfterSale,
      quantity_after: stockAfterSale - 1,
      reference_type: "order_correction",
      reference_id: correction.id,
      actor_display_name_snapshot: actor.displayName,
    });
    expect(correctionMovement.rows[0]?.reference_display).toContain("correction 1");
    expect(correctionMovement.rows[0]?.metadata).toMatchObject({
      historyQuality: "native",
      orderId,
      correctionId: correction.id,
      revision: 1,
    });

    const payments = await client.query(`
      SELECT direction, method, amount::numeric AS amount, status, metadata
      FROM app.payment_entries
      WHERE order_id = $1
      ORDER BY created_at ASC
    `, [orderId]);
    expect(payments.rows).toHaveLength(2);
    expect(payments.rows[1]).toMatchObject({
      direction: "charge",
      method: "cash",
      status: "posted",
      metadata: expect.objectContaining({ correctionId: correction.id, revision: 1 }),
    });

    const correctionEvent = await queryOne<{ id: string; event_type: string; payload: Record<string, unknown> }>(client, `
      SELECT id::text, event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'order.corrected'
      ORDER BY created_at DESC
      LIMIT 1
    `, [orderId]);
    expect(correctionEvent?.payload).toMatchObject({ correctionId: correction.id, totalDelta: Number(sale.response.data.total) });
    await processOutboxEvent({ id: correctionEvent!.id, eventType: correctionEvent!.event_type, payload: correctionEvent!.payload });
    await processOutboxEvent({ id: correctionEvent!.id, eventType: correctionEvent!.event_type, payload: correctionEvent!.payload });

    const journal = await client.query(`
      SELECT a.code, jl.debit_amount::numeric AS debit, jl.credit_amount::numeric AS credit
      FROM accounting.journal_entries je
      JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
      JOIN accounting.accounts a ON a.id = jl.account_id
      WHERE je.reference_type = 'order_correction' AND je.reference_id = $1
    `, [correction.id]);
    expect(journal.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "1111" }),
      expect.objectContaining({ code: "5111" }),
      expect.objectContaining({ code: "6321" }),
      expect.objectContaining({ code: "1561" }),
    ]));
    const debits = journal.rows.reduce((sum, row) => sum + Number(row.debit || 0), 0);
    const credits = journal.rows.reduce((sum, row) => sum + Number(row.credit || 0), 0);
    expect(debits).toBe(credits);

    const audit = await client.query(`
      SELECT action, reason
      FROM audit.events
      WHERE subject_type = 'order' AND subject_id = $1 AND action = 'order.corrected'
    `, [orderId]);
    expect(audit.rows).toEqual([expect.objectContaining({ reason: correctionBody.reason })]);

    const correctionLoyalty = await client.query(`
      SELECT points_earned, points_redeemed
      FROM ai_module.loyalty_records
      WHERE order_id = $1 AND description LIKE 'Order correction%'
    `, [orderId]);
    expect(correctionLoyalty.rows).toHaveLength(1);
    expect(Number(correctionLoyalty.rows[0].points_earned)).toBeGreaterThan(0);
  });

  it("records a negative correction as payable opening plus exact refund payout without double counting", async () => {
    await ensureStockAtLeast(6);
    const stockBeforeSale = await stockForVariant();
    const sale = await completeSale(
      { "idempotency-key": `db-test:${runId}:negative-correction-sale` },
      {
        customerId: "cus_demo",
        items: [{ variantId, quantity: 2 }],
        paymentMethod: "cash",
        amountReceived: 1_000_000,
        notes: `DB negative correction ${runId}`,
      },
      actor,
      operatingScope,
    );
    const orderId = String(sale.response.data.orderId);
    const originalTotal = Number(sale.response.data.total);
    const unitTotal = originalTotal / 2;
    await expect(stockForVariant()).resolves.toBe(stockBeforeSale - 2);

    const saleEvent = await queryOne<{ id: string; event_type: string; payload: Record<string, unknown> }>(client, `
      SELECT id::text, event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'sale.created'
      ORDER BY created_at DESC LIMIT 1
    `, [orderId]);
    await processOutboxEvent({
      id: saleEvent!.id,
      eventType: saleEvent!.event_type,
      payload: saleEvent!.payload,
    });

    const draft = {
      baseRevision: 0,
      reason: "Khách trả lại một hộp do nhân viên nhập thừa số lượng.",
      items: [{ variantId, quantity: 1 }],
      settlement: { method: "cash", amountReceived: 0 },
    };
    const preview = await previewOrderCorrection(orderId, draft, actor, operatingScope);
    expect(preview.data).toMatchObject({
      totalDelta: -unitTotal,
      settlement: { amount: unitTotal, direction: "refund", status: "posted" },
    });
    const corrected = await applyOrderCorrection(
      { "idempotency-key": `db-test:${runId}:negative-correction-apply` },
      orderId,
      {
        ...draft,
        settlement: { method: "cash", amountReceived: unitTotal },
      },
      actor,
      operatingScope,
    );
    const correction = corrected.response.data.correction;
    expect(correction).toMatchObject({
      revision: 1,
      totalDelta: -unitTotal,
      customerRefundPayableId: expect.any(String),
      canonicalRefundPaymentEventId: expect.any(String),
    });
    await expect(stockForVariant()).resolves.toBe(stockBeforeSale - 1);

    const payable = await queryOne<{
      opened_minor: string;
      cleared_minor: string;
      balance_minor: string;
      status: string;
    }>(client, `
      SELECT opened_minor::text, cleared_minor::text, balance_minor::text, status
      FROM app.customer_refund_payable_balances
      WHERE payable_id = $1::uuid
    `, [correction.customerRefundPayableId]);
    expect(payable).toEqual({
      opened_minor: String(unitTotal),
      cleared_minor: String(unitTotal),
      balance_minor: "0",
      status: "cleared",
    });

    const canonicalEvents = await client.query(`
      SELECT kind, status, method, amount_minor::text
      FROM app.payment_events
      WHERE merchant_id = $1 AND store_id = $2 AND order_id = $3
      ORDER BY source_occurred_at, id
    `, [operatingScope.merchantId, operatingScope.storeId, orderId]);
    expect(canonicalEvents.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "charge", status: "posted", amount_minor: String(originalTotal) }),
      expect.objectContaining({ kind: "refund", status: "posted", amount_minor: String(unitTotal) }),
    ]));

    const correctionEvent = await queryOne<{ id: string; event_type: string; payload: Record<string, unknown> }>(client, `
      SELECT id::text, event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'order.corrected'
      ORDER BY created_at DESC LIMIT 1
    `, [orderId]);
    await processOutboxEvent({
      id: correctionEvent!.id,
      eventType: correctionEvent!.event_type,
      payload: correctionEvent!.payload,
    });
    await processOutboxEvent({
      id: correctionEvent!.id,
      eventType: correctionEvent!.event_type,
      payload: correctionEvent!.payload,
    });

    const journals = await client.query(`
      SELECT je.reference_type, je.reference_id, a.code,
             jl.debit_amount::numeric AS debit, jl.credit_amount::numeric AS credit
      FROM accounting.journal_entries je
      JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
      JOIN accounting.accounts a ON a.id = jl.account_id
      WHERE (je.reference_type = 'order_correction' AND je.reference_id = $1)
         OR (je.reference_type = 'customer_refund_payout' AND je.reference_id = $2)
      ORDER BY je.reference_type, a.code
    `, [correction.id, correction.canonicalRefundPaymentEventId]);
    expect(journals.rows.map((row) => row.code)).toEqual(expect.arrayContaining([
      "CUSTOMER_REFUND_PAYABLE",
      "5111",
      "6321",
      "1561",
      "1111",
    ]));
    for (const referenceType of ["order_correction", "customer_refund_payout"]) {
      const rows = journals.rows.filter((row) => row.reference_type === referenceType);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.reduce((sum, row) => sum + Number(row.debit || 0), 0)).toBe(
        rows.reduce((sum, row) => sum + Number(row.credit || 0), 0),
      );
    }
  });

  it("rejects correction without stock or with a stale revision without mutating order stock", async () => {
    await setStock(1);
    const sale = await completeSale({ "idempotency-key": `db-test:${runId}:correction-short-sale` }, {
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
    }, actor, operatingScope);
    const orderId = String(sale.response.data.orderId);
    const stockAfterSale = await stockForVariant();

    await expect(applyOrderCorrection({ "idempotency-key": `db-test:${runId}:correction-short` }, orderId, {
      baseRevision: 0,
      reason: "Yêu cầu tăng số lượng vượt quá tồn kho hiện có.",
      items: [{ variantId, quantity: 2 }],
      settlement: { method: "cash", amountReceived: Number(sale.response.data.total) },
    }, actor, operatingScope)).rejects.toMatchObject({ code: "insufficient_stock", statusCode: 409 });
    await expect(stockForVariant()).resolves.toBe(stockAfterSale);

    await expect(applyOrderCorrection({ "idempotency-key": `db-test:${runId}:correction-stale` }, orderId, {
      baseRevision: 1,
      reason: "Dùng phiên bản cũ để kiểm tra xung đột điều chỉnh đơn.",
      items: [{ variantId, quantity: 1 }],
    }, actor, operatingScope)).rejects.toMatchObject({ code: "order_correction_conflict", statusCode: 409 });
  });

  it("preserves fixed discount semantics during order correction", async () => {
    await ensureStockAtLeast(5);
    const sale = await completeSale({ "idempotency-key": `db-test:${runId}:fixed-discount-correction-sale` }, {
      customerId: "cus_demo",
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
      discountType: "amount",
      discountValue: 20000,
      shippingFee: 0,
      notes: `DB fixed discount correction ${runId}`,
    }, actor, operatingScope);
    const orderId = String(sale.response.data.orderId);
    const saleTotal = Number(sale.response.data.total);

    const saleEvent = await queryOne<{ id: string; event_type: string; payload: Record<string, unknown> }>(client, `
      SELECT id::text, event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'sale.created'
      ORDER BY created_at DESC
      LIMIT 1
    `, [orderId]);
    await processOutboxEvent({ id: saleEvent!.id, eventType: saleEvent!.event_type, payload: saleEvent!.payload });

    const correctionBody = {
      baseRevision: 0,
      reason: "Tăng số lượng cho đơn có giảm giá cố định.",
      items: [{ variantId, quantity: 2 }],
      settlement: { method: "cash", amountReceived: 0 },
    };
    const preview = await previewOrderCorrection(orderId, {
      ...correctionBody,
      settlement: { method: "cash", amountReceived: 0 },
    }, actor, operatingScope);
    expect(preview.data.beforeTotals.discountType).toBe("amount");
    expect(preview.data.beforeTotals.discount).toBe(20000);
    expect(preview.data.afterTotals.discountType).toBe("amount");
    expect(preview.data.afterTotals.discount).toBe(20000);

    const corrected = await applyOrderCorrection(
      { "idempotency-key": `db-test:${runId}:fixed-discount-correction-apply` },
      orderId,
      { ...correctionBody, settlement: { method: "cash", amountReceived: preview.data.totalDelta } },
      actor,
      operatingScope,
    );
    expect(corrected.statusCode).toBe(201);
    expect(corrected.response.data.correction.afterTotals).toMatchObject({
      discountType: "amount",
      discountValue: 20000,
      discount: 20000,
    });
    // The fixed discount (20000 VND) is unchanged; adding one more unit
    // increases the payable by exactly the unit price (subtotal per unit).
    const unitPrice = Number(sale.response.data.subtotal);
    expect(corrected.response.data.correction.totalDelta).toBe(unitPrice);
  });
});

describe("listOrders date-range filtering", () => {
  it("filters inclusively in the store timezone and reports aggregates not capped by the page limit", async () => {
    await ensureStockAtLeast(8);

    // Create three cash sales, then backdate each to a controlled wall-clock
    // time so the date-range logic (and its timezone handling) is deterministic.
    const createBackdated = async (key: string, createdAt: string) => {
      const sale = await completeSale(
        { "idempotency-key": `db-test:${runId}:datefilter-${key}` },
        {
          customerId: "cus_demo",
          items: [{ variantId, quantity: 1 }],
          paymentMethod: "cash",
          amountReceived: 10_000_000,
          notes: `DB date filter ${runId} ${key}`,
          salesChannel: "pos_counter",
        },
        actor,
        operatingScope,
      );
      const order = sale.response.data;
      await client.query(`UPDATE public."order" SET created_at = $1 WHERE id = $2`, [createdAt, order.id]);
      return order;
    };

    // orderA/orderB land cleanly on their VN calendar day; orderC sits on the
    // UTC/VN midnight boundary: 2026-01-20 18:00 UTC == 2026-01-21 01:00 VN.
    const orderA = await createBackdated("a", "2026-01-10T10:00:00+07:00");
    const orderB = await createBackdated("b", "2026-01-15T10:00:00+07:00");
    const orderC = await createBackdated("c", "2026-01-20T18:00:00+00:00");

    const scope = { merchantId: operatingScope.merchantId, storeIds: reportScope.storeIds };
    const hasId = (res: { orders: Array<{ id: string }> }, id: string) => res.orders.some((o) => o.id === id);

    // Single-day range is inclusive on both ends: orderB (15th) is in, orderA (10th) is out.
    const onlyB = await listOrders({ ...scope, dateFrom: "2026-01-15", dateTo: "2026-01-15" });
    expect(hasId(onlyB, orderB.id)).toBe(true);
    expect(hasId(onlyB, orderA.id)).toBe(false);

    // Timezone boundary: orderC is the 21st in VN. Filtering by the VN day must
    // include it, while a naive UTC-day filter (the 20th) must not.
    const vnDay = await listOrders({ ...scope, dateFrom: "2026-01-21", dateTo: "2026-01-21" });
    expect(hasId(vnDay, orderC.id)).toBe(true);
    const utcDay = await listOrders({ ...scope, dateFrom: "2026-01-20", dateTo: "2026-01-20" });
    expect(hasId(utcDay, orderC.id)).toBe(false);

    // The aggregate must reflect the full filtered set, not the page cap.
    const myRevenue = Number(orderA.total || 0) + Number(orderB.total || 0) + Number(orderC.total || 0);
    const capped = await listOrders({ ...scope, dateFrom: "2026-01-01", dateTo: "2026-01-31", limit: 1 });
    expect(capped.orders).toHaveLength(1);
    expect(capped.totalCount).toBeGreaterThan(capped.orders.length);
    expect(capped.totalRevenue).toBeGreaterThanOrEqual(myRevenue);

    // The aggregate is identical regardless of page size.
    const wide = await listOrders({ ...scope, dateFrom: "2026-01-01", dateTo: "2026-01-31", limit: 200 });
    expect(wide.totalCount).toBe(capped.totalCount);
    expect(wide.totalRevenue).toBe(capped.totalRevenue);
    expect(wide.orders.length).toBeLessThanOrEqual(wide.totalCount);
  });
});
