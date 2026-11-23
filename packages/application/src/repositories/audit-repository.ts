import { isPartnerBusinessActor, businessActorId, partnerActorMetadata, type PartnerBusinessActor } from "../utils/business-actor";
import type { ClientBase } from "pg";
import { id } from "../utils/id";

export interface AuditActor {
  operatorId: string;
  role?: string;
  organizationId?: string;
  channel?: string;
  channelUserId?: string;
  serviceIdentity?: string;
  requestId?: string;
  actualOperatorId?: string;
  effectiveOperatorId?: string;
  impersonationSessionId?: string;
  actorChain?: unknown[];
}

export interface AuditEntryReceipt {
  id: string;
  createdAt: string;
  correlationId: string;
}

export async function recordAuditEntry(
  client: ClientBase,
  actor: AuditActor | PartnerBusinessActor,
  action: string,
  subjectType: string,
  subjectId: string,
  detail: { before?: unknown; after?: unknown; reason?: string; correlationId?: string; merchantId?: string; storeId?: string },
): Promise<AuditEntryReceipt> {
  const partner = isPartnerBusinessActor(actor) ? actor : null;
  const staff = isPartnerBusinessActor(actor) ? null : actor;
  if (partner && (detail.merchantId !== partner.merchantId || detail.storeId !== partner.storeId)) {
    throw new Error("Partner audit scope mismatch");
  }
  const correlationId = detail.correlationId || id("cor");
  const result = await client.query<{ id: string; created_at: Date | string }>(`
    INSERT INTO audit.events (
      organization_id, merchant_id, store_id, actor_type, actor_id, action, subject_type, subject_id,
      before, after, reason, correlation_id,
      channel, channel_user_id, service_identity, request_id,
      actual_actor_id, effective_actor_id, impersonation_session_id, actor_chain,
      partner_id,integration_id,client_id,grant_version,trace_id,origin_request_id,auth_method,credential_id,key_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb,$21,$22,$23,$24,$25,$26,$27,$28,$29)
    RETURNING id::text, created_at
  `, [
    actor.organizationId || "org_default",
    detail.merchantId || null,
    detail.storeId || null,
    partner ? "partner" : staff?.role || "system",
    businessActorId(actor),
    action,
    subjectType,
    subjectId,
    detail.before === undefined ? null : JSON.stringify(detail.before),
    detail.after === undefined ? null : JSON.stringify(detail.after),
    detail.reason ?? null,
    correlationId,
    partner ? "partner_api" : staff?.channel || null,
    staff?.channelUserId || null,
    staff?.serviceIdentity || null,
    actor.requestId || null,
    staff?.actualOperatorId || null,
    staff?.effectiveOperatorId || null,
    staff?.impersonationSessionId || null,
    JSON.stringify(partner ? [partnerActorMetadata(partner)] : staff?.actorChain || []),
    partner?.partnerId ?? null,partner?.integrationId ?? null,partner?.clientId ?? null,
    partner?.storeGrantVersion ?? null,partner?.traceId ?? null,partner?.requestId ?? null,
    partner?.authMethod ?? null,partner?.credentialId ?? null,partner?.keyId ?? null,
  ]);
  const row = result.rows[0]!;
  return {
    id: String(row.id),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    correlationId,
  };
}
