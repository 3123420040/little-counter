import { randomBytes } from "node:crypto";
import { hash as hashPassword } from "bcrypt";
import { connectPlatformClient, type PoolClient } from "./client";
import { rawNumber } from "./raw-number";
import { ensureRetailPaymentEvidenceSchema } from "./retail-payment-evidence-schema";
import { withConnectedClient } from "./transaction";

let schemaReady: Promise<void> | null = null;

const DEMO_PRODUCTS = [
  {
    id: "prod_mint",
    variantId: "var_mint_20",
    sku: "MINT-MED-20",
    barcode: "8930000000011",
    title: "Mint Medium Pouch",
    price: 250000,
    costPrice: 175000,
    stock: 10,
    reorderLevel: 5,
  },
  {
    id: "prod_citrus",
    variantId: "var_citrus_20",
    sku: "CITRUS-LOW-20",
    barcode: "8930000000012",
    title: "Citrus Low Pouch",
    price: 230000,
    costPrice: 160000,
    stock: 15,
    reorderLevel: 5,
  },
  {
    id: "prod_berry",
    variantId: "var_berry_20",
    sku: "BERRY-STRONG-20",
    barcode: "8930000000013",
    title: "Berry Strong Pouch",
    price: 280000,
    costPrice: 195000,
    stock: 2,
    reorderLevel: 5,
  },
  {
    id: "prod_mint_slim",
    variantId: "var_mint_slim_20",
    sku: "MINT-SLIM-20",
    barcode: "8930000000014",
    title: "Mint Slim Pack",
    price: 180000,
    costPrice: 125000,
    stock: 15,
    reorderLevel: 5,
  },
  {
    id: "prod_wintergreen",
    variantId: "var_wintergreen_20",
    sku: "WINTER-STRONG-20",
    barcode: "8930000000015",
    title: "Wintergreen Strong",
    price: 260000,
    costPrice: 180000,
    stock: 8,
    reorderLevel: 5,
  },
  {
    id: "prod_coffee",
    variantId: "var_coffee_20",
    sku: "COFFEE-MED-20",
    barcode: "8930000000016",
    title: "Coffee Medium",
    price: 240000,
    costPrice: 168000,
    stock: 12,
    reorderLevel: 5,
  },
] as const;

export function shouldRunPlatformSchemaBootstrap(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NODE_ENV === "production") return false;
  if (env.PLATFORM_RUNTIME_SCHEMA_BOOTSTRAP_ENABLED !== undefined) {
    return env.PLATFORM_RUNTIME_SCHEMA_BOOTSTRAP_ENABLED === "true";
  }
  return env.NODE_ENV === "test";
}

