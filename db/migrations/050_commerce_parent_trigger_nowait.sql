-- Row triggers run after PostgreSQL acquires the child tuple lock. Waiting
-- for a parent held by a booking reader would invert parent-before-child order.
-- NOWAIT aborts this rare operational writer immediately with retryable 55P03;
-- the caller must roll back/retry the whole transaction. No stock can oversell.
CREATE OR REPLACE FUNCTION integration.lock_variant_reparent_writer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    PERFORM 1 FROM public.product WHERE id IN (OLD.product_id,NEW.product_id) ORDER BY id FOR UPDATE NOWAIT;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION integration.lock_reservation_writer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_location TEXT; next_location TEXT;
BEGIN
  IF TG_OP<>'INSERT' AND OLD.reserved_quantity<>0 THEN previous_location:=OLD.location_id; END IF;
  IF TG_OP<>'DELETE' AND NEW.reserved_quantity<>0 THEN next_location:=NEW.location_id; END IF;
  IF previous_location IS NOT NULL OR next_location IS NOT NULL THEN
    PERFORM 1 FROM public.stock_location WHERE id IN (previous_location,next_location) ORDER BY id FOR UPDATE NOWAIT;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

