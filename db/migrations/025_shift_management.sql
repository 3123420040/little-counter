-- 025_shift_management.sql
-- Shift Operations & Handover Management foundation.
--
-- Additive and repeat-safe:
--   * Shift policy defaults are disabled; rollout is opt-in per store/location.
--   * Shift state is app-owned operational evidence, not accounting state.
--   * Quick stock counts store discrepancy evidence only and do not mutate stock.

INSERT INTO app.permissions (id, description) VALUES
  ('shift:open', 'Open POS shifts and acknowledge handovers'),
  ('shift:close', 'Close POS shifts and record close evidence'),
  ('shift:read', 'Read POS shift status and shift history'),
  ('shift:cash_adjust', 'Record operational shift cash movements'),
  ('shift:review', 'Approve or flag closed shift reviews'),
  ('shift:manage', 'Manage stale shifts and force-close operational shifts'),
  ('shift:report', 'Read full shift reconciliation and productivity reports')
ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO app.role_permissions (role, permission_id) VALUES
  ('staff', 'shift:open'),
  ('staff', 'shift:close'),
  ('staff', 'shift:read'),
  ('staff', 'shift:cash_adjust'),
  ('manager', 'shift:open'),
  ('manager', 'shift:close'),
  ('manager', 'shift:read'),
  ('manager', 'shift:cash_adjust'),
  ('manager', 'shift:review'),
  ('manager', 'shift:manage'),
  ('manager', 'shift:report'),
  ('owner', 'shift:open'),
  ('owner', 'shift:close'),
  ('owner', 'shift:read'),
  ('owner', 'shift:cash_adjust'),
  ('owner', 'shift:review'),
  ('owner', 'shift:manage'),
  ('owner', 'shift:report')
ON CONFLICT (role, permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS app.shift_policies (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
  store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
  stock_location_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  enforce_shift_on_pos BOOLEAN NOT NULL DEFAULT false,
  allow_offline_cached_shift BOOLEAN NOT NULL DEFAULT true,
  blind_close_cash BOOLEAN NOT NULL DEFAULT true,
  require_handover_ack BOOLEAN NOT NULL DEFAULT false,
  quick_stock_count_required BOOLEAN NOT NULL DEFAULT false,
  max_open_duration_minutes INT NOT NULL DEFAULT 960 CHECK (max_open_duration_minutes > 0),
  stale_after_minutes INT NOT NULL DEFAULT 1080 CHECK (stale_after_minutes > 0),
  cash_discrepancy_alert_threshold NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (cash_discrepancy_alert_threshold >= 0),
  stock_discrepancy_alert_threshold INT NOT NULL DEFAULT 1 CHECK (stock_discrepancy_alert_threshold >= 0),
  checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, store_id, stock_location_id)
);

CREATE INDEX IF NOT EXISTS shift_policies_scope_enabled_idx
  ON app.shift_policies(merchant_id, store_id, stock_location_id, enabled);

CREATE TABLE IF NOT EXISTS app.work_shifts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL DEFAULT 'org_default',
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
  store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
  stock_location_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closing','closed','force_closed','voided')),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('not_required','pending','approved','flagged')),
  z_number INT CHECK (z_number IS NULL OR z_number > 0),
  opened_by TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  opening_cash_amount NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (opening_cash_amount >= 0),
  opening_note TEXT,
  close_started_at TIMESTAMPTZ,
  closed_by TEXT,
  closed_at TIMESTAMPTZ,
  force_closed_by TEXT,
  force_closed_at TIMESTAMPTZ,
  blind_cash_count_amount NUMERIC(20,0) CHECK (blind_cash_count_amount IS NULL OR blind_cash_count_amount >= 0),
  expected_cash_amount NUMERIC(20,0),
  cash_variance_amount NUMERIC(20,0),
  closing_note TEXT,
  outgoing_handover_note TEXT,
  z_report_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  review_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS work_shifts_one_active_scope_idx
  ON app.work_shifts(merchant_id, store_id, stock_location_id)
  WHERE status IN ('open','closing');

CREATE UNIQUE INDEX IF NOT EXISTS work_shifts_store_z_number_idx
  ON app.work_shifts(merchant_id, store_id, z_number)
  WHERE z_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS work_shifts_scope_opened_idx
  ON app.work_shifts(merchant_id, store_id, opened_at DESC);

