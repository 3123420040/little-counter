import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createPartnerAsAdmin, type PartnerAsConfig } from "./authorization-server";
import { PartnerError } from "./errors";
import { recordAuditEntry } from "../repositories/audit-repository";
import { withPartnerTransaction } from "./transaction";

interface ControlOperation {
  id: string; integration_id: string; client_id: string | null; kind: "provision" | "rotate" | "revoke";
  status: string; oauth_client_id: string; auth_method: "private_key_jwt" | "client_secret_basic";
  credential_reference: string; prior_client_id: string | null; overlap_seconds: number | null;
  as_client_id: string | null; claim_token: string; request_id: string | null; attempts: number;
}
async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>, checkOwnership: () => void = () => undefined) {
  return withPartnerTransaction(pool, async db => {
    checkOwnership();
    return work(db);
  }, { beforeCommit: checkOwnership });
}
async function lockedOperation(db: PoolClient, op: ControlOperation) {
  const integration = (await db.query(`SELECT i.*,m.legacy_organization_id FROM integration.integrations i
    JOIN app.merchants m ON m.id=i.merchant_id WHERE i.id=$1 FOR UPDATE OF i`, [op.integration_id])).rows[0];
  const owned = await db.query(`SELECT id FROM integration.control_operations WHERE id=$1 AND claim_token=$2
    AND lease_expires_at>clock_timestamp() AND status<>'completed' FOR UPDATE`, [op.id, op.claim_token]);
  if (!owned.rowCount || !integration) throw new PartnerError("mutation_busy");
  return integration;
}
async function complete(db: PoolClient, op: ControlOperation, org: string, merchant: string, errorCode: string | null = null) {
  const changed = await db.query(`UPDATE integration.control_operations SET status='completed',error_code=$3,claim_token=NULL,lease_expires_at=NULL,updated_at=now()
    WHERE id=$1 AND claim_token=$2 AND lease_expires_at>clock_timestamp() RETURNING id`, [op.id, op.claim_token, errorCode]);
  if (!changed.rowCount) throw new PartnerError("mutation_busy");
  await recordAuditEntry(db, { operatorId: "partner-control-reconciler", role: "system", organizationId: org,
    serviceIdentity: "partner-control-reconciler", requestId: op.request_id ?? undefined },
  `partner.client_${op.kind}_reconciled`, "partner_integration", op.integration_id,
  { merchantId: merchant, after: { operation_id: op.id, client_id: op.client_id, outcome: errorCode ?? "completed" } });
}

/** One bounded claim per call. AS calls occur outside DB transactions; the
 * durable lease token fences every local state transition after network work. */
