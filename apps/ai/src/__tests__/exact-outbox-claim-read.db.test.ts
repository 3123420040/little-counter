import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { connectPlatformClient } from "../../../../packages/application/src/db/client";
import { shutdownPlatformDb } from "../../../../packages/application/src/platform-db";

let client: PoolClient;

beforeAll(async () => {
  client = await connectPlatformClient();
  await client.query("BEGIN");
  await client.query(`
    CREATE TEMP TABLE exact_claim_snapshot_probe (
      id uuid PRIMARY KEY,
      status text NOT NULL,
      claimed_by text,
      claim_token uuid,
      claim_version bigint NOT NULL DEFAULT 0
    ) ON COMMIT DROP
  `);
  await client.query(`
    CREATE FUNCTION pg_temp.claim_snapshot_probe(p_worker text)
    RETURNS TABLE(event_id uuid, claim_token uuid, claim_version bigint)
    LANGUAGE sql
    AS $function$
      UPDATE exact_claim_snapshot_probe
      SET
        status = 'processing',
        claimed_by = p_worker,
        claim_token = gen_random_uuid(),
        claim_version = claim_version + 1
      WHERE status = 'pending'
      RETURNING id, exact_claim_snapshot_probe.claim_token,
        exact_claim_snapshot_probe.claim_version
    $function$
  `);
});

afterAll(async () => {
  if (client) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
  await shutdownPlatformDb().catch(() => undefined);
});

async function resetProbe(): Promise<void> {
  await client.query("TRUNCATE exact_claim_snapshot_probe");
  await client.query(`
    INSERT INTO exact_claim_snapshot_probe (id, status)
    VALUES ('11111111-1111-4111-8111-111111111111', 'pending')
  `);
}

describe("exact outbox claim/read PostgreSQL snapshot semantics", () => {
  it("reproduces the same-statement claim plus status join returning no envelope", async () => {
    await resetProbe();
    const result = await client.query(`
      SELECT event.id
      FROM pg_temp.claim_snapshot_probe('worker_a') claimed
      JOIN exact_claim_snapshot_probe event
        ON event.id = claimed.event_id
       AND event.status = 'processing'
       AND event.claimed_by = 'worker_a'
       AND event.claim_token = claimed.claim_token
       AND event.claim_version = claimed.claim_version
    `);

    expect(result.rows).toEqual([]);
    const persisted = await client.query<{ status: string }>(`
      SELECT status FROM exact_claim_snapshot_probe
    `);
    expect(persisted.rows).toEqual([{ status: "processing" }]);
  });

  it("resolves the exact claimed identity when read in the next statement", async () => {
    await resetProbe();
    const claimed = await client.query<{
      event_id: string;
      claim_token: string;
      claim_version: string;
    }>(`
      SELECT event_id::text, claim_token::text, claim_version::text
      FROM pg_temp.claim_snapshot_probe('worker_b')
    `);
    expect(claimed.rows).toHaveLength(1);

    const resolved = await client.query<{ id: string }>(`
      SELECT event.id::text AS id
      FROM exact_claim_snapshot_probe event
      WHERE event.id = $1::uuid
        AND event.status = 'processing'
        AND event.claimed_by = $2
        AND event.claim_token = $3::uuid
        AND event.claim_version = $4::bigint
    `, [
      claimed.rows[0]?.event_id,
      "worker_b",
      claimed.rows[0]?.claim_token,
      claimed.rows[0]?.claim_version,
    ]);

    expect(resolved.rows).toEqual([{ id: "11111111-1111-4111-8111-111111111111" }]);
  });
});
