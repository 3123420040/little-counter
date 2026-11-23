import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import { createJournalEntry, postJournalEntry } from "../services/accounting-service";
import { createCustomer, deleteCustomer, listCustomers, mergeCustomers, updateCustomer } from "../services/customer-service";
import { createProductCategory, updateProductCategory } from "../services/product-category-service";
import type { OperatorContext } from "../services/auth-service";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const actor: OperatorContext = { operatorId: "op_owner", role: "owner", displayName: "Scoped DB Owner", organizationId: "org_default" };
const merchantA = { scopeKind: "merchant_target" as const, merchantId: "merchant_default" };
const merchantB = { scopeKind: "merchant_target" as const, merchantId: `merchant-scope-${runId}` };
const storeA = { scopeKind: "operating" as const, merchantId: "merchant_default", storeId: "store_default", stockLocationId: "sloc_default" };

let client: PoolClient;
const categoryIds: string[] = [];
const customerIds: string[] = [];
const journalIds: string[] = [];
const orderIds: string[] = [];

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await client.query(`
    INSERT INTO app.merchants (
      id, display_name, legacy_organization_id, status, metadata
    ) VALUES ($1, $2, $3, 'active', '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `, [merchantB.merchantId, `Scope merchant ${runId}`, `org-scope-${runId}`]);
});

