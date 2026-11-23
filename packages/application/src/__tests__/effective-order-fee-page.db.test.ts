import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const admissionFixture = vi.hoisted(() => ({ ready: false }));
vi.mock("@medusa-snus/application", async original => {
  const actual = await original<typeof import("@medusa-snus/application")>();
  return { ...actual, getBuildInfoV2: (...args: Parameters<typeof actual.getBuildInfoV2>) => admissionFixture.ready ? readyBuild : actual.getBuildInfoV2(...args) };
});
import { connectPlatformClient, shutdownPlatformPool, type PoolClient } from "../db/client";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { calculateOrderTotals, calculateOrderTotalsV2 } from "../services/order-total-service";
import { recordOriginalOrderCommercialRevisionFromOrderCreateV1, recordOriginalOrderCommercialRevisionFromOrderCreateV2 } from "../services/original-order-commercial-revision-caller";
import { appendCancellationCommercialRevisionV1 } from "../services/cancellation-commercial-revision-service";
import { recordAuditEntry } from "../repositories/audit-repository";
import { PostgresOrderPageSnapshotRepositoryV1 } from "../services/postgres-order-page-snapshot-repository";
import { readEffectiveOrderPageV4, readEffectiveOrderPageV5 } from "../services/effective-order-page-service";
import { normalizeOrderCursorFiltersV1 } from "../services/order-cursor-service";
import type { CreatorSelectionV1 } from "@medusa-snus/contracts";
import { CartPaymentFeePreviewV1Schema, OrderPaymentFeeFinancialSnapshotV1Schema, OrderCorrectionFinancialContextV1Schema, OrderCorrectionFinancialPreviewV1Schema, OrderCorrectionFinancialResponseV1Schema, EffectiveOrderRecreatePrefillV3Schema, CreatorSalesDashboardV3Schema, ORDER_CSV_ORDER_V5_HEADERS, ORDER_CSV_LINE_V5_HEADERS, EffectiveOrderPageV5Schema } from "@medusa-snus/contracts";
import { signJwt } from "../middleware/auth";
import { completeSale, quoteSaleForClient, previewOrderShippingFee, updateOrderShippingFee } from "../services/order-service";
import { previewOrderCorrection, applyOrderCorrection } from "../services/order-correction-service";
import { RuntimeBuildInfoV2Schema, emptyRuntimeCapabilitySetV1, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1, PAYMENT_FEE_WRITE_HTTP_HEADER_V1 } from "@medusa-snus/contracts/runtime-capabilities";
import { processOutboxEvent } from "../services/outbox-processor-service";
import { readCreatorSalesDashboardV3 } from "../services/creator-sales-dashboard-v2-service";
import { GET as pageRoute } from "../../../../src/api/admin/orders/effective-v5/route";
import { GET as pageAlias } from "../../../../src/api/platform/admin/orders/effective-v5/route";

import { readDashboardCommercialSliceV1, readDashboardCommercialSliceV2 } from "../services/dashboard-commercial-slice";
import { withDashboardReadSnapshot } from "../services/dashboard-report-foundation";
import { resolveDashboardStoreWindows, resolveDashboardHistoryStoreWindows } from "../services/dashboard-report-foundation";
import { parseCsvRows } from "../services/csv-parse-service";
import { exportEffectiveOrderSnapshotCsvV4, exportEffectiveOrderSnapshotCsvV5 } from "../services/effective-order-csv-v4-snapshot-export-service";
import { GET as legacyDashboardRoute } from "../../../../src/api/admin/dashboard/route";
import { GET as dashboardV3 } from "../../../../src/api/admin/dashboard/creator-sales-v3/route";
import { GET as dashboardV3Alias } from "../../../../src/api/platform/admin/dashboard/creator-sales-v3/route";
import { GET as recreateV3 } from "../../../../src/api/orders/[id]/effective-recreate-prefill-v3/route";
import { GET as recreateV2 } from "../../../../src/api/orders/[id]/effective-recreate-prefill-v2/route";
import { POST as checkoutPost } from "../../../../src/api/pos/carts/complete/route";
import { POST as cartPreviewPost } from "../../../../src/api/pos/carts/preview/route";
import { GET as correctionContextGet } from "../../../../src/api/admin/orders/[id]/corrections/preview/route";
import { GET as correctionContextAlias } from "../../../../src/api/platform/admin/orders/[id]/corrections/preview/route";
import { POST as intentPost } from "../../../../src/api/payment-intents/route";
import { POST as intentCreationReceiptPost } from "../../../../src/api/payment-intents/creation-receipt/route";
import { POST as intentCreationClosePost } from "../../../../src/api/payment-intents/creation-receipt/close/route";
import { paymentIntentCreationKeyPrefixV1 } from "@medusa-snus/contracts";
import { createPaymentIntent, closePaymentIntentCreationReceiptV1, recoverPaymentIntentCreationReceiptV1 } from "../services/payment-intent-service";
import { GET as intentListGet } from "../../../../src/api/payment-intents/route";
import { GET as intentGet } from "../../../../src/api/payment-intents/[id]/route";
import { POST as intentCancelPost } from "../../../../src/api/payment-intents/[id]/cancel/route";
import { POST as intentSettlePost } from "../../../../src/api/payment-intents/[id]/mock-settle/route";
import { POST as correctionPreviewPost } from "../../../../src/api/admin/orders/[id]/corrections/preview/route";
import { POST as correctionApplyPost } from "../../../../src/api/admin/orders/[id]/corrections/route";
import { GET as dashboardRoute } from "../../../../src/api/admin/dashboard/creator-sales-v2/route";
import { GET as csvRoute } from "../../../../src/api/admin/orders/export-effective-v5/route";
import { GET as csvAlias } from "../../../../src/api/platform/admin/orders/export-effective-v5/route";
let db: PoolClient;
const prefix = `v5-${randomUUID()}`, merchantId = `${prefix}:m`, storeId = `${prefix}:s`;
const scope = { merchantId, storeIds: [storeId] };
const catalog = { product: `${prefix}:product`, variant: `${prefix}:variant`, item: `${prefix}:item`, priceSet: `${prefix}:prices`, foreignMerchant: `${prefix}:foreign` };
const keyring = { current: { keyId: "owned-v5", keyBase64Url: Buffer.alloc(32, 21).toString("base64url") } };
const staffA = `${prefix}:a`, staffB = `${prefix}:b`, manager = `${prefix}:manager`;
const ids = { free: `${prefix}:free`, inclusive: `${prefix}:inclusive`, exclusive: `${prefix}:exclusive`, cancelled: `${prefix}:cancelled` };
// Synthetic admission isolates handler/business wiring; it does not qualify compiled/native readiness.
const readyBuild = RuntimeBuildInfoV2Schema.parse({ schemaVersion: 2, service: "medusa", sourceCommit: "a".repeat(40), releaseId: "synthetic-fee-snapshot",
  compatibilityFamily: "snus-runtime-v1", capabilities: { ...emptyRuntimeCapabilitySetV1(), checkoutWrite: ["v1"], paymentWrite: ["v1"] },
  paymentFeeCapabilities: { ordersRead: ["v5"], orderDetail: ["v3"], orderRecreate: ["v3"], csvRead: ["v5"], dashboardRead: ["v3"], paymentFeeWrite: ["v1"] } });
function filters(selection: CreatorSelectionV1 = { mode: "all", creatorOperatorIds: [] }, statusMode: "all" | "completed" | "other" = "all") {
  return { ...normalizeOrderCursorFiltersV1({ statusMode,
    storeWindows: [{ storeId, startInclusive: "2026-10-26T00:00:00.000Z", endExclusive: "2026-10-27T00:00:00.000Z" }] }), searchMode: "order_or_customer_identity" as const, creatorSelection: selection };
}
async function seedOrder(orderId: string, goods: number, taxMode: "inclusive" | "exclusive", createdAt: string, actorId: string, legacy = false) {
  await db.query(`INSERT INTO public."order"(id,currency_code,merchant_id,store_id,status,created_at,metadata)
    VALUES($1,'vnd',$2,$3,'completed',$4::timestamptz,'{"customerAttributionMode":"walk_in"}')`, [orderId, merchantId, storeId, createdAt]);
  const dependencies = { client: db, config: { enabled: true }, transactionContext: {
    ownership: "caller" as const, orderCreatedInCurrentTransaction: true as const }, repositoryOptions: { statementTimeoutMs: 10_000, lockTimeoutMs: 1_000 } };
  const input = { merchantId, storeId, orderId, orderCreatedAt: createdAt, currencyCode: "VND" as const, minorUnitExponent: 0 as const,
    lines: [{ orderLineItemId: `${orderId}:line`, productId: catalog.product, variantId: catalog.variant,
      skuSnapshot: "V5-SYNTHETIC", titleSnapshot: "V5 synthetic line", quantity: 1, unitPriceMinor: goods,
      unitCostMinor: 50, costEvidenceSource: "inventory.product_settings" as const, costEvidenceUpdatedAt: createdAt }] };
  if (legacy) {
    const commercialContext = { taxMode, vatRate: 0.1 };
    const totals = calculateOrderTotals(goods, {}, 0, commercialContext);
    await recordOriginalOrderCommercialRevisionFromOrderCreateV1(dependencies, { ...input, commercialContext,
      totals });
    await db.query('UPDATE public."order" SET metadata=$2 WHERE id=$1', [orderId, JSON.stringify({ ...totals, customerAttributionMode: "walk_in" })]);
  } else {
    const commercialContext = { taxMode, vatRatePpm: 100_000 };
    const totals = calculateOrderTotalsV2(goods, { paymentFeeType: "percent", paymentFeeValue: 10 }, 0, commercialContext);
    await recordOriginalOrderCommercialRevisionFromOrderCreateV2(dependencies, { ...input, commercialContext,
      totals });
    await db.query('UPDATE public."order" SET metadata=$2 WHERE id=$1', [orderId, JSON.stringify({ ...totals, commercialCalculationVersion: 2, customerAttributionMode: "walk_in" })]);
  }
  await recordAuditEntry(db, { operatorId: actorId, role: "staff", organizationId: merchantId }, "order.created", "order", orderId, { merchantId, storeId });
}
beforeAll(async () => {
  vi.stubEnv("ORDER_CURSOR_CURRENT_KEY", keyring.current.keyBase64Url);
  vi.stubEnv("ORDER_CURSOR_CURRENT_KEY_ID", keyring.current.keyId);
  db = await connectPlatformClient();
  await assertSafeTestDatabaseSentinel(db, requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL));
  await db.query("BEGIN");
  try {
    await db.query("INSERT INTO app.merchants(id,display_name,legacy_organization_id) VALUES($1,'V5 synthetic',$1)", [merchantId]);
    await db.query("INSERT INTO public.stock_location(id,name) VALUES($1,'V5 synthetic')", [storeId]);
    await db.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,is_primary) VALUES($1,$2,'V5 synthetic',$1,true)", [storeId, merchantId]);
    await db.query("INSERT INTO app.merchants(id,display_name,legacy_organization_id) VALUES($1,'Foreign synthetic',$1)", [catalog.foreignMerchant]);
    for (const [productId, variantId, owner] of [[catalog.product, catalog.variant, merchantId], [`${catalog.product}:foreign`, `${catalog.variant}:foreign`, catalog.foreignMerchant]]) {
      await db.query("INSERT INTO public.product(id,title,handle,status,merchant_id) VALUES($1,'Current product',$1,'published',$2)", [productId, owner]);
      await db.query("INSERT INTO public.product_variant(id,title,sku,product_id) VALUES($1,'Current variant','V5-SYNTHETIC',$2)", [variantId, productId]);
    }
    await db.query("INSERT INTO public.price_set(id) VALUES($1)", [catalog.priceSet]);
    await db.query("INSERT INTO public.product_variant_price_set(id,variant_id,price_set_id) VALUES($1,$2,$3)", [`${prefix}:vps`, catalog.variant, catalog.priceSet]);
    await db.query("INSERT INTO public.price(id,price_set_id,currency_code,amount,raw_amount) VALUES($1,$2,'vnd',1200,$3)",
      [`${prefix}:price`, catalog.priceSet, JSON.stringify({ value: "1200", precision: 20 })]);
    await db.query("INSERT INTO public.inventory_item(id,sku,title) VALUES($1,'V5-SYNTHETIC','Current item')", [catalog.item]);
    await db.query("INSERT INTO public.product_variant_inventory_item(id,variant_id,inventory_item_id,required_quantity) VALUES($1,$2,$3,1)", [`${prefix}:vii`, catalog.variant, catalog.item]);
    await db.query("INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity) VALUES($1,$2,$3,5,0)", [`${prefix}:level`, catalog.item, storeId]);
    await db.query("INSERT INTO inventory.product_settings(variant_id,product_id,cost_price,reorder_level,preferred_stock,merchant_id) VALUES($1,$2,50,0,10,$3)", [catalog.variant, catalog.product, merchantId]);
    for (const actorId of [staffA, staffB, manager]) {
      const role = actorId === manager ? "manager" : "staff";
      await db.query(`INSERT INTO medusa.staff_users(operator_id,password_hash,display_name,role,organization_id,is_active)
        VALUES($1,'not-a-live-password-hash','V5 synthetic staff',$3,$2,true)`, [actorId, merchantId, role]);
      await db.query("INSERT INTO app.operator_security_state(operator_id) VALUES($1)", [actorId]);
      await db.query(`INSERT INTO app.operator_memberships(operator_id,scope_type,merchant_id,store_id,role_key,status,granted_by,valid_from)
        VALUES($1,'store',$2,$3,$4,'active','UAT',clock_timestamp()-interval '1 day')`, [actorId, merchantId, storeId, role]);
    }
    await seedOrder(ids.free, 500, "inclusive", "2026-10-26T04:00:00.000Z", staffA, true);
    await seedOrder(ids.inclusive, 1_000, "inclusive", "2026-10-26T03:00:00.000Z", staffA);
    await seedOrder(ids.exclusive, 1_000, "exclusive", "2026-10-26T02:00:00.000Z", staffB);
    await seedOrder(ids.cancelled, 700, "inclusive", "2026-10-26T03:30:00.000Z", staffB);
    await appendCancellationCommercialRevisionV1(db, { merchantId, storeId, orderId: ids.cancelled, sourceId: randomUUID(),
      sourceOccurredAt: "2026-10-26T04:30:00.000Z", reason: "Synthetic aggregate cancellation" });
    await db.query(`UPDATE public."order" SET status='canceled' WHERE id=$1`, [ids.cancelled]);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
});
// Append-only synthetic facts remain only in the sentinel-qualified DB until the runner resets it.
afterAll(async () => { vi.unstubAllEnvs(); db?.release(); await shutdownPlatformPool(); });
function read(selection?: CreatorSelectionV1, limit = 1, cursor?: string, statusMode: "all" | "completed" | "other" = "all") {
  return readEffectiveOrderPageV5(new PostgresOrderPageSnapshotRepositoryV1(db, 10_000), {
    scope, filters: filters(selection, statusMode), limit, ...(cursor ? { cursor } : {}), nowEpochSeconds: Math.floor(Date.now() / 1_000),
  }, keyring);
}
describe("real fee-aware full-cohort orders snapshot", () => {
  async function http(query: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    const token = signJwt({ operatorId: staffA, role: "staff", displayName: "V5 synthetic staff", organizationId: merchantId,
      authState: "authenticated", sessionVersion: 1 });
    const response = { statusCode: 200, payload: undefined as unknown, headers: {} as Record<string, string>,
      status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { this.payload = value; },
      setHeader(name: string, value: string) { this.headers[name] = value; } };
    await pageRoute({ headers: { authorization: `Bearer ${token}`, "x-report-merchant-id": merchantId, "x-report-store-ids": storeId, ...headers },
      query: { from: "2026-10-26", to: "2026-10-26", limit: "1", ...query } }, response as never);
    return response;
  }
  it("serves real staff auth with the same alias and lets staff filter other creators in the store", async () => {
    expect(pageAlias).toBe(pageRoute);
    const response = await http({ creatorOperatorId: [staffA, staffB] });
    expect(response.statusCode).toBe(200);
    expect(response.headers["X-Order-List-Contract"]).toBe("orders.effective-page.v5");
    const body = EffectiveOrderPageV5Schema.parse(response.payload);
    expect(body.pagination.totalCount).toBe(4);
    expect(body.currencies[0]!.paymentFeeCustomerTotalMinor).toBe(210);
    const other = await http({ creatorOperatorId: staffB });
    expect(other.statusCode).toBe(200);
    expect(EffectiveOrderPageV5Schema.parse(other.payload).currencies).toMatchObject([{ orderCount: 2, paymentFeeCustomerTotalMinor: 110 }]);
  });
  it("rejects foreign report scope and freshly revoked staff membership", async () => {
    expect((await http({}, { "x-report-store-ids": "store_default" })).statusCode).toBe(403);
    await db.query("UPDATE app.operator_memberships SET status='revoked' WHERE operator_id=$1", [staffA]);
    try { expect((await http()).statusCode).toBe(403); }
    finally { await db.query("UPDATE app.operator_memberships SET status='active' WHERE operator_id=$1", [staffA]); }
  });
  it("rejects an unknown status instead of silently widening the filter", async () => {
    expect((await http({ status: "not-a-status" })).statusCode).toBe(400);
  });
  it("keeps fees beyond the current page, excluding cancelled commercial values", async () => {
    const page = await read();
    expect(page.data.map((row) => row.order.orderId)).toEqual([ids.free]);
    expect(page.data[0]!.order).toMatchObject({ componentVersion: 1, components: { paymentFeeMinor: 0 } });
    expect(page.pagination).toMatchObject({ hasMore: true, totalCount: 4 });
    expect(page.currencies).toMatchObject([{ orderCount: 4, activeOrderCount: 3, cancelledOrderCount: 1,
      currentOrderGrossValueMinor: 2_810, effectiveItemQuantity: 3, paymentFeeMinor: 200, paymentFeeVatMinor: 19, paymentFeeCustomerTotalMinor: 210 }]);
  });
  it.each([
    [[staffA], 2, 1_600, 2, 100, 9, 100], [[staffB], 2, 1_210, 1, 100, 10, 110],
    [[staffA, staffB], 4, 2_810, 3, 200, 19, 210],
  ] as const)("applies creator OR selection %j to rows and full-cohort amounts", async (actors, count, gross, qty, fee, vat, customerFee) => {
    const page = await read({ mode: "selected", creatorOperatorIds: [...actors].sort() }, 20);
    expect(page.data).toHaveLength(count);
    expect(page.pagination.totalCount).toBe(count);
    expect(page.currencies).toMatchObject([{ currentOrderGrossValueMinor: gross, effectiveItemQuantity: qty,
      paymentFeeMinor: fee, paymentFeeVatMinor: vat, paymentFeeCustomerTotalMinor: customerFee }]);
  });
  it("continues all pages at the original snapshot without duplicating identities or losing fees", async () => {
    const first = await read(), found = first.data.map((row) => row.order.orderId);
    let page = first;
    while (page.pagination.nextCursor) {
      page = await read(undefined, 1, page.pagination.nextCursor);
      expect(page.pagination.asOf).toBe(first.pagination.asOf);
      expect(page.currencies).toEqual(first.currencies);
      found.push(...page.data.map((row) => row.order.orderId));
      expect(found.length).toBeLessThanOrEqual(4);
    }
    expect(found).toEqual([ids.free, ids.cancelled, ids.inclusive, ids.exclusive]);
  });
  it("uses stored revision time for historical fee aggregates", async () => {
    const repository = new PostgresOrderPageSnapshotRepositoryV1(db, 10_000);
    const aggregates = await repository.withRepeatableReadSnapshot((snapshot) => snapshot.readFeeAwareCurrencyAggregates({
      scope, filters: filters(), asOf: "2026-10-26T04:15:00.000Z" }));
    expect(aggregates).toMatchObject([{ activeOrderCount: 4, cancelledOrderCount: 0, currentOrderGrossValueMinor: 3_580,
      effectiveItemQuantity: 4, paymentFeeMinor: 270, paymentFeeVatMinor: 25, paymentFeeCustomerTotalMinor: 280 }]);
  });
  it("retains legacy full-cohort refusal and denies foreign scope", async () => {
    await expect(readEffectiveOrderPageV4(new PostgresOrderPageSnapshotRepositoryV1(db, 10_000), {
      scope, filters: filters(), limit: 1, nowEpochSeconds: Math.floor(Date.now() / 1_000) }, keyring))
      .rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 });
    await expect(readEffectiveOrderPageV5(new PostgresOrderPageSnapshotRepositoryV1(db, 10_000), {
      scope: { ...scope, merchantId: "foreign" }, filters: filters(), limit: 1, nowEpochSeconds: Math.floor(Date.now() / 1_000) }, keyring)).rejects.toThrow();
    const cancelled = await read(undefined, 20, undefined, "other");
    expect(cancelled.data[0]!.order.components.paymentFeeMinor).toBe(70);
    expect(cancelled.currencies).toMatchObject([{ currentOrderGrossValueMinor: 0, effectiveItemQuantity: 0, paymentFeeCustomerTotalMinor: 0 }]);
  });
});


