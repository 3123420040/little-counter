-- 027_outbox_causality_and_claim_fencing.sql
-- Exact aggregate sequence, source-time provenance and claim fencing.
--
-- Existing rows are deliberately labelled legacy_ambiguous by a metadata-only
-- default. This migration does not assign them a sequence, source identity or
-- exact causal position. Once the insert trigger exists, an unfenced
-- predecessor writer cannot create another ambiguous row.

CREATE TABLE IF NOT EXISTS outbox.aggregate_sequences (
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
  store_id TEXT,
  store_scope_key TEXT GENERATED ALWAYS AS (COALESCE(store_id, '')) STORED,
  aggregate_type TEXT NOT NULL CHECK (aggregate_type <> ''),
  aggregate_id TEXT NOT NULL CHECK (aggregate_id <> ''),
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, store_scope_key, aggregate_type, aggregate_id),
  FOREIGN KEY (merchant_id, store_id)
    REFERENCES app.stores(merchant_id, id) ON UPDATE CASCADE
);

ALTER TABLE outbox.events
  ADD COLUMN IF NOT EXISTS aggregate_sequence BIGINT,
  ADD COLUMN IF NOT EXISTS causality_quality TEXT NOT NULL DEFAULT 'legacy_ambiguous',
  ADD COLUMN IF NOT EXISTS source_occurred_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_event_id TEXT,
  ADD COLUMN IF NOT EXISTS predecessor_event_id UUID,
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claim_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dead_letter_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS failure_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS retry_policy_key TEXT;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'outbox.events'::regclass
      AND conname = 'outbox_events_causality_quality_chk'
  ) THEN
    ALTER TABLE outbox.events
      ADD CONSTRAINT outbox_events_causality_quality_chk
      CHECK (causality_quality IN ('exact', 'legacy_ambiguous')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'outbox.events'::regclass
      AND conname = 'outbox_events_exact_identity_chk'
  ) THEN
    ALTER TABLE outbox.events
      ADD CONSTRAINT outbox_events_exact_identity_chk
      CHECK (
        causality_quality = 'legacy_ambiguous'
        OR (
          merchant_id IS NOT NULL
          AND aggregate_sequence IS NOT NULL
          AND aggregate_sequence > 0
          AND source_occurred_at IS NOT NULL
          AND source_event_id IS NOT NULL
          AND source_event_id <> ''
          AND retry_policy_key IS NOT NULL
          AND retry_policy_key <> ''
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'outbox.events'::regclass
      AND conname = 'outbox_events_claim_version_chk'
  ) THEN
    ALTER TABLE outbox.events
      ADD CONSTRAINT outbox_events_claim_version_chk
      CHECK (claim_version >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'outbox.events'::regclass
      AND conname = 'outbox_events_exact_processing_claim_chk'
  ) THEN
    ALTER TABLE outbox.events
      ADD CONSTRAINT outbox_events_exact_processing_claim_chk
      CHECK (
        causality_quality = 'legacy_ambiguous'
        OR status <> 'processing'
        OR (
          claim_token IS NOT NULL
          AND claim_version > 0
          AND claimed_by IS NOT NULL
          AND claimed_at IS NOT NULL
          AND claimed_until IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END;
$constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_exact_sequence_unique_idx
  ON outbox.events(
    merchant_id,
    COALESCE(store_id, ''),
    aggregate_type,
    aggregate_id,
    aggregate_sequence
  )
  WHERE causality_quality = 'exact';

CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_exact_source_unique_idx
  ON outbox.events(merchant_id, COALESCE(store_id, ''), source_event_id)
  WHERE causality_quality = 'exact';

CREATE INDEX IF NOT EXISTS outbox_events_exact_claim_queue_idx
  ON outbox.events(status, next_retry_at, created_at, id)
  WHERE causality_quality = 'exact'
    AND status IN ('pending', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS outbox_events_exact_aggregate_time_idx
  ON outbox.events(
    merchant_id,
    COALESCE(store_id, ''),
    aggregate_type,
    aggregate_id,
    aggregate_sequence
  )
  WHERE causality_quality = 'exact';

CREATE OR REPLACE VIEW outbox.legacy_ambiguous_events
WITH (security_barrier = true)
AS
SELECT
  id,
  merchant_id,
  store_id,
  aggregate_type,
  aggregate_id,
  event_type,
  occurred_at,
  status,
  attempts,
  last_error,
  created_at
FROM outbox.events
WHERE causality_quality = 'legacy_ambiguous';

CREATE OR REPLACE VIEW outbox.blocked_exact_events
WITH (security_barrier = true)
AS
SELECT
  event.id,
  event.merchant_id,
  event.store_id,
  event.aggregate_type,
  event.aggregate_id,
  event.aggregate_sequence,
  event.event_type,
  event.source_event_id,
  event.source_occurred_at,
  event.status,
  event.attempts,
  event.predecessor_event_id,
  predecessor.status AS predecessor_status,
  CASE
    WHEN predecessor.status = 'dead_lettered' THEN 'dead_predecessor'
    ELSE 'predecessor_incomplete'
  END AS blocked_reason
FROM outbox.events event
JOIN outbox.events predecessor
  ON predecessor.id = event.predecessor_event_id
 AND predecessor.causality_quality = 'exact'
WHERE event.causality_quality = 'exact'
  AND event.aggregate_sequence > 1
  AND event.status IN ('pending', 'failed')
  AND predecessor.status <> 'completed';

CREATE OR REPLACE FUNCTION outbox.allocate_aggregate_sequence(
  p_merchant_id TEXT,
  p_store_id TEXT,
  p_aggregate_type TEXT,
  p_aggregate_id TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $function$
DECLARE
  allocated BIGINT;
BEGIN
  IF p_merchant_id IS NULL OR p_merchant_id = ''
    OR p_aggregate_type IS NULL OR p_aggregate_type = ''
    OR p_aggregate_id IS NULL OR p_aggregate_id = ''
  THEN
    RAISE EXCEPTION 'exact outbox sequence requires merchant and aggregate identity'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app.merchants WHERE id = p_merchant_id) THEN
    RAISE EXCEPTION 'unknown merchant for exact outbox sequence'
      USING ERRCODE = '23503';
  END IF;
  IF p_store_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.stores
    WHERE merchant_id = p_merchant_id AND id = p_store_id
  ) THEN
    RAISE EXCEPTION 'outbox store is not owned by merchant'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO outbox.aggregate_sequences (
    merchant_id,
    store_id,
    aggregate_type,
    aggregate_id,
    last_sequence,
    updated_at
  )
  VALUES (
    p_merchant_id,
    p_store_id,
    p_aggregate_type,
    p_aggregate_id,
    1,
    clock_timestamp()
  )
  ON CONFLICT (merchant_id, store_scope_key, aggregate_type, aggregate_id)
  DO UPDATE SET
    last_sequence = outbox.aggregate_sequences.last_sequence + 1,
    updated_at = clock_timestamp()
  RETURNING last_sequence INTO allocated;

  RETURN allocated;
END;
$function$;

CREATE OR REPLACE FUNCTION outbox.enforce_new_event_causality()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.causality_quality <> 'exact'
    OR NEW.merchant_id IS NULL
    OR NEW.aggregate_sequence IS NULL
    OR NEW.aggregate_sequence <= 0
    OR NEW.source_occurred_at IS NULL
    OR NEW.source_event_id IS NULL
    OR NEW.source_event_id = ''
    OR NEW.retry_policy_key IS NULL
    OR NEW.retry_policy_key = ''
  THEN
    RAISE EXCEPTION 'new outbox event must carry exact causality identity'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.claim_token IS NOT NULL
    OR NEW.claim_version <> 0
    OR NEW.claimed_at IS NOT NULL
    OR NEW.completed_at IS NOT NULL
    OR NEW.dead_lettered_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'new outbox event cannot arrive pre-claimed or completed'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'pending' OR NEW.attempts <> 0 THEN
    RAISE EXCEPTION 'new exact outbox event must start pending'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.store_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.stores
    WHERE merchant_id = NEW.merchant_id AND id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'new outbox event store is not owned by merchant'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM outbox.aggregate_sequences sequence_state
    WHERE sequence_state.merchant_id = NEW.merchant_id
      AND sequence_state.store_id IS NOT DISTINCT FROM NEW.store_id
      AND sequence_state.aggregate_type = NEW.aggregate_type
      AND sequence_state.aggregate_id = NEW.aggregate_id
      AND sequence_state.last_sequence = NEW.aggregate_sequence
  ) THEN
    RAISE EXCEPTION 'aggregate sequence was not allocated in this scope'
      USING ERRCODE = '23514';
  END IF;
  IF (
    NEW.aggregate_sequence = 1 AND NEW.predecessor_event_id IS NOT NULL
  ) OR (
    NEW.aggregate_sequence > 1 AND NOT EXISTS (
      SELECT 1
      FROM outbox.events predecessor
      WHERE predecessor.id = NEW.predecessor_event_id
        AND predecessor.causality_quality = 'exact'
        AND predecessor.merchant_id = NEW.merchant_id
        AND predecessor.store_id IS NOT DISTINCT FROM NEW.store_id
        AND predecessor.aggregate_type = NEW.aggregate_type
        AND predecessor.aggregate_id = NEW.aggregate_id
        AND predecessor.aggregate_sequence = NEW.aggregate_sequence - 1
    )
  ) THEN
    RAISE EXCEPTION 'exact outbox predecessor mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION outbox.reject_outbox_causality_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.causality_quality = 'legacy_ambiguous'
    AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)
  THEN
    RAISE EXCEPTION 'ambiguous legacy outbox event is quarantined'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
    OR NEW.store_id IS DISTINCT FROM OLD.store_id
    OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
    OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
    OR NEW.aggregate_sequence IS DISTINCT FROM OLD.aggregate_sequence
    OR NEW.event_type IS DISTINCT FROM OLD.event_type
    OR NEW.event_version IS DISTINCT FROM OLD.event_version
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
    OR NEW.source_occurred_at IS DISTINCT FROM OLD.source_occurred_at
    OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
    OR NEW.predecessor_event_id IS DISTINCT FROM OLD.predecessor_event_id
    OR NEW.causality_quality IS DISTINCT FROM OLD.causality_quality
    OR NEW.retry_policy_key IS DISTINCT FROM OLD.retry_policy_key
  THEN
    RAISE EXCEPTION 'outbox causal identity and payload are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.causality_quality = 'exact'
    AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)
  THEN
    IF OLD.status IN ('completed', 'dead_lettered') THEN
      RAISE EXCEPTION 'terminal exact outbox event is immutable'
        USING ERRCODE = '55000';
    END IF;

    IF NEW.status = 'processing'
      AND OLD.status IN ('pending', 'failed', 'processing')
    THEN
      IF (OLD.status = 'processing' AND OLD.claimed_until >= clock_timestamp())
        OR (OLD.status IN ('pending', 'failed')
          AND OLD.next_retry_at IS NOT NULL
          AND OLD.next_retry_at > clock_timestamp())
        OR NEW.claim_version <> OLD.claim_version + 1
        OR NEW.claim_token IS NULL
        OR NEW.claim_token IS NOT DISTINCT FROM OLD.claim_token
        OR NEW.attempts <> OLD.attempts + 1
        OR NEW.claimed_by IS NULL
        OR NEW.claimed_by = ''
        OR NEW.claimed_at IS NULL
        OR NEW.claimed_until IS NULL
        OR NEW.claimed_until <= clock_timestamp()
        OR NEW.completed_at IS NOT NULL
        OR NEW.dead_lettered_at IS NOT NULL
        OR NEW.dead_letter_reason_code IS NOT NULL
      THEN
        RAISE EXCEPTION 'exact outbox claim transition is invalid'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.status = 'processing'
      AND NEW.status IN ('completed', 'failed', 'dead_lettered')
    THEN
      IF NEW.claim_version <> OLD.claim_version
        OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
        OR NEW.claimed_by IS DISTINCT FROM OLD.claimed_by
        OR NEW.attempts <> OLD.attempts
        OR NEW.claimed_until IS NOT NULL
        OR (NEW.status = 'completed' AND (
          NEW.completed_at IS NULL
          OR NEW.next_retry_at IS NOT NULL
          OR NEW.last_error IS NOT NULL
        ))
        OR (NEW.status = 'failed' AND (
          NEW.next_retry_at IS NULL
          OR NEW.last_error IS NULL
          OR NEW.last_error = ''
          OR NEW.failure_fingerprint IS NULL
          OR NEW.failure_fingerprint !~ '^[a-f0-9]{64}$'
        ))
        OR (NEW.status = 'dead_lettered' AND (
          NEW.dead_lettered_at IS NULL
          OR NEW.dead_letter_reason_code IS NULL
          OR NEW.dead_letter_reason_code = ''
          OR NEW.last_error IS NULL
          OR NEW.last_error = ''
          OR NEW.failure_fingerprint IS NULL
          OR NEW.failure_fingerprint !~ '^[a-f0-9]{64}$'
        ))
      THEN
        RAISE EXCEPTION 'exact outbox claim transition is invalid'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'exact outbox claim transition is invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION outbox.reject_outbox_event_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'outbox events are append-only'
    USING ERRCODE = '55000';
