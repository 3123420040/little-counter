import { createHash } from "node:crypto";
import { Pool,type PoolClient } from "pg";
import { partnerDatabaseTimeouts, withPartnerTransaction } from "./transaction";
import { z } from "zod";
import { permissions,type MerchantTargetScope } from "@medusa-snus/contracts";
import { requireScopedActorPermission,type PermissionActor } from "../services/permission-service";
import { recordAuditEntry } from "../repositories/audit-repository";
import { PlatformError } from "../errors/platform-error";

const fail=(code:string,status:number):never=>{throw new PlatformError(code,code.replaceAll("_"," "),status);};
const input=z.object({integration_id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  from:z.iso.datetime(),to:z.iso.datetime(),after_id:z.uuid().optional(),limit:z.number().int().min(1).max(200).default(100)})
  .strict().refine(q=>Date.parse(q.to)>Date.parse(q.from)&&Date.parse(q.to)-Date.parse(q.from)<=31*86400000);
const owned=`e.merchant_id=$1 AND e.action LIKE 'partner.%' AND
  (e.integration_id=$2 OR (e.subject_type='partner_integration' AND e.subject_id=$2)
   OR (e.subject_type='partner_order' AND EXISTS(SELECT 1 FROM integration.partner_orders p
      WHERE p.id=e.subject_id AND p.integration_id=$2 AND p.merchant_id=$1)))`;

/** Caller must COMMIT the export audit before releasing this safe projection.
 * A checksum proves exact downloaded bytes, not immunity to a privileged DBA. */
export async function exportPartnerAuditForClient(db:PoolClient,actor:PermissionActor,scope:MerchantTargetScope,
  raw:unknown,environment:"sandbox"|"production",requestId:string){
  if("channel" in actor)fail("forbidden",403);
  await requireScopedActorPermission(actor,permissions.accountingRead,{scopeType:"merchant",merchantId:scope.merchantId});
  const parsed=input.safeParse(raw);if(!parsed.success)fail("invalid_request",400);const q=parsed.data!;
  const integration=(await db.query(`SELECT i.id,m.legacy_organization_id FROM integration.integrations i
    JOIN app.merchants m ON m.id=i.merchant_id WHERE i.id=$1 AND i.merchant_id=$2 AND i.environment=$3`,
  [q.integration_id,scope.merchantId,environment])).rows[0];
  // Revoked integrations remain readable by authorized staff for investigations.
  if(!integration)fail("resource_not_found",404);
  const params=[scope.merchantId,q.integration_id,q.from,q.to,q.after_id??null,q.limit+1];
  if(q.after_id){
    const cursor=await db.query(`SELECT e.id FROM audit.events e WHERE ${owned}
      AND e.created_at>=$3 AND e.created_at<$4 AND e.id=$5::uuid`,params.slice(0,5));
    if(!cursor.rowCount)fail("invalid_cursor",400);
  }
  const result=await db.query(`SELECT e.id::text,e.created_at::text,e.merchant_id,e.store_id,e.actor_type,e.actor_id,
    e.action,e.subject_type,e.subject_id,e.correlation_id,e.request_id,e.partner_id,e.integration_id,
    e.client_id,e.key_id,e.auth_method,e.credential_id,e.grant_version,e.trace_id,e.origin_request_id
    FROM audit.events e WHERE ${owned} AND e.created_at>=$3 AND e.created_at<$4
    AND ($5::uuid IS NULL OR (e.created_at,e.id)>(SELECT a.created_at,a.id FROM audit.events a WHERE a.id=$5::uuid))
    ORDER BY e.created_at,e.id LIMIT $6`,params);
  const rows=result.rows.slice(0,q.limit),next=result.rows.length>q.limit?rows.at(-1)!.id:null;
  const content=JSON.stringify({schema_version:1,merchant_id:scope.merchantId,integration_id:q.integration_id,
    environment,from:q.from,to:q.to,after_id:q.after_id??null,rows,next_after_id:next});
  if(Buffer.byteLength(content)>262144)fail("export_page_too_large",422);
  const checksum=createHash("sha256").update(content,"utf8").digest("hex");
  const receipt=await recordAuditEntry(db,{...actor,organizationId:integration.legacy_organization_id,requestId},
    "partner.audit_export","partner_integration",q.integration_id,{merchantId:scope.merchantId,correlationId:requestId,
      after:{sha256:checksum,row_count:rows.length,from:q.from,to:q.to,after_id:q.after_id??null,next_after_id:next}});
  return {data:{content,sha256:checksum,row_count:rows.length,next_after_id:next},meta:{request_id:requestId,audit_id:receipt.id}};
}

let pool:Pool|undefined,inflight=0;
export async function exportPartnerAudit(actor:PermissionActor,scope:MerchantTargetScope,raw:unknown,requestId:string){
  const environment=process.env.PARTNER_ENVIRONMENT,url=process.env.PARTNER_AUDIT_DATABASE_URL;
  if(!url||(environment!=="sandbox"&&environment!=="production")||inflight>=2)fail("dependency_unavailable",503);
  if(!pool){pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:1000,...partnerDatabaseTimeouts});pool.on("error",()=>undefined);}
  inflight++;
  try{
    return await withPartnerTransaction(pool,async db=>{
      const role=await db.query(`SELECT NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)
        AND pg_has_role(current_user,'snus_partner_audit','MEMBER') AS allowed FROM pg_roles WHERE rolname=current_user`);
      if(role.rows[0]?.allowed!==true)fail("dependency_unavailable",503);
      return exportPartnerAuditForClient(db,actor,scope,raw,environment as "sandbox"|"production",requestId);
    },{begin:"BEGIN ISOLATION LEVEL REPEATABLE READ"});
  }catch(error){
    if(error instanceof PlatformError)throw error;return fail("dependency_unavailable",503);
  }finally{inflight--;}
}
