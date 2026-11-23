import { randomBytes, randomUUID } from "node:crypto";
import { createPartnerTelemetry, type PartnerTelemetryEntry } from "./telemetry";

let sink: ReturnType<typeof createPartnerTelemetry> | undefined;
let dropped = 0;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

function workerTelemetry() {
  // The production worker mounts its own spool and sets the shared telemetry
  // directory variable. Keep the dedicated variable used by isolated tests.
  const directory = process.env.PARTNER_WORKER_TELEMETRY_DIRECTORY
    ?? process.env.PARTNER_TELEMETRY_DIRECTORY;
  const endpoint = process.env.PARTNER_TELEMETRY_ENDPOINT;
  if (!directory || !endpoint) return undefined;
  sink ??= createPartnerTelemetry(directory, endpoint);
  return sink;
}

/** Payload was committed by the core; bind it to the claimed envelope before
 * admitting provenance. Each claim attempt gets a new request/span identity. */
export function beginPartnerWorkerTrace(event: { id: string; merchantId: string; storeId: string | null;
  aggregateId: string; eventType: string; payload: Record<string,unknown> }) {
  const p=event.payload;
  if(p.actorType!=="partner")return;
  try {
    // Old committed OAuth envelopes have no discriminator. Explicit new
    // identities must be internally consistent; never invent a client for MCP.
    const authMethod=p.authMethod??"oauth_client";
    const credentialId=p.credentialId??(p.authMethod===undefined?p.clientId:undefined);
    const validCredential=authMethod==="mcp_key"
      ? id(p.keyId) && p.clientId===null && p.registryClientId===null && credentialId===p.keyId
      : authMethod==="oauth_client" && id(p.clientId) && credentialId===p.clientId && p.keyId==null;
    if(p.merchantId!==event.merchantId || p.storeId!==event.storeId || p.orderId!==event.aggregateId
      || !id(p.partnerId) || !id(p.integrationId) || !validCredential || !id(p.originRequestId)
      || !id(event.id) || !id(event.aggregateId) || !id(event.eventType)
      || typeof p.traceId!=="string" || !/^[a-f0-9]{32}$/.test(p.traceId)
      || !Number.isSafeInteger(p.grantVersion) || Number(p.grantVersion)<1) {dropped++;return;}
    const telemetry=workerTelemetry();
    if(!telemetry)return;
    const start=performance.now();
    const identity={request_id:`req_${randomUUID()}`,trace_id:p.traceId,span_id:randomBytes(8).toString("hex"),
      parent_span_id:typeof p.spanId==="string" && /^[a-f0-9]{16}$/.test(p.spanId) ? p.spanId : undefined,
      origin_request_id:p.originRequestId,event_id:event.id,core_order_id:event.aggregateId,
      partner_id:p.partnerId,integration_id:p.integrationId,client_id:authMethod==="mcp_key"?null:String(p.clientId),merchant_id:event.merchantId,
      auth_method:authMethod as "mcp_key"|"oauth_client",credential_id:String(credentialId),key_id:authMethod==="mcp_key"?String(p.keyId):null,
      transport:authMethod==="mcp_key"?"mcp_http" as const:"rest" as const,
      store_id:event.storeId,grant_version:Number(p.grantVersion)};
    return (outcome: "completed" | "retry_scheduled" | "dead_lettered" | "stale_claim" | "transition_failed") => {
      try {
        const entry: PartnerTelemetryEntry={...identity,timestamp:new Date().toISOString(),service:"exact-outbox-worker",
          environment:process.env.PARTNER_ENVIRONMENT??"unconfigured",release:process.env.BUILD_RELEASE_ID??"unconfigured",
          source:process.env.BUILD_SOURCE_COMMIT??"unconfigured",route:event.eventType,method:"PROCESS",
          status:outcome==="completed" ? 200 : 500,duration_ms:performance.now()-start,outcome,
          error_code:outcome==="completed" ? null : outcome,idempotency_replayed:false,client_correlation_id:null};
        telemetry.emit(entry);
        const line=`${JSON.stringify(entry)}\n`;
        if(process.stdout.writableLength<65536)process.stdout.write(line);else dropped++;
      } catch {dropped++;}
    };
  } catch {dropped++;return;}
}

export function partnerWorkerTelemetryHealth() {
  // Initialize even while the queue is idle. The observer needs a live worker
  // heartbeat before the first partner order is allowed through.
  const health=workerTelemetry()?.health();
  return {...health,dropped:dropped+(health?.dropped??0)};
}
export function closePartnerWorkerTelemetry() { sink?.close(); sink=undefined; }