export async function ensurePlatformSchema(): Promise<void> {
  // Servers using an existing database must use the migration ledger for schema changes.
  if (!shouldRunPlatformSchemaBootstrap()) return;
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = await connectPlatformClient();
      try {
        await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
        await client.query("CREATE SCHEMA IF NOT EXISTS app");
        await client.query("CREATE SCHEMA IF NOT EXISTS inventory");
        await client.query("CREATE SCHEMA IF NOT EXISTS notification");
        await client.query("CREATE SCHEMA IF NOT EXISTS ai_module");

        await client.query(`
          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'accounting' AND table_name = 'journal_entries'
                AND column_name = 'reference_id' AND data_type <> 'text'
            ) THEN
              ALTER TABLE accounting.journal_entries ALTER COLUMN reference_id TYPE TEXT USING reference_id::text;
            END IF;
            IF to_regclass('accounting.journal_entries') IS NOT NULL THEN
              ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS merchant_id TEXT;
              ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS store_id TEXT;
            END IF;
            IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'medusa' AND table_name = 'stock_movements'
                AND column_name = 'reference_id' AND data_type <> 'text'
            ) THEN
              ALTER TABLE medusa.stock_movements ALTER COLUMN reference_id TYPE TEXT USING reference_id::text;
            END IF;
            IF to_regclass('outbox.events') IS NOT NULL THEN
              ALTER TABLE outbox.events ADD COLUMN IF NOT EXISTS merchant_id TEXT;
              ALTER TABLE outbox.events ADD COLUMN IF NOT EXISTS store_id TEXT;
              CREATE INDEX IF NOT EXISTS outbox_events_merchant_pending_idx
                ON outbox.events(merchant_id, created_at)
                WHERE merchant_id IS NOT NULL AND status = 'pending';
              CREATE INDEX IF NOT EXISTS outbox_events_store_idx
                ON outbox.events(store_id, created_at)
                WHERE store_id IS NOT NULL;
            END IF;
            IF to_regclass('ai_module.customer_profiles') IS NOT NULL THEN
              ALTER TABLE ai_module.customer_profiles ADD COLUMN IF NOT EXISTS merchant_id TEXT;
            END IF;
            IF to_regclass('ai_module.loyalty_records') IS NOT NULL THEN
              ALTER TABLE ai_module.loyalty_records ADD COLUMN IF NOT EXISTS merchant_id TEXT;
            END IF;
            IF to_regclass('ai_module.loyalty_tiers') IS NOT NULL THEN
              ALTER TABLE ai_module.loyalty_tiers ADD COLUMN IF NOT EXISTS merchant_id TEXT;
              ALTER TABLE ai_module.loyalty_tiers DROP CONSTRAINT IF EXISTS loyalty_tiers_name_key;
              CREATE UNIQUE INDEX IF NOT EXISTS loyalty_tiers_merchant_name_unique_idx
                ON ai_module.loyalty_tiers(merchant_id, name)
                WHERE merchant_id IS NOT NULL;
            END IF;
            IF to_regclass('ai_module.actions') IS NOT NULL THEN
              ALTER TABLE ai_module.actions ADD COLUMN IF NOT EXISTS merchant_id TEXT;
              ALTER TABLE ai_module.actions ADD COLUMN IF NOT EXISTS store_id TEXT;
              CREATE INDEX IF NOT EXISTS ai_actions_merchant_idx
                ON ai_module.actions(merchant_id, created_at DESC)
                WHERE merchant_id IS NOT NULL;
              CREATE INDEX IF NOT EXISTS ai_actions_store_idx
                ON ai_module.actions(store_id, created_at DESC)
                WHERE store_id IS NOT NULL;
            END IF;
            IF to_regclass('medusa.stock_movements') IS NOT NULL THEN
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS merchant_id TEXT;
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS store_id TEXT;
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS stock_location_id TEXT;
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS product_id TEXT;
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS variant_id TEXT;
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS sku_snapshot TEXT;
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS product_title_snapshot TEXT;
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS source_action TEXT;
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS reason_code TEXT;
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS reference_display TEXT;
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS actor_display_name_snapshot TEXT;
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS actor_role_snapshot TEXT;
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS actual_operator_id TEXT;
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS source_channel TEXT;
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS correlation_id TEXT;
              ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
              UPDATE medusa.stock_movements
              SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('historyQuality', 'backfilled')
              WHERE NOT COALESCE(metadata, '{}'::jsonb) ? 'historyQuality';
              CREATE INDEX IF NOT EXISTS stock_movements_scope_item_created_idx
                ON medusa.stock_movements(merchant_id, store_id, stock_location_id, inventory_item_id, created_at DESC, id DESC);
              CREATE INDEX IF NOT EXISTS stock_movements_scope_product_created_idx
                ON medusa.stock_movements(merchant_id, store_id, stock_location_id, product_id, created_at DESC, id DESC)
                WHERE product_id IS NOT NULL;
              CREATE INDEX IF NOT EXISTS stock_movements_scope_action_created_idx
                ON medusa.stock_movements(merchant_id, store_id, stock_location_id, movement_type, created_at DESC, id DESC);
	              CREATE INDEX IF NOT EXISTS stock_movements_scope_actor_created_idx
	                ON medusa.stock_movements(merchant_id, store_id, stock_location_id, performed_by, created_at DESC, id DESC);
	              CREATE INDEX IF NOT EXISTS stock_movements_scope_reference_idx
	                ON medusa.stock_movements(merchant_id, store_id, stock_location_id, reference_type, reference_id, created_at DESC)
	                WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
	            END IF;
	          END $$;
	        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS app.idempotency_records (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            idempotency_key TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            response JSONB NOT NULL,
            tenant_id TEXT,
            operation TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days')
          );

          CREATE TABLE IF NOT EXISTS app.auth_login_failures (
            account_hash TEXT NOT NULL,
            ip_hash TEXT NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
            first_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            blocked_until TIMESTAMPTZ,
            last_failure_code TEXT NOT NULL,
            PRIMARY KEY (account_hash, ip_hash)
          );
          CREATE INDEX IF NOT EXISTS auth_login_failures_retention_idx
            ON app.auth_login_failures(last_attempt_at);
        `);
        // Ensure the tenant-scoped columns exist even if the table pre-exists
        // from an older schema.ts/migration (CREATE TABLE IF NOT EXISTS does
        // not add columns). The scoped unique indexes are created by migration
        // 014 once the columns are guaranteed present. Guard with IF EXISTS so
        // a brand-new DB (where CREATE TABLE just created the columns) does
        // not error.
        await client.query(`
          DO $$
          BEGIN
              IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'app' AND table_name = 'idempotency_records') THEN
                  ALTER TABLE app.idempotency_records ADD COLUMN IF NOT EXISTS tenant_id TEXT;
                  ALTER TABLE app.idempotency_records ADD COLUMN IF NOT EXISTS operation TEXT;
                  -- Migration 014 replaces the global UNIQUE on idempotency_key
                  -- with a partial legacy index + a scoped (tenant_id, operation,
                  -- idempotency_key) unique index. Apply the drop here so DB
                  -- tests/bootstrap that do not run the migration runner still
                  -- pick up the constraint change.
                  ALTER TABLE app.idempotency_records
                      DROP CONSTRAINT IF EXISTS idempotency_records_idempotency_key_key;
              END IF;
          END $$;
        `);
        await client.query("DROP INDEX IF EXISTS app.app_idempotency_key_idx");

        await client.query(`
          CREATE TABLE IF NOT EXISTS app.package_entitlements (
            organization_id TEXT NOT NULL DEFAULT 'org_default',
            package_key TEXT NOT NULL CHECK (package_key IN ('basic', 'plus', 'ai_fan')),
            effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
            effective_to TIMESTAMPTZ,
            metadata JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (organization_id, package_key, effective_from)
          );
          CREATE INDEX IF NOT EXISTS package_entitlements_active_idx
            ON app.package_entitlements(organization_id, effective_to, effective_from DESC);

          CREATE TABLE IF NOT EXISTS app.feature_entitlements (
            organization_id TEXT NOT NULL DEFAULT 'org_default',
            feature_key TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT false,
            package_key TEXT NOT NULL CHECK (package_key IN ('basic', 'plus', 'ai_fan')),
            limits JSONB NOT NULL DEFAULT '{}',
            metadata JSONB NOT NULL DEFAULT '{}',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (organization_id, feature_key)
          );


          -- Bootstrap stubs for tenant entities created in migration 002 so that
          -- subscription/usage tables satisfy their FKs in local/dev/test envs.
          -- Production runs migrations 002 then 004 in order.
          CREATE TABLE IF NOT EXISTS app.merchants (
            id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL DEFAULT '',
            legacy_organization_id TEXT NOT NULL DEFAULT 'org_default',
            status TEXT NOT NULL DEFAULT 'active',
            status_version BIGINT NOT NULL DEFAULT 1 CHECK (status_version BETWEEN 1 AND 9007199254740991),
            status_changed_at TIMESTAMPTZ,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE TABLE IF NOT EXISTS app.stores (
            id TEXT PRIMARY KEY,
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            display_name TEXT NOT NULL DEFAULT '',
            stock_location_id TEXT NOT NULL DEFAULT '',
            is_primary BOOLEAN NOT NULL DEFAULT false,
            status TEXT NOT NULL DEFAULT 'active',
            status_version BIGINT NOT NULL DEFAULT 1 CHECK (status_version BETWEEN 1 AND 9007199254740991),
            status_changed_at TIMESTAMPTZ,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE IF NOT EXISTS app.product_qr_codes (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
            product_id TEXT NOT NULL,
            variant_id TEXT NOT NULL,
            slug TEXT NOT NULL,
            public_url_path TEXT NOT NULL,
            payload_version INT NOT NULL DEFAULT 1,
            print_version INT NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
            product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            disabled_at TIMESTAMPTZ
          );
          CREATE UNIQUE INDEX IF NOT EXISTS product_qr_codes_slug_unique_idx
            ON app.product_qr_codes(slug);
          CREATE UNIQUE INDEX IF NOT EXISTS product_qr_codes_store_variant_unique_idx
            ON app.product_qr_codes(merchant_id, store_id, variant_id);
          CREATE INDEX IF NOT EXISTS product_qr_codes_product_idx
            ON app.product_qr_codes(merchant_id, store_id, product_id);

          CREATE TABLE IF NOT EXISTS app.product_qr_scan_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            qr_code_id UUID REFERENCES app.product_qr_codes(id) ON DELETE SET NULL,
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
            context TEXT NOT NULL,
            actor_type TEXT NOT NULL DEFAULT 'staff',
            actor_id TEXT,
            result TEXT NOT NULL CHECK (result IN ('success', 'failure')),
            reason TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS product_qr_scan_events_scope_time_idx
            ON app.product_qr_scan_events(merchant_id, store_id, scanned_at DESC);
          CREATE INDEX IF NOT EXISTS product_qr_scan_events_qr_time_idx
            ON app.product_qr_scan_events(qr_code_id, scanned_at DESC);

          CREATE TABLE IF NOT EXISTS app.scan_go_carts (
            id TEXT PRIMARY KEY,
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
            status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'redeemed', 'expired', 'cancelled')),
            merchant_slug TEXT NOT NULL,
            store_slug TEXT NOT NULL,
            customer_nickname TEXT,
            customer_contact TEXT,
            contact_type TEXT CHECK (contact_type IN ('whatsapp', 'email', 'phone')),
            age_acknowledged_at TIMESTAMPTZ NOT NULL,
            edit_secret_hash TEXT,
            token_hash TEXT UNIQUE,
            token_generated_at TIMESTAMPTZ,
            token_expires_at TIMESTAMPTZ,
            redeemed_at TIMESTAMPTZ,
            redeemed_by_operator_id TEXT,
            redeemed_order_id TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          ALTER TABLE app.scan_go_carts
            ADD COLUMN IF NOT EXISTS redeemed_order_id TEXT;
          ALTER TABLE app.scan_go_carts
            ADD COLUMN IF NOT EXISTS edit_secret_hash TEXT;
          CREATE INDEX IF NOT EXISTS scan_go_carts_scope_status_idx
            ON app.scan_go_carts(merchant_id, store_id, status, updated_at DESC);
          CREATE INDEX IF NOT EXISTS scan_go_carts_token_hash_idx
            ON app.scan_go_carts(token_hash)
            WHERE token_hash IS NOT NULL;
          CREATE INDEX IF NOT EXISTS scan_go_carts_redeemed_order_idx
            ON app.scan_go_carts(redeemed_order_id)
            WHERE redeemed_order_id IS NOT NULL;

          CREATE TABLE IF NOT EXISTS app.scan_go_cart_items (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            cart_id TEXT NOT NULL REFERENCES app.scan_go_carts(id) ON DELETE CASCADE,
            product_id TEXT NOT NULL,
            variant_id TEXT NOT NULL,
            qr_slug TEXT,
            sku TEXT NOT NULL DEFAULT '',
            barcode TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            quantity INT NOT NULL CHECK (quantity > 0),
            unit_price_vnd NUMERIC(20,0) NOT NULL CHECK (unit_price_vnd >= 0),
            product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (cart_id, variant_id)
          );
          CREATE INDEX IF NOT EXISTS scan_go_cart_items_cart_idx
            ON app.scan_go_cart_items(cart_id);

          CREATE TABLE IF NOT EXISTS app.product_variant_images (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            store_id TEXT REFERENCES app.stores(id) ON UPDATE CASCADE,
            product_id TEXT NOT NULL,
            variant_id TEXT NOT NULL,
            image_url TEXT NOT NULL,
            image_type TEXT NOT NULL CHECK (
              image_type IN ('primary', 'front', 'back', 'side', 'angle', 'counter_capture', 'strength_text', 'qr_tag')
            ),
            source TEXT NOT NULL CHECK (
              source IN ('manual', 'import', 'metadata_backfill', 'autofill', 'staff_correction', 'system')
            ),
            quality_status TEXT NOT NULL DEFAULT 'pending' CHECK (
              quality_status IN ('pending', 'approved', 'rejected')
            ),
            quality_score NUMERIC(5,4) CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),
            is_primary BOOLEAN NOT NULL DEFAULT false,
            external_provider TEXT,
            external_product_ref TEXT,
            external_image_ref TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS product_variant_images_scope_variant_idx
            ON app.product_variant_images(merchant_id, store_id, variant_id);
          CREATE INDEX IF NOT EXISTS product_variant_images_product_idx
            ON app.product_variant_images(merchant_id, product_id);
          CREATE INDEX IF NOT EXISTS product_variant_images_provider_ref_idx
            ON app.product_variant_images(external_provider, external_product_ref)
            WHERE external_provider IS NOT NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS product_variant_images_variant_url_unique_idx
            ON app.product_variant_images(merchant_id, COALESCE(store_id, ''), variant_id, image_url);
          CREATE UNIQUE INDEX IF NOT EXISTS product_variant_images_one_primary_idx
            ON app.product_variant_images(merchant_id, COALESCE(store_id, ''), variant_id)
            WHERE is_primary = true;

          CREATE TABLE IF NOT EXISTS app.vision_catalog_index_items (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            store_id TEXT REFERENCES app.stores(id) ON UPDATE CASCADE,
            product_id TEXT NOT NULL,
            variant_id TEXT NOT NULL,
            image_id UUID REFERENCES app.product_variant_images(id) ON DELETE SET NULL,
            provider TEXT NOT NULL,
            provider_location TEXT,
            provider_product_set_ref TEXT,
            provider_product_ref TEXT,
            provider_image_ref TEXT,
            sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (
              sync_status IN ('pending', 'synced', 'failed', 'disabled')
            ),
            sync_error TEXT,
            synced_at TIMESTAMPTZ,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS vision_catalog_index_scope_variant_idx
            ON app.vision_catalog_index_items(merchant_id, store_id, variant_id, provider);
          CREATE INDEX IF NOT EXISTS vision_catalog_index_status_idx
            ON app.vision_catalog_index_items(provider, sync_status, updated_at DESC);
          CREATE UNIQUE INDEX IF NOT EXISTS vision_catalog_index_provider_image_unique_idx
            ON app.vision_catalog_index_items(
              merchant_id,
              COALESCE(store_id, ''),
              provider,
              COALESCE(provider_location, ''),
              COALESCE(provider_product_set_ref, ''),
              variant_id,
              COALESCE(image_id, '00000000-0000-0000-0000-000000000000'::uuid)
            );

          CREATE TABLE IF NOT EXISTS app.vision_scan_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
            operator_id TEXT,
            mode TEXT NOT NULL CHECK (mode IN ('single', 'bulk')),
            status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
            client_scan_id TEXT,
            image_hash TEXT NOT NULL,
            raw_image_storage_key TEXT,
            qr_detected_count INT NOT NULL DEFAULT 0 CHECK (qr_detected_count >= 0),
            ai_detected_count INT NOT NULL DEFAULT 0 CHECK (ai_detected_count >= 0),
            unresolved_count INT NOT NULL DEFAULT 0 CHECK (unresolved_count >= 0),
            latency_ms INT CHECK (latency_ms IS NULL OR latency_ms >= 0),
            provider TEXT,
            model_version TEXT,
            estimated_cost_usd NUMERIC(12,6) CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS vision_scan_events_scope_time_idx
            ON app.vision_scan_events(merchant_id, store_id, created_at DESC);
          CREATE UNIQUE INDEX IF NOT EXISTS vision_scan_events_client_id_unique_idx
            ON app.vision_scan_events(merchant_id, store_id, client_scan_id)
            WHERE client_scan_id IS NOT NULL;

          CREATE TABLE IF NOT EXISTS app.vision_scan_detections (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            scan_event_id UUID NOT NULL REFERENCES app.vision_scan_events(id) ON DELETE CASCADE,
            object_id TEXT NOT NULL,
            bbox JSONB,
            source TEXT NOT NULL CHECK (source IN ('qr', 'barcode', 'vision_provider', 'manual')),
            detection_type TEXT NOT NULL CHECK (detection_type IN ('exact_match', 'candidate_match', 'unresolved')),
            resolved_variant_id TEXT,
            confidence NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
            candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
            requires_confirmation BOOLEAN NOT NULL DEFAULT true,
            decision TEXT NOT NULL DEFAULT 'pending' CHECK (
              decision IN ('pending', 'accepted', 'corrected', 'rejected', 'unresolved')
            ),
            warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE UNIQUE INDEX IF NOT EXISTS vision_scan_detections_object_idx
            ON app.vision_scan_detections(scan_event_id, object_id);
          CREATE INDEX IF NOT EXISTS vision_scan_detections_variant_idx
            ON app.vision_scan_detections(resolved_variant_id)
            WHERE resolved_variant_id IS NOT NULL;

          CREATE TABLE IF NOT EXISTS app.vision_scan_corrections (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            scan_event_id UUID NOT NULL REFERENCES app.vision_scan_events(id) ON DELETE CASCADE,
            detection_id UUID REFERENCES app.vision_scan_detections(id) ON DELETE SET NULL,
            selected_variant_id TEXT,
            previous_variant_id TEXT,
            operator_id TEXT,
            correction_type TEXT NOT NULL CHECK (
              correction_type IN ('staff_accepted', 'staff_selected_correct_variant', 'staff_rejected', 'manual_search_selected')
            ),
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT vision_scan_corrections_selected_variant_chk CHECK (
              (correction_type = 'staff_rejected' AND selected_variant_id IS NULL)
              OR (correction_type <> 'staff_rejected' AND selected_variant_id IS NOT NULL)
            )
          );
          CREATE INDEX IF NOT EXISTS vision_scan_corrections_scan_idx
            ON app.vision_scan_corrections(scan_event_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS vision_scan_corrections_selected_variant_idx
            ON app.vision_scan_corrections(selected_variant_id, created_at DESC)
            WHERE selected_variant_id IS NOT NULL;

          CREATE TABLE IF NOT EXISTS app.vision_scan_image_artifacts (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            store_id TEXT REFERENCES app.stores(id) ON UPDATE CASCADE,
            scan_event_id UUID NOT NULL REFERENCES app.vision_scan_events(id) ON DELETE CASCADE,
            detection_id UUID REFERENCES app.vision_scan_detections(id) ON DELETE SET NULL,
            variant_id TEXT REFERENCES public.product_variant(id) ON DELETE SET NULL,
            artifact_type TEXT NOT NULL CHECK (artifact_type IN ('raw_scan', 'object_crop')),
            gcs_uri TEXT NOT NULL,
            storage_key TEXT NOT NULL,
            content_type TEXT NOT NULL,
            byte_size INT CHECK (byte_size IS NULL OR byte_size >= 0),
            width INT CHECK (width IS NULL OR width > 0),
            height INT CHECK (height IS NULL OR height > 0),
            bbox JSONB,
            image_hash TEXT,
            quality_status TEXT NOT NULL DEFAULT 'pending' CHECK (
              quality_status IN ('pending', 'approved', 'rejected', 'skipped')
            ),
            retention_expires_at TIMESTAMPTZ,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS vision_scan_image_artifacts_scan_idx
            ON app.vision_scan_image_artifacts(scan_event_id, artifact_type, created_at DESC);
          CREATE INDEX IF NOT EXISTS vision_scan_image_artifacts_variant_idx
            ON app.vision_scan_image_artifacts(merchant_id, store_id, variant_id, artifact_type)
            WHERE variant_id IS NOT NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS vision_scan_image_artifacts_storage_unique_idx
            ON app.vision_scan_image_artifacts(storage_key);

          ALTER TABLE app.vision_scan_corrections
            DROP CONSTRAINT IF EXISTS vision_scan_corrections_correction_type_check;
          ALTER TABLE app.vision_scan_corrections
            ADD CONSTRAINT vision_scan_corrections_correction_type_check
            CHECK (correction_type IN ('staff_accepted', 'staff_selected_correct_variant', 'staff_rejected', 'manual_search_selected'));

          CREATE INDEX IF NOT EXISTS product_variant_sku_lower_active_idx
            ON public.product_variant (LOWER(sku))
            WHERE deleted_at IS NULL AND sku IS NOT NULL;
          CREATE INDEX IF NOT EXISTS product_variant_barcode_lower_active_idx
            ON public.product_variant (LOWER(barcode))
            WHERE deleted_at IS NULL AND barcode IS NOT NULL;

          CREATE TABLE IF NOT EXISTS app.package_catalog_versions (
            id TEXT PRIMARY KEY,
            catalog_version TEXT NOT NULL,
            package_key TEXT NOT NULL CHECK (package_key IN ('basic', 'plus', 'ai_fan')),
            annual_price_vnd NUMERIC(20,0) NOT NULL CHECK (annual_price_vnd >= 0),
            included_stores INTEGER NOT NULL CHECK (included_stores >= 0),
            staff_limit INTEGER NOT NULL CHECK (staff_limit >= 0),
            research_runs_per_month INTEGER NOT NULL CHECK (research_runs_per_month >= 0),
            telegram_ai_drafts_per_month INTEGER NOT NULL CHECK (telegram_ai_drafts_per_month >= 0),
            feature_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
            effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
            is_published BOOLEAN NOT NULL DEFAULT true,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE UNIQUE INDEX IF NOT EXISTS package_catalog_versions_version_pkg_idx
            ON app.package_catalog_versions(catalog_version, package_key);
          CREATE INDEX IF NOT EXISTS package_catalog_versions_pkg_idx
            ON app.package_catalog_versions(package_key, effective_from DESC);

          CREATE TABLE IF NOT EXISTS app.merchant_subscriptions (
            id TEXT PRIMARY KEY,
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            package_key TEXT NOT NULL CHECK (package_key IN ('basic', 'plus', 'ai_fan')),
            catalog_version_id TEXT NOT NULL REFERENCES app.package_catalog_versions(id),
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'grace', 'expired')),
            current_period_start TIMESTAMPTZ NOT NULL,
            current_period_end TIMESTAMPTZ NOT NULL,
            grace_ends_at TIMESTAMPTZ,
            primary_store_id TEXT NOT NULL,
            usage_anchor_day SMALLINT NOT NULL DEFAULT 1 CHECK (usage_anchor_day BETWEEN 1 AND 31),
            policy_version TEXT NOT NULL DEFAULT '1.1.2-annual-v1',
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (current_period_end > current_period_start)
          );
          CREATE UNIQUE INDEX IF NOT EXISTS merchant_subscriptions_merchant_idx
            ON app.merchant_subscriptions(merchant_id);
          CREATE INDEX IF NOT EXISTS merchant_subscriptions_period_end_idx
            ON app.merchant_subscriptions(current_period_end);
          CREATE INDEX IF NOT EXISTS merchant_subscriptions_status_idx
            ON app.merchant_subscriptions(status, grace_ends_at);

          CREATE TABLE IF NOT EXISTS app.subscription_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            subscription_id TEXT NOT NULL REFERENCES app.merchant_subscriptions(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL CHECK (event_type IN (
              'subscription.activated', 'subscription.renewed', 'subscription.upgraded',
              'subscription.renewal_reminder', 'subscription.entered_grace',
              'subscription.grace_ending', 'subscription.expired', 'subscription.reactivated'
            )),
            reminder_offset_days SMALLINT CHECK (reminder_offset_days IN (30, 14, 7, 1)),
            period_end TIMESTAMPTZ NOT NULL,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE UNIQUE INDEX IF NOT EXISTS subscription_events_reminder_unique_idx
            ON app.subscription_events(subscription_id, period_end, reminder_offset_days)
            WHERE event_type = 'subscription.renewal_reminder';
          CREATE UNIQUE INDEX IF NOT EXISTS subscription_events_lifecycle_unique_idx
            ON app.subscription_events(subscription_id, event_type, period_end)
            WHERE event_type <> 'subscription.renewal_reminder';

          ALTER TABLE app.subscription_events
            DROP CONSTRAINT IF EXISTS subscription_events_event_type_check;
          ALTER TABLE app.subscription_events
            ADD CONSTRAINT subscription_events_event_type_check CHECK (event_type IN (
              'subscription.activated', 'subscription.renewed', 'subscription.upgraded',
              'subscription.renewal_reminder', 'subscription.entered_grace',
              'subscription.grace_ending', 'subscription.expired', 'subscription.reactivated'
            ));

          -- Notification delivery claim/lease columns. The canonical table is
          -- created by migration 011; these additive ALTERs make the columns
          -- available in any environment that bootstraps via ensurePlatformSchema
          -- without replaying the migration. A worker claims rows by writing
          -- claimed_by/lease_token/lease_expires_at; the lease is asserted again
          -- when delivery outcomes are persisted. Expired leases are retryable.
          CREATE TABLE IF NOT EXISTS app.subscription_notifications (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            subscription_id TEXT NOT NULL REFERENCES app.merchant_subscriptions(id) ON DELETE CASCADE,
            source_event_id UUID NOT NULL,
            event_type TEXT NOT NULL,
            reminder_offset_days SMALLINT,
            period_end TIMESTAMPTZ NOT NULL,
            notification_type TEXT NOT NULL,
            template_key TEXT NOT NULL,
            template_version INT NOT NULL,
            idempotency_key TEXT NOT NULL,
            recipient_operator_id TEXT,
            recipient_email_hash TEXT,
            delivery_status TEXT NOT NULL DEFAULT 'pending',
            provider TEXT,
            provider_message_id TEXT,
            attempt_count INT NOT NULL DEFAULT 0,
            last_error TEXT,
            next_retry_at TIMESTAMPTZ,
            sent_at TIMESTAMPTZ,
            claimed_by TEXT,
            lease_token UUID,
            lease_expires_at TIMESTAMPTZ,
            payload_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT subscription_notifications_idempotency_uniq
              UNIQUE (source_event_id, template_key, template_version)
          );
          ALTER TABLE app.subscription_notifications
            ADD COLUMN IF NOT EXISTS claimed_by TEXT;
          ALTER TABLE app.subscription_notifications
            ADD COLUMN IF NOT EXISTS lease_token UUID;
          ALTER TABLE app.subscription_notifications
            ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

          CREATE TABLE IF NOT EXISTS app.subscription_usage_buckets (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            subscription_id TEXT NOT NULL REFERENCES app.merchant_subscriptions(id) ON DELETE CASCADE,
            metric_key TEXT NOT NULL CHECK (metric_key IN ('product_research_runs', 'telegram_ai_drafts', 'provider_credits', 'llm_tokens')),
            window_start TIMESTAMPTZ NOT NULL,
            window_end TIMESTAMPTZ NOT NULL,
            included_quantity BIGINT CHECK (included_quantity IS NULL OR included_quantity >= 0),
            used_quantity BIGINT NOT NULL DEFAULT 0 CHECK (used_quantity >= 0),
            reserved_quantity BIGINT NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (window_end > window_start)
          );
          CREATE UNIQUE INDEX IF NOT EXISTS usage_buckets_window_unique_idx
            ON app.subscription_usage_buckets(merchant_id, metric_key, window_start);
          CREATE INDEX IF NOT EXISTS usage_buckets_lookup_idx
            ON app.subscription_usage_buckets(merchant_id, metric_key, window_end DESC);

          CREATE TABLE IF NOT EXISTS app.subscription_usage_reservations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            reservation_token TEXT NOT NULL UNIQUE,
            bucket_id UUID NOT NULL REFERENCES app.subscription_usage_buckets(id) ON DELETE CASCADE,
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            metric_key TEXT NOT NULL CHECK (metric_key IN ('product_research_runs', 'telegram_ai_drafts', 'provider_credits', 'llm_tokens')),
            quantity BIGINT NOT NULL CHECK (quantity > 0),
            status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'committed', 'released')),
            reference_type TEXT,
            reference_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            resolved_at TIMESTAMPTZ
          );
          CREATE INDEX IF NOT EXISTS usage_reservations_bucket_idx
            ON app.subscription_usage_reservations(bucket_id, status);
        `);

        await seedPackageCatalog(client);

        await seedEnvEntitlements(client);

        await client.query(`
          CREATE TABLE IF NOT EXISTS app.operator_identities (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id TEXT NOT NULL DEFAULT 'org_default',
            merchant_id TEXT,
            default_store_id TEXT,
            provider TEXT NOT NULL CHECK (provider IN ('telegram')),
            provider_user_id TEXT NOT NULL,
            operator_id TEXT NOT NULL,
            display_name TEXT,
            audit_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
            is_active BOOLEAN NOT NULL DEFAULT true,
            verified_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (organization_id, provider, provider_user_id),
            UNIQUE (organization_id, provider, operator_id)
          );
          ALTER TABLE app.operator_identities ADD COLUMN IF NOT EXISTS merchant_id TEXT;
          ALTER TABLE app.operator_identities ADD COLUMN IF NOT EXISTS default_store_id TEXT;
          ALTER TABLE app.operator_identities ADD COLUMN IF NOT EXISTS audit_evidence JSONB NOT NULL DEFAULT '{}'::jsonb;
          ALTER TABLE app.operator_identities DROP CONSTRAINT IF EXISTS operator_identities_organization_id_provider_provider_user_id_key;
          ALTER TABLE app.operator_identities DROP CONSTRAINT IF EXISTS operator_identities_organization_id_provider_operator_id_key;
          CREATE UNIQUE INDEX IF NOT EXISTS operator_identities_legacy_provider_user_idx
            ON app.operator_identities(organization_id, provider, provider_user_id)
            WHERE merchant_id IS NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS operator_identities_legacy_provider_operator_idx
            ON app.operator_identities(organization_id, provider, operator_id)
            WHERE merchant_id IS NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS operator_identities_merchant_provider_user_idx
            ON app.operator_identities(merchant_id, provider, provider_user_id)
            WHERE merchant_id IS NOT NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS operator_identities_merchant_provider_operator_idx
            ON app.operator_identities(merchant_id, provider, operator_id)
            WHERE merchant_id IS NOT NULL;
          CREATE INDEX IF NOT EXISTS operator_identities_operator_idx
            ON app.operator_identities(operator_id)
            WHERE is_active = true;

          CREATE TABLE IF NOT EXISTS app.telegram_bot_configs (
            id TEXT PRIMARY KEY,
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            token_secret_ref TEXT NOT NULL,
            webhook_path_secret_hash TEXT NOT NULL,
            telegram_secret_token_hash TEXT NOT NULL,
            default_store_id TEXT REFERENCES app.stores(id) ON UPDATE CASCADE,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked')),
            allowed_commands JSONB NOT NULL DEFAULT '[]'::jsonb,
            health JSONB NOT NULL DEFAULT '{}'::jsonb,
            last_heartbeat_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (merchant_id),
            UNIQUE (webhook_path_secret_hash),
            UNIQUE (telegram_secret_token_hash)
          );
          CREATE INDEX IF NOT EXISTS telegram_bot_configs_merchant_idx
            ON app.telegram_bot_configs(merchant_id);

          CREATE TABLE IF NOT EXISTS app.telegram_runtime_leases (
            lease_key TEXT PRIMARY KEY,
            holder_id TEXT NOT NULL,
            mode TEXT NOT NULL CHECK (mode IN ('polling', 'webhook')),
            expires_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE IF NOT EXISTS app.telegram_sales_profiles (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            store_id TEXT REFERENCES app.stores(id) ON UPDATE CASCADE,
            telegram_user_id TEXT NOT NULL,
            telegram_chat_id TEXT,
            telegram_username TEXT,
            telegram_first_name TEXT,
            language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ru')),
            customer_id TEXT,
            phone TEXT,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (merchant_id, telegram_user_id)
          );
          CREATE INDEX IF NOT EXISTS telegram_sales_profiles_scope_idx
            ON app.telegram_sales_profiles(merchant_id, store_id, updated_at DESC);

          CREATE TABLE IF NOT EXISTS app.telegram_sales_drafts (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
            store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
            profile_id UUID NOT NULL REFERENCES app.telegram_sales_profiles(id) ON DELETE RESTRICT,
            telegram_user_id TEXT NOT NULL,
            telegram_chat_id TEXT,
            telegram_username TEXT,
            language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ru')),
            status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('pending', 'needs_review', 'converted', 'rejected', 'expired', 'cancelled')),
            items JSONB NOT NULL DEFAULT '[]'::jsonb,
            quote JSONB NOT NULL DEFAULT '{}'::jsonb,
            delivery JSONB NOT NULL DEFAULT '{}'::jsonb,
            customer_message TEXT,
            operator_notes TEXT,
            ai_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            source TEXT NOT NULL DEFAULT 'telegram',
            idempotency_key TEXT NOT NULL,
            converted_order_id TEXT,
            reviewed_by TEXT,
            reviewed_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (merchant_id, idempotency_key)
          );
          CREATE INDEX IF NOT EXISTS telegram_sales_drafts_scope_status_idx
            ON app.telegram_sales_drafts(merchant_id, store_id, status, created_at DESC);
          CREATE INDEX IF NOT EXISTS telegram_sales_drafts_profile_idx
            ON app.telegram_sales_drafts(profile_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS telegram_sales_drafts_converted_order_idx
            ON app.telegram_sales_drafts(converted_order_id)
            WHERE converted_order_id IS NOT NULL;

          CREATE TABLE IF NOT EXISTS app.bot_sessions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id TEXT NOT NULL DEFAULT 'org_default',
            merchant_id TEXT,
            store_id TEXT,
            provider TEXT NOT NULL CHECK (provider IN ('telegram')),
            provider_user_id TEXT NOT NULL,
            operator_id TEXT,
            state JSONB NOT NULL DEFAULT '{}',
            expires_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (organization_id, provider, provider_user_id)
          );
          ALTER TABLE app.bot_sessions ADD COLUMN IF NOT EXISTS merchant_id TEXT;
          ALTER TABLE app.bot_sessions ADD COLUMN IF NOT EXISTS store_id TEXT;
          ALTER TABLE app.bot_sessions DROP CONSTRAINT IF EXISTS bot_sessions_organization_id_provider_provider_user_id_key;
          CREATE UNIQUE INDEX IF NOT EXISTS bot_sessions_legacy_provider_user_idx
            ON app.bot_sessions(organization_id, provider, provider_user_id)
            WHERE merchant_id IS NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS bot_sessions_merchant_provider_user_idx
            ON app.bot_sessions(merchant_id, provider, provider_user_id)
            WHERE merchant_id IS NOT NULL;
          CREATE INDEX IF NOT EXISTS bot_sessions_expiry_idx ON app.bot_sessions(expires_at);

          CREATE TABLE IF NOT EXISTS app.permissions (
            id TEXT PRIMARY KEY,
            description TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS app.role_permissions (
            role TEXT NOT NULL CHECK (role IN ('staff', 'manager', 'accountant', 'owner')),
            permission_id TEXT NOT NULL REFERENCES app.permissions(id),
            PRIMARY KEY (role, permission_id)
          );

          CREATE TABLE IF NOT EXISTS app.operator_memberships (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            operator_id TEXT NOT NULL,
            scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'merchant', 'store')),
            merchant_id TEXT REFERENCES app.merchants(id) ON UPDATE CASCADE,
            store_id TEXT REFERENCES app.stores(id) ON UPDATE CASCADE,
            role_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
            valid_to TIMESTAMPTZ,
            granted_by TEXT NOT NULL,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT operator_memberships_status_check
              CHECK (status IN ('active', 'disabled', 'pending', 'revoked')),
            CONSTRAINT operator_memberships_scope_check
              CHECK (
                (scope_type = 'platform' AND merchant_id IS NULL AND store_id IS NULL)
                OR (scope_type = 'merchant' AND merchant_id IS NOT NULL AND store_id IS NULL)
                OR (scope_type = 'store' AND merchant_id IS NOT NULL AND store_id IS NOT NULL)
              )
          );
          CREATE INDEX IF NOT EXISTS operator_memberships_operator_idx
            ON app.operator_memberships(operator_id, status);
          CREATE INDEX IF NOT EXISTS operator_memberships_merchant_idx
            ON app.operator_memberships(merchant_id, status)
            WHERE merchant_id IS NOT NULL;
          CREATE INDEX IF NOT EXISTS operator_memberships_store_idx
            ON app.operator_memberships(store_id, status)
            WHERE store_id IS NOT NULL;

          CREATE TABLE IF NOT EXISTS app.operator_security_state (
            operator_id TEXT PRIMARY KEY,
            requires_password_change BOOLEAN NOT NULL DEFAULT false,
            force_logout_after TIMESTAMPTZ,
            session_version INT NOT NULL DEFAULT 1 CHECK (session_version >= 1),
            global_status TEXT NOT NULL DEFAULT 'active' CHECK (global_status IN ('active', 'suspended')),
            password_changed_at TIMESTAMPTZ,
            temporary_password_hash TEXT,
            temporary_password_expires_at TIMESTAMPTZ,
            last_login_at TIMESTAMPTZ,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE IF NOT EXISTS app.operator_profiles (
            operator_id TEXT PRIMARY KEY,
            email TEXT,
            normalized_email TEXT,
            phone_e164 TEXT,
            locale TEXT,
            avatar_url TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS operator_profiles_normalized_email_idx
            ON app.operator_profiles(normalized_email)
            WHERE normalized_email IS NOT NULL;

          CREATE TABLE IF NOT EXISTS app.operator_explicit_permission_grants (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            operator_id TEXT NOT NULL,
            permission_id TEXT NOT NULL REFERENCES app.permissions(id),
            scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'merchant', 'store')),
            merchant_id TEXT,
            store_id TEXT,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
            granted_by TEXT NOT NULL,
            revoked_by TEXT,
            reason TEXT NOT NULL DEFAULT '',
            valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
            valid_to TIMESTAMPTZ,
            revoked_at TIMESTAMPTZ,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT operator_explicit_permission_scope_check CHECK (
              (scope_type = 'platform' AND merchant_id IS NULL AND store_id IS NULL)
              OR (scope_type = 'merchant' AND merchant_id IS NOT NULL AND store_id IS NULL)
              OR (scope_type = 'store' AND merchant_id IS NOT NULL AND store_id IS NOT NULL)
            )
          );
          CREATE UNIQUE INDEX IF NOT EXISTS operator_explicit_permission_active_unique_idx
            ON app.operator_explicit_permission_grants(
              operator_id, permission_id, scope_type, COALESCE(merchant_id, ''), COALESCE(store_id, '')
            )
            WHERE status = 'active' AND valid_to IS NULL;
          CREATE INDEX IF NOT EXISTS operator_explicit_permission_operator_idx
            ON app.operator_explicit_permission_grants(operator_id, status, valid_from DESC);

          CREATE TABLE IF NOT EXISTS app.impersonation_sessions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            actual_operator_id TEXT NOT NULL,
            effective_operator_id TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'read_only' CHECK (mode IN ('read_only')),
            reason TEXT NOT NULL,
            ticket_ref TEXT,
            started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at TIMESTAMPTZ NOT NULL,
            ended_at TIMESTAMPTZ,
            end_reason TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS impersonation_sessions_active_idx
            ON app.impersonation_sessions(actual_operator_id, effective_operator_id, expires_at)
            WHERE ended_at IS NULL;

          CREATE TABLE IF NOT EXISTS app.operator_identity_link_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            operator_id TEXT NOT NULL,
            provider TEXT NOT NULL CHECK (provider IN ('telegram')),
            token_hash TEXT NOT NULL UNIQUE,
            expires_at TIMESTAMPTZ NOT NULL,
            consumed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS operator_identity_link_tokens_operator_idx
            ON app.operator_identity_link_tokens(operator_id, provider, expires_at DESC);

          CREATE TABLE IF NOT EXISTS app.payment_entries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id TEXT NOT NULL DEFAULT 'org_default',
            order_id TEXT NOT NULL,
            direction TEXT NOT NULL CHECK (direction IN ('charge', 'refund')),
            method TEXT NOT NULL,
            amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
            currency_code TEXT NOT NULL DEFAULT 'vnd',
            status TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'voided')),
            reference TEXT,
            reason TEXT,
            metadata JSONB NOT NULL DEFAULT '{}',
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS payment_entries_order_idx
            ON app.payment_entries(order_id, created_at DESC);
	          CREATE INDEX IF NOT EXISTS payment_entries_status_idx
	            ON app.payment_entries(status, created_at DESC);
	          ALTER TABLE app.payment_entries ADD COLUMN IF NOT EXISTS merchant_id TEXT;
	          ALTER TABLE app.payment_entries ADD COLUMN IF NOT EXISTS store_id TEXT;
	          CREATE INDEX IF NOT EXISTS payment_entries_scope_order_created_idx
	            ON app.payment_entries(merchant_id, store_id, order_id, created_at DESC)
	            WHERE merchant_id IS NOT NULL AND store_id IS NOT NULL;

          CREATE TABLE IF NOT EXISTS app.order_corrections (
            id TEXT PRIMARY KEY,
            organization_id TEXT NOT NULL DEFAULT 'org_default',
            order_id TEXT NOT NULL,
            revision INT NOT NULL CHECK (revision > 0),
            base_revision INT NOT NULL DEFAULT 0 CHECK (base_revision >= 0),
            status TEXT NOT NULL CHECK (status IN ('applied', 'pending_settlement', 'cancelled', 'expired')),
            reason TEXT NOT NULL,
            before_totals JSONB NOT NULL,
            after_totals JSONB NOT NULL,
            total_delta NUMERIC(14,2) NOT NULL,
            settlement_method TEXT,
            settlement_payment_entry_id UUID REFERENCES app.payment_entries(id),
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (order_id, revision)
          );
          CREATE INDEX IF NOT EXISTS order_corrections_order_idx
            ON app.order_corrections(order_id, revision DESC);
          CREATE UNIQUE INDEX IF NOT EXISTS order_corrections_pending_order_idx
            ON app.order_corrections(order_id)
            WHERE status = 'pending_settlement';

          CREATE TABLE IF NOT EXISTS app.order_correction_items (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            correction_id TEXT NOT NULL REFERENCES app.order_corrections(id) ON DELETE CASCADE,
            variant_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            product_title TEXT NOT NULL,
            sku TEXT,
            quantity_before INT NOT NULL DEFAULT 0 CHECK (quantity_before >= 0),
            quantity_after INT NOT NULL DEFAULT 0 CHECK (quantity_after >= 0),
            quantity_delta INT NOT NULL,
            unit_price NUMERIC(14,2) NOT NULL,
            cost_price NUMERIC(14,2) NOT NULL DEFAULT 0,
            line_total_before NUMERIC(14,2) NOT NULL DEFAULT 0,
            line_total_after NUMERIC(14,2) NOT NULL DEFAULT 0,
            stock_delta INT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (correction_id, variant_id)
          );
          CREATE INDEX IF NOT EXISTS order_correction_items_correction_idx
            ON app.order_correction_items(correction_id);

          CREATE TABLE IF NOT EXISTS app.order_correction_settlements (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            correction_id TEXT NOT NULL REFERENCES app.order_corrections(id) ON DELETE CASCADE,
            payment_entry_id UUID REFERENCES app.payment_entries(id),
            method TEXT NOT NULL,
            amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
            status TEXT NOT NULL CHECK (status IN ('none', 'pending', 'posted')),
            metadata JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS order_correction_settlements_correction_idx
            ON app.order_correction_settlements(correction_id);

          CREATE TABLE IF NOT EXISTS app.payment_intents (
            id TEXT PRIMARY KEY,
            organization_id TEXT NOT NULL DEFAULT 'org_default',
            merchant_id TEXT,
            store_id TEXT,
            provider TEXT NOT NULL CHECK (provider IN ('mock', 'sepay_va', 'nowpayments')),
            status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'completed', 'expired', 'cancelled', 'manual_review', 'failed')),
            amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
            currency_code TEXT NOT NULL DEFAULT 'vnd',
            order_input JSONB NOT NULL,
            provider_reference TEXT,
            reference_code TEXT NOT NULL UNIQUE,
            payment_url TEXT,
            qr_payload TEXT,
            expires_at TIMESTAMPTZ NOT NULL,
            paid_at TIMESTAMPTZ,
            completed_order_id TEXT,
            manual_review_reason TEXT,
            metadata JSONB NOT NULL DEFAULT '{}',
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS payment_intents_status_idx
            ON app.payment_intents(status, expires_at, created_at DESC);
          CREATE INDEX IF NOT EXISTS payment_intents_provider_reference_idx
            ON app.payment_intents(provider, provider_reference)
            WHERE provider_reference IS NOT NULL;
	          ALTER TABLE app.payment_intents ADD COLUMN IF NOT EXISTS merchant_id TEXT;
	          ALTER TABLE app.payment_intents ADD COLUMN IF NOT EXISTS store_id TEXT;
	          ALTER TABLE app.payment_intents ADD COLUMN IF NOT EXISTS stock_location_id TEXT;
	          CREATE INDEX IF NOT EXISTS payment_intents_scope_status_created_idx
	            ON app.payment_intents(merchant_id, store_id, status, created_at DESC)
	            WHERE merchant_id IS NOT NULL AND store_id IS NOT NULL;

          CREATE TABLE IF NOT EXISTS app.payment_provider_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id TEXT NOT NULL DEFAULT 'org_default',
            merchant_id TEXT,
            store_id TEXT,
            provider TEXT NOT NULL,
            provider_event_id TEXT NOT NULL,
            payment_intent_id TEXT REFERENCES app.payment_intents(id),
            event_type TEXT NOT NULL,
            amount NUMERIC(14,2),
            currency_code TEXT,
            status TEXT NOT NULL CHECK (status IN ('received', 'matched', 'ignored', 'manual_review', 'failed')),
            error TEXT,
            payload JSONB NOT NULL DEFAULT '{}',
            received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (provider, provider_event_id)
          );
	          CREATE INDEX IF NOT EXISTS payment_provider_events_intent_idx
	            ON app.payment_provider_events(payment_intent_id, received_at DESC);
	          ALTER TABLE app.payment_provider_events ADD COLUMN IF NOT EXISTS merchant_id TEXT;
	          ALTER TABLE app.payment_provider_events ADD COLUMN IF NOT EXISTS store_id TEXT;

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

	          CREATE TABLE IF NOT EXISTS app.integration_configs (
            id TEXT PRIMARY KEY,
            provider_key TEXT NOT NULL CHECK (provider_key IN ('mock', 'sepay_va', 'nowpayments')),
            purpose TEXT NOT NULL CHECK (purpose IN ('platform_billing', 'merchant_retail')),
            scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'merchant', 'store')),
            merchant_id TEXT REFERENCES app.merchants(id) ON UPDATE CASCADE,
            store_id TEXT REFERENCES app.stores(id) ON UPDATE CASCADE,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'error')),
            secret_digest TEXT,
            secret_set_at TIMESTAMPTZ,
            last_rotated_at TIMESTAMPTZ,
            callback_url TEXT,
            health_summary TEXT,
            required_action TEXT,
            live_mode BOOLEAN NOT NULL DEFAULT false CHECK (live_mode = false),
            created_by TEXT NOT NULL,
            updated_by TEXT NOT NULL,
            disabled_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT integration_configs_target_check CHECK (
              (scope_type = 'platform' AND merchant_id IS NULL AND store_id IS NULL)
              OR (scope_type = 'merchant' AND merchant_id IS NOT NULL AND store_id IS NULL)
              OR (scope_type = 'store' AND merchant_id IS NOT NULL AND store_id IS NOT NULL)
            )
          );
          CREATE UNIQUE INDEX IF NOT EXISTS integration_configs_target_unique_idx
            ON app.integration_configs (
              provider_key, purpose, scope_type,
              COALESCE(merchant_id, ''), COALESCE(store_id, '')
            );
          CREATE INDEX IF NOT EXISTS integration_configs_merchant_idx
            ON app.integration_configs(merchant_id, status, updated_at DESC)
            WHERE merchant_id IS NOT NULL;
          CREATE INDEX IF NOT EXISTS integration_configs_store_idx
            ON app.integration_configs(store_id, status, updated_at DESC)
            WHERE store_id IS NOT NULL;

          DO $$
          BEGIN
            IF to_regclass('audit.events') IS NOT NULL THEN
              ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS merchant_id TEXT;
              ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS store_id TEXT;
              ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS channel TEXT;
              ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS channel_user_id TEXT;
              ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS service_identity TEXT;
              ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS request_id TEXT;
              ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS effective_actor_id TEXT;
              ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS actual_actor_id TEXT;
              ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS impersonation_session_id TEXT;
              ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS actor_chain JSONB NOT NULL DEFAULT '[]'::jsonb;
              CREATE INDEX IF NOT EXISTS audit_merchant_subject_idx
                ON audit.events(merchant_id, subject_type, subject_id, created_at DESC)
                WHERE merchant_id IS NOT NULL;
              CREATE INDEX IF NOT EXISTS audit_store_subject_idx
                ON audit.events(store_id, subject_type, subject_id, created_at DESC)
                WHERE store_id IS NOT NULL;
              CREATE INDEX IF NOT EXISTS audit_channel_idx
                ON audit.events(channel, channel_user_id, created_at DESC);
              CREATE INDEX IF NOT EXISTS audit_actor_chain_idx
                ON audit.events(actual_actor_id, effective_actor_id, created_at DESC)
                WHERE actual_actor_id IS NOT NULL OR effective_actor_id IS NOT NULL;
              CREATE INDEX IF NOT EXISTS audit_impersonation_session_idx
                ON audit.events(impersonation_session_id, created_at DESC)
                WHERE impersonation_session_id IS NOT NULL;
            END IF;

            IF to_regclass('app.operator_memberships') IS NOT NULL THEN
              ALTER TABLE app.operator_memberships
                DROP CONSTRAINT IF EXISTS operator_memberships_status_check;
              ALTER TABLE app.operator_memberships
                ADD CONSTRAINT operator_memberships_status_check
                CHECK (status IN ('active', 'disabled', 'pending', 'revoked'));
            END IF;
          END $$;

          DO $$
          BEGIN
            IF to_regclass('medusa.staff_users') IS NOT NULL THEN
              INSERT INTO app.operator_security_state (operator_id, password_changed_at, last_login_at)
              SELECT operator_id, created_at, last_login_at
              FROM medusa.staff_users
              ON CONFLICT (operator_id) DO NOTHING;
            END IF;
          END $$;
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS inventory.product_settings (
            variant_id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            cost_price NUMERIC(14,2) NOT NULL DEFAULT 0,
            reorder_level INT NOT NULL DEFAULT 5,
            preferred_stock INT NOT NULL DEFAULT 20,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          ALTER TABLE inventory.product_settings
            ADD COLUMN IF NOT EXISTS merchant_id TEXT;

          CREATE TABLE IF NOT EXISTS inventory.purchase_orders (
            id TEXT PRIMARY KEY,
            supplier_name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'sent', 'partially_received', 'received', 'cancelled')),
            expected_date DATE,
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE IF NOT EXISTS inventory.purchase_order_items (
            id TEXT PRIMARY KEY,
            purchase_order_id TEXT NOT NULL REFERENCES inventory.purchase_orders(id) ON DELETE CASCADE,
            variant_id TEXT NOT NULL,
            quantity INT NOT NULL CHECK (quantity > 0),
            unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
            received_quantity INT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          ALTER TABLE inventory.purchase_orders
            ADD COLUMN IF NOT EXISTS merchant_id TEXT,
            ADD COLUMN IF NOT EXISTS store_id TEXT,
            ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS sent_by TEXT,
            ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS cancelled_by TEXT,
            ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
            ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS closed_by TEXT,
            ADD COLUMN IF NOT EXISTS close_reason TEXT,
            ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual',
            ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

          ALTER TABLE inventory.purchase_orders
            DROP CONSTRAINT IF EXISTS purchase_orders_status_check;
          ALTER TABLE inventory.purchase_orders
            ADD CONSTRAINT purchase_orders_status_check
            CHECK (status IN ('draft', 'sent', 'partially_received', 'received', 'cancelled', 'closed_short'));
          ALTER TABLE inventory.purchase_orders
            DROP CONSTRAINT IF EXISTS purchase_orders_source_check;
          ALTER TABLE inventory.purchase_orders
            ADD CONSTRAINT purchase_orders_source_check
            CHECK (source IN ('manual', 'csv_import', 'recommendation_csv', 'system_backfill'));

          ALTER TABLE inventory.purchase_order_items
            ADD COLUMN IF NOT EXISTS sku_snapshot TEXT,
            ADD COLUMN IF NOT EXISTS product_name_snapshot TEXT,
            ADD COLUMN IF NOT EXISTS category_names_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

          CREATE TABLE IF NOT EXISTS inventory.purchase_order_receipts (
            id TEXT PRIMARY KEY,
            purchase_order_id TEXT NOT NULL REFERENCES inventory.purchase_orders(id) ON DELETE CASCADE,
            merchant_id TEXT NOT NULL,
            store_id TEXT NOT NULL,
            stock_location_id TEXT NOT NULL,
            received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            received_by TEXT NOT NULL,
            note TEXT,
            source TEXT NOT NULL DEFAULT 'web_pos'
              CHECK (source IN ('web_pos', 'csv_import', 'system_backfill')),
            idempotency_key TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS purchase_order_receipts_po_time_idx
            ON inventory.purchase_order_receipts(purchase_order_id, received_at DESC);
          CREATE INDEX IF NOT EXISTS purchase_order_receipts_scope_time_idx
            ON inventory.purchase_order_receipts(merchant_id, store_id, received_at DESC);

          CREATE TABLE IF NOT EXISTS inventory.purchase_order_receipt_items (
            id TEXT PRIMARY KEY,
            receipt_id TEXT NOT NULL REFERENCES inventory.purchase_order_receipts(id) ON DELETE CASCADE,
            purchase_order_item_id TEXT NOT NULL REFERENCES inventory.purchase_order_items(id) ON DELETE CASCADE,
            variant_id TEXT NOT NULL,
            inventory_item_id TEXT NOT NULL,
            quantity_received INT NOT NULL CHECK (quantity_received > 0),
            unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
            inventory_value NUMERIC(14,2) NOT NULL DEFAULT 0,
            quantity_after INT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS purchase_order_receipt_items_receipt_idx
            ON inventory.purchase_order_receipt_items(receipt_id);
          CREATE INDEX IF NOT EXISTS purchase_order_receipt_items_po_item_idx
            ON inventory.purchase_order_receipt_items(purchase_order_item_id);
        `);

        // Now that app.payment_intents and app.payment_entries exist (created
        // above), apply the retail payment evidence schema and crypto asset
        // evidence schema. These ALTER those tables so they must run after.
        await ensureRetailPaymentEvidenceSchema(client);

        await ensureCryptoAssetEvidenceSchema(client);

        await client.query(`
          CREATE TABLE IF NOT EXISTS notification.telegram_recipients (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            merchant_id TEXT NOT NULL,
            store_id TEXT,
            telegram_user_id TEXT NOT NULL,
            telegram_chat_id TEXT,
            telegram_username TEXT,
            linked_operator_id TEXT,
            display_name TEXT NOT NULL,
            recipient_kind TEXT NOT NULL
              CHECK (recipient_kind IN ('owner', 'manager', 'sales_staff', 'ops', 'custom')),
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'disabled')),
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_by TEXT NOT NULL,
            updated_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE UNIQUE INDEX IF NOT EXISTS telegram_recipients_active_user_idx
            ON notification.telegram_recipients(merchant_id, telegram_user_id)
            WHERE status = 'active';
          CREATE INDEX IF NOT EXISTS telegram_recipients_scope_idx
            ON notification.telegram_recipients(merchant_id, store_id, status);
          CREATE INDEX IF NOT EXISTS telegram_recipients_operator_idx
            ON notification.telegram_recipients(linked_operator_id)
            WHERE linked_operator_id IS NOT NULL;

          CREATE TABLE IF NOT EXISTS notification.telegram_notification_rules (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            merchant_id TEXT NOT NULL,
            store_id TEXT,
            recipient_id UUID NOT NULL REFERENCES notification.telegram_recipients(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT true,
            event_scope TEXT NOT NULL,
            channel_filter TEXT NOT NULL DEFAULT 'all',
            event_types TEXT[] NOT NULL DEFAULT '{}',
            template_profile TEXT NOT NULL DEFAULT 'default',
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_by TEXT NOT NULL,
            updated_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS telegram_notification_rules_scope_idx
            ON notification.telegram_notification_rules(merchant_id, store_id, enabled);
          CREATE INDEX IF NOT EXISTS telegram_notification_rules_recipient_idx
            ON notification.telegram_notification_rules(recipient_id);

          CREATE TABLE IF NOT EXISTS notification.email_receipts (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            order_id TEXT NOT NULL,
            recipient TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')),
            error TEXT,
            sent_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE IF NOT EXISTS notification.telegram_notifications (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id TEXT NOT NULL DEFAULT 'org_default',
            recipient_operator_id TEXT NOT NULL,
            template TEXT NOT NULL,
            payload JSONB NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'processing', 'sent', 'dead_lettered')),
            attempts INT NOT NULL DEFAULT 0,
            source_event_id TEXT UNIQUE,
            claimed_until TIMESTAMPTZ,
            next_retry_at TIMESTAMPTZ,
            last_error TEXT,
            sent_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          ALTER TABLE notification.telegram_notifications ADD COLUMN IF NOT EXISTS merchant_id TEXT;
          ALTER TABLE notification.telegram_notifications ADD COLUMN IF NOT EXISTS store_id TEXT;
          ALTER TABLE notification.telegram_notifications ADD COLUMN IF NOT EXISTS recipient_id UUID REFERENCES notification.telegram_recipients(id) ON DELETE SET NULL;
          ALTER TABLE notification.telegram_notifications ADD COLUMN IF NOT EXISTS rule_id UUID REFERENCES notification.telegram_notification_rules(id) ON DELETE SET NULL;
          ALTER TABLE notification.telegram_notifications ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
          ALTER TABLE notification.telegram_notifications ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
          ALTER TABLE notification.telegram_notifications ALTER COLUMN recipient_operator_id DROP NOT NULL;
          ALTER TABLE notification.telegram_notifications DROP CONSTRAINT IF EXISTS telegram_notifications_source_event_id_key;
          UPDATE notification.telegram_notifications
          SET dedupe_key = COALESCE(source_event_id, id::text)
          WHERE dedupe_key IS NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS telegram_notifications_dedupe_key_uidx
            ON notification.telegram_notifications(dedupe_key);
          CREATE INDEX IF NOT EXISTS telegram_notifications_dispatch_idx
            ON notification.telegram_notifications(status, next_retry_at, created_at);
          CREATE INDEX IF NOT EXISTS telegram_notifications_recipient_idx
            ON notification.telegram_notifications(recipient_operator_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS telegram_notifications_direct_recipient_idx
            ON notification.telegram_notifications(recipient_id, created_at DESC)
            WHERE recipient_id IS NOT NULL;
          CREATE INDEX IF NOT EXISTS telegram_notifications_merchant_idx
            ON notification.telegram_notifications(merchant_id, created_at)
            WHERE merchant_id IS NOT NULL;
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS ai_module.product_research_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id TEXT NOT NULL DEFAULT 'org_default',
            product_id TEXT NOT NULL,
            product_title TEXT NOT NULL,
            provider TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
            summary TEXT NOT NULL,
            confidence TEXT NOT NULL DEFAULT 'medium',
            risk_flags JSONB NOT NULL DEFAULT '[]',
            raw_query TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS product_research_runs_product_idx
            ON ai_module.product_research_runs(product_id, created_at DESC);

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

          ALTER TABLE ai_module.product_research_runs
            ADD COLUMN IF NOT EXISTS merchant_id TEXT,
            ADD COLUMN IF NOT EXISTS preferred_language TEXT NOT NULL DEFAULT 'vi',
            ADD COLUMN IF NOT EXISTS quota_reservation_token TEXT,
            ADD COLUMN IF NOT EXISTS contradictions JSONB NOT NULL DEFAULT '[]',
            ADD COLUMN IF NOT EXISTS operator_review_status TEXT NOT NULL DEFAULT 'pending',
            ADD COLUMN IF NOT EXISTS operator_reviewed_by TEXT,
            ADD COLUMN IF NOT EXISTS operator_reviewed_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS operator_notes TEXT NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS operator_task_draft JSONB NOT NULL DEFAULT '{}';
          UPDATE ai_module.product_research_runs
            SET merchant_id = organization_id
            WHERE merchant_id IS NULL;
          CREATE INDEX IF NOT EXISTS product_research_runs_merchant_product_idx
            ON ai_module.product_research_runs(merchant_id, product_id, created_at DESC);

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
          CREATE INDEX IF NOT EXISTS promotion_strategies_active_idx
            ON ai_module.promotion_strategies(is_active, starts_at, ends_at, priority DESC);
          CREATE INDEX IF NOT EXISTS promotion_strategies_merchant_store_idx
            ON ai_module.promotion_strategies(merchant_id, store_id, is_active, priority DESC);

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
          CREATE INDEX IF NOT EXISTS cross_sell_events_created_idx
            ON ai_module.cross_sell_events(created_at DESC);
          CREATE INDEX IF NOT EXISTS cross_sell_events_variant_idx
            ON ai_module.cross_sell_events(accepted_variant_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS cross_sell_events_merchant_store_idx
            ON ai_module.cross_sell_events(merchant_id, store_id, created_at DESC);

          ALTER TABLE ai_module.inventory_alerts
            ADD COLUMN IF NOT EXISTS merchant_id TEXT,
            ADD COLUMN IF NOT EXISTS store_id TEXT,
            ADD COLUMN IF NOT EXISTS variant_id TEXT,
            ADD COLUMN IF NOT EXISTS inventory_item_id TEXT,
            ADD COLUMN IF NOT EXISTS product_title_snapshot TEXT,
            ADD COLUMN IF NOT EXISTS sku_snapshot TEXT;
          DO $$
          BEGIN
            IF to_regclass('public.product') IS NOT NULL AND EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'product'
                AND column_name = 'merchant_id'
            ) THEN
              EXECUTE $backfill$
                UPDATE ai_module.inventory_alerts a
                  SET
                    merchant_id = COALESCE(a.merchant_id, p.merchant_id),
                    store_id = COALESCE(a.store_id, s.id)
                  FROM public.product p
                  LEFT JOIN app.stores s ON s.merchant_id = p.merchant_id AND s.is_primary = true
                  WHERE p.id = a.product_id
                    AND (a.merchant_id IS NULL OR a.store_id IS NULL)
              $backfill$;
            END IF;
          END $$;
          CREATE INDEX IF NOT EXISTS inventory_alerts_merchant_store_status_idx
            ON ai_module.inventory_alerts(merchant_id, store_id, status, created_at DESC);
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS public.region (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            currency_code TEXT NOT NULL DEFAULT 'vnd',
            automatic_taxes BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
          );

          CREATE TABLE IF NOT EXISTS public.sales_channel (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            is_disabled BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
          );

          CREATE TABLE IF NOT EXISTS public.stock_location (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
          );

          CREATE TABLE IF NOT EXISTS public.customer (
            id TEXT PRIMARY KEY,
            first_name TEXT,
            last_name TEXT,
            phone TEXT,
            email TEXT,
            has_account BOOLEAN NOT NULL DEFAULT false,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
          );
          ALTER TABLE public.customer ADD COLUMN IF NOT EXISTS merchant_id TEXT;
          CREATE INDEX IF NOT EXISTS customer_phone_idx
            ON public.customer(phone) WHERE deleted_at IS NULL;

          CREATE TABLE IF NOT EXISTS public.product (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            handle TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            metadata JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
          );
          ALTER TABLE public.product ADD COLUMN IF NOT EXISTS merchant_id TEXT;
          CREATE UNIQUE INDEX IF NOT EXISTS product_handle_unique_idx
            ON public.product(handle) WHERE deleted_at IS NULL;
          CREATE INDEX IF NOT EXISTS product_status_idx
            ON public.product(status) WHERE deleted_at IS NULL;

          CREATE TABLE IF NOT EXISTS public.product_variant (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT 'Default',
            sku TEXT,
            barcode TEXT,
            product_id TEXT NOT NULL REFERENCES public.product(id) ON UPDATE CASCADE ON DELETE CASCADE,
            manage_inventory BOOLEAN NOT NULL DEFAULT true,
            variant_rank INT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
          );
          CREATE INDEX IF NOT EXISTS product_variant_product_idx
            ON public.product_variant(product_id) WHERE deleted_at IS NULL;

          DO $$
          BEGIN
            IF to_regclass('public.product') IS NOT NULL
              AND to_regclass('public.product_variant') IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'product'
                  AND column_name = 'merchant_id'
              ) THEN
              EXECUTE $vision_backfill$
                INSERT INTO app.product_variant_images (
                  merchant_id,
                  store_id,
                  product_id,
                  variant_id,
                  image_url,
                  image_type,
                  source,
                  quality_status,
                  is_primary,
                  metadata
                )
                SELECT
                  p.merchant_id,
                  s.id AS store_id,
                  p.id AS product_id,
                  v.id AS variant_id,
                  p.metadata->>'imageUrl' AS image_url,
                  'primary' AS image_type,
                  'metadata_backfill' AS source,
                  'pending' AS quality_status,
                  true AS is_primary,
                  jsonb_build_object('source', 'public.product.metadata.imageUrl')
                FROM public.product p
                JOIN public.product_variant v
                  ON v.product_id = p.id
                 AND v.deleted_at IS NULL
                LEFT JOIN app.stores s
                  ON s.merchant_id = p.merchant_id
                 AND s.is_primary = true
                 AND s.status = 'active'
                WHERE p.deleted_at IS NULL
                  AND p.merchant_id IS NOT NULL
                  AND COALESCE(p.metadata->>'imageUrl', '') <> ''
                  AND NOT EXISTS (
                    SELECT 1
                    FROM app.product_variant_images existing
                    WHERE existing.merchant_id = p.merchant_id
                      AND existing.store_id IS NOT DISTINCT FROM s.id
                      AND existing.variant_id = v.id
                      AND (
                        existing.image_url = p.metadata->>'imageUrl'
                        OR existing.is_primary = true
                      )
                  )
              $vision_backfill$;
            END IF;
          END $$;

          CREATE TABLE IF NOT EXISTS public.price_set (
            id TEXT PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
          );
          ALTER TABLE public.price_set ADD COLUMN IF NOT EXISTS merchant_id TEXT;

          CREATE TABLE IF NOT EXISTS public.product_variant_price_set (
            id TEXT PRIMARY KEY,
            variant_id TEXT NOT NULL REFERENCES public.product_variant(id) ON UPDATE CASCADE ON DELETE CASCADE,
            price_set_id TEXT NOT NULL REFERENCES public.price_set(id) ON UPDATE CASCADE ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ,
            UNIQUE (variant_id, price_set_id)
          );
          CREATE INDEX IF NOT EXISTS product_variant_price_set_variant_idx
            ON public.product_variant_price_set(variant_id) WHERE deleted_at IS NULL;

          CREATE TABLE IF NOT EXISTS public.price (
            id TEXT PRIMARY KEY,
            price_set_id TEXT NOT NULL REFERENCES public.price_set(id) ON UPDATE CASCADE ON DELETE CASCADE,
            currency_code TEXT NOT NULL DEFAULT 'vnd',
            amount NUMERIC(14,2) NOT NULL DEFAULT 0,
            raw_amount JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
          );
          CREATE INDEX IF NOT EXISTS price_price_set_currency_idx
            ON public.price(price_set_id, currency_code) WHERE deleted_at IS NULL;

          CREATE TABLE IF NOT EXISTS public.inventory_item (
            id TEXT PRIMARY KEY,
            sku TEXT,
            title TEXT NOT NULL,
            requires_shipping BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
          );
          CREATE INDEX IF NOT EXISTS inventory_item_sku_idx
            ON public.inventory_item(sku) WHERE deleted_at IS NULL;

          CREATE TABLE IF NOT EXISTS public.product_variant_inventory_item (
            id TEXT PRIMARY KEY,
            variant_id TEXT NOT NULL REFERENCES public.product_variant(id) ON UPDATE CASCADE ON DELETE CASCADE,
            inventory_item_id TEXT NOT NULL REFERENCES public.inventory_item(id) ON UPDATE CASCADE ON DELETE CASCADE,
            required_quantity NUMERIC(14,2) NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ,
            UNIQUE (variant_id, inventory_item_id)
          );
          CREATE INDEX IF NOT EXISTS product_variant_inventory_item_variant_idx
            ON public.product_variant_inventory_item(variant_id) WHERE deleted_at IS NULL;
          CREATE INDEX IF NOT EXISTS product_variant_inventory_item_item_idx
            ON public.product_variant_inventory_item(inventory_item_id) WHERE deleted_at IS NULL;

          CREATE TABLE IF NOT EXISTS public.inventory_level (
            id TEXT PRIMARY KEY,
            inventory_item_id TEXT NOT NULL REFERENCES public.inventory_item(id) ON UPDATE CASCADE ON DELETE CASCADE,
            location_id TEXT NOT NULL REFERENCES public.stock_location(id) ON UPDATE CASCADE ON DELETE CASCADE,
            stocked_quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
            reserved_quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
            incoming_quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
          );
          CREATE UNIQUE INDEX IF NOT EXISTS inventory_level_item_location_unique_idx
            ON public.inventory_level(inventory_item_id, location_id) WHERE deleted_at IS NULL;
          CREATE INDEX IF NOT EXISTS inventory_level_item_idx
            ON public.inventory_level(inventory_item_id) WHERE deleted_at IS NULL;

          CREATE SEQUENCE IF NOT EXISTS public.order_display_id_seq START 1;
          CREATE TABLE IF NOT EXISTS public."order" (
            id TEXT PRIMARY KEY,
            display_id INT NOT NULL DEFAULT nextval('public.order_display_id_seq'),
            custom_display_id TEXT,
            region_id TEXT REFERENCES public.region(id),
            customer_id TEXT REFERENCES public.customer(id),
            sales_channel_id TEXT REFERENCES public.sales_channel(id),
            status TEXT NOT NULL DEFAULT 'pending',
            email TEXT,
            currency_code TEXT NOT NULL DEFAULT 'vnd',
            metadata JSONB NOT NULL DEFAULT '{}',
            canceled_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
	          );
	          ALTER TABLE public."order" ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
	          ALTER TABLE public."order" ADD COLUMN IF NOT EXISTS merchant_id TEXT;
	          ALTER TABLE public."order" ADD COLUMN IF NOT EXISTS store_id TEXT;
	          CREATE INDEX IF NOT EXISTS order_customer_idx
	            ON public."order"(customer_id) WHERE deleted_at IS NULL;
	          CREATE INDEX IF NOT EXISTS order_created_idx
	            ON public."order"(created_at DESC) WHERE deleted_at IS NULL;
	          CREATE INDEX IF NOT EXISTS order_shift_id_idx
	            ON public."order" ((metadata->>'shiftId'))
	            WHERE deleted_at IS NULL AND metadata ? 'shiftId';
	          CREATE INDEX IF NOT EXISTS order_scope_created_idx
	            ON public."order"(merchant_id, store_id, created_at DESC)
	            WHERE deleted_at IS NULL;

          CREATE TABLE IF NOT EXISTS public.order_line_item (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            variant_id TEXT,
            product_id TEXT,
            product_title TEXT,
            product_handle TEXT,
            variant_sku TEXT,
            variant_barcode TEXT,
            variant_title TEXT,
            unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
            raw_unit_price JSONB NOT NULL DEFAULT '{}',
            is_tax_inclusive BOOLEAN NOT NULL DEFAULT true,
            metadata JSONB NOT NULL DEFAULT '{}',
            totals_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
          );

          CREATE TABLE IF NOT EXISTS public.order_item (
            id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL REFERENCES public."order"(id) ON UPDATE CASCADE ON DELETE CASCADE,
            version INT NOT NULL DEFAULT 1,
            item_id TEXT NOT NULL REFERENCES public.order_line_item(id) ON UPDATE CASCADE ON DELETE CASCADE,
            quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
            raw_quantity JSONB NOT NULL DEFAULT '{}',
            fulfilled_quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
            shipped_quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
            return_requested_quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
            return_received_quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
            return_dismissed_quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
            written_off_quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
            delivered_quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
            unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
            raw_unit_price JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
          );
          CREATE INDEX IF NOT EXISTS order_item_order_idx
            ON public.order_item(order_id) WHERE deleted_at IS NULL;

          CREATE TABLE IF NOT EXISTS public.order_summary (
            id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL REFERENCES public."order"(id) ON UPDATE CASCADE ON DELETE CASCADE,
            version INT NOT NULL DEFAULT 1,
            totals JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
          );
          CREATE INDEX IF NOT EXISTS order_summary_order_idx
            ON public.order_summary(order_id) WHERE deleted_at IS NULL;
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS public.product_category (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            handle TEXT NOT NULL,
            mpath TEXT NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT false,
            is_internal BOOLEAN NOT NULL DEFAULT false,
            rank INT NOT NULL DEFAULT 0,
            parent_category_id TEXT REFERENCES public.product_category(id) ON UPDATE CASCADE ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ,
            metadata JSONB,
            external_id TEXT
          );
          ALTER TABLE public.product_category ADD COLUMN IF NOT EXISTS merchant_id TEXT;
          CREATE UNIQUE INDEX IF NOT EXISTS "IDX_category_handle_unique"
            ON public.product_category(handle) WHERE deleted_at IS NULL;
          CREATE INDEX IF NOT EXISTS "IDX_product_category_parent_category_id"
            ON public.product_category(parent_category_id) WHERE deleted_at IS NULL;
          CREATE INDEX IF NOT EXISTS "IDX_product_category_path"
            ON public.product_category(mpath) WHERE deleted_at IS NULL;

          CREATE TABLE IF NOT EXISTS public.product_category_product (
            product_id TEXT NOT NULL REFERENCES public.product(id) ON UPDATE CASCADE ON DELETE CASCADE,
            product_category_id TEXT NOT NULL REFERENCES public.product_category(id) ON UPDATE CASCADE ON DELETE CASCADE,
            PRIMARY KEY (product_id, product_category_id)
          );
        `);

        await seedPlatformData(client);
      } finally {
        client.release();
      }
    })();
  }
  return schemaReady;
}

