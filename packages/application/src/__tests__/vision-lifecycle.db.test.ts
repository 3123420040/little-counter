import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { shutdownPlatformPool } from "../db/client";
import { recordVisionScanCorrection, scanVisionProducts, type VisionScanResult } from "../services/vision-scan-service";
import { resolvePackageEntitlements } from "../services/feature-entitlement-service";
import { resolveProductScan } from "../services/product-qr-service";
import { withConnectedTransaction } from "../db/transaction";

let pool: Pool, db: PoolClient, blocker: PoolClient | undefined, server: Server, baseUrl: string;
let merchantId: string, foreignId: string, storeId: string, foreignStoreId: string, locationId: string, foreignLocationId: string;
let catalogId: string, basicCatalogId: string, seed: VisionScanResult, foreignSeed: VisionScanResult;
let providerMode: "duplicate" | "hold" = "duplicate", releaseProvider: (() => void) | undefined, providerEntered: (() => void) | undefined;
const pendingJobs = new Set<Promise<unknown>>();
const scope = (foreign = false) => ({ scopeKind: "operating" as const, merchantId: foreign ? foreignId : merchantId, storeId: foreign ? foreignStoreId : storeId, stockLocationId: foreign ? foreignLocationId : locationId });
const actor = () => ({ operatorId: `${merchantId}-owner`, type: "staff", role: "owner" });
const image = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0x43]).toString("base64")}`;
const scan = (foreign = false) => scanVisionProducts({ imageHash: "synthetic-lifecycle", clientScanId: randomUUID() }, scope(foreign), actor());
const correct = (foreign = false) => {
  const target = foreign ? foreignSeed : seed;
  return recordVisionScanCorrection(target.data.scanId, { detectionId: target.data.detections[0].detectionId, correctionType: "staff_rejected", metadata: { fixture: "synthetic-lifecycle" } }, scope(foreign), actor());
};
function settle<T>(job: Promise<T>) {
  const result = job.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  pendingJobs.add(result); void result.finally(() => pendingJobs.delete(result)); return result;
}
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString }); db = await pool.connect();
  await assertSafeTestDatabaseSentinel(db, target);
  const catalogs = (await db.query("SELECT id,package_key,feature_keys FROM app.package_catalog_versions ORDER BY effective_from DESC")).rows;
  const ai = catalogs.find(x => x.package_key === "ai_fan");
  expect(ai.feature_keys).toEqual(expect.arrayContaining(["vision_pos_input", "vision_pos_single_capture", "vision_correction_report"]));
  catalogId = ai.id; basicCatalogId = catalogs.find(x => x.package_key === "basic").id;
  server = createServer((req, res) => {
    req.resume();
    const respond = () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: { detections: providerMode === "duplicate" ? [{ objectId: "duplicate", bbox: {} }, { objectId: "duplicate", bbox: {} }] : [], candidates: [] } })); };
    if (providerMode === "hold") { releaseProvider = respond; providerEntered?.(); } else respond();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing local provider address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  for (const [key, value] of Object.entries({ PLATFORM_RUNTIME_SCHEMA_BOOTSTRAP_ENABLED: "false", APP_PACKAGE_KEY: "basic", VISION_FEATURE_ENABLED: "true", VISION_KILL_SWITCH: "false", VISION_PROVIDER: "noop", VISION_POS_SINGLE_CAPTURE_ENABLED: "true", VISION_RAW_IMAGE_STORAGE_ENABLED: "false", VISION_DEBUG_IMAGE_STORAGE: "false", VISION_LEARNING_ENABLED: "false", VISION_SCAN_RATE_LIMIT_PER_OPERATOR: "100", VISION_AI_BASE_URL: baseUrl, VISION_SCAN_TIMEOUT_MS: "4500" })) vi.stubEnv(key, value);
  const key = randomUUID(); merchantId = `vision-lifecycle-${key}`; foreignId = `${merchantId}-foreign`;
  storeId = `${merchantId}-store`; foreignStoreId = `${foreignId}-store`; locationId = `${merchantId}-location`; foreignLocationId = `${foreignId}-location`;
  await db.query("INSERT INTO app.merchants(id,display_name,legacy_organization_id,status) VALUES($1,'Synthetic target',$1,'active'),($2,'Synthetic foreign',$2,'active')", [merchantId, foreignId]);
  await db.query("INSERT INTO public.stock_location(id,name) VALUES($1,'Synthetic target'),($2,'Synthetic foreign')", [locationId, foreignLocationId]);
  await db.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,status,is_primary) VALUES($1,$2,'Synthetic target',$3,'active',true),($4,$5,'Synthetic foreign',$6,'active',true)", [storeId, merchantId, locationId, foreignStoreId, foreignId, foreignLocationId]);
  await db.query("INSERT INTO app.merchant_subscriptions(id,merchant_id,package_key,catalog_version_id,status,current_period_start,current_period_end,grace_ends_at,primary_store_id,metadata) VALUES($1,$1,'ai_fan',$5,'active',now(),now()+interval '1 year',now()+interval '1 year 7 days',$3,'{\"source\":\"synthetic_db_test\"}'),($2,$2,'ai_fan',$5,'active',now(),now()+interval '1 year',now()+interval '1 year 7 days',$4,'{\"source\":\"synthetic_db_test\"}')", [merchantId, foreignId, storeId, foreignStoreId, catalogId]);
  expect(await resolvePackageEntitlements({ merchantId })).toMatchObject({ packageKey: "ai_fan", subscriptionStatus: "active", features: expect.arrayContaining(["vision_pos_input", "vision_correction_report"]) });
  seed = await scan(); foreignSeed = await scan(true);
});
afterEach(async () => {
  releaseProvider?.(); releaseProvider = undefined; providerEntered = undefined;
  if (blocker) { await blocker.query("ROLLBACK"); blocker.release(); blocker = undefined; }
  await Promise.all(pendingJobs);
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM app.product_qr_scan_events WHERE merchant_id=ANY($1::text[])", [[merchantId, foreignId]]);
    await db.query("DELETE FROM app.vision_scan_events WHERE merchant_id=ANY($1::text[])", [[merchantId, foreignId]]);
    await db.query("DELETE FROM app.merchant_subscriptions WHERE merchant_id=ANY($1::text[])", [[merchantId, foreignId]]);
    await db.query("DELETE FROM app.stores WHERE merchant_id=ANY($1::text[])", [[merchantId, foreignId]]);
    await db.query("DELETE FROM public.stock_location WHERE id=ANY($1::text[])", [[locationId, foreignLocationId]]);
    await db.query("DELETE FROM app.merchants WHERE id=ANY($1::text[])", [[merchantId, foreignId]]);
    await db.query("COMMIT");
  } finally { vi.unstubAllEnvs(); }
});
afterAll(async () => { await new Promise<void>(resolve => server?.close(() => resolve())); db?.release(); await pool?.end(); await shutdownPlatformPool(); });
async function effects() {
  const rows = [];
  for (const table of ["app.vision_scan_events", "app.vision_scan_detections", "app.vision_scan_corrections", "app.vision_scan_image_artifacts", "app.product_qr_scan_events", "app.merchant_subscriptions"]) rows.push((await db.query(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text) digest FROM ${table} t`)).rows);
  return rows;
}
async function suspend(kind: string) {
  if (kind !== "store") await db.query("UPDATE app.merchants SET status='suspended' WHERE id=$1", [merchantId]);
  if (kind !== "merchant") await db.query("UPDATE app.stores SET status='suspended' WHERE id=$1", [storeId]);
}
async function blockedBackend(blockerPid: number, settled: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!settled() && Date.now() < deadline) {
    const row = (await db.query("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) LIMIT 1", [blockerPid])).rows[0];
    if (row) return Number(row.pid);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return null;
}
describe("Vision lifecycle transactions with real DB entitlements", () => {
  it("persists one scan and its detection with the DB AI package despite Basic env", async () => {
    const result = await scan(); expect(result.data.provider).toBe("noop"); expect(result.data.detections).toHaveLength(1);
    expect((await db.query("SELECT count(*)::int n FROM app.vision_scan_detections WHERE scan_event_id=$1", [result.data.scanId])).rows[0].n).toBe(1);
  });
  it("persists correction and updates the same detection", async () => {
    const result = await correct(); expect(result.data.scanId).toBe(seed.data.scanId);
    expect((await db.query("SELECT decision FROM app.vision_scan_detections WHERE id=$1", [seed.data.detections[0].detectionId])).rows[0].decision).toBe("rejected");
  });
  for (const operation of ["scan", "correction"]) {
    const invoke = (foreign = false) => operation === "scan" ? scan(foreign) : correct(foreign);
    it.each(["store", "merchant", "both"])(`${operation}: %s suspension denies retries and preserves foreign-active writes`, async kind => {
      await suspend(kind); const before = await effects();
      for (let retry = 0; retry < 2; retry++) { await expect(invoke()).rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 }); expect(await effects()).toEqual(before); }
      expect((await invoke(true)).data).toBeDefined();
    });
    it(`${operation}: rejects a store from another merchant`, async () => {
      const before = await effects(), badScope = { ...scope(), storeId: foreignStoreId };
      const result = operation === "scan" ? scanVisionProducts({ imageHash: "synthetic" }, badScope, actor()) : recordVisionScanCorrection(seed.data.scanId, { correctionType: "staff_rejected" }, badScope, actor());
      await expect(result).rejects.toMatchObject({ code: "forbidden", statusCode: 403 }); expect(await effects()).toEqual(before);
    });
    it(`${operation}: keeps DB Basic entitlement denial despite forced AI env`, async () => {
      await db.query("UPDATE app.merchant_subscriptions SET package_key='basic',catalog_version_id=$2 WHERE merchant_id=$1", [merchantId, basicCatalogId]); vi.stubEnv("APP_PACKAGE_KEY", "ai_fan"); const before = await effects();
      await expect(invoke()).rejects.toMatchObject({ code: "feature_not_entitled", statusCode: 403 }); expect(await effects()).toEqual(before);
    });
    for (const kind of ["store", "merchant"]) for (const outcome of ["COMMIT", "ROLLBACK"]) {
      it(`${operation}: waits for ${kind} suspension ${outcome.toLowerCase()}`, async () => {
        blocker = await pool.connect(); await blocker.query("BEGIN"); const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
        if (kind === "store") { await blocker.query("SELECT id FROM app.merchants WHERE id=$1 FOR SHARE", [merchantId]); await blocker.query("UPDATE app.stores SET status='suspended' WHERE id=$1", [storeId]); }
        else await blocker.query("UPDATE app.merchants SET status='suspended' WHERE id=$1", [merchantId]);
        const before = await effects(); let finished = false; const pending = settle(invoke()).finally(() => { finished = true; });
        let waiting: number | null = null; try { waiting = await blockedBackend(pid, () => finished); } finally { await blocker.query(outcome); }
        const result = await pending; expect(waiting).not.toBeNull();
        if (outcome === "COMMIT") { expect(result.error).toMatchObject({ code: "scope_suspended", statusCode: 403 }); expect(await effects()).toEqual(before); }
        else { expect(result.error).toBeUndefined(); expect(result.value?.data).toBeDefined(); }
      });
    }
  }
  it("rolls back event and first detection when the next provider detection fails", async () => {
    vi.stubEnv("VISION_PROVIDER", "google_product_search"); providerMode = "duplicate"; const before = await effects();
    await expect(scanVisionProducts({ imageBase64: image }, scope(), actor())).rejects.toMatchObject({ code: "23505" }); expect(await effects()).toEqual(before);
  });
  it("also rolls back QR analytics when the later Vision detection fails", async () => {
    vi.stubEnv("VISION_PROVIDER", "google_product_search"); providerMode = "duplicate"; const before = await effects();
    await expect(scanVisionProducts({ imageBase64: image, qrCodes: [merchantId + "-missing-code"] }, scope(), actor())).rejects.toMatchObject({ code: "23505" }); expect(await effects()).toEqual(before);
  });
  it("keeps a failed optional QR analytics insert from aborting its caller transaction", async () => {
    const before = await effects();
    await withConnectedTransaction(async client => {
      await expect(resolveProductScan({ code: merchantId + "-missing-code", context: "pos_add_to_cart" }, scope(), { ...actor(), operatorId: "\0" }, { client })).rejects.toMatchObject({ code: "resource_not_found", statusCode: 404 });
      expect((await client.query("SELECT 1 n")).rows[0].n).toBe(1);
    });
    expect(await effects()).toEqual(before);
  });
  it("records an unresolved QR only while active and never after suspension", async () => {
    const input = { imageHash: "synthetic-qr", qrCodes: [merchantId + "-missing-code"] };
    expect((await scanVisionProducts(input, scope(), actor())).data.scanId).toBeTruthy();
    expect((await db.query("SELECT count(*)::int n FROM app.product_qr_scan_events WHERE merchant_id=$1", [merchantId])).rows[0].n).toBe(1);
    await suspend("store"); const before = await effects();
    await expect(scanVisionProducts(input, scope(), actor())).rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 }); expect(await effects()).toEqual(before);
  });
  it("rolls back inserted correction if its detection update is cancelled", async () => {
    blocker = await pool.connect(); await blocker.query("BEGIN"); const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await blocker.query("SELECT id FROM app.vision_scan_detections WHERE id=$1 FOR NO KEY UPDATE", [seed.data.detections[0].detectionId]);
    const before = await effects(); let finished = false; const pending = settle(correct()).finally(() => { finished = true; });
    const waiting = await blockedBackend(pid, () => finished);
    try { expect(waiting).not.toBeNull(); const victim = (await db.query("SELECT query FROM pg_stat_activity WHERE pid=$1", [waiting])).rows[0]; expect(victim.query).toMatch(/UPDATE app\.vision_scan_detections/); await db.query("SELECT pg_cancel_backend($1)", [waiting]); }
    finally { await blocker.query("ROLLBACK"); }
    expect((await pending).error).toMatchObject({ code: "57014" }); expect(await effects()).toEqual(before);
  });
  it("serializes suspension after an admitted scan while the local provider is in flight", async () => {
    vi.stubEnv("VISION_PROVIDER", "google_product_search"); providerMode = "hold";
    const entered = new Promise<void>(resolve => { providerEntered = resolve; });
    const pending = settle(scanVisionProducts({ imageBase64: image }, scope(), actor())); await entered;
    blocker = await pool.connect(); const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    let finished = false; const suspension = settle(blocker.query("UPDATE app.stores SET status='suspended' WHERE id=$1", [storeId])).finally(() => { finished = true; });
    let blocked = false; const deadline = Date.now() + 3000;
    try { while (!finished && Date.now() < deadline) { blocked = (await db.query("SELECT cardinality(pg_blocking_pids($1))>0 blocked", [pid])).rows[0].blocked; if (blocked) break; await new Promise(resolve => setTimeout(resolve, 20)); } }
    finally { releaseProvider?.(); releaseProvider = undefined; }
    const result = await pending; await suspension; expect(blocked).toBe(true); expect(result.error).toBeUndefined(); expect(result.value?.data.scanId).toBeTruthy();
    const before = await effects(); await expect(scan()).rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 }); expect(await effects()).toEqual(before);
  });
});
