-- Expand ownership without changing visible codes or identifiers.
ALTER TABLE public.product_variant ADD COLUMN merchant_id text;
ALTER TABLE public.inventory_item ADD COLUMN merchant_id text;
DO $$ BEGIN
  IF EXISTS(SELECT m.inventory_item_id FROM public.product_variant_inventory_item m
    LEFT JOIN public.product_variant v ON v.id=m.variant_id LEFT JOIN public.product p ON p.id=v.product_id
    GROUP BY m.inventory_item_id HAVING count(DISTINCT p.merchant_id)>1 OR bool_or(p.merchant_id IS NULL)) THEN
    RAISE EXCEPTION 'Ambiguous or orphan inventory ownership';
  END IF;
END $$;
UPDATE public.product_variant v SET merchant_id=p.merchant_id FROM public.product p WHERE p.id=v.product_id;
UPDATE public.inventory_item i SET merchant_id=x.merchant_id FROM (
 SELECT m.inventory_item_id,min(v.merchant_id) merchant_id FROM public.product_variant_inventory_item m
 JOIN public.product_variant v ON v.id=m.variant_id GROUP BY m.inventory_item_id
) x WHERE i.id=x.inventory_item_id;
ALTER TABLE public.product_variant ADD CONSTRAINT catalog_variant_merchant_fk FOREIGN KEY(merchant_id) REFERENCES app.merchants(id);
ALTER TABLE public.inventory_item ADD CONSTRAINT catalog_item_merchant_fk FOREIGN KEY(merchant_id) REFERENCES app.merchants(id);
