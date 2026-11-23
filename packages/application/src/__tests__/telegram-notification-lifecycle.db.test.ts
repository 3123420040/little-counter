import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { shutdownPlatformPool } from "../db/client";
import {
  createTelegramNotificationRecipient as createRecipient,
  updateTelegramNotificationRecipient as updateRecipient,
  createTelegramNotificationRule as createRule,
  updateTelegramNotificationRule as updateRule,
  sendTelegramNotificationRecipientTest as enqueueTest,
} from "../services/telegram-notification-settings-service";

let pool: Pool, db: PoolClient, blocker: PoolClient | undefined;
let merchantId: string, foreignId: string, storeId: string, foreignStoreId: string, locationId: string, foreignLocationId: string;
let recipientId: string, foreignRecipientId: string, ruleId: string;
const actor = { operatorId: "synthetic-notification-lifecycle", role: "owner" as const, organizationId: "synthetic-notification-org" };
const scope = () => ({ scopeKind: "merchant_target" as const, merchantId });
const recipientInput = () => ({ storeId, telegramUserId: `synthetic-${randomUUID()}`, displayName: "Synthetic recipient", recipientKind: "custom" as const });
const ruleInput = () => ({ storeId, recipientId, name: "Synthetic rule", enabled: false, eventScope: "synthetic", eventTypes: ["synthetic.noop"] });

beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString });
  db = await pool.connect();
  await assertSafeTestDatabaseSentinel(db, target);
});
beforeEach(async () => {
  vi.stubEnv("PLATFORM_RUNTIME_SCHEMA_BOOTSTRAP_ENABLED", "false");
  const key = randomUUID();
  merchantId = `notify-lifecycle-${key}`; foreignId = `${merchantId}-foreign`;
  storeId = `${merchantId}-store`; foreignStoreId = `${foreignId}-store`;
  locationId = `${merchantId}-location`; foreignLocationId = `${foreignId}-location`;
  recipientId = randomUUID(); foreignRecipientId = randomUUID(); ruleId = randomUUID();
  await db.query("INSERT INTO app.merchants(id,display_name,legacy_organization_id,status) VALUES($1,'Synthetic target',$1,'active'),($2,'Synthetic foreign',$2,'active')", [merchantId, foreignId]);
  await db.query("INSERT INTO public.stock_location(id,name) VALUES($1,'Synthetic target'),($2,'Synthetic foreign')", [locationId, foreignLocationId]);
  await db.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,status) VALUES($1,$2,'Synthetic target',$3,'active'),($4,$5,'Synthetic foreign',$6,'active')", [storeId, merchantId, locationId, foreignStoreId, foreignId, foreignLocationId]);
  await db.query(`INSERT INTO notification.telegram_recipients(id,merchant_id,store_id,telegram_user_id,telegram_chat_id,display_name,recipient_kind,status,created_by)
    VALUES($1,$2,$3,'synthetic-target','synthetic-target','Synthetic target','custom','active',$7),($4,$5,$6,'synthetic-foreign','synthetic-foreign','Synthetic foreign','custom','active',$7)`, [recipientId, merchantId, storeId, foreignRecipientId, foreignId, foreignStoreId, actor.operatorId]);
  await db.query(`INSERT INTO notification.telegram_notification_rules(id,merchant_id,store_id,recipient_id,name,enabled,event_scope,channel_filter,event_types,template_profile,created_by)
    VALUES($1,$2,$3,$4,'Synthetic rule',false,'synthetic','all',ARRAY['synthetic.noop'],'default',$5)`, [ruleId, merchantId, storeId, recipientId, actor.operatorId]);
});
afterEach(async () => {
  try {
    if (blocker) { await blocker.query("ROLLBACK"); blocker.release(); blocker = undefined; }
    await db.query("BEGIN");
    for (const table of ["notification.telegram_notifications", "notification.telegram_notification_rules", "notification.telegram_recipients", "audit.events"]) {
      await db.query(`DELETE FROM ${table} WHERE merchant_id=ANY($1::text[])`, [[merchantId, foreignId]]);
    }
    await db.query("DELETE FROM app.stores WHERE merchant_id=ANY($1::text[])", [[merchantId, foreignId]]);
    await db.query("DELETE FROM public.stock_location WHERE id=ANY($1::text[])", [[locationId, foreignLocationId]]);
    await db.query("DELETE FROM app.merchants WHERE id=ANY($1::text[])", [[merchantId, foreignId]]);
    await db.query("COMMIT");
  } finally { vi.unstubAllEnvs(); }
});
afterAll(async () => { db?.release(); await pool?.end(); await shutdownPlatformPool(); });

