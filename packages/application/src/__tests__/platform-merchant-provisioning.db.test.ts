import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { connectPlatformClient, type PoolClient } from "../db/client";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { shutdownPlatformDb } from "../platform-db";
import { createPlatformMerchant } from "../services/platform-merchant-provisioning-service";
import { resolveScopeBootstrap } from "../services/access-service";
import { describeFoundStockPolicy } from "../services/merchant-checkout-policy-service";

const admin = { operatorId: "op_create_merchant_admin", role: "owner" as const, organizationId: "org_default", displayName: "Admin" };
const owner = { operatorId: "op_create_merchant_owner", role: "owner" as const, organizationId: "org_create_merchant_existing", displayName: "Owner" };
const readonly = { ...admin, operatorId: "op_create_merchant_readonly" };
const unrelated = { ...owner, operatorId: "op_create_merchant_unrelated", role: "staff" as const };
const input = { displayName: "Provisioning DB Merchant", storeName: "Primary Store", timezone: "Asia/Ho_Chi_Minh", ownerOperatorId: owner.operatorId };
const headers = (key: string) => ({ "idempotency-key": key });
let client: PoolClient;

beforeAll(async () => {
  client = await connectPlatformClient();
  await assertSafeTestDatabaseSentinel(client, requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL));
  await client.query(`INSERT INTO medusa.staff_users (operator_id,password_hash,display_name,role,organization_id,is_active)
    VALUES ($1,'unchanged-test-hash','Existing Owner','owner',$2,true),
           ($3,'admin-test-hash','Platform Admin','owner','org_default',true),
           ($4,'readonly-test-hash','Readonly','owner','org_default',true)
    ON CONFLICT (operator_id) DO NOTHING`, [owner.operatorId, owner.organizationId, admin.operatorId, readonly.operatorId]);
  await client.query(`INSERT INTO medusa.staff_users (operator_id,password_hash,display_name,role,organization_id,is_active)
    VALUES ($1,'test-only-hash','Unrelated Staff','staff',$2,true)`, [unrelated.operatorId,owner.organizationId]);
  await client.query(`INSERT INTO app.merchants (id,display_name,legacy_organization_id,status)
    VALUES ('merchant_create_existing','Existing Merchant',$1,'active') ON CONFLICT DO NOTHING`, [owner.organizationId]);
  await client.query(`INSERT INTO app.operator_security_state
    (operator_id,requires_password_change,session_version,global_status,password_changed_at)
    VALUES ($1,false,9,'active','2026-01-01')`, [owner.operatorId]);
  await client.query(`INSERT INTO app.operator_memberships (operator_id,scope_type,merchant_id,role_key,status,granted_by)
    VALUES ($1,'merchant','merchant_create_existing','owner','active','test'),
           ($2,'platform',NULL,'platform_admin','active','test'),
           ($3,'platform',NULL,'platform_readonly','active','test')`, [owner.operatorId,admin.operatorId,readonly.operatorId]);
  await client.query(`INSERT INTO app.operator_memberships (operator_id,scope_type,merchant_id,role_key,status,granted_by)
    VALUES ($1,'merchant','merchant_create_existing','staff','active','test')`, [unrelated.operatorId]);
}, 30000);

afterAll(async () => {
  if (client) {
    const merchants = await client.query<{ id: string }>("SELECT id FROM app.merchants WHERE display_name='Provisioning DB Merchant'");
    for (const { id } of merchants.rows) {
      const stores = await client.query<{ stock_location_id: string }>("SELECT stock_location_id FROM app.stores WHERE merchant_id=$1", [id]);
      for (const table of ["audit.events", "app.subscription_events", "app.merchant_subscriptions", "ai_module.loyalty_tiers", "app.operator_memberships", "app.stores"]) {
        await client.query(`DELETE FROM ${table} WHERE merchant_id=$1`, [id]);
      }
      await client.query("DELETE FROM app.merchants WHERE id=$1", [id]);
      for (const store of stores.rows) await client.query("DELETE FROM public.stock_location WHERE id=$1", [store.stock_location_id]);
    }
    await client.query("DELETE FROM app.idempotency_records WHERE tenant_id=$1", [`platform:${admin.operatorId}`]);
    await client.query("DELETE FROM audit.events WHERE actor_id=ANY($1::text[])", [[admin.operatorId,readonly.operatorId,owner.operatorId]]);
    await client.query("DELETE FROM app.operator_memberships WHERE operator_id=ANY($1::text[])", [[admin.operatorId,readonly.operatorId,owner.operatorId,unrelated.operatorId]]);
    await client.query("DELETE FROM app.operator_security_state WHERE operator_id=ANY($1::text[])", [[admin.operatorId,readonly.operatorId,owner.operatorId]]);
    await client.query("DELETE FROM app.merchants WHERE id='merchant_create_existing'");
    await client.query("DELETE FROM medusa.staff_users WHERE operator_id=ANY($1::text[])", [[admin.operatorId,readonly.operatorId,owner.operatorId,unrelated.operatorId]]);
    client.release();
  }
  await shutdownPlatformDb();
});

