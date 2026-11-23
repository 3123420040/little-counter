import type { PoolClient } from "pg";
import type { PartnerControlInput, PartnerEnvironment } from "@medusa-snus/contracts/partner-api";
import { PlatformError } from "../errors/platform-error";
import { generatePartnerMcpKey } from "./mcp-key";

export type McpKeyCommand = Extract<PartnerControlInput,{action:"create_mcp_key"|"rotate_mcp_key"|"revoke_mcp_key"|"set_mcp_key_scopes"}>;
function finiteSetting(value: string | undefined, fallback: number, max: number, min: number) {
  const parsed=value===undefined?fallback:Number(value);
  if(!Number.isInteger(parsed)||parsed<min||parsed>max)throw new PlatformError("dependency_unavailable","Invalid key lifecycle policy",503);
  return parsed;
}

/** Internal port: staff permission and integration FOR UPDATE are held by
 * executePartnerControlForClient. Return safe audit detail separately from
 * the secret; the outer transaction must COMMIT before exposing revealedKey. */
export async function mutatePartnerMcpKey(db: PoolClient, command: McpKeyCommand, environment: PartnerEnvironment,
  actorId: string, integrationStatus: string) {
  const fail=():never=>{throw new PlatformError("resource_not_found","Resource not found",404);};
  let label: string, scopes: readonly string[];
  if(command.action==="create_mcp_key") {
    const row=(await db.query(`SELECT p.display_name FROM integration.partners p
      JOIN integration.integrations i ON i.partner_id=p.id WHERE i.id=$1`,[command.integration_id])).rows[0];
    label=command.label??row?.display_name??"Partner"; scopes=command.scopes;
  } else {
    const row=(await db.query(`SELECT id,label,scopes,status,expires_at>clock_timestamp() AS valid
      FROM integration.partner_mcp_keys WHERE integration_id=$1 AND id=$2 FOR UPDATE`,
    [command.integration_id,command.key_id])).rows[0];
    if(!row)fail();
    if(command.action==="revoke_mcp_key") {
      if(row.status!=="revoked")await db.query(`UPDATE integration.partner_mcp_keys
        SET status='revoked',revoked_at=clock_timestamp(),revoked_by=$3 WHERE integration_id=$1 AND id=$2`,
      [command.integration_id,command.key_id,actorId]);
      return {audit:{key_id:command.key_id,status:"revoked"},revealedKey:undefined};
    }
    if(row.status!=="active"||!row.valid)fail();
    if(command.action==="set_mcp_key_scopes") {
      const changed=(await db.query(`UPDATE integration.partner_mcp_keys SET scopes=$3
        WHERE integration_id=$1 AND id=$2 RETURNING version`,[command.integration_id,command.key_id,command.scopes])).rows[0];
      return {audit:{key_id:command.key_id,prior_scopes:row.scopes,scopes:command.scopes,version:changed.version},revealedKey:undefined};
    }
    label=row.label;scopes=row.scopes;
    const overlap=finiteSetting(process.env.PARTNER_MCP_ROTATION_OVERLAP_HOURS,24,24,0);
    await db.query(`UPDATE integration.partner_mcp_keys SET expires_at=LEAST(expires_at,clock_timestamp()+$3*interval '1 hour')
      WHERE integration_id=$1 AND id=$2`,[command.integration_id,command.key_id,overlap]);
  }
  if(integrationStatus==="revoked")throw new PlatformError("integration_disabled","Integration disabled",403);
  const ttl=finiteSetting(process.env.PARTNER_MCP_KEY_TTL_DAYS,90,365,1);
  const generated=generatePartnerMcpKey(environment);
  const row=(await db.query(`INSERT INTO integration.partner_mcp_keys(id,integration_id,label,secret_hash,scopes,created_by,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 day') RETURNING expires_at::text`,
  [generated.keyId,command.integration_id,label,generated.secretHash,scopes,actorId,ttl])).rows[0];
  return {audit:{key_id:generated.keyId,label,scopes,status:"active",expires_at:row.expires_at,
    prior_key_id:command.action==="rotate_mcp_key"?command.key_id:null},revealedKey:generated.key};
}
