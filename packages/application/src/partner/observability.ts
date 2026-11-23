import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";

const fields = new Set(["timestamp", "service", "environment", "release", "source", "request_id", "trace_id", "span_id",
  "partner_id", "integration_id", "client_id", "merchant_id", "store_id", "grant_version", "route", "method", "status",
  "duration_ms", "outcome", "error_code", "idempotency_replayed", "client_correlation_id", "origin_request_id", "event_id",
  "core_order_id", "parent_span_id", "original_request_id", "auth_method", "credential_id", "key_id", "transport", "tool_name"]);
const recordSchema = z.object({ timeUnixNano: z.string().regex(/^\d{1,20}$/), severityNumber: z.number().int().min(0).max(24),
  attributes: z.array(z.object({ key: z.string().max(128), value: z.object({ stringValue: z.string().max(256).optional(),
    doubleValue: z.number().finite().optional(), intValue: z.union([z.number(), z.string()]).optional(), boolValue: z.boolean().optional() }) })).max(64) });
const payloadSchema = z.object({ resourceLogs: z.array(z.object({ scopeLogs: z.array(z.object({
  logRecords: z.array(z.unknown()).max(256) })).max(16) })).max(16) });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class InvalidPartnerTelemetryBatch extends Error {}

// Called inside one transaction: OTLP acknowledgement follows durable commit.
// The collector is the sole trusted loopback sender, never a partner endpoint.
export async function ingestPartnerLogs(db: PoolClient, raw: unknown, environment: string) {
  const parsedPayload = payloadSchema.safeParse(raw);
  if (!parsedPayload.success) throw new InvalidPartnerTelemetryBatch("Invalid telemetry envelope");
  const payload = parsedPayload.data;
  const records = payload.resourceLogs.flatMap(resource => resource.scopeLogs.flatMap(scope => scope.logRecords));
  if (records.length > 256) throw new InvalidPartnerTelemetryBatch("Batch too large");
  let inserted = 0, rejected = 0;
  for (const rawRecord of records) {
    const parsedRecord=recordSchema.safeParse(rawRecord);
    if(!parsedRecord.success){rejected++;continue;}
    const record=parsedRecord.data;
    const attrs: Record<string, string | number | boolean> = {};
    for (const entry of record.attributes) {
      if (!fields.has(entry.key)) continue;
      const value = entry.value.stringValue ?? entry.value.doubleValue ?? entry.value.boolValue ?? entry.value.intValue;
      if (value !== undefined) attrs[entry.key] = value;
    }
    // JSONB cannot represent NUL or unpaired UTF-16 surrogates. Reject before
    // even the scope lookup so deterministic text errors never enter retries.
    if(Object.values(attrs).some(value=>typeof value==="string"&&(value.includes(String.fromCharCode(0))||/[\uD800-\uDFFF]/u.test(value)))){rejected++;continue;}
    // Prevent JSONB's decimal expansion of tiny/huge exponent numbers from
    // defeating the bounded record size. Native telemetry uses these 3 numbers.
    if(Object.entries(attrs).some(([key,value])=>typeof value==="number"&&
      (!["status","duration_ms","grant_version"].includes(key)||!Number.isFinite(value)||Math.abs(value)>1e9
        ||(value!==0&&Math.abs(value)<1e-6)))){rejected++;continue;}
    if (attrs.environment !== environment) {rejected++;continue;}
    const observed = new Date(Number(BigInt(record.timeUnixNano) / 1000000n));
    if (!Number.isFinite(observed.getTime()) || observed.getTime() > Date.now() + 60000) {rejected++;continue;}
    let invalid=false;
    for (const key of ["status", "duration_ms", "grant_version"]) if (attrs[key] !== undefined) {
      const value = Number(attrs[key]);
      if (!Number.isFinite(value) || value < 0 || value > (key === "status" ? 599 : 1e9)
        ||(value!==0&&value<1e-6)) {invalid=true;break;}
      attrs[key] = value;
    }
    if(invalid){rejected++;continue;}
    const merchant = typeof attrs.merchant_id === "string" ? attrs.merchant_id : null;
    const integration = typeof attrs.integration_id === "string" ? attrs.integration_id : null;
    if (merchant || integration) {
      const owned = await db.query("SELECT id FROM integration.integrations WHERE id=$1 AND merchant_id=$2 AND environment=$3", [integration, merchant, environment]);
      if (!owned.rowCount) {rejected++;continue;}
    }
    const security = record.severityNumber >= 13 || attrs.outcome === "denied" || attrs.error_code !== undefined;
    const safe = Object.fromEntries(Object.keys(attrs).sort().map(key => [key, attrs[key]]));
    if(Buffer.byteLength(JSON.stringify(safe),"utf8")+2*Object.keys(safe).length>8192){rejected++;continue;}
    const key = hash(JSON.stringify([observed.toISOString(), security, safe]));
    const result = await db.query(`INSERT INTO observability.partner_logs(event_key,observed_at,merchant_id,integration_id,credential_id,security,attributes)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_key) DO NOTHING`, [key, observed, merchant, integration,
      typeof attrs.credential_id === "string" ? attrs.credential_id : null, security, safe]);
    inserted += result.rowCount ?? 0;
  }
  return {inserted,rejected};
}