async function effects() {
  const result: Record<string, unknown> = {};
  for (const table of ["notification.telegram_notifications", "notification.telegram_notification_rules", "notification.telegram_recipients", "audit.events"]) {
    result[table] = (await db.query(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text) digest FROM ${table} t`)).rows;
  }
  return result;
}
async function suspend(kind: string) {
  if (kind !== "store") await db.query("UPDATE app.merchants SET status='suspended' WHERE id=$1", [merchantId]);
  if (kind !== "merchant") await db.query("UPDATE app.stores SET status='suspended' WHERE id=$1", [storeId]);
}
const writers = [
  ["create recipient", () => createRecipient(merchantId, recipientInput(), actor, scope())],
  ["update recipient", () => updateRecipient(merchantId, recipientId, { displayName: "Changed" }, actor, scope())],
  ["detach recipient", () => updateRecipient(merchantId, recipientId, { storeId: null }, actor, scope())],
  ["create rule", () => createRule(merchantId, ruleInput(), actor, scope())],
  ["merchant rule referencing store recipient", () => createRule(merchantId, { ...ruleInput(), storeId: null }, actor, scope())],
  ["update rule", () => updateRule(merchantId, ruleId, { name: "Changed" }, actor, scope())],
  ["detach rule", () => updateRule(merchantId, ruleId, { storeId: null }, actor, scope())],
  ["enqueue test", () => enqueueTest(merchantId, recipientId, actor, scope())],
] as const;

describe("notification settings transactional lifecycle admission", () => {
  for (const kind of ["store", "merchant", "both"]) {
    it.each(writers)(`${kind} suspension blocks %s without effects`, async (_name, write) => {
      await suspend(kind);
      const before = await effects();
      await expect(write()).rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
      expect(await effects()).toEqual(before);
    });
  }
  it("checks merchant-only writes and keeps foreign-active settings usable", async () => {
    await suspend("merchant");
    await expect(createRecipient(merchantId, { ...recipientInput(), storeId: null }, actor, scope()))
      .rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
    const foreign = { scopeKind: "merchant_target" as const, merchantId: foreignId };
    const created = await createRecipient(foreignId, { ...recipientInput(), storeId: foreignStoreId }, actor, foreign);
    await updateRecipient(foreignId, created.data.id, { displayName: "Updated foreign" }, actor, foreign);
    const rule = await createRule(foreignId, { ...ruleInput(), storeId: foreignStoreId, recipientId: created.data.id }, actor, foreign);
    await updateRule(foreignId, rule.data.id, { name: "Updated foreign" }, actor, foreign);
    expect((await enqueueTest(foreignId, created.data.id, actor, foreign)).data.queued).toBe(true);
    expect((await db.query("SELECT merchant_id,status,attempts,sent_at FROM notification.telegram_notifications WHERE merchant_id=ANY($1::text[])", [[merchantId, foreignId]])).rows)
      .toEqual([{ merchant_id: foreignId, status: "pending", attempts: 0, sent_at: null }]);
  });
  it("cannot detach a merchant-wide rule from a suspended recipient store", async () => {
    const replacement = await createRecipient(merchantId, { ...recipientInput(), storeId: null }, actor, scope());
    await db.query("UPDATE notification.telegram_notification_rules SET store_id=NULL WHERE id=$1", [ruleId]);
    await suspend("store");
    const before = await effects();
    await expect(updateRule(merchantId, ruleId, { recipientId: replacement.data.id }, actor, scope()))
      .rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
    expect(await effects()).toEqual(before);
  });
  it("cannot select a suspended recipient store for an existing merchant-wide rule", async () => {
    const original = await createRecipient(merchantId, { ...recipientInput(), storeId: null }, actor, scope());
    await db.query("UPDATE notification.telegram_notification_rules SET store_id=NULL,recipient_id=$2 WHERE id=$1", [ruleId, original.data.id]);
    await suspend("store");
    const before = await effects();
    await expect(updateRule(merchantId, ruleId, { recipientId }, actor, scope()))
      .rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
    expect(await effects()).toEqual(before);
  });
  it("cannot move merchant-wide recipient or rule settings into a suspended store", async () => {
    await db.query("UPDATE notification.telegram_notification_rules SET store_id=NULL WHERE id=$1", [ruleId]);
    await db.query("UPDATE notification.telegram_recipients SET store_id=NULL WHERE id=$1", [recipientId]);
    await suspend("store");
    const before = await effects();
    await expect(updateRecipient(merchantId, recipientId, { storeId }, actor, scope()))
      .rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
    await expect(updateRule(merchantId, ruleId, { storeId }, actor, scope()))
      .rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
    expect(await effects()).toEqual(before);
  });
  it("waits for an in-flight store suspension and rejects after its commit", async () => {
    blocker = await pool.connect();
    await blocker.query("BEGIN");
    const blockerPid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await blocker.query("SELECT id FROM app.merchants WHERE id=$1 FOR SHARE", [merchantId]);
    await blocker.query("UPDATE app.stores SET status='suspended' WHERE id=$1", [storeId]);
    const before = await effects();
    let settled = false;
    const pending = enqueueTest(merchantId, recipientId, actor, scope()).then(
      value => ({ value, error: undefined }), error => ({ value: undefined, error }),
    ).finally(() => { settled = true; });
    let blocked = false;
    try {
      const deadline = Date.now() + 3000;
      while (!settled && Date.now() < deadline) {
        blocked = (await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) blocked", [blockerPid])).rows[0].blocked;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { await blocker.query("COMMIT"); }
    const result = await pending;
    expect(blocked).toBe(true);
    expect(result.error).toMatchObject({ code: "scope_suspended", statusCode: 403 });
    expect(await effects()).toEqual(before);
  });
});
