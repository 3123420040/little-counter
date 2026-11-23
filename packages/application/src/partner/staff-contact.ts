import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { partnerDatabaseTimeouts, withPartnerTransaction } from "./transaction";
import { permissions, type OperatingScope } from "@medusa-snus/contracts";
import { requireScopedActorPermission, type PermissionActor } from "../services/permission-service";
import { recordAuditEntry } from "../repositories/audit-repository";
import { PlatformError } from "../errors/platform-error";
import { decryptPartnerContact, partnerContactKeyringSchema, type PartnerContactKeyring } from "./contact-crypto";

const fail = (code: string, status: number): never => { throw new PlatformError(code, code.replaceAll("_", " "), status); };
/** Scoped staff access only; audit must commit before plaintext reaches HTTP. */
export async function readPartnerStaffContactForClient(db: PoolClient, actor: PermissionActor, scope: OperatingScope,
  coreOrderId: string, keys: PartnerContactKeyring, requestId: string) {
  if ("channel" in actor) fail("forbidden", 403);
  await requireScopedActorPermission(actor, permissions.partnerContactRead,
    { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
  const order = (await db.query(`SELECT o.id,m.legacy_organization_id FROM integration.partner_orders o
    JOIN app.merchants m ON m.id=o.merchant_id WHERE o.core_order_id=$1 AND o.merchant_id=$2 AND o.store_id=$3`,
  [coreOrderId, scope.merchantId, scope.storeId])).rows[0];
  if (!order) fail("resource_not_found", 404);
  const contact = (await db.query(`SELECT key_version,ciphertext,nonce,auth_tag,retention_until FROM integration.order_contacts
    WHERE partner_order_id=$1 AND retention_until>statement_timestamp()`, [order.id])).rows[0];
  if (!contact) fail("partner_contact_unavailable", 404);
  const value = decryptPartnerContact(keys, { merchantId: scope.merchantId, storeId: scope.storeId, orderId: order.id }, contact);
  await recordAuditEntry(db, { ...actor, organizationId: order.legacy_organization_id, requestId },
    "partner.contact_read", "partner_order", order.id, { merchantId: scope.merchantId, storeId: scope.storeId,
      after: { purpose: "order_fulfillment" }, correlationId: requestId });
  return { data: { ...value, retention_until: new Date(contact.retention_until).toISOString() }, meta: { request_id: requestId } };
}

let pool: Pool | undefined;
let inflight = 0;
export async function readPartnerStaffContact(actor: PermissionActor, scope: OperatingScope, coreOrderId: string, requestId: string) {
  if (!process.env.PARTNER_CONTACT_DATABASE_URL || !process.env.PARTNER_CONTACT_KEYS_FILE) fail("dependency_unavailable", 503);
  let keys: PartnerContactKeyring;
  try { keys = partnerContactKeyringSchema.parse(JSON.parse(readFileSync(process.env.PARTNER_CONTACT_KEYS_FILE!, "utf8"))); }
  catch { return fail("dependency_unavailable", 503); }
  if (!pool) {
    pool = new Pool({ connectionString: process.env.PARTNER_CONTACT_DATABASE_URL, max: 2,
      connectionTimeoutMillis: 1000, ...partnerDatabaseTimeouts });
    pool.on("error", () => undefined);
  }
  if (inflight >= 2) fail("dependency_unavailable", 503);
  inflight++;
  try {
    return await withPartnerTransaction(pool, async db => {
      const role = await db.query(`SELECT NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)
        AND pg_has_role(current_user,'snus_partner_contacts','MEMBER') AS allowed FROM pg_roles WHERE rolname=current_user`);
      if (!role.rows[0]?.allowed) fail("dependency_unavailable", 503);
      return readPartnerStaffContactForClient(db, actor, scope, coreOrderId, keys, requestId);
    });
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    return fail("dependency_unavailable", 503);
  } finally { inflight--; }
}