export interface ObserverHealth { code: string; active: boolean; source: string }
export async function maintainPartnerObservability(db: PoolClient, health: ObserverHealth[] = [], environment="sandbox") {
  // Advisory lock makes retention and alert transitions serial across replicas.
  await db.query("SELECT pg_advisory_xact_lock(hashtext('partner-observability'))");
  const purged = await db.query(`DELETE FROM observability.partner_logs WHERE event_key IN (
    SELECT event_key FROM observability.partner_logs WHERE observed_at < clock_timestamp()-
      CASE WHEN security THEN interval '90 days' ELSE interval '30 days' END ORDER BY observed_at LIMIT 500)`);
  const rows = (await db.query(`SELECT merchant_id,integration_id,
    count(*) FILTER(WHERE observed_at>clock_timestamp()-interval '5 minutes')::int requests,
    count(*) FILTER(WHERE observed_at>clock_timestamp()-interval '5 minutes' AND attributes->>'status' ~ '^5[0-9]{2}$')::int errors,
    count(*) FILTER(WHERE observed_at>clock_timestamp()-interval '1 minute' AND attributes->>'outcome'='denied')::int denied,
    count(*) FILTER(WHERE attributes->>'error_code'='internal_error')::int internal_errors,
    COALESCE(percentile_cont(0.95) WITHIN GROUP(ORDER BY (attributes->>'duration_ms')::double precision)
      FILTER(WHERE (attributes->>'tool_name'='book_order' OR attributes->>'route'='/partner/v1/orders')
        AND attributes->>'method'='POST' AND attributes->>'duration_ms' ~ '^[0-9]+(?:\\.[0-9]+)?$'),0) book_p95_ms
    FROM observability.partner_logs WHERE observed_at>clock_timestamp()-interval '10 minutes'
      AND merchant_id IS NOT NULL AND attributes->>'environment'=$1
      AND attributes->>'method' IN('GET','POST','DELETE','OPTIONS') GROUP BY merchant_id,integration_id`,[environment])).rows;
  const desired: Array<{merchant: string | null; integration: string | null; code: string; detail: Record<string, unknown>}> = [];
  for (const row of rows) {
    const add = (code: string, detail: Record<string, unknown>) => desired.push({merchant:row.merchant_id,integration:row.integration_id,code,detail});
    if (row.requests >= 50 && row.errors / row.requests > 0.02) add("partner_5xx_rate", {requests:row.requests,errors:row.errors});
    if (row.denied > 20) add("partner_auth_denials", {denied:row.denied});
    if (Number(row.book_p95_ms) > 2000) add("partner_booking_latency", {p95_ms:Number(row.book_p95_ms)});
    if (row.internal_errors > 0) add("partner_internal_failure", {count:row.internal_errors});
  }
  const outbox = (await db.query(`SELECT partner.merchant_id,partner.integration_id,max(EXTRACT(EPOCH FROM(clock_timestamp()-event.created_at)))::double precision lag_seconds
    FROM outbox.events event JOIN integration.partner_orders partner ON partner.core_order_id=event.aggregate_id
    JOIN integration.integrations integration ON integration.id=partner.integration_id
    WHERE event.status IN('pending','processing','failed') AND event.created_at<clock_timestamp()-interval '60 seconds'
      AND integration.environment=$1 GROUP BY partner.merchant_id,partner.integration_id`,[environment])).rows;
  for (const row of outbox) desired.push({merchant:row.merchant_id,integration:row.integration_id,code:"outbox_lag",detail:{oldest_pending_seconds:row.lag_seconds}});
  for (const row of health) if (row.active) desired.push({merchant:null,integration:null,code:row.code,detail:{source:row.source}});
  const keys = [];
  for (const row of desired) {
    row.detail.environment=environment;
    const key = hash(JSON.stringify([environment,row.merchant,row.integration,row.code,row.detail.source ?? null])); keys.push(key);
    const changed = await db.query(`INSERT INTO observability.partner_alerts(alert_key,merchant_id,integration_id,code,active,first_seen,last_seen,detail)
      VALUES($1,$2,$3,$4,true,clock_timestamp(),clock_timestamp(),$5) ON CONFLICT(alert_key) DO UPDATE SET
      active=true,first_seen=CASE WHEN partner_alerts.active THEN partner_alerts.first_seen ELSE EXCLUDED.first_seen END,
      last_seen=EXCLUDED.last_seen,detail=EXCLUDED.detail RETURNING alert_key`, [key,row.merchant,row.integration,row.code,row.detail]);
    if (!changed.rowCount) throw new Error("Alert persistence failed");
  }
  await db.query("UPDATE observability.partner_alerts SET active=false,last_seen=clock_timestamp() WHERE active AND detail->>'environment'=$2 AND NOT(alert_key=ANY($1::text[]))",[keys,environment]);
  await db.query("DELETE FROM observability.partner_alerts WHERE NOT active AND last_seen<clock_timestamp()-interval '90 days'");
  return {purged:purged.rowCount ?? 0,active_alerts:desired.length};
}
