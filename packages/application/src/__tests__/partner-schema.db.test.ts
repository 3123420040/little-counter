import { Client } from "pg";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { requireSafeTestDatabaseTarget, assertSafeTestDatabaseSentinel } from "../db/test-database-target";

let db: Client;
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  db = new Client({ connectionString: target.connectionString });
  await db.connect();
  await assertSafeTestDatabaseSentinel(db, target);
});
afterAll(async () => { await db?.end(); });
beforeEach(async () => {
  await db.query("BEGIN");
  await db.query(`
    INSERT INTO app.merchants(id,display_name,legacy_organization_id,status)
      VALUES ('p_test_m','Fixture','p_test_org','active'),('p_test_other','Other fixture','p_test_other_org','active');
    INSERT INTO public.stock_location(id,name) VALUES ('p_test_loc','Fixture'),('p_test_loc_other','Other');
    INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,status)
      VALUES ('p_test_s','p_test_m','Fixture','p_test_loc','active'),('p_test_s_other','p_test_other','Other','p_test_loc_other','active');
    INSERT INTO integration.partners(id,code,display_name,status) VALUES ('p_test_partner','p_test_partner','Synthetic','active');
    INSERT INTO integration.policies(id,version,merchant_id,currency,max_order_total,max_quantity,safety_stock,contact_retention_days,
      read_per_minute,quote_per_minute,book_per_minute,read_burst,quote_burst,book_burst,mutation_concurrency)
      VALUES ('p_test_policy',1,'p_test_m','VND',10000000,100,0,30,120,30,10,20,5,2,2);
    INSERT INTO integration.integrations(id,partner_id,merchant_id,environment,installation_key,status,writes_enabled,policy_id,policy_version)
      VALUES ('p_test_i','p_test_partner','p_test_m','sandbox','fixture','active',true,'p_test_policy',1),
      ('p_test_i_other','p_test_partner','p_test_m','sandbox','other','active',true,'p_test_policy',1);
    INSERT INTO integration.clients(id,integration_id,issuer,oauth_client_id,subject,status,auth_method,credential_reference)
      VALUES ('p_test_c','p_test_i','https://fixture.invalid','fixture','subject','active','private_key_jwt','fixture-public-key');
    INSERT INTO integration.assortments(id,merchant_id,status) VALUES ('p_test_a','p_test_m','active');
    INSERT INTO integration.store_grants(integration_id,merchant_id,store_id,stock_location_id,allowed_scopes,assortment_id,status)
      VALUES ('p_test_i','p_test_m','p_test_s','p_test_loc',ARRAY['orders:write'],'p_test_a','active');
    INSERT INTO integration.quotes(id,integration_id,merchant_id,store_id,stock_location_id,grant_version,store_grant_version,
      pricing_version,policy_id,policy_version,snapshot,request_hash,expires_at)
      VALUES ('p_test_q','p_test_i','p_test_m','p_test_s','p_test_loc',1,1,'price','p_test_policy',1,'{}',repeat('a',64),now()+interval '5 minutes');
  `);
});
afterEach(async () => { await db.query("ROLLBACK"); });

