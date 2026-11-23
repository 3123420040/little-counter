import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import { getChannelSession } from "../services/channel-session-service";
import {
  clearTelegramSalesSession,
  getTelegramSalesSession,
  updateTelegramSalesSession,
} from "../services/telegram-sales-session-service";

const originalToken = process.env.TELEGRAM_SERVICE_TOKEN;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const serviceToken = "db-test-telegram-sales-session-token";
const userId = `telegram_public_session_${runId}`;
const merchantId = "merchant_default";
const storeId = "store_default";

const headers = {
  authorization: `Bearer ${serviceToken}`,
  "x-channel": "telegram",
  "x-channel-user-id": userId,
  "x-merchant-id": merchantId,
  "x-store-id": storeId,
  "x-request-id": `db-test-public-session-${runId}`,
};

let client: PoolClient;

beforeAll(async () => {
  process.env.TELEGRAM_SERVICE_TOKEN = serviceToken;
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await client.query("DELETE FROM app.bot_sessions WHERE provider = 'telegram' AND provider_user_id = $1", [userId]);
  await client.query("DELETE FROM app.operator_identities WHERE provider = 'telegram' AND provider_user_id = $1", [userId]);
});

afterAll(async () => {
  await client?.query("DELETE FROM app.bot_sessions WHERE provider = 'telegram' AND provider_user_id = $1", [userId]).catch(() => undefined);
  await client?.query("DELETE FROM app.operator_identities WHERE provider = 'telegram' AND provider_user_id = $1", [userId]).catch(() => undefined);
  client?.release();
  if (originalToken === undefined) delete process.env.TELEGRAM_SERVICE_TOKEN;
  else process.env.TELEGRAM_SERVICE_TOKEN = originalToken;
  await shutdownPlatformDb().catch(() => undefined);
});

describe("telegram sales public customer session PostgreSQL integration", () => {
  it("stores public customer session state without creating an operator identity", async () => {
    const updated = await updateTelegramSalesSession(headers, {
      state: { lastCommand: "start", language: "en" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(updated.data).toMatchObject({
      channel: "telegram",
      channelUserId: userId,
      actorType: "telegram_customer",
      merchantId,
      storeId,
      state: { lastCommand: "start", language: "en" },
    });
    expect(updated.data).not.toHaveProperty("operatorId");

    const read = await getTelegramSalesSession(headers);
    expect(read.data).toMatchObject({
      actorType: "telegram_customer",
      state: { lastCommand: "start", language: "en" },
    });

    const identityCount = await client.query(`
      SELECT count(*)::int AS count
      FROM app.operator_identities
      WHERE provider = 'telegram' AND provider_user_id = $1
    `, [userId]);
    expect(identityCount.rows[0].count).toBe(0);

    await expect(getChannelSession(headers)).rejects.toMatchObject({
      code: "channel_identity_unmapped",
      statusCode: 403,
    });
  });

  it("expires and clears only the scoped public customer session", async () => {
    await updateTelegramSalesSession(headers, {
      state: { pendingAction: "checkout_address" },
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const read = await getTelegramSalesSession(headers);
    expect(read.data.state).toEqual({});
    expect(read.data.expiresAt).toBeNull();

    const rowsAfterExpiry = await client.query(`
      SELECT count(*)::int AS count
      FROM app.bot_sessions
      WHERE provider = 'telegram'
        AND provider_user_id = $1
        AND merchant_id = $2
    `, [userId, merchantId]);
    expect(rowsAfterExpiry.rows[0].count).toBe(0);

    await updateTelegramSalesSession(headers, {
      state: { lastCommand: "products" },
      expiresAt: null,
    });
    const cleared = await clearTelegramSalesSession(headers);
    expect(cleared.data).toMatchObject({
      actorType: "telegram_customer",
      channelUserId: userId,
      merchantId,
      cleared: true,
    });
  });
});
