import { randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { permissions, type RequestAccess } from "@medusa-snus/contracts";
import { partnerScopes, type PartnerOrderRequest } from "@medusa-snus/contracts/partner-api";
import { requireSafeTestDatabaseTarget, assertSafeTestDatabaseSentinel } from "../db/test-database-target";
import { seedPartnerBookingFixture } from "./helpers/partner-booking-fixture";
import { createPartnerQuoteForClient } from "../partner/quotes";
import { bookPartnerOrderForClient } from "../partner/booking";
import { readPartnerIdentity, selectPartnerStore } from "../partner/registry";
import { readPartnerStaffContactForClient } from "../partner/staff-contact";
import { decryptPartnerContact } from "../partner/contact-crypto";
import { maintainPartnerRetentionForClient } from "../partner/maintenance";
import type { OperatorContext } from "../services/auth-service";

let pool: Pool; let db: PoolClient; let body: PartnerOrderRequest;
const keys = { current: "v1", keys: { v1: randomBytes(32).toString("base64url") } };
const contactKeys = { current: "contact-v1", keys: { "contact-v1": randomBytes(32).toString("base64url") } };
const token = { issuer: "https://pr.invalid", clientId: "reads", subject: "subject", scopes: partnerScopes, expiresAt: 9999999999 };
const scope = { scopeKind: "operating" as const, merchantId: "pr_m", storeId: "pr_s1", stockLocationId: "pr_l1" };
const contact = { mode: "delivery" as const, recipient_name: "SYNTHETIC_RECIPIENT", phone: "SYNTHETIC_PHONE", address: "SYNTHETIC_ADDRESS" };
function staff(merchantId = "pr_m", storeId = "pr_s1"): OperatorContext {
  const access: RequestAccess = { actorId: "pr_staff", legacyOrganizationId: "pr_org", isPlatformAdmin: false,
    permissionIds: [permissions.partnerContactRead], explicitPermissions: [], memberships: [{ membershipId: "pr_membership",
      operatorId: "pr_staff", scopeType: "store", merchantId, storeId, roleKey: "staff", status: "active", permissionIds: [permissions.partnerContactRead] }] };
  return { operatorId: "pr_staff", role: "staff", organizationId: "pr_org", displayName: "Synthetic", access };
}
async function context(required: "orders:quote" | "orders:write" = "orders:write") {
  const identity = await readPartnerIdentity(db, token, "sandbox", "req_delivery", "e".repeat(32));
  const ctx = selectPartnerStore(identity, "pr_s1", required, true);
  await db.query("SELECT integration.lock_authorization($1,$2,$3)", [ctx.integrationId, ctx.registryClientId, ctx.storeId]);
  return ctx;
}
async function book() {
  return bookPartnerOrderForClient(db, await context(), keys, body, "delivery-booking-key-0001", contactKeys);
}
async function coreId(orderId: string) {
  return (await db.query("SELECT core_order_id FROM integration.partner_orders WHERE id=$1", [orderId])).rows[0].core_order_id as string;
}
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString }); db = await pool.connect(); await assertSafeTestDatabaseSentinel(db, target);
});
beforeEach(async () => {
  await db.query("BEGIN"); await seedPartnerBookingFixture(db, "pr");
  await db.query(`INSERT INTO integration.policies SELECT (jsonb_populate_record(NULL::integration.policies,
    to_jsonb(p)||'{"version":2,"delivery_fee":30000}'::jsonb)).* FROM integration.policies p WHERE id='pr_policy';
    UPDATE integration.integrations SET policy_version=2 WHERE id='pr_i'`);
  const quote = await createPartnerQuoteForClient(db, await context("orders:quote"), keys,
    { store_id: "pr_s1", items: [{ variant_id: "pr_v1", quantity: 2 }], fulfillment_mode: "delivery" }, true);
  expect(quote.data).toMatchObject({ shipping_fee: 30000, total: 530000 });
  body = { store_id: "pr_s1", quote_id: quote.data.quote_id, external_order_id: "synthetic-delivery", payment_method: "cod", fulfillment: contact };
});
afterEach(async () => { await db.query("ROLLBACK"); });
afterAll(async () => { db?.release(); await pool?.end(); });

