GRANT SELECT (id,merchant_id,deleted_at) ON public.price_set TO snus_partner_api;
GRANT SELECT (id,variant_id,price_set_id,deleted_at) ON public.product_variant_price_set TO snus_partner_api;
GRANT SELECT (id,price_set_id,currency_code,amount,updated_at,deleted_at,price_list_id,rules_count,min_quantity,max_quantity)
  ON public.price TO snus_partner_api;
