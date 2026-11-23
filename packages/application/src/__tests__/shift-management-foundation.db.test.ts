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

const shiftMigration = migrationSql("025_shift_management.sql");

let client: PoolClient;

async function scalar(sql: string): Promise<string> {
  const result = await client.query<{ value: string }>(sql);
  return String(result.rows[0]?.value ?? "");
}

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
});

afterAll(async () => {
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("025 shift management foundation", () => {
  it("creates shift tables, grants, and indexes idempotently", async () => {
    await client.query("BEGIN");
    try {
      await client.query(shiftMigration);
      await client.query(shiftMigration);

      expect(await scalar(`
        SELECT count(*)::text AS value
        FROM information_schema.tables
        WHERE table_schema = 'app'
          AND table_name IN (
            'shift_policies',
            'work_shifts',
            'shift_cash_movements',
            'shift_stock_counts',
            'shift_handover_acknowledgements',
            'shift_events'
          )
      `)).toBe("6");

      expect(await scalar(`
        SELECT count(*)::text AS value
        FROM app.permissions
        WHERE id IN (
          'shift:open',
          'shift:close',
          'shift:read',
          'shift:cash_adjust',
          'shift:review',
          'shift:manage',
          'shift:report'
        )
      `)).toBe("7");

      expect(await scalar(`
        SELECT count(*)::text AS value
        FROM app.role_permissions
        WHERE role = 'staff'
          AND permission_id IN ('shift:open','shift:close','shift:read','shift:cash_adjust')
      `)).toBe("4");

      expect(await scalar(`
        SELECT count(*)::text AS value
        FROM app.role_permissions
        WHERE role = 'accountant'
          AND permission_id LIKE 'shift:%'
      `)).toBe("0");

      expect(await scalar(`
        SELECT count(*)::text AS value
        FROM pg_indexes
        WHERE schemaname = 'app'
          AND indexname IN (
            'work_shifts_one_active_scope_idx',
            'work_shifts_store_z_number_idx',
            'shift_policies_scope_enabled_idx',
            'shift_cash_movements_shift_time_idx',
            'shift_stock_counts_shift_time_idx',
            'shift_handover_ack_scope_time_idx',
            'shift_events_shift_time_idx'
          )
      `)).toBe("7");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("enforces one active shift and one Z-number per merchant store", async () => {
    await client.query("BEGIN");
    try {
      await client.query(shiftMigration);
      await client.query(`
        INSERT INTO public.stock_location (id, name)
        VALUES ('sloc_shift_test', 'Shift Test')
        ON CONFLICT (id) DO NOTHING
      `);
      await client.query(`
        INSERT INTO app.merchants (id, display_name, legacy_organization_id)
        VALUES ('merchant_shift_test', 'Shift Test Merchant', 'org_shift_test')
        ON CONFLICT (id) DO NOTHING
      `);
      await client.query(`
        INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status)
        VALUES ('store_shift_test', 'merchant_shift_test', 'Shift Test Store', 'sloc_shift_test', true, 'active')
        ON CONFLICT (id) DO NOTHING
      `);

      await client.query(`
        INSERT INTO app.work_shifts (
          id, merchant_id, store_id, stock_location_id, status, opened_by, opening_cash_amount
        )
        VALUES (
          'shift_active_a', 'merchant_shift_test', 'store_shift_test', 'sloc_shift_test', 'open', 'op_staff1', 100000
        )
      `);

      await client.query("SAVEPOINT duplicate_active_shift");
      await expect(client.query(`
        INSERT INTO app.work_shifts (
          id, merchant_id, store_id, stock_location_id, status, opened_by, opening_cash_amount
        )
        VALUES (
          'shift_active_b', 'merchant_shift_test', 'store_shift_test', 'sloc_shift_test', 'open', 'op_staff2', 100000
        )
      `)).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT duplicate_active_shift");

      await client.query(`
        INSERT INTO app.work_shifts (
          id, merchant_id, store_id, stock_location_id, status, review_status, z_number,
          opened_by, opened_at, closed_by, closed_at, opening_cash_amount
        )
        VALUES (
          'shift_closed_a', 'merchant_shift_test', 'store_shift_test', 'sloc_shift_test', 'closed', 'pending', 1,
          'op_staff1', now() - interval '2 hours', 'op_staff1', now(), 100000
        )
      `);

      await client.query("SAVEPOINT duplicate_z_number");
      await expect(client.query(`
        INSERT INTO app.work_shifts (
          id, merchant_id, store_id, stock_location_id, status, review_status, z_number,
          opened_by, opened_at, closed_by, closed_at, opening_cash_amount
        )
        VALUES (
          'shift_closed_b', 'merchant_shift_test', 'store_shift_test', 'sloc_shift_test', 'closed', 'pending', 1,
          'op_staff2', now() - interval '1 hour', 'op_staff2', now(), 100000
        )
      `)).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT duplicate_z_number");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
