import { Pool } from "pg";
import {
  assertSafeTestDatabaseSentinel,
  redactDatabaseTarget,
  requireSafeTestDatabaseTarget,
} from "../packages/application/src/db/test-database-target";

function formatConnectionError(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map(formatConnectionError).join("; ");
  }
  if (error instanceof Error) {
    const details = error as Error & { code?: string; address?: string; port?: number };
    const suffix = [details.code, details.address, details.port].filter(Boolean).join(" ");
    return suffix ? `${error.message || error.name} (${suffix})` : error.message || error.name;
  }
  return String(error);
}

async function main(): Promise<void> {
  let target;
  try {
    target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL, process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unsafe database test target");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString: target.connectionString,
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 2_000),
    max: 1,
  });
  try {
    await pool.query("select 1");
    await assertSafeTestDatabaseSentinel(pool, target);
  } catch (error) {
    console.error("PostgreSQL is required for this command but is not reachable.");
    console.error(`DATABASE_TARGET=${redactDatabaseTarget(target.connectionString)}`);
    console.error(`Connection error: ${formatConnectionError(error)}`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

void main();
