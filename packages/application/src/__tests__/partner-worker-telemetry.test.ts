import { mkdtempSync,readFileSync,readdirSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,it,expect,vi } from "vitest";
import { beginPartnerWorkerTrace,closePartnerWorkerTelemetry,partnerWorkerTelemetryHealth } from "../partner/worker-telemetry";
let directory:string|undefined;
afterEach(()=>{closePartnerWorkerTelemetry();vi.unstubAllEnvs();vi.restoreAllMocks();if(directory)rmSync(directory,{recursive:true,force:true});});
const event={id:"event-1",merchantId:"merchant-1",storeId:"store-1",aggregateId:"order-1",eventType:"sale.created",payload:{
  actorType:"partner",partnerId:"partner-1",integrationId:"integration-1",clientId:"client-1",originRequestId:"req_origin",
  merchantId:"merchant-1",storeId:"store-1",orderId:"order-1",grantVersion:2,traceId:"a".repeat(32),spanId:"b".repeat(16),
  external_order_id:"PRIVATE_EXTERNAL",recipient_name:"PRIVATE_CONTACT",authorization:"SECRET_TOKEN"}};
function setup(){directory=mkdtempSync(join(tmpdir(),"partner-worker-trace-"));vi.stubEnv("PARTNER_WORKER_TELEMETRY_DIRECTORY",directory);
  vi.stubEnv("PARTNER_TELEMETRY_ENDPOINT","http://127.0.0.1:1");vi.spyOn(process.stdout,"write").mockReturnValue(true);}
describe("partner worker attempt provenance",()=>{
  it("starts an idle worker heartbeat from the production spool configuration",()=>{
    directory=mkdtempSync(join(tmpdir(),"partner-worker-idle-"));
    vi.stubEnv("PARTNER_WORKER_TELEMETRY_DIRECTORY",undefined);
    vi.stubEnv("PARTNER_TELEMETRY_DIRECTORY",directory);
    vi.stubEnv("PARTNER_TELEMETRY_ENDPOINT","http://127.0.0.1:1");
    const health=partnerWorkerTelemetryHealth();
    expect(health).toMatchObject({pid:process.pid,stopped:false,dropped:0});
    expect(readdirSync(directory)).toEqual([]);
  });
  it("preserves MCP key provenance with no fabricated OAuth client",()=>{
    setup();const payload={...event.payload,authMethod:"mcp_key",credentialId:"key-1",keyId:"key-1",clientId:null,registryClientId:null};
    beginPartnerWorkerTrace({...event,payload})!("completed");
    const record=JSON.parse(readFileSync(join(directory!,readdirSync(directory!)[0]),"utf8"));
    const attributes=record.traces.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    expect(attributes).toContainEqual({key:"auth_method",value:{stringValue:"mcp_key"}});
    expect(attributes).toContainEqual({key:"key_id",value:{stringValue:"key-1"}});
    expect(attributes.some((a:{key:string})=>a.key==="client_id")).toBe(false);
    expect(beginPartnerWorkerTrace({...event,payload:{...payload,clientId:"fabricated"}})).toBeUndefined();
  });
  it("links each new consumer span/request to the committed origin, with no payload disclosure",()=>{
    setup();beginPartnerWorkerTrace(event)!("retry_scheduled");beginPartnerWorkerTrace(event)!("completed");
    const records=readdirSync(directory!).map(name=>JSON.parse(readFileSync(join(directory!,name),"utf8")));
    expect(records).toHaveLength(2);
    const spans=records.map(r=>r.traces.resourceSpans[0].scopeSpans[0].spans[0]);
    for(const span of spans){expect(span).toMatchObject({traceId:event.payload.traceId,parentSpanId:event.payload.spanId,kind:5});
      expect(span.attributes).toContainEqual({key:"origin_request_id",value:{stringValue:"req_origin"}});}
    expect(new Set(spans.map(s=>s.spanId)).size).toBe(2);
    const requests=spans.map(s=>s.attributes.find((a:{key:string})=>a.key==="request_id").value.stringValue);
    expect(new Set(requests).size).toBe(2);expect(requests).not.toContain("req_origin");
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_EXTERNAL|PRIVATE_CONTACT|SECRET_TOKEN/);
  });
  it("rejects inconsistent envelope provenance without throwing into the worker",()=>{
    setup();const before=partnerWorkerTelemetryHealth().dropped;
    expect(beginPartnerWorkerTrace({...event,merchantId:"other"})).toBeUndefined();
    expect(partnerWorkerTelemetryHealth().dropped).toBe(before+1);expect(readdirSync(directory!)).toEqual([]);
  });
});
