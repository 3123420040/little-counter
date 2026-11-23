import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { z } from "zod";
import openapi from "./openapi.json";

// This OpenAPI document is canonical. Release-pack copies are checked byte for
// byte, and runtime validation compiles its schemas without stripping inputs.
export { openapi as partnerOpenApi };
export const partnerScopes = [
  "partner:read", "catalog:read", "inventory:read",
  "orders:quote", "orders:write", "orders:read",
] as const;
export type PartnerScope = typeof partnerScopes[number];
export type PartnerEnvironment = "sandbox" | "production";
export interface PartnerQuoteRequest {
  store_id: string;
  items: Array<{ variant_id: string; quantity: number }>;
  fulfillment_mode: "pickup" | "delivery";
}
export type PartnerFulfillment = { mode: "pickup" } | {
  mode: "delivery"; recipient_name: string; phone: string; address: string;
};
export interface PartnerOrderRequest {
  store_id: string;
  quote_id: string;
  external_order_id: string;
  payment_method: "cod";
  fulfillment: PartnerFulfillment;
}
export interface PartnerQuote {
  quote_id: string; store_id: string; currency: "VND";
  items: Array<{ variant_id: string; quantity: number; unit_price: number; line_total: number }>;
  subtotal: number; shipping_fee: number; total: number;
  fulfillment_mode: "pickup" | "delivery";
  pricing_version: string; policy_version: number;
  expires_at: string; stock_reserved: false;
}
export interface PartnerOrder {
  order_id: string; external_order_id: string; store_id: string;
  booking_status: "confirmed" | "cancelled";
  collection_status: "unconfirmed" | "confirmed";
  payment_method: "cod"; currency: "VND"; total: number;
  stock_deducted: true; created_at: string; updated_at: string;
}
export type PartnerInventoryItem = {
  variant_id: string; store_id: string; as_of: string;
} & ({ availability_status: "unavailable"; available_quantity: null }
  | { availability_status: "available" | "out_of_stock"; available_quantity: number });
export interface PartnerProduct { variant_id: string; sku: string; title: string }
export type PartnerCatalogMode = "explicit" | "merchant_published";
export interface PartnerCatalogSummary {
  store_id: string; as_of: string; catalog_mode: PartnerCatalogMode;
  catalog_scope: "eligible_published_variants"; inventory_complete: boolean;
  quantity_basis: "per_variant"; has_shared_inventory_items: boolean;
  product_count: number; sku_count: number; available_sku_count: number;
  out_of_stock_sku_count: number; unavailable_sku_count: number;
  available_quantity_sum: number | null;
}
export interface PartnerMeta { request_id: string; original_request_id?: string }
export interface PartnerPage { next_cursor: string | null; as_of: string }

const ajv = new Ajv2020({ strict: false, allErrors: false, coerceTypes: false });
addFormats(ajv);
ajv.addSchema({ $id: "urn:snus:partner:v1", components: openapi.components });
const validators = Object.fromEntries(Object.keys(openapi.components.schemas).map((name) => [
  name, ajv.compile({ $ref: `urn:snus:partner:v1#/components/schemas/${name}` }),
]));
// MCP has an explicit identity DTO; REST's required OAuth client_id remains a
// string. Reuse every business field and change only the credential profile.
export const partnerMcpContextSchema = {
  type:"object",required:["data","meta"],properties:{
    data:{...openapi.components.schemas.Integration,
      required:[...openapi.components.schemas.Integration.required,"auth_method","key_id"],
      properties:{...openapi.components.schemas.Integration.properties,client_id:{type:"null"},
        auth_method:{const:"mcp_key"},key_id:{type:"string",pattern:"^[a-f0-9]{32}$"}}},
    meta:{$ref:"urn:snus:partner:v1#/components/schemas/Meta"},
  },
};
const mcpContextValidator=ajv.compile({...partnerMcpContextSchema,components:openapi.components});
export function isPartnerMcpContext(value:unknown):boolean {return mcpContextValidator(value)===true;}
export type PartnerSchemaName = keyof typeof openapi.components.schemas;
export function isPartnerSchema(name: PartnerSchemaName, value: unknown): boolean {
  return validators[name](value) === true;
}

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const limit = z.string().regex(/^[0-9]+$/).transform(Number).pipe(z.number().int().min(1).max(100));
const page = {
  store_id: identifier,
  limit: limit.optional().default(20),
  cursor: z.string().min(1).max(2048).optional(),
};
export const PartnerMeQuery = z.strictObject({});
export const PartnerProductQuery = z.strictObject(page);
export const PartnerCatalogSummaryQuery = z.strictObject({ store_id: identifier });
export const PartnerInventoryQuery = z.strictObject({
  ...page,
  variant_ids: z.string().transform((value) => value.split(","))
    .pipe(z.array(identifier).min(1).max(50))
    .refine((values) => new Set(values).size === values.length).optional(),
});
export const PartnerOrderDetailQuery = z.strictObject({ store_id: identifier });
export const PartnerOrderQuery = z.strictObject({
  ...page,
  external_order_id: z.string().min(1).max(128).optional(),
  date_from: z.iso.datetime({ offset: true }).optional(),
  date_to: z.iso.datetime({ offset: true }).optional(),
}).superRefine((value, ctx) => {
  const badCombination = value.external_order_id !== undefined
    && (value.date_from !== undefined || value.date_to !== undefined || value.cursor !== undefined);
  const partialRange = (value.date_from === undefined) !== (value.date_to === undefined);
  const duration = value.date_from && value.date_to
    ? Date.parse(value.date_to) - Date.parse(value.date_from) : undefined;
  if (badCombination || partialRange || (duration !== undefined && (duration <= 0 || duration > 31 * 86_400_000))) {
    ctx.addIssue({ code: "custom", message: "Invalid order filter combination or date range" });
  }
});

export function normalizePartnerQuote(input: PartnerQuoteRequest): PartnerQuoteRequest {
  const quantities = new Map<string, number>();
  for (const line of input.items) {
    const quantity = (quantities.get(line.variant_id) ?? 0) + line.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
      throw new Error("Quantity after aggregation must be between 1 and 100");
    }
    quantities.set(line.variant_id, quantity);
  }
  return { ...input, items: [...quantities].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([variant_id, quantity]) => ({ variant_id, quantity })) };
}

export { PartnerControlCommand, PartnerControlPolicy, PartnerControlStatusQuery } from "./control";
export type { PartnerControlInput, PartnerControlPolicyInput } from "./control";
export { partnerMcpTools } from "./mcp";