export type SeedPlatformDataOptions = {
  includeDemoData?: boolean;
};

export function shouldIncludeDemoData(
  options?: SeedPlatformDataOptions,
): boolean {
  // App startup may call this compatibility bootstrap in production. Demo data
  // must stay local-only even when an environment flag is misconfigured.
  if (process.env.NODE_ENV === "production") return false;
  if (options?.includeDemoData !== undefined) return options.includeDemoData;
  if (process.env.PLATFORM_DEMO_SEED === "true") return true;
  if (process.env.PLATFORM_DEMO_SEED === "false") return false;
  return process.env.NODE_ENV === "test";
}

const entitlementFeatureKeys = [
  "sepay_qr_payment",
  "crypto_payment",
  "smart_cross_sell",
  "product_research",
  "customer_scan_go",
  "telegram_ai_ordering",
  "telegram_sales_channel",
  "vision_pos_input",
  "vision_pos_single_capture",
  "vision_pos_bulk_capture",
  "vision_debug_image_storage",
  "vision_correction_report",
] as const;

export function resolveEnvEntitlementSeed(
  env: NodeJS.ProcessEnv = process.env,
) {
  const envPackageKey = String(env.APP_PACKAGE_KEY || "basic")
    .trim()
    .toLowerCase();
  const packageKey =
    envPackageKey === "plus" || envPackageKey === "ai_fan"
      ? envPackageKey
      : "basic";
  const packageFeatures = {
    basic: [],
    plus: [
      "sepay_qr_payment",
      "crypto_payment",
      "smart_cross_sell",
      "product_research",
      "customer_scan_go",
    ],
    ai_fan: [
      "sepay_qr_payment",
      "crypto_payment",
      "smart_cross_sell",
      "product_research",
      "customer_scan_go",
      "telegram_ai_ordering",
      "telegram_sales_channel",
      "vision_pos_input",
      "vision_pos_single_capture",
      "vision_correction_report",
    ],
  }[packageKey];
  const forcedFeatures = String(env.FEATURE_FLAGS || "")
    .split(",")
    .map((value) => value.trim())
    .map(
      (value) =>
        ({
          sepay_payments: "sepay_qr_payment",
          crypto_payments: "crypto_payment",
          cross_sell: "smart_cross_sell",
        })[value] || value,
    )
    .filter((value): value is (typeof entitlementFeatureKeys)[number] =>
      entitlementFeatureKeys.includes(value as never),
    );

  return {
    packageKey,
    entitlementFeatures: Array.from(
      new Set([...packageFeatures, ...forcedFeatures]),
    ),
  };
}