describe("platform merchant atomic provisioning", () => {
  it("creates an operational tenant without changing the existing owner's account", async () => {
    const before = (await client.query("SELECT * FROM medusa.staff_users WHERE operator_id=$1", [owner.operatorId])).rows[0];
    const oldMembership = (await client.query("SELECT * FROM app.operator_memberships WHERE operator_id=$1 AND merchant_id='merchant_create_existing'", [owner.operatorId])).rows;
    const oldSecurity = (await client.query("SELECT * FROM app.operator_security_state WHERE operator_id=$1", [owner.operatorId])).rows;
    expect(oldSecurity).toHaveLength(1);
    const result = await createPlatformMerchant(input, admin, headers("create-graph"));
    expect(result.statusCode).toBe(201);
    expect(result.data).toMatchObject({ ...input, packageKey: "basic" });
    const merchantId = result.data.merchantId;
    const store = (await client.query("SELECT * FROM app.stores WHERE merchant_id=$1", [merchantId])).rows;
    expect(store).toHaveLength(1);
    expect(store[0]).toMatchObject({ id: result.data.storeId, is_primary: true, stock_location_id: result.data.stockLocationId, metadata: { ownerSettings: { timezone: input.timezone } } });
    expect((await client.query("SELECT * FROM medusa.staff_users WHERE operator_id=$1", [owner.operatorId])).rows[0]).toEqual(before);
    expect((await client.query("SELECT * FROM app.operator_memberships WHERE operator_id=$1 AND merchant_id='merchant_create_existing'", [owner.operatorId])).rows).toEqual(oldMembership);
    expect((await client.query("SELECT * FROM app.operator_security_state WHERE operator_id=$1", [owner.operatorId])).rows).toEqual(oldSecurity);
    expect((await client.query("SELECT role_key FROM app.operator_memberships WHERE operator_id=$1 AND merchant_id=$2", [owner.operatorId,merchantId])).rows).toEqual([{ role_key: "owner" }]);
    expect((await client.query("SELECT count(*)::int AS n FROM ai_module.loyalty_tiers WHERE merchant_id=$1", [merchantId])).rows[0].n).toBe(4);
    expect((await client.query("SELECT package_key,primary_store_id FROM app.merchant_subscriptions WHERE merchant_id=$1", [merchantId])).rows).toEqual([{ package_key: "basic", primary_store_id: result.data.storeId }]);
    expect((await client.query("SELECT action FROM audit.events WHERE merchant_id=$1", [merchantId])).rows).toContainEqual({ action: "platform.merchant.created" });
    const bootstrap = await resolveScopeBootstrap(owner, { "x-operating-merchant-id": merchantId, "x-operating-store-id": result.data.storeId });
    expect(bootstrap.activeOperatingScope).toMatchObject({ merchantId, storeId: result.data.storeId });
    expect(bootstrap.access.isPlatformAdmin).toBe(false);
    await expect(resolveScopeBootstrap(unrelated, { "x-operating-merchant-id": merchantId, "x-operating-store-id": result.data.storeId }))
      .rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
    expect(bootstrap.merchants.map((m) => m.id).sort()).toEqual([merchantId,"merchant_create_existing"].sort());
    const merchant = (await client.query("SELECT metadata,legacy_organization_id FROM app.merchants WHERE id=$1", [merchantId])).rows[0];
    expect(merchant.legacy_organization_id).not.toBe(owner.organizationId);
    expect(describeFoundStockPolicy(merchant.metadata)).toMatchObject({ enabled: true, source: "default" });
  });

  it("provisions through the actual least-privilege runtime database login", () => {
    const runtimeUrl = new URL(process.env.TEST_DATABASE_URL!);
    runtimeUrl.username = "snus_v19_runtime_writer";
    expect(process.env.TEST_MEDUSA_DB_PASS).toBeTruthy();
    runtimeUrl.password = process.env.TEST_MEDUSA_DB_PASS!;
    const source = `
      import { createPlatformMerchant } from './packages/application/src/services/platform-merchant-provisioning-service.ts';
      import { connectPlatformClient } from './packages/application/src/db/client.ts';
      import { shutdownPlatformDb } from './packages/application/src/platform-db.ts';
      (async () => { try {
        const c=await connectPlatformClient();
        const {rows}=await c.query('SELECT current_user AS identity'); c.release();
        const result=await createPlatformMerchant(${JSON.stringify(input)},${JSON.stringify(admin)},${JSON.stringify(headers("runtime-key"))});
        console.log(JSON.stringify({identity:rows[0].identity,statusCode:result.statusCode,merchantId:result.data.merchantId}));
      } catch(error) { console.error(JSON.stringify({code:error.code,message:error.message})); process.exitCode=1; }
      finally { await shutdownPlatformDb(); } })();
    `;
    const result = spawnSync(process.execPath,[resolve("node_modules/tsx/dist/cli.mjs"),"-e",source], {
      encoding: "utf8", timeout: 30000,
      env: { ...process.env, DATABASE_URL: runtimeUrl.toString(), PLATFORM_RUNTIME_SCHEMA_BOOTSTRAP_ENABLED: "false", RUNTIME_SCHEMA_DDL_ENABLED: "false" },
    });
    expect(result.status, result.stderr.replaceAll(process.env.TEST_MEDUSA_DB_PASS!, "[REDACTED]")).toBe(0);
    const evidence = JSON.parse(result.stdout.trim());
    expect(evidence).toMatchObject({ identity: "snus_v19_runtime_writer", statusCode: 201 });
    expect(evidence.merchantId).toMatch(/^merchant_/);
  },30000);

  it.each([owner, readonly, unrelated])("rejects a non-writing platform actor $operatorId", async (actor) => {
    await expect(createPlatformMerchant(input, actor, headers(`denied-${actor.operatorId}`))).rejects.toMatchObject({ statusCode: 403 });
  });

  it.each(["manager","accountant"] as const)("does not give a merchant %s platform creation rights", async (role) => {
    await client.query("UPDATE app.operator_memberships SET role_key=$2 WHERE operator_id=$1", [unrelated.operatorId,role]);
    try {
      await expect(createPlatformMerchant(input, { ...unrelated, role }, headers(`denied-${role}`))).rejects.toMatchObject({ statusCode: 403 });
    } finally { await client.query("UPDATE app.operator_memberships SET role_key='staff' WHERE operator_id=$1", [unrelated.operatorId]); }
  });

  it("replays concurrent submissions once and rejects a changed payload", async () => {
    const responses = await Promise.all(Array.from({ length: 3 }, () => createPlatformMerchant(input, admin, headers("concurrent"))));
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200,200,201]);
    expect(new Set(responses.map((r) => r.data.merchantId)).size).toBe(1);
    const merchantId = responses[0].data.merchantId;
    expect((await client.query("SELECT count(*)::int AS n FROM audit.events WHERE merchant_id=$1 AND action='platform.merchant.created'", [merchantId])).rows[0].n).toBe(1);
    expect((await client.query("SELECT count(*)::int AS n FROM app.subscription_events WHERE merchant_id=$1", [merchantId])).rows[0].n).toBe(1);
    await expect(createPlatformMerchant({ ...input, storeName: "Changed Store" }, admin, headers("concurrent"))).rejects.toMatchObject({ code: "idempotency_conflict", statusCode: 409 });
  });

  it("retains provisioning receipts beyond generic cache expiry so an old tab cannot create another merchant", async () => {
    const first = await createPlatformMerchant(input, admin, headers("durable-receipt"));
    const receipt = await client.query("SELECT expires_at::text AS expiry FROM app.idempotency_records WHERE tenant_id=$1 AND idempotency_key='durable-receipt'", [`platform:${admin.operatorId}`]);
    expect(receipt.rows).toEqual([{ expiry: "infinity" }]);
    await client.query("UPDATE app.idempotency_records SET created_at=now()-interval '35 days' WHERE tenant_id=$1 AND idempotency_key='durable-receipt'", [`platform:${admin.operatorId}`]);
    const replay = await createPlatformMerchant(input, admin, headers("durable-receipt"));
    expect(replay).toEqual({ data: first.data, statusCode: 200 });
  });

  it.each([
    { status: "revoked", valid_from: "2000-01-01", valid_to: null },
    { status: "active", valid_from: "2099-01-01", valid_to: null },
    { status: "active", valid_from: "2000-01-01", valid_to: "2001-01-01" },
  ])("rejects non-effective platform membership %j even on replay", async (membership) => {
    await client.query("UPDATE app.operator_memberships SET status=$2,valid_from=$3,valid_to=$4 WHERE operator_id=$1 AND scope_type='platform'",
      [admin.operatorId,membership.status,membership.valid_from,membership.valid_to]);
    try {
      await expect(createPlatformMerchant(input, admin, headers("create-graph"))).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      await client.query("UPDATE app.operator_memberships SET status='active',valid_from=now(),valid_to=NULL WHERE operator_id=$1 AND scope_type='platform'", [admin.operatorId]);
    }
  });

  it("rejects read-only impersonation", async () => {
    await expect(createPlatformMerchant(input, { ...admin, impersonationMode: "read_only" }, headers("impersonation")))
      .rejects.toMatchObject({ code: "impersonation_read_only", statusCode: 403 });
  });

  it("rejects missing, inactive, suspended and expired-temporary owners", async () => {
    await expect(createPlatformMerchant({ ...input, ownerOperatorId: "missing_owner" }, admin, headers("missing")))
      .rejects.toMatchObject({ code: "owner_not_available" });
    await client.query("UPDATE medusa.staff_users SET is_active=false WHERE operator_id=$1", [owner.operatorId]);
    try {
      await expect(createPlatformMerchant(input, admin, headers("inactive"))).rejects.toMatchObject({ code: "owner_not_available" });
    } finally { await client.query("UPDATE medusa.staff_users SET is_active=true WHERE operator_id=$1", [owner.operatorId]); }
    await client.query("UPDATE app.operator_security_state SET global_status='suspended' WHERE operator_id=$1", [owner.operatorId]);
    try {
      await expect(createPlatformMerchant(input, admin, headers("suspended"))).rejects.toMatchObject({ code: "owner_not_available" });
      await client.query("UPDATE app.operator_security_state SET global_status='active',temporary_password_hash='test-only',temporary_password_expires_at=now()-interval '1 minute' WHERE operator_id=$1", [owner.operatorId]);
      await expect(createPlatformMerchant(input, admin, headers("expired-owner"))).rejects.toMatchObject({ code: "owner_not_available" });
    } finally { await client.query("UPDATE app.operator_security_state SET global_status='active',temporary_password_hash=NULL,temporary_password_expires_at=NULL WHERE operator_id=$1", [owner.operatorId]); }
  });

  it("rolls back the entire graph, subscription event and receipt when audit fails", async () => {
    const tables = ["app.merchants", "app.stores", "public.stock_location", "app.operator_memberships", "ai_module.loyalty_tiers", "app.merchant_subscriptions", "app.subscription_events", "app.idempotency_records"];
    const counts = async () => {
      const values: number[] = [];
      for (const table of tables) values.push((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
      return values;
    };
    const before = await counts();
    await client.query(`CREATE FUNCTION app.reject_platform_create_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='platform.merchant.created' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_platform_create_test BEFORE INSERT ON audit.events FOR EACH ROW EXECUTE FUNCTION app.reject_platform_create_test()`);
    try {
      await expect(createPlatformMerchant(input, admin, headers("rollback"))).rejects.toThrow("test audit failure");
      expect(await counts()).toEqual(before);
    } finally {
      await client.query("DROP TRIGGER reject_platform_create_test ON audit.events; DROP FUNCTION app.reject_platform_create_test()");
    }
    expect((await createPlatformMerchant(input, admin, headers("rollback"))).statusCode).toBe(201);
  });
});
