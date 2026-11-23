import type { PoolClient } from "./client";

export async function queryOne<T extends Record<string, unknown>>(
  client: PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const result = await client.query(sql, params);
  return (result.rows[0] as T | undefined) ?? null;
}