END;
$function$;

CREATE OR REPLACE FUNCTION outbox.claim_exact_events(
  p_worker_id TEXT,
  p_limit INT DEFAULT 50,
  p_lease_seconds INT DEFAULT 60
)
RETURNS TABLE(event_id UUID, claim_token UUID, claim_version BIGINT)
LANGUAGE plpgsql
AS $function$
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'claim requires worker identity' USING ERRCODE = '23514';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'claim limit must be between 1 and 200' USING ERRCODE = '23514';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 5 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'claim lease must be between 5 and 300 seconds' USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT e.id
    FROM outbox.events e
    WHERE e.causality_quality = 'exact'
      AND (
        (e.status IN ('pending', 'failed')
          AND (e.next_retry_at IS NULL OR e.next_retry_at <= clock_timestamp()))
        OR (e.status = 'processing' AND e.claimed_until < clock_timestamp())
      )
      AND (
        e.aggregate_sequence = 1
        OR EXISTS (
          SELECT 1
          FROM outbox.events predecessor
          WHERE predecessor.id = e.predecessor_event_id
            AND predecessor.causality_quality = 'exact'
            AND predecessor.merchant_id = e.merchant_id
            AND predecessor.store_id IS NOT DISTINCT FROM e.store_id
            AND predecessor.aggregate_type = e.aggregate_type
            AND predecessor.aggregate_id = e.aggregate_id
            AND predecessor.aggregate_sequence = e.aggregate_sequence - 1
            AND predecessor.status = 'completed'
        )
      )
    ORDER BY e.created_at, e.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), tokens AS (
    SELECT candidates.id, gen_random_uuid() AS token
    FROM candidates
  ), claimed AS (
    UPDATE outbox.events e
    SET
      status = 'processing',
      attempts = e.attempts + 1,
      claimed_by = p_worker_id,
      claimed_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
      claim_token = tokens.token,
      claim_version = e.claim_version + 1,
      claimed_at = clock_timestamp(),
      next_retry_at = NULL,
      last_error = NULL,
      failure_fingerprint = NULL,
      completed_at = NULL,
      dead_lettered_at = NULL,
      dead_letter_reason_code = NULL
    FROM tokens
    WHERE e.id = tokens.id
    RETURNING e.id, e.claim_token, e.claim_version
  )
  SELECT claimed.id, claimed.claim_token, claimed.claim_version
  FROM claimed;