describe("S5 encrypted delivery and audited staff fulfillment", () => {
  it("charges the positive delivery fee normally even when every unit price is zero", async () => {
    await db.query("UPDATE public.price SET amount=0 WHERE id='pr_price'");
    const quote=await createPartnerQuoteForClient(db,await context("orders:quote"),keys,
      {store_id:"pr_s1",items:[{variant_id:"pr_v1",quantity:2}],fulfillment_mode:"delivery"},true);
    expect(quote.data).toMatchObject({total:30000,shipping_fee:30000});
    body={...body,quote_id:quote.data.quote_id};
    await db.query("SET LOCAL ROLE snus_partner_api");
    const receipt=await book();
    expect(receipt.body.data).toMatchObject({total:30000,collection_status:"unconfirmed"});
    await db.query("SET CONSTRAINTS ALL IMMEDIATE;RESET ROLE");
    const payments=await db.query("SELECT amount_minor FROM app.payment_events WHERE order_id=$1",[await coreId(receipt.body.data.order_id)]);
    expect(payments.rows).toEqual([{amount_minor:"30000"}]);
  });
  it("persists encrypted contact atomically while public data/audit/outbox stay free of contact", async () => {
    await db.query("SET LOCAL ROLE snus_partner_api"); const result = await book(); expect(result.body.data.total).toBe(530000);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE;RESET ROLE");
    const stored = (await db.query("SELECT * FROM integration.order_contacts WHERE partner_order_id=$1", [result.body.data.order_id])).rows[0];
    expect(stored.nonce).toHaveLength(12); expect(stored.auth_tag).toHaveLength(16);
    const output = JSON.stringify([result, (await db.query("SELECT * FROM audit.events WHERE merchant_id='pr_m'")).rows,
      (await db.query("SELECT * FROM outbox.events WHERE merchant_id='pr_m'")).rows,
      (await db.query("SELECT * FROM integration.idempotency_records WHERE integration_id='pr_i'")).rows, stored]);
    for (const value of [contact.recipient_name, contact.phone, contact.address]) expect(output).not.toContain(value);
    expect(decryptPartnerContact(contactKeys, { ...scope, orderId: result.body.data.order_id }, stored)).toEqual(contact);
  });
  it("gives scoped staff the delivery contact only with transactional read audit", async () => {
    const result = await book(); const core = await coreId(result.body.data.order_id);
    await db.query("SET LOCAL ROLE snus_partner_contacts");
    const response = await readPartnerStaffContactForClient(db, staff(), scope, core, contactKeys, "req_staff_contact");
    expect(response.data).toMatchObject(contact);
    await db.query("RESET ROLE");
    const audit = (await db.query("SELECT action,actor_id,store_id,after FROM audit.events WHERE request_id='req_staff_contact'")).rows[0];
    expect(audit).toEqual({ action: "partner.contact_read", actor_id: "pr_staff", store_id: "pr_s1", after: { purpose: "order_fulfillment" } });
  });
  it("does not combine another store's permission with the requested store", async () => {
    const result = await book(); const core = await coreId(result.body.data.order_id);
    await expect(readPartnerStaffContactForClient(db, staff("pr_m", "pr_s2"), scope, core, contactKeys, "req_wrong_scope"))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(readPartnerStaffContactForClient(db, staff(), scope, "unknown", contactKeys, "req_unknown"))
      .rejects.toMatchObject({ code: "resource_not_found" });
  });
  it("replays a safe delivery snapshot with delivery keys disabled",async()=>{
    const original=await book();
    const replay=await bookPartnerOrderForClient(db,await context(),keys,body,"delivery-booking-key-0001");
    expect(replay.status).toBe(200);expect(replay.body.data).toEqual(original.body.data);
  });
  it("denies public API SELECT on encrypted contacts", async () => {
    await book(); await db.query("SET LOCAL ROLE snus_partner_api");
    await expect(db.query("SELECT * FROM integration.order_contacts")).rejects.toMatchObject({ code: "42501" });
  });
  it("authenticates ciphertext against order/store and supports retained decryption keys", async () => {
    const result = await book(); const row = (await db.query("SELECT * FROM integration.order_contacts WHERE partner_order_id=$1", [result.body.data.order_id])).rows[0];
    const binding = { ...scope, orderId: result.body.data.order_id };
    for (const other of [{ ...binding, orderId: "po_other" }, { ...binding, storeId: "pr_s2" }, { ...binding, merchantId: "pr_other" }]) {
      expect(() => decryptPartnerContact(contactKeys, other, row)).toThrow();
    }
    const rotated = { current: "contact-v2", keys: { ...contactKeys.keys, "contact-v2": randomBytes(32).toString("base64url") } };
    expect(decryptPartnerContact(rotated, binding, row)).toEqual(contact);
    const corrupt = Buffer.from(row.ciphertext); corrupt[0] ^= 1;
    expect(() => decryptPartnerContact(rotated, binding, { ...row, ciphertext: corrupt })).toThrow();
  });
  it("fails closed without a contact key even when a shipping fee is configured", async () => {
    await expect(bookPartnerOrderForClient(db, await context(), keys, body, "delivery-booking-key-0001"))
      .rejects.toMatchObject({ code: "shipping_policy_unavailable" });
  });
  it("removes expired contact without removing order ownership or replay", async () => {
    const result = await book(); const core = await coreId(result.body.data.order_id);
    await db.query(`UPDATE integration.order_contacts SET created_at=now()-interval '31 days',retention_until=now()-interval '1 day'
      WHERE partner_order_id=$1`, [result.body.data.order_id]);
    await expect(readPartnerStaffContactForClient(db, staff(), scope, core, contactKeys, "req_expired"))
      .rejects.toMatchObject({ code: "partner_contact_unavailable" });
    await db.query("SET LOCAL ROLE snus_partner_maintenance");
    expect((await maintainPartnerRetentionForClient(db, 500)).contacts).toBeGreaterThanOrEqual(1);
    await db.query("RESET ROLE");
    expect((await book()).status).toBe(200);
    expect((await db.query("SELECT count(*) FROM integration.order_contacts WHERE partner_order_id=$1", [result.body.data.order_id])).rows[0].count).toBe("0");
  });
});
