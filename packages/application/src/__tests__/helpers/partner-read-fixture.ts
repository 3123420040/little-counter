import type { PoolClient } from "pg";

// Synthetic rows only; caller owns the transaction and its rollback.
export async function seedPartnerReadFixture(db: PoolClient, prefix = "pr") {
  if (!/^[a-z][a-z0-9]{1,23}$/.test(prefix)) throw new Error("Invalid synthetic fixture prefix");
  await db.query(`
    INSERT INTO app.merchants(id,display_name,legacy_organization_id,status) VALUES ('pr_m','Synthetic','pr_org','active'),('pr_other','Other','pr_other_org','active');
    INSERT INTO public.stock_location(id,name) VALUES ('pr_l1','One'),('pr_l2','Two');
    INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,status) VALUES ('pr_s1','pr_m','One','pr_l1','active'),('pr_s2','pr_m','Two','pr_l2','active');
    INSERT INTO app.package_catalog_versions(id,catalog_version,package_key,annual_price_vnd,included_stores,staff_limit,research_runs_per_month,telegram_ai_drafts_per_month,feature_keys)
      VALUES ('pr_cat','pr_fixture','plus',0,2,3,0,0,'["partner_api"]');
    INSERT INTO app.merchant_subscriptions(id,merchant_id,package_key,catalog_version_id,current_period_start,current_period_end,primary_store_id)
      VALUES ('pr_sub','pr_m','plus','pr_cat',now()-interval '1 day',now()+interval '1 day','pr_s1');
    INSERT INTO integration.partners(id,code,display_name,status) VALUES ('pr_p','pr_p','Synthetic','active');
    INSERT INTO integration.policies(id,version,merchant_id,currency,max_order_total,max_quantity,safety_stock,contact_retention_days,
      read_per_minute,quote_per_minute,book_per_minute,read_burst,quote_burst,book_burst,mutation_concurrency)
      VALUES ('pr_policy',1,'pr_m','VND',10000000,100,2,30,120,30,10,20,5,2,2);
    INSERT INTO integration.integrations(id,partner_id,merchant_id,environment,installation_key,status,writes_enabled,policy_id,policy_version)
      VALUES ('pr_i','pr_p','pr_m','sandbox','fixture','active',true,'pr_policy',1);
    INSERT INTO integration.clients(id,integration_id,issuer,oauth_client_id,subject,status,auth_method,credential_reference)
      VALUES ('pr_c','pr_i','https://pr.invalid','reads','subject','active','private_key_jwt','fixture-key');
    INSERT INTO integration.assortments(id,merchant_id,status) VALUES ('pr_a','pr_m','active');
    INSERT INTO integration.store_grants(integration_id,merchant_id,store_id,stock_location_id,allowed_scopes,assortment_id,status)
      VALUES ('pr_i','pr_m','pr_s1','pr_l1',ARRAY['partner:read','inventory:read','catalog:read','orders:write'],'pr_a','active'),
        ('pr_i','pr_m','pr_s2','pr_l2',ARRAY['inventory:read','orders:read'],'pr_a','active');
    INSERT INTO public.product(id,title,handle,status,merchant_id) VALUES ('pr_product','Synthetic product','pr_product','published','pr_m');
    INSERT INTO public.product_variant(id,title,sku,product_id) VALUES
      ('pr_v1','One','pr_sku1','pr_product'),('pr_v2','Two','pr_sku2','pr_product'),('pr_v3','Three','pr_sku3','pr_product');
    INSERT INTO public.inventory_item(id) VALUES ('pr_item1'),('pr_item2'),('pr_item3');
    INSERT INTO public.product_variant_inventory_item(id,variant_id,inventory_item_id) VALUES
      ('pr_map1','pr_v1','pr_item1'),('pr_map2','pr_v2','pr_item2'),('pr_map3','pr_v3','pr_item3');
    INSERT INTO integration.assortment_items(assortment_id,variant_id) VALUES ('pr_a','pr_v1'),('pr_a','pr_v2'),('pr_a','pr_v3');
    INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity) VALUES
      ('pr_il1','pr_item1','pr_l1',10,0),('pr_il2','pr_item1','pr_l2',40,0),('pr_il3','pr_item3','pr_l1',-5,0);
  `.replace(/\bpr_/g, `${prefix}_`).replace("https://pr.invalid", prefix === "pr" ? "https://pr.invalid" : `https://${prefix}.invalid`));
}

// Call only after qualified disposable sentinel check; owner-only teardown.
export async function cleanupPartnerReadFixture(db: PoolClient) {
      await db.query(`
        DELETE FROM integration.control_operations WHERE integration_id='pr_i';
        DELETE FROM integration.store_grants WHERE integration_id='pr_i';
        DELETE FROM integration.clients WHERE integration_id='pr_i';
        DELETE FROM integration.integrations WHERE id='pr_i';
        -- Test teardown only: immutable policy fixture is deleted by the
        -- qualified synthetic DB owner, never by an application role.
        ALTER TABLE integration.policies DISABLE TRIGGER partner_policy_immutable;
        DELETE FROM integration.policies WHERE id='pr_policy';
        ALTER TABLE integration.policies ENABLE TRIGGER partner_policy_immutable;
        DELETE FROM integration.partners WHERE id='pr_p';
        DELETE FROM integration.assortment_items WHERE assortment_id='pr_a';
        DELETE FROM integration.assortments WHERE id='pr_a';
        DELETE FROM public.inventory_level WHERE id IN ('pr_il1','pr_il2','pr_il3');
        DELETE FROM public.product_variant_inventory_item WHERE id IN ('pr_map1','pr_map2','pr_map3');
        DELETE FROM public.inventory_item WHERE id IN ('pr_item1','pr_item2','pr_item3');
        DELETE FROM public.product_variant WHERE id IN ('pr_v1','pr_v2','pr_v3');
        DELETE FROM public.product WHERE id='pr_product';
        DELETE FROM app.merchant_subscriptions WHERE id='pr_sub';
        DELETE FROM app.package_catalog_versions WHERE id='pr_cat';
        DELETE FROM app.stores WHERE id IN ('pr_s1','pr_s2');
        DELETE FROM public.stock_location WHERE id IN ('pr_l1','pr_l2');
        DELETE FROM app.merchants WHERE id IN ('pr_m','pr_other');
      `);
}
