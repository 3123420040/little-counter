-- Strict ownership activates with the scoped writer release, after writer drain.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.product_variant v LEFT JOIN public.product p ON p.id=v.product_id
   WHERE v.merchant_id IS DISTINCT FROM p.merchant_id OR (v.merchant_id IS NULL AND (nullif(btrim(v.sku),'') IS NOT NULL OR nullif(btrim(v.barcode),'') IS NOT NULL))) THEN RAISE EXCEPTION 'Invalid variant owner'; END IF;
 IF EXISTS(SELECT 1 FROM public.inventory_level l JOIN public.inventory_item i ON i.id=l.inventory_item_id
   WHERE i.merchant_id IS NULL OR NOT EXISTS(SELECT 1 FROM app.stores s WHERE s.stock_location_id=l.location_id AND s.merchant_id=i.merchant_id)) THEN RAISE EXCEPTION 'Invalid inventory level owner'; END IF;
 IF EXISTS(SELECT 1 FROM public.reservation_item r LEFT JOIN public.inventory_item i ON i.id=r.inventory_item_id WHERE i.merchant_id IS NULL OR NOT EXISTS(SELECT 1 FROM app.stores s WHERE s.stock_location_id=r.location_id AND s.merchant_id=i.merchant_id)) THEN RAISE EXCEPTION 'Invalid reservation owner'; END IF;
END $$;
-- Codes are unique only among active, bound records in the same merchant.
CREATE UNIQUE INDEX catalog_variant_sku_unique ON public.product_variant(merchant_id,lower(btrim(sku))) WHERE deleted_at IS NULL AND merchant_id IS NOT NULL AND nullif(btrim(sku),'') IS NOT NULL;
CREATE UNIQUE INDEX catalog_variant_barcode_unique ON public.product_variant(merchant_id,lower(btrim(barcode))) WHERE deleted_at IS NULL AND merchant_id IS NOT NULL AND nullif(btrim(barcode),'') IS NOT NULL;
CREATE UNIQUE INDEX catalog_inventory_sku_unique ON public.inventory_item(merchant_id,lower(btrim(sku))) WHERE deleted_at IS NULL AND merchant_id IS NOT NULL AND nullif(btrim(sku),'') IS NOT NULL;
CREATE FUNCTION integration.catalog_variant_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE parent text;
BEGIN
 SELECT merchant_id INTO parent FROM public.product WHERE id=NEW.product_id FOR SHARE NOWAIT;
 IF NOT FOUND OR (NEW.merchant_id IS NOT NULL AND NEW.merchant_id IS DISTINCT FROM parent) THEN RAISE EXCEPTION 'Invalid variant merchant' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.merchant_id IS NOT NULL AND parent IS DISTINCT FROM OLD.merchant_id THEN RAISE EXCEPTION 'Variant merchant is immutable' USING ERRCODE='23514'; END IF;
 IF parent IS NULL AND (nullif(btrim(NEW.sku),'') IS NOT NULL OR nullif(btrim(NEW.barcode),'') IS NOT NULL) THEN RAISE EXCEPTION 'Variant codes require merchant' USING ERRCODE='23514'; END IF;
 NEW.merchant_id:=parent; RETURN NEW;
END $$;
CREATE TRIGGER tenant_variant_owner BEFORE INSERT OR UPDATE ON public.product_variant FOR EACH ROW EXECUTE FUNCTION integration.catalog_variant_owner();
CREATE FUNCTION integration.catalog_item_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.merchant_id IS NOT NULL AND NEW.merchant_id IS DISTINCT FROM OLD.merchant_id THEN RAISE EXCEPTION 'Inventory merchant is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.merchant_id IS NOT NULL AND (TG_OP='INSERT' OR OLD.merchant_id IS NULL) THEN
   IF NOT EXISTS(SELECT 1 FROM public.product_variant_inventory_item m JOIN public.product_variant v ON v.id=m.variant_id WHERE m.inventory_item_id=NEW.id AND v.merchant_id=NEW.merchant_id)
   OR EXISTS(SELECT 1 FROM public.product_variant_inventory_item m JOIN public.product_variant v ON v.id=m.variant_id WHERE m.inventory_item_id=NEW.id AND v.merchant_id IS DISTINCT FROM NEW.merchant_id) THEN RAISE EXCEPTION 'Inventory binding requires matching merchant mapping' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tenant_item_owner BEFORE INSERT OR UPDATE ON public.inventory_item FOR EACH ROW EXECUTE FUNCTION integration.catalog_item_owner();
