-- Deferred core commit constraints verify collection revision coverage. The
-- trigger-owned bump function still owns all mutations of these two tables.
GRANT SELECT ON app.order_collection_revision_events,app.order_collection_revisions TO snus_partner_api;
