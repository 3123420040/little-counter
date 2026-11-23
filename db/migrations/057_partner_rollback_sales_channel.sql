-- Keep partner provenance while making stored core orders readable by the
-- selected 2.1 rollback image, whose sales-channel enum predates partner_api.
UPDATE public."order" core
SET metadata=jsonb_set(core.metadata,'{salesChannel}','"website"'::jsonb,false)
WHERE core.metadata->>'sourceFlow'='partner_api_v1'
  AND core.metadata->>'salesChannel'='partner_api'
  AND EXISTS(SELECT 1 FROM integration.partner_orders partner WHERE partner.core_order_id=core.id);