export async function ensureCryptoAssetEvidenceSchema(
  client: Pick<PoolClient, "query">,
): Promise<void> {
  // Bootstrap stubs for crypto asset evidence tables.
  // Production runs 007_crypto_asset_evidence.sql through the migration runner.
  await client.query(`
    CREATE TABLE IF NOT EXISTS accounting.crypto_receipt_evidence (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      evidence_id TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL DEFAULT 'nowpayments' CHECK (provider IN ('nowpayments')),
      provider_event_id TEXT,
      merchant_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      order_id TEXT,
      payment_entry_id UUID,
      payment_intent_id TEXT,
      provider_payment_id TEXT,
      business_purpose TEXT NOT NULL DEFAULT 'retail_order' CHECK (business_purpose = 'retail_order'),
      asset TEXT NOT NULL CHECK (asset IN ('USDT', 'USDC')),
      network TEXT NOT NULL CHECK (network IN ('TRC20', 'MATIC')),
      retail_crypto_asset TEXT NOT NULL CHECK (retail_crypto_asset IN ('USDTTRC20', 'USDCMATIC')),
      gross_quantity NUMERIC(36,18) NOT NULL CHECK (gross_quantity > 0),
      provider_fee_quantity NUMERIC(36,18) NOT NULL DEFAULT 0 CHECK (provider_fee_quantity >= 0),
      net_quantity NUMERIC(36,18) NOT NULL CHECK (net_quantity >= 0),
      fee_asset TEXT CHECK (fee_asset IN ('USDT', 'USDC')),
      tx_hash TEXT NOT NULL,
      destination_wallet_ref TEXT NOT NULL,
      custody_account_ref TEXT,
      provider_config_id TEXT,
      provider_config_purpose TEXT NOT NULL DEFAULT 'merchant_retail' CHECK (provider_config_purpose = 'merchant_retail'),
      wallet_provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
      quote_id TEXT,
      quote_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      valuation_rate NUMERIC(36,12) NOT NULL CHECK (valuation_rate > 0),
      valuation_rate_source TEXT NOT NULL,
      valuation_timestamp TIMESTAMPTZ NOT NULL,
      gross_vnd_value NUMERIC(20,0) NOT NULL CHECK (gross_vnd_value >= 0),
      fee_vnd_value NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (fee_vnd_value >= 0),
      net_vnd_value NUMERIC(20,0) NOT NULL CHECK (net_vnd_value >= 0),
      carrying_value_vnd NUMERIC(20,0) NOT NULL CHECK (carrying_value_vnd >= 0),
      sale_journal_entry_id UUID REFERENCES accounting.journal_entries(id),
      fee_journal_entry_id UUID REFERENCES accounting.journal_entries(id),
      evidence_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'verified' CHECK (status IN ('verified', 'ignored', 'manual_review')),
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT crypto_receipt_fee_not_exceed_gross_chk CHECK (provider_fee_quantity <= gross_quantity),
      CONSTRAINT crypto_receipt_net_quantity_chk CHECK (net_quantity = gross_quantity - provider_fee_quantity),
      CONSTRAINT crypto_receipt_asset_network_chk CHECK (
        (retail_crypto_asset = 'USDTTRC20' AND asset = 'USDT' AND network = 'TRC20')
        OR (retail_crypto_asset = 'USDCMATIC' AND asset = 'USDC' AND network = 'MATIC')
      )
    );
    CREATE TABLE IF NOT EXISTS accounting.crypto_asset_lots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lot_id TEXT NOT NULL UNIQUE,
      receipt_evidence_id UUID NOT NULL REFERENCES accounting.crypto_receipt_evidence(id) ON DELETE RESTRICT,
      merchant_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      asset TEXT NOT NULL CHECK (asset IN ('USDT', 'USDC')),
      network TEXT NOT NULL CHECK (network IN ('TRC20', 'MATIC')),
      retail_crypto_asset TEXT NOT NULL CHECK (retail_crypto_asset IN ('USDTTRC20', 'USDCMATIC')),
      wallet_ref TEXT NOT NULL,
      original_quantity NUMERIC(36,18) NOT NULL CHECK (original_quantity >= 0),
      remaining_quantity NUMERIC(36,18) NOT NULL CHECK (remaining_quantity >= 0),
      original_carrying_value_vnd NUMERIC(20,0) NOT NULL CHECK (original_carrying_value_vnd >= 0),
      remaining_carrying_value_vnd NUMERIC(20,0) NOT NULL CHECK (remaining_carrying_value_vnd >= 0),
      valuation_rate NUMERIC(36,12) NOT NULL CHECK (valuation_rate > 0),
      acquired_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT crypto_lot_remaining_quantity_chk CHECK (remaining_quantity <= original_quantity),
      CONSTRAINT crypto_lot_remaining_value_chk CHECK (remaining_carrying_value_vnd <= original_carrying_value_vnd)
    );
    CREATE TABLE IF NOT EXISTS accounting.crypto_treasury_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      treasury_event_id TEXT NOT NULL UNIQUE,
      merchant_id TEXT NOT NULL,
      store_id TEXT,
      event_type TEXT NOT NULL CHECK (event_type IN ('manual_transfer', 'off_ramp', 'disposal')),
      asset TEXT NOT NULL CHECK (asset IN ('USDT', 'USDC')),
      network TEXT NOT NULL CHECK (network IN ('TRC20', 'MATIC')),
      retail_crypto_asset TEXT NOT NULL CHECK (retail_crypto_asset IN ('USDTTRC20', 'USDCMATIC')),
      source_wallet_ref TEXT NOT NULL,
      destination_wallet_ref TEXT,
      quantity NUMERIC(36,18) NOT NULL CHECK (quantity > 0),
      proceeds_vnd NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (proceeds_vnd >= 0),
      fee_quantity NUMERIC(36,18) NOT NULL DEFAULT 0 CHECK (fee_quantity >= 0),
      fee_vnd_value NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (fee_vnd_value >= 0),
      carrying_value_removed_vnd NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (carrying_value_removed_vnd >= 0),
      gain_vnd NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (gain_vnd >= 0),
      loss_vnd NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (loss_vnd >= 0),
      journal_entry_id UUID REFERENCES accounting.journal_entries(id),
      evidence_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      manual_reason TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT crypto_treasury_asset_network_chk CHECK (
        (retail_crypto_asset = 'USDTTRC20' AND asset = 'USDT' AND network = 'TRC20')
        OR (retail_crypto_asset = 'USDCMATIC' AND asset = 'USDC' AND network = 'MATIC')
      )
    );
    CREATE TABLE IF NOT EXISTS accounting.crypto_treasury_event_lots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      treasury_event_id UUID NOT NULL REFERENCES accounting.crypto_treasury_events(id) ON DELETE CASCADE,
      lot_id UUID NOT NULL REFERENCES accounting.crypto_asset_lots(id) ON DELETE RESTRICT,
      quantity_removed NUMERIC(36,18) NOT NULL CHECK (quantity_removed > 0),
      carrying_value_removed_vnd NUMERIC(20,0) NOT NULL CHECK (carrying_value_removed_vnd >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (treasury_event_id, lot_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS crypto_receipt_provider_event_idx
      ON accounting.crypto_receipt_evidence(provider, provider_event_id)
      WHERE provider_event_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS crypto_receipt_tx_wallet_asset_idx
      ON accounting.crypto_receipt_evidence(merchant_id, destination_wallet_ref, retail_crypto_asset, tx_hash);
    CREATE INDEX IF NOT EXISTS crypto_receipt_scope_idx
      ON accounting.crypto_receipt_evidence(merchant_id, store_id, retail_crypto_asset, created_at DESC);
    CREATE INDEX IF NOT EXISTS crypto_receipt_payment_idx
      ON accounting.crypto_receipt_evidence(payment_intent_id, payment_entry_id, order_id);
    CREATE INDEX IF NOT EXISTS crypto_lots_open_fifo_idx
      ON accounting.crypto_asset_lots(merchant_id, wallet_ref, retail_crypto_asset, acquired_at, id)
      WHERE status = 'open' AND remaining_quantity > 0;
    CREATE INDEX IF NOT EXISTS crypto_lots_scope_idx
      ON accounting.crypto_asset_lots(merchant_id, store_id, retail_crypto_asset, status);
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_receipt_fee_not_exceed_gross_chk') THEN
        ALTER TABLE accounting.crypto_receipt_evidence
          ADD CONSTRAINT crypto_receipt_fee_not_exceed_gross_chk CHECK (provider_fee_quantity <= gross_quantity);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_receipt_net_quantity_chk') THEN
        ALTER TABLE accounting.crypto_receipt_evidence
          ADD CONSTRAINT crypto_receipt_net_quantity_chk CHECK (net_quantity = gross_quantity - provider_fee_quantity);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_receipt_asset_network_chk') THEN
        ALTER TABLE accounting.crypto_receipt_evidence
          ADD CONSTRAINT crypto_receipt_asset_network_chk CHECK (
            (retail_crypto_asset = 'USDTTRC20' AND asset = 'USDT' AND network = 'TRC20')
            OR (retail_crypto_asset = 'USDCMATIC' AND asset = 'USDC' AND network = 'MATIC')
          );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_lot_remaining_quantity_chk') THEN
        ALTER TABLE accounting.crypto_asset_lots
          ADD CONSTRAINT crypto_lot_remaining_quantity_chk CHECK (remaining_quantity <= original_quantity);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_lot_remaining_value_chk') THEN
        ALTER TABLE accounting.crypto_asset_lots
          ADD CONSTRAINT crypto_lot_remaining_value_chk CHECK (remaining_carrying_value_vnd <= original_carrying_value_vnd);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_treasury_asset_network_chk') THEN
        ALTER TABLE accounting.crypto_treasury_events
          ADD CONSTRAINT crypto_treasury_asset_network_chk CHECK (
            (retail_crypto_asset = 'USDTTRC20' AND asset = 'USDT' AND network = 'TRC20')
            OR (retail_crypto_asset = 'USDCMATIC' AND asset = 'USDC' AND network = 'MATIC')
          );
      END IF;
    END $$;
  `);
}

