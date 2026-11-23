-- Count all creation evidence for an order, including conflicting scope/actors.
-- Leading organization_id in the older index cannot bound this global check.
CREATE INDEX IF NOT EXISTS order_creator_provenance_idx
  ON audit.events(subject_id)
  INCLUDE (actor_id, actor_type, merchant_id, store_id)
  WHERE subject_type = 'order'
    AND action IN ('order.created', 'order.remote_created', 'order.partner_created');
