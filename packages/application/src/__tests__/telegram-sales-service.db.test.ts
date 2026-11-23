import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { queryOne } from "../db/query";
import { claimTelegramNotifications, shutdownPlatformDb } from "../platform-db";
import { createPaymentIntent, settleMockPaymentIntent } from "../services/payment-intent-service";
import {
  checkoutTelegramSalesDraft,
  confirmTelegramSalesDraft,
  createTelegramSalesDraft,
  listTelegramSalesCatalog,
  listTelegramSalesCustomerDrafts,
  listTelegramSalesDrafts,
  quoteTelegramSalesCart,
} from "../services/telegram-sales-service";
import { readCheckoutSettlementPolicy, updateStoreSettlementPolicy } from "../services/store-settlement-policy-service";
import type { OperatorContext } from "../services/auth-service";
import { signJwt } from "../middleware/auth";
import { POST as telegramQuotePost } from "../../../../src/api/channel/telegram-sales/quote/route";
import { POST as telegramDraftPost } from "../../../../src/api/channel/telegram-sales/drafts/route";
import { POST as telegramConfirmPost } from "../../../../src/api/admin/telegram-sales/drafts/[id]/confirm/route";
import { POST as telegramCheckoutPost } from "../../../../src/api/admin/telegram-sales/drafts/[id]/checkout/route";
import { POST as platformTelegramConfirmPost } from "../../../../src/api/platform/admin/telegram-sales/drafts/[id]/confirm/route";
import { POST as platformTelegramCheckoutPost } from "../../../../src/api/platform/admin/telegram-sales/drafts/[id]/checkout/route";

