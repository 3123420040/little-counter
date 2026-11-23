-- Price INSERT/UPDATE/DELETE must lock the stable price-set parent. Locking
-- existing price rows alone cannot prevent a concurrent replacement/phantom.
CREATE FUNCTION integration.lock_price_writer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old_set TEXT; new_set TEXT;
BEGIN
  IF TG_OP<>'INSERT' THEN old_set:=OLD.price_set_id; END IF;
  IF TG_OP<>'DELETE' THEN new_set:=NEW.price_set_id; END IF;
  PERFORM 1 FROM public.price_set WHERE id IN (old_set,new_set) ORDER BY id FOR UPDATE;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_price_writer BEFORE INSERT OR UPDATE OR DELETE ON public.price
  FOR EACH ROW EXECUTE FUNCTION integration.lock_price_writer();

-- Mapping changes serialize on the stable variant, including insertion into
-- an empty mapping set. The public API never obtains UPDATE on these tables.
CREATE FUNCTION integration.lock_variant_mapping_writer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old_variant TEXT; new_variant TEXT;
BEGIN
  IF TG_OP<>'INSERT' THEN old_variant:=OLD.variant_id; END IF;
  IF TG_OP<>'DELETE' THEN new_variant:=NEW.variant_id; END IF;
  PERFORM 1 FROM public.product_variant WHERE id IN (old_variant,new_variant) ORDER BY id FOR UPDATE;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_price_mapping_writer BEFORE INSERT OR UPDATE OR DELETE ON public.product_variant_price_set
  FOR EACH ROW EXECUTE FUNCTION integration.lock_variant_mapping_writer();
CREATE TRIGGER commerce_inventory_mapping_writer BEFORE INSERT OR UPDATE OR DELETE ON public.product_variant_inventory_item
  FOR EACH ROW EXECUTE FUNCTION integration.lock_variant_mapping_writer();

CREATE FUNCTION integration.lock_commerce_inputs(target_merchant TEXT, identifiers TEXT[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE variants TEXT[];
BEGIN
  IF cardinality(identifiers)>500 THEN RAISE EXCEPTION 'commerce input bound exceeded' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.product p WHERE p.merchant_id=target_merchant
    AND (p.id=ANY(identifiers) OR p.id IN (SELECT v.product_id FROM public.product_variant v WHERE v.id=ANY(identifiers)))
    ORDER BY p.id FOR SHARE;
  SELECT array_agg(id ORDER BY id) INTO variants FROM public.product_variant
    WHERE id IN (SELECT v.id FROM public.product_variant v JOIN public.product p ON p.id=v.product_id
      WHERE p.merchant_id=target_merchant AND (v.id=ANY(identifiers) OR p.id=ANY(identifiers)));
  PERFORM 1 FROM public.product_variant WHERE id=ANY(variants) ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.price_set WHERE id IN (SELECT price_set_id FROM public.product_variant_price_set
    WHERE variant_id=ANY(variants) AND deleted_at IS NULL) ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.inventory_item WHERE id IN (SELECT inventory_item_id FROM public.product_variant_inventory_item
    WHERE variant_id=ANY(variants) AND deleted_at IS NULL) ORDER BY id FOR SHARE;
END $$;
REVOKE ALL ON FUNCTION integration.lock_price_writer(),integration.lock_variant_mapping_writer(),integration.lock_commerce_inputs(TEXT,TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.lock_commerce_inputs(TEXT,TEXT[]) TO snus_partner_api;
-- Existing runtime writer identities are deployment parameters. Grant their
-- current, already-provisioned writers the lock-only capability; new identities
-- get the same grant from provision-runtime-database-roles.sql after migration.
DO $$ DECLARE writer RECORD; BEGIN
  FOR writer IN SELECT rolname FROM pg_roles WHERE rolcanlogin AND NOT rolsuper
    AND has_table_privilege(oid,'public.product','UPDATE')
    AND has_table_privilege(oid,'public.inventory_level','UPDATE')
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA integration TO %I',writer.rolname);
    EXECUTE format('GRANT EXECUTE ON FUNCTION integration.lock_commerce_inputs(TEXT,TEXT[]) TO %I',writer.rolname);
  END LOOP;
END $$;