export async function seedPackageCatalog(
  client: Pick<PoolClient, "query">,
): Promise<void> {
  await client.query(`
    INSERT INTO app.package_catalog_versions
      (id, catalog_version, package_key, annual_price_vnd, included_stores, staff_limit,
       research_runs_per_month, telegram_ai_drafts_per_month, feature_keys, effective_from, metadata)
    VALUES
      ('pcv_1_1_2_annual_v1_basic', '1.1.2-annual-v1', 'basic', 0, 1, 3, 0, 0,
       '["pos_core","accounting_core"]'::jsonb, '2026-06-20T00:00:00Z', '{"taxInclusive": true}'::jsonb),
      ('pcv_1_1_2_annual_v1_plus', '1.1.2-annual-v1', 'plus', 3588000, 3, 10, 100, 0,
       '["pos_core","accounting_core","sepay_qr_payment","crypto_payment","smart_cross_sell","product_research","customer_scan_go"]'::jsonb,
       '2026-06-20T00:00:00Z', '{"taxInclusive": true}'::jsonb),
      ('pcv_1_1_2_annual_v1_ai_fan', '1.1.2-annual-v1', 'ai_fan', 7188000, 5, 30, 500, 2000,
       '["pos_core","accounting_core","telegram_runtime","sepay_qr_payment","crypto_payment","smart_cross_sell","product_research","customer_scan_go","telegram_ai_ordering","telegram_sales_channel","vision_pos_input","vision_pos_single_capture","vision_correction_report"]'::jsonb,
       '2026-06-20T00:00:00Z', '{"taxInclusive": true}'::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      annual_price_vnd = EXCLUDED.annual_price_vnd,
      included_stores = EXCLUDED.included_stores,
      staff_limit = EXCLUDED.staff_limit,
      research_runs_per_month = EXCLUDED.research_runs_per_month,
      telegram_ai_drafts_per_month = EXCLUDED.telegram_ai_drafts_per_month,
      feature_keys = EXCLUDED.feature_keys,
      metadata = EXCLUDED.metadata
  `);
}