const originalTelegramToken = process.env.TELEGRAM_SERVICE_TOKEN;
const originalPackageKey = process.env.APP_PACKAGE_KEY;
const originalSepayPaymentsEnabled = process.env.SEPAY_PAYMENTS_ENABLED;
const serviceToken = "db-test-telegram-sales-token";
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const telegramUserId = `telegram_sales_${runId}`;
const notificationOperatorId = `telegram_notify_${runId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
const notificationProviderUserId = `telegram_notify_user_${runId}`;
const variantId = "var_mint_20";
const merchantId = "merchant_default";
const storeId = "store_default";
const stockLocationId = "sloc_default";

let client: PoolClient;
let baselineStock = 0;
let draftId = "";
let checkoutDraftId = "";
let fallbackSalesVariantId = "";
let fallbackSalesSku = "";
let fallbackSalesOriginalMetadata: Record<string, unknown> | null = null;

const channelHeaders = {
  authorization: `Bearer ${serviceToken}`,
  "x-channel": "telegram",
  "x-channel-user-id": telegramUserId,
  "x-merchant-id": merchantId,
  "x-store-id": storeId,
  "x-request-id": `db-test-${runId}`,
};

const ownerActor: OperatorContext = {
  operatorId: "op_owner",
  role: "owner",
  displayName: "Store Owner",
  organizationId: "org_default",
  permissions: ["remote_order:create", "orders:read"],
};

async function stockForVariant(): Promise<number> {
  const row = await queryOne<{ stocked_quantity: string }>(client, `
    SELECT il.stocked_quantity::numeric AS stocked_quantity
    FROM public.product_variant_inventory_item vii
    JOIN public.inventory_level il ON il.inventory_item_id = vii.inventory_item_id AND il.deleted_at IS NULL
    WHERE vii.variant_id = $1 AND vii.deleted_at IS NULL
      AND il.location_id = $2
    LIMIT 1
  `, [variantId, stockLocationId]);
  return Number(row?.stocked_quantity || 0);
}

const originalManualBankFlag = process.env.MANUAL_BANK_CONFIRMATION_ENABLED;
beforeAll(async () => {
  // These fixtures deliberately exercise the available manual-confirmation rail.
  process.env.MANUAL_BANK_CONFIRMATION_ENABLED = "true";
  process.env.TELEGRAM_SERVICE_TOKEN = serviceToken;
  process.env.APP_PACKAGE_KEY = "ai_fan";
  process.env.SEPAY_PAYMENTS_ENABLED = "true";
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  const fallbackSalesVariant = await queryOne<{ id: string; sku: string; metadata: Record<string, unknown> | null }>(client, `
    SELECT pv.id, COALESCE(pv.sku, '') AS sku, pv.metadata
    FROM public.product p
    JOIN public.product_variant pv
      ON pv.product_id = p.id
     AND pv.deleted_at IS NULL
    JOIN public.product_variant_inventory_item pvii
      ON pvii.variant_id = pv.id
     AND pvii.deleted_at IS NULL
    JOIN public.inventory_level il
      ON il.inventory_item_id = pvii.inventory_item_id
     AND il.deleted_at IS NULL
     AND il.location_id = $1
     AND il.stocked_quantity > 0
    WHERE p.merchant_id = $2
      AND p.status = 'published'
      AND p.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.order_line_item li
        WHERE li.variant_id = pv.id
          AND li.deleted_at IS NULL
      )
    ORDER BY p.title ASC
    LIMIT 1
  `, [stockLocationId, merchantId]);
  fallbackSalesVariantId = fallbackSalesVariant?.id || "";
  fallbackSalesSku = fallbackSalesVariant?.sku || "";
  fallbackSalesOriginalMetadata = fallbackSalesVariant?.metadata || null;
  if (fallbackSalesVariantId) {
    await client.query(`
      UPDATE public.product_variant
      SET metadata = (
            CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END
          ) || '{"telegramSalesQuantity":"4242"}'::jsonb,
          updated_at = now()
      WHERE id = $1
    `, [fallbackSalesVariantId]);
  }
  baselineStock = await stockForVariant();
  if (baselineStock < 3) {
    await client.query(`
      UPDATE public.inventory_level il
      SET stocked_quantity = 10, updated_at = now()
      FROM public.product_variant_inventory_item vii
      WHERE vii.inventory_item_id = il.inventory_item_id
        AND vii.variant_id = $1
        AND il.location_id = $2
        AND il.deleted_at IS NULL
        AND vii.deleted_at IS NULL
    `, [variantId, stockLocationId]);
    baselineStock = await stockForVariant();
  }

  const owner = await queryOne<{ password_hash: string }>(client, `
    SELECT password_hash
    FROM medusa.staff_users
    WHERE operator_id = 'op_owner'
    LIMIT 1
  `);
  if (!owner) throw new Error("op_owner fixture is required for telegram sales DB test");
  await client.query(`
    DELETE FROM app.operator_identities
    WHERE provider = 'telegram'
      AND (provider_user_id = $1 OR operator_id = $2)
  `, [notificationProviderUserId, notificationOperatorId]);
  await client.query("DELETE FROM medusa.staff_users WHERE operator_id = $1", [notificationOperatorId]);
  await client.query(`
    INSERT INTO medusa.staff_users (operator_id, password_hash, display_name, role, organization_id, is_active)
    VALUES ($1, $2, 'Telegram Notify Test', 'owner', 'org_default', true)
  `, [notificationOperatorId, owner.password_hash]);
  await client.query(`
    INSERT INTO app.operator_identities (
      organization_id,
      merchant_id,
      default_store_id,
      provider,
      provider_user_id,
      operator_id,
      display_name,
      is_active,
      verified_at
    )
    VALUES ('org_default', $1, $2, 'telegram', $3, $4, 'Telegram Notify Test', true, now())
  `, [merchantId, storeId, notificationProviderUserId, notificationOperatorId]);
  await client.query(`
    DELETE FROM notification.telegram_notifications
    WHERE source_event_id LIKE 'telegram-sales-draft:%'
      AND payload->>'telegramUserId' = $1
  `, [telegramUserId]);
});

afterAll(async () => {
  if (originalManualBankFlag === undefined) delete process.env.MANUAL_BANK_CONFIRMATION_ENABLED;
  else process.env.MANUAL_BANK_CONFIRMATION_ENABLED = originalManualBankFlag;
  if (fallbackSalesVariantId) {
    await client?.query("UPDATE public.product_variant SET metadata = $2::jsonb, updated_at = now() WHERE id = $1", [
      fallbackSalesVariantId,
      JSON.stringify(fallbackSalesOriginalMetadata),
    ]).catch(() => undefined);
  }
  await client?.query(`
    UPDATE public.inventory_level il
    SET stocked_quantity = GREATEST(stocked_quantity, $3), updated_at = now()
    FROM public.product_variant_inventory_item vii
    WHERE vii.inventory_item_id = il.inventory_item_id
      AND vii.variant_id = $1
      AND il.location_id = $2
      AND il.deleted_at IS NULL
      AND vii.deleted_at IS NULL
  `, [variantId, stockLocationId, baselineStock]).catch(() => undefined);
  await client?.query("DELETE FROM app.telegram_sales_drafts WHERE telegram_user_id = $1", [telegramUserId]).catch(() => undefined);
  await client?.query("DELETE FROM app.telegram_sales_profiles WHERE telegram_user_id = $1", [telegramUserId]).catch(() => undefined);
  await client?.query("DELETE FROM notification.telegram_notifications WHERE payload->>'telegramUserId' = $1", [telegramUserId]).catch(() => undefined);
  await client?.query("DELETE FROM app.operator_identities WHERE provider = 'telegram' AND provider_user_id = $1", [notificationProviderUserId]).catch(() => undefined);
  await client?.query("DELETE FROM medusa.staff_users WHERE operator_id = $1", [notificationOperatorId]).catch(() => undefined);
  await client?.query("DELETE FROM app.idempotency_records WHERE idempotency_key LIKE $1 OR idempotency_key = $2", [
    `db-test:${runId}:%`,
    draftId ? `telegram-sales-confirm:${draftId}` : "",
  ]).catch(() => undefined);
  client?.release();
  if (originalTelegramToken === undefined) delete process.env.TELEGRAM_SERVICE_TOKEN;
  else process.env.TELEGRAM_SERVICE_TOKEN = originalTelegramToken;
  if (originalPackageKey === undefined) delete process.env.APP_PACKAGE_KEY;
  else process.env.APP_PACKAGE_KEY = originalPackageKey;
  if (originalSepayPaymentsEnabled === undefined) delete process.env.SEPAY_PAYMENTS_ENABLED;
  else process.env.SEPAY_PAYMENTS_ENABLED = originalSepayPaymentsEnabled;
  await shutdownPlatformDb().catch(() => undefined);
});

describe("telegram sales service PostgreSQL integration", () => {
  it.each([0, 2])("rejects unsupported payment fee=%s at every raw Telegram boundary before facts or draft lookup", async paymentFeeValue => {
    const input = { items: [{ variantId, quantity: 1 }], paymentMethod: "cash", amountReceived: 1_000_000,
      paymentFeeType: "percent" as const, paymentFeeValue, operatorNotes: "Synthetic unsupported fee probe" };
    const scope = { scopeKind: "operating" as const, merchantId, storeId, stockLocationId };
    const facts = async () => (await client.query(`SELECT
      (SELECT count(*) FROM app.telegram_sales_profiles WHERE telegram_user_id=$1) AS profiles,
      (SELECT count(*) FROM app.telegram_sales_drafts WHERE telegram_user_id=$1) AS drafts,
      (SELECT count(*) FROM public."order" WHERE merchant_id=$2) AS orders,
      (SELECT count(*) FROM app.payment_entries WHERE merchant_id=$2) AS payments,
      (SELECT count(*) FROM outbox.events WHERE merchant_id=$2) AS outbox,
      (SELECT count(*) FROM app.idempotency_records WHERE tenant_id=$2) AS receipts`, [telegramUserId, merchantId])).rows[0];
    const before = { ...await facts(), stock: await stockForVariant() };
    for (const send of [
      () => quoteTelegramSalesCart(channelHeaders, input),
      () => createTelegramSalesDraft({ ...channelHeaders, "idempotency-key": `unsupported-fee-${runId}-${paymentFeeValue}` }, input),
      () => confirmTelegramSalesDraft(channelHeaders, `missing-${runId}`, input, ownerActor, scope),
      () => checkoutTelegramSalesDraft(channelHeaders, `missing-${runId}`, input, ownerActor, scope),
    ]) {
      await expect(send()).rejects.toMatchObject({ code: "validation_error", statusCode: 400,
        message: "Payment fee is not supported by Telegram sales" });
      expect({ ...await facts(), stock: await stockForVariant() }).toEqual(before);
    }
    const staffHeaders = { authorization: `Bearer ${signJwt({ operatorId: "op_owner", role: "owner", displayName: "Owner",
      organizationId: "org_default", sessionVersion: 1, authState: "authenticated" })}`,
      "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId };
    for (const [handler, requestHeaders] of [
      [telegramQuotePost, channelHeaders], [telegramDraftPost, channelHeaders],
      [telegramConfirmPost, staffHeaders], [telegramCheckoutPost, staffHeaders],
      [platformTelegramConfirmPost, staffHeaders], [platformTelegramCheckoutPost, staffHeaders],
    ] as const) {
      const response = { statusCode: 200, payload: undefined as unknown,
        status(value: number) { this.statusCode = value; return this; },
        json(value: unknown) { this.payload = value; }, setHeader() {} };
      await handler({ headers: { ...requestHeaders, "idempotency-key": `http-fee-${runId}-${paymentFeeValue}` }, body: input,
        params: { id: `missing-${runId}` }, query: {} } as never, response as never);
      expect(response.statusCode).toBe(400);
      expect(response.payload).toMatchObject({ error: { code: "validation_error", message: "Payment fee is not supported by Telegram sales" } });
      expect({ ...await facts(), stock: await stockForVariant() }).toEqual(before);
    }
  });
  it("exposes customer-safe catalog and quote data without exact stock", async () => {
    const catalog = await listTelegramSalesCatalog(channelHeaders, { q: "MINT-MED-20", limit: 20 });
    expect(catalog.data.length).toBeGreaterThan(0);
    const item = catalog.data.find((entry) => entry.variantId === variantId);
    expect(item).toMatchObject({
      variantId,
      availability: expect.stringMatching(/available|low_stock|out_of_stock/),
    });
    expect(item).not.toHaveProperty("stock");
    expect(item).not.toHaveProperty("inventory_quantity");

    if (fallbackSalesVariantId && fallbackSalesSku) {
      const fallbackCatalog = await listTelegramSalesCatalog(channelHeaders, { q: fallbackSalesSku, limit: 20 });
      const fallbackItem = fallbackCatalog.data.find((entry) => entry.variantId === fallbackSalesVariantId);
      expect(fallbackItem).toMatchObject({
        variantId: fallbackSalesVariantId,
      });
      expect(Number(fallbackItem?.salesQuantity || 0)).toBeGreaterThanOrEqual(0);
      expect(Number(fallbackItem?.salesRank || 0)).toBeGreaterThan(0);
    }

    const quote = await quoteTelegramSalesCart(channelHeaders, {
      items: [{ variantId, quantity: 1 }],
      shippingFee: 15000,
    });
    expect(quote.data).toMatchObject({
      currencyCode: "vnd",
      paymentMethod: "cod",
      salesChannel: "telegram",
      shippingFee: 15000,
    });
    expect(quote.data.items[0]).toMatchObject({
      variantId,
      quantity: 1,
      canFulfill: true,
    });
    expect(quote.data.items[0]).not.toHaveProperty("stock");
  });

  it("creates a Telegram sales draft idempotently and converts it only after staff confirmation", async () => {
    const body = {
      profile: {
        telegramUserId,
        telegramChatId: telegramUserId,
        username: "db_test_customer",
        firstName: "DB Test Customer",
        language: "en",
      },
      items: [{ variantId, quantity: 1 }],
      delivery: {
        address: "UAT test address",
        note: "Call on arrival",
      },
      customerMessage: "I want one mint pouch",
      shippingFee: 15000,
      aiMetadata: {
        provider: "db-test",
      },
    };
    const headers = {
      ...channelHeaders,
      "idempotency-key": `db-test:${runId}:draft`,
    };

    const created = await createTelegramSalesDraft(headers, body);
    const replay = await createTelegramSalesDraft(headers, body);

    expect(created.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.response).toEqual(created.response);
    draftId = String(created.response.data.id);
    expect(created.response.data).toMatchObject({
      status: "needs_review",
      telegramUserId,
      telegramUsername: "db_test_customer",
      convertedOrderId: null,
    });
    const notifications = await client.query<{
      id: string;
      organization_id: string;
      merchant_id: string | null;
      store_id: string | null;
      recipient_operator_id: string | null;
      recipient_id: string | null;
      telegram_chat_id: string | null;
      template: string;
      payload: Record<string, unknown>;
    }>(`
      SELECT id::text, organization_id, merchant_id, store_id,
             recipient_operator_id, recipient_id::text, telegram_chat_id,
             template, payload
      FROM notification.telegram_notifications
      WHERE source_event_id = $1
      ORDER BY recipient_operator_id NULLS LAST, created_at ASC
    `, [`telegram-sales-draft:${draftId}`]);
    expect(notifications.rows.length).toBeGreaterThan(0);
    const notification = notifications.rows.find((row) => row.recipient_operator_id === notificationOperatorId)
      || notifications.rows[0];
    expect(notification).toMatchObject({
      organization_id: "org_default",
      merchant_id: merchantId,
      store_id: storeId,
      template: "telegram_sales_request_created",
    });
    expect(notification.recipient_operator_id === notificationOperatorId || notification.recipient_id).toBeTruthy();
    expect(notification?.payload).toMatchObject({
      draftId,
      telegramUserId,
      telegramUsername: "db_test_customer",
      telegramUrl: "https://t.me/db_test_customer",
      portalPath: "/telegram-sales",
      actionLabel: "Thanh toán",
    });
    await client.query(`
      UPDATE notification.telegram_notifications
      SET status = 'pending',
          attempts = 0,
          claimed_until = NULL,
          next_retry_at = NULL,
          created_at = TIMESTAMPTZ '1970-01-01 00:00:00+00',
          updated_at = now()
      WHERE id = $1
    `, [notification.id]);
    const claimedNotifications = await claimTelegramNotifications(channelHeaders, 25);
    const claimedNotification = claimedNotifications.data.find((entry) => entry.id === notification?.id);
    expect(claimedNotification).toMatchObject({
      template: "telegram_sales_request_created",
      attempts: 1,
    });
    if (notification.recipient_operator_id) {
      expect(claimedNotification).toMatchObject({
        telegramUserId: notificationProviderUserId,
        recipientOperatorId: notificationOperatorId,
      });
    } else {
      expect(claimedNotification?.recipientId).toBe(notification.recipient_id);
      expect(claimedNotification?.telegramUserId).toBeTruthy();
    }
    expect(claimedNotification?.text).toContain("Telegram sales request moi");
    expect(claimedNotification?.text).toContain(draftId);
    expect(claimedNotification?.text).toContain("Chat Telegram: https://t.me/db_test_customer");
    expect(claimedNotification?.text).toContain("Xu ly tai POS: /telegram-sales");

    const customerHistory = await listTelegramSalesCustomerDrafts(channelHeaders, { limit: 5, offset: 0 });
    const customerDraft = customerHistory.data.find((draft) => draft.id === draftId);
    expect(Number(customerHistory.statusCounts?.needs_review || 0)).toBeGreaterThanOrEqual(1);
    expect(customerDraft).toMatchObject({
      id: draftId,
      status: "needs_review",
      customerMessage: "I want one mint pouch",
      convertedOrderId: null,
      delivery: {
        address: "UAT test address",
        note: "Call on arrival",
      },
      quote: {
        total: expect.any(Number),
        items: [
          expect.objectContaining({
            title: expect.any(String),
            quantity: 1,
          }),
        ],
      },
    });
    expect(customerDraft?.quote.items[0]).not.toHaveProperty("variantId");
    expect(customerDraft).not.toHaveProperty("operatorNotes");
    expect(customerDraft).not.toHaveProperty("merchantId");

    const pendingInbox = await listTelegramSalesDrafts(
      { status: "pending", limit: 10 },
      { scopeKind: "report", merchantId, storeIds: [storeId] },
    );
    expect(pendingInbox.data.some((draft) => draft.id === draftId && draft.status === "needs_review")).toBe(true);
    await expect(stockForVariant()).resolves.toBe(baselineStock);

    const confirmed = await confirmTelegramSalesDraft(
      { "x-request-id": `db-test-${runId}:confirm` },
      draftId,
      { shippingFee: 15000, operatorNotes: "Approved in DB integration test" },
      ownerActor,
      { scopeKind: "operating", merchantId, storeId, stockLocationId },
    );

    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.response.data.draft).toMatchObject({
      id: draftId,
      status: "converted",
    });
    expect(confirmed.response.data.order).toMatchObject({
      remoteStatus: "confirmed",
      medusaStatus: "completed",
      salesChannel: "telegram",
      paymentMethod: "cod",
    });
    await expect(stockForVariant()).resolves.toBe(baselineStock - 1);

    const audit = await client.query(`
      SELECT actor_id, action, channel, channel_user_id, service_identity
      FROM audit.events
      WHERE subject_type = 'order'
        AND subject_id = $1
        AND action = 'order.remote_created'
      ORDER BY created_at DESC
      LIMIT 1
    `, [confirmed.response.data.order.orderId]);
    expect(audit.rows[0]).toMatchObject({
      actor_id: "op_owner",
      action: "order.remote_created",
      channel: "telegram",
      channel_user_id: telegramUserId,
      service_identity: "telegram_sales_portal_confirm",
    });
  });

  it.each(["manual_confirmation", "confirm_on_booking"] as const)("checks out a Telegram sales draft with %s policy through the POS cart payment flow", async (mode) => {
    const originalMetadata = (await client.query("SELECT metadata FROM app.stores WHERE id=$1", [storeId])).rows[0].metadata;
    const previousPolicy = (await readCheckoutSettlementPolicy(merchantId, storeId)).data;
    await updateStoreSettlementPolicy(storeId, { mode, expectedVersion: previousPolicy.policyVersion }, ownerActor, { scopeKind: "merchant_target", merchantId });
    const policy = (await readCheckoutSettlementPolicy(merchantId, storeId)).data;
    try {
    const stockBefore = await stockForVariant();
    expect(stockBefore).toBeGreaterThan(0);

    const created = await createTelegramSalesDraft({
      ...channelHeaders,
      "idempotency-key": `db-test:${runId}:checkout-draft:${mode}`,
    }, {
      profile: {
        telegramUserId,
        telegramChatId: telegramUserId,
        username: "db_test_customer",
        firstName: "DB Test Customer",
        language: "en",
      },
      items: [{ variantId, quantity: 1 }],
      delivery: {
        address: "Checkout test address",
        note: "Leave with reception",
      },
      customerMessage: "Checkout one mint pouch from Telegram",
      shippingFee: 12000,
      aiMetadata: {
        provider: "db-test",
      },
    });
    checkoutDraftId = String(created.response.data.id);

    const checkedOut = await checkoutTelegramSalesDraft(
      { "idempotency-key": `db-test:${runId}:checkout:${mode}`, "x-request-id": `db-test-${runId}:checkout` },
      checkoutDraftId,
      {
        items: [{ variantId, quantity: 1 }],
        paymentMethod: "bank_transfer",
        amountReceived: 0,
        discountType: "amount",
        discountValue: 10000,
        shippingFee: 12000,
        customerMode: "walk_in",
        ...(mode === "confirm_on_booking" ? { bankTransferSettlementAcknowledgment: { policyVersion: policy.policyVersion, acknowledgmentVersion: policy.acknowledgmentVersion } } : {}),
        notes: "Customer will pay by bank transfer at counter.",
        operatorNotes: "Portal checkout uses shared cart flow.",
        salesChannel: "telegram",
        sourceFlow: "telegram_sales",
        salesChannelLocked: true,
      },
      ownerActor,
      { scopeKind: "operating", merchantId, storeId, stockLocationId },
    );

    expect(checkedOut.statusCode).toBe(201);
    expect(checkedOut.response.data.order.paymentStatus).toBe(mode === "confirm_on_booking" ? "posted" : "pending");
    expect(checkedOut.response.data.draft).toMatchObject({
      id: checkoutDraftId,
      status: "converted",
      convertedOrderId: expect.any(String),
      operatorNotes: "Portal checkout uses shared cart flow.",
      quote: expect.objectContaining({
        paymentMethod: "bank_transfer",
        salesChannel: "telegram",
        shippingFee: 12000,
        discount: 10000,
        total: expect.any(Number),
      }),
    });
    expect(checkedOut.response.data.order).toMatchObject({
      salesChannel: "telegram",
      paymentMethod: "bank_transfer",
      sourceFlow: "telegram_sales",
      salesChannelLocked: true,
      customerNickname: "@db_test_customer",
      customerContactType: "telegram",
      notes: expect.stringContaining("Telegram draft:"),
    });
    await expect(stockForVariant()).resolves.toBe(stockBefore - 1);

    const draftRow = await queryOne<{ status: string; converted_order_id: string | null; quote: Record<string, unknown> }>(client, `
      SELECT status, converted_order_id, quote
      FROM app.telegram_sales_drafts
      WHERE id = $1
      LIMIT 1
    `, [checkoutDraftId]);
    expect(draftRow).toMatchObject({
      status: "converted",
      converted_order_id: checkedOut.response.data.order.orderId,
    });
    expect(draftRow?.quote).toMatchObject({
      paymentMethod: "bank_transfer",
      salesChannel: "telegram",
    });

    const draftAudit = await client.query(`
      SELECT actor_id, action, subject_id
      FROM audit.events
      WHERE subject_type = 'telegram_sales_draft'
        AND subject_id = $1
        AND action = 'telegram_sales.draft_checked_out'
      ORDER BY created_at DESC
      LIMIT 1
    `, [checkoutDraftId]);
    expect(draftAudit.rows[0]).toMatchObject({
      actor_id: "op_owner",
      action: "telegram_sales.draft_checked_out",
      subject_id: checkoutDraftId,
    });

    const orderAudit = await client.query(`
      SELECT actor_id, action
      FROM audit.events
      WHERE subject_type = 'order'
        AND subject_id = $1
        AND action = 'order.created'
      ORDER BY created_at DESC
      LIMIT 1
    `, [checkedOut.response.data.order.orderId]);
    expect(orderAudit.rows[0]).toMatchObject({
      actor_id: "op_owner",
      action: "order.created",
    });
    } finally {
      await client.query("UPDATE app.stores SET metadata=$2::jsonb WHERE id=$1", [storeId, JSON.stringify(originalMetadata)]);
    }
  });

  it("converts a Telegram sales draft when a SePay payment intent settles", async () => {
    const stockBefore = await stockForVariant();
    expect(stockBefore).toBeGreaterThan(0);

    const created = await createTelegramSalesDraft({
      ...channelHeaders,
      "idempotency-key": `db-test:${runId}:sepay-intent-draft`,
    }, {
      profile: {
        telegramUserId,
        telegramChatId: telegramUserId,
        username: "db_test_customer",
        firstName: "DB Test Customer",
        language: "en",
      },
      items: [{ variantId, quantity: 1 }],
      delivery: {
        address: "SePay intent address",
        note: "Call before delivery",
      },
      customerMessage: "Checkout one pouch with SePay",
      shippingFee: 9000,
      aiMetadata: {
        provider: "db-test",
      },
    });
    const sepayDraftId = String(created.response.data.id);

    const intentCreate = await createPaymentIntent({ "idempotency-key": `db-test:${runId}:sepay-intent:create` }, {
      provider: "sepay_va",
      order: {
        items: [{ variantId, quantity: 1 }],
        paymentMethod: "sepay_va",
        amountReceived: 0,
        shippingFee: 9000,
        notes: "Telegram SePay payment intent checkout.",
        salesChannel: "telegram",
        sourceFlow: "telegram_sales",
        salesChannelLocked: true,
        customerNickname: "@db_test_customer",
        customerContactType: "telegram",
        telegramSalesDraftId: sepayDraftId,
        telegramSalesOperatorNotes: "Settle SePay intent from Telegram inbox.",
      },
    }, ownerActor, { merchantId, storeId, stockLocationId });

    expect(intentCreate.statusCode).toBe(201);
    expect(intentCreate.response.data).toMatchObject({
      provider: "sepay_va",
      status: "pending",
    });

    const settled = await settleMockPaymentIntent(
      { "idempotency-key": `db-test:${runId}:sepay-intent:settle` },
      intentCreate.response.data.id,
      ownerActor,
      { merchantId, storeId },
    );

    expect(settled.statusCode).toBe(201);
    expect(settled.response.data).toMatchObject({
      provider: "sepay_va",
      status: "completed",
      completedOrderId: expect.any(String),
    });
    expect(settled.response.order).toMatchObject({
      salesChannel: "telegram",
      paymentMethod: "sepay_va",
      sourceFlow: "telegram_sales",
      salesChannelLocked: true,
      customerNickname: "@db_test_customer",
      customerContactType: "telegram",
      telegramSalesDraftId: sepayDraftId,
    });
    await expect(stockForVariant()).resolves.toBe(stockBefore - 1);

    const draftRow = await queryOne<{ status: string; converted_order_id: string | null; operator_notes: string | null; quote: Record<string, unknown> }>(client, `
      SELECT status, converted_order_id, operator_notes, quote
      FROM app.telegram_sales_drafts
      WHERE id = $1
      LIMIT 1
    `, [sepayDraftId]);
    expect(draftRow).toMatchObject({
      status: "converted",
      converted_order_id: settled.response.data.completedOrderId,
      operator_notes: "Settle SePay intent from Telegram inbox.",
      quote: expect.objectContaining({
        paymentMethod: "sepay_va",
        salesChannel: "telegram",
        shippingFee: 9000,
      }),
    });

    const orderRow = await queryOne<{ metadata: Record<string, unknown> }>(client, `
      SELECT metadata
      FROM public."order"
      WHERE id = $1
      LIMIT 1
    `, [settled.response.data.completedOrderId]);
    expect(orderRow?.metadata).toMatchObject({
      paymentMethod: "sepay_va",
      salesChannel: "telegram",
      sourceFlow: "telegram_sales",
      telegramSalesDraftId: sepayDraftId,
    });

    const draftAudit = await client.query(`
      SELECT actor_id, action, after
      FROM audit.events
      WHERE subject_type = 'telegram_sales_draft'
        AND subject_id = $1
        AND action = 'telegram_sales.draft_checked_out'
      ORDER BY created_at DESC
      LIMIT 1
    `, [sepayDraftId]);
    expect(draftAudit.rows[0]).toMatchObject({
      actor_id: "op_owner",
      action: "telegram_sales.draft_checked_out",
    });
    expect(draftAudit.rows[0]?.after).toMatchObject({
      source: "payment_intent_settlement",
      paymentMethod: "sepay_va",
    });
  });
});
