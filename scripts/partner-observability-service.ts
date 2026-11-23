import { createServer } from "node:http";
import { readFileSync, lstatSync } from "node:fs";
import { Pool } from "pg";
import { ingestPartnerLogs, maintainPartnerObservability, InvalidPartnerTelemetryBatch, type ObserverHealth } from "../packages/application/src/partner/observability";
import { partnerDatabaseTimeouts, withPartnerTransaction } from "../packages/application/src/partner/transaction";

async function main() {
  const port=Number(process.env.PARTNER_OBSERVER_PORT), interval=Number(process.env.PARTNER_OBSERVER_INTERVAL_MS);
  const environment=process.env.PARTNER_ENVIRONMENT;
  if (!process.env.PARTNER_OBSERVER_DATABASE_URL || !["sandbox","production"].includes(environment ?? "")
    || !Number.isInteger(port) || port<1024 || port>65535 || !Number.isInteger(interval) || interval<1000 || interval>60000) throw Error("Invalid observer config");
  const paths: string[]=JSON.parse(process.env.PARTNER_OBSERVER_HEALTH_FILES ?? "[]");
  if (!Array.isArray(paths) || paths.length>16 || paths.some(path=>typeof path!=="string")) throw Error("Invalid health sources");
  const pool=new Pool({connectionString:process.env.PARTNER_OBSERVER_DATABASE_URL,max:2,connectionTimeoutMillis:1000,
    ...partnerDatabaseTimeouts,statement_timeout:5000});
  pool.on("error",()=>undefined);
  try {
    const role=await pool.query(`SELECT NOT(rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)
      AND pg_has_role(current_user,'snus_partner_observer','MEMBER') allowed FROM pg_roles WHERE rolname=current_user`);
    if (!role.rows[0]?.allowed) throw Error("Unsafe observer role");
  } catch(error) {await pool.end();throw error;}
  let stopping=false,running=false,ready=false,lastTick=0,ticks=0,failures=0,inflight=0;
  let rejectedRecords=0,lastRejection=0;
  let ingestFailed=false;
  let timer:ReturnType<typeof setTimeout> | undefined;
  const server=createServer(async(req,res)=>{
    if(req.method==="GET" && req.url==="/health") {
      const healthy=ready&&!ingestFailed&&!stopping&&Date.now()-lastTick<Math.max(15000,interval*3);
      res.writeHead(healthy?200:503,{"content-type":"application/json","cache-control":"no-store"});
      res.end(JSON.stringify({ready:healthy,ticks,failures,rejected_records:rejectedRecords,last_tick:lastTick?new Date(lastTick).toISOString():null}));return;
    }
    if(req.method!=="POST"||req.url!=="/v1/logs"){res.writeHead(404).end();return;}
    if(stopping||inflight>=1){res.writeHead(503).end();return;}
    if(!/^application\/json(?:;|$)/i.test(req.headers["content-type"]??"")){res.writeHead(415).end();return;}
    inflight++;
    try {
      const chunks:Buffer[]=[];let bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>1048576){res.writeHead(413).end();req.resume();return;}chunks.push(chunk);}
      let payload:unknown;try{payload=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{res.writeHead(400).end();return;}
      const result=await withPartnerTransaction(pool,db=>ingestPartnerLogs(db,payload,environment!),
        {timeoutMs:10000,statementTimeoutMs:5000});ingestFailed=false;
      if(result.rejected){rejectedRecords+=result.rejected;lastRejection=Date.now();}
      res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify(result.rejected
        ?{partialSuccess:{rejectedLogRecords:String(result.rejected),errorMessage:"Invalid telemetry records rejected"}}:{}));
    }catch(error){failures++;
      if(error instanceof InvalidPartnerTelemetryBatch){lastRejection=Date.now();res.writeHead(400).end();}
      else {ingestFailed=true;res.writeHead(503).end();}}
    finally{inflight--;}
  });
  server.requestTimeout=5000;server.headersTimeout=5000;server.maxConnections=8;
  try{await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(port,process.env.PARTNER_PRIVATE_BIND_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",resolve);});}
  catch(error){await pool.end();throw error;}
  async function tick(){
    running=true;
    try{
      const health:ObserverHealth[]=[];
      health.push({code:"telemetry_ingest_failed",active:ingestFailed,source:"observer"});
      health.push({code:"telemetry_records_rejected",active:lastRejection>0&&Date.now()-lastRejection<600000,source:"observer"});
      for(const [index,path] of paths.entries()){
        const source=`process-${index+1}`;
        try{
          const stat=lstatSync(path);
          if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw Error("Unsafe health source");
          const value=JSON.parse(readFileSync(path,"utf8"));
          if(!Number.isFinite(Date.parse(value.observed_at))||Date.now()-Date.parse(value.observed_at)>15000||value.stopped)throw Error("Stale health");
          for(const code of ["telemetry_dropped","telemetry_storage_failed","telemetry_export_failed","telemetry_queue_pressure"])
            health.push({code,active:Array.isArray(value.alerts)&&value.alerts.includes(code),source});
        }catch{health.push({code:"telemetry_health_unavailable",active:true,source});}
      }
      const result=await withPartnerTransaction(pool,db=>maintainPartnerObservability(db,health,environment),
        {timeoutMs:10000,statementTimeoutMs:5000});
      ready=true;ticks++;
      if(result.purged)console.log(JSON.stringify({service:"partner-observer",outcome:"retention",...result}));
    }catch{ready=false;failures++;}
    finally{lastTick=Date.now();running=false;if(!stopping)timer=setTimeout(tick,interval);}
  }
  async function stop(){if(stopping)return;stopping=true;clearTimeout(timer);server.close();
    while(running||inflight)await new Promise(resolve=>setTimeout(resolve,50));await pool.end();}
  process.once("SIGTERM",()=>{void stop();});process.once("SIGINT",()=>{void stop();});
  await tick();
}
void main().catch(()=>{console.error(JSON.stringify({service:"partner-observer",outcome:"startup_failed"}));process.exitCode=1;});
