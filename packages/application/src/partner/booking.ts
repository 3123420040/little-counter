import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { isPartnerSchema, type PartnerCatalogMode, type PartnerOrder, type PartnerOrderRequest, type PartnerQuote, type PartnerQuoteRequest } from "@medusa-snus/contracts/partner-api";
import { createOrderForClient } from "../services/order-service";
import { PlatformError } from "../errors/platform-error";
import { recordAuditEntry } from "../repositories/audit-repository";
import { canonicalPartnerJson, partnerFingerprint, type PartnerKeyring } from "./fingerprints";
import { pricePartnerItems } from "./quotes";
import type { PartnerContext } from "./registry";
import { PartnerError } from "./errors";
import { encryptPartnerContact, type PartnerContactKeyring } from "./contact-crypto";

const operation = "v1:POST:/partner/v1/orders";
interface StoredQuote {
  quote: PartnerQuote; request: PartnerQuoteRequest; fingerprintVersion: string;
  assortmentVersion: number; catalogMode?: PartnerCatalogMode;
}
/** A bounded, transaction-scoped lock independent of rotating HMAC keys. Only
 * a SHA-256 digest reaches PostgreSQL lock diagnostics, never an external ID
 * or idempotency key. HMAC remains the stored lookup/request fingerprint. */
async function namespaceLock(db: PoolClient, values: string[]) {
  const digest = createHash("sha256").update(canonicalPartnerJson(values)).digest("hex");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [digest]);
}
function requestHash(keys: PartnerKeyring, request: PartnerOrderRequest, version: string) {
  return partnerFingerprint(keys, request, version);
}

/** Caller owns READ COMMITTED transaction and rechecked authorization locks.
 * No connection, COMMIT, external I/O or retry is performed by this port. */
