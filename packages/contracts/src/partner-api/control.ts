import { z } from "zod";

// Internal staff control contract, intentionally absent from public OpenAPI.
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const PartnerControlStatusQuery = z.strictObject({
  integration_id: identifier,
  clients_after: identifier.optional(),
  grants_after: identifier.optional(),
  operations_after: identifier.optional(),
  keys_after: z.string().regex(/^[a-f0-9]{32}$/).optional(),
});
const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PartnerControlReasonSchema = z.enum(["onboarding", "commercial_policy", "security_incident", "credential_rotation", "operator_request"]);
const reason = PartnerControlReasonSchema;
const scopes = z.array(z.enum(["partner:read", "catalog:read", "inventory:read", "orders:quote", "orders:write", "orders:read"]))
  .min(1).max(6).refine((v) => new Set(v).size === v.length);
export const PartnerControlPolicy = z.strictObject({
  currency: z.literal("VND"), max_order_total: money.refine((v) => v > 0), max_quantity: z.number().int().min(1).max(100),
  safety_stock: z.number().int().min(0).max(2147483647), delivery_fee: money.nullable(),
  contact_retention_days: z.number().int().min(1).max(365),
  read_per_minute: z.number().int().min(1).max(120000), read_burst: z.number().int().min(1).max(10000),
  quote_per_minute: z.number().int().min(1).max(30000), quote_burst: z.number().int().min(1).max(1000),
  book_per_minute: z.number().int().min(1).max(10000), book_burst: z.number().int().min(1).max(1000),
  mutation_concurrency: z.number().int().min(1).max(100),
});
export const PartnerControlCommand = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create"), installation_key: identifier,
    partner_name: z.string().trim().min(1).max(120), environment: z.enum(["sandbox", "production"]),
    policy: PartnerControlPolicy, reason }),
  z.strictObject({ action: z.literal("set_policy"), integration_id: identifier, policy: PartnerControlPolicy, reason }),
  z.strictObject({ action: z.literal("set_assortment"), integration_id: identifier, assortment_id: identifier.optional(),
    new_assortment_id: identifier.optional(),
    variant_ids: z.array(identifier).max(500).refine((v) => new Set(v).size === v.length), status: z.enum(["active", "inactive"]), reason })
    .refine(value => !(value.assortment_id && value.new_assortment_id), "Choose an existing or new assortment identity"),
  z.strictObject({ action: z.literal("set_grant"), integration_id: identifier, store_id: identifier, assortment_id: identifier,
    scopes, status: z.enum(["active", "inactive", "revoked"]), reason }),
  z.strictObject({ action: z.literal("set_mcp_catalog_mode"), integration_id: identifier, store_id: identifier,
    mcp_catalog_mode: z.enum(["explicit", "merchant_published"]), reason }),
  z.strictObject({ action: z.literal("set_status"), integration_id: identifier,
    status: z.enum(["active", "paused", "revoked"]), writes_enabled: z.boolean(),
    conformance_receipt_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), reason }),
  z.strictObject({ action: z.literal("provision_client"), integration_id: identifier,
    auth_method: z.enum(["private_key_jwt", "client_secret_basic"]),
    credential_reference: identifier, reason }),
  z.strictObject({ action: z.literal("rotate_client"), integration_id: identifier, client_id: identifier,
    auth_method: z.enum(["private_key_jwt", "client_secret_basic"]), credential_reference: identifier,
    overlap_seconds: z.number().int().min(0).max(86400), reason }),
  z.strictObject({ action: z.literal("revoke_client"), integration_id: identifier, client_id: identifier, reason }),
  z.strictObject({ action: z.literal("create_mcp_key"), integration_id: identifier,
    label: z.string().trim().min(1).max(128).optional(),
    scopes: scopes.default(["partner:read","catalog:read","inventory:read","orders:read"]), reason }),
  z.strictObject({ action: z.literal("rotate_mcp_key"), integration_id: identifier,
    key_id: z.string().regex(/^[a-f0-9]{32}$/), reason }),
  z.strictObject({ action: z.literal("revoke_mcp_key"), integration_id: identifier,
    key_id: z.string().regex(/^[a-f0-9]{32}$/), reason }),
  z.strictObject({ action: z.literal("set_mcp_key_scopes"), integration_id: identifier,
    key_id: z.string().regex(/^[a-f0-9]{32}$/), scopes, reason }),
]);
export type PartnerControlInput = z.infer<typeof PartnerControlCommand>;
export type PartnerControlPolicyInput = z.infer<typeof PartnerControlPolicy>;
