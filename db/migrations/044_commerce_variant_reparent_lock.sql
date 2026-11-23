-- A move into a product can create the same expansion phantom as INSERT.
-- Lock both stable product parents when the association changes; ordinary
-- variant field updates continue to conflict on the variant row itself.
CREATE FUNCTION integration.lock_variant_reparent_writer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    PERFORM 1 FROM public.product WHERE id IN (OLD.product_id,NEW.product_id) ORDER BY id FOR UPDATE;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_variant_reparent_writer BEFORE UPDATE OF product_id ON public.product_variant
  FOR EACH ROW EXECUTE FUNCTION integration.lock_variant_reparent_writer();
REVOKE ALL ON FUNCTION integration.lock_variant_reparent_writer() FROM PUBLIC;