afterAll(async () => {
  if (journalIds.length) await client.query("DELETE FROM accounting.journal_entries WHERE id = ANY($1::uuid[])", [journalIds]).catch(() => undefined);
  if (orderIds.length) await client.query("DELETE FROM public.\"order\" WHERE id = ANY($1::text[])", [orderIds]).catch(() => undefined);
  if (customerIds.length) {
    await client.query("DELETE FROM ai_module.customer_profiles WHERE customer_id = ANY($1::text[])", [customerIds]).catch(() => undefined);
    await client.query("DELETE FROM public.customer WHERE id = ANY($1::text[])", [customerIds]).catch(() => undefined);
  }
  if (categoryIds.length) await client.query("DELETE FROM public.product_category WHERE id = ANY($1::text[])", [categoryIds]).catch(() => undefined);
  await client.query("DELETE FROM app.merchants WHERE id = $1", [merchantB.merchantId]).catch(() => undefined);
  client.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("legacy mutation services enforce the route's authorized target", () => {
  it("rejects merchant A catalog updates against a merchant B category before updating it", async () => {
    const created = await createProductCategory(
      { "idempotency-key": `db-test:${runId}:category-b` },
      { name: `Merchant B category ${runId}` },
      actor,
      merchantB,
    );
    const categoryId = created.response.product_category.id;
    categoryIds.push(categoryId);

    await expect(updateProductCategory(
      { "idempotency-key": `db-test:${runId}:category-a-update` },
      categoryId,
      { name: "forbidden rename" },
      actor,
      merchantA,
    )).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });

    const row = await client.query("SELECT name FROM public.product_category WHERE id = $1", [categoryId]);
    expect(row.rows[0]?.name).toBe(`Merchant B category ${runId}`);
  });

  it("rejects a cross-merchant customer merge without deleting either customer", async () => {
    const customerA = await createCustomer(
      { "idempotency-key": `db-test:${runId}:customer-a` },
      { phone: `090${runId.slice(-7)}`, first_name: "Merchant A" },
      actor,
      merchantA,
    );
    const customerB = await createCustomer(
      { "idempotency-key": `db-test:${runId}:customer-b` },
      { phone: `091${runId.slice(-7)}`, first_name: "Merchant B" },
      actor,
      merchantB,
    );
    customerIds.push(customerA.response.customer.id, customerB.response.customer.id);

    await expect(mergeCustomers(
      { "idempotency-key": `db-test:${runId}:cross-merchant-merge` },
      { primaryId: customerA.response.customer.id, duplicateId: customerB.response.customer.id },
      actor,
      merchantA,
    )).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });

    const rows = await client.query("SELECT id, deleted_at FROM public.customer WHERE id = ANY($1::text[])", [customerIds]);
    expect(rows.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: customerA.response.customer.id, deleted_at: null }),
      expect.objectContaining({ id: customerB.response.customer.id, deleted_at: null }),
    ]));
  });

  it("updates and soft-deletes a customer without removing historical orders", async () => {
    const created = await createCustomer(
      { "idempotency-key": `db-test:${runId}:customer-delete-create` },
      { phone: `092${runId.slice(-7)}`, first_name: "Delete", last_name: "Before" },
      actor,
      merchantA,
    );
    const customerId = String(created.response.customer.id);
    customerIds.push(customerId);

    const updated = await updateCustomer(
      { "idempotency-key": `db-test:${runId}:customer-delete-update` },
      customerId,
      { phone: `093${runId.slice(-7)}`, first_name: "Delete", last_name: "After", email: "delete-test@example.local" },
      actor,
      merchantA,
    );
    expect(updated.statusCode).toBe(200);
    expect(updated.response.customer).toMatchObject({
      id: customerId,
      phone: `093${runId.slice(-7)}`,
      first_name: "Delete",
      last_name: "After",
      email: "delete-test@example.local",
    });

    const orderId = `order_customer_delete_${runId.replace(/[^a-zA-Z0-9]/g, "_")}`;
    orderIds.push(orderId);
    await client.query(`
      INSERT INTO public."order" (id, customer_id, status, currency_code, metadata, merchant_id, store_id)
      VALUES ($1, $2, 'completed', 'vnd', '{}'::jsonb, $3, $4)
    `, [orderId, customerId, merchantA.merchantId, storeA.storeId]);

    const deleted = await deleteCustomer(
      { "idempotency-key": `db-test:${runId}:customer-delete` },
      customerId,
      actor,
      merchantA,
    );
    expect(deleted.statusCode).toBe(200);
    expect(deleted.response).toEqual({ deleted: true, id: customerId });

    const customerRow = await client.query("SELECT id, deleted_at FROM public.customer WHERE id = $1", [customerId]);
    expect(customerRow.rows[0]?.deleted_at).toBeTruthy();
    const listed = await listCustomers({ merchantId: merchantA.merchantId, q: `093${runId.slice(-7)}` });
    expect(listed.customers.some((customer) => customer.id === customerId)).toBe(false);
    const orderRow = await client.query("SELECT customer_id FROM public.\"order\" WHERE id = $1", [orderId]);
    expect(orderRow.rows[0]?.customer_id).toBe(customerId);
  });

  it("rejects cross-merchant customer delete before mutating the customer", async () => {
    const created = await createCustomer(
      { "idempotency-key": `db-test:${runId}:customer-b-delete-create` },
      { phone: `094${runId.slice(-7)}`, first_name: "Merchant B Delete" },
      actor,
      merchantB,
    );
    const customerId = String(created.response.customer.id);
    customerIds.push(customerId);

    await expect(deleteCustomer(
      { "idempotency-key": `db-test:${runId}:customer-b-delete-forbidden` },
      customerId,
      actor,
      merchantA,
    )).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });

    const row = await client.query("SELECT deleted_at FROM public.customer WHERE id = $1", [customerId]);
    expect(row.rows[0]?.deleted_at).toBe(null);
  });

  it("rejects a wrong-store journal post before changing the draft", async () => {
    const created = await createJournalEntry(
      { "idempotency-key": `db-test:${runId}:journal-create` },
      {
        entryDate: "2026-06-21",
        description: `Scoped journal ${runId}`,
        lines: [
          { accountCode: "1111", debitAmount: 1000, creditAmount: 0 },
          { accountCode: "4111", debitAmount: 0, creditAmount: 1000 },
        ],
      },
      actor,
      storeA,
    );
    const journalId = String(created.response.data.id);
    journalIds.push(journalId);
    await client.query("UPDATE accounting.journal_entries SET store_id = 'store_other' WHERE id = $1", [journalId]);

    await expect(postJournalEntry(
      { "idempotency-key": `db-test:${runId}:journal-post-other-store` },
      journalId,
      actor,
      storeA,
    )).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });

    const entry = await client.query("SELECT status FROM accounting.journal_entries WHERE id = $1", [journalId]);
    expect(entry.rows[0]?.status).toBe("draft");
  });
});
