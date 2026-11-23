import { closeSync, constants, fstatSync, openSync, readFileSync, writeFileSync, fsyncSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { PartnerControlCommand, PartnerControlStatusQuery } from "@medusa-snus/contracts/partner-api";
import { readBoundedResponse } from "../packages/application/src/partner/bounded-response";

// Internal CLI uses a staff session from an owner-only secret file. It never
// receives a staff/partner token, AS secret or private key as a command argument.
async function main() {
  const [merchantId,inputFile]=process.argv.slice(2);
  if(!merchantId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(merchantId) || !inputFile)throw new Error("Usage: partner-control <merchant-id> <command.json>");
  const input=JSON.parse(readFileSync(inputFile,"utf8"));
  const isStatus=input?.action === "status";
  const { action: _action, ...statusQuery } = input;
  const command=isStatus ? PartnerControlStatusQuery.parse(statusQuery) : PartnerControlCommand.parse(input);
  const revealsKey=input?.action==="create_mcp_key"||input?.action==="rotate_mcp_key";
  // Reserve an owner-only output before sending the mutation. Never print the
  // secret; lost response leaves an empty file and requires orphan reconciliation.
  let secretFd:number|undefined;
  if(revealsKey){
    const destination=process.env.PARTNER_MCP_KEY_OUTPUT_FILE;
    if(!destination)throw new Error("Private key output file required");
    const parent=statSync(dirname(destination));
    if(!parent.isDirectory()||parent.uid!==process.getuid?.()||(parent.mode&0o077)!==0)throw new Error("Private key output directory required");
    secretFd=openSync(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  }
  try {
  const base=new URL(process.env.PARTNER_CONTROL_BASE_URL!);
  if(base.username||base.password||base.search||base.hash||base.pathname!=="/"
    || (base.protocol!=="https:" && !(base.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(base.hostname))))throw new Error("Invalid staff control URL");
  const fd=openSync(process.env.PARTNER_STAFF_TOKEN_FILE!,constants.O_RDONLY|constants.O_NOFOLLOW);
  let token: string;
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile() || stat.uid!==process.getuid?.() || (stat.mode&0o077)!==0 || stat.size>8192)throw new Error("Private owner-only staff file required");
    token=readFileSync(fd,"utf8").trim();
  } finally { closeSync(fd); }
  if(!/^[A-Za-z0-9_.-]{16,8192}$/.test(token))throw new Error("Invalid staff session file");
  const endpoint=new URL(`/platform/admin/merchants/${encodeURIComponent(merchantId)}/partner-integrations`,base);
  if(isStatus)for(const [key,value] of Object.entries(command))endpoint.searchParams.set(key,String(value));
  const response=await fetch(endpoint,{
    method:isStatus ? "GET" : "POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:isStatus ? undefined : JSON.stringify(command),
    signal:AbortSignal.timeout(10000),redirect:"error",
  });
  const body=JSON.parse(await readBoundedResponse(response,131072)) as {data?:Record<string,unknown>;error?:{code?:string}};
  if(!response.ok){console.error(JSON.stringify({status:response.status,error_code:body.error?.code??"control_request_failed"}));process.exitCode=1;return;}
  if(revealsKey){
    const key=body.data?.revealed_key;
    if(typeof key!=="string"||!/^snus_mcp_(test|live)_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(key))throw new Error("Missing committed key response");
    writeFileSync(secretFd!,`${key}\n`,{encoding:"utf8"});fsyncSync(secretFd!);
  }
  // Allowlist even successful output, so a future control route cannot expose
  // credential data through this operator's terminal history by accident.
  const keys=["integration_id","partner_id","assortment_id","store_id","client_id","key_id","prior_key_id","expires_at","scopes","version","operation_id","oauth_client_id","issuer","status","writes_enabled","policy_version","mcp_catalog_mode","request_id"];
  const pick=(row: Record<string,unknown>,fields: string[])=>Object.fromEntries(fields.filter((key)=>key in row).map((key)=>[key,row[key]]));
  const output=pick(body.data??{},[...keys,"environment","grant_version"]);
  if(isStatus && body.data) {
    for(const [name,fields] of Object.entries({clients:["client_id","oauth_client_id","status","retire_at"],
      keys:["key_id","label","scopes","status","version","expires_at","created_at","revoked_at"],
      grants:["store_id","status","scopes","assortment_id","mcp_catalog_mode","version"],
      operations:["operation_id","kind","status","client_id","oauth_client_id","attempts","next_attempt_at"]})) {
      const rows=body.data[name];
      if(Array.isArray(rows))output[name]=rows.slice(0,50).map((row)=>pick(row,fields));
    }
    if(body.data.next && typeof body.data.next==="object")output.next=pick(body.data.next as Record<string,unknown>,["clients_after","grants_after","operations_after","keys_after"]);
  }
  console.log(JSON.stringify(output,null,2));
  } finally {if(secretFd!==undefined)closeSync(secretFd);}
}
void main().catch(()=>{console.error("Partner control command failed; verify input, staff session file and endpoint configuration. No secret logged.");process.exitCode=1;});
