-- Lifecycle versions are independent of subscription, checkout policy and child status.
ALTER TABLE app.merchants
  ADD COLUMN IF NOT EXISTS status_version BIGINT NOT NULL DEFAULT 1
    CHECK (status_version BETWEEN 1 AND 9007199254740991),
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
ALTER TABLE app.stores
  ADD COLUMN IF NOT EXISTS status_version BIGINT NOT NULL DEFAULT 1
    CHECK (status_version BETWEEN 1 AND 9007199254740991),
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;

DO $shape$
DECLARE entity REGCLASS;
BEGIN
  FOREACH entity IN ARRAY ARRAY['app.merchants'::regclass,'app.stores'::regclass] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=entity AND a.attname='status_version' AND NOT a.attisdropped
        AND a.atttypid='bigint'::regtype AND a.attnotnull AND pg_get_expr(d.adbin,d.adrelid)='1'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_attribute a WHERE a.attrelid=entity AND a.attname='status_changed_at'
        AND NOT a.attisdropped AND a.atttypid='timestamptz'::regtype AND NOT a.attnotnull
        AND NOT EXISTS (SELECT 1 FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum)
    ) THEN RAISE EXCEPTION 'Business lifecycle column shape differs for %',entity; END IF;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I',
      entity,split_part(entity::text,'.',2)||'_status_version_check');
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK(status_version BETWEEN 1 AND 9007199254740991)',
      entity,split_part(entity::text,'.',2)||'_status_version_check');
  END LOOP;
END;
$shape$;

ALTER TABLE app.stores DROP CONSTRAINT IF EXISTS stores_status_check;
ALTER TABLE app.stores ADD CONSTRAINT stores_status_check
  CHECK (status IN ('active', 'suspended', 'closed'));

-- NULL deliberately means no trustworthy lifecycle transition timestamp exists yet.
-- The prior-intent exception must fail closed for such inactive entities.
