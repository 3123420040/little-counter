import { Pool, type PoolClient } from "pg";
import { partnerDatabaseTimeouts, withPartnerTransaction } from "./transaction";
import { z } from "zod";
import { permissions, type MerchantTargetScope } from "@medusa-snus/contracts";
import { PlatformError } from "../errors/platform-error";
import { recordAuditEntry } from "../repositories/audit-repository";
import { requireScopedActorPermission, type PermissionActor } from "../services/permission-service";

const querySchema = z.strictObject({
  mode: z.enum(["overview", "access", "security"]).default("overview"),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  integration_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional(),
  after_event_key: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).refine(value => Date.parse(value.to) > Date.parse(value.from)
  && Date.parse(value.to) - Date.parse(value.from) <= 7 * 86400000);

function fail(code: string, statusCode: number): never {
  throw new PlatformError(code, code.replaceAll("_", " "), statusCode);
}

export async function readPartnerOperationsForClient(db: PoolClient, actor: PermissionActor,
  scope: MerchantTargetScope, raw: unknown, environment: "sandbox" | "production", requestId: string) {
  if ("channel" in actor) fail("forbidden", 403);
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) fail("invalid_request", 400);
  const query = parsed.data;
  await requireScopedActorPermission(actor, permissions.partnerLogsRead,
    { scopeType: "merchant", merchantId: scope.merchantId });
  if (query.mode === "security") await requireScopedActorPermission(actor, permissions.partnerSecurityRead,
    { scopeType: "merchant", merchantId: scope.merchantId });

  const merchant = (await db.query("SELECT legacy_organization_id FROM app.merchants WHERE id=$1", [scope.merchantId])).rows[0];
  if (!merchant) fail("resource_not_found", 404);
  if (query.integration_id) {
    const owned = await db.query(`SELECT id FROM integration.integrations
      WHERE id=$1 AND merchant_id=$2 AND environment=$3`, [query.integration_id, scope.merchantId, environment]);
    if (!owned.rowCount) fail("resource_not_found", 404);
  }
  const base = [scope.merchantId, query.from, query.to, query.integration_id ?? null, environment];
  let data: Record<string, unknown>;
  if (query.mode === "overview") {
    const telemetry = (await db.query(`SELECT count(*)::int AS requests,
      count(*) FILTER(WHERE attributes->>'status'='401')::int AS unauthorized,
      count(*) FILTER(WHERE attributes->>'status'='403')::int AS forbidden,
      count(*) FILTER(WHERE attributes->>'status'='429')::int AS throttled,
      count(*) FILTER(WHERE attributes->>'status' ~ '^5[0-9]{2}$')::int AS server_errors,
      count(*) FILTER(WHERE attributes->>'outcome'='denied')::int AS denied,
      count(*) FILTER(WHERE attributes->>'idempotency_replayed'='true')::int AS replays,
      count(*) FILTER(WHERE attributes->>'error_code' IN('idempotency_conflict','external_order_conflict'))::int AS conflicts,
      count(*) FILTER(WHERE attributes->>'error_code'='insufficient_stock')::int AS stock_rejections,
      count(*) FILTER(WHERE attributes->>'outcome'='success' AND attributes->>'method'='POST' AND
        (attributes->>'route'='/partner/v1/orders' OR attributes->>'tool_name'='book_order'))::int AS books,
      COALESCE(percentile_cont(0.5) WITHIN GROUP(ORDER BY (attributes->>'duration_ms')::double precision)
        FILTER(WHERE attributes->>'duration_ms' ~ '^[0-9]+(?:\\.[0-9]+)?$'),0)::double precision AS p50_ms,
      COALESCE(percentile_cont(0.95) WITHIN GROUP(ORDER BY (attributes->>'duration_ms')::double precision)
        FILTER(WHERE attributes->>'duration_ms' ~ '^[0-9]+(?:\\.[0-9]+)?$'),0)::double precision AS p95_ms,
      COALESCE(percentile_cont(0.99) WITHIN GROUP(ORDER BY (attributes->>'duration_ms')::double precision)
        FILTER(WHERE attributes->>'duration_ms' ~ '^[0-9]+(?:\\.[0-9]+)?$'),0)::double precision AS p99_ms
      FROM observability.partner_logs WHERE merchant_id=$1 AND observed_at>=$2 AND observed_at<$3
      AND ($4::text IS NULL OR integration_id=$4) AND attributes->>'environment'=$5
      AND attributes->>'method' IN('GET','POST','DELETE','OPTIONS')`, base)).rows[0];
    const commerce = (await db.query(`SELECT count(*)::int AS orders,
      COALESCE(sum(CASE WHEN latest.currency_code='VND' AND latest.commercial_state='active' THEN components.total_minor ELSE 0 END),0)::text
        AS booked_value_vnd_minor
      FROM integration.partner_orders partner
      LEFT JOIN LATERAL(SELECT revision.id,revision.currency_code,revision.commercial_state
        FROM app.order_commercial_revisions revision WHERE revision.order_id=partner.core_order_id
        ORDER BY revision.revision DESC LIMIT 1) latest ON true
      LEFT JOIN app.order_commercial_revision_components components ON components.revision_id=latest.id
      WHERE partner.merchant_id=$1 AND partner.created_at>=$2 AND partner.created_at<$3
      AND ($4::text IS NULL OR partner.integration_id=$4)
      AND partner.integration_id IN(SELECT id FROM integration.integrations WHERE environment=$5)`, base)).rows[0];
    const outbox = (await db.query(`SELECT COALESCE(max(EXTRACT(EPOCH FROM(clock_timestamp()-event.created_at))),0)::double precision AS oldest_pending_seconds
      FROM outbox.events event JOIN integration.partner_orders partner ON partner.core_order_id=event.aggregate_id
      WHERE partner.merchant_id=$1 AND event.status IN('pending','processing','failed')
      AND ($2::text IS NULL OR partner.integration_id=$2)
      AND partner.integration_id IN(SELECT id FROM integration.integrations WHERE environment=$3)`, [scope.merchantId, query.integration_id ?? null, environment])).rows[0];
    const alerts = (await db.query(`SELECT alert_key,code,integration_id,first_seen::text,last_seen::text,detail
      FROM observability.partner_alerts WHERE active=true AND (merchant_id=$1 OR merchant_id IS NULL)
      AND ($2::text IS NULL OR integration_id=$2 OR integration_id IS NULL)
      AND detail->>'environment'=$3 ORDER BY code,alert_key`,
    [scope.merchantId, query.integration_id ?? null, environment])).rows;
    const byCredential = (await db.query(`SELECT integration_id,credential_id,
      count(*)::int requests,
      count(*) FILTER(WHERE attributes->>'status' ~ '^5[0-9]{2}$')::int server_errors,
      count(*) FILTER(WHERE attributes->>'idempotency_replayed'='true')::int replays,
      COALESCE(percentile_cont(0.95) WITHIN GROUP(ORDER BY (attributes->>'duration_ms')::double precision)
        FILTER(WHERE attributes->>'duration_ms' ~ '^[0-9]+(?:\\.[0-9]+)?$'),0)::double precision p95_ms
      FROM observability.partner_logs WHERE merchant_id=$1 AND observed_at>=$2 AND observed_at<$3
      AND ($4::text IS NULL OR integration_id=$4) AND attributes->>'environment'=$5
      AND attributes->>'method' IN('GET','POST','DELETE','OPTIONS')
      GROUP BY integration_id,credential_id ORDER BY count(*) DESC,integration_id,credential_id LIMIT 101`,base)).rows;
    data = { telemetry: {...telemetry, requests_per_second:telemetry.requests / ((Date.parse(query.to)-Date.parse(query.from))/1000)},
      commerce, outbox, alerts, by_credential:byCredential.slice(0,100), credentials_truncated:byCredential.length>100 };
  } else {
    const security = query.mode === "security";
    if (query.after_event_key) {
      const cursor = await db.query(`SELECT event_key FROM observability.partner_logs WHERE event_key=$1
        AND merchant_id=$2 AND observed_at>=$3 AND observed_at<$4 AND ($5::text IS NULL OR integration_id=$5)
        AND attributes->>'environment'=$6 AND security=$7::boolean`, [query.after_event_key, ...base, security]);
      if (!cursor.rowCount) fail("invalid_cursor", 400);
    }
    const rows = (await db.query(`SELECT event_key,observed_at::text,integration_id,credential_id,security,attributes
      FROM observability.partner_logs WHERE merchant_id=$1 AND observed_at>=$2 AND observed_at<$3
      AND ($4::text IS NULL OR integration_id=$4) AND attributes->>'environment'=$5 AND security=$7::boolean
      AND ($6::text IS NULL OR (observed_at,event_key)<(SELECT observed_at,event_key FROM observability.partner_logs WHERE event_key=$6))
      ORDER BY observed_at DESC,event_key DESC LIMIT $8`, [...base, query.after_event_key ?? null, security, query.limit + 1])).rows;
    const page = rows.slice(0, query.limit);
    data = { rows: page, next_after_event_key: rows.length > query.limit ? page.at(-1)!.event_key : null };
  }
  const receipt = await recordAuditEntry(db, { ...actor, organizationId: merchant.legacy_organization_id, requestId },
    "partner.log_view", "merchant", scope.merchantId, { merchantId: scope.merchantId, correlationId: requestId,
      after: { mode: query.mode, from: query.from, to: query.to, integration_id: query.integration_id ?? null,
        row_count: Array.isArray(data.rows) ? data.rows.length : null } });
  return { data, meta: { request_id: requestId, audit_id: receipt.id } };
}

let pool: Pool | undefined, inflight = 0;
export async function readPartnerOperations(actor: PermissionActor, scope: MerchantTargetScope, raw: unknown, requestId: string) {
  const url = process.env.PARTNER_OPERATIONS_DATABASE_URL, environment = process.env.PARTNER_ENVIRONMENT;
  if (!url || (environment !== "sandbox" && environment !== "production") || inflight >= 2) fail("dependency_unavailable", 503);
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 1000, ...partnerDatabaseTimeouts });
    pool.on("error", () => undefined);
  }
  inflight++;
  try {
    return await withPartnerTransaction(pool, async db => {
      const role = await db.query(`SELECT NOT(rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)
        AND pg_has_role(current_user,'snus_partner_operations','MEMBER') AS allowed FROM pg_roles WHERE rolname=current_user`);
      if (role.rows[0]?.allowed !== true) fail("dependency_unavailable", 503);
      return readPartnerOperationsForClient(db, actor, scope, raw, environment, requestId);
    }, { begin: "BEGIN ISOLATION LEVEL REPEATABLE READ" });
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    return fail("dependency_unavailable", 503);
  } finally { inflight--; }
}
