import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Pool } from "pg";
import { createPartnerAsAdmin, type PartnerAsConfig } from "../packages/application/src/partner/authorization-server";
import { reconcilePartnerControlOnce } from "../packages/application/src/partner/control-reconciler";
import { partnerDatabaseTimeouts } from "../packages/application/src/partner/transaction";

async function main() {
  const interval = Number(process.env.PARTNER_RECONCILER_INTERVAL_MS);
  const port = Number(process.env.PARTNER_RECONCILER_HEALTH_PORT);
  if (!Number.isInteger(interval) || interval<500 || interval>60000 || !Number.isInteger(port) || port<1024 || port>65535
    || !process.env.PARTNER_RECONCILER_DATABASE_URL || !process.env.PARTNER_RECONCILER_AS_CONFIG_FILE) throw new Error("Missing bounded reconciler config");
  const config = JSON.parse(readFileSync(process.env.PARTNER_RECONCILER_AS_CONFIG_FILE,"utf8")) as PartnerAsConfig;
  const as = createPartnerAsAdmin(config);
  const pool = new Pool({connectionString:process.env.PARTNER_RECONCILER_DATABASE_URL,max:2,connectionTimeoutMillis:1000,
    ...partnerDatabaseTimeouts,application_name:"partner-control-reconciler"});
  pool.on("error",()=>undefined);
  try {
  const role = await pool.query(`SELECT NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)
    AND pg_has_role(current_user,'snus_partner_control','MEMBER') AS allowed FROM pg_roles WHERE rolname=current_user`);
  if (!role.rows[0]?.allowed) throw new Error("Unsafe reconciler role");
  } catch(error) {await pool.end();throw error;}
  let stopping=false; let running=false; let lastTick:string|null=null; let lastDependencyCheck=0;
  let ready=false; let completed=0; let failed=0; let timer:ReturnType<typeof setTimeout>|undefined;
  const server=createServer((req,res)=>{
    if(req.method!=="GET" || req.url!=="/health"){res.writeHead(404).end();return;}
    const healthy=!stopping && ready && !!lastTick && Date.now()-Date.parse(lastTick)<Math.max(60000,interval*3);
    res.writeHead(healthy?200:503,{"content-type":"application/json","cache-control":"no-store"});
    res.end(JSON.stringify({ready:healthy,running,last_tick:lastTick,interval_ms:interval,completed,failed}));
  });
  server.requestTimeout=5000; server.headersTimeout=5000;
  try {
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(port,process.env.PARTNER_PRIVATE_BIND_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",resolve);});
  } catch(error) {await pool.end();throw error;}
  async function tick(){
    running=true;
    try {
      if(Date.now()-lastDependencyCheck>30000){await as.ready();lastDependencyCheck=Date.now();}
      const result=await reconcilePartnerControlOnce(pool,config,as);
      ready=true;lastTick=new Date().toISOString();
      if(result.outcome!=="idle"){
        if(result.outcome==="completed")completed++;else failed++;
        console.log(JSON.stringify({timestamp:lastTick,service:"partner-control-reconciler",environment:config.environment,
          outcome:result.outcome,operation_id:result.operationId,error_code:"errorCode" in result?result.errorCode:null}));
      }
    }catch{ready=false;failed++;lastTick=new Date().toISOString();
      console.log(JSON.stringify({timestamp:lastTick,service:"partner-control-reconciler",outcome:"dependency_unavailable"}));
    }finally{running=false;if(!stopping)timer=setTimeout(tick,interval);}
  }
  async function stop(){if(stopping)return;stopping=true;clearTimeout(timer);server.close();
    while(running)await new Promise((resolve)=>setTimeout(resolve,50));await pool.end();}
  process.once("SIGTERM",()=>{void stop();});process.once("SIGINT",()=>{void stop();});
  console.log(JSON.stringify({service:"partner-control-reconciler",outcome:"started",interval_ms:interval,health_port:port}));
  await tick();
}
void main().catch(()=>{console.error(JSON.stringify({service:"partner-control-reconciler",outcome:"startup_failed"}));process.exitCode=1;});
