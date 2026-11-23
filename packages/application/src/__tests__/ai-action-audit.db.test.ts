import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import { approveAiAction, rejectAiAction } from "../services/ai-service";
import type { ChannelActor } from "../services/channel-auth-service";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const telegramUserId = `db_ai_${runId}`;
const idempotencyPrefix = `db-test:${runId}:ai-action-audit`;

const actor: ChannelActor = {
  operatorId: "op_owner",
  role: "owner",
  displayName: "DB Test Owner",
  organizationId: "org_default",
  channel: "telegram",
  channelUserId: telegramUserId,
  serviceIdentity: "telegram",
  requestId: `db-test-${runId}`,
  permissions: ["ai:review"],
};

let client: PoolClient;

async function createReviewAction(label: string): Promise<string> {
  const inserted = await client.query(`
    INSERT INTO ai_module.actions (
      action_type,
      status,
      output_payload,
      confidence,
      risk_level,
      model_provider,
      model_name,
      prompt_version,
      merchant_id,
      store_id
    ) VALUES (
      'reply_draft',
      'review_required',
      $1::jsonb,
      0.850,
      'medium',
      'deterministic',
      'deterministic-rules',
      'db-test',
      'merchant_default',
      'store_default'
    )
    RETURNING id::text
  `, [JSON.stringify({ responseText: label })]);
  return String(inserted.rows[0].id);
}

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
});

afterAll(async () => {
  await client?.query("DELETE FROM audit.events WHERE subject_type = 'ai_action' AND channel_user_id = $1", [telegramUserId]).catch(() => undefined);
  await client?.query("DELETE FROM ai_module.actions WHERE prompt_version = 'db-test' AND output_payload->>'responseText' LIKE $1", [`%${runId}%`]).catch(() => undefined);
  await client?.query("DELETE FROM app.idempotency_records WHERE idempotency_key LIKE $1", [`${idempotencyPrefix}%`]).catch(() => undefined);
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("AI action PostgreSQL audit", () => {
  it("records Telegram channel audit rows for approved and rejected AI actions", async () => {
    const approvedActionId = await createReviewAction(`approve-${runId}`);
    const rejectedActionId = await createReviewAction(`reject-${runId}`);

    const approved = await approveAiAction(
      { "idempotency-key": `${idempotencyPrefix}:approve` },
      approvedActionId,
      "Approved smoke reply",
      actor,
      "merchant_default",
    );
    const rejected = await rejectAiAction(
      { "idempotency-key": `${idempotencyPrefix}:reject` },
      rejectedActionId,
      "Operator rejected smoke reply",
      actor,
      "merchant_default",
    );

    expect(approved.statusCode).toBe(201);
    expect(rejected.statusCode).toBe(201);
    expect(approved.response.data).toMatchObject({
      status: "approved",
      reviewed_by: actor.operatorId,
      approved_text: "Approved smoke reply",
    });
    expect(rejected.response.data).toMatchObject({
      status: "rejected",
      reviewed_by: actor.operatorId,
      rejection_reason: "Operator rejected smoke reply",
    });

    const audit = await client.query(`
      SELECT action, subject_id, channel, channel_user_id, service_identity, request_id, before, after, reason
      FROM audit.events
      WHERE subject_type = 'ai_action'
        AND subject_id = ANY($1::text[])
      ORDER BY created_at ASC
    `, [[approvedActionId, rejectedActionId]]);

    expect(audit.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "ai_action.approved",
        subject_id: approvedActionId,
        channel: "telegram",
        channel_user_id: telegramUserId,
        service_identity: "telegram",
        request_id: `db-test-${runId}`,
        before: expect.objectContaining({ status: "review_required" }),
        after: expect.objectContaining({
          status: "approved",
          approvedText: "Approved smoke reply",
          reviewedBy: actor.operatorId,
        }),
      }),
      expect.objectContaining({
        action: "ai_action.rejected",
        subject_id: rejectedActionId,
        channel: "telegram",
        channel_user_id: telegramUserId,
        service_identity: "telegram",
        request_id: `db-test-${runId}`,
        before: expect.objectContaining({ status: "review_required" }),
        after: expect.objectContaining({
          status: "rejected",
          rejectionReason: "Operator rejected smoke reply",
          reviewedBy: actor.operatorId,
        }),
        reason: "Operator rejected smoke reply",
      }),
    ]));

    await expect(rejectAiAction(
      { "idempotency-key": `${idempotencyPrefix}:reject-approved` },
      approvedActionId,
      "Late rejection should fail",
      actor,
      "merchant_default",
    )).rejects.toMatchObject({
      code: "invalid_state_transition",
      statusCode: 409,
    });

    const invalidAudit = await client.query(`
      SELECT action
      FROM audit.events
      WHERE subject_type = 'ai_action'
        AND subject_id = $1
        AND action = 'ai_action.rejected'
    `, [approvedActionId]);
    expect(invalidAudit.rows).toHaveLength(0);
  });
});
