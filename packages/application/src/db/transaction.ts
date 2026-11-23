import { connectPlatformClient, connectReportClient, type PoolClient } from "./client";

export async function withConnectedClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await connectPlatformClient();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withConnectedReportClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await connectReportClient();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withConnectedTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withConnectedClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}
