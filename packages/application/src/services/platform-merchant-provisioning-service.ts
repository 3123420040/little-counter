import { createPlatformMerchantSchema, permissions, type CreatedPlatformMerchant } from "@medusa-snus/contracts";
import { withScopedIdempotency } from "../db/idempotency";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedTransaction } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import { headerValue, type HeadersLike } from "../http/headers";
import { recordAuditEntry } from "../repositories/audit-repository";
import { id } from "../utils/id";
import { requireActivePlatformMembership } from "./access-service";
import { assertNotReadOnlyImpersonation, requireScopedActorPermission, type PermissionActor } from "./permission-service";
import { getMerchantSubscriptionStatus } from "./subscription-service";

export async function createPlatformMerchant(rawInput: unknown, actor: PermissionActor, headers: HeadersLike) {
  await assertNotReadOnlyImpersonation(actor);
  await requireActivePlatformMembership(actor);
  await requireScopedActorPermission(actor, permissions.platformWrite, { scopeType: "platform" });
  const parsed = createPlatformMerchantSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new PlatformError("validation_error", "Thông tin merchant không hợp lệ.", 400, {
      field: String(parsed.error.issues[0]?.path[0] || "merchant"),
    });
  }
  const input = parsed.data;
  await ensurePlatformSchema();

  return withConnectedTransaction(async (client) => {
    const tenantId = `platform:${actor.operatorId}`;
    const operation = "platform-merchant-create";
    const result = await withScopedIdempotency(client, headers, input, tenantId,
      operation, async (): Promise<CreatedPlatformMerchant> => {
        const owner = await client.query(`
          SELECT operator_id FROM medusa.staff_users
          WHERE operator_id=$1 AND is_active=true FOR SHARE
        `, [input.ownerOperatorId]);
        if (!owner.rows[0]) throw new PlatformError("owner_not_available", "Owner không tồn tại hoặc đã ngừng hoạt động.", 409);
        const security = await client.query<{
          global_status: string; temporary_password_hash: string | null;
          temporary_password_expires_at: Date | null;
        }>(`SELECT global_status,temporary_password_hash,temporary_password_expires_at
            FROM app.operator_security_state WHERE operator_id=$1 FOR SHARE`, [input.ownerOperatorId]);
        const state = security.rows[0];
        if (state && (state.global_status !== "active" || (state.temporary_password_hash
          && (!state.temporary_password_expires_at || state.temporary_password_expires_at.getTime() <= Date.now())))) {
          throw new PlatformError("owner_not_available", "Tài khoản owner đang bị khóa hoặc mật khẩu tạm đã hết hạn.", 409);
        }

        const merchantId = id("merchant");
        const organizationId = id("org");
        const storeId = id("store");
        const stockLocationId = id("sloc");
        await client.query(`INSERT INTO app.merchants (id,display_name,legacy_organization_id,status)
          VALUES ($1,$2,$3,'active')`, [merchantId,input.displayName,organizationId]);
        await client.query("INSERT INTO public.stock_location (id,name) VALUES ($1,$2)", [stockLocationId,input.storeName]);
        await client.query(`INSERT INTO app.stores (id,merchant_id,display_name,stock_location_id,is_primary,status,metadata)
          VALUES ($1,$2,$3,$4,true,'active',jsonb_build_object('ownerSettings',jsonb_build_object('timezone',$5::text)))`,
        [storeId,merchantId,input.storeName,stockLocationId,input.timezone]);
        await client.query(`INSERT INTO app.operator_memberships
          (operator_id,scope_type,merchant_id,role_key,status,granted_by)
          VALUES ($1,'merchant',$2,'owner','active',$3)`, [input.ownerOperatorId,merchantId,actor.operatorId]);
        await client.query(`INSERT INTO ai_module.loyalty_tiers
          (name,points_threshold,discount_percent,description,merchant_id) VALUES
          ('bronze',0,0,'Mặc định cho khách hàng mới',$1),
          ('silver',100,2,'Tích lũy 100 điểm',$1),
          ('gold',500,5,'Tích lũy 500 điểm',$1),
          ('platinum',1000,10,'Tích lũy 1000 điểm',$1)`, [merchantId]);
        await getMerchantSubscriptionStatus(merchantId, { client });
        const data: CreatedPlatformMerchant = {
          merchantId, storeId, stockLocationId, ...input, packageKey: "basic",
        };
        await recordAuditEntry(client, { ...actor, organizationId }, "platform.merchant.created", "merchant", merchantId, {
          merchantId, storeId, after: data,
        });
        return data;
      });
    // A delayed retry must never create a second tenant after generic cache expiry.
    await client.query(`UPDATE app.idempotency_records SET expires_at='infinity'
      WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3`,
    [tenantId,operation,headerValue(headers,"idempotency-key")]);
    return { data: result.response, statusCode: result.statusCode };
  });
}
