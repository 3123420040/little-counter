-- The facade deliberately refuses locations with reservations because legacy
-- POS writers do not implement reservation consumption. Its authorization
-- transaction holds stock_location SHARE. Serialize any reservation change
-- on that same parent so a nonzero hold cannot appear after the guarded check.
CREATE FUNCTION integration.lock_reservation_writer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_location TEXT; next_location TEXT;
BEGIN
  IF TG_OP<>'INSERT' AND OLD.reserved_quantity<>0 THEN previous_location:=OLD.location_id; END IF;
  IF TG_OP<>'DELETE' AND NEW.reserved_quantity<>0 THEN next_location:=NEW.location_id; END IF;
  IF previous_location IS NOT NULL OR next_location IS NOT NULL THEN
    PERFORM 1 FROM public.stock_location WHERE id IN (previous_location,next_location) ORDER BY id FOR UPDATE;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_reservation_writer BEFORE INSERT OR UPDATE OR DELETE ON public.inventory_level
  FOR EACH ROW EXECUTE FUNCTION integration.lock_reservation_writer();
REVOKE ALL ON FUNCTION integration.lock_reservation_writer() FROM PUBLIC;
