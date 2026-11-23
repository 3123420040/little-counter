import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PartnerAccessLog } from "./runtime";
import { postPartnerTelemetry } from "./telemetry-transport";

export interface PartnerTelemetryEntry extends Omit<PartnerAccessLog, "service" | "method"> {
  service: "medusa-partner-api" | "exact-outbox-worker";
  method: "GET" | "POST" | "PROCESS";
  origin_request_id?: string;
  event_id?: string;
  core_order_id?: string;
  parent_span_id?: string;
}

// Allowlisted, bounded local spool. Export is asynchronous and never decides a
// committed commerce response. Files survive process/collector restart.
export function createPartnerTelemetry(directory: string, endpoint: string) {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid telemetry endpoint");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // This directory belongs to one API process. An interrupted temp write was
  // never published; removing it at startup keeps crash residue bounded.
  for(const name of readdirSync(directory))if(/^[0-9]+-[a-f0-9-]+\.json\.tmp$/.test(name))unlinkSync(join(directory,name));
  const maxRecords = 1024;
  const maxRecordBytes = 16384;
  let dropped = 0, exported = 0, failures = 0, running = false, stopped = false;
  let consecutiveFailures=0,lastAlert="",storageFailed=false;
  const files = () => readdirSync(directory).filter(name => /^[0-9]+-[a-f0-9-]+\.json$/.test(name)).sort();
  const fields: ReadonlyArray<keyof PartnerTelemetryEntry> = ["timestamp","service","environment","release","source",
    "request_id","trace_id","span_id","partner_id","integration_id","client_id","merchant_id","store_id",
    "grant_version","route","method","status","duration_ms","outcome","error_code","idempotency_replayed","client_correlation_id",
    "origin_request_id","event_id","core_order_id","parent_span_id","original_request_id",
    "auth_method","credential_id","key_id","transport","tool_name"];
  function emit(entry: PartnerTelemetryEntry) {
    try {
      const safe = Object.fromEntries(fields.filter(key => entry[key] != null).map(key => [key, entry[key]]));
      const attributes = Object.entries(safe).map(([key, value]) => ({key, value: typeof value === "number"
        ? {doubleValue: value} : typeof value === "boolean" ? {boolValue:value} : {stringValue:String(value).slice(0,256)}}));
      const resource = {attributes:[{key:"service.name",value:{stringValue:entry.service}},
        {key:"deployment.environment.name",value:{stringValue:entry.environment}},
        {key:"service.version",value:{stringValue:entry.release}}]};
      const end = BigInt(Date.parse(entry.timestamp)) * 1000000n;
      const start = end - BigInt(Math.max(0,Math.round(entry.duration_ms))) * 1000000n;
      // MCP tool/protocol denials can travel over HTTP200. Classify the
      // operation outcome so the WARN-filtered security stream retains them.
      const denied = entry.outcome === "denied" || entry.error_code != null;
      const record = JSON.stringify({
        logs:{resourceLogs:[{resource,scopeLogs:[{scope:{name:"snus.partner"},logRecords:[{
          timeUnixNano:end.toString(),observedTimeUnixNano:end.toString(),traceId:entry.trace_id,spanId:entry.span_id,
          severityNumber:entry.status>=500?17:entry.status>=400||denied?13:9,body:{stringValue:"partner.request"},attributes}]}]}]},
        traces:{resourceSpans:[{resource,scopeSpans:[{scope:{name:"snus.partner"},spans:[{
          traceId:entry.trace_id,spanId:entry.span_id,parentSpanId:entry.parent_span_id,
          name:`${entry.method} ${entry.route}`,kind:entry.method === "PROCESS" ? 5 : 2,
          startTimeUnixNano:start.toString(),endTimeUnixNano:end.toString(),attributes,
          status:{code:entry.status>=400||denied?2:1}}]}]}]},
      });
      if (Buffer.byteLength(record)>maxRecordBytes || files().length>=maxRecords) {dropped++;return;}
      const name = `${Date.now()}-${randomUUID()}.json`;
      const temporary = join(directory,`${name}.tmp`);
      writeFileSync(temporary,record,{mode:0o600,flag:"wx",flush:true});
      renameSync(temporary,join(directory,name));
    } catch { dropped++; }
  }
  async function flush() {
    if(running||stopped)return;
    running=true;
    try {
      for(const name of files().slice(0,32)) {
        const path=join(directory,name);
        const record=JSON.parse(readFileSync(path,"utf8"));
        for(const signal of ["logs","traces"] as const){
          const result = await postPartnerTelemetry(new URL(`/v1/${signal}`,url),JSON.stringify(record[signal]));
          if(result.length>4096 || (result && Object.keys(JSON.parse(result)?.partialSuccess??{}).length))throw new Error("Telemetry partial export");
        }
        unlinkSync(path);exported++;consecutiveFailures=0;
      }
    } catch {failures++;consecutiveFailures++;} finally {running=false;publishHealth();}
  }
  function health(){
    let pending:number|null=null;
    try {pending=files().length;}catch {storageFailed=true;}
    return {pid:process.pid,observed_at:new Date().toISOString(),stopped,dropped,exported,failures,consecutive_failures:consecutiveFailures,
      pending,running,storage_failed:storageFailed,max_records:maxRecords,max_record_bytes:maxRecordBytes,
      alerts:[...(dropped>0?["telemetry_dropped"]:[]),...(storageFailed?["telemetry_storage_failed"]:[]),
        ...(consecutiveFailures>=3?["telemetry_export_failed"]:[]),...(pending!==null&&pending>=820?["telemetry_queue_pressure"]:[])]};
  }
  function publishHealth(){
    let snapshot=health();
    try {
      writeFileSync(join(directory,"health.json.tmp"),JSON.stringify(snapshot),{mode:0o600});
      renameSync(join(directory,"health.json.tmp"),join(directory,"health.json"));
      storageFailed=false;
    }catch {storageFailed=true;snapshot=health();}
    const state=snapshot.alerts.join(",");
    if(state!==lastAlert){
      lastAlert=state;
      try {if(process.stderr.writableLength<65536)process.stderr.write(`${JSON.stringify({timestamp:snapshot.observed_at,
        service:"partner-telemetry",outcome:state?"alert":"recovered",alerts:snapshot.alerts})}\n`);}catch {/* Health file remains the independent signal. */}
    }
  }
  const timer=setInterval(()=>{void flush();},500);timer.unref();
  const healthTimer=setInterval(publishHealth,5000);healthTimer.unref();
  return {emit,flush,health,
    close:()=>{stopped=true;clearInterval(timer);clearInterval(healthTimer);publishHealth();}};
}
