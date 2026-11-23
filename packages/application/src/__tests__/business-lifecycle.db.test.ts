import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPlatformClient, shutdownPlatformPool, type PoolClient } from "../db/client";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { lockActiveBusinessScopeForClient, lockActivePartnerBusinessScopeForClient, lockActivePartnerControlScopeForClient } from "../services/business-lifecycle-service";
import { createOrderForClient } from "../services/order-service";
import { startShift, updateShiftPolicy } from "../services/shift-service";
import { ensureProductQrIdentity } from "../services/product-qr-service";
import { createVisionReferenceImage, syncVisionReferenceImagesFromProductMetadata } from "../services/vision-catalog-service";
import { createPlatformStore, grantPlatformMembership, mutatePlatformIntegrationConfig } from "../services/platform-admin-service";
import { seedPartnerReadFixture } from "./helpers/partner-read-fixture";
import { ensurePlatformSchema } from "../db/schema";

const merchantId = `lifecycle-lock-${randomUUID()}`, storeId = `${merchantId}:store`;
const target = { scopeType: "store" as const, merchantId, storeId };
let writer: PoolClient, statusWriter: PoolClient;
beforeAll(async () => {
  writer = await connectPlatformClient();
  await assertSafeTestDatabaseSentinel(writer, requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL));
  const migration = readFileSync(new URL("../../../../db/migrations/070_business_lifecycle_versions.sql", import.meta.url), "utf8");
  const ledger = await writer.query("SELECT checksum FROM app.schema_migrations WHERE filename='070_business_lifecycle_versions.sql'");
  expect(ledger.rows).toEqual([{ checksum: createHash("sha256").update(migration).digest("hex") }]);
  statusWriter = await connectPlatformClient();
  await writer.query("INSERT INTO app.merchants(id,display_name,legacy_organization_id) VALUES($1,$1,$1)", [merchantId]);
  await writer.query("INSERT INTO public.stock_location(id,name) VALUES($1,$1)", [storeId]);
  await writer.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id) VALUES($1,$2,$1,$1)", [storeId, merchantId]);
});
afterAll(async () => {
  await writer?.query("ROLLBACK"); await statusWriter?.query("ROLLBACK");
  writer?.release(); statusWriter?.release(); await shutdownPlatformPool();
});

