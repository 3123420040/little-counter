import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { shutdownPlatformPool } from "../db/client";
import { recordCrossSellAcceptance } from "../services/recommendation-service";

let pool: Pool, db: PoolClient, blocker: PoolClient | undefined;
let merchantId: string, foreignId: string, storeId: string, foreignStoreId: string, locationId: string, foreignLocationId: string;
let actor: { operatorId: string; role: "owner"; organizationId: string };
const input = () => ({ merchantId, storeId, acceptedVariantId: "synthetic-variant", acceptedProductId: "synthetic-product", cartVariantIds: ["synthetic-cart-variant"], source: "pos", metadata: { reason: "Synthetic lifecycle test" } });

beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString });
  db = await pool.connect();
  await assertSafeTestDatabaseSentinel(db, target);
});
beforeEach(async () => {
  vi.stubEnv("PLATFORM_RUNTIME_SCHEMA_BOOTSTRAP_ENABLED", "false");
  vi.stubEnv("APP_PACKAGE_KEY", "ai_fan");
  const key = randomUUID();
  merchantId = `recommendation-lifecycle-${key}`; foreignId = `${merchantId}-foreign`;
  storeId = `${merchantId}-store`; foreignStoreId = `${foreignId}-store`;
  locationId = `${merchantId}-location`; foreignLocationId = `${foreignId}-location`;
  actor = { operatorId: `${merchantId}-owner`, role: "owner", organizationId: merchantId };
  await db.query("INSERT INTO app.merchants(id,display_name,legacy_organization_id,status) VALUES($1,'Synthetic target',$1,'active'),($2,'Synthetic foreign',$2,'active')", [merchantId, foreignId]);
  await db.query("INSERT INTO public.stock_location(id,name) VALUES($1,'Synthetic target'),($2,'Synthetic foreign')", [locationId, foreignLocationId]);
  await db.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,status) VALUES($1,$2,'Synthetic target',$3,'active'),($4,$5,'Synthetic foreign',$6,'active')", [storeId, merchantId, locationId, foreignStoreId, foreignId, foreignLocationId]);
});
afterEach(async () => {
  try {
    if (blocker) { await blocker.query("ROLLBACK"); blocker.release(); blocker = undefined; }
    await db.query("BEGIN");
    await db.query("DELETE FROM ai_module.cross_sell_events WHERE created_by=$1 AND merchant_id=ANY($2::text[])", [actor.operatorId, [merchantId, foreignId, `${merchantId}-missing`]]);
    await db.query("DELETE FROM app.stores WHERE merchant_id=ANY($1::text[])", [[merchantId, foreignId]]);
    await db.query("DELETE FROM public.stock_location WHERE id=ANY($1::text[])", [[locationId, foreignLocationId]]);
    await db.query("DELETE FROM app.merchants WHERE id=ANY($1::text[])", [[merchantId, foreignId]]);
    await db.query("COMMIT");
  } finally { vi.unstubAllEnvs(); }
});
afterAll(async () => { db?.release(); await pool?.end(); await shutdownPlatformPool(); });

async function effects() {
  return (await db.query("SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text) digest FROM ai_module.cross_sell_events t")).rows;
}
async function suspend(kind: string) {
  if (kind !== "store") await db.query("UPDATE app.merchants SET status='suspended' WHERE id=$1", [merchantId]);
  if (kind !== "merchant") await db.query("UPDATE app.stores SET status='suspended' WHERE id=$1", [storeId]);
}

describe("cross-sell acceptance transactional lifecycle admission", () => {
  it("records an active acceptance with its original payload", async () => {
    const accepted = await recordCrossSellAcceptance(input(), actor);
    expect(accepted.data.recorded).toBe(true);
    expect((await db.query("SELECT merchant_id,store_id,event_type,accepted_variant_id,accepted_product_id,cart_variant_ids,source,metadata,created_by FROM ai_module.cross_sell_events WHERE merchant_id=$1", [merchantId])).rows).toEqual([{
      merchant_id: merchantId, store_id: storeId, event_type: "accepted", accepted_variant_id: "synthetic-variant", accepted_product_id: "synthetic-product", cart_variant_ids: ["synthetic-cart-variant"], source: "pos", metadata: input().metadata, created_by: actor.operatorId,
    }]);
  });
  it.each(["store", "merchant", "both"])("%s suspension blocks retries while foreign-active acceptance remains available", async kind => {
    await suspend(kind);
    const before = await effects();
    for (let retry = 0; retry < 2; retry++) {
      await expect(recordCrossSellAcceptance(input(), actor)).rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
      expect(await effects()).toEqual(before);
    }
    const foreign = await recordCrossSellAcceptance({ ...input(), merchantId: foreignId, storeId: foreignStoreId }, actor);
    expect(foreign.data.recorded).toBe(true);
    expect((await db.query("SELECT merchant_id,store_id FROM ai_module.cross_sell_events WHERE created_by=$1", [actor.operatorId])).rows)
      .toEqual([{ merchant_id: foreignId, store_id: foreignStoreId }]);
  });
  it("rejects a store belonging to another merchant without recording telemetry", async () => {
    const before = await effects();
    await expect(recordCrossSellAcceptance({ ...input(), storeId: foreignStoreId }, actor)).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
    expect(await effects()).toEqual(before);
  });
  it("rejects an unknown merchant without recording telemetry", async () => {
    const before = await effects();
    await expect(recordCrossSellAcceptance({ ...input(), merchantId: `${merchantId}-missing` }, actor)).rejects.toMatchObject({ code: "resource_not_found", statusCode: 404 });
    expect(await effects()).toEqual(before);
  });
  it.each(["merchantId", "storeId", "acceptedVariantId"] as const)("preserves the no-write response for missing %s", async field => {
    const before = await effects();
    expect(await recordCrossSellAcceptance({ ...input(), [field]: "" }, actor)).toEqual({ data: { recorded: false, reason: field === "acceptedVariantId" ? "missing_accepted_variant_id" : "missing_operating_scope" } });
    expect(await effects()).toEqual(before);
  });
  for (const kind of ["store", "merchant"]) for (const outcome of ["COMMIT", "ROLLBACK"]) {
    it(`waits for in-flight ${kind} suspension and handles ${outcome.toLowerCase()} atomically`, async () => {
      blocker = await pool.connect(); await blocker.query("BEGIN");
      const blockerPid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      if (kind === "store") {
        await blocker.query("SELECT id FROM app.merchants WHERE id=$1 FOR SHARE", [merchantId]);
        await blocker.query("UPDATE app.stores SET status='suspended' WHERE id=$1", [storeId]);
      } else await blocker.query("UPDATE app.merchants SET status='suspended' WHERE id=$1", [merchantId]);
      const before = await effects();
      let settled = false;
      const pending = recordCrossSellAcceptance(input(), actor).then(
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
      } finally { await blocker.query(outcome); }
      const result = await pending;
      expect(blocked).toBe(true);
      if (outcome === "COMMIT") {
        expect(result.error).toMatchObject({ code: "scope_suspended", statusCode: 403 });
        expect(await effects()).toEqual(before);
      } else {
        expect(result.error).toBeUndefined(); expect(result.value?.data.recorded).toBe(true);
        expect((await db.query("SELECT count(*)::int n FROM ai_module.cross_sell_events WHERE merchant_id=$1", [merchantId])).rows[0].n).toBe(1);
      }
    });
  }
});
