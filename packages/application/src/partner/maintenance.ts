import type { PoolClient } from "pg";
import { recordAuditEntry } from "../repositories/audit-repository";

/** Caller owns a bounded transaction. A global transaction lock prevents two
 * scheduled replicas from processing the same batch. Namespace tombstones,
 * consumed quotes and immutable external references are never deleted. */
export async function maintainPartnerRetentionForClient(db: PoolClient, batchSize: number) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error("Invalid retention batch size");
  const locked = await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended('snus-partner-retention-v1',0)) AS acquired");
  if (!locked.rows[0].acquired) return { outcome: "busy" as const, tombstones: 0, contacts: 0, quotes: 0 };
  const replay = await db.query(`WITH due AS (
    SELECT integration_id,store_id,operation,fingerprint_version,key_fingerprint FROM integration.idempotency_records
    WHERE state='completed' AND expires_at<=statement_timestamp() ORDER BY expires_at LIMIT $1
  ) UPDATE integration.idempotency_records r SET state='tombstone',public_response=NULL FROM due d
    WHERE (r.integration_id,r.store_id,r.operation,r.fingerprint_version,r.key_fingerprint)=
      (d.integration_id,d.store_id,d.operation,d.fingerprint_version,d.key_fingerprint)`, [batchSize]);
  const control = await db.query(`WITH due AS (
    SELECT id FROM integration.control_request_receipts WHERE state='completed' AND replay_until<=clock_timestamp()
    ORDER BY replay_until,id LIMIT $1
  ) UPDATE integration.control_request_receipts r SET state='tombstone',result_metadata=NULL
    FROM due d WHERE r.id=d.id`, [batchSize]);
  const contacts = await db.query(`DELETE FROM integration.order_contacts WHERE partner_order_id IN (
    SELECT partner_order_id FROM integration.order_contacts WHERE retention_until<=statement_timestamp()
    ORDER BY retention_until LIMIT $1)`, [batchSize]);
  const quotes = await db.query(`DELETE FROM integration.quotes WHERE id IN (
    SELECT id FROM integration.quotes WHERE consumed_order_id IS NULL AND expires_at<=statement_timestamp()
    ORDER BY expires_at LIMIT $1)`, [batchSize]);
  const counts = { tombstones: (replay.rowCount ?? 0) + (control.rowCount ?? 0), contacts: contacts.rowCount ?? 0, quotes: quotes.rowCount ?? 0 };
  if (Object.values(counts).some(Boolean)) {
    await recordAuditEntry(db, { operatorId: "partner-retention", role: "system", serviceIdentity: "partner-retention" },
      "partner.retention_applied", "retention_batch", "partner-v1", { after: counts });
  }
  return { outcome: "completed" as const, ...counts };
}