export async function bookPartnerOrderForClient(db: PoolClient, ctx: PartnerContext, keys: PartnerKeyring,
  request: PartnerOrderRequest, idempotencyKey: unknown, contactKeys?: PartnerContactKeyring) {
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) throw new PartnerError("idempotency_key_required");
  if (request?.payment_method && request.payment_method !== "cod") throw new PartnerError("unsupported_payment_method");
  if (!isPartnerSchema("OrderRequest", request)) throw new PartnerError("invalid_request");
  if (!ctx.scopes.includes("orders:write")) throw new PartnerError("insufficient_scope");
  if (ctx.writesDenialCode) throw new PartnerError(ctx.writesDenialCode);
  if (request.store_id !== ctx.storeId) throw new PartnerError("store_not_allowed");
  await namespaceLock(db, [ctx.integrationId,ctx.storeId,operation,idempotencyKey]);
  const versions = Object.keys(keys.keys).sort();
  const fingerprints = versions.map(version => partnerFingerprint(keys, idempotencyKey, version));
  const existing = (await db.query(`SELECT r.*,r.expires_at<=clock_timestamp() AS expired FROM integration.idempotency_records r
    JOIN unnest($4::text[],$5::text[]) AS k(version,fingerprint) ON k.version=r.fingerprint_version AND k.fingerprint=r.key_fingerprint
    WHERE r.integration_id=$1 AND r.store_id=$2 AND r.operation=$3`, [ctx.integrationId,ctx.storeId,operation,versions,fingerprints])).rows;
  if (existing.length > 1) throw new PartnerError("dependency_unavailable");
  if (existing[0]) {
    const row = existing[0];
    if (row.request_hash !== requestHash(keys, request, row.fingerprint_version)) throw new PartnerError("idempotency_conflict");
    if (row.state === "tombstone" || row.expired) throw new PartnerError("idempotency_record_expired");
    return { status:200,replayed:true,body:{ data:row.public_response,meta:{request_id:ctx.requestId,original_request_id:row.original_request_id} } };
  }
  await namespaceLock(db, [ctx.integrationId,"external-order",request.external_order_id]);
  const external = (await db.query(`SELECT store_id,request_hash,fingerprint_version,id,initial_response,origin_request_id
    FROM integration.partner_orders WHERE integration_id=$1 AND external_order_id=$2`, [ctx.integrationId,request.external_order_id])).rows[0];
  async function saveReplay(orderId: string, data: PartnerOrder, originalRequestId: string) {
    await db.query(`INSERT INTO integration.idempotency_records(integration_id,store_id,operation,key_fingerprint,fingerprint_version,
      request_hash,state,public_response,response_status,original_request_id,order_id,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'completed',$7::jsonb,201,$8,$9,transaction_timestamp()+interval '30 days')`,
    [ctx.integrationId,ctx.storeId,operation,partnerFingerprint(keys,idempotencyKey),keys.current,requestHash(keys,request,keys.current),
      JSON.stringify(data),originalRequestId,orderId]);
  }
  if (external) {
    if (external.store_id !== ctx.storeId || external.request_hash !== requestHash(keys,request,external.fingerprint_version)) {
      throw new PartnerError("external_order_conflict");
    }
    await saveReplay(external.id,external.initial_response,external.origin_request_id);
    return {status:200,replayed:true,body:{data:external.initial_response,meta:{request_id:ctx.requestId,original_request_id:external.origin_request_id}}};
  }
  if (request.fulfillment.mode === "delivery" && !contactKeys) throw new PartnerError("shipping_policy_unavailable");
  const quote = (await db.query(`SELECT *,expires_at<=clock_timestamp() AS expired FROM integration.quotes
    WHERE id=$1 AND integration_id=$2 AND store_id=$3 AND merchant_id=$4 FOR UPDATE`,
  [request.quote_id,ctx.integrationId,ctx.storeId,ctx.merchantId])).rows[0];
  if (!quote) throw new PartnerError("resource_not_found");
  if (quote.consumed_order_id) throw new PartnerError("quote_consumed");
  if (quote.expired) throw new PartnerError("quote_expired");
  const snapshot = quote.snapshot as StoredQuote;
  if (quote.grant_version !== ctx.grantVersion || quote.store_grant_version !== ctx.storeGrantVersion
    || quote.policy_id !== ctx.policy.id || quote.policy_version !== ctx.policy.version
    || quote.stock_location_id !== ctx.stockLocationId || snapshot.assortmentVersion !== ctx.assortmentVersion
    || (snapshot.catalogMode ?? "explicit") !== ctx.catalogMode
    || snapshot.request.fulfillment_mode !== request.fulfillment.mode) throw new PartnerError("quote_changed");
  await db.query("SELECT integration.lock_commerce_inputs($1,$2::text[])", [ctx.merchantId,snapshot.request.items.map(line=>line.variant_id)]);
  // Lock the physical levels before availability/safety-stock validation. POS,
  // Telegram and staff mutation writers use the same physical item ordering.
  await db.query(`SELECT il.id FROM public.inventory_level il
    JOIN public.product_variant_inventory_item vii ON vii.inventory_item_id=il.inventory_item_id AND vii.deleted_at IS NULL
    WHERE vii.variant_id=ANY($1::text[]) AND il.location_id=$2 AND il.deleted_at IS NULL
    ORDER BY il.inventory_item_id COLLATE "C" FOR UPDATE OF il`, [snapshot.request.items.map(line=>line.variant_id),ctx.stockLocationId]);
  const current = await pricePartnerItems(db,ctx,keys,snapshot.request,snapshot.fingerprintVersion,!!contactKeys);
  if (current.pricingVersion !== quote.pricing_version || current.total !== snapshot.quote.total) throw new PartnerError("quote_changed");
  let core;
  try {
    core = await createOrderForClient(db,{items:current.items.map(line=>({variantId:line.variant_id,quantity:line.quantity})),
      // Persist an established 2.1 remote channel value so an old image can
      // read the order after application rollback. sourceFlow and immutable
      // partner ownership remain the authoritative partner provenance.
      paymentMethod:"cod",amountReceived:0,salesChannel:"website",sourceFlow:"partner_api_v1",shippingFee:current.shippingFee},ctx,
    {merchantId:ctx.merchantId,storeId:ctx.storeId,stockLocationId:ctx.stockLocationId,source:"remote",salesChannelId:"sc_remote",
      orderStatus:"completed",remoteStatus:"confirmed"});
  } catch (error) {
    if (error instanceof PlatformError && error.code === "insufficient_stock") throw new PartnerError("insufficient_stock");
    throw error;
  }
  if (core.data.total !== current.total) throw new PartnerError("quote_changed");
  const orderId = `po_${randomUUID()}`;
  const data: PartnerOrder = {order_id:orderId,external_order_id:request.external_order_id,store_id:ctx.storeId,
    booking_status:"confirmed",collection_status:"unconfirmed",payment_method:"cod",currency:"VND",total:core.data.total,
    stock_deducted:true,created_at:core.data.createdAt,updated_at:core.data.createdAt};
  await db.query(`INSERT INTO integration.partner_orders(id,integration_id,partner_id,merchant_id,store_id,stock_location_id,
    core_order_id,quote_id,external_order_id,request_hash,fingerprint_version,created_by_client_id,origin_request_id,trace_id,initial_response,
    auth_method,created_by_key_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)`, [orderId,ctx.integrationId,ctx.partnerId,ctx.merchantId,ctx.storeId,
    ctx.stockLocationId,core.data.orderId,request.quote_id,request.external_order_id,requestHash(keys,request,keys.current),keys.current,
    ctx.registryClientId,ctx.requestId,ctx.traceId,JSON.stringify(data),ctx.authMethod,ctx.keyId]);
  if (request.fulfillment.mode === "delivery") {
    const encrypted = encryptPartnerContact(contactKeys!, { merchantId: ctx.merchantId, storeId: ctx.storeId, orderId }, request.fulfillment);
    await db.query(`INSERT INTO integration.order_contacts(partner_order_id,key_version,ciphertext,nonce,auth_tag,retention_until)
      VALUES($1,$2,$3,$4,$5,transaction_timestamp()+$6::int*interval '1 day')`,
    [orderId,encrypted.key_version,encrypted.ciphertext,encrypted.nonce,encrypted.auth_tag,ctx.policy.contactRetentionDays]);
  }
  await db.query("UPDATE integration.quotes SET consumed_order_id=$1 WHERE id=$2", [orderId,request.quote_id]);
  await saveReplay(orderId,data,ctx.requestId);
  await recordAuditEntry(db,ctx,"partner.order_booked","partner_order",orderId,
    {merchantId:ctx.merchantId,storeId:ctx.storeId,after:{coreOrderId:core.data.orderId,quoteId:request.quote_id,total:data.total}});
  const body = {data,meta:{request_id:ctx.requestId}};
  if (!isPartnerSchema("OrderResponse",body)) throw new PartnerError("internal_error");
  return {status:201,replayed:false,body};
}
