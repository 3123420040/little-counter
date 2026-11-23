import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../db/migrations");

function migrationSql(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), "utf8");
}

const expand = migrationSql("002_tenant_foundation_expand.sql");
const backfill = migrationSql("003_tenant_foundation_backfill_default_scope.sql");
const hardening = migrationSql("013_tenant_constraints_not_valid.sql");
const stockLocationProvenance = migrationSql("015_stock_movement_stock_location.sql");

let client: PoolClient;

async function scalar(sql: string): Promise<string> {
  const result = await client.query<{ value: string }>(sql);
  return String(result.rows[0]?.value ?? "");
}

async function normalizePre019IdentityFixture(): Promise<void> {
  // This suite exercises migrations 002/003 as they ran before migration 019
  // introduced merchant-scoped identity uniqueness. A current development DB
  // can legitimately contain both the retained legacy NULL-scope identity and
  // its scoped replacement. Remove only that later duplicate inside the test
  // transaction; ROLLBACK restores the current database exactly.
  await client.query(`
    DELETE FROM app.operator_identities scoped
    USING app.operator_identities legacy
    WHERE scoped.id <> legacy.id
      AND scoped.merchant_id = 'merchant_default'
      AND legacy.merchant_id IS NULL
      AND scoped.provider = legacy.provider
      AND scoped.provider_user_id = legacy.provider_user_id
  `);
}

