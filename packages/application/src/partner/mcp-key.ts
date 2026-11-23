import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import type { PartnerEnvironment, PartnerScope } from "@medusa-snus/contracts/partner-api";
import { PartnerError } from "./errors";

const keyPattern = /^Bearer snus_mcp_(test|live)_([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/;
const dummyDigest = Buffer.alloc(32);
const digest = (key: string) => createHash("sha256").update(key, "utf8").digest();

/** Returned secret is for the control plane's post-COMMIT, show-once channel.
 * Callers must persist only secretHash; never serialize this object to logs. */
export function generatePartnerMcpKey(environment: PartnerEnvironment) {
  const keyId = randomBytes(16).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const key = `snus_mcp_${environment === "production" ? "live" : "test"}_${keyId}.${secret}`;
  return { keyId, key, secretHash: digest(key).toString("hex") };
}

export interface VerifiedPartnerMcpKey {
  readonly authMethod: "mcp_key";
  readonly credentialId: string;
  readonly keyId: string;
  readonly clientId: null;
  readonly integrationId: string;
  readonly scopes: readonly PartnerScope[];
  readonly version: number;
}

/** Primary DB, query-only. Re-run after mutation authorization locks: expiry is
 * evaluated with the DB wall clock, including time spent waiting for a lock. */
export async function verifyPartnerMcpKey(db: Pick<PoolClient, "query">, authorization: unknown,
  environment: PartnerEnvironment): Promise<VerifiedPartnerMcpKey> {
  const match = typeof authorization === "string" && authorization.length <= 128
    ? keyPattern.exec(authorization) : null;
  if (!match || Buffer.from(match[3], "base64url").toString("base64url") !== match[3]) {
    throw new PartnerError("invalid_token");
  }
  try {
    const result = await db.query(`SELECT k.id,k.integration_id,k.secret_hash,k.scopes,k.version,
      k.status='active' AND k.expires_at>clock_timestamp() AS valid,i.environment
      FROM integration.partner_mcp_keys k JOIN integration.integrations i ON i.id=k.integration_id
      WHERE k.id=$1`, [match[2]]);
    const row = result.rows[0];
    const expected = row ? Buffer.from(row.secret_hash, "hex") : dummyDigest;
    const correct = timingSafeEqual(digest((authorization as string).slice(7)), expected);
    if (!row || !correct || !row.valid || row.environment !== environment
      || match[1] !== (environment === "production" ? "live" : "test")) throw new PartnerError("invalid_token");
    return Object.freeze({ authMethod: "mcp_key", credentialId: row.id, keyId: row.id, clientId: null,
      integrationId: row.integration_id, scopes: Object.freeze([...row.scopes]), version: row.version });
  } catch (error) {
    if (error instanceof PartnerError) throw error;
    throw new PartnerError("dependency_unavailable");
  }
}
