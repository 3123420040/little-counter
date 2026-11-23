-- Query-only core access for the partner facade. No lazy provisioning or
-- inheritance of a staff/report role that could expose contacts or metadata.
GRANT USAGE ON SCHEMA app, public TO snus_partner_api;
GRANT SELECT (id,status,legacy_organization_id) ON app.merchants TO snus_partner_api;
GRANT SELECT (id,merchant_id,stock_location_id,status) ON app.stores TO snus_partner_api;
GRANT SELECT (merchant_id,catalog_version_id,current_period_end,grace_ends_at) ON app.merchant_subscriptions TO snus_partner_api;
GRANT SELECT (id,feature_keys) ON app.package_catalog_versions TO snus_partner_api;
GRANT SELECT (id,deleted_at) ON public.stock_location TO snus_partner_api;
GRANT SELECT (id,title,merchant_id,status,deleted_at) ON public.product TO snus_partner_api;
GRANT SELECT (id,sku,product_id,deleted_at,manage_inventory,allow_backorder) ON public.product_variant TO snus_partner_api;
GRANT SELECT (variant_id,inventory_item_id,required_quantity,deleted_at) ON public.product_variant_inventory_item TO snus_partner_api;
GRANT SELECT (id,deleted_at) ON public.inventory_item TO snus_partner_api;
GRANT SELECT (inventory_item_id,location_id,stocked_quantity,reserved_quantity,deleted_at) ON public.inventory_level TO snus_partner_api;