async function applyTenantFoundationAtItsHistoricalBoundary(): Promise<void> {
  await client.query(expand);
  const trigger = await client.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgrelid = 'outbox.events'::regclass
        AND tgname = 'outbox_events_causal_identity_immutable_trg'
        AND NOT tgisinternal
    ) AS present
  `);
  if (trigger.rows[0]?.present) {
    await client.query(
      "ALTER TABLE outbox.events DISABLE TRIGGER outbox_events_causal_identity_immutable_trg",
    );
  }
  try {
    await client.query(backfill);
  } finally {
    if (trigger.rows[0]?.present) {
      await client.query(
        "ALTER TABLE outbox.events ENABLE TRIGGER outbox_events_causal_identity_immutable_trg",
      );
    }
  }
}

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
});

afterAll(async () => {
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("002/003 tenant foundation migration", () => {
  it("applies additively, backfills default scope, and is idempotent within a transaction", async () => {
    await client.query("BEGIN");
    try {
      // Ensure sloc_default exists so store_default can bind to it.
      await client.query(
        "INSERT INTO public.stock_location (id, name) VALUES ('sloc_default', 'Default Store') ON CONFLICT (id) DO NOTHING",
      );
      await normalizePre019IdentityFixture();

      // Snapshot invariants before migration.
      const beforeOrders = await scalar(
        'SELECT count(*)::text AS value FROM public."order" WHERE deleted_at IS NULL',
      );
      const beforePaymentSum = await scalar(
        "SELECT COALESCE(sum(amount), 0)::text AS value FROM app.payment_entries WHERE direction = 'charge'",
      );
      const beforeJournalDelta = await scalar(
        "SELECT (COALESCE(sum(debit_amount),0) - COALESCE(sum(credit_amount),0))::text AS value FROM accounting.journal_lines",
      );
      const beforeActiveStaff = await scalar(
        "SELECT count(*)::text AS value FROM medusa.staff_users WHERE is_active = true",
      );

      // Apply expand + backfill.
      await applyTenantFoundationAtItsHistoricalBoundary();

      // Core tenant tables exist.
      expect(await scalar(
        "SELECT count(*)::text AS value FROM information_schema.tables WHERE table_schema='app' AND table_name IN ('merchants','stores','operator_memberships')",
      )).toBe("3");

      // merchant_default mapped from org_default.
      expect(await scalar(
        "SELECT count(*)::text AS value FROM app.merchants WHERE id='merchant_default' AND legacy_organization_id='org_default'",
      )).toBe("1");

      // store_default is primary and bound to sloc_default.
      expect(await scalar(
        "SELECT count(*)::text AS value FROM app.stores WHERE id='store_default' AND merchant_id='merchant_default' AND stock_location_id='sloc_default' AND is_primary=true",
      )).toBe("1");

      // Nullable tenant columns were added (no NOT NULL).
      expect(await scalar(
        "SELECT is_nullable AS value FROM information_schema.columns WHERE table_schema='public' AND table_name='order' AND column_name='store_id'",
      )).toBe("YES");
      expect(await scalar(
        "SELECT is_nullable AS value FROM information_schema.columns WHERE table_schema='public' AND table_name='product' AND column_name='merchant_id'",
      )).toBe("YES");

      // Backfill: every live product/order is scoped to the default tenant.
      expect(await scalar(
        "SELECT count(*)::text AS value FROM public.product WHERE deleted_at IS NULL AND merchant_id IS NULL",
      )).toBe("0");
      expect(await scalar(
        'SELECT count(*)::text AS value FROM public."order" WHERE deleted_at IS NULL AND (store_id IS NULL OR merchant_id IS NULL)',
      )).toBe("0");

      // Scoped idempotency uniqueness index exists; legacy global unique kept.
      expect(await scalar(
        "SELECT count(*)::text AS value FROM pg_indexes WHERE schemaname='app' AND indexname='idempotency_records_tenant_op_key_unique_idx'",
      )).toBe("1");

      // Memberships derived from active staff users.
      expect(Number(await scalar(
        "SELECT count(*)::text AS value FROM app.operator_memberships WHERE scope_type='store' AND store_id='store_default'",
      ))).toBe(Number(beforeActiveStaff));

      // Invariants unchanged by the additive migration.
      expect(await scalar('SELECT count(*)::text AS value FROM public."order" WHERE deleted_at IS NULL')).toBe(beforeOrders);
      expect(await scalar("SELECT COALESCE(sum(amount),0)::text AS value FROM app.payment_entries WHERE direction='charge'")).toBe(beforePaymentSum);
      expect(await scalar("SELECT (COALESCE(sum(debit_amount),0) - COALESCE(sum(credit_amount),0))::text AS value FROM accounting.journal_lines")).toBe(beforeJournalDelta);
      expect(Number(beforeJournalDelta)).toBe(0);

      // Idempotency: applying both files again changes nothing.
      const merchantsBefore = await scalar("SELECT count(*)::text AS value FROM app.merchants");
      const membershipsBefore = await scalar("SELECT count(*)::text AS value FROM app.operator_memberships");
      await applyTenantFoundationAtItsHistoricalBoundary();
      expect(await scalar("SELECT count(*)::text AS value FROM app.merchants")).toBe(merchantsBefore);
      expect(await scalar("SELECT count(*)::text AS value FROM app.operator_memberships")).toBe(membershipsBefore);

      // Legacy org_default rows remain readable.
      expect(Number(await scalar(
        "SELECT count(*)::text AS value FROM medusa.staff_users WHERE organization_id='org_default'",
      ))).toBeGreaterThanOrEqual(0);
    } finally {
      // Roll back so the dev database is left untouched by the test.
      await client.query("ROLLBACK");
    }
  });

  it("ledger bootstrap creates app.schema_migrations", async () => {
    const ledger = migrationSql("000_schema_migrations_ledger.sql");
    await client.query("BEGIN");
    try {
      await client.query(ledger);
      expect(await scalar(
        "SELECT count(*)::text AS value FROM information_schema.tables WHERE table_schema='app' AND table_name='schema_migrations'",
      )).toBe("1");
      const cols = await client.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND table_name='schema_migrations' ORDER BY column_name",
      );
      expect(cols.rows.map((row) => row.column_name)).toEqual([
        "applied_at",
        "applied_by",
        "checksum",
        "filename",
      ]);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("validates safe tenant bindings without making compatibility columns required", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO public.stock_location (id, name) VALUES ('sloc_default', 'Default Store') ON CONFLICT (id) DO NOTHING",
      );
      await normalizePre019IdentityFixture();
      await applyTenantFoundationAtItsHistoricalBoundary();
      await client.query(hardening);

      const validated = await client.query<{ conname: string; convalidated: boolean }>(`
        SELECT conname, convalidated
        FROM pg_constraint
        WHERE conname IN (
          'stores_stock_location_fk',
          'operator_memberships_store_merchant_fk',
          'purchase_orders_store_merchant_fk',
          'stock_movements_store_merchant_fk'
        )
        ORDER BY conname
      `);
      expect(validated.rows).toEqual([
        { conname: "operator_memberships_store_merchant_fk", convalidated: true },
        { conname: "purchase_orders_store_merchant_fk", convalidated: true },
        { conname: "stock_movements_store_merchant_fk", convalidated: true },
        { conname: "stores_stock_location_fk", convalidated: true },
      ]);

      await client.query("SAVEPOINT invalid_stock_location");
      await expect(client.query(`
        INSERT INTO app.stores
          (id, merchant_id, display_name, stock_location_id, is_primary, status)
        VALUES
          ('store_invalid_location', 'merchant_default', 'Invalid', 'sloc_missing', false, 'active')
      `)).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT invalid_stock_location");

      await client.query(`
        INSERT INTO app.merchants (id, display_name, legacy_organization_id)
        VALUES
          ('merchant_constraint_a', 'Constraint A', 'org_constraint_a'),
          ('merchant_constraint_b', 'Constraint B', 'org_constraint_b')
      `);
      await client.query(`
        INSERT INTO public.stock_location (id, name)
        VALUES ('sloc_constraint_a', 'Constraint A'), ('sloc_constraint_b', 'Constraint B')
        ON CONFLICT (id) DO NOTHING
      `);
      await client.query(`
        INSERT INTO app.stores
          (id, merchant_id, display_name, stock_location_id, is_primary, status)
        VALUES
          ('store_constraint_a', 'merchant_constraint_a', 'Constraint A', 'sloc_constraint_a', true, 'active'),
          ('store_constraint_b', 'merchant_constraint_b', 'Constraint B', 'sloc_constraint_b', true, 'active')
      `);

      await client.query("SAVEPOINT cross_tenant_membership");
      await expect(client.query(`
        INSERT INTO app.operator_memberships
          (operator_id, scope_type, merchant_id, store_id, role_key, granted_by)
        VALUES
          ('op_cross_tenant', 'store', 'merchant_constraint_a', 'store_constraint_b', 'staff', 'test')
      `)).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT cross_tenant_membership");

      expect(await scalar(
        "SELECT is_nullable AS value FROM information_schema.columns WHERE table_schema='audit' AND table_name='events' AND column_name='store_id'",
      )).toBe("YES");
      expect(await scalar(
        "SELECT is_nullable AS value FROM information_schema.columns WHERE table_schema='accounting' AND table_name='journal_entries' AND column_name='store_id'",
      )).toBe("YES");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("reapplies stock-location provenance safely and enforces tenant-scoped loyalty tiers", async () => {
    await client.query("BEGIN");
    try {
      await client.query(stockLocationProvenance);
      await client.query(stockLocationProvenance);

      expect(await scalar(
        "SELECT is_nullable AS value FROM information_schema.columns WHERE table_schema='medusa' AND table_name='stock_movements' AND column_name='stock_location_id'",
      )).toBe("YES");
      expect(await scalar(
        "SELECT convalidated::text AS value FROM pg_constraint WHERE conname='stock_movements_stock_location_fk'",
      )).toBe("true");
      expect(await scalar(
        "SELECT count(*)::text AS value FROM pg_indexes WHERE schemaname='medusa' AND indexname='stock_movements_store_location_idx'",
      )).toBe("1");
      expect(await scalar(
        "SELECT count(*)::text AS value FROM pg_indexes WHERE schemaname='ai_module' AND indexname='loyalty_tiers_merchant_name_unique_idx'",
      )).toBe("1");
      expect(await scalar(
        "SELECT count(*)::text AS value FROM pg_constraint WHERE conrelid='ai_module.loyalty_tiers'::regclass AND conname='loyalty_tiers_name_key'",
      )).toBe("0");

      await client.query(`
        INSERT INTO app.merchants (id, display_name, legacy_organization_id)
        VALUES
          ('merchant_tier_scope_a', 'Tier Scope A', 'org_tier_scope_a'),
          ('merchant_tier_scope_b', 'Tier Scope B', 'org_tier_scope_b')
        ON CONFLICT (id) DO NOTHING
      `);
      await client.query(`
        INSERT INTO ai_module.loyalty_tiers
          (name, points_threshold, discount_percent, description, merchant_id)
        VALUES
          ('fixture-shared-tier', 0, 0, 'A', 'merchant_tier_scope_a'),
          ('fixture-shared-tier', 0, 0, 'B', 'merchant_tier_scope_b')
      `);
      await client.query("SAVEPOINT duplicate_tier");
      await expect(client.query(`
        INSERT INTO ai_module.loyalty_tiers
          (name, points_threshold, discount_percent, description, merchant_id)
        VALUES ('fixture-shared-tier', 10, 1, 'Duplicate', 'merchant_tier_scope_a')
      `)).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT duplicate_tier");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
