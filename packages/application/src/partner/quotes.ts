import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { isPartnerSchema, normalizePartnerQuote, type PartnerQuote, type PartnerQuoteRequest } from "@medusa-snus/contracts/partner-api";
import { recordAuditEntry } from "../repositories/audit-repository";
import { calculateOrderTotals, commercialAdjustmentContext } from "../services/order-total-service";
import type { PartnerContext } from "./registry";
import { partnerFingerprint, type PartnerKeyring } from "./fingerprints";
import { PartnerError } from "./errors";
import { partnerCatalogScopeSql } from "./catalog";

/** Caller owns a READ COMMITTED transaction and authorization locks. Commerce
 * parent locks remain held through snapshot persistence/booking commit. Stock
 * is only observed here: neither a quote nor its TTL reserves inventory. */
export async function pricePartnerItems(db: PoolClient, ctx: PartnerContext, keys: PartnerKeyring,
  input: PartnerQuoteRequest, fingerprintVersion = keys.current, deliveryReady = false) {
  if (!isPartnerSchema("QuoteRequest", input)) throw new PartnerError("invalid_request");
  let request: PartnerQuoteRequest;
  try { request = normalizePartnerQuote(input); } catch { throw new PartnerError("invalid_request"); }
  if (request.store_id !== ctx.storeId) throw new PartnerError("store_not_allowed");
  if (ctx.writesDenialCode) throw new PartnerError(ctx.writesDenialCode);
  if (request.items.some(line => line.quantity > ctx.policy.maxQuantity)) throw new PartnerError("invalid_request");
  if (request.fulfillment_mode === "delivery" && (!deliveryReady || ctx.policy.deliveryFee === null)) {
    throw new PartnerError("shipping_policy_unavailable");
  }
  await db.query("SELECT integration.lock_commerce_inputs($1,$2::text[])", [ctx.merchantId, request.items.map(line => line.variant_id)]);
  const reserved = await db.query(`SELECT EXISTS(SELECT 1 FROM public.inventory_level
    WHERE location_id=$1 AND deleted_at IS NULL AND reserved_quantity<>0) AS present`, [ctx.stockLocationId]);
  if (reserved.rows[0].present) throw new PartnerError("unsupported_inventory_model");
  const rows = (await db.query(`
    SELECT v.id AS variant_id,v.manage_inventory,v.allow_backorder,
      components.count AS component_count,components.item_id,components.required_quantity,ii.id AS live_item,
      levels.stocked_quantity,levels.reserved_quantity,
      prices.count AS price_count,prices.amount,prices.price_id,prices.price_set_id,prices.mapping_id,
      prices.updated_at,prices.rules_count,prices.price_list_id,prices.min_quantity,prices.max_quantity,
      prices.live_set,prices.price_merchant
    FROM public.product_variant v
    JOIN public.product p ON p.id=v.product_id AND p.deleted_at IS NULL AND p.status='published' AND p.merchant_id=$2
    LEFT JOIN LATERAL (SELECT count(*) AS count,min(inventory_item_id) AS item_id,min(required_quantity) AS required_quantity
      FROM public.product_variant_inventory_item WHERE variant_id=v.id AND deleted_at IS NULL) components ON true
    LEFT JOIN public.inventory_item ii ON ii.id=components.item_id AND ii.deleted_at IS NULL
    LEFT JOIN public.inventory_level levels ON levels.inventory_item_id=components.item_id AND levels.location_id=$3 AND levels.deleted_at IS NULL
    LEFT JOIN LATERAL (SELECT count(*) AS count,min(pr.amount) AS amount,min(pr.id) AS price_id,
      min(ps.id) AS price_set_id,min(vps.id) AS mapping_id,max(pr.updated_at) AS updated_at,
      max(pr.rules_count) AS rules_count,min(pr.price_list_id) AS price_list_id,
      min(pr.min_quantity) AS min_quantity,min(pr.max_quantity) AS max_quantity,
      bool_and(ps.deleted_at IS NULL) AS live_set,min(ps.merchant_id) AS price_merchant
      FROM public.product_variant_price_set vps JOIN public.price_set ps ON ps.id=vps.price_set_id
      JOIN public.price pr ON pr.price_set_id=ps.id AND pr.deleted_at IS NULL AND pr.currency_code='vnd'
      WHERE vps.variant_id=v.id AND vps.deleted_at IS NULL) prices ON true
    WHERE v.deleted_at IS NULL AND ${partnerCatalogScopeSql(ctx)} AND v.id=ANY($4::text[]) ORDER BY v.id COLLATE "C"
  `, [ctx.assortmentId, ctx.merchantId, ctx.stockLocationId, request.items.map(line => line.variant_id)])).rows;
  if (rows.length !== request.items.length) throw new PartnerError("resource_not_found");
  const needed = new Map<string, number>();
  const source: unknown[] = [];
  const items = request.items.map(line => {
    const row = rows.find(candidate => candidate.variant_id === line.variant_id)!;
    if (Number(row.component_count) !== 1 || Number(row.required_quantity) !== 1 || !row.live_item
      || !row.manage_inventory || row.allow_backorder) throw new PartnerError("unsupported_inventory_model");
    const unitPrice = Number(row.amount);
    if (Number(row.price_count) !== 1 || !row.live_set || (row.price_merchant && row.price_merchant !== ctx.merchantId)
      || row.price_list_id !== null || Number(row.rules_count) !== 0 || row.min_quantity !== null || row.max_quantity !== null
      || !Number.isSafeInteger(unitPrice) || unitPrice < 0) throw new PartnerError("quote_changed");
    const stock = row.stocked_quantity === null ? 0 : Number(row.stocked_quantity);
    const quantity = (needed.get(row.item_id) ?? 0) + line.quantity;
    needed.set(row.item_id, quantity);
    if (!Number.isSafeInteger(stock) || quantity > Math.max(0, stock - ctx.policy.safetyStock)) throw new PartnerError("insufficient_stock");
    source.push({ variant: line.variant_id, item: row.item_id, mapping: row.mapping_id, set: row.price_set_id,
      price: row.price_id, amount: unitPrice, updated: new Date(row.updated_at).toISOString() });
    const lineTotal = unitPrice * line.quantity;
    if (!Number.isSafeInteger(lineTotal)) throw new PartnerError("invalid_request");
    return { ...line, unit_price: unitPrice, line_total: lineTotal };
  });
  const subtotal = items.reduce((sum, line) => sum + line.line_total, 0);
  const shippingFee = request.fulfillment_mode === "pickup" ? 0 : ctx.policy.deliveryFee!;
  const commercial = commercialAdjustmentContext();
  // Public v1 has no tax surcharge field; inclusive VND matches the existing
  // default. Exclusive pricing must be explicitly designed before enablement.
  if (commercial.taxMode !== "inclusive") throw new PartnerError("merchant_capability_denied");
  const totals = calculateOrderTotals(subtotal, {}, shippingFee, commercial);
  if (!Number.isSafeInteger(totals.total) || totals.total > ctx.policy.maxOrderTotal) throw new PartnerError("invalid_request");
  const pricingVersion = `price_${partnerFingerprint(keys, { source, commercial }, fingerprintVersion)}`;
  return { request, items, subtotal, shippingFee, total: totals.total, pricingVersion, fingerprintVersion, commercial };
}

