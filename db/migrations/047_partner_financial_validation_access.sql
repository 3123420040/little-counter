-- Deferred payment bundle validator checks delta rows even for initial COD.
-- Read only: partner cannot create correction deltas or staff refunds.
GRANT SELECT ON app.payment_correction_component_deltas TO snus_partner_api;