describe("ordinary writer lifecycle fence on PostgreSQL", () => {
  it("holds the implicit primary store lifecycle lock through the actual vision image INSERT", async () => {
    const prefix = `vi${randomUUID().replaceAll("-", "").slice(0, 12)}`, key = `vision_${prefix}`;
    const trigger = `vision_lifecycle_${prefix}`;
    let running: Promise<unknown> | undefined;
    await ensurePlatformSchema();
    await seedPartnerReadFixture(writer, prefix);
    await writer.query("UPDATE app.stores SET is_primary=true WHERE id=$1", [`${prefix}_s1`]);
    await writer.query("UPDATE public.product SET metadata=jsonb_build_object('imageUrl','https://example.com/uat.png') WHERE id=$1", [`${prefix}_product`]);
    await writer.query(`CREATE FUNCTION pg_temp.delay_vision_lifecycle_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.merchant_id=TG_ARGV[0] THEN PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[1],0)); END IF; RETURN NEW; END $$`);
    await writer.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON app.product_variant_images FOR EACH ROW
      EXECUTE FUNCTION pg_temp.delay_vision_lifecycle_insert('${prefix}_m','${key}')`);
    try {
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await writer.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
      running = syncVisionReferenceImagesFromProductMetadata({ merchantId: `${prefix}_m` });
      const deadline = Date.now() + 2_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        waiting = (await writer.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event='advisory') AS waiting", [pid])).rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect((await writer.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND position('WITH inserted AS (' in query)>0) AS command_insert", [pid])).rows[0].command_insert).toBe(true);
      await statusWriter.query("BEGIN; SET LOCAL lock_timeout='150ms'");
      await expect(statusWriter.query("UPDATE app.stores SET status='suspended' WHERE id=$1", [`${prefix}_s1`])).rejects.toMatchObject({ code: "55P03" });
      await statusWriter.query("ROLLBACK");
      await writer.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
      await expect(running).resolves.toMatchObject({ insertedCount: 3 });
      expect((await writer.query("SELECT DISTINCT store_id FROM app.product_variant_images WHERE merchant_id=$1", [`${prefix}_m`])).rows)
        .toEqual([{ store_id: `${prefix}_s1` }]);
    } finally {
      await statusWriter.query("ROLLBACK");
      await writer.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
      if (running) await running.catch(() => undefined);
      await writer.query(`DROP TRIGGER IF EXISTS ${trigger} ON app.product_variant_images`);
      await writer.query("UPDATE integration.integrations SET status='revoked',writes_enabled=false WHERE id=$1", [`${prefix}_i`]);
    }
  });
  it.each(["lock_active_control_scope", "lock_active_control_ready_store"])("keeps %s available only to its bounded execution role", async name => {
    const acl = await writer.query(`SELECT p.prosecdef,p.proconfig,
      EXISTS(SELECT 1 FROM aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute,
      has_function_privilege('snus_partner_control',p.oid,'EXECUTE') AS control_execute,
      has_function_privilege('snus_partner_api',p.oid,'EXECUTE') AS api_execute
      FROM pg_proc p WHERE p.oid=$1::regprocedure`, [`integration.${name}(text,text)`]);
    expect(acl.rows).toEqual([{ prosecdef: true, proconfig: ["search_path=pg_catalog"], public_execute: false, control_execute: true, api_execute: false }]);
    await writer.query("BEGIN");
    try {
      await writer.query("SET LOCAL ROLE snus_partner_control");
      expect((await writer.query("SELECT has_column_privilege(current_user,'app.merchants','status','UPDATE') AS allowed")).rows[0].allowed).toBe(false);
      await lockActivePartnerControlScopeForClient(writer, merchantId);
      await lockActivePartnerControlScopeForClient(writer, merchantId, storeId);
      await statusWriter.query("BEGIN; SET LOCAL lock_timeout='150ms'");
      await expect(statusWriter.query("UPDATE app.stores SET status='suspended' WHERE id=$1", [storeId])).rejects.toMatchObject({ code: "55P03" });
    } finally { await writer.query("ROLLBACK"); await statusWriter.query("ROLLBACK"); }
  });
  it.each(["merchant", "store"] as const)("denies inactive %s under the actual control execution role", async entity => {
    await writer.query("BEGIN");
    try {
      await writer.query(entity === "merchant" ? "UPDATE app.merchants SET status='suspended' WHERE id=$1"
        : "UPDATE app.stores SET status='suspended' WHERE id=$1", [entity === "merchant" ? merchantId : storeId]);
      await writer.query("SET LOCAL ROLE snus_partner_control");
      await expect(lockActivePartnerControlScopeForClient(writer, merchantId, storeId)).rejects.toMatchObject({ code: "scope_suspended" });
    } finally { await writer.query("ROLLBACK"); }
  });
  it.each(["merchant", "store"] as const)("denies platform issue/grant commands but preserves credential disable for an inactive %s", async entity => {
    const actor = { operatorId: "op_owner", organizationId: merchantId, role: "owner" as const };
    const config = { providerKey: "mock", purpose: "merchant_retail", scope: entity, merchantId,
      ...(entity === "store" ? { storeId } : {}) };
    const update = entity === "merchant" ? "UPDATE app.merchants SET status=$2 WHERE id=$1" : "UPDATE app.stores SET status=$2 WHERE id=$1";
    const entityId = entity === "merchant" ? merchantId : storeId;
    await mutatePlatformIntegrationConfig({ ...config, action: "set", secret: "disposable-uat-not-a-live-credential" }, actor);
    try {
      await writer.query(update, [entityId, "suspended"]);
      await expect(mutatePlatformIntegrationConfig({ ...config, action: "rotate", secret: "disposable-replacement" }, actor))
        .rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
      await expect(grantPlatformMembership({ operatorId: "op_owner", scopeType: entity, merchantId,
        ...(entity === "store" ? { storeId } : {}), roleKey: "manager" }, actor))
        .rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
      if (entity === "merchant") await expect(createPlatformStore({ merchantId, displayName: "Inactive merchant store" }, actor))
        .rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
      await expect(mutatePlatformIntegrationConfig({ ...config, action: "disable" }, actor)).resolves.toMatchObject({ data: { status: "inactive" } });
    } finally { await writer.query(update, [entityId, "active"]); }
  });
  it.each(["merchant", "store"] as const)("denies shift, QR and vision writers for a suspended %s before business writes", async entity => {
    const update = entity === "merchant" ? "UPDATE app.merchants SET status=$2 WHERE id=$1" : "UPDATE app.stores SET status=$2 WHERE id=$1";
    const entityId = entity === "merchant" ? merchantId : storeId;
    const scope = { scopeKind: "operating" as const, merchantId, storeId, stockLocationId: storeId };
    const actor = { operatorId: "op_owner", organizationId: merchantId, role: "owner" as const, displayName: "UAT" };
    try {
      await writer.query(update, [entityId, "suspended"]);
      for (const command of [
        () => updateShiftPolicy({ "idempotency-key": `${merchantId}:inactive-policy:${entity}` }, {}, actor, scope),
        () => startShift({ "idempotency-key": `${merchantId}:inactive-shift:${entity}` }, { openingCashAmount: { currencyCode: "vnd", amountVnd: "0" } }, actor, scope),
        () => ensureProductQrIdentity({ productId: "missing-product", scope }),
        () => syncVisionReferenceImagesFromProductMetadata({ merchantId, storeId }),
        () => createVisionReferenceImage({ merchantId, storeId, variantId: "missing-variant", imageUrl: "https://example.com/uat.png" }),
      ]) await expect(command()).rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
      expect((await writer.query("SELECT count(*)::int AS count FROM app.shift_policies WHERE merchant_id=$1", [merchantId])).rows[0].count).toBe(0);
    } finally { await writer.query(update, [entityId, "active"]); }
  });
  it("keeps the Partner lock SECURITY DEFINER bounded to its explicit execution role", async () => {
    const row = await writer.query(`SELECT p.prosecdef,p.proconfig,
      EXISTS(SELECT 1 FROM aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute,
      has_function_privilege('snus_partner_api',p.oid,'EXECUTE') AS partner_execute,
      has_function_privilege('snus_partner_control',p.oid,'EXECUTE') AS control_execute
      FROM pg_proc p WHERE p.oid='integration.lock_active_business_scope(text,text)'::regprocedure`);
    expect(row.rows).toEqual([{ prosecdef: true, proconfig: ["search_path=pg_catalog"],
      public_execute: false, partner_execute: true, control_execute: false }]);
  });
  it.each(["merchant", "store"] as const)("denies an inactive %s under the actual Partner role", async entity => {
    await writer.query("BEGIN");
    try {
      await writer.query(entity === "merchant" ? "UPDATE app.merchants SET status='suspended' WHERE id=$1"
        : "UPDATE app.stores SET status='suspended' WHERE id=$1", [entity === "merchant" ? merchantId : storeId]);
      await writer.query("SET LOCAL ROLE snus_partner_api");
      await expect(lockActivePartnerBusinessScopeForClient(writer, merchantId, storeId))
        .rejects.toMatchObject({ code: "scope_suspended", statusCode: 403 });
    } finally { await writer.query("ROLLBACK"); }
  });
  it("holds the Partner lifecycle row lock until caller commit", async () => {
    await writer.query("BEGIN"); await statusWriter.query("BEGIN");
    try {
      await writer.query("SET LOCAL ROLE snus_partner_api");
      await lockActivePartnerBusinessScopeForClient(writer, merchantId, storeId);
      await statusWriter.query("SET LOCAL lock_timeout='150ms'");
      await expect(statusWriter.query("UPDATE app.merchants SET status='suspended' WHERE id=$1", [merchantId]))
        .rejects.toMatchObject({ code: "55P03" });
    } finally { await writer.query("ROLLBACK"); await statusWriter.query("ROLLBACK"); }
  });
  it("allows the actual restricted Partner role through an active lifecycle fence without granting tenant UPDATE", async () => {
    await writer.query("BEGIN");
    try {
      await writer.query("SET LOCAL ROLE snus_partner_api");
      const privilege = await writer.query("SELECT has_column_privilege(current_user,'app.merchants','status','UPDATE') AS merchant_update,has_column_privilege(current_user,'app.stores','status','UPDATE') AS store_update");
      expect(privilege.rows).toEqual([{ merchant_update: false, store_update: false }]);
      await expect(createOrderForClient(writer, { items: [], paymentMethod: "cod", amountReceived: 0,
        salesChannel: "website", sourceFlow: "partner_api_v1" }, {
        actorType: "partner", partnerId: "UAT", integrationId: "UAT", clientId: "UAT", registryClientId: "UAT",
        authMethod: "oauth_client", credentialId: "UAT", keyId: null, merchantId, storeId,
        organizationId: merchantId, requestId: "UAT", traceId: "a".repeat(32), grantVersion: 1, storeGrantVersion: 1,
      }, { source: "remote", salesChannelId: "sc_remote", orderStatus: "completed", merchantId, storeId, stockLocationId: storeId }))
        .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    } finally { await writer.query("ROLLBACK"); }
  });
  it("starts entity versions at one without inventing a historical transition timestamp", async () => {
    for (const table of ["merchants", "stores"]) {
      const row = await writer.query(`SELECT status_version::text, status_changed_at FROM app.${table} WHERE id=$1`,
        [table === "merchants" ? merchantId : storeId]);
      expect(row.rows).toEqual([{ status_version: "1", status_changed_at: null }]);
    }
  });
  it.each(["version-default", "transition-default"])("refuses lifecycle schema drift: %s", async drift => {
    await writer.query("BEGIN");
    try {
      await writer.query(drift === "version-default"
        ? "ALTER TABLE app.merchants ALTER COLUMN status_version SET DEFAULT 2"
        : "ALTER TABLE app.stores ALTER COLUMN status_changed_at SET DEFAULT now()");
      const migration = readFileSync(new URL("../../../../db/migrations/070_business_lifecycle_versions.sql", import.meta.url), "utf8");
      await expect(writer.query(migration)).rejects.toMatchObject({ code: "P0001", message: expect.stringContaining("Business lifecycle column shape differs") });
    } finally { await writer.query("ROLLBACK"); }
  });
  it("requires an explicit caller-owned transaction", async () => {
    await expect(lockActiveBusinessScopeForClient(writer, target)).rejects.toMatchObject({ code: "25P01" });
  });
  it("does not accept a historical scope or platform target as business authority", async () => {
    for (const invalid of [{ scopeKind: "historical_read", merchantId, storeIds: [storeId] }, { scopeType: "platform" }]) {
      await expect(lockActiveBusinessScopeForClient(writer, invalid as never)).rejects.toMatchObject({ code: "scope_required" });
    }
  });
  it("requires the store to belong to the locked merchant", async () => {
    await writer.query("BEGIN");
    try {
      await expect(lockActiveBusinessScopeForClient(writer, { ...target, storeId: "store_default" }))
        .rejects.toMatchObject({ code: "forbidden" });
    } finally { await writer.query("ROLLBACK"); }
  });
  it.each(["merchant", "store"] as const)("metadata %s writers acquire UPDATE directly instead of upgrading competing SHARE locks", async entity => {
    const metadataTarget = entity === "merchant" ? { scopeType: "merchant" as const, merchantId } : target;
    await writer.query("BEGIN"); await statusWriter.query("BEGIN");
    try {
      await lockActiveBusinessScopeForClient(writer, metadataTarget, "update");
      await statusWriter.query("SET LOCAL lock_timeout='150ms'");
      await expect(lockActiveBusinessScopeForClient(statusWriter, metadataTarget, "update")).rejects.toMatchObject({ code: "55P03" });
    } finally { await writer.query("ROLLBACK"); await statusWriter.query("ROLLBACK"); }
  });
  it.each(["merchant", "store"] as const)("serializes %s status changes behind an in-flight writer and denies after commit", async entity => {
    const update = entity === "merchant" ? "UPDATE app.merchants SET status=$2 WHERE id=$1"
      : "UPDATE app.stores SET status=$2 WHERE id=$1";
    const entityId = entity === "merchant" ? merchantId : storeId;
    const disabledStatus = "suspended";
    await writer.query("BEGIN");
    try {
      await lockActiveBusinessScopeForClient(writer, target);
      await statusWriter.query("BEGIN");
      await statusWriter.query("SET LOCAL lock_timeout='150ms'");
      await expect(statusWriter.query(update, [entityId, disabledStatus])).rejects.toMatchObject({ code: "55P03" });
      await statusWriter.query("ROLLBACK");
      await writer.query("COMMIT");
      await statusWriter.query("BEGIN");
      await statusWriter.query(update, [entityId, disabledStatus]);
      await statusWriter.query("COMMIT");
      await writer.query("BEGIN");
      await expect(lockActiveBusinessScopeForClient(writer, target)).rejects.toMatchObject({ code: "scope_suspended" });
    } finally {
      await writer.query("ROLLBACK"); await statusWriter.query("ROLLBACK");
      await statusWriter.query(update, [entityId, "active"]);
    }
  });
});
