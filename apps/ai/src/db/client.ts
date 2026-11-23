import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({
  connectionString: databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export function getDb() {
  return pool;
}

export async function query(text: string, params?: unknown[]) {
  return pool.query(text, params);
}

export async function shutdown() {
  await pool.end();
}
