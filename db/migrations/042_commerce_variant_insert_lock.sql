-- The legacy product-id sale input expands a product into its variants. A new
-- variant must serialize with that expansion, including an initially empty set.
-- Ordinary updates/deletes already conflict with the variant SHARE row locks.
CREATE FUNCTION integration.lock_variant_insert_writer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM 1 FROM public.product WHERE id=NEW.product_id FOR UPDATE;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_variant_insert_writer BEFORE INSERT ON public.product_variant
  FOR EACH ROW EXECUTE FUNCTION integration.lock_variant_insert_writer();
REVOKE ALL ON FUNCTION integration.lock_variant_insert_writer() FROM PUBLIC;