CREATE INDEX IF NOT EXISTS work_shifts_operator_opened_idx
  ON app.work_shifts(merchant_id, store_id, opened_by, opened_at DESC);

CREATE INDEX IF NOT EXISTS work_shifts_review_queue_idx
  ON app.work_shifts(merchant_id, store_id, review_status, closed_at DESC);

CREATE TABLE IF NOT EXISTS app.shift_cash_movements (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES app.work_shifts(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
  store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
  stock_location_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('pay_in','pay_out','cash_drop','cash_correction')),
  amount NUMERIC(20,0) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  reason_code TEXT,
  performed_by TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shift_cash_movements_shift_time_idx
  ON app.shift_cash_movements(merchant_id, store_id, shift_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS shift_cash_movements_type_time_idx
  ON app.shift_cash_movements(merchant_id, store_id, type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS app.shift_stock_counts (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES app.work_shifts(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
  store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
  stock_location_id TEXT NOT NULL,
  count_type TEXT NOT NULL DEFAULT 'quick' CHECK (count_type IN ('quick','close')),
  inventory_item_id TEXT NOT NULL,
  product_id TEXT,
  variant_id TEXT,
  sku_snapshot TEXT,
  product_title_snapshot TEXT,
  system_quantity INT NOT NULL,
  counted_quantity INT NOT NULL CHECK (counted_quantity >= 0),
  discrepancy_quantity INT NOT NULL,
  reason TEXT,
  counted_by TEXT NOT NULL,
  counted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shift_stock_counts_shift_time_idx
  ON app.shift_stock_counts(merchant_id, store_id, stock_location_id, shift_id, counted_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS shift_stock_counts_unique_item_count_type_idx
  ON app.shift_stock_counts(shift_id, inventory_item_id, count_type);

CREATE TABLE IF NOT EXISTS app.shift_handover_acknowledgements (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
  store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
  stock_location_id TEXT NOT NULL,
  previous_shift_id TEXT NOT NULL REFERENCES app.work_shifts(id) ON DELETE RESTRICT,
  receiving_shift_id TEXT REFERENCES app.work_shifts(id) ON DELETE SET NULL,
  acknowledged_by TEXT NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledgement_note TEXT,
  received_opening_cash_amount NUMERIC(20,0) CHECK (
    received_opening_cash_amount IS NULL OR received_opening_cash_amount >= 0
  ),
  acknowledged_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  snapshot_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shift_handover_ack_scope_time_idx
  ON app.shift_handover_acknowledgements(merchant_id, store_id, stock_location_id, acknowledged_at DESC);

CREATE INDEX IF NOT EXISTS shift_handover_ack_previous_idx
  ON app.shift_handover_acknowledgements(previous_shift_id, acknowledged_at DESC);

CREATE INDEX IF NOT EXISTS shift_handover_ack_receiving_idx
  ON app.shift_handover_acknowledgements(receiving_shift_id)
  WHERE receiving_shift_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app.shift_events (
  id TEXT PRIMARY KEY,
  shift_id TEXT REFERENCES app.work_shifts(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
  store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
  stock_location_id TEXT,
  event_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT,
  before JSONB,
  after JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shift_events_shift_time_idx
  ON app.shift_events(merchant_id, store_id, shift_id, created_at DESC);

CREATE INDEX IF NOT EXISTS shift_events_type_time_idx
  ON app.shift_events(merchant_id, store_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS order_shift_id_idx
  ON public."order" ((metadata->>'shiftId'))
  WHERE deleted_at IS NULL AND metadata ? 'shiftId';

CREATE INDEX IF NOT EXISTS order_scope_created_idx
  ON public."order"(merchant_id, store_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS payment_entries_scope_order_created_idx
  ON app.payment_entries(merchant_id, store_id, order_id, created_at DESC)
  WHERE merchant_id IS NOT NULL AND store_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_intents_scope_status_created_idx
  ON app.payment_intents(merchant_id, store_id, status, created_at DESC)
  WHERE merchant_id IS NOT NULL AND store_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS stock_movements_scope_reference_idx
  ON medusa.stock_movements(merchant_id, store_id, stock_location_id, reference_type, reference_id, created_at DESC)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
