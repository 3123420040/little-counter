-- Exact shared-core dependencies for COD creation. Runtime GET uses a server
-- READ ONLY transaction. No staff users, customer/contact SELECT, registry
-- mutation, refund/cancellation service role, schema DDL or role inheritance.
GRANT USAGE ON SCHEMA inventory,medusa,outbox TO snus_partner_api;
GRANT SELECT (handle) ON public.product TO snus_partner_api;
GRANT SELECT (title,barcode) ON public.product_variant TO snus_partner_api;
GRANT SELECT (sku,title) ON public.inventory_item TO snus_partner_api;
GRANT SELECT (id) ON public.inventory_level TO snus_partner_api;
GRANT INSERT (id,inventory_item_id,location_id,stocked_quantity,reserved_quantity,incoming_quantity),
  UPDATE (stocked_quantity,updated_at) ON public.inventory_level TO snus_partner_api;
GRANT SELECT (variant_id,cost_price,updated_at,reorder_level) ON inventory.product_settings TO snus_partner_api;
GRANT INSERT (id,region_id,customer_id,sales_channel_id,status,email,currency_code,metadata,merchant_id,store_id),
  SELECT (id,display_id,created_at,merchant_id,store_id), UPDATE (custom_display_id) ON public."order" TO snus_partner_api;
GRANT INSERT, SELECT ON public.order_line_item,public.order_item,public.order_summary TO snus_partner_api;
GRANT UPDATE (totals_id) ON public.order_line_item TO snus_partner_api;
GRANT INSERT, SELECT ON medusa.stock_movements,outbox.events,app.payment_entries,
  app.order_commercial_revisions,app.order_commercial_revision_components,app.order_commercial_revision_lines,
  app.commercial_obligations,app.payment_events,app.payment_event_evidence,
  app.payment_event_component_allocations,app.payment_event_allocations TO snus_partner_api;
GRANT USAGE ON SEQUENCE public.order_display_id_seq TO snus_partner_api;
GRANT EXECUTE ON FUNCTION outbox.allocate_aggregate_sequence(text,text,text,text) TO snus_partner_api;
GRANT EXECUTE ON FUNCTION app.bump_order_collection_revision(text,text,text,text,text) TO snus_partner_api;
GRANT SELECT ON outbox.aggregate_sequences TO snus_partner_api;
-- Existing immutable financial triggers need row locks (PostgreSQL requires
-- UPDATE privilege). Their immutable triggers reject actual changes/deletes.
GRANT UPDATE ON app.commercial_obligations,app.payment_events,app.order_commercial_revisions TO snus_partner_api;