async function reconcileClaimedOperation(pool: Pool, config: PartnerAsConfig,
  as: ReturnType<typeof createPartnerAsAdmin>, checkOwnership: () => void) {
  const transact = <T>(work: (db: PoolClient) => Promise<T>) => transaction(pool, work, checkOwnership);
  const op = await transact( async (db) => {
    const result = await db.query(`UPDATE integration.control_operations SET claim_token=$2,lease_expires_at=clock_timestamp()+interval '30 seconds',
      attempts=attempts+1,updated_at=now() WHERE id=(SELECT o.id FROM integration.control_operations o
      JOIN integration.integrations i ON i.id=o.integration_id WHERE i.environment=$1 AND o.status IN ('pending','verified','failed')
      AND o.next_attempt_at<=now() AND (o.lease_expires_at IS NULL OR o.lease_expires_at<=clock_timestamp())
      ORDER BY o.next_attempt_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1) RETURNING *`, [config.environment, randomUUID()]);
    return result.rows[0] as ControlOperation | undefined;
  });
  if (!op) return { outcome: "idle" as const };
  try {
    if (op.kind === "revoke") {
      const client = await transact( async (db) => {
        await lockedOperation(db, op);
        const found = (await db.query("SELECT id,as_client_id,status FROM integration.clients WHERE id=$1 AND integration_id=$2 FOR UPDATE", [op.client_id, op.integration_id])).rows[0];
        if (!found) throw new PartnerError("resource_not_found");
        // Scheduled rotation expiry also uses this path. A local revoke always
        // commits before attempting AS; issued JWTs become unusable at once.
        await db.query("UPDATE integration.clients SET status='revoked' WHERE id=$1", [found.id]);
        return found;
      });
      if (client.as_client_id) await as.setEnabled(client.as_client_id, false);
      await transact( async (db) => {
        const integration = await lockedOperation(db, op);
        await complete(db, op, integration.legacy_organization_id, integration.merchant_id);
      });
    } else {
      // Deterministic oauth_client_id + ownership attributes recover an orphan
      // created before a process crash. Never adopt an unrelated AS client.
      const mapped = await as.ensureInactiveClient({ oauthClientId: op.oauth_client_id, integrationId: op.integration_id,
        operationId: op.id, authMethod: op.auth_method, credentialReference: op.credential_reference });
      const registryId = `pcl_${op.id}`;
      await transact( async (db) => {
        await lockedOperation(db, op);
        await db.query(`INSERT INTO integration.clients(id,integration_id,issuer,oauth_client_id,subject,status,auth_method,credential_reference,as_client_id)
          VALUES ($1,$2,$3,$4,$5,'inactive',$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [registryId, op.integration_id, mapped.issuer, op.oauth_client_id, mapped.subject, op.auth_method, op.credential_reference, mapped.asClientId]);
        const existing = (await db.query("SELECT * FROM integration.clients WHERE id=$1 AND integration_id=$2", [registryId, op.integration_id])).rows[0];
        if (!existing || existing.subject !== mapped.subject || existing.issuer !== mapped.issuer || existing.oauth_client_id !== op.oauth_client_id
          || existing.as_client_id !== mapped.asClientId || existing.auth_method !== op.auth_method) throw new PartnerError("idempotency_conflict");
        const changed = await db.query(`UPDATE integration.control_operations SET status='verified',client_id=$3,as_client_id=$4,updated_at=now()
          WHERE id=$1 AND claim_token=$2 AND lease_expires_at>clock_timestamp() RETURNING id`, [op.id, op.claim_token, registryId, mapped.asClientId]);
        if (!changed.rowCount) throw new PartnerError("mutation_busy");
      });
      op.client_id = registryId;
      await as.setEnabled(mapped.asClientId, true);
      const activated = await transact( async (db) => {
        const integration = await lockedOperation(db, op);
        const client = (await db.query("SELECT status FROM integration.clients WHERE id=$1 AND integration_id=$2 FOR UPDATE", [registryId, op.integration_id])).rows[0];
        let prior;
        if (op.kind === "rotate") prior = (await db.query("SELECT status,retire_at FROM integration.clients WHERE id=$1 AND integration_id=$2 FOR UPDATE", [op.prior_client_id, op.integration_id])).rows[0];
        const allowed = integration.status !== "revoked" && client?.status === "inactive"
          && (op.kind !== "rotate" || (prior?.status === "active" && prior.retire_at === null));
        if (!allowed) {
          // Durable follow-up ensures AS disable is retried even if this worker
          // crashes immediately after committing the local rejection.
          await db.query("UPDATE integration.clients SET status='revoked' WHERE id=$1", [registryId]);
          await db.query(`INSERT INTO integration.control_operations(id,integration_id,client_id,kind,status,request_id)
            VALUES ($1,$2,$3,'revoke','pending',$4)`, [`pop_${randomUUID()}`, op.integration_id, registryId, op.request_id]);
          await complete(db, op, integration.legacy_organization_id, integration.merchant_id, "integration_disabled");
          return false;
        }
        await db.query("UPDATE integration.clients SET status='active' WHERE id=$1", [registryId]);
        if (op.kind === "rotate") {
          const retired = (await db.query(`UPDATE integration.clients SET retire_at=now()+($2::integer*interval '1 second')
            WHERE id=$1 RETURNING retire_at`, [op.prior_client_id, op.overlap_seconds])).rows[0];
          await db.query(`INSERT INTO integration.control_operations(id,integration_id,client_id,kind,status,next_attempt_at,request_id)
            VALUES ($1,$2,$3,'revoke','pending',$4,$5)`, [`pop_${randomUUID()}`, op.integration_id, op.prior_client_id, retired.retire_at, op.request_id]);
        }
        await complete(db, op, integration.legacy_organization_id, integration.merchant_id);
        return true;
      });
      if (!activated) await as.setEnabled(mapped.asClientId, false);
    }
    return { outcome: "completed" as const, operationId: op.id };
  } catch (error) {
    const code = error instanceof PartnerError ? error.code : "dependency_unavailable";
    await transact( async (db) => {
      await db.query(`UPDATE integration.control_operations SET status='failed',error_code=$3,
        next_attempt_at=now()+($4::integer*interval '1 second'),claim_token=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE id=$1 AND claim_token=$2 AND lease_expires_at>clock_timestamp()`,
      [op.id, op.claim_token, code, Math.min(3600, 30 * 2 ** Math.min(op.attempts, 6))]);
    });
    return { outcome: "failed" as const, operationId: op.id, errorCode: code };
  }
}

// The AS does not implement our DB claim token. Serialize external writers for
// each environment with a session lock, including time outside transactions.
// A lease expiry alone must not let a second live process race AS writes.
export async function reconcilePartnerControlOnce(pool: Pool, config: PartnerAsConfig,
  as = createPartnerAsAdmin(config)) {
  const guard = await pool.connect();
  let owned = false, broken = false;
  const lost = () => {broken=true;};
  guard.on("error",lost);
  guard.on("end",lost);
  const checkOwnership = () => {if(broken)throw new PartnerError("dependency_unavailable");};
  const guardedAs: ReturnType<typeof createPartnerAsAdmin> = { ...as,
    ensureInactiveClient: async input => {checkOwnership();const result=await as.ensureInactiveClient(input,checkOwnership);checkOwnership();return result;},
    setEnabled: async (id,enabled) => {checkOwnership();await as.setEnabled(id,enabled,checkOwnership);checkOwnership();},
  };
  const lockName = `partner-as-writer:${config.environment}`;
  try {
    owned = (await guard.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS owned", [lockName])).rows[0].owned === true;
    if (!owned) return { outcome: "idle" as const };
    // Revisit completed mappings too: a network request accepted by AS can
    // finish after the originating process/DB connection dies. Local registry
    // remains authoritative for business access while this repair converges.
    const cursor = (await guard.query("SELECT last_client_id FROM integration.as_convergence_cursors WHERE environment=$1",[config.environment])).rows[0]?.last_client_id ?? "";
    const result = await guard.query(`SELECT c.id,c.as_client_id,
      (c.status='active' AND i.status<>'revoked' AND (c.retire_at IS NULL OR c.retire_at>clock_timestamp())) AS enabled
      FROM integration.clients c JOIN integration.integrations i ON i.id=c.integration_id
      WHERE i.environment=$1 AND c.as_client_id IS NOT NULL AND c.id>$2 ORDER BY c.id LIMIT 1`, [config.environment,cursor]);
    const client = result.rows[0];
    await guard.query(`INSERT INTO integration.as_convergence_cursors(environment,last_client_id) VALUES($1,$2)
      ON CONFLICT(environment) DO UPDATE SET last_client_id=EXCLUDED.last_client_id,updated_at=clock_timestamp()`,[config.environment,client?.id??""]);
    let convergenceFailed = false;
    if (client) {
      try {await guardedAs.setEnabled(client.as_client_id,client.enabled);}
      catch {checkOwnership();convergenceFailed=true;}
    }
    const outcome = await reconcileClaimedOperation(pool,config,guardedAs,checkOwnership);
    if (convergenceFailed && outcome.outcome === "idle") throw new PartnerError("dependency_unavailable");
    return outcome;
  } finally {
    if (owned) try {await guard.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockName]);} catch {broken=true;}
    guard.removeListener("error",lost);
    guard.removeListener("end",lost);
    guard.release(broken);
  }
}