export async function createPartnerQuoteForClient(db: PoolClient, ctx: PartnerContext, keys: PartnerKeyring,
  input: PartnerQuoteRequest, deliveryReady = false) {
  if (!ctx.scopes.includes("orders:quote")) throw new PartnerError("insufficient_scope");
  const priced = await pricePartnerItems(db, ctx, keys, input, keys.current, deliveryReady);
  const clock = (await db.query("SELECT transaction_timestamp() AS created_at")).rows[0].created_at as Date;
  const quote: PartnerQuote = { quote_id: `pq_${randomUUID()}`, store_id: ctx.storeId, currency: "VND",
    items: priced.items, subtotal: priced.subtotal, shipping_fee: priced.shippingFee, total: priced.total,
    fulfillment_mode: priced.request.fulfillment_mode, pricing_version: priced.pricingVersion,
    policy_version: ctx.policy.version, expires_at: new Date(clock.getTime() + 300000).toISOString(), stock_reserved: false };
  await db.query(`INSERT INTO integration.quotes(id,integration_id,merchant_id,store_id,stock_location_id,
    grant_version,store_grant_version,pricing_version,policy_id,policy_version,snapshot,request_hash,expires_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)`, [quote.quote_id,ctx.integrationId,ctx.merchantId,ctx.storeId,
    ctx.stockLocationId,ctx.grantVersion,ctx.storeGrantVersion,quote.pricing_version,ctx.policy.id,ctx.policy.version,
    JSON.stringify({ quote, request: priced.request, fingerprintVersion: keys.current, assortmentVersion: ctx.assortmentVersion,
      catalogMode: ctx.catalogMode,
      commercial: priced.commercial }), partnerFingerprint(keys, priced.request),quote.expires_at,clock.toISOString()]);
  await recordAuditEntry(db, ctx, "partner.quote_created", "partner_quote", quote.quote_id,
    { merchantId:ctx.merchantId,storeId:ctx.storeId,after:{ total:quote.total,currency:"VND",itemCount:quote.items.length } });
  return { data: quote, meta: { request_id: ctx.requestId } };
}
