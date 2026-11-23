import { Pool, type PoolClient } from "pg";
import { getPlatformDatabaseUrl, getReportDatabaseUrl } from "./config";

export type { PoolClient };

const platformPool = new Pool({
  connectionString: getPlatformDatabaseUrl(),
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
});

const reportPool = new Pool({
  connectionString: getReportDatabaseUrl(),
  max: Number(process.env.REPORT_DB_POOL_MAX || 5),
  idleTimeoutMillis: 30_000,
});

export async function connectPlatformClient(): Promise<PoolClient> {
  return platformPool.connect();
}

export async function connectReportClient(): Promise<PoolClient> {
  return reportPool.connect();
}

export async function shutdownPlatformPool(): Promise<void> {
  await Promise.all([platformPool.end(), reportPool.end()]);
}
