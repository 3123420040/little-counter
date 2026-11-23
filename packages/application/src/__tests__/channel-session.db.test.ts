import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import { getChannelSession, updateChannelSession } from "../services/channel-session-service";

const originalToken = process.env.TELEGRAM_SERVICE_TOKEN;
const originalServiceId = process.env.TELEGRAM_SERVICE_ID;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const userId = `db-session-${runId}`;
const operatorId = `op_session_${runId.replace(/[^a-zA-Z0-9]/g, "_")}`;
const token = "db-session-service-token-min-32-chars";

const headers = {
  authorization: `Bearer ${token}`,
  "x-channel": "telegram",
  "x-channel-user-id": userId,
};

let client: PoolClient;

beforeAll(async () => {
  process.env.TELEGRAM_SERVICE_TOKEN = token;
  process.env.TELEGRAM_SERVICE_ID = "telegram";
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  const owner = await client.query("SELECT password_hash FROM medusa.staff_users WHERE operator_id = 'op_owner' LIMIT 1");
  await client.query(`
    INSERT INTO medusa.staff_users (operator_id, password_hash, display_name, role, is_active)
    VALUES ($1, $2, 'DB Session Operator', 'owner', true)
    ON CONFLICT (operator_id) DO UPDATE SET is_active = true
  `, [operatorId, owner.rows[0]?.password_hash || "test-password-hash"]);
  await client.query(`
    INSERT INTO app.operator_identities (
      organization_id, provider, provider_user_id, operator_id, display_name, is_active, verified_at
    )
    VALUES ('org_default', 'telegram', $1, $2, 'DB Session Test', true, now())
    ON CONFLICT (organization_id, provider, provider_user_id) WHERE merchant_id IS NULL
    DO UPDATE SET operator_id = EXCLUDED.operator_id, is_active = true, verified_at = now()
  `, [userId, operatorId]);
  await client.query(`
    INSERT INTO app.operator_memberships (
      operator_id, scope_type, merchant_id, role_key, status, granted_by
    )
    VALUES ($1, 'merchant', 'merchant_default', 'owner', 'active', 'db-test')
  `, [operatorId]);
});

afterAll(async () => {
  await client?.query("DELETE FROM app.bot_sessions WHERE provider = 'telegram' AND provider_user_id = $1", [userId]).catch(() => undefined);
  await client?.query("DELETE FROM app.operator_memberships WHERE operator_id = $1", [operatorId]).catch(() => undefined);
  await client?.query("DELETE FROM app.operator_identities WHERE provider = 'telegram' AND provider_user_id = $1", [userId]).catch(() => undefined);
  await client?.query("DELETE FROM medusa.staff_users WHERE operator_id = $1", [operatorId]).catch(() => undefined);
  client?.release();
  if (originalToken === undefined) delete process.env.TELEGRAM_SERVICE_TOKEN;
  else process.env.TELEGRAM_SERVICE_TOKEN = originalToken;
  if (originalServiceId === undefined) delete process.env.TELEGRAM_SERVICE_ID;
  else process.env.TELEGRAM_SERVICE_ID = originalServiceId;
  await shutdownPlatformDb().catch(() => undefined);
});

describe("channel session PostgreSQL integration", () => {
  it("returns an empty session and deletes the row when the pending session is expired", async () => {
    const expiredAt = new Date(Date.now() - 1000).toISOString();
    await updateChannelSession(headers, {
      state: { pendingAction: "create_order", confirmCode: "order-expired" },
      expiresAt: expiredAt,
    });

    const result = await getChannelSession(headers);

    expect(result.data.state).toEqual({});
    expect(result.data.expiresAt).toBeNull();
    const rows = await client.query(`
      SELECT count(*)::int AS count
      FROM app.bot_sessions
      WHERE provider = 'telegram' AND provider_user_id = $1
    `, [userId]);
    expect(rows.rows[0].count).toBe(0);
  });
});
