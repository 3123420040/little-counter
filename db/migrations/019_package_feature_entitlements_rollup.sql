-- 019_package_feature_entitlements_rollup.sql
-- Release 1.4 — Package feature entitlement rollup after 1.3/1.4.
--
-- Keep the original 1.1.2 package catalog migration immutable. Later product
-- capabilities are appended here so production checksum-ledger deployments can
-- advance without rewriting already-applied migration history.

WITH desired_features(package_key, feature_key, sort_order) AS (
    VALUES
        ('plus', 'customer_scan_go', 1000),
        ('ai_fan', 'customer_scan_go', 1000),
        ('ai_fan', 'vision_pos_input', 1010),
        ('ai_fan', 'vision_pos_single_capture', 1020),
        ('ai_fan', 'vision_correction_report', 1030)
)
UPDATE app.package_catalog_versions pcv
SET feature_keys = (
    SELECT COALESCE(jsonb_agg(feature_key ORDER BY first_seen), '[]'::jsonb)
    FROM (
        SELECT feature_key, MIN(position) AS first_seen
        FROM (
            SELECT existing.feature_key, existing.position
            FROM jsonb_array_elements_text(pcv.feature_keys)
                WITH ORDINALITY AS existing(feature_key, position)
            UNION ALL
            SELECT desired.feature_key, desired.sort_order
            FROM desired_features desired
            WHERE desired.package_key = pcv.package_key
        ) merged
        GROUP BY feature_key
    ) deduped
)
WHERE pcv.package_key IN ('plus', 'ai_fan');
