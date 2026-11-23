import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import type { OperatorContext } from "../services/auth-service";
import type { ChannelActor } from "../services/channel-auth-service";
import { createProduct } from "../services/product-management-service";
import { listProducts } from "../services/product-service";
import {
  adjustStock,
  listInventoryItems,
  listStockMovements,
} from "../services/inventory-service";
import {
  cancelOrder,
  completeSale,
  createRemoteOrder,
  getOrder,
} from "../services/order-service";
import {
  createCustomer,
  getCustomerLoyalty,
  listCustomers,
  listLoyaltyTiers,
} from "../services/customer-service";
import {
  createProductCategory,
  getProductCategory,
  listProductCategories,
} from "../services/product-category-service";
import {
  createJournalEntry,
  listJournalEntries,
} from "../services/accounting-service";
import { createPaymentIntent, settleMockPaymentIntent } from "../services/payment-intent-service";
import { getReceiptText } from "../services/receipt-service";
import { getDashboard } from "../services/dashboard-service";
import { listAudit } from "../services/audit-service";

/**
 * Merchant-scoped resource isolation.
 * Every tenant owns distinct products, inventory, customers and orders.
 */
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const MERCHANT_A = `scope_test_merchant_a_${runId}`;
const MERCHANT_B = `scope_test_merchant_b_${runId}`;
const STORE_A = `scope_test_store_a_${runId}`;
const STORE_B = `scope_test_store_b_${runId}`;
const SLOC_A = `scope_test_sloc_a_${runId}`;
const SLOC_B = `scope_test_sloc_b_${runId}`;
const STORE_TIME_ZONE = "Asia/Ho_Chi_Minh";

const scopeA = { scopeKind: "operating" as const, merchantId: MERCHANT_A, storeId: STORE_A, stockLocationId: SLOC_A };
const scopeB = { scopeKind: "operating" as const, merchantId: MERCHANT_B, storeId: STORE_B, stockLocationId: SLOC_B };
const merchantScopeA = { scopeKind: "merchant_target" as const, merchantId: MERCHANT_A };
const merchantScopeB = { scopeKind: "merchant_target" as const, merchantId: MERCHANT_B };
const reportA = { scopeKind: "report" as const, merchantId: MERCHANT_A, storeIds: [STORE_A] };
const reportB = { scopeKind: "report" as const, merchantId: MERCHANT_B, storeIds: [STORE_B] };

const actorA: OperatorContext = { operatorId: `scope_test_owner_a_${runId}`, role: "owner", displayName: "Tenant A", organizationId: `scope_test_org_a_${runId}` };
const actorB: OperatorContext = { operatorId: `scope_test_owner_b_${runId}`, role: "owner", displayName: "Tenant B", organizationId: `scope_test_org_b_${runId}` };
const channelA: ChannelActor = {
  ...actorA,
  channel: "telegram",
  channelUserId: `scope_test_tg_a_${runId}`,
  serviceIdentity: "telegram",
  permissions: ["remote_order:create", "orders:read", "order:cancel", "order:refund"],
};

let client: PoolClient;
let productA = "";
let productB = "";
let variantA = "";
let variantB = "";
let inventoryA = "";
let inventoryB = "";
let customerA = "";
let customerB = "";
let categoryA = "";
let categoryB = "";
let orderB = "";

function dateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error(`Unable to derive dashboard date for ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}

async function stock(inventoryItemId: string, stockLocationId: string): Promise<number> {
  const row = await queryOne<{ quantity: string }>(client, `
    SELECT stocked_quantity::numeric AS quantity
    FROM public.inventory_level
    WHERE inventory_item_id = $1 AND location_id = $2 AND deleted_at IS NULL
  `, [inventoryItemId, stockLocationId]);
  return Number(row?.quantity || 0);
}

async function inventoryItemForVariant(variantId: string): Promise<string> {
  const row = await queryOne<{ inventory_item_id: string }>(client, `
    SELECT inventory_item_id
    FROM public.product_variant_inventory_item
    WHERE variant_id = $1 AND deleted_at IS NULL
  `, [variantId]);
  if (!row?.inventory_item_id) throw new Error(`Missing inventory item for ${variantId}`);
  return row.inventory_item_id;
}

beforeAll(async () => {
  process.env.APP_PACKAGE_KEY = "ai_fan";
  await ensurePlatformSchema();
  client = await connectPlatformClient();

  for (const [merchantId, orgId, storeId, stockLocationId, label] of [
    [MERCHANT_A, actorA.organizationId, STORE_A, SLOC_A, "A"],
    [MERCHANT_B, actorB.organizationId, STORE_B, SLOC_B, "B"],
  ] as const) {
    await client.query(
      "INSERT INTO app.merchants (id, display_name, legacy_organization_id, status) VALUES ($1, $2, $3, 'active')",
      [merchantId, `Fixture ${label}`, orgId],
    );
    await client.query("INSERT INTO public.stock_location (id, name) VALUES ($1, $2)", [stockLocationId, `Fixture Location ${label}`]);
    await client.query(
      `INSERT INTO app.stores (
        id, merchant_id, display_name, stock_location_id, is_primary, status, metadata
      ) VALUES (
        $1, $2, $3, $4, true, 'active',
        '{"ownerSettings":{"timezone":"Asia/Ho_Chi_Minh"}}'::jsonb
      )`,
      [storeId, merchantId, `Fixture Store ${label}`, stockLocationId],
    );
    await client.query(`
      INSERT INTO ai_module.loyalty_tiers (name, points_threshold, discount_percent, description, merchant_id)
      VALUES
        ('bronze', 0, 0, 'Default', $1),
        ('silver', 100, 2, 'Silver', $1)
      ON CONFLICT (merchant_id, name) WHERE merchant_id IS NOT NULL DO NOTHING
    `, [merchantId]);
  }

  const createdA = await createProduct(
    { "idempotency-key": `a19r2:${runId}:product-a` },
    { title: `Tenant A Product ${runId}`, sku: `A19R2-A-${runId}`, barcode: `A19R2-BA-${runId}`, price: 100000, costPrice: 60000, reorderLevel: 3, categoryIds: [], imageUrl: "https://tenant-a.example.com/product.jpg" },
    actorA,
    merchantScopeA,
    scopeA,
  );
  const createdB = await createProduct(
    { "idempotency-key": `a19r2:${runId}:product-b` },
    { title: `Tenant B Product ${runId}`, sku: `A19R2-B-${runId}`, barcode: `A19R2-BB-${runId}`, price: 200000, costPrice: 120000, reorderLevel: 3, categoryIds: [], imageUrl: "https://tenant-b.example.com/product.jpg" },
    actorB,
    merchantScopeB,
    scopeB,
  );
  productA = createdA.response.product.id;
  productB = createdB.response.product.id;
  variantA = createdA.response.product.variants[0].id;
  variantB = createdB.response.product.variants[0].id;
  inventoryA = await inventoryItemForVariant(variantA);
  inventoryB = await inventoryItemForVariant(variantB);

  await adjustStock(
    { "idempotency-key": `a19r2:${runId}:opening-a` },
    { inventoryItemId: inventoryA, adjustment: 30, reason: `opening-a-${runId}` },
    actorA,
    scopeA,
  );
  await adjustStock(
    { "idempotency-key": `a19r2:${runId}:opening-b` },
    { inventoryItemId: inventoryB, adjustment: 40, reason: `opening-b-${runId}` },
    actorB,
    scopeB,
  );

  const createdCustomerA = await createCustomer(
    { "idempotency-key": `a19r2:${runId}:customer-a` },
    { phone: `0901${runId.replace(/\D/g, "").slice(-6)}`, first_name: "Customer A" },
    actorA,
    merchantScopeA,
  );
  const createdCustomerB = await createCustomer(
    { "idempotency-key": `a19r2:${runId}:customer-b` },
    { phone: `0902${runId.replace(/\D/g, "").slice(-6)}`, first_name: "Customer B" },
    actorB,
    merchantScopeB,
  );
  customerA = createdCustomerA.response.customer.id;
  customerB = createdCustomerB.response.customer.id;

  const createdCategoryA = await createProductCategory(
    { "idempotency-key": `a19r2:${runId}:category-a` },
    { name: `Tenant A Category ${runId}` },
    actorA,
    merchantScopeA,
  );
  const createdCategoryB = await createProductCategory(
    { "idempotency-key": `a19r2:${runId}:category-b` },
    { name: `Tenant B Category ${runId}` },
    actorB,
    merchantScopeB,
  );
  categoryA = createdCategoryA.response.product_category.id;
  categoryB = createdCategoryB.response.product_category.id;
}, 30_000);

afterAll(async () => {
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("Tenant isolation", () => {
  it("isolates distinct catalog and inventory rows by merchant", async () => {
    const productsA = await listProducts({ merchantId: MERCHANT_A, stockLocationId: SLOC_A });
    const productsB = await listProducts({ merchantId: MERCHANT_B, stockLocationId: SLOC_B });
    expect(productsA.find((item) => item.id === productA)?.imageUrl).toBe("https://tenant-a.example.com/product.jpg");
    expect(productsA.some((item) => item.id === productB)).toBe(false);
    expect(productsB.find((item) => item.id === productB)?.imageUrl).toBe("https://tenant-b.example.com/product.jpg");
    expect(productsB.some((item) => item.id === productA)).toBe(false);

    const inventoryForA = await listInventoryItems(scopeA);
    const inventoryForB = await listInventoryItems(scopeB);
    expect(inventoryForA.inventory_items.some((item) => item.id === inventoryA)).toBe(true);
    expect(inventoryForA.inventory_items.some((item) => item.id === inventoryB)).toBe(false);
    expect(inventoryForB.inventory_items.some((item) => item.id === inventoryB)).toBe(true);
    expect(inventoryForB.inventory_items.some((item) => item.id === inventoryA)).toBe(false);
  });

  it("isolates customers, loyalty tiers and categories", async () => {
    const customersA = await listCustomers({ merchantId: MERCHANT_A });
    const customersB = await listCustomers({ merchantId: MERCHANT_B });
    expect(customersA.customers.map((row) => row.id)).toContain(customerA);
    expect(customersA.customers.map((row) => row.id)).not.toContain(customerB);
    expect(customersB.customers.map((row) => row.id)).toContain(customerB);
    expect(customersB.customers.map((row) => row.id)).not.toContain(customerA);

    await expect(getCustomerLoyalty(customerB, { merchantId: MERCHANT_A })).rejects.toMatchObject({ code: "resource_not_found" });
    expect((await listLoyaltyTiers(MERCHANT_A)).data.map((tier) => tier.name)).toEqual(["bronze", "silver"]);

    const categoriesA = await listProductCategories(MERCHANT_A, { q: runId });
    const categoriesB = await listProductCategories(MERCHANT_B, { q: runId });
    expect(categoriesA.product_categories.map((row) => row.id)).toContain(categoryA);
    expect(categoriesA.product_categories.map((row) => row.id)).not.toContain(categoryB);
    expect(categoriesB.product_categories.map((row) => row.id)).toContain(categoryB);
    await expect(getProductCategory(categoryB, MERCHANT_A)).rejects.toMatchObject({ code: "resource_not_found" });
  });

  it("creates a real store-B order and rejects store-A read/cancel before mutation", async () => {
    const beforeB = await stock(inventoryB, SLOC_B);
    const created = await completeSale(
      { "idempotency-key": `a19r2:${runId}:sale-b` },
      { customerId: customerB, items: [{ variantId: variantB, quantity: 1 }], paymentMethod: "cash", amountReceived: 500000, salesChannel: "pos_counter" },
      actorB,
      scopeB,
    );
    orderB = created.response.data.orderId;
    expect(orderB).toBeTruthy();
    await expect(getOrder(orderB, { merchantId: MERCHANT_A, storeIds: [STORE_A] })).rejects.toMatchObject({ code: "resource_not_found" });
    await expect(cancelOrder(
      { "idempotency-key": `a19r2:${runId}:cross-cancel` },
      orderB,
      { reason: "cross tenant" },
      actorA,
      scopeA,
    )).rejects.toMatchObject({ code: "forbidden" });
    await expect(stock(inventoryB, SLOC_B)).resolves.toBe(beforeB - 1);
  });

  it("settles a payment intent only against its captured stock location", async () => {
    const beforeA = await stock(inventoryA, SLOC_A);
    const beforeB = await stock(inventoryB, SLOC_B);
    const intent = await createPaymentIntent(
      { "idempotency-key": `a19r2:${runId}:intent-a` },
      { provider: "mock", order: { items: [{ variantId: variantA, quantity: 1 }], customerId: customerA, paymentMethod: "mock", amountReceived: 0, salesChannel: "pos_counter" } },
      actorA,
      scopeA,
    );
    const settled = await settleMockPaymentIntent(
      { "idempotency-key": `a19r2:${runId}:settle-a` },
      intent.response.data.id,
      actorA,
      scopeA,
    );
    expect(settled.response.data.completedOrderId).toBeTruthy();
    await expect(stock(inventoryA, SLOC_A)).resolves.toBe(beforeA - 1);
    await expect(stock(inventoryB, SLOC_B)).resolves.toBe(beforeB);
  });

  it("binds a remote order to the selected OperatingScope", async () => {
    const remote = await createRemoteOrder(
      { "idempotency-key": `a19r2:${runId}:remote-a` },
      { items: [{ variantId: variantA, quantity: 1 }], customerId: customerA, paymentMethod: "cod", salesChannel: "telegram" },
      channelA,
      scopeA,
    );
    const row = await queryOne<{ merchant_id: string; store_id: string }>(client, "SELECT merchant_id, store_id FROM public.\"order\" WHERE id = $1", [remote.response.data.orderId]);
    expect(row).toEqual({ merchant_id: MERCHANT_A, store_id: STORE_A });
  });

  it("serializes concurrent same-tenant idempotency and isolates the same key across tenants", async () => {
    const beforeA = await stock(inventoryA, SLOC_A);
    const concurrentKey = { "idempotency-key": `a19r2:${runId}:concurrent` };
    const concurrentBody = { inventoryItemId: inventoryA, adjustment: 1, reason: `concurrent-${runId}` };
    const concurrent = await Promise.all([
      adjustStock(concurrentKey, concurrentBody, actorA, scopeA),
      adjustStock(concurrentKey, concurrentBody, actorA, scopeA),
    ]);
    expect(concurrent.map((result) => result.statusCode).sort()).toEqual([200, 201]);
    await expect(stock(inventoryA, SLOC_A)).resolves.toBe(beforeA + 1);
    const movementCount = await queryOne<{ count: number }>(client, "SELECT count(*)::int AS count FROM medusa.stock_movements WHERE reason = $1", [concurrentBody.reason]);
    expect(movementCount?.count).toBe(1);

    const sharedHeaders = { "idempotency-key": `a19r2:${runId}:shared-cross-tenant` };
    const beforeCrossA = await stock(inventoryA, SLOC_A);
    const beforeCrossB = await stock(inventoryB, SLOC_B);
    const [resultA, resultB] = await Promise.all([
      adjustStock(sharedHeaders, { inventoryItemId: inventoryA, adjustment: 1, reason: `cross-a-${runId}` }, actorA, scopeA),
      adjustStock(sharedHeaders, { inventoryItemId: inventoryB, adjustment: 1, reason: `cross-b-${runId}` }, actorB, scopeB),
    ]);
    expect(resultA.statusCode).toBe(201);
    expect(resultB.statusCode).toBe(201);
    await expect(stock(inventoryA, SLOC_A)).resolves.toBe(beforeCrossA + 1);
    await expect(stock(inventoryB, SLOC_B)).resolves.toBe(beforeCrossB + 1);
  });

  it("returns only stamped stock movements for the selected tenant/store", async () => {
    const movementsA = await listStockMovements(scopeA);
    const movementsB = await listStockMovements(scopeB);
    expect(movementsA.data.length).toBeGreaterThan(0);
    expect(movementsB.data.length).toBeGreaterThan(0);
    expect(movementsA.data.every((row) => row.merchantId === MERCHANT_A && row.storeId === STORE_A && row.stockLocationId === SLOC_A)).toBe(true);
    expect(movementsB.data.every((row) => row.merchantId === MERCHANT_B && row.storeId === STORE_B && row.stockLocationId === SLOC_B)).toBe(true);
    expect(movementsA.data.some((row) => row.inventoryItemId === inventoryB)).toBe(false);
    expect(movementsB.data.some((row) => row.inventoryItemId === inventoryA)).toBe(false);
  });

  it("scopes receipts, journals, dashboards and audit reads", async () => {
    expect((await getReceiptText(orderB, reportB)).toString()).toContain("Receipt:");
    await expect(getReceiptText(orderB, reportA)).rejects.toMatchObject({ code: "resource_not_found" });

    const journalA = await createJournalEntry(
      { "idempotency-key": `a19r2:${runId}:journal-a` },
      { entryDate: new Date().toISOString().slice(0, 10), description: `Journal A ${runId}`, lines: [{ accountCode: "1111", debitAmount: 1000, creditAmount: 0 }, { accountCode: "4111", debitAmount: 0, creditAmount: 1000 }] },
      actorA,
      scopeA,
    );
    const journalB = await createJournalEntry(
      { "idempotency-key": `a19r2:${runId}:journal-b` },
      { entryDate: new Date().toISOString().slice(0, 10), description: `Journal B ${runId}`, lines: [{ accountCode: "1111", debitAmount: 2000, creditAmount: 0 }, { accountCode: "4111", debitAmount: 0, creditAmount: 2000 }] },
      actorB,
      scopeB,
    );
    const journalsA = await listJournalEntries(reportA);
    const journalsB = await listJournalEntries(reportB);
    expect(journalsA.data.map((row: { id: string }) => row.id)).toContain(journalA.response.data.id);
    expect(journalsA.data.map((row: { id: string }) => row.id)).not.toContain(journalB.response.data.id);
    expect(journalsB.data.map((row: { id: string }) => row.id)).toContain(journalB.response.data.id);

    const dashboardDate = dateInTimeZone(new Date(), STORE_TIME_ZONE);
    const dashboardA = await getDashboard(reportA, { date: dashboardDate });
    const dashboardB = await getDashboard(reportB, { date: dashboardDate });
    expect(dashboardA.data.orderCount).toBeGreaterThan(0);
    expect(dashboardB.data.orderCount).toBeGreaterThan(0);

    const auditA = await listAudit(reportA);
    const auditB = await listAudit(reportB);
    expect(auditA.data.length).toBeGreaterThan(0);
    expect(auditB.data.length).toBeGreaterThan(0);
    expect(auditA.data.every((row: { merchantId: string }) => row.merchantId === MERCHANT_A)).toBe(true);
    expect(auditB.data.every((row: { merchantId: string }) => row.merchantId === MERCHANT_B)).toBe(true);
  });
});