export async function seedEnvEntitlements(
  client: Pick<PoolClient, "query">,
): Promise<void> {
  const { packageKey, entitlementFeatures } = resolveEnvEntitlementSeed();

  await client.query(
    `
    INSERT INTO app.package_entitlements (organization_id, package_key, metadata)
    SELECT 'org_default', $1, jsonb_build_object('source', 'env')
    WHERE NOT EXISTS (
      SELECT 1 FROM app.package_entitlements
      WHERE organization_id = 'org_default' AND effective_to IS NULL
    )
  `,
    [packageKey],
  );

  for (const feature of entitlementFeatureKeys) {
    await client.query(
      `
      INSERT INTO app.feature_entitlements (organization_id, feature_key, enabled, package_key, metadata)
      VALUES ('org_default', $1, $2, $3, jsonb_build_object('source', 'env'))
      ON CONFLICT (organization_id, feature_key) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        package_key = EXCLUDED.package_key,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      WHERE app.feature_entitlements.metadata->>'source' = 'env'
        AND NOT EXISTS (
          SELECT 1
          FROM app.package_entitlements purchased
          WHERE purchased.organization_id = app.feature_entitlements.organization_id
            AND purchased.effective_to IS NULL
            AND COALESCE(purchased.metadata->>'source', '') <> 'env'
        )
    `,
      [feature, entitlementFeatures.includes(feature), packageKey],
    );
  }
}