describe("S1 actual PostgreSQL partner ownership/ACL constraints", () => {
  it("rejects a grant assembled from a different merchant store", async () => {
    await expect(db.query(`INSERT INTO integration.store_grants(integration_id,merchant_id,store_id,stock_location_id,allowed_scopes,assortment_id,status)
      VALUES ('p_test_i','p_test_m','p_test_s_other','p_test_loc_other',ARRAY['orders:write'],'p_test_a','active')`)).rejects.toMatchObject({ code: "23503" });
  });
  it("rejects a control operation targeting a sibling integration client", async () => {
    await expect(db.query(`INSERT INTO integration.control_operations(id,integration_id,client_id,kind,status)
      VALUES ('p_test_op','p_test_i_other','p_test_c','revoke','pending')`)).rejects.toMatchObject({ code: "23503" });
  });
  it("keeps policy revisions immutable", async () => {
    await expect(db.query("UPDATE integration.policies SET max_order_total=1 WHERE id='p_test_policy'"))
      .rejects.toMatchObject({ code: "23514" });
  });
  it("preserves integration identity even before any orders exist", async () => {
    await expect(db.query("UPDATE integration.integrations SET environment='production' WHERE id='p_test_i'"))
      .rejects.toMatchObject({ code: "23514" });
  });
  it("derives integration version and cannot roll it backwards", async () => {
    await db.query("UPDATE integration.integrations SET writes_enabled=false WHERE id='p_test_i'");
    await db.query("UPDATE integration.integrations SET grant_version=1 WHERE id='p_test_i'");
    expect((await db.query("SELECT grant_version FROM integration.integrations WHERE id='p_test_i'")).rows[0].grant_version).toBe(2);
  });
  it("versions a selected-store scope change without accepting caller version overrides", async () => {
    await db.query("UPDATE integration.store_grants SET allowed_scopes=ARRAY['orders:read'],version=99 WHERE integration_id='p_test_i'");
    expect((await db.query("SELECT version FROM integration.store_grants WHERE integration_id='p_test_i'")).rows[0].version).toBe(2);
  });
  it("defaults MCP catalog mode to explicit and versions a mode change without accepting caller version overrides", async () => {
    expect((await db.query("SELECT mcp_catalog_mode,version FROM integration.store_grants WHERE integration_id='p_test_i'")).rows[0])
      .toEqual({ mcp_catalog_mode: "explicit", version: 1 });
    await db.query("UPDATE integration.store_grants SET mcp_catalog_mode='merchant_published',version=99 WHERE integration_id='p_test_i'");
    expect((await db.query("SELECT mcp_catalog_mode,version FROM integration.store_grants WHERE integration_id='p_test_i'")).rows[0])
      .toEqual({ mcp_catalog_mode: "merchant_published", version: 2 });
  });
  it("allows public role authorization locking without giving it registry mutation", async () => {
    await db.query("SET LOCAL ROLE snus_partner_api");
    await expect(db.query("SELECT integration.lock_authorization('p_test_i','p_test_c','p_test_s')")).resolves.toHaveProperty("rowCount", 1);
    await expect(db.query("UPDATE integration.integrations SET writes_enabled=false WHERE id='p_test_i'"))
      .rejects.toMatchObject({ code: "42501" });
  });
  it("denies raw contact reads to the public API role", async () => {
    await db.query("SET LOCAL ROLE snus_partner_api");
    await expect(db.query("SELECT * FROM integration.order_contacts")).rejects.toMatchObject({ code: "42501" });
  });
  it("denies audit mutation to the public API role", async () => {
    await db.query("SET LOCAL ROLE snus_partner_api");
    await expect(db.query("DELETE FROM audit.events WHERE false")).rejects.toMatchObject({ code: "42501" });
  });
  it("prevents changing the quote price snapshot even with SQL UPDATE privilege", async () => {
    await db.query("SET LOCAL ROLE snus_partner_api");
    await expect(db.query("UPDATE integration.quotes SET snapshot='{\"total\":0}' WHERE id='p_test_q'"))
      .rejects.toMatchObject({ code: "23514" });
  });
  it("prevents maintenance from deleting a still-live quote", async () => {
    await db.query("SET LOCAL ROLE snus_partner_maintenance");
    await expect(db.query("DELETE FROM integration.quotes WHERE id='p_test_q'"))
      .rejects.toMatchObject({ code: "23514" });
  });
  it("rejects invalid scope entries instead of broadening grants", async () => {
    await expect(db.query("UPDATE integration.store_grants SET allowed_scopes=ARRAY['admin:all'] WHERE integration_id='p_test_i'"))
      .rejects.toMatchObject({ code: "23514" });
  });
});