ALTER TABLE public.product_variant_inventory_item ADD CONSTRAINT catalog_mapping_variant_fk FOREIGN KEY(variant_id) REFERENCES public.product_variant(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE public.product_variant_inventory_item ADD CONSTRAINT catalog_mapping_item_fk FOREIGN KEY(inventory_item_id) REFERENCES public.inventory_item(id) ON UPDATE CASCADE ON DELETE CASCADE;
CREATE FUNCTION integration.catalog_mapping_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target text; owner text; previous text;
BEGIN
 IF TG_OP='UPDATE' THEN previous:=OLD.inventory_item_id; END IF;
 PERFORM 1 FROM public.inventory_item WHERE id IN(previous,NEW.inventory_item_id) ORDER BY id FOR UPDATE NOWAIT;
 SELECT merchant_id INTO target FROM public.product_variant WHERE id=NEW.variant_id;
 SELECT merchant_id INTO owner FROM public.inventory_item WHERE id=NEW.inventory_item_id;
 IF NOT FOUND OR target IS NULL OR (owner IS NOT NULL AND owner<>target) THEN RAISE EXCEPTION 'Cross merchant inventory mapping' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tenant_mapping_owner BEFORE INSERT OR UPDATE ON public.product_variant_inventory_item FOR EACH ROW EXECUTE FUNCTION integration.catalog_mapping_owner();
CREATE FUNCTION integration.catalog_mapping_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE public.inventory_item i SET merchant_id=v.merchant_id FROM public.product_variant v WHERE i.id=NEW.inventory_item_id AND v.id=NEW.variant_id AND i.merchant_id IS NULL;
 RETURN NEW;
END $$;
CREATE TRIGGER tenant_mapping_bind AFTER INSERT OR UPDATE ON public.product_variant_inventory_item FOR EACH ROW EXECUTE FUNCTION integration.catalog_mapping_bind();
CREATE FUNCTION integration.catalog_stock_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner text;
BEGIN
 SELECT merchant_id INTO owner FROM public.inventory_item WHERE id=NEW.inventory_item_id FOR SHARE NOWAIT;
 IF owner IS NULL OR NOT EXISTS(SELECT 1 FROM app.stores WHERE stock_location_id=NEW.location_id AND merchant_id=owner) THEN RAISE EXCEPTION 'Inventory must be bound to location merchant' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tenant_level_owner BEFORE INSERT OR UPDATE ON public.inventory_level FOR EACH ROW EXECUTE FUNCTION integration.catalog_stock_owner();
CREATE TRIGGER tenant_reservation_owner BEFORE INSERT OR UPDATE ON public.reservation_item FOR EACH ROW EXECUTE FUNCTION integration.catalog_stock_owner();
CREATE FUNCTION integration.catalog_parent_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.merchant_id IS DISTINCT FROM OLD.merchant_id THEN RAISE EXCEPTION 'Catalog merchant is immutable' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_SCHEMA='app' THEN
   IF NEW.stock_location_id IS DISTINCT FROM OLD.stock_location_id THEN RAISE EXCEPTION 'Store stock location is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tenant_product_owner BEFORE UPDATE OF merchant_id ON public.product FOR EACH ROW EXECUTE FUNCTION integration.catalog_parent_owner();
CREATE TRIGGER tenant_store_owner BEFORE UPDATE OF merchant_id,stock_location_id ON app.stores FOR EACH ROW EXECUTE FUNCTION integration.catalog_parent_owner();
REVOKE ALL ON FUNCTION integration.catalog_variant_owner(),integration.catalog_item_owner(),integration.catalog_mapping_owner(),integration.catalog_mapping_bind(),integration.catalog_stock_owner(),integration.catalog_parent_owner() FROM PUBLIC;
DROP INDEX IF EXISTS public."IDX_product_variant_sku_unique";
DROP INDEX IF EXISTS public.product_variant_sku_unique_idx;
DROP INDEX IF EXISTS public."IDX_inventory_item_sku";
DROP INDEX IF EXISTS public."IDX_product_variant_barcode_unique";
DROP INDEX IF EXISTS public.product_variant_barcode_unique_idx;
