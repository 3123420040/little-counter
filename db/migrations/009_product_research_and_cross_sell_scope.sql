-- 009_product_research_and_cross_sell_scope.sql
-- Release 1.1.2 — Product research persistence and merchant-scoped cross-sell.
-- Additive only; legacy organization rows are retained and mapped when possible.

CREATE SCHEMA IF NOT EXISTS ai_module;

CREATE TABLE IF NOT EXISTS ai_module.product_research_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL DEFAULT 'org_default',
  merchant_id TEXT,
  store_id TEXT,
  product_id TEXT NOT NULL,
  product_title TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  summary TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'medium',
  risk_flags JSONB NOT NULL DEFAULT '[]',
  raw_query TEXT NOT NULL,
  preferred_language TEXT NOT NULL DEFAULT 'vi',
  quota_reservation_token TEXT,
  contradictions JSONB NOT NULL DEFAULT '[]',
  operator_review_status TEXT NOT NULL DEFAULT 'pending',
  operator_reviewed_by TEXT,
  operator_reviewed_at TIMESTAMPTZ,
  operator_notes TEXT NOT NULL DEFAULT '',
  operator_task_draft JSONB NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ai_module.product_research_runs
  ADD COLUMN IF NOT EXISTS merchant_id TEXT,
  ADD COLUMN IF NOT EXISTS store_id TEXT,
  ADD COLUMN IF NOT EXISTS preferred_language TEXT NOT NULL DEFAULT 'vi',
  ADD COLUMN IF NOT EXISTS quota_reservation_token TEXT,
  ADD COLUMN IF NOT EXISTS contradictions JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS operator_review_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS operator_reviewed_by TEXT,
  ADD COLUMN IF NOT EXISTS operator_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS operator_notes TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS operator_task_draft JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS ai_module.product_research_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES ai_module.product_research_runs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  language TEXT,
  rank INT NOT NULL DEFAULT 0
);

ALTER TABLE ai_module.product_research_sources
  ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS ai_module.promotion_strategies (
  id TEXT PRIMARY KEY,
  merchant_id TEXT,
  store_id TEXT,
  name TEXT NOT NULL,
  priority INT NOT NULL DEFAULT 0,
  product_id TEXT,
  category_name TEXT,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ai_module.promotion_strategies
  ADD COLUMN IF NOT EXISTS merchant_id TEXT,
  ADD COLUMN IF NOT EXISTS store_id TEXT;

CREATE TABLE IF NOT EXISTS ai_module.cross_sell_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL DEFAULT 'org_default',
  merchant_id TEXT,
  store_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('accepted')),
  cart_variant_ids TEXT[] NOT NULL DEFAULT '{}',
  accepted_variant_id TEXT NOT NULL,
  accepted_product_id TEXT,
  customer_id TEXT,
  source TEXT NOT NULL DEFAULT 'pos',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ai_module.cross_sell_events
  ADD COLUMN IF NOT EXISTS merchant_id TEXT,
  ADD COLUMN IF NOT EXISTS store_id TEXT;

UPDATE ai_module.product_research_runs r
SET merchant_id = m.id
FROM app.merchants m
WHERE r.merchant_id IS NULL
  AND m.legacy_organization_id = r.organization_id;

UPDATE ai_module.product_research_runs r
SET store_id = s.id
FROM app.stores s
WHERE r.store_id IS NULL
  AND r.merchant_id = s.merchant_id
  AND s.is_primary = true;

UPDATE ai_module.cross_sell_events e
SET merchant_id = m.id
FROM app.merchants m
WHERE e.merchant_id IS NULL
  AND m.legacy_organization_id = e.organization_id;

UPDATE ai_module.cross_sell_events e
SET store_id = s.id
FROM app.stores s
WHERE e.store_id IS NULL
  AND e.merchant_id = s.merchant_id
  AND s.is_primary = true;

UPDATE ai_module.promotion_strategies
SET merchant_id = 'merchant_default'
WHERE merchant_id IS NULL
  AND EXISTS (SELECT 1 FROM app.merchants WHERE id = 'merchant_default');

CREATE INDEX IF NOT EXISTS product_research_runs_merchant_product_idx
  ON ai_module.product_research_runs(merchant_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS product_research_runs_store_idx
  ON ai_module.product_research_runs(store_id, created_at DESC)
  WHERE store_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS promotion_strategies_merchant_store_idx
  ON ai_module.promotion_strategies(merchant_id, store_id, is_active, priority DESC);
CREATE INDEX IF NOT EXISTS cross_sell_events_merchant_store_idx
  ON ai_module.cross_sell_events(merchant_id, store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cross_sell_events_variant_idx
  ON ai_module.cross_sell_events(accepted_variant_id, created_at DESC);