END;
$function$;

CREATE OR REPLACE FUNCTION outbox.complete_exact_event_claim(
  p_event_id UUID,
  p_worker_id TEXT,
  p_claim_token UUID,
  p_claim_version BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $function$
DECLARE
  completion_time TIMESTAMPTZ := clock_timestamp();
BEGIN
  UPDATE outbox.events
  SET
    status = 'completed',
    completed_at = completion_time,
    claimed_until = NULL,
    next_retry_at = NULL,
    last_error = NULL
  WHERE id = p_event_id
    AND causality_quality = 'exact'
    AND status = 'processing'
    AND claimed_by = p_worker_id
    AND claim_token = p_claim_token
    AND claim_version = p_claim_version
    AND claimed_until >= completion_time;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION outbox.fail_exact_event_claim(
  p_event_id UUID,
  p_worker_id TEXT,
  p_claim_token UUID,
  p_claim_version BIGINT,
  p_error TEXT,
  p_failure_fingerprint TEXT,
  p_retry_at TIMESTAMPTZ,
  p_dead_letter BOOLEAN,
  p_dead_letter_reason_code TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $function$
DECLARE
  decision_time TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_error IS NULL OR p_error = '' THEN
    RAISE EXCEPTION 'failed claim requires error evidence' USING ERRCODE = '23514';
  END IF;
  IF p_failure_fingerprint IS NULL
    OR p_failure_fingerprint !~ '^[a-f0-9]{64}$'
  THEN
    RAISE EXCEPTION 'failure fingerprint must be SHA-256' USING ERRCODE = '23514';
  END IF;
  IF p_dead_letter IS NULL THEN
    RAISE EXCEPTION 'failed claim requires an explicit dead-letter decision'
      USING ERRCODE = '23514';
  END IF;
  IF p_dead_letter AND (
    p_dead_letter_reason_code IS NULL OR p_dead_letter_reason_code = ''
  ) THEN
    RAISE EXCEPTION 'dead letter requires a reason code' USING ERRCODE = '23514';
  END IF;
  IF NOT p_dead_letter AND p_retry_at IS NULL THEN
    RAISE EXCEPTION 'retryable failure requires next retry time' USING ERRCODE = '23514';
  END IF;
  IF NOT p_dead_letter AND (
    p_retry_at <= decision_time
    OR p_retry_at > decision_time + INTERVAL '1 hour'
  ) THEN
    RAISE EXCEPTION 'retry time must be in the future and within one hour'
      USING ERRCODE = '23514';
  END IF;

  UPDATE outbox.events
  SET
    status = CASE WHEN p_dead_letter THEN 'dead_lettered' ELSE 'failed' END,
    last_error = p_error,
    failure_fingerprint = p_failure_fingerprint,
    next_retry_at = CASE WHEN p_dead_letter THEN NULL ELSE p_retry_at END,
    claimed_until = NULL,
    dead_lettered_at = CASE WHEN p_dead_letter THEN decision_time ELSE NULL END,
    dead_letter_reason_code = CASE
      WHEN p_dead_letter THEN p_dead_letter_reason_code
      ELSE NULL
    END
  WHERE id = p_event_id
    AND causality_quality = 'exact'
    AND status = 'processing'
    AND claimed_by = p_worker_id
    AND claim_token = p_claim_token
    AND claim_version = p_claim_version
    AND claimed_until >= decision_time;
  RETURN FOUND;
END;
$function$;

DO $triggers$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'outbox.events'::regclass
      AND tgname = 'outbox_events_exact_insert_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER outbox_events_exact_insert_trg
      BEFORE INSERT ON outbox.events
      FOR EACH ROW EXECUTE FUNCTION outbox.enforce_new_event_causality();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'outbox.events'::regclass
      AND tgname = 'outbox_events_causal_identity_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER outbox_events_causal_identity_immutable_trg
      BEFORE UPDATE ON outbox.events
      FOR EACH ROW EXECUTE FUNCTION outbox.reject_outbox_causality_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'outbox.events'::regclass
      AND tgname = 'outbox_events_append_only_delete_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER outbox_events_append_only_delete_trg
      BEFORE DELETE ON outbox.events
      FOR EACH ROW EXECUTE FUNCTION outbox.reject_outbox_event_delete();
  END IF;
END;
$triggers$;

REVOKE UPDATE (
  merchant_id,
  store_id,
  aggregate_type,
  aggregate_id,
  aggregate_sequence,
  event_type,
  event_version,
  payload,
  occurred_at,
  source_occurred_at,
  source_event_id,
  predecessor_event_id,
  causality_quality,
  retry_policy_key
) ON outbox.events FROM PUBLIC;

REVOKE DELETE ON outbox.events FROM PUBLIC;
