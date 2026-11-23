import { mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer,type Server } from "node:http";
import { afterEach,describe,it,expect } from "vitest";
import { createPartnerTelemetry } from "../partner/telemetry";
import type { PartnerAccessLog } from "../partner/runtime";
const directories:string[]=[];
const instances:ReturnType<typeof createPartnerTelemetry>[]=[];
const servers:Server[]=[];
const entry:PartnerAccessLog={timestamp:new Date().toISOString(),service:"medusa-partner-api",environment:"sandbox",release:"2.2.0-test",
  source:"a".repeat(40),request_id:"req_telemetry",trace_id:"b".repeat(32),span_id:"c".repeat(16),partner_id:null,integration_id:null,
  client_id:null,merchant_id:null,store_id:null,grant_version:null,route:"/partner/v1/orders/{order_id}",method:"GET",status:401,
  duration_ms:12,outcome:"denied",error_code:"invalid_token",idempotency_replayed:false,client_correlation_id:null};
function directory(){const path=mkdtempSync(join(tmpdir(),"partner-telemetry-"));directories.push(path);return path;}
function create(path:string,endpoint:string){const value=createPartnerTelemetry(path,endpoint);instances.push(value);return value;}
afterEach(async()=>{instances.splice(0).forEach(value=>value.close());for(const server of servers.splice(0))await new Promise<void>(resolve=>server.close(()=>resolve()));
  directories.splice(0).forEach(path=>rmSync(path,{recursive:true,force:true}));});
describe("partner bounded disk telemetry",()=>{
  it("keeps MCP HTTP200 denials in the security stream and marks their spans failed",()=>{
    const path=directory(),sink=create(path,"http://127.0.0.1:1");
    const cases=[
      {id:"protocol",status:200,outcome:"denied",code:"mcp_protocol_error",severity:13,spanStatus:2},
      {id:"validation",status:200,outcome:"denied",code:"invalid_request",severity:13,spanStatus:2},
      {id:"success",status:200,outcome:"success",code:null,severity:9,spanStatus:1},
      {id:"dependency",status:503,outcome:"denied",code:"dependency_unavailable",severity:17,spanStatus:2},
    ];
    for(const c of cases)sink.emit({...entry,request_id:c.id,status:c.status,outcome:c.outcome,error_code:c.code,transport:"mcp_http",route:"/mcp"});
    for(const name of readdirSync(path)){
      const record=JSON.parse(readFileSync(join(path,name),"utf8"));
      const log=record.logs.resourceLogs[0].scopeLogs[0].logRecords[0];
      const id=log.attributes.find((a:{key:string})=>a.key==="request_id").value.stringValue;
      const expected=cases.find(c=>c.id===id)!;
      expect(log.severityNumber).toBe(expected.severity);
      expect(record.traces.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(expected.spanStatus);
    }
  });
  it("persists only allowlisted logs and real request span identities before asynchronous export",()=>{
    const path=directory();const sink=create(path,"http://127.0.0.1:1");
    sink.emit({...entry,authorization:"SECRET_TOKEN",body:"PRIVATE_CONTACT",external_order_id:"PRIVATE_EXTERNAL"} as PartnerAccessLog);
    expect(sink.health().pending).toBe(1);
    const raw=readFileSync(join(path,readdirSync(path)[0]),"utf8");
    for(const secret of ["SECRET_TOKEN","PRIVATE_CONTACT","PRIVATE_EXTERNAL"])expect(raw).not.toContain(secret);
    const span=JSON.parse(raw).traces.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBe(entry.trace_id);expect(span.name).toBe("GET /partner/v1/orders/{order_id}");
    expect(BigInt(span.endTimeUnixNano)-BigInt(span.startTimeUnixNano)).toBe(12000000n);
  });
  it("retains disk records on collector outage, then exports them after process restart",async()=>{
    const path=directory();const first=create(path,"http://127.0.0.1:1");first.emit(entry);await first.flush();
    expect(first.health()).toMatchObject({pending:1,failures:1,exported:0});first.close();
    const requests:string[]=[];const server=createServer(async(req,res)=>{for await(const _chunk of req){ /* drain */ }
      requests.push(req.url!);res.setHeader("content-type","application/json");res.end("{}");});servers.push(server);
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const second=create(path,`http://127.0.0.1:${(server.address() as {port:number}).port}`);await second.flush();
    expect(requests).toEqual(["/v1/logs","/v1/traces"]);expect(second.health()).toMatchObject({pending:0,exported:1});
  });
  it("caps queue growth and reports drops without throwing into commerce",()=>{
    const path=directory();const sink=create(path,"http://127.0.0.1:1");
    for(let n=0;n<1024;n++)writeFileSync(join(path,`${n}-aaaa.json`),"{}");
    expect(()=>sink.emit(entry)).not.toThrow();expect(sink.health()).toMatchObject({pending:1024,dropped:1});
  });
  it("publishes private health and alerts after repeated exporter failure, then records stopped state",async()=>{
    const path=directory();const sink=create(path,"http://127.0.0.1:1");sink.emit(entry);
    for(let n=0;n<3;n++)await sink.flush();
    const health=JSON.parse(readFileSync(join(path,"health.json"),"utf8"));
    expect(health).toMatchObject({pending:1,consecutive_failures:3,stopped:false,alerts:["telemetry_export_failed"]});
    expect(health.observed_at).toBeTruthy();
    sink.close();expect(JSON.parse(readFileSync(join(path,"health.json"),"utf8")).stopped).toBe(true);
  });
  it("removes unpublished crash residue before accepting more telemetry",()=>{
    const path=directory();writeFileSync(join(path,"1-aaaa.json.tmp"),"partial");
    create(path,"http://127.0.0.1:1");expect(readdirSync(path)).toEqual([]);
  });
});
