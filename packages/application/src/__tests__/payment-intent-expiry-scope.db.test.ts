import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { shutdownPlatformPool } from "../db/client";

// Only transaction ownership changes: every service query runs in real PostgreSQL and rolls back.
const harness = vi.hoisted(() => ({ client: null as PoolClient | null }));
vi.mock("../db/transaction", async original => ({
  ...await original<typeof import("../db/transaction")>(),
  withConnectedTransaction: async (handler: (client: PoolClient) => Promise<unknown>) => handler(harness.client!),
}));
import { listPaymentIntents, type ListPaymentIntentsInput } from "../services/payment-intent-service";

let pool: Pool, db: PoolClient, prefix: string;
const id = (suffix: string) => `${prefix}_${suffix}`;
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString });
  db = await pool.connect(); harness.client = db;
  await assertSafeTestDatabaseSentinel(db, target);
});
beforeEach(async () => {
  vi.stubEnv("PLATFORM_RUNTIME_SCHEMA_BOOTSTRAP_ENABLED", "false");
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  prefix = `expiry${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await db.query(`
    INSERT INTO app.merchants(id,display_name,legacy_organization_id,status)
      VALUES ('fixture_m','Expiry target','fixture_org','active'),('fixture_foreign','Expiry foreign','fixture_other_org','active');
    INSERT INTO public.stock_location(id,name) VALUES ('fixture_l1','One'),('fixture_l2','Two'),('fixture_l3','Foreign');
    INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,status) VALUES
      ('fixture_s1','fixture_m','One','fixture_l1','active'),
      ('fixture_s2','fixture_m','Two','fixture_l2','active'),
      ('fixture_s3','fixture_foreign','Foreign','fixture_l3','active');
    INSERT INTO app.payment_intents(id,merchant_id,store_id,provider,status,amount,order_input,reference_code,expires_at,created_by,updated_at)
      VALUES
      ('fixture_due1','fixture_m','fixture_s1','mock','pending',240320,'{}','fixture_ref1',now()-interval '1 day','fixture_actor',now()-interval '2 days'),
      ('fixture_due2','fixture_m','fixture_s2','mock','pending',240320,'{}','fixture_ref2',now()-interval '1 day','fixture_actor',now()-interval '2 days'),
      ('fixture_foreign_due','fixture_foreign','fixture_s3','mock','pending',240320,'{}','fixture_ref3',now()-interval '1 day','fixture_actor',now()-interval '2 days'),
      ('fixture_future','fixture_m','fixture_s1','mock','pending',240320,'{}','fixture_ref4',now()+interval '1 day','fixture_actor',now()-interval '2 days'),
      ('fixture_paid','fixture_m','fixture_s1','mock','paid',240320,'{}','fixture_ref5',now()-interval '1 day','fixture_actor',now()-interval '2 days');
  `.replace(/\bfixture_/g, `${prefix}_`));
});
afterEach(async () => { try { await db?.query("ROLLBACK"); } finally { vi.unstubAllEnvs(); } });
afterAll(async () => { db?.release(); await pool?.end(); await shutdownPlatformPool(); });

async function rows() {
  return (await db.query("SELECT to_jsonb(t) row FROM app.payment_intents t ORDER BY id")).rows.map(x => x.row);
}

async function assertExpiry(input: ListPaymentIntentsInput, expectedSuffixes: string[]) {
  const before = await rows(), result = await listPaymentIntents(input), after = await rows();
  const changed = expectedSuffixes.map(id);
  expect(after).toHaveLength(before.length);
  for (const old of before) {
    const now = after.find(x => x.id === old.id);
    expect(now).toBeDefined();
    if (!changed.includes(old.id)) { expect(now).toEqual(old); continue; }
    expect(now).toEqual({ ...old, status: "expired", manual_review_reason: "payment_intent_expired", updated_at: now.updated_at });
    expect(new Date(now.updated_at).getTime()).toBeGreaterThan(new Date(old.updated_at).getTime());
  }
  expect(after.filter((row, index) => JSON.stringify(row) !== JSON.stringify(before[index])).map(x => x.id).sort()).toEqual(changed.sort());
  return result;
}

describe("payment-intent list expiry respects the requested report scope", () => {
  it("expires only the selected store while leaving another store and merchant intact", async () => {
    const result = await assertExpiry({ merchantId: id("m"), storeIds: [id("s1")] }, ["due1"]);
    expect(result.data.map(x => x.id).sort()).toEqual(["due1", "future", "paid"].map(id).sort());
  });
  it("supports the singular store scope", async () => {
    await assertExpiry({ merchantId: id("m"), storeId: id("s1") }, ["due1"]);
  });
  it("expires both explicitly selected stores without touching a foreign merchant", async () => {
    await assertExpiry({ merchantId: id("m"), storeIds: [id("s1"), id("s2")] }, ["due1", "due2"]);
  });
  it("retains merchant-wide service scope", async () => {
    await assertExpiry({ merchantId: id("m") }, ["due1", "due2"]);
  });
  it("retains singular-store service scope without broadening it", async () => {
    await assertExpiry({ storeId: id("s1") }, ["due1"]);
  });
  it("retains a store-set service scope without broadening it", async () => {
    await assertExpiry({ storeIds: [id("s1"), id("s2")] }, ["due1", "due2"]);
  });
  it("intersects merchant and a foreign store set without writes", async () => {
    expect((await assertExpiry({ merchantId: id("m"), storeIds: [id("s3")] }, [])).data).toEqual([]);
  });
  it("intersects singular and multiple store selectors without writes", async () => {
    expect((await assertExpiry({ merchantId: id("m"), storeId: id("s1"), storeIds: [id("s2")] }, [])).data).toEqual([]);
  });
  it("does not expire other intents for an unknown scope", async () => {
    expect((await assertExpiry({ merchantId: id("missing"), storeIds: [id("missing_store")] }, [])).count).toBe(0);
  });
  it("keeps existing in-scope expiry while reading the manual-review queue", async () => {
    expect((await assertExpiry({ merchantId: id("m"), storeIds: [id("s1")], status: "manual_review" }, ["due1"])).data).toEqual([]);
  });
  it("applies expiry before status filtering and pagination", async () => {
    const result = await assertExpiry({ merchantId: id("m"), storeIds: [id("s1"), id("s2")], status: "expired", limit: 1, offset: 1 }, ["due1", "due2"]);
    expect(result.count).toBe(2); expect(result.data).toHaveLength(1); expect(result.data[0].status).toBe("expired");
  });
  it("keeps provider filtering independent of the scope-bound expiry", async () => {
    expect((await assertExpiry({ merchantId: id("m"), storeIds: [id("s1")], provider: "sepay_va" }, ["due1"])).data).toEqual([]);
  });
});