export async function seedPlatformData(
  clientArg?: PoolClient,
  options?: SeedPlatformDataOptions,
): Promise<void> {
  const includeDemoData = shouldIncludeDemoData(options);
  const run = async (client: PoolClient) => {
    await client.query(`
      INSERT INTO public.region (id, name, currency_code, automatic_taxes)
      VALUES ('reg_vn', 'Vietnam', 'vnd', true)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, currency_code = EXCLUDED.currency_code;

      INSERT INTO public.sales_channel (id, name, description, is_disabled)
      VALUES
        ('sc_pos', 'POS Counter', 'In-store sales', false),
        ('sc_remote', 'Remote Channel', 'Orders created by channel adapters', false),
        ('sc_stash_dash', 'Stash Dash', 'Customer self-scan cart imports', false)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        is_disabled = false;

      INSERT INTO public.stock_location (id, name)
      VALUES ('sloc_default', 'Default Store')
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

      INSERT INTO app.merchants (id, display_name, legacy_organization_id, status)
      VALUES ('merchant_default', 'Default Merchant', 'org_default', 'active')
      ON CONFLICT (id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        legacy_organization_id = EXCLUDED.legacy_organization_id,
        status = 'active';

      INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status)
      VALUES ('store_default', 'merchant_default', 'Default Store', 'sloc_default', true, 'active')
      ON CONFLICT (id) DO UPDATE SET
        merchant_id = EXCLUDED.merchant_id,
        display_name = EXCLUDED.display_name,
        stock_location_id = EXCLUDED.stock_location_id,
        is_primary = true,
        status = 'active';
    `);

    await client.query(`
      INSERT INTO accounting.accounts (code, name, type) VALUES
        ('1111', 'Tiền mặt', 'asset'),
        ('1121', 'Tiền gửi ngân hàng', 'asset'),
        ('1122', 'Tài sản stablecoin/crypto', 'asset'),
        ('1311', 'Phải thu khách hàng', 'asset'),
        ('1561', 'Hàng hóa', 'asset'),
        ('3311', 'Phải trả người bán', 'liability'),
        ('3331', 'Thuế GTGT phải nộp', 'liability'),
        ('4111', 'Vốn chủ sở hữu', 'equity'),
        ('4211', 'Lợi nhuận chưa phân phối', 'equity'),
        ('5111', 'Doanh thu bán hàng hóa', 'revenue'),
        ('5112', 'Doanh thu vận chuyển', 'revenue'),
        ('5113', 'Doanh thu phí thanh toán', 'revenue'),
        ('5151', 'Doanh thu tài chính', 'revenue'),
        ('5152', 'Lãi thanh lý tài sản stablecoin/crypto', 'revenue'),
        ('7111', 'Thu nhập khác từ chênh lệch kiểm kê', 'revenue'),
        ('6321', 'Giá vốn hàng bán', 'expense'),
        ('6351', 'Lỗ thanh lý tài sản stablecoin/crypto', 'expense'),
        ('6421', 'Chi phí bán hàng', 'expense'),
        ('6422', 'Chi phí quản lý doanh nghiệp', 'expense'),
        ('6423', 'Chi phí nhà cung cấp thanh toán', 'expense')
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type;

      INSERT INTO ai_module.loyalty_tiers (name, points_threshold, discount_percent, description, merchant_id) VALUES
        ('bronze', 0, 0, 'Mặc định cho khách hàng mới', 'merchant_default'),
        ('silver', 100, 2, 'Tích lũy 100 điểm', 'merchant_default'),
        ('gold', 500, 5, 'Tích lũy 500 điểm', 'merchant_default'),
        ('platinum', 1000, 10, 'Tích lũy 1000 điểm', 'merchant_default')
      ON CONFLICT DO NOTHING;

      UPDATE ai_module.loyalty_tiers
      SET points_threshold = defaults.points_threshold,
          discount_percent = defaults.discount_percent,
          description = defaults.description
      FROM (VALUES
        ('bronze', 0, 0::numeric, 'Mặc định cho khách hàng mới'),
        ('silver', 100, 2::numeric, 'Tích lũy 100 điểm'),
        ('gold', 500, 5::numeric, 'Tích lũy 500 điểm'),
        ('platinum', 1000, 10::numeric, 'Tích lũy 1000 điểm')
      ) AS defaults(name, points_threshold, discount_percent, description)
      WHERE ai_module.loyalty_tiers.merchant_id = 'merchant_default'
        AND ai_module.loyalty_tiers.name = defaults.name;
    `);

    await client.query(`
      INSERT INTO app.permissions (id, description) VALUES
        ('inventory:read', 'Read products and inventory through channel adapters'),
        ('orders:read', 'Read orders through channel adapters'),
        ('reports:read', 'Read dashboard and reports through channel adapters'),
        ('remote_order:create', 'Create remote orders through channel adapters'),
        ('order:cancel', 'Cancel orders'),
        ('order:cancel_own', 'Cancel own orders within the authorized store'),
        ('dashboard:self:read', 'Read the operator self-only sales dashboard'),
        ('order:refund', 'Create order refunds'),
        ('order:correct', 'Create auditable order corrections'),
        ('accounting:read', 'Read accounting reports'),
        ('ai:review', 'Approve or reject AI review actions'),
        ('payment_intent:create', 'Create external payment intents'),
        ('payment_intent:read', 'Read external payment intents'),
        ('payment_intent:resolve', 'Resolve external payment intents'),
        ('recommendation:read', 'Read cross-sell recommendations'),
        ('product_research:run', 'Run product research'),
        ('product_research:read', 'Read product research results'),
        ('telegram_ai_order:create', 'Create AI-assisted Telegram order drafts'),
        ('subscription:read', 'Read merchant subscription package state'),
        ('subscription:bill', 'Create package billing orders'),
        ('subscription:apply', 'Apply verified subscription purchases'),
        ('integration_config:read', 'Read integration configuration status without secrets'),
        ('integration_config:write', 'Write integration configuration secrets'),
        ('platform:read', 'Read platform administration data'),
        ('platform:write', 'Change platform administration data'),
        ('catalog:write', 'Create, update, or delete merchant catalog data'),
        ('customer:write', 'Create, update, delete, merge merchant customers, or send receipt emails'),
        ('loyalty:write', 'Change merchant loyalty data'),
        ('accounting:write', 'Create, post, update, or void merchant journal entries'),
        ('order:write', 'Change merchant orders, shipping, or corrections'),
        ('inventory:write', 'Adjust inventory or manage purchase-order stock movements'),
        ('catalog:read', 'Read merchant catalog data'),
        ('category:read', 'Read merchant category names, status and product counts'),
        ('customer:read', 'Read merchant customer data'),
        ('loyalty:read', 'Read merchant loyalty data'),
        ('settings:read', 'Read merchant-owned settings'),
        ('settings:write', 'Update merchant-owned settings'),
        ('orders:export', 'Export order reports as CSV'),
        ('scan_go:redeem', 'Redeem customer Scan & Go carts in POS'),
        ('vision_scan:use', 'Use vision-assisted product input in POS'),
        ('vision_scan:read', 'Read vision scan events and outcomes'),
        ('vision_catalog:write', 'Manage vision catalog reference images and provider index state'),
        ('vision_debug_image:enable', 'Enable temporary debug image retention for failed or ambiguous vision scans'),
        ('profile:read', 'Read own operator profile and security state'),
        ('profile:write', 'Update own operator profile metadata'),
        ('profile:password_write', 'Change own operator password'),
        ('profile:telegram_write', 'Link or unlink own Telegram identity'),
        ('team:read', 'Read merchant team operators and memberships'),
        ('team:write', 'Create or update merchant team non-owner operators'),
        ('team:reset_password', 'Reset merchant team non-owner passwords'),
        ('platform_operator:read', 'Read platform-wide operators and security state'),
	        ('platform_operator:reset_password', 'Reset operator password from platform administration'),
	        ('platform_operator:suspend', 'Suspend or unsuspend an operator globally'),
	        ('platform_membership:write', 'Grant or revoke platform-sensitive permissions'),
	        ('platform_impersonation:start', 'Start read-only platform owner impersonation'),
	        ('shift:open', 'Open POS shifts and acknowledge handovers'),
	        ('shift:close', 'Close POS shifts and record close evidence'),
	        ('shift:read', 'Read POS shift status and shift history'),
	        ('shift:cash_adjust', 'Record operational shift cash movements'),
	        ('shift:review', 'Approve or flag closed shift reviews'),
	        ('shift:manage', 'Manage stale shifts and force-close operational shifts'),
	        ('shift:report', 'Read full shift reconciliation and productivity reports')
	      ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description;

      INSERT INTO app.role_permissions (role, permission_id) VALUES
        ('staff', 'order:cancel_own'),
        ('staff', 'dashboard:self:read'),
        ('staff', 'inventory:read'),
        ('staff', 'orders:read'),
        ('staff', 'remote_order:create'),
        ('staff', 'payment_intent:create'),
        ('staff', 'payment_intent:read'),
        ('staff', 'recommendation:read'),
        ('staff', 'product_research:read'),
        ('staff', 'catalog:read'),
        ('staff', 'category:read'),
        ('staff', 'customer:read'),
        ('staff', 'customer:write'),
        ('staff', 'vision_scan:use'),
	        ('staff', 'profile:read'),
	        ('staff', 'profile:write'),
	        ('staff', 'profile:password_write'),
	        ('staff', 'profile:telegram_write'),
	        ('staff', 'shift:open'),
	        ('staff', 'shift:close'),
	        ('staff', 'shift:read'),
	        ('staff', 'shift:cash_adjust'),
	        ('manager', 'inventory:read'),
        ('manager', 'orders:read'),
        ('manager', 'reports:read'),
        ('manager', 'remote_order:create'),
        ('manager', 'order:cancel'),
        ('manager', 'order:correct'),
        ('manager', 'accounting:read'),
        ('manager', 'ai:review'),
        ('manager', 'payment_intent:create'),
        ('manager', 'payment_intent:read'),
        ('manager', 'payment_intent:resolve'),
        ('manager', 'recommendation:read'),
        ('manager', 'product_research:run'),
        ('manager', 'product_research:read'),
        ('manager', 'telegram_ai_order:create'),
        ('manager', 'catalog:write'),
        ('manager', 'customer:write'),
        ('manager', 'loyalty:write'),
        ('manager', 'order:write'),
        ('manager', 'inventory:write'),
        ('manager', 'catalog:read'),
        ('manager', 'category:read'),
        ('manager', 'customer:read'),
        ('manager', 'loyalty:read'),
        ('manager', 'orders:export'),
        ('manager', 'scan_go:redeem'),
        ('manager', 'vision_scan:use'),
        ('manager', 'vision_scan:read'),
        ('manager', 'vision_catalog:write'),
        ('manager', 'profile:read'),
        ('manager', 'profile:write'),
        ('manager', 'profile:password_write'),
        ('manager', 'profile:telegram_write'),
	        ('manager', 'team:read'),
	        ('manager', 'team:write'),
	        ('manager', 'team:reset_password'),
	        ('manager', 'shift:open'),
	        ('manager', 'shift:close'),
	        ('manager', 'shift:read'),
	        ('manager', 'shift:cash_adjust'),
	        ('manager', 'shift:review'),
	        ('manager', 'shift:manage'),
	        ('manager', 'shift:report'),
	        ('accountant', 'accounting:read'),
        ('accountant', 'category:read'),
        ('accountant', 'customer:read'),
        ('accountant', 'customer:write'),
        ('accountant', 'reports:read'),
        ('accountant', 'accounting:write'),
        ('accountant', 'orders:export'),
        ('accountant', 'profile:read'),
        ('accountant', 'profile:write'),
        ('accountant', 'profile:password_write'),
        ('accountant', 'profile:telegram_write'),
        ('owner', 'inventory:read'),
        ('owner', 'orders:read'),
        ('owner', 'reports:read'),
        ('owner', 'remote_order:create'),
        ('owner', 'order:cancel'),
        ('owner', 'order:refund'),
        ('owner', 'order:correct'),
        ('owner', 'accounting:read'),
        ('owner', 'ai:review'),
        ('owner', 'payment_intent:create'),
        ('owner', 'payment_intent:read'),
        ('owner', 'payment_intent:resolve'),
        ('owner', 'recommendation:read'),
        ('owner', 'product_research:run'),
        ('owner', 'product_research:read'),
        ('owner', 'telegram_ai_order:create'),
        ('owner', 'catalog:write'),
        ('owner', 'customer:write'),
        ('owner', 'loyalty:write'),
        ('owner', 'accounting:write'),
        ('owner', 'order:write'),
        ('owner', 'inventory:write'),
        ('owner', 'subscription:read'),
        ('owner', 'subscription:bill'),
        ('owner', 'integration_config:read'),
        ('owner', 'settings:read'),
        ('owner', 'settings:write'),
        ('owner', 'catalog:read'),
        ('owner', 'category:read'),
        ('owner', 'customer:read'),
        ('owner', 'loyalty:read'),
        ('owner', 'orders:export'),
        ('owner', 'scan_go:redeem'),
        ('owner', 'vision_scan:use'),
        ('owner', 'vision_scan:read'),
        ('owner', 'vision_catalog:write'),
        ('owner', 'vision_debug_image:enable'),
        ('owner', 'profile:read'),
        ('owner', 'profile:write'),
        ('owner', 'profile:password_write'),
        ('owner', 'profile:telegram_write'),
	        ('owner', 'team:read'),
	        ('owner', 'team:write'),
	        ('owner', 'team:reset_password'),
	        ('owner', 'shift:open'),
	        ('owner', 'shift:close'),
	        ('owner', 'shift:read'),
	        ('owner', 'shift:cash_adjust'),
	        ('owner', 'shift:review'),
	        ('owner', 'shift:manage'),
	        ('owner', 'shift:report'),
	        ('staff', 'scan_go:redeem')
      ON CONFLICT (role, permission_id) DO NOTHING;
    `);

    if (!includeDemoData) return;
    const demoPasswordHash = process.env.DEMO_PASSWORD_HASH || await hashPassword(randomBytes(32).toString("hex"), 12);

    await client.query(
      `
      INSERT INTO medusa.staff_users (operator_id, password_hash, display_name, role) VALUES
        ('op_owner', $1, 'Store Owner', 'owner'),
        ('op_staff1', $1, 'Nhan Vien 1', 'staff'),
        ('op_manager', $1, 'Quan Ly', 'manager'),
        ('op_accountant', $1, 'Ke Toan', 'accountant')
      ON CONFLICT (operator_id) DO NOTHING;
    `,
      [demoPasswordHash],
    );

    await client.query(`
      UPDATE app.operator_memberships om
      SET role_key = su.role,
          status = 'active',
          valid_to = NULL,
          updated_at = now()
      FROM medusa.staff_users su
      WHERE om.operator_id = su.operator_id
        AND om.scope_type = 'store'
        AND om.merchant_id = 'merchant_default'
        AND om.store_id = 'store_default'
        AND su.operator_id IN ('op_owner', 'op_staff1', 'op_manager', 'op_accountant')
        AND su.is_active = true;

      INSERT INTO app.operator_memberships
        (operator_id, scope_type, merchant_id, store_id, role_key, status, granted_by)
      SELECT
        su.operator_id,
        'store',
        'merchant_default',
        'store_default',
        su.role,
        'active',
        'seed'
      FROM medusa.staff_users su
      WHERE su.is_active = true
        AND su.operator_id IN ('op_owner', 'op_staff1', 'op_manager', 'op_accountant')
        AND NOT EXISTS (
          SELECT 1
          FROM app.operator_memberships om
          WHERE om.operator_id = su.operator_id
            AND om.scope_type = 'store'
            AND om.merchant_id = 'merchant_default'
            AND om.store_id = 'store_default'
        )
    `);

    await client.query(`
      INSERT INTO public.customer (id, first_name, last_name, phone, email, has_account, merchant_id)
      VALUES ('cus_demo', 'Demo', 'Khach', '0900000000', 'demo@example.local', false, 'merchant_default')
      ON CONFLICT (id) DO UPDATE SET phone = EXCLUDED.phone, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, merchant_id = EXCLUDED.merchant_id;

      INSERT INTO ai_module.customer_profiles (customer_id, phone, total_spent, order_count, merchant_id)
      VALUES ('cus_demo', '0900000000', 0, 0, 'merchant_default')
      ON CONFLICT (customer_id) DO UPDATE SET merchant_id = EXCLUDED.merchant_id;
    `);

    for (const product of DEMO_PRODUCTS) {
      const priceSetId = `ps_${product.variantId}`;
      const inventoryItemId = `iitem_${product.variantId}`;
      const priceId = `price_${product.variantId}`;
      const inventoryLevelId = `ilev_${product.variantId}`;
      await client.query(
        `
        INSERT INTO public.product (id, title, handle, status, metadata, merchant_id)
        VALUES ($1, $2, $3, 'published', $4::jsonb, 'merchant_default')
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          status = 'published',
          metadata = COALESCE(public.product.metadata, '{}'::jsonb) || EXCLUDED.metadata,
          merchant_id = EXCLUDED.merchant_id
      `,
        [
          product.id,
          product.title,
          product.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, ""),
          JSON.stringify({ category: "snus" }),
        ],
      );
      await client.query(
        `
        INSERT INTO public.product_variant (id, title, sku, barcode, product_id, manage_inventory)
        VALUES ($1, 'Default', $2, $3, $4, true)
        ON CONFLICT (id) DO UPDATE SET sku = EXCLUDED.sku, barcode = EXCLUDED.barcode, product_id = EXCLUDED.product_id
      `,
        [product.variantId, product.sku, product.barcode, product.id],
      );
      await client.query(
        `
        INSERT INTO public.price_set (id, merchant_id)
        VALUES ($1, 'merchant_default')
        ON CONFLICT (id) DO UPDATE SET merchant_id = EXCLUDED.merchant_id
      `,
        [priceSetId],
      );
      await client.query(
        `
        INSERT INTO public.product_variant_price_set (id, variant_id, price_set_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (variant_id, price_set_id) DO NOTHING
      `,
        [`pvps_${product.variantId}`, product.variantId, priceSetId],
      );
      await client.query(
        `
        INSERT INTO public.price (id, price_set_id, currency_code, amount, raw_amount)
        VALUES ($1, $2, 'vnd', $3, $4::jsonb)
        ON CONFLICT (id) DO UPDATE SET amount = EXCLUDED.amount, raw_amount = EXCLUDED.raw_amount
      `,
        [
          priceId,
          priceSetId,
          product.price,
          JSON.stringify(rawNumber(product.price)),
        ],
      );
      await client.query(
        `
        INSERT INTO public.inventory_item (id, sku, title, requires_shipping)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (id) DO UPDATE SET sku = EXCLUDED.sku, title = EXCLUDED.title
      `,
        [inventoryItemId, product.sku, product.title],
      );
      await client.query(
        `
        INSERT INTO public.product_variant_inventory_item (id, variant_id, inventory_item_id, required_quantity)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (variant_id, inventory_item_id) DO NOTHING
      `,
        [`pvii_${product.variantId}`, product.variantId, inventoryItemId],
      );
      await client.query(
        `
        INSERT INTO public.inventory_level (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity, incoming_quantity)
        VALUES ($1, $2, 'sloc_default', $3, 0, 0)
        ON CONFLICT (inventory_item_id, location_id) WHERE deleted_at IS NULL
        DO NOTHING
      `,
        [inventoryLevelId, inventoryItemId, product.stock],
      );
      await client.query(
        `
        INSERT INTO inventory.product_settings (variant_id, product_id, cost_price, reorder_level, preferred_stock, merchant_id)
        VALUES ($1, $2, $3, $4, 20, 'merchant_default')
        ON CONFLICT (variant_id) DO UPDATE SET
          product_id = EXCLUDED.product_id,
          cost_price = EXCLUDED.cost_price,
          reorder_level = EXCLUDED.reorder_level,
          merchant_id = EXCLUDED.merchant_id,
          updated_at = now()
      `,
        [
          product.variantId,
          product.id,
          product.costPrice,
          product.reorderLevel,
        ],
      );
    }

    await client.query(`
      INSERT INTO public.product_category (
        id, name, description, handle, mpath, is_active, is_internal, rank, parent_category_id, metadata, merchant_id
      )
      VALUES ('pcat_snus', 'Snus', '', 'snus', 'pcat_snus.', true, false, 0, NULL, '{}'::jsonb, 'merchant_default')
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        handle = EXCLUDED.handle,
        mpath = EXCLUDED.mpath,
        is_active = true,
        is_internal = false,
        rank = EXCLUDED.rank,
        merchant_id = EXCLUDED.merchant_id,
        updated_at = now();

      INSERT INTO public.product_category_product (product_id, product_category_id)
      SELECT p.id, 'pcat_snus'
      FROM public.product p
      WHERE p.deleted_at IS NULL
        AND lower(COALESCE(p.metadata->>'category', '')) = 'snus'
      ON CONFLICT (product_id, product_category_id) DO NOTHING;
    `);
  };

  if (clientArg) return run(clientArg);
  await withConnectedClient(run);
}