describe("real CSV V5 surcharge readback", () => {
  it("exports a mixed cohort across one-order batches with persisted descriptors and no fee duplication", async () => {
    const repository = new PostgresOrderPageSnapshotRepositoryV1(db, 10_000);
    const artifact = await exportEffectiveOrderSnapshotCsvV5(repository, { scope, filters: filters(), grain: "order", batchSize: 1 });
    expect(artifact).toMatchObject({ orderCount: 4, rowCount: 4, snapshot: { contractVersion: "orders.effective-order.v5", merchantId } });
    const rows = parseCsvRows(artifact.csv, ORDER_CSV_ORDER_V5_HEADERS);
    expect(rows.map(row => row.order_id)).toEqual([ids.free, ids.cancelled, ids.inclusive, ids.exclusive]);
    expect(rows.find(row => row.order_id === ids.free)).toMatchObject({ component_version: "1", payment_fee_type: "", payment_fee_minor: "0" });
    expect(rows.find(row => row.order_id === ids.inclusive)).toMatchObject({ payment_fee_type: "percent", payment_fee_value: "10",
      payment_fee_basis_minor: "1000", payment_fee_vat_rate_ppm: "100000", payment_fee_minor: "100", payment_fee_vat_minor: "9",
      payment_fee_customer_total_minor: "100", payment_fee_commercial_revenue_ex_vat_minor: "91", effective_commercial_total_minor: "1100" });
    expect(rows.find(row => row.order_id === ids.exclusive)).toMatchObject({ payment_fee_customer_total_minor: "110", payment_fee_commercial_revenue_ex_vat_minor: "100", effective_commercial_total_minor: "1210" });
    expect(rows.find(row => row.order_id === ids.cancelled)).toMatchObject({ commercial_state: "cancelled", payment_fee_minor: "70", current_order_gross_value_minor: "0" });
    const lines = await exportEffectiveOrderSnapshotCsvV5(repository, { scope, filters: filters({ mode: "selected", creatorOperatorIds: [staffA] }), grain: "effective_line", batchSize: 1 });
    expect(lines).toMatchObject({ orderCount: 2, rowCount: 2 });
    expect(parseCsvRows(lines.csv, ORDER_CSV_LINE_V5_HEADERS).map(row => row.order_id)).toEqual([ids.free, ids.inclusive]);
    expect(ORDER_CSV_LINE_V5_HEADERS).not.toContain("payment_fee_minor");
    await expect(exportEffectiveOrderSnapshotCsvV4(repository, { scope, filters: filters(), grain: "order", batchSize: 1 })).rejects.toMatchObject({ code: "unsupported_contract" });
  });
  async function http(operatorId: string, role: "staff" | "manager", query: Record<string, unknown> = {}, headers: Record<string, string> = {}, handler = csvRoute, params: Record<string, string> = {}, requestBody?: unknown) {
    const token = signJwt({ operatorId, role, displayName: "Synthetic CSV operator", organizationId: merchantId, authState: "authenticated", sessionVersion: 1 });
    const response = { statusCode: 200, payload: undefined as unknown, headers: {} as Record<string, string>,
      status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { this.payload = value; }, send(value: unknown) { this.payload = value; },
      setHeader(name: string, value: string) { this.headers[name] = value; } };
    await handler({ headers: { authorization: `Bearer ${token}`, "x-report-merchant-id": merchantId, "x-report-store-ids": storeId, ...headers },
      params, body: requestBody, query: { ...(handler === intentListGet ? {} : { from: "2026-10-26", to: "2026-10-26" }), ...query } }, response as never);
    return response;
  }
  const fingerprint = async () => (await db.query(`SELECT
      (SELECT count(*) FROM public."order" WHERE merchant_id=$1) AS orders,
      (SELECT count(*) FROM app.order_commercial_revisions WHERE merchant_id=$1) AS revisions,
      (SELECT count(*) FROM app.payment_events WHERE merchant_id=$1) AS events,
      (SELECT count(*) FROM app.payment_intents WHERE merchant_id=$1) AS intents,
      (SELECT stocked_quantity FROM public.inventory_level WHERE inventory_item_id=$2) AS stock`, [merchantId, catalog.item])).rows[0];
  it("refuses a missing live price instead of quoting a false free product", async () => {
    await db.query("BEGIN");
    try {
      await db.query("UPDATE public.price SET deleted_at=clock_timestamp() WHERE price_set_id=$1", [catalog.priceSet]);
      await expect(quoteSaleForClient(db, { items: [{ variantId: catalog.variant, quantity: 1 }], amountReceived: 0,
        paymentMethod: "cash", paymentFeeType: "percent", paymentFeeValue: 10 }, storeId, merchantId, storeId))
        .rejects.toMatchObject({ code: "variant_price_unavailable", statusCode: 409 });
    } finally { await db.query("ROLLBACK"); }
  });
  const previewHeaders = () => ({ "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId,
    [PAYMENT_FEE_WRITE_HTTP_HEADER_V1]: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 });
  const previewInput = () => ({ items: [{ variantId: catalog.variant, quantity: 1 }], paymentFeeType: "percent", paymentFeeValue: 10 });
  async function confirmationFor(input: Record<string, unknown>) {
    const commercial = Object.fromEntries(Object.entries(input).filter(([key, value]) => value !== undefined
      && ["items", "discountType", "discountValue", "discountPercent", "shippingFee", "paymentFeeType", "paymentFeeValue"].includes(key)));
    const preview = await http(manager, "manager", {}, previewHeaders(), cartPreviewPost, {}, commercial);
    expect(preview.statusCode).toBe(200);
    return CartPaymentFeePreviewV1Schema.parse(preview.payload).data.confirmationToken;
  }
  const previewFacts = async () => (await db.query(`SELECT
    (SELECT count(*) FROM public."order" WHERE merchant_id=$1) AS orders,
    (SELECT count(*) FROM app.order_commercial_revisions WHERE merchant_id=$1) AS revisions,
    (SELECT count(*) FROM app.payment_entries WHERE merchant_id=$1) AS entries,
    (SELECT count(*) FROM app.payment_events WHERE merchant_id=$1) AS events,
    (SELECT count(*) FROM app.payment_intents WHERE merchant_id=$1) AS intents,
    (SELECT count(*) FROM app.commercial_obligations WHERE merchant_id=$1) AS obligations,
    (SELECT count(*) FROM app.payment_event_allocations WHERE merchant_id=$1) AS allocations,
    (SELECT count(*) FROM accounting.journal_entries WHERE merchant_id=$1) AS journals,
    (SELECT count(*) FROM audit.events WHERE organization_id=$1) AS audits,
    (SELECT count(*) FROM medusa.stock_movements WHERE inventory_item_id=$2) AS movements,
    (SELECT count(*) FROM app.idempotency_records WHERE tenant_id=$1) AS receipts,
    (SELECT count(*) FROM outbox.events WHERE merchant_id=$1) AS outbox,
    (SELECT count(*) FROM public.inventory_level WHERE inventory_item_id=$2) AS levels,
    (SELECT stocked_quantity::text FROM public.inventory_level WHERE inventory_item_id=$2) AS stock`, [merchantId, catalog.item])).rows[0];
  it.each([
    ["revision", "app.order_commercial_revisions"], ["charge", "app.payment_entries"], ["event", "app.payment_events"],
  ] as const)("rolls back the entire fee-bearing sale after an injected %s insert failure", async (stage, table) => {
    const businessRows = async () => {
      const result: Record<string, string> = {};
      for (const name of [
        'public."order"', "public.order_summary", "public.order_item", "public.order_line_item", "public.inventory_level",
        "app.order_commercial_revisions", "app.order_commercial_revision_components", "app.order_commercial_revision_lines",
        "app.commercial_obligations", "app.payment_entries", "app.payment_events", "app.payment_event_allocations",
        "app.payment_event_component_allocations", "app.payment_event_evidence", "app.order_collection_revisions",
        "app.order_collection_revision_events", "app.customer_refund_payables", "accounting.journal_entries", "accounting.journal_lines",
        "audit.events", "medusa.stock_movements", "outbox.events", "app.idempotency_records",
      ]) {
        result[name] = (await db.query(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text) AS digest FROM ${name} t`)).rows[0]!.digest;
      }
      return result;
    };
    const trigger = `v230_fee_fault_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const fault = `v230_injected_after_${stage}`;
    const actor = { operatorId: manager, role: "manager" as const, displayName: "Synthetic fee operator", organizationId: merchantId };
    const operating = { scopeKind: "operating" as const, merchantId, storeId, stockLocationId: storeId };
    const sale = { ...previewInput(), customerMode: "walk_in" as const, paymentMethod: "cash", amountReceived: 2000 };
    const before = await businessRows();
    try {
      await db.query(`CREATE FUNCTION app.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.merchant_id=TG_ARGV[0] THEN RAISE EXCEPTION '%', TG_ARGV[1]; END IF; RETURN NEW; END $$`);
      await db.query(`CREATE TRIGGER ${trigger} AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION app.${trigger}('${merchantId}','${fault}')`);
      await expect(completeSale({ "idempotency-key": `${prefix}:fault:${stage}` }, sale, actor, operating)).rejects.toThrow(fault);
      expect(await businessRows()).toEqual(before);
      expect(await confirmationFor(sale)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
      await db.query(`DROP FUNCTION IF EXISTS app.${trigger}()`);
    }
  });
  it("rejects changed checkout/intent prices, VAT and fees before durable facts while preview ignores stock-only refresh", async () => {
    const sale = { ...previewInput(), customerMode: "walk_in", paymentMethod: "cash", amountReceived: 2000, cartConfirmationToken: "" };
    const oldPackage = process.env.APP_PACKAGE_KEY, oldVAT = process.env.VAT_RATE;
    const headers = { ...previewHeaders(), "idempotency-key": `${prefix}:stale-cart-price` };
    admissionFixture.ready = true; process.env.APP_PACKAGE_KEY = "plus";
    try {
      sale.cartConfirmationToken = await confirmationFor(sale);
      const before = await previewFacts();
      const { cartConfirmationToken: _token, ...unconfirmed } = sale;
      for (const handler of [checkoutPost, intentPost]) {
        const denied = await http(manager, "manager", {}, headers, handler, {}, handler === checkoutPost ? unconfirmed : { provider: "mock", order: unconfirmed });
        expect(denied.statusCode).toBe(400); expect(await previewFacts()).toEqual(before);
      }
      await db.query("UPDATE public.inventory_level SET stocked_quantity=4 WHERE inventory_item_id=$1", [catalog.item]);
      expect(await confirmationFor(sale)).toBe(sale.cartConfirmationToken);
      await db.query("UPDATE public.inventory_level SET stocked_quantity=5 WHERE inventory_item_id=$1", [catalog.item]);
      const rejectBoth = async (input: typeof sale) => {
        for (const handler of [checkoutPost, intentPost]) {
          const result = await http(manager, "manager", {}, headers, handler, {}, handler === checkoutPost ? input : { provider: "mock", order: input });
          expect(result.statusCode).toBe(409); expect(result.payload).toMatchObject({ error: { code: "cart_quote_changed" } });
          expect(await previewFacts()).toEqual(before);
        }
      };
      await db.query("UPDATE public.price SET amount=1400,raw_amount=$2 WHERE id=$1", [`${prefix}:price`, JSON.stringify({ value: "1400", precision: 20 })]);
      await rejectBoth(sale);
      await db.query("UPDATE public.price SET amount=1200,raw_amount=$2 WHERE id=$1", [`${prefix}:price`, JSON.stringify({ value: "1200", precision: 20 })]);
      process.env.VAT_RATE = "0.2"; await rejectBoth(sale);
      if (oldVAT === undefined) delete process.env.VAT_RATE; else process.env.VAT_RATE = oldVAT;
      await rejectBoth({ ...sale, paymentFeeValue: 20 });
    } finally {
      admissionFixture.ready = false;
      if (oldPackage === undefined) delete process.env.APP_PACKAGE_KEY; else process.env.APP_PACKAGE_KEY = oldPackage;
      if (oldVAT === undefined) delete process.env.VAT_RATE; else process.env.VAT_RATE = oldVAT;
      await db.query("UPDATE public.price SET amount=1200,raw_amount=$2 WHERE id=$1", [`${prefix}:price`, JSON.stringify({ value: "1200", precision: 20 })]);
      await db.query("UPDATE public.inventory_level SET stocked_quantity=5 WHERE inventory_item_id=$1", [catalog.item]);
    }
  });
  it("reads stored correction fee context without new-write admission or durable business mutations", async () => {
    const before = await previewFacts();
    for (const orderId of Object.values(ids)) {
      const response = await http(manager, "manager", {}, previewHeaders(), correctionContextGet, { id: orderId });
      expect(response.statusCode).toBe(200);
      const context = OrderCorrectionFinancialContextV1Schema.parse(response.payload).data;
      expect(context).toMatchObject({ orderId, merchantId, storeId, baseRevision: orderId === ids.cancelled ? 1 : 0,
        commercialState: orderId === ids.cancelled ? "cancelled" : "active", currencyCode: "VND" });
      if (orderId === ids.free) expect(context).toMatchObject({ componentVersion: 1, paymentFee: null });
      else expect(context).toMatchObject({ componentVersion: 2, paymentFee: { paymentFeeType: "percent", paymentFeeValue: 10 } });
      if (orderId === ids.cancelled) expect(context.components).toMatchObject({ paymentFeeMinor: 70, paymentFeeVatMinor: 6 });
      expect(JSON.stringify(context)).not.toMatch(/costEvidence|password|createdBy|unitCost/);
      expect(response.headers).toMatchObject({ "Cache-Control": "private, no-store", [PAYMENT_FEE_WRITE_HTTP_HEADER_V1]: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 });
    }
    const alias = await http(manager, "manager", {}, previewHeaders(), correctionContextAlias, { id: ids.inclusive });
    expect(alias.statusCode).toBe(200); expect(alias.payload).toEqual((await http(manager, "manager", {}, previewHeaders(), correctionContextGet, { id: ids.inclusive })).payload);
    expect((await http(staffA, "staff", {}, previewHeaders(), correctionContextGet, { id: ids.inclusive })).statusCode).toBe(403);
    expect((await http(manager, "manager", {}, previewHeaders(), correctionContextGet, { id: "foreign-or-missing" })).statusCode).toBe(404);
    expect((await http(manager, "manager", {}, { ...previewHeaders(), "x-operating-store-id": "foreign" }, correctionContextGet, { id: ids.inclusive })).statusCode).toBe(403);
    const { [PAYMENT_FEE_WRITE_HTTP_HEADER_V1]: _contract, ...legacyHeaders } = previewHeaders();
    expect((await http(manager, "manager", {}, legacyHeaders, correctionContextGet, { id: ids.inclusive })).statusCode).toBe(409);
    expect(await previewFacts()).toEqual(before);
  });
  it("previews with authoritative prices/VAT while new writes are unavailable and changes no durable business facts", async () => {
    const before = await previewFacts();
    const result = await http(staffA, "staff", {}, previewHeaders(), cartPreviewPost, {}, previewInput());
    expect(result.statusCode).toBe(200);
    expect(result.payload).toMatchObject({ schemaVersion: 1, contractVersion: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
      data: { merchantId, storeId, input: previewInput(), items: [{ variantId: catalog.variant, unitPrice: 1200, quantity: 1, stock: 5 }],
        financial: { paymentFee: { paymentFeeBasisMinor: 1200 }, components: { paymentFeeMinor: 120, paymentFeeVatMinor: 11, totalMinor: 1320 } } } });
    expect(result.headers).toMatchObject({ "Cache-Control": "private, no-store", [PAYMENT_FEE_WRITE_HTTP_HEADER_V1]: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 });
    expect(await previewFacts()).toEqual(before);
    expect((await http(staffA, "staff", {}, {}, cartPreviewPost, {}, previewInput())).statusCode).toBe(409);
    expect((await http(staffA, "staff", {}, { ...previewHeaders(), "x-operating-store-id": "store_default" }, cartPreviewPost, {}, previewInput())).statusCode).toBe(403);
    expect((await http(staffA, "staff", {}, previewHeaders(), cartPreviewPost, {}, { ...previewInput(), total: 1 })).statusCode).toBe(400);
    expect((await http(staffA, "staff", {}, previewHeaders(), cartPreviewPost, {}, { ...previewInput(), items: [{ variantId: `${catalog.variant}:foreign`, quantity: 1 }] })).statusCode).toBe(404);
    expect(await previewFacts()).toEqual(before);
  });
  it.each(["merchant", "store"] as const)("blocks preview under a suspended %s and preserves all business facts", async kind => {
    const before = await previewFacts();
    const table = kind === "merchant" ? "app.merchants" : "app.stores", target = kind === "merchant" ? merchantId : storeId;
    await db.query(`UPDATE ${table} SET status='suspended' WHERE id=$1`, [target]);
    try {
      const result = await http(manager, "manager", {}, previewHeaders(), cartPreviewPost, {}, previewInput());
      expect(result.statusCode).toBe(403); expect(await previewFacts()).toEqual(before);
    } finally { await db.query(`UPDATE ${table} SET status='active' WHERE id=$1`, [target]); }
  });
  it("rolls back a shared reader's missing-inventory materialization", async () => {
    const row = (await db.query("SELECT to_jsonb(level) AS value FROM public.inventory_level level WHERE inventory_item_id=$1 AND location_id=$2", [catalog.item, storeId])).rows[0].value;
    await db.query("DELETE FROM public.inventory_level WHERE inventory_item_id=$1 AND location_id=$2", [catalog.item, storeId]);
    try {
      const before = await previewFacts();
      const result = await http(staffA, "staff", {}, previewHeaders(), cartPreviewPost, {}, previewInput());
      expect(result.statusCode).toBe(200);
      expect(result.payload).toMatchObject({ data: { items: [{ stock: 0 }], financial: { components: { totalMinor: 1320 } } } });
      expect(await previewFacts()).toEqual(before);
      const rejected = await http(staffA, "staff", {}, previewHeaders(), cartPreviewPost, {}, {
        ...previewInput(), paymentFeeType: "amount", paymentFeeValue: Number.MAX_SAFE_INTEGER,
      });
      expect(rejected.statusCode).toBe(400);
      expect(await previewFacts()).toEqual(before);
    } finally {
      await db.query("INSERT INTO public.inventory_level SELECT (jsonb_populate_record(NULL::public.inventory_level,$1::jsonb)).*", [JSON.stringify(row)]);
    }
  });
  it.each([
    [240000, "inclusive", "0.1", { discountPercent: 10, shippingFee: 20000, paymentFeeType: "percent", paymentFeeValue: 2 }, 240320, 4320, 21847],
    [240000, "exclusive", "0.1", { discountType: "amount", discountValue: 24000, shippingFee: 20000, paymentFeeType: "percent", paymentFeeValue: 2 }, 264352, 4320, 24032],
    [5, "exclusive", "0.1", { shippingFee: 5, paymentFeeType: "amount", paymentFeeValue: 5 }, 18, 5, 3],
    [240000, "inclusive", "0", { discountPercent: 10, shippingFee: 20000, paymentFeeType: "percent", paymentFeeValue: 2 }, 240320, 4320, 0],
    [240000, "exclusive", "0", { discountPercent: 10, shippingFee: 20000, paymentFeeType: "percent", paymentFeeValue: 2 }, 240320, 4320, 0],
    [240000, "inclusive", "0", { discountPercent: 10, shippingFee: 20000, paymentFeeType: "amount", paymentFeeValue: 0 }, 236000, 0, 0],
    [240000, "exclusive", "0", { discountPercent: 10, shippingFee: 20000, paymentFeeType: "amount", paymentFeeValue: 0 }, 236000, 0, 0],
    [100001, "inclusive", "0.1", { discountPercent: 10, shippingFee: 7000, paymentFeeType: "percent", paymentFeeValue: 2.5 }, 99251, 2250, 9023],
    [240000, "inclusive", "0.1", { discountPercent: 100, shippingFee: 20000, paymentFeeType: "percent", paymentFeeValue: 2 }, 20000, 0, 1818],
    [240000, "inclusive", "0.1", { discountPercent: 100, shippingFee: 20000, paymentFeeType: "amount", paymentFeeValue: 10000 }, 30000, 10000, 2727],
    [0, "inclusive", "0.1", { paymentFeeType: "amount", paymentFeeValue: 10 }, 10, 10, 1],
  ] as const)("matches independent server preview oracle price=%i mode=%s VAT=%s", async (price, taxMode, vatRate, adjustment, total, fee, vat) => {
    const originalVat = process.env.VAT_RATE, originalMode = process.env.TAX_MODE;
    try {
      process.env.VAT_RATE = vatRate; process.env.TAX_MODE = taxMode;
      await db.query("UPDATE public.price SET amount=$2,raw_amount=$3 WHERE price_set_id=$1", [catalog.priceSet, price, JSON.stringify({ value: String(price), precision: 20 })]);
      const before = await previewFacts();
      const result = await http(staffA, "staff", {}, previewHeaders(), cartPreviewPost, {}, { ...previewInput(), ...adjustment });
      expect(result.statusCode).toBe(200);
      expect(result.payload).toMatchObject({ data: { financial: { components: { totalMinor: total, paymentFeeMinor: fee, vatMinor: vat },
        paymentFee: { vatRatePpm: vatRate === "0" ? 0 : 100000 } } } });
      expect(await previewFacts()).toEqual(before);
    } finally {
      if (originalVat === undefined) delete process.env.VAT_RATE; else process.env.VAT_RATE = originalVat;
      if (originalMode === undefined) delete process.env.TAX_MODE; else process.env.TAX_MODE = originalMode;
      await db.query("UPDATE public.price SET amount=1200,raw_amount=$2 WHERE price_set_id=$1", [catalog.priceSet, JSON.stringify({ value: "1200", precision: 20 })]);
    }
  });
  it.each((["checkout", "intent", "correction_preview", "correction_apply"] as const).flatMap(family => [false, true].map(negotiated => ({ family, negotiated }))))(
    "denies HTTP $family fee input with negotiated=$negotiated before commercial mutation", async ({ family, negotiated }) => {
    const before = await fingerprint();
    const sale = { items: [{ variantId: catalog.variant, quantity: 1 }], customerMode: "walk_in", paymentMethod: "cash", amountReceived: 2000,
      paymentFeeType: "percent", paymentFeeValue: 10, shippingFee: 0, cartConfirmationToken: "a".repeat(64) };
    const requestBody = family === "intent" ? { provider: "mock", order: sale } : family === "checkout" ? sale
      : { baseRevision: 0, reason: "Synthetic incompatible fee request", items: sale.items, paymentFeeType: "percent", paymentFeeValue: 10, settlement: { method: "cash", amountReceived: 2000 } };
    const handler = family === "checkout" ? checkoutPost : family === "intent" ? intentPost : family === "correction_preview" ? correctionPreviewPost : correctionApplyPost;
    const response = await http(manager, "manager", {}, { "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId,
      "idempotency-key": `${prefix}:${family}:${negotiated}`, ...(negotiated ? { [PAYMENT_FEE_WRITE_HTTP_HEADER_V1]: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 } : {}) }, handler, { id: ids.free }, requestBody);
    expect(response.statusCode).toBe(negotiated ? 503 : 409);
    expect(response.payload).toMatchObject({ error: { code: negotiated ? "feature_unavailable" : "unsupported_contract" } });
    expect(response.headers[PAYMENT_FEE_WRITE_HTTP_HEADER_V1]).toBeUndefined();
    expect(await fingerprint()).toEqual(before);
  });
  it.each([correctionPreviewPost, correctionApplyPost])("denies legacy correction of a fee-bearing source without a descriptor in the body", async handler => {
    const before = (await db.query("SELECT count(*)::int AS count FROM app.order_commercial_revisions WHERE merchant_id=$1", [merchantId])).rows[0];
    const response = await http(manager, "manager", {}, { "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId,
      "idempotency-key": `${prefix}:legacy-inherited:${handler === correctionPreviewPost ? 'preview' : 'apply'}` }, handler, { id: ids.inclusive },
      { baseRevision: 0, reason: "Synthetic inherited fee correction", items: [{ variantId: catalog.variant, quantity: 1 }] });
    expect(response.statusCode).toBe(409);
    expect(response.payload).toMatchObject({ error: { code: "unsupported_contract" } });
    expect((await db.query("SELECT count(*)::int AS count FROM app.order_commercial_revisions WHERE merchant_id=$1", [merchantId])).rows[0]).toEqual(before);
  });
  it("recreates fee-bearing, fee-free and cancelled sources with current scoped catalog pricing only", async () => {
    const headers = { "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId };
    for (const orderId of Object.values(ids)) {
      const response = await http(staffA, "staff", {}, headers, recreateV3, { id: orderId });
      expect(response.statusCode).toBe(200);
      expect(response.headers).toMatchObject({ "Cache-Control": "private, no-store", "X-Order-Recreate-Contract": "orders.effective-recreate.v3" });
      const result = EffectiveOrderRecreatePrefillV3Schema.parse((response.payload as { prefill: unknown }).prefill);
      expect(result).toMatchObject({ schemaVersion: 3, customerAttribution: "walk_in", customer: null,
        commercialPrefill: { cartReadiness: "ready", sourceOrder: { orderId }, availableCount: 1,
          items: [{ mapping: { productId: catalog.product, variantId: catalog.variant, cartUnitPriceMinor: 1200, stockAvailableQuantity: 5, priceChanged: true } }] } });
      expect(JSON.stringify(result)).not.toMatch(/paymentFee|discountMinor|shippingMinor|vatMinor|totalMinor/);
    }
    expect((await http(staffA, "staff", {}, headers, recreateV2, { id: ids.inclusive })).statusCode).toBe(409);
    expect((await http(staffA, "staff", {}, headers, recreateV2, { id: ids.free })).statusCode).toBe(200);
    expect((await http(staffA, "staff", {}, { ...headers, "x-operating-store-id": "store_default" }, recreateV3, { id: ids.inclusive })).statusCode).toBe(403);
  });
  it.each(["unpublished", "archived", "no_stock", "no_price"])("blocks %s catalog items without mapping a foreign merchant's identical SKU", async fault => {
    const headers = { "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId };
    try {
      if (fault === "unpublished") await db.query("UPDATE public.product SET status='draft' WHERE id=$1", [catalog.product]);
      if (fault === "archived") await db.query("UPDATE public.product_variant SET deleted_at=clock_timestamp() WHERE id=$1", [catalog.variant]);
      if (fault === "no_stock") await db.query("UPDATE public.inventory_level SET stocked_quantity=0 WHERE inventory_item_id=$1", [catalog.item]);
      if (fault === "no_price") await db.query("UPDATE public.price SET deleted_at=clock_timestamp() WHERE price_set_id=$1", [catalog.priceSet]);
      const response = await http(staffA, "staff", {}, headers, recreateV3, { id: ids.inclusive });
      expect(response.statusCode).toBe(200);
      expect(response.payload).toMatchObject({ prefill: { commercialPrefill: { cartReadiness: "blocked_unavailable_items", unavailableCount: 1,
        items: [{ mapping: { status: "unavailable", reasons: [fault === "unpublished" ? "variant_unpublished" : fault === "no_stock" ? "insufficient_stock" : "variant_not_found"] } }] } } });
      expect(JSON.stringify(response.payload)).not.toContain(`${catalog.variant}:foreign`);
    } finally {
      await db.query("UPDATE public.product SET status='published' WHERE id=$1", [catalog.product]);
      await db.query("UPDATE public.product_variant SET deleted_at=NULL WHERE id=$1", [catalog.variant]);
      await db.query("UPDATE public.inventory_level SET stocked_quantity=5 WHERE inventory_item_id=$1", [catalog.item]);
      await db.query("UPDATE public.price SET deleted_at=NULL WHERE price_set_id=$1", [catalog.priceSet]);
    }
  });
  it("keeps an explicitly zero-priced catalog item distinct from a missing price", async () => {
    try {
      await db.query("UPDATE public.price SET amount=0,raw_amount=$2 WHERE price_set_id=$1", [catalog.priceSet, JSON.stringify({ value: "0", precision: 20 })]);
      const response = await http(staffA, "staff", {}, { "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId }, recreateV3, { id: ids.inclusive });
      expect(response.statusCode).toBe(200);
      expect(response.payload).toMatchObject({ prefill: { commercialPrefill: { cartReadiness: "ready", items: [{ mapping: { status: "available", cartUnitPriceMinor: 0 } }] } } });
    } finally {
      await db.query("UPDATE public.price SET amount=1200,raw_amount=$2 WHERE price_set_id=$1", [catalog.priceSet, JSON.stringify({ value: "1200", precision: 20 })]);
    }
  });
  it("serves the authenticated scoped V5 download, creator selection and identical platform alias", async () => {
    expect(csvAlias).toBe(csvRoute);
    const response = await http(manager, "manager", { creatorOperatorId: [staffB], grain: "order", batchSize: "1" });
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({ "X-Order-Export-Contract": "orders.effective-order.v5", "Cache-Control": "private, no-store", "X-Order-Export-Order-Count": "2" });
    expect(JSON.parse(response.headers["X-Order-Export-Scope"]!)).toEqual({ scopeKind: "report", ...scope });
    expect(JSON.parse(response.headers["X-Order-Export-Creator-Selection"]!)).toEqual({ mode: "selected", creatorOperatorIds: [staffB] });
    expect(parseCsvRows(String(response.payload), ORDER_CSV_ORDER_V5_HEADERS).map(row => row.order_id)).toEqual([ids.cancelled, ids.exclusive]);
    expect(Number(response.headers["X-Order-Export-Content-Length"])).toBe(Buffer.byteLength(String(response.payload)));
  });
  it.each([
    { merchantStatus: "active", storeStatus: "suspended" },
    { merchantStatus: "suspended", storeStatus: "active" },
  ])("retains real management report history without granting staff inactive access: %j", async ({ merchantStatus, storeStatus }) => {
    await db.query("UPDATE app.merchants SET status=$2 WHERE id=$1", [merchantId, merchantStatus]);
    await db.query("UPDATE app.stores SET status=$2 WHERE id=$1", [storeId, storeStatus]);
    try {
      if (storeStatus === "suspended") {
        await expect(resolveDashboardStoreWindows(db, { scopeKind: "report", ...scope }, { from: "2026-10-26", to: "2026-10-26", inclusiveDays: 1 }))
          .rejects.toMatchObject({ code: "dashboard_store_time_unavailable" });
        await expect(new PostgresOrderPageSnapshotRepositoryV1(db, 10_000).withRepeatableReadSnapshot(tx => tx.readStoreRevisionVector(scope))).rejects.toThrow();
        expect(await new PostgresOrderPageSnapshotRepositoryV1(db, 10_000, "active_or_suspended").withRepeatableReadSnapshot(tx => tx.readStoreRevisionVector(scope))).toHaveLength(1);
      }
      const page = await http(manager, "manager", {}, {}, pageRoute);
      expect(page.statusCode).toBe(200);
      expect(EffectiveOrderPageV5Schema.parse(page.payload).pagination.totalCount).toBe(4);
      const csv = await http(manager, "manager");
      expect(csv.statusCode).toBe(200);
      expect(parseCsvRows(String(csv.payload), ORDER_CSV_ORDER_V5_HEADERS)).toHaveLength(4);
      // No fee-bearing orders in this creator cohort: V2 history can be tested independently of its money compatibility gate.
      const dashboard = await http(manager, "manager", { creatorOperatorId: [manager] }, {}, dashboardRoute);
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.payload).toMatchObject({ schemaVersion: 2, audience: "full", creatorSelection: { mode: "selected", creatorOperatorIds: [manager] } });
      const feeDashboard = await http(manager, "manager", { creatorOperatorId: [staffA, staffB] }, {}, dashboardV3);
      expect(feeDashboard.statusCode).toBe(200);
      expect(CreatorSalesDashboardV3Schema.parse(feeDashboard.payload).currencies).toMatchObject([{ orderCount: 4, currentPaymentFeeMinor: 200,
        currentPaymentFeeCustomerTotalMinor: 210 }]);
      expect((await http(staffA, "staff", {}, {}, pageRoute)).statusCode).toBe(403);
      expect((await http(staffA, "staff", {}, {}, dashboardRoute)).statusCode).toBe(403);
      expect((await http(staffA, "staff", {}, {}, dashboardV3)).statusCode).toBe(403);
      expect((await http(manager, "manager", {}, { "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId }, recreateV3, { id: ids.inclusive })).statusCode).toBe(403);
      expect((await http(staffA, "staff", {}, { "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId }, recreateV3, { id: ids.inclusive })).statusCode).toBe(403);
      expect((await http(manager, "manager", {}, { "x-report-store-ids": "store_default" }, pageRoute)).statusCode).toBe(403);
      await db.query("UPDATE app.operator_memberships SET status='revoked' WHERE operator_id=$1", [manager]);
      try {
        expect((await http(manager, "manager", {}, {}, pageRoute)).statusCode).toBe(403);
        expect((await http(manager, "manager", {}, {}, dashboardV3)).statusCode).toBe(403);
        expect((await http(manager, "manager", {}, { "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId }, recreateV3, { id: ids.inclusive })).statusCode).toBe(403);
      }
      finally { await db.query("UPDATE app.operator_memberships SET status='active' WHERE operator_id=$1", [manager]); }
    } finally {
      await db.query("UPDATE app.merchants SET status='active' WHERE id=$1", [merchantId]);
      await db.query("UPDATE app.stores SET status='active' WHERE id=$1", [storeId]);
    }
  });
  it("reads real canonical fee rows through the versioned commercial Dashboard and keeps legacy HTTP explicit", async () => {
    const snapshot = await withDashboardReadSnapshot(db, { scope: { scopeKind: "report", ...scope }, range: { from: "2026-10-26", to: "2026-10-26" }, statementTimeoutMs: 10_000 },
      (client, context) => readDashboardCommercialSliceV2(client, context));
    expect(snapshot.data.schemaVersion).toBe(2);
    expect(snapshot.data.currencies.find(row => row.currencyCode === "VND")).toMatchObject({ validOrderCount: 3, cancelledOrderCohortCount: 1,
      currentOrderGrossValueMinor: 2810, currentPaymentFeeMinor: 200, currentPaymentFeeVatMinor: 19,
      currentPaymentFeeCustomerTotalMinor: 210, currentPaymentFeeRevenueExVatMinor: 191, effectiveItemQuantity: 3,
      currentVatMinor: 255, currentCogsMinor: 150, currentMerchandiseGrossProfitMinor: 2214 });
    const historical = await withDashboardReadSnapshot(db, { scope: { scopeKind: "report", ...scope }, range: { from: "2026-10-26", to: "2026-10-26" }, statementTimeoutMs: 10_000 },
      (client, context) => readDashboardCommercialSliceV2(client, { ...context, reportAsOf: "2026-10-26T04:15:00.000Z" }));
    expect(historical.data.currencies.find(row => row.currencyCode === "VND")).toMatchObject({ validOrderCount: 4, cancelledOrderCohortCount: 0,
      currentOrderGrossValueMinor: 3580, currentPaymentFeeMinor: 270, currentPaymentFeeVatMinor: 25, currentPaymentFeeCustomerTotalMinor: 280,
      currentPaymentFeeRevenueExVatMinor: 255, effectiveItemQuantity: 4, currentVatMinor: 325, currentMerchandiseGrossProfitMinor: 2800 });
    const filtered = await withDashboardReadSnapshot(db, { scope: { scopeKind: "report", ...scope }, range: { from: "2026-10-26", to: "2026-10-26" }, statementTimeoutMs: 10_000 },
      (client, context) => readDashboardCommercialSliceV2(client, context, { mode: "selected", creatorOperatorIds: [staffB] }));
    expect(filtered.data.currencies.find(row => row.currencyCode === "VND")).toMatchObject({ validOrderCount: 1, cancelledOrderCohortCount: 1,
      currentOrderGrossValueMinor: 1210, currentPaymentFeeMinor: 100, currentPaymentFeeVatMinor: 10, currentPaymentFeeRevenueExVatMinor: 100 });
    await expect(withDashboardReadSnapshot(db, { scope: { scopeKind: "report", ...scope }, range: { from: "2026-10-26", to: "2026-10-26" }, statementTimeoutMs: 10_000 },
      (client, context) => readDashboardCommercialSliceV1(client, context))).rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 });
    expect((await http(manager, "manager", {}, {}, dashboardRoute)).statusCode).toBe(409);
    expect((await http(manager, "manager", {}, {}, legacyDashboardRoute)).statusCode).toBe(409);
  });
  it("serves full/self DashboardV3 through real fresh auth and keeps accounting data out of staff JSON", async () => {
    expect(dashboardV3Alias).toBe(dashboardV3);
    const staff = await http(staffA, "staff", {}, {}, dashboardV3);
    expect(staff.statusCode).toBe(200);
    const self = CreatorSalesDashboardV3Schema.parse(staff.payload);
    expect(self).toMatchObject({ schemaVersion: 3, audience: "self", creatorSelection: { mode: "selected", creatorOperatorIds: [staffA] },
      currencies: [{ orderCount: 2, activeOrderCount: 2, currentOrderGrossValueMinor: 1600, currentPaymentFeeCustomerTotalMinor: 100,
        currentPaymentFeeVatMinor: 9, recordedGrossCollectionsMinor: 0, recordedPaymentFeeMinor: 0 }] });
    expect(JSON.stringify(self)).not.toMatch(/cogs|costCoverage|profit|financial|paymentFeeRevenue|journal/i);
    expect((await http(staffA, "staff", { creatorOperatorId: [staffB] }, {}, dashboardV3)).statusCode).toBe(403);
    const managerResponse = await http(manager, "manager", { creatorOperatorId: [staffA, staffB] }, {}, dashboardV3);
    expect(managerResponse.statusCode).toBe(200); expect(managerResponse.headers["X-Dashboard-Contract"]).toBe("dashboard.creator-sales.v3");
    expect(CreatorSalesDashboardV3Schema.parse(managerResponse.payload)).toMatchObject({ audience: "full", currencies: [{ orderCount: 4,
      activeOrderCount: 3, currentOrderGrossValueMinor: 2810, currentPaymentFeeCustomerTotalMinor: 210 }],
      feeFinancial: { currencies: [{ currentPaymentFeeRevenueExVatMinor: 191, recordedPaymentFeeRevenueExVatMinor: 0 }],
        journals: { currencies: [{ revenueExcludingVatMinor: 0, coverage: { totalJournalCount: 0 } }] } } });
    expect((await http(manager, "manager", {}, { "x-report-store-ids": "store_default" }, dashboardV3)).statusCode).toBe(403);
  });
  it("keeps closed business entities outside ordinary management report scope", async () => {
    await db.query("UPDATE app.stores SET status='closed' WHERE id=$1", [storeId]);
    try {
      await expect(resolveDashboardHistoryStoreWindows(db, { scopeKind: "report", ...scope }, { from: "2026-10-26", to: "2026-10-26", inclusiveDays: 1 }))
        .rejects.toMatchObject({ code: "dashboard_store_time_unavailable" });
      for (const handler of [pageRoute, csvRoute, dashboardRoute]) expect((await http(manager, "manager", {}, {}, handler)).statusCode).toBe(403);
    } finally { await db.query("UPDATE app.stores SET status='active' WHERE id=$1", [storeId]); }
  });
  it("keeps export permission and fresh scope, and rejects status/grain widening", async () => {
    expect((await http(staffA, "staff")).statusCode).toBe(403);
    expect((await http(manager, "manager", {}, { "x-report-store-ids": "store_default" })).statusCode).toBe(403);
    expect((await http(manager, "manager", { status: "invalid" })).statusCode).toBe(400);
    expect((await http(manager, "manager", { grain: "invalid" })).statusCode).toBe(400);
    expect((await http(manager, "manager", { creatorOperatorId: ["foreign-creator"] })).statusCode).toBe(403);
  });
  it("preserves trusted V2 corrections/shipping and rejects a legacy replay of its committed result", async () => {
    const actor = { operatorId: manager, role: "manager" as const, displayName: "Synthetic fee operator", organizationId: merchantId };
    const operating = { scopeKind: "operating" as const, merchantId, storeId, stockLocationId: storeId };
    const saleInput = { items: [{ variantId: catalog.variant, quantity: 1 }], customerMode: "walk_in" as const,
      paymentMethod: "cash", amountReceived: 2000, paymentFeeType: "percent" as const, paymentFeeValue: 10 };
    const booked = await completeSale({ "idempotency-key": `${prefix}:trusted-sale` }, saleInput, actor, operating);
    const afterSale = await fingerprint();
    await expect(completeSale({ "idempotency-key": `${prefix}:trusted-sale` }, { ...saleInput, paymentFeeValue: 20 }, actor, operating))
      .rejects.toMatchObject({ code: "idempotency_conflict", statusCode: 409 });
    expect(await fingerprint()).toEqual(afterSale);
    const orderId = String(booked.response.data.orderId);
    expect(booked.response.data.total).toBe(1320);
    expect(booked.response.data).toMatchObject({ financial: { calculationVersion: 2,
      paymentFee: { paymentFeeType: "percent", paymentFeeValue: 10, paymentFeeBasisMinor: 1200 },
      components: { paymentFeeMinor: 120, paymentFeeVatMinor: 11, totalMinor: 1320 } } });
    const input = { baseRevision: 0, reason: "Synthetic trusted fee correction", items: [{ variantId: catalog.variant, quantity: 2 }],
      settlement: { method: "cash", amountReceived: 1320 } };
    const preview = await previewOrderCorrection(orderId, input, actor, operating, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
    expect(preview.data).toMatchObject({ totalDelta: 1320, beforeTotals: { paymentFeeMinor: 120 }, afterTotals: { paymentFeeMinor: 240, total: 2640 } });
    expect(preview.data).toMatchObject({ beforeFinancial: { components: { totalMinor: 1320 } },
      afterFinancial: { paymentFee: { paymentFeeBasisMinor: 2400 }, components: { totalMinor: 2640, paymentFeeMinor: 240 } } });
    const key = `${prefix}:trusted-correction`;
    const corrected = await applyOrderCorrection({ "idempotency-key": key }, orderId, input, actor, operating, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
    expect(corrected.response.data.correction.afterTotals).toMatchObject({ paymentFeeMinor: 240, total: 2640 });
    expect(corrected.response.data.correction).toMatchObject({ beforeFinancial: { components: { totalMinor: 1320 } },
      afterFinancial: { components: { totalMinor: 2640, paymentFeeMinor: 240 } } });
    const replay = await applyOrderCorrection({ "idempotency-key": key }, orderId, input, actor, operating, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
    expect(replay.response).toEqual(corrected.response); expect(replay.statusCode).toBe(200);
    const saleReplay = await completeSale({ "idempotency-key": `${prefix}:trusted-sale` }, saleInput, actor, operating);
    expect(saleReplay.response).toEqual(JSON.parse(JSON.stringify(booked.response)));
    const count = (await db.query("SELECT count(*)::int AS n FROM app.order_commercial_revisions WHERE order_id=$1", [orderId])).rows[0];
    const legacyReplay = await http(manager, "manager", {}, { "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId,
      "idempotency-key": key }, correctionApplyPost, { id: orderId }, input);
    expect(legacyReplay.statusCode).toBe(409); expect(legacyReplay.payload).toMatchObject({ error: { code: "unsupported_contract" } });
    expect((await db.query("SELECT count(*)::int AS n FROM app.order_commercial_revisions WHERE order_id=$1", [orderId])).rows[0]).toEqual(count);
    const shipping = { shippingFee: 100, reason: "Synthetic shipping retains fee", paymentMethod: "cash", amountReceived: 100 };
    const quote = await previewOrderShippingFee(orderId, shipping, actor, operating);
    expect(quote.data).toMatchObject({ before: { total: 2640 }, after: { total: 2740 }, totalDelta: 100 });
    await updateOrderShippingFee({ "idempotency-key": `${prefix}:shipping` }, orderId,
      { ...shipping, confirmationToken: quote.data.confirmationToken }, actor, operating);
    expect((await db.query(`SELECT c.payment_fee_minor::int AS fee,c.total_minor::int AS total FROM app.order_commercial_revisions r
      JOIN app.order_commercial_revision_components c ON c.revision_id=r.id WHERE r.order_id=$1 ORDER BY r.revision DESC LIMIT 1`, [orderId])).rows[0]).toEqual({ fee: 240, total: 2740 });
    expect((await db.query("SELECT stocked_quantity::int AS stock FROM public.inventory_level WHERE inventory_item_id=$1", [catalog.item])).rows[0]).toEqual({ stock: 3 });
    const events = await db.query<{ id: string; event_type: string; payload: Record<string, unknown> }>(`SELECT id::text,event_type,payload
      FROM outbox.events WHERE merchant_id=$1 AND aggregate_type='order' AND aggregate_id=$2
        AND event_type IN ('sale.created','order.corrected') ORDER BY created_at,id`, [merchantId, orderId]);
    expect(events.rows).toHaveLength(3);
    for (const event of events.rows) {
      const message = { id: event.id, eventType: event.event_type, payload: event.payload };
      await processOutboxEvent(message); await processOutboxEvent(message);
    }
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(String(booked.response.data.createdAt)));
    const report = await readCreatorSalesDashboardV3(db, { scope: { scopeKind: "report", ...scope }, range: { from: localDate, to: localDate },
      creatorSelection: { mode: "selected", creatorOperatorIds: [manager] }, audience: "full", statementTimeoutMs: 10_000 });
    expect(report.currencies).toMatchObject([{ currentOrderGrossValueMinor: 2740, currentPaymentFeeMinor: 240,
      recordedGrossCollectionsMinor: 2740, recordedPaymentFeeMinor: 240, effectiveItemQuantity: 2 }]);
    const costProof = await db.query(`SELECT r.revision,r.source_type,r.data_quality,count(l.id)::int AS lines,
      count(l.id) FILTER(WHERE l.cost_minor IS NOT NULL AND l.cost_evidence_id IS NOT NULL)::int AS known_lines,
      sum(l.cost_minor)::text AS known_cost FROM app.order_commercial_revisions r LEFT JOIN app.order_commercial_revision_lines l ON l.revision_id=r.id
      WHERE r.order_id=$1 GROUP BY r.id,r.revision,r.source_type,r.data_quality ORDER BY r.revision`, [orderId]);
    expect(costProof.rows).toMatchObject([{ revision: 0, data_quality: "complete", known_lines: 1, known_cost: "50" },
      { revision: 1, data_quality: "partial", known_lines: 0, known_cost: null }, { revision: 2, data_quality: "partial", known_lines: 0, known_cost: null }]);
    expect(report.financial?.currencies).toMatchObject([{ status: "unavailable", issues: ["incomplete_cost_provenance"] }]);
    expect(report.financial?.profitCoverage).toMatchObject([{ coverage: { status: "partial", totalJournalCount: 2, coveredJournalCount: 1,
      excludedJournalCount: 1, verifiedSubsetRevenueExcludingVatMinor: 1091, verifiedSubsetCogsRecognizedMinor: 50, verifiedSubsetGrossProfitMinor: 1041 } }]);
    const goodsJournal = await db.query(`SELECT sum(CASE WHEN a.code='5111' THEN l.credit_amount-l.debit_amount ELSE 0 END)::int AS revenue,
      sum(CASE WHEN a.code='6321' THEN l.debit_amount-l.credit_amount ELSE 0 END)::int AS cogs
      FROM accounting.journal_entries j JOIN accounting.journal_lines l ON l.journal_entry_id=j.id JOIN accounting.accounts a ON a.id=l.account_id
      WHERE j.merchant_id=$1 AND j.store_id=$2 AND j.status='posted'`, [merchantId, storeId]);
    expect(goodsJournal.rows[0]).toEqual({ revenue: 2182, cogs: 100 });
    expect(report.feeFinancial).toMatchObject({ currencies: [{ currentPaymentFeeRevenueExVatMinor: 218, recordedPaymentFeeRevenueExVatMinor: 218 }],
      journals: { currencies: [{ revenueExcludingVatMinor: 218, coverage: { status: "available", coveredJournalCount: 2, totalJournalCount: 2 } }] } });
  });
  it("rejects malformed negotiated checkout bodies and product aliases before durable writes", async () => {
    const actor = { operatorId: manager, role: "manager" as const, displayName: "Synthetic fee operator", organizationId: merchantId };
    const scope = { scopeKind: "operating" as const, merchantId, storeId, stockLocationId: storeId };
    const sale = { items: [{ variantId: catalog.variant, quantity: 1 }], customerMode: "walk_in", paymentMethod: "cash", amountReceived: 2000,
      paymentFeeType: "percent", paymentFeeValue: 10, cartConfirmationToken: "a".repeat(64) };
    admissionFixture.ready = true;
    try {
      const before = await previewFacts();
      for (const [index, invalid] of [{ ...sale, merchantId: catalog.foreignMerchant }, { ...sale, total: 1 },
        { ...sale, amountReceived: "2000" }, { ...sale, items: [{ ...sale.items[0], unitPrice: 1 }] },
        { ...sale, items: [sale.items[0], sale.items[0]] }, { ...sale, items: [{ variantId: catalog.product, quantity: 1 }] }].entries()) {
        const result = await http(staffA, "staff", {}, { ...previewHeaders(), "idempotency-key": `${prefix}:strict-raw:${index}` }, checkoutPost, {}, invalid);
        expect(result.statusCode).toBe(400); expect(result.payload).toMatchObject({ error: { code: "validation_error" } });
        expect(await previewFacts()).toEqual(before);
      }
      for (const [index, items] of [[{ variantId: catalog.product, quantity: 1 }], [sale.items[0], sale.items[0]]].entries()) {
        await expect(completeSale({ "idempotency-key": `${prefix}:strict-kernel:${index}` }, { ...sale, items }, actor, scope))
          .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
        await db.query("BEGIN");
        try {
          await expect(quoteSaleForClient(db, { ...sale, items }, storeId, merchantId, storeId))
            .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
        } finally { await db.query("ROLLBACK"); }
        expect(await previewFacts()).toEqual(before);
      }
      await db.query("BEGIN");
      try {
        const { paymentFeeType: _type, paymentFeeValue: _value, cartConfirmationToken: _token, ...legacy } = sale;
        const quote = await quoteSaleForClient(db, { ...legacy, items: [{ variantId: catalog.product, quantity: 1 }] }, storeId, merchantId, storeId);
        expect(quote.items).toMatchObject([{ variantId: catalog.variant, quantity: 1 }]);
      } finally { await db.query("ROLLBACK"); }
      const oldPackage = process.env.APP_PACKAGE_KEY;
      try {
        process.env.APP_PACKAGE_KEY = "plus";
        const denied = await http(manager, "manager", {}, { ...previewHeaders(), "idempotency-key": `${prefix}:alias-before-intent` }, intentPost, {},
          { provider: "mock", order: { ...sale, items: [{ variantId: catalog.product, quantity: 1 }] } });
        expect(denied.statusCode).toBe(400); expect(denied.payload).toMatchObject({ error: { code: "validation_error" } });
        expect(await previewFacts()).toEqual(before);
      } finally { if (oldPackage === undefined) delete process.env.APP_PACKAGE_KEY; else process.env.APP_PACKAGE_KEY = oldPackage; }
    } finally { admissionFixture.ready = false; }
  });
  it("preserves a genuine V1 correction through the modern HTTP contract and denies malformed input without writes", async () => {
    const priorStock = (await db.query("SELECT stocked_quantity::text AS quantity FROM public.inventory_level WHERE inventory_item_id=$1", [catalog.item])).rows[0].quantity;
    const operating = { "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId };
    const original = { items: [{ variantId: catalog.variant, quantity: 1 }], customerMode: "walk_in", paymentMethod: "cash", amountReceived: 2000 };
    const sale = await http(staffA, "staff", {}, { ...operating, "idempotency-key": `${prefix}:modern-correction-legacy-sale` }, checkoutPost, {}, original);
    expect(sale.statusCode).toBe(201);
    const orderId = String((sale.payload as { data: { orderId: string } }).data.orderId);
    const headers = { ...previewHeaders(), "idempotency-key": `${prefix}:modern-v1-correction` };
    const correction = { baseRevision: 0, reason: "Synthetic legacy quantity correction", items: [{ variantId: catalog.variant, quantity: 2 }], settlement: { method: "cash", amountReceived: 1200 } };
    admissionFixture.ready = true;
    try {
      const before = await previewFacts();
      for (const [index, invalid] of [{ ...correction, merchantId: catalog.foreignMerchant }, { ...correction, baseRevision: "0" },
        { ...correction, items: [{ variantId: catalog.variant, quantity: 2, unitPrice: 1 }] },
        { ...correction, settlement: { method: "cash", amountReceived: 1200, force: true } }].entries()) {
        for (const handler of [correctionPreviewPost, correctionApplyPost]) {
          const denied = await http(manager, "manager", {}, { ...headers, "idempotency-key": `${prefix}:strict-correction:${index}` }, handler, { id: orderId }, invalid);
          expect(denied.statusCode).toBe(400); expect(denied.payload).toMatchObject({ error: { code: "validation_error" } });
          expect(await previewFacts()).toEqual(before);
        }
      }
      const preview = await http(manager, "manager", {}, headers, correctionPreviewPost, { id: orderId }, correction);
      expect(preview.statusCode).toBe(200);
      expect(OrderCorrectionFinancialPreviewV1Schema.parse(preview.payload).data).toMatchObject({ beforeTotals: { total: 1200 }, afterTotals: { total: 2400 },
        beforeFinancial: { status: "legacy" }, afterFinancial: { status: "legacy" }, totalDelta: 1200 });
      expect(await previewFacts()).toEqual(before);
      const missingConfirmation = await http(manager, "manager", {}, headers, correctionApplyPost, { id: orderId }, correction);
      expect(missingConfirmation.statusCode).toBe(400); expect(await previewFacts()).toEqual(before);
      const confirmed = { ...correction, confirmationToken: OrderCorrectionFinancialPreviewV1Schema.parse(preview.payload).data.confirmationToken };
      const applied = await http(manager, "manager", {}, headers, correctionApplyPost, { id: orderId }, confirmed);
      expect(applied.statusCode).toBe(201);
      expect(OrderCorrectionFinancialResponseV1Schema.parse(applied.payload).data.correction).toMatchObject({
        beforeFinancial: { status: "legacy" }, afterFinancial: { status: "legacy" }, totalDelta: 1200 });
      const after = await previewFacts();
      const retry = await http(manager, "manager", {}, headers, correctionApplyPost, { id: orderId }, confirmed);
      expect(retry.statusCode).toBe(200); expect(retry.payload).toEqual(applied.payload); expect(await previewFacts()).toEqual(after);
      expect((await db.query(`SELECT c.component_version FROM app.order_commercial_revision_components c
        JOIN app.order_commercial_revisions r ON r.id=c.revision_id WHERE r.order_id=$1 ORDER BY r.revision`, [orderId])).rows.map(row => Number(row.component_version))).toEqual([1, 1]);
      const legacyFacts = (await db.query(`SELECT to_jsonb(r) AS revision, to_jsonb(c) AS components
        FROM app.order_commercial_revisions r JOIN app.order_commercial_revision_components c ON c.revision_id=r.id
        WHERE r.order_id=$1 AND r.revision<=1 ORDER BY r.revision`, [orderId])).rows;
      const promotedInput = { ...correction, baseRevision: 1, paymentFeeType: "percent", paymentFeeValue: 10,
        settlement: { method: "cash", amountReceived: 240 } };
      const promotionPreview = await http(manager, "manager", {}, headers, correctionPreviewPost, { id: orderId }, promotedInput);
      expect(promotionPreview.statusCode).toBe(200);
      const promoted = await http(manager, "manager", {}, { ...headers, "idempotency-key": `${prefix}:modern-v1-promotion` }, correctionApplyPost, { id: orderId },
        { ...promotedInput, confirmationToken: OrderCorrectionFinancialPreviewV1Schema.parse(promotionPreview.payload).data.confirmationToken });
      expect(promoted.statusCode).toBe(201);
      expect(OrderCorrectionFinancialResponseV1Schema.parse(promoted.payload).data.correction).toMatchObject({
        beforeTotals: { total: 2400 }, afterTotals: { total: 2640 }, totalDelta: 240,
        afterFinancial: { status: "available", snapshot: { paymentFee: { paymentFeeBasisMinor: 2400 }, components: { paymentFeeMinor: 240 } } } });
      expect((await db.query(`SELECT to_jsonb(r) AS revision, to_jsonb(c) AS components
        FROM app.order_commercial_revisions r JOIN app.order_commercial_revision_components c ON c.revision_id=r.id
        WHERE r.order_id=$1 AND r.revision<=1 ORDER BY r.revision`, [orderId])).rows).toEqual(legacyFacts);
    } finally {
      admissionFixture.ready = false;
      await db.query("UPDATE public.inventory_level SET stocked_quantity=$2 WHERE inventory_item_id=$1", [catalog.item, priorStock]);
    }
  });
  it("returns frozen checkout/intent/correction snapshots through authenticated HTTP with synthetic admission", async () => {
    const originalPackage = process.env.APP_PACKAGE_KEY;
    const operating = { "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId,
      [PAYMENT_FEE_WRITE_HTTP_HEADER_V1]: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 };
    const sale = { items: [{ variantId: catalog.variant, quantity: 1 }], customerMode: "walk_in", paymentMethod: "cash", amountReceived: 2000,
      paymentFeeType: "percent", paymentFeeValue: 10, shippingFee: 0, cartConfirmationToken: "" };
    admissionFixture.ready = true;
    try {
      sale.cartConfirmationToken = await confirmationFor(sale);
      const checkoutHeaders = { ...operating, "idempotency-key": `${prefix}:http-snapshot-sale` };
      const created = await http(staffA, "staff", {}, checkoutHeaders, checkoutPost, {}, sale);
      expect(created.statusCode).toBe(201);
      expect(created.headers[PAYMENT_FEE_WRITE_HTTP_HEADER_V1]).toBe(PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
      const body = created.payload as { data: { orderId: string; financial: unknown } };
      expect(OrderPaymentFeeFinancialSnapshotV1Schema.parse(body.data.financial).components).toMatchObject({ totalMinor: 1320, paymentFeeMinor: 120 });
      const correction = { baseRevision: 0, reason: "Synthetic HTTP surcharge adjustment", items: sale.items,
        paymentFeeType: "percent", paymentFeeValue: 20, settlement: { method: "cash", amountReceived: 120 } };
      const preview = await http(manager, "manager", {}, operating, correctionPreviewPost, { id: body.data.orderId }, correction);
      expect(preview.statusCode).toBe(200);
      expect(OrderCorrectionFinancialPreviewV1Schema.parse(preview.payload)).toMatchObject({ data: { merchantId, storeId,
        beforeFinancial: { status: "available", snapshot: { components: { totalMinor: 1320 } } },
        afterFinancial: { status: "available", snapshot: { components: { totalMinor: 1440, paymentFeeMinor: 240 } } }, totalDelta: 120 } });
      const confirmationToken = (preview.payload as { data: { confirmationToken: string } }).data.confirmationToken;
      expect(confirmationToken).toMatch(/^[a-f0-9]{64}$/);
      const beforeConfirm = await previewFacts();
      const changed = await http(manager, "manager", {}, { ...operating, "idempotency-key": `${prefix}:stale-quoted-fee` }, correctionApplyPost,
        { id: body.data.orderId }, { ...correction, confirmationToken, paymentFeeValue: 30, settlement: { method: "cash", amountReceived: 240 } });
      expect(changed.statusCode).toBe(409); expect(changed.payload).toMatchObject({ error: { code: "order_correction_quote_changed" } });
      expect(await previewFacts()).toEqual(beforeConfirm);
      const correctionHeaders = { ...operating, "idempotency-key": `${prefix}:http-snapshot-correction` };
      const confirmed = { ...correction, confirmationToken };
      const corrected = await http(manager, "manager", {}, correctionHeaders, correctionApplyPost, { id: body.data.orderId }, confirmed);
      expect(corrected.statusCode).toBe(201);
      expect(OrderCorrectionFinancialResponseV1Schema.parse(corrected.payload)).toMatchObject({ data: { merchantId, storeId,
        correction: { beforeFinancial: { status: "available", snapshot: { components: { totalMinor: 1320 } } },
          afterFinancial: { status: "available", snapshot: { components: { totalMinor: 1440, paymentFeeMinor: 240 } } } } } });
      const after = await fingerprint();
      await db.query("UPDATE public.price SET amount=1300,raw_amount=$2 WHERE id=$1", [`${prefix}:price`, JSON.stringify({ value: "1300", precision: 20 })]);
      try {
        const retry = await http(staffA, "staff", {}, checkoutHeaders, checkoutPost, {}, sale);
        expect(retry.statusCode).toBe(200); expect(retry.payload).toEqual(JSON.parse(JSON.stringify(created.payload)));
      } finally { await db.query("UPDATE public.price SET amount=1200,raw_amount=$2 WHERE id=$1", [`${prefix}:price`, JSON.stringify({ value: "1200", precision: 20 })]); }
      const correctionRetry = await http(manager, "manager", {}, correctionHeaders, correctionApplyPost, { id: body.data.orderId }, confirmed);
      expect(correctionRetry.statusCode).toBe(200); expect(correctionRetry.payload).toEqual(JSON.parse(JSON.stringify(corrected.payload)));
      expect(await fingerprint()).toEqual(after);
      const intentHeaders = { ...operating, "idempotency-key": paymentIntentCreationKeyPrefixV1(manager, storeId) + `${prefix}:http-snapshot-intent` };
      process.env.APP_PACKAGE_KEY = "basic";
      const deniedIntent = await http(manager, "manager", {}, intentHeaders, intentPost, {}, { provider: "mock", order: sale });
      expect(deniedIntent.statusCode).toBe(403); expect(await fingerprint()).toEqual(after);
      expect(deniedIntent.payload).toMatchObject({ error: { code: "feature_not_entitled" } });
      process.env.APP_PACKAGE_KEY = "plus";
      const intent = await http(manager, "manager", {}, intentHeaders, intentPost, {}, { provider: "mock", order: sale });
      expect(intent.statusCode).toBe(201);
      expect(intent.payload).toMatchObject({ data: { amount: 1320, financial: { status: "available", snapshot: { components: { totalMinor: 1320, paymentFeeMinor: 120 } } } } });
      const intentRetry = await http(manager, "manager", {}, intentHeaders, intentPost, {}, { provider: "mock", order: sale });
      expect(intentRetry.statusCode).toBe(200); expect(intentRetry.payload).toEqual(JSON.parse(JSON.stringify(intent.payload)));
      const intentId = String((intent.payload as { data: { id: string } }).data.id);
      admissionFixture.ready = false;
      const receiptRequest = { requestHash: createHash("sha256").update(JSON.stringify({ provider: "mock", order: sale })).digest("hex") };
      const beforeLookup = await previewFacts();
      process.env.APP_PACKAGE_KEY = "basic";
      const recoveredCreation = await http(manager, "manager", {}, intentHeaders, intentCreationReceiptPost, {}, receiptRequest);
      process.env.APP_PACKAGE_KEY = "plus";
      expect(recoveredCreation.statusCode).toBe(200);
      expect(recoveredCreation.headers).toMatchObject({ "Cache-Control": "private, no-store", [PAYMENT_FEE_WRITE_HTTP_HEADER_V1]: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 });
      expect(recoveredCreation.payload).toMatchObject({ schemaVersion: 1, requestHash: receiptRequest.requestHash,
        data: { status: "resolved", intent: { id: intentId, merchantId, storeId, status: "pending", amount: 1320,
          financial: { status: "available", snapshot: { components: { paymentFeeMinor: 120, totalMinor: 1320 } } } } } });
      const retainedClose = await http(manager, "manager", {}, intentHeaders, intentCreationClosePost, {}, receiptRequest);
      expect(retainedClose.statusCode).toBe(200);
      expect(retainedClose.payload).toMatchObject({ data: { status: "resolved", intent: { id: intentId } } });
      for (const field of ["metadata", "orderInput", "createdBy", "providerReference", "stockLocationId"]) {
        expect(recoveredCreation.payload).not.toHaveProperty(`data.intent.${field}`);
      }
      expect((await http(staffA, "staff", {}, intentHeaders, intentCreationReceiptPost, {}, receiptRequest)).statusCode).toBe(403);
      expect((await http(manager, "manager", {}, { ...intentHeaders, "x-operating-store-id": "store_default" }, intentCreationReceiptPost, {}, receiptRequest)).statusCode).toBe(403);
      expect((await http(manager, "manager", {}, intentHeaders, intentCreationReceiptPost, {}, { requestHash: "a".repeat(64) })).statusCode).toBe(409);
      expect((await http(manager, "manager", {}, intentHeaders, intentCreationReceiptPost, {}, { ...receiptRequest, operatorId: manager })).statusCode).toBe(400);
      expect((await http(manager, "manager", {}, operating, intentCreationReceiptPost, {}, receiptRequest)).statusCode).toBe(400);
      const { [PAYMENT_FEE_WRITE_HTTP_HEADER_V1]: _receiptContract, ...withoutReceiptContract } = intentHeaders;
      expect((await http(manager, "manager", {}, withoutReceiptContract, intentCreationReceiptPost, {}, receiptRequest)).statusCode).toBe(409);
      for (const key of [`${prefix}:never-dispatched`, checkoutHeaders["idempotency-key"]]) {
        const unresolved = await http(manager, "manager", {}, { ...intentHeaders, "idempotency-key": key }, intentCreationReceiptPost, {}, receiptRequest);
        expect(unresolved.statusCode).toBe(200); expect(unresolved.payload).toMatchObject({ data: { status: "unresolved" } });
      }
      await db.query("UPDATE app.operator_memberships SET status='revoked' WHERE operator_id=$1", [manager]);
      try { expect((await http(manager, "manager", {}, intentHeaders, intentCreationReceiptPost, {}, receiptRequest)).statusCode).toBe(403); }
      finally { await db.query("UPDATE app.operator_memberships SET status='active' WHERE operator_id=$1", [manager]); }
      const storedExpiry = (await db.query("SELECT expires_at FROM app.idempotency_records WHERE tenant_id=$1 AND operation='payment_intent.create' AND idempotency_key=$2", [merchantId, intentHeaders["idempotency-key"]])).rows[0]!.expires_at;
      await db.query("UPDATE app.idempotency_records SET expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND operation='payment_intent.create' AND idempotency_key=$2", [merchantId, intentHeaders["idempotency-key"]]);
      try {
        const expiredCreation = await http(manager, "manager", {}, intentHeaders, intentCreationReceiptPost, {}, receiptRequest);
        expect(expiredCreation.statusCode).toBe(200); expect(expiredCreation.payload).toMatchObject({ data: { status: "resolved", intent: { id: intentId } } });
      } finally { await db.query("UPDATE app.idempotency_records SET expires_at=$3 WHERE tenant_id=$1 AND operation='payment_intent.create' AND idempotency_key=$2", [merchantId, intentHeaders["idempotency-key"], storedExpiry]); }
      const originalReceipt = (await db.query("SELECT to_jsonb(r) AS value FROM app.idempotency_records r WHERE tenant_id=$1 AND operation='payment_intent.create' AND idempotency_key=$2", [merchantId, intentHeaders["idempotency-key"]])).rows[0]!.value;
      await db.query("DELETE FROM app.idempotency_records WHERE tenant_id=$1 AND operation='payment_intent.create' AND idempotency_key=$2", [merchantId, intentHeaders["idempotency-key"]]);
      try {
        const beforeMissingCache = await previewFacts();
        const canonicalRecovery = await http(manager, "manager", {}, intentHeaders, intentCreationReceiptPost, {}, receiptRequest);
        expect(canonicalRecovery.statusCode).toBe(200);
        expect(canonicalRecovery.payload).toMatchObject({ data: { status: "resolved", intent: { id: intentId } } });
        admissionFixture.ready = true;
        const duplicateCreation = await http(manager, "manager", {}, intentHeaders, intentPost, {}, { provider: "mock", order: sale });
        admissionFixture.ready = false;
        expect(duplicateCreation.statusCode).toBe(409);
        expect(duplicateCreation.payload).toMatchObject({ error: { code: "payment_intent_creation_already_recorded" } });
        const canonicalClose = await http(manager, "manager", {}, intentHeaders, intentCreationClosePost, {}, receiptRequest);
        expect(canonicalClose.statusCode).toBe(200); expect(canonicalClose.payload).toMatchObject({ data: { status: "resolved", intent: { id: intentId } } });
        expect(await previewFacts()).toEqual(beforeMissingCache);
      } finally {
        admissionFixture.ready = false;
        await db.query("INSERT INTO app.idempotency_records SELECT (jsonb_populate_record(NULL::app.idempotency_records,$1::jsonb)).*", [JSON.stringify(originalReceipt)]);
      }
      expect(await previewFacts()).toEqual(beforeLookup);
      const beforeRecovery = await previewFacts();
      for (const candidate of [
        { handler: checkoutPost, request: sale, requestHeaders: checkoutHeaders, expected: created.payload, operator: staffA, role: "staff" as const, operation: "order.complete_sale" },
        { handler: intentPost, request: { provider: "mock", order: sale }, requestHeaders: intentHeaders, expected: intent.payload, operator: manager, role: "manager" as const, operation: "payment_intent.create" },
      ]) {
        await db.query("UPDATE public.price SET amount=1300,raw_amount=$2 WHERE id=$1", [`${prefix}:price`, JSON.stringify({ value: "1300", precision: 20 })]);
        try {
          process.env.APP_PACKAGE_KEY = "basic";
          const recovered = await http(candidate.operator, candidate.role, {}, candidate.requestHeaders, candidate.handler, {}, candidate.request);
          expect(recovered.statusCode).toBe(200); expect(recovered.payload).toEqual(JSON.parse(JSON.stringify(candidate.expected)));
          expect(recovered.headers).toMatchObject({ "Cache-Control": "private, no-store", [PAYMENT_FEE_WRITE_HTTP_HEADER_V1]: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 });
        } finally {
          process.env.APP_PACKAGE_KEY = "plus";
          await db.query("UPDATE public.price SET amount=1200,raw_amount=$2 WHERE id=$1", [`${prefix}:price`, JSON.stringify({ value: "1200", precision: 20 })]);
        }
        const { [PAYMENT_FEE_WRITE_HTTP_HEADER_V1]: _contract, ...unnegotiated } = candidate.requestHeaders;
        expect((await http(candidate.operator, candidate.role, {}, unnegotiated, candidate.handler, {}, candidate.request)).statusCode).toBe(409);
        expect((await http(candidate.operator, candidate.role, {}, candidate.requestHeaders, candidate.handler, {}, { ...candidate.request, total: 1 })).statusCode).toBe(400);
        const unknown = await http(candidate.operator, candidate.role, {}, { ...candidate.requestHeaders, "idempotency-key": `${prefix}:missing:${candidate.operation}` }, candidate.handler, {}, candidate.request);
        expect(unknown.statusCode).toBe(503); expect(unknown.payload).toMatchObject({ error: { code: "feature_unavailable" } });
        const changedRequest = candidate.operation === "order.complete_sale" ? { ...sale, paymentFeeValue: 20 }
          : { provider: "mock", order: { ...sale, paymentFeeValue: 20 } };
        const mismatch = await http(candidate.operator, candidate.role, {}, candidate.requestHeaders, candidate.handler, {}, changedRequest);
        expect(mismatch.statusCode).toBe(409); expect(mismatch.payload).toMatchObject({ error: { code: "idempotency_conflict" } });
        const foreign = await http(candidate.operator, candidate.role, {}, { ...candidate.requestHeaders, "x-operating-store-id": "store_default" }, candidate.handler, {}, candidate.request);
        expect(foreign.statusCode).toBe(403);
        await db.query("UPDATE app.operator_memberships SET status='revoked' WHERE operator_id=$1", [candidate.operator]);
        try { expect((await http(candidate.operator, candidate.role, {}, candidate.requestHeaders, candidate.handler, {}, candidate.request)).statusCode).toBe(403); }
        finally { await db.query("UPDATE app.operator_memberships SET status='active' WHERE operator_id=$1", [candidate.operator]); }
        const key = candidate.requestHeaders["idempotency-key"];
        const retained = (await db.query("SELECT expires_at,response FROM app.idempotency_records WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3", [merchantId, candidate.operation, key])).rows[0]!;
        await db.query("UPDATE app.idempotency_records SET response=jsonb_set(response,'{data,storeId}',to_jsonb('foreign-store'::text)) WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3", [merchantId, candidate.operation, key]);
        try {
          const wrongScope = await http(candidate.operator, candidate.role, {}, candidate.requestHeaders, candidate.handler, {}, candidate.request);
          expect(wrongScope.statusCode).toBe(403); expect(wrongScope.payload).not.toHaveProperty("data");
        } finally { await db.query("UPDATE app.idempotency_records SET response=$4::jsonb WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3", [merchantId, candidate.operation, key, JSON.stringify(retained.response)]); }
        await db.query("UPDATE app.idempotency_records SET expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3", [merchantId, candidate.operation, key]);
        try {
          const expired = await http(candidate.operator, candidate.role, {}, candidate.requestHeaders, candidate.handler, {}, candidate.request);
          expect(expired.statusCode).toBe(503);
          expect((await db.query("SELECT count(*) AS count FROM app.idempotency_records WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3", [merchantId, candidate.operation, key])).rows[0]!.count).toBe("1");
        } finally { await db.query("UPDATE app.idempotency_records SET expires_at=$4 WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3", [merchantId, candidate.operation, key, retained.expires_at]); }
        expect(await previewFacts()).toEqual(beforeRecovery);
      }
      const legacyIntent = await http(manager, "manager", {}, {}, intentGet, { id: intentId });
      expect(legacyIntent.statusCode).toBe(409);
      expect(legacyIntent.payload).toMatchObject({ error: { code: "unsupported_contract" } });
      const modernIntent = await http(manager, "manager", {}, operating, intentGet, { id: intentId });
      expect(modernIntent.statusCode).toBe(200);
      expect(modernIntent.payload).toMatchObject({ data: { financial: { status: "available", snapshot: { components: { paymentFeeMinor: 120, totalMinor: 1320 } } } } });
      const oldList = await http(manager, "manager", { limit: "1", offset: "9999" }, {}, intentListGet);
      expect(oldList.statusCode).toBe(409);
      const newList = await http(manager, "manager", { limit: "1", offset: "9999" }, operating, intentListGet);
      expect(newList.statusCode).toBe(200); expect(newList.payload).toMatchObject({ data: [], count: 1, limit: 1, offset: 9999 });
      for (const key of ["orderInput", "metadata", "providerReference", "createdBy", "stockLocationId"]) {
        expect(modernIntent.payload).not.toHaveProperty(`data.${key}`);
      }
      const legacyOperating = { "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId };
      const cancellationKey = { "idempotency-key": `${prefix}:http-cancel-fee` };
      const rejectedCancel = await http(manager, "manager", {}, { ...legacyOperating, ...cancellationKey }, intentCancelPost, { id: intentId }, {});
      expect(rejectedCancel.statusCode).toBe(409);
      expect((await http(manager, "manager", {}, operating, intentGet, { id: intentId })).payload).toEqual(modernIntent.payload);
      const cancelled = await http(manager, "manager", {}, { ...operating, ...cancellationKey }, intentCancelPost, { id: intentId }, {});
      const recoveredCancelled = await http(manager, "manager", {}, intentHeaders, intentCreationReceiptPost, {}, receiptRequest);
      expect(recoveredCancelled.statusCode).toBe(200);
      expect(recoveredCancelled.payload).toMatchObject({ data: { status: "resolved", intent: { id: intentId, status: "cancelled" } } });
      expect(cancelled.statusCode).toBe(201);
      expect(cancelled.payload).toMatchObject({ data: { status: "cancelled", financial: { status: "available" } } });
      const cachedCancel = await http(manager, "manager", {}, { ...legacyOperating, ...cancellationKey }, intentCancelPost, { id: intentId }, {});
      expect(cachedCancel.statusCode).toBe(409);
      expect((await http(manager, "manager", {}, { ...operating, ...cancellationKey }, intentCancelPost, { id: intentId }, {})).payload).toEqual(cancelled.payload);
      const newIntent = async (suffix: string, paymentFeeValue = 10) => {
        admissionFixture.ready = true;
        try {
          const order = { ...sale, paymentFeeValue };
          order.cartConfirmationToken = await confirmationFor(order);
          const created = await http(manager, "manager", {}, { ...operating, "idempotency-key": `${prefix}:${suffix}` }, intentPost, {},
            { provider: "mock", order });
          expect(created.statusCode).toBe(201);
          return String((created.payload as { data: { id: string } }).data.id);
        } finally { admissionFixture.ready = false; }
      };
      for (const priceChange of ["removed", "changed"] as const) {
        const changedPriceId = await newIntent(`price-${priceChange}-after-intent`);
        if (priceChange === "removed") await db.query("UPDATE public.price SET deleted_at=clock_timestamp() WHERE price_set_id=$1", [catalog.priceSet]);
        else await db.query("UPDATE public.price SET amount=1400,raw_amount=$2 WHERE price_set_id=$1", [catalog.priceSet, JSON.stringify({ value: "1400", precision: 20 })]);
        try {
        const before = await previewFacts();
        const settleHeaders = { ...operating, "idempotency-key": `${prefix}:settle-price-${priceChange}` };
        const result = await http(manager, "manager", {}, settleHeaders, intentSettlePost, { id: changedPriceId }, {});
        expect(result.statusCode).toBe(201);
        expect(result.payload).toMatchObject({ data: { status: "manual_review", manualReviewReason: "payment_intent_quote_invalid",
          financial: { status: "available", snapshot: { components: { totalMinor: 1320 } } } } });
        const after = await previewFacts();
        expect({ ...after, receipts: before.receipts }).toEqual(before);
        expect(Number(after.receipts)).toBe(Number(before.receipts) + 1);
        const replay = await http(manager, "manager", {}, settleHeaders, intentSettlePost, { id: changedPriceId }, {});
        expect(replay.statusCode).toBe(200); expect(replay.payload).toEqual(JSON.parse(JSON.stringify(result.payload)));
        expect(await previewFacts()).toEqual(after);
        expect((await db.query("SELECT status,error FROM app.payment_provider_events WHERE provider='mock' AND provider_event_id=$1", [`mock:${changedPriceId}:settled`])).rows)
          .toEqual([{ status: "manual_review", error: "payment_intent_quote_invalid" }]);
        } finally { await db.query("UPDATE public.price SET deleted_at=NULL,amount=1200,raw_amount=$2 WHERE price_set_id=$1", [catalog.priceSet, JSON.stringify({ value: "1200", precision: 20 })]); }
      }
      const corruptId = await newIntent("corrupt-fee-intent");
      await db.query("UPDATE app.payment_intents SET metadata=jsonb_set(metadata,'{quote,totals,total}','1200') WHERE id=$1", [corruptId]);
      const beforeCorruptSettlement = await fingerprint();
      const corruptSettlement = await http(manager, "manager", {}, { ...operating, "idempotency-key": `${prefix}:corrupt-settle` }, intentSettlePost, { id: corruptId }, {});
      expect(corruptSettlement.statusCode).toBe(201);
      expect(corruptSettlement.payload).toMatchObject({ data: { status: "manual_review", manualReviewReason: "payment_intent_quote_invalid",
        financial: { status: "unavailable", reason: "stored_quote_invalid" } } });
      expect(await fingerprint()).toEqual(beforeCorruptSettlement);
      const corruptPendingId = await newIntent("corrupt-pending-fee-intent");
      await db.query("UPDATE app.payment_intents SET metadata=jsonb_set(metadata,'{quote,totals,total}','1200') WHERE id=$1", [corruptPendingId]);
      const recoverCancel = await http(manager, "manager", {}, { ...operating, "idempotency-key": `${prefix}:corrupt-cancel` }, intentCancelPost, { id: corruptPendingId }, {});
      expect(recoverCancel.statusCode).toBe(201);
      expect(recoverCancel.payload).toMatchObject({ data: { status: "cancelled", financial: { status: "unavailable" } } });
      const paidId = await newIntent("paid-fee-intent");
      const paidKey = { "idempotency-key": `${prefix}:paid-fee-settle` };
      const beforePaid = await fingerprint();
      const oldSettle = await http(manager, "manager", {}, { ...legacyOperating, ...paidKey }, intentSettlePost, { id: paidId }, {});
      expect(oldSettle.statusCode).toBe(409); expect(await fingerprint()).toEqual(beforePaid);
      const paid = await http(manager, "manager", {}, { ...operating, ...paidKey }, intentSettlePost, { id: paidId }, {});
      expect(paid.statusCode).toBe(201);
      expect(paid.payload).toMatchObject({ data: { status: "completed", financial: { status: "available", snapshot: { components: { totalMinor: 1320 } } } },
        order: { orderId: expect.any(String) } });
      const afterPaid = await fingerprint();
      expect((await http(manager, "manager", {}, { ...legacyOperating, ...paidKey }, intentSettlePost, { id: paidId }, {})).statusCode).toBe(409);
      const paidReplay = await http(manager, "manager", {}, { ...operating, ...paidKey }, intentSettlePost, { id: paidId }, {});
      expect(paidReplay.statusCode).toBe(200); expect(paidReplay.payload).toEqual(JSON.parse(JSON.stringify(paid.payload)));
      expect(await fingerprint()).toEqual(afterPaid);
      const zeroId = await newIntent("zero-fee-intent", 0);
      expect((await http(manager, "manager", {}, {}, intentGet, { id: zeroId })).statusCode).toBe(200);
      expect((await http(manager, "manager", { status: "pending" }, {}, intentListGet)).statusCode).toBe(200);
      await db.query(`UPDATE app.payment_intents SET order_input=jsonb_set(order_input,'{paymentFeeValue}','10'),
        metadata=jsonb_set(metadata,'{quote,totals,paymentFeeValue}','10') WHERE id=$1`, [zeroId]);
      const concealed = await http(manager, "manager", { status: "pending", limit: "1", offset: "9999" }, {}, intentListGet);
      expect(concealed.statusCode).toBe(409);
      const exposed = await http(manager, "manager", { status: "pending" }, operating, intentListGet);
      expect(exposed.statusCode).toBe(200);
      expect(exposed.payload).toMatchObject({ data: [{ id: zeroId, financial: { status: "unavailable" } }] });
      const { paymentFeeType: _type, paymentFeeValue: _value, cartConfirmationToken: _token, ...legacySale } = sale;
      const legacyHeaders = { "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId,
        "idempotency-key": `${prefix}:http-legacy-snapshot-sale` };
      const legacy = await http(staffA, "staff", {}, legacyHeaders, checkoutPost, {}, legacySale);
      expect(legacy.statusCode).toBe(201); expect(legacy.payload).toMatchObject({ data: { total: 1200 } });
      expect(legacy.payload).not.toHaveProperty("data.financial");
      expect(legacy.headers).not.toHaveProperty(PAYMENT_FEE_WRITE_HTTP_HEADER_V1);
    } finally {
      admissionFixture.ready = false;
      if (originalPackage === undefined) delete process.env.APP_PACKAGE_KEY; else process.env.APP_PACKAGE_KEY = originalPackage;
    }
  });
  it("posts the O2 exclusive-VAT sale through the actual worker with separated balanced revenue and frozen VAT on replay", async () => {
    const variant = `${prefix}:exclusive-variant`, item = `${prefix}:exclusive-item`, priceSet = `${prefix}:exclusive-price-set`;
    await db.query("BEGIN");
    try {
      await db.query("INSERT INTO public.product_variant(id,title,sku,product_id) VALUES($1,'Exclusive oracle','EXCLUSIVE-ORACLE',$2)", [variant, catalog.product]);
      await db.query("INSERT INTO public.price_set(id) VALUES($1)", [priceSet]);
      await db.query("INSERT INTO public.product_variant_price_set(id,variant_id,price_set_id) VALUES($1,$2,$3)", [`${prefix}:exclusive-vps`, variant, priceSet]);
      await db.query("INSERT INTO public.price(id,price_set_id,currency_code,amount,raw_amount) VALUES($1,$2,'vnd',240000,$3)", [`${prefix}:exclusive-price`, priceSet, JSON.stringify({ value: "240000", precision: 20 })]);
      await db.query("INSERT INTO public.inventory_item(id,sku,title) VALUES($1,'EXCLUSIVE-ORACLE','Exclusive oracle')", [item]);
      await db.query("INSERT INTO public.product_variant_inventory_item(id,variant_id,inventory_item_id,required_quantity) VALUES($1,$2,$3,1)", [`${prefix}:exclusive-vii`, variant, item]);
      await db.query("INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity) VALUES($1,$2,$3,10,0)", [`${prefix}:exclusive-level`, item, storeId]);
      await db.query("INSERT INTO inventory.product_settings(variant_id,product_id,cost_price,reorder_level,preferred_stock,merchant_id) VALUES($1,$2,50,0,10,$3)", [variant, catalog.product, merchantId]);
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    const oldTax = process.env.TAX_MODE, oldVAT = process.env.VAT_RATE;
    admissionFixture.ready = true; process.env.TAX_MODE = "exclusive"; process.env.VAT_RATE = "0.1";
    try {
      const sale = { items: [{ variantId: variant, quantity: 1 }], customerMode: "walk_in", paymentMethod: "cash", amountReceived: 300000,
        discountType: "percent", discountValue: 10, shippingFee: 20000, paymentFeeType: "percent", paymentFeeValue: 2, cartConfirmationToken: "" };
      sale.cartConfirmationToken = await confirmationFor(sale);
      const headers = { ...previewHeaders(), "idempotency-key": `${prefix}:exclusive-sale` };
      const booked = await http(staffB, "staff", {}, headers, checkoutPost, {}, sale);
      expect(booked.statusCode).toBe(201);
      expect(booked.payload).toMatchObject({ data: { total: 264352, tax: 24032, discount: 24000, change: 35648,
        financial: { paymentFee: { paymentFeeBasisMinor: 216000, vatRatePpm: 100000 }, components: {
          taxMode: "exclusive", merchandiseNetMinor: 216000, shippingMinor: 20000, paymentFeeMinor: 4320,
          merchandiseVatMinor: 21600, shippingVatMinor: 2000, paymentFeeVatMinor: 432, vatMinor: 24032, totalMinor: 264352 } } } });
      const orderId = String((booked.payload as { data: { orderId: string } }).data.orderId);
      const events = (await db.query("SELECT id::text,event_type,payload FROM outbox.events WHERE aggregate_type='order' AND aggregate_id=$1 AND event_type='sale.created'", [orderId])).rows;
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ total: 264352, tax: 24032, merchandiseRevenue: 216000,
        shippingRevenue: 20000, paymentFeeRevenueMinor: 4320, loyaltyBase: 216000, cogs: 50 });
      process.env.TAX_MODE = "inclusive"; process.env.VAT_RATE = "0.2";
      const event = events[0]!;
      await processOutboxEvent({ id: event.id, eventType: event.event_type, payload: event.payload });
      await processOutboxEvent({ id: event.id, eventType: event.event_type, payload: event.payload });
      const lines = await db.query(`SELECT a.code,sum(l.debit_amount)::int AS debit,sum(l.credit_amount)::int AS credit
        FROM accounting.journal_entries j JOIN accounting.journal_lines l ON l.journal_entry_id=j.id JOIN accounting.accounts a ON a.id=l.account_id
        WHERE j.merchant_id=$1 AND j.store_id=$2 AND j.reference_type='order' AND j.reference_id=$3 AND j.status='posted'
        GROUP BY a.code ORDER BY a.code`, [merchantId, storeId, orderId]);
      expect(lines.rows).toEqual([{ code: "1111", debit: 264352, credit: 0 }, { code: "1561", debit: 0, credit: 50 },
        { code: "3331", debit: 0, credit: 24032 }, { code: "5111", debit: 0, credit: 216000 },
        { code: "5112", debit: 0, credit: 20000 }, { code: "5113", debit: 0, credit: 4320 }, { code: "6321", debit: 50, credit: 0 }]);
      expect(lines.rows.reduce((n, line) => n + line.debit, 0)).toBe(264402);
      expect(lines.rows.reduce((n, line) => n + line.credit, 0)).toBe(264402);
      expect((await db.query("SELECT count(*)::int AS count FROM accounting.journal_entries WHERE reference_type='order' AND reference_id=$1", [orderId])).rows[0]!.count).toBe(1);
      expect((await db.query("SELECT stocked_quantity::int AS stock FROM public.inventory_level WHERE inventory_item_id=$1", [item])).rows[0]!.stock).toBe(9);
      const replay = await http(staffB, "staff", {}, headers, checkoutPost, {}, sale);
      expect(replay.statusCode).toBe(200); expect(replay.payload).toEqual(JSON.parse(JSON.stringify(booked.payload)));
    } finally {
      admissionFixture.ready = false;
      if (oldTax === undefined) delete process.env.TAX_MODE; else process.env.TAX_MODE = oldTax;
      if (oldVAT === undefined) delete process.env.VAT_RATE; else process.env.VAT_RATE = oldVAT;
    }
  });
  it("binds new-item prices before correction commit and distinguishes a missing price from an explicit free price", async () => {
    const variant = `${prefix}:quote-variant`, item = `${prefix}:quote-item`, priceSet = `${prefix}:quote-price-set`, priceId = `${prefix}:quote-price`;
    await db.query("BEGIN");
    try {
      await db.query("INSERT INTO public.product_variant(id,title,sku,product_id) VALUES($1,'Quote item','QUOTE-PRICE',$2)", [variant, catalog.product]);
      await db.query("INSERT INTO public.price_set(id) VALUES($1)", [priceSet]);
      await db.query("INSERT INTO public.product_variant_price_set(id,variant_id,price_set_id) VALUES($1,$2,$3)", [`${prefix}:quote-vps`, variant, priceSet]);
      await db.query("INSERT INTO public.price(id,price_set_id,currency_code,amount,raw_amount) VALUES($1,$2,'vnd',1400,$3)", [priceId, priceSet, JSON.stringify({ value: "1400", precision: 20 })]);
      await db.query("INSERT INTO public.inventory_item(id,sku,title) VALUES($1,'QUOTE-PRICE','Quote item')", [item]);
      await db.query("INSERT INTO public.product_variant_inventory_item(id,variant_id,inventory_item_id,required_quantity) VALUES($1,$2,$3,1)", [`${prefix}:quote-vii`, variant, item]);
      await db.query("INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity) VALUES($1,$2,$3,3,0)", [`${prefix}:quote-level`, item, storeId]);
      await db.query("INSERT INTO inventory.product_settings(variant_id,product_id,cost_price,reorder_level,preferred_stock,merchant_id) VALUES($1,$2,50,0,3,$3)", [variant, catalog.product, merchantId]);
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    const priorStock = (await db.query("SELECT stocked_quantity::text AS quantity FROM public.inventory_level WHERE inventory_item_id=$1", [catalog.item])).rows[0].quantity;
    await db.query("UPDATE public.inventory_level SET stocked_quantity=2 WHERE inventory_item_id=$1", [catalog.item]);
    const { [PAYMENT_FEE_WRITE_HTTP_HEADER_V1]: _financial, ...legacyHeaders } = previewHeaders();
    const original = await http(staffA, "staff", {}, { ...legacyHeaders, "idempotency-key": `${prefix}:price-correction-source` }, checkoutPost, {},
      { items: [{ variantId: catalog.variant, quantity: 1 }], customerMode: "walk_in", paymentMethod: "cash", amountReceived: 2000 });
    expect(original.statusCode).toBe(201);
    const input = { baseRevision: 0, reason: "Synthetic new-item price confirmation", items: [{ variantId: catalog.variant, quantity: 1 }, { variantId: variant, quantity: 1 }],
      paymentFeeType: "percent", paymentFeeValue: 10, settlement: { method: "cash", amountReceived: 1660 } };
    const target = { id: String((original.payload as { data: { orderId: string } }).data.orderId) }, headers = { ...previewHeaders(), "idempotency-key": `${prefix}:price-changed-correction` };
    admissionFixture.ready = true;
    try {
      const before = await previewFacts();
      const quoted = await http(manager, "manager", {}, headers, correctionPreviewPost, target, input);
      expect(quoted.statusCode).toBe(200); const quote = OrderCorrectionFinancialPreviewV1Schema.parse(quoted.payload);
      expect(quote.data).toMatchObject({ afterTotals: { total: 2860 }, totalDelta: 1660 });
      await db.query("UPDATE public.price SET amount=1500,raw_amount=$2 WHERE id=$1", [priceId, JSON.stringify({ value: "1500", precision: 20 })]);
      const changed = await http(manager, "manager", {}, headers, correctionApplyPost, target,
        { ...input, confirmationToken: quote.data.confirmationToken, settlement: { method: "cash", amountReceived: 1770 } });
      expect(changed.statusCode).toBe(409); expect(changed.payload).toMatchObject({ error: { code: "order_correction_quote_changed" } });
      expect(await previewFacts()).toEqual(before);
      await db.query("UPDATE public.price SET deleted_at=clock_timestamp() WHERE id=$1", [priceId]);
      const missing = await http(manager, "manager", {}, headers, correctionPreviewPost, target, input);
      expect(missing.statusCode).toBe(409); expect(missing.payload).toMatchObject({ error: { code: "variant_price_unavailable" } });
      expect(await previewFacts()).toEqual(before);
      await db.query("UPDATE public.price SET deleted_at=NULL,amount=0,raw_amount=$2 WHERE id=$1", [priceId, JSON.stringify({ value: "0", precision: 20 })]);
      const free = await http(manager, "manager", {}, headers, correctionPreviewPost, target, input);
      expect(free.statusCode).toBe(200); expect(OrderCorrectionFinancialPreviewV1Schema.parse(free.payload).data).toMatchObject({ afterTotals: { total: 1320 }, totalDelta: 120 });
      await db.query("UPDATE public.price SET deleted_at=clock_timestamp() WHERE id=$1", [`${prefix}:price`]);
      try {
        const retained = await http(manager, "manager", {}, headers, correctionPreviewPost, target, input);
        expect(retained.statusCode).toBe(200); expect(OrderCorrectionFinancialPreviewV1Schema.parse(retained.payload).data).toMatchObject({
          afterTotals: { total: 1320 }, items: expect.arrayContaining([expect.objectContaining({ variantId: catalog.variant, unitPrice: 1200 })]) });
      } finally { await db.query("UPDATE public.price SET deleted_at=NULL WHERE id=$1", [`${prefix}:price`]); }
      expect(await previewFacts()).toEqual(before);
      expect((await db.query("SELECT stocked_quantity::int AS quantity FROM public.inventory_level WHERE inventory_item_id=$1", [item])).rows[0].quantity).toBe(3);
    } finally {
      admissionFixture.ready = false;
      await db.query("UPDATE public.inventory_level SET stocked_quantity=$2 WHERE inventory_item_id=$1", [catalog.item, priorStock]);
    }
  });
  async function recoverableCreation(suffix: string) {
    const order = { items: [{ variantId: `${prefix}:exclusive-variant`, quantity: 1 }], customerMode: "walk_in" as const,
      paymentMethod: "cash", amountReceived: 0, paymentFeeType: "percent" as const, paymentFeeValue: 2, cartConfirmationToken: "" };
    order.cartConfirmationToken = await confirmationFor(order);
    const body = { provider: "mock" as const, order };
    const requestHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    return { body, requestHash, headers: { ...previewHeaders(), "idempotency-key": paymentIntentCreationKeyPrefixV1(manager, storeId) + `${prefix}:${suffix}` } };
  }
  it("closes only an unexecuted owned key, retains a permanent refusal and denies late creation without new business facts", async () => {
    const request = await recoverableCreation("never-executed");
    const before = await previewFacts(), oldPackage = process.env.APP_PACKAGE_KEY;
    process.env.APP_PACKAGE_KEY = "plus";
    try {
      const result = await http(manager, "manager", {}, request.headers, intentCreationClosePost, {}, { requestHash: request.requestHash });
      expect(result.statusCode).toBe(200); expect(result.payload).toMatchObject({ data: { status: "closed" } });
      const after = await previewFacts();
      expect(after).toEqual({ ...before, receipts: String(Number(before.receipts) + 1) });
      const retained = (await db.query(`SELECT expires_at::text AS expiry,response FROM app.idempotency_records
        WHERE tenant_id=$1 AND operation='payment_intent.create' AND idempotency_key=$2`, [merchantId, request.headers["idempotency-key"]])).rows[0]!;
      expect(retained.expiry).toBe("infinity");
      expect(retained.response).toEqual({ schemaVersion: 1, idempotencyOutcome: "closed_without_execution", operatorId: manager, merchantId, storeId });
      expect((await http(manager, "manager", {}, request.headers, intentCreationClosePost, {}, { requestHash: request.requestHash })).payload).toEqual(result.payload);
      expect((await http(manager, "manager", {}, request.headers, intentCreationReceiptPost, {}, { requestHash: request.requestHash })).payload).toEqual(result.payload);
      admissionFixture.ready = true;
      const late = await http(manager, "manager", {}, request.headers, intentPost, {}, request.body);
      expect(late.statusCode).toBe(409); expect(late.payload).toMatchObject({ error: { code: "idempotency_request_closed" } });
      expect((await http(manager, "manager", {}, request.headers, intentCreationClosePost, {}, { requestHash: "a".repeat(64) })).statusCode).toBe(409);
      expect((await http(staffA, "staff", {}, request.headers, intentCreationClosePost, {}, { requestHash: request.requestHash })).statusCode).toBe(403);
      expect((await http(manager, "manager", {}, { ...request.headers, "x-operating-store-id": "store_default" }, intentCreationClosePost, {}, { requestHash: request.requestHash })).statusCode).toBe(403);
      expect((await http(manager, "manager", {}, { ...request.headers, "idempotency-key": `${prefix}:unversioned-close` }, intentCreationClosePost, {}, { requestHash: request.requestHash })).statusCode).toBe(400);
      expect(await previewFacts()).toEqual(after);
    } finally {
      admissionFixture.ready = false;
      if (oldPackage === undefined) delete process.env.APP_PACKAGE_KEY; else process.env.APP_PACKAGE_KEY = oldPackage;
    }
  });
  it("allows an explicit scoped reader to recover but refuses closure without fresh create permission", async () => {
    const request = await recoverableCreation("read-only-close");
    const before = await previewFacts();
    await db.query("UPDATE app.operator_memberships SET role_key='accountant' WHERE operator_id=$1", [manager]);
    const grant = (await db.query(`INSERT INTO app.operator_explicit_permission_grants(operator_id,permission_id,scope_type,merchant_id,store_id,status,granted_by)
      VALUES($1,'payment_intent:read','store',$2,$3,'active','UAT') RETURNING id`, [manager, merchantId, storeId])).rows[0]!;
    try {
      const read = await http(manager, "manager", {}, request.headers, intentCreationReceiptPost, {}, { requestHash: request.requestHash });
      expect(read.statusCode).toBe(200); expect(read.payload).toMatchObject({ data: { status: "unresolved" } });
      expect((await http(manager, "manager", {}, request.headers, intentCreationClosePost, {}, { requestHash: request.requestHash })).statusCode).toBe(403);
      expect(await previewFacts()).toEqual(before);
    } finally {
      await db.query("DELETE FROM app.operator_explicit_permission_grants WHERE id=$1", [grant.id]);
      await db.query("UPDATE app.operator_memberships SET role_key='manager' WHERE operator_id=$1", [manager]);
    }
  });
  it.each(["create", "close"] as const)("serializes simultaneous creation/closure when %s reaches the key lock first", async first => {
    const request = await recoverableCreation(`race-${first}`), blocker = await connectPlatformClient();
    const actor = { operatorId: manager, role: "manager" as const, displayName: "Synthetic recovery operator", organizationId: merchantId };
    const operating = { merchantId, storeId, stockLocationId: storeId };
    const lockKey = `${merchantId}\u001fpayment_intent.create\u001f${request.headers["idempotency-key"]}`;
    const jobs: Array<Promise<{ value?: unknown; error?: unknown }>> = [];
    const oldPackage = process.env.APP_PACKAGE_KEY; process.env.APP_PACKAGE_KEY = "plus";
    const before = await previewFacts(); let released = false;
    const launch = (kind: "create" | "close") => {
      const job = kind === "create" ? createPaymentIntent(request.headers, request.body, actor, operating)
        : closePaymentIntentCreationReceiptV1(request.headers, { requestHash: request.requestHash }, actor, operating);
      const observed = job.then(value => ({ value }), error => ({ error })); jobs.push(observed); return observed;
    };
    const waitForWaiters = async (count: number) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const row = (await db.query(`SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objsubid=1
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid AND objid=(hashtextextended($1,0)&4294967295)::oid`, [lockKey])).rows[0]!;
        if (row.count >= count) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`Expected ${count} confirmed creation-key waiters`);
    };
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey]);
      const early = launch(first); await waitForWaiters(1);
      const late = launch(first === "create" ? "close" : "create"); await waitForWaiters(2);
      await blocker.query("COMMIT"); released = true;
      const values = await Promise.all([early, late]);
      if (first === "close") {
        expect(values[0].value).toMatchObject({ data: { status: "closed" } });
        expect(values[1].error).toMatchObject({ code: "idempotency_request_closed" });
      } else {
        expect(values[0].value).toMatchObject({ statusCode: 201 });
        const id = String((values[0].value as { response: { data: { id: string } } }).response.data.id);
        expect(values[1].value).toMatchObject({ data: { status: "resolved", intent: { id } } });
      }
      expect(await previewFacts()).toEqual({ ...before, receipts: String(Number(before.receipts) + 1),
        intents: String(Number(before.intents) + (first === "create" ? 1 : 0)) });
      const recovered = await recoverPaymentIntentCreationReceiptV1(request.headers, { requestHash: request.requestHash }, actor, operating);
      expect(recovered.data.status).toBe(first === "create" ? "resolved" : "closed");
    } finally {
      if (!released) await blocker.query("ROLLBACK");
      await Promise.allSettled(jobs); blocker.release();
      if (oldPackage === undefined) delete process.env.APP_PACKAGE_KEY; else process.env.APP_PACKAGE_KEY = oldPackage;
    }
  }, 20_000);

});
