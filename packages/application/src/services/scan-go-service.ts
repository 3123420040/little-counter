import { createHash, randomBytes } from "node:crypto";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import { queryOne } from "../db/query";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import type { OperatingScope } from "@medusa-snus/contracts";
import type { OperatorContext } from "./auth-service";
import { requireFeatureCapability } from "./feature-entitlement-service";
import { id } from "../utils/id";

const SCAN_GO_TOKEN_SECONDS = 30 * 60;
const MAX_SCAN_GO_CART_LINES = 50;

export interface ScanGoCartLineInput {
  productId?: string;
  variantId?: string;
  sku?: string;
  title?: string;
  quantity?: number;
  unitPriceVnd?: number;
}

export interface CreateScanGoCartInput {
  merchantSlug?: string;
  storeSlug?: string;
  lines?: ScanGoCartLineInput[];
  customerNickname?: string | null;
  customerContact?: string | null;
  contactType?: "whatsapp" | "email" | "phone" | null;
  ageAcknowledgedAt?: string;
}

export interface UpdateScanGoCartInput {
  editSecret?: string;
  lines?: ScanGoCartLineInput[];
  customerNickname?: string | null;
  customerContact?: string | null;
  contactType?: "whatsapp" | "email" | "phone" | null;
}

export interface ScanGoCartLineDto {
  productId: string;
  variantId: string;
  sku: string;
  title: string;
  quantity: number;
  unitPriceVnd: number;
  qrSlug: string;
  merchantSlug: string;
  storeSlug: string;
  brand: string;
  flavor: string;
  strengthLabel: string;
  imageUrl: string | null;
}

export interface ScanGoCartDto {
  cartId: string;
  editSecret?: string;
  merchantSlug: string;
  storeSlug: string;
  lines: ScanGoCartLineDto[];
  customerNickname: string | null;
  customerContact: string | null;
  contactType: "whatsapp" | "email" | "phone" | null;
  ageAcknowledgedAt: string;
}

export interface ScanGoCheckoutTokenDto {
  cartId: string;
  token: string;
  qrPayload: string;
  expiresAt: string;
  redeemableSeconds: number;
}

export interface StaffScanGoCartLineDto {
  productId: string;
  variantId: string;
  inventoryItemId: string;
  sku: string;
  title: string;
  quantity: number;
  unitPrice: number;
  stockLevel: number;
  warning?: string;
}

export interface StaffScanGoCartDto {
  cartId: string;
  status: string;
  sourceFlow: "customer_scan_go";
  salesChannel: "stash_dash";
  salesChannelLocked: true;
  customerNickname: string | null;
  customerContact: string | null;
  contactType: "whatsapp" | "email" | "phone" | null;
  ageVerificationReminder: string;
  expiresAt: string;
  redeemedAt?: string;
  redeemedByOperatorId?: string | null;
  lines: StaffScanGoCartLineDto[];
  warnings: string[];
}

interface StoreScopeRow extends Record<string, unknown> {
  merchant_id: string;
  store_id: string;
  stock_location_id: string;
}

interface CartRow extends Record<string, unknown> {
  id: string;
  merchant_id: string;
  store_id: string;
  status: string;
  merchant_slug: string;
  store_slug: string;
  customer_nickname: string | null;
  customer_contact: string | null;
  contact_type: "whatsapp" | "email" | "phone" | null;
  age_acknowledged_at: Date | string;
  edit_secret_hash: string | null;
  token_hash: string | null;
  token_expires_at: Date | string | null;
  redeemed_at: Date | string | null;
  redeemed_by_operator_id: string | null;
}

interface CartItemRow extends Record<string, unknown> {
  product_id: string;
  variant_id: string;
  qr_slug: string | null;
  sku: string;
  barcode: string;
  title: string;
  quantity: string | number;
  unit_price_vnd: string | number;
  product_snapshot: Record<string, unknown> | null;
}

interface VariantRow extends Record<string, unknown> {
  qr_code_id?: string | null;
  product_id: string;
  variant_id: string;
  inventory_item_id: string;
  title: string;
  image_url: string | null;
  status: string;
  sku: string;
  barcode: string;
  price: string | number | null;
  stock: string | number | null;
  qr_slug: string | null;
}

async function recordScanGoEvent(
  client: PoolClient,
  input: {
    merchantId: string;
    storeId: string;
    qrCodeId?: string | null;
    context: string;
    actorType: "customer" | "staff" | "channel";
    actorId?: string | null;
    result: "success" | "failure";
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await client.query(`
      INSERT INTO app.product_qr_scan_events
        (qr_code_id, merchant_id, store_id, context, actor_type, actor_id, result, reason, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    `, [
      input.qrCodeId || null,
      input.merchantId,
      input.storeId,
      input.context,
      input.actorType,
      input.actorId || null,
      input.result,
      input.reason || null,
      JSON.stringify(input.metadata || {}),
    ]);
  } catch {
    // Analytics must not block scan, cart, or checkout flows.
  }
}

function platformErrorCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code || "error") : "error";
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedClient(fn);
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedTransaction(fn);
}

function publicBaseUrl(): string {
  return (process.env.PUBLIC_APP_URL || process.env.PUBLIC_URL || "http://localhost:8080").replace(/\/+$/, "");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return `sgt_${randomBytes(18).toString("hex")}`;
}

function newEditSecret(): string {
  return `sge_${randomBytes(24).toString("hex")}`;
}

export function extractScanGoToken(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) throw new PlatformError("validation_error", "Scan Go token is required", 400);
  if (/^sgt_[a-f0-9]+$/i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const token = url.searchParams.get("t") || url.searchParams.get("token");
    if (token?.trim() && /^sgt_[a-f0-9]+$/i.test(token.trim())) return token.trim();
  } catch {
    // Not a URL; fall through to validation error.
  }
  throw new PlatformError("validation_error", "Invalid Scan Go token payload", 400);
}

function iso(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function cleanOptional(value: unknown, max: number): string | null {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, max);
}

function normalizeContactType(value: unknown): "whatsapp" | "email" | "phone" | null {
  if (value === null || value === undefined || value === "") return null;
  if (value === "whatsapp" || value === "email" || value === "phone") return value;
  throw new PlatformError("validation_error", "Invalid contact type", 400);
}

function assertAgeAcknowledged(value: unknown): string {
  const text = String(value || "").trim();
  const date = new Date(text);
  if (!text || Number.isNaN(date.getTime())) {
    throw new PlatformError("age_acknowledgement_required", "18+ acknowledgement is required before creating a Scan & Go cart", 400);
  }
  return date.toISOString();
}

function deriveBrand(title: string): string {
  return title.split(/\s+/)[0]?.trim() || title;
}

function deriveFlavor(title: string, brand: string): string {
  return title.toLowerCase().startsWith(brand.toLowerCase())
    ? title.slice(brand.length).replace(/\b\d{1,4}\s*mg(?:\s*\/\s*pouch)?\b/gi, "").trim() || title
    : title;
}

function deriveStrength(title: string, sku: string): string {
  const match = `${title} ${sku}`.match(/(\d{1,4})\s*mg(?:\s*\/\s*pouch)?/i);
  return match ? `${match[1]}mg/pouch` : "Strong";
}

function snapshotForVariant(row: VariantRow) {
  const title = String(row.title || "");
  const sku = String(row.sku || "");
  const brand = deriveBrand(title);
  return {
    brand,
    flavor: deriveFlavor(title, brand),
    strengthLabel: deriveStrength(title, sku),
    imageUrl: row.image_url || null,
  };
}

async function resolvePublicStoreScope(client: PoolClient, merchantSlug: string, storeSlug: string): Promise<StoreScopeRow> {
  const row = await queryOne<StoreScopeRow>(client, `
    SELECT
      m.id AS merchant_id,
      s.id AS store_id,
      s.stock_location_id
    FROM app.merchants m
    JOIN app.stores s ON s.merchant_id = m.id AND s.status = 'active'
    WHERE m.status = 'active'
      AND (m.id = $1 OR m.metadata->>'slug' = $1 OR ($1 = 'default' AND m.id = 'merchant_default'))
      AND (s.id = $2 OR s.metadata->>'slug' = $2 OR (($2 = 'main' OR $2 = 'default') AND s.is_primary = true))
    ORDER BY s.is_primary DESC, s.created_at ASC
    LIMIT 1
  `, [merchantSlug, storeSlug]);
  if (!row) throw new PlatformError("resource_not_found", "Scan & Go store not found", 404);
  await requireFeatureCapability("customer_scan_go", { merchantId: row.merchant_id, client });
  return row;
}

async function variantForCartLine(client: PoolClient, line: ScanGoCartLineInput, scope: StoreScopeRow): Promise<VariantRow> {
  const productId = String(line.productId || "").trim();
  const variantId = String(line.variantId || "").trim();
  if (!productId || !variantId) throw new PlatformError("validation_error", "Cart line requires productId and variantId", 400);
  const row = await queryOne<VariantRow>(client, `
    SELECT
      p.id AS product_id,
      pv.id AS variant_id,
      pvii.inventory_item_id,
      p.title,
      p.metadata->>'imageUrl' AS image_url,
      p.status,
      COALESCE(pv.sku, '') AS sku,
      COALESCE(pv.barcode, '') AS barcode,
      COALESCE(pr.amount, 0)::numeric AS price,
      COALESCE(il.stocked_quantity, 0)::numeric AS stock,
      q.slug AS qr_slug
    FROM public.product p
    JOIN public.product_variant pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
    JOIN public.product_variant_inventory_item pvii ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
    LEFT JOIN public.inventory_level il ON il.inventory_item_id = pvii.inventory_item_id AND il.location_id = $4 AND il.deleted_at IS NULL
    LEFT JOIN public.product_variant_price_set vps ON vps.variant_id = pv.id AND vps.deleted_at IS NULL
    LEFT JOIN public.price pr ON pr.price_set_id = vps.price_set_id AND pr.currency_code = 'vnd' AND pr.deleted_at IS NULL
    LEFT JOIN app.product_qr_codes q
      ON q.variant_id = pv.id
     AND q.merchant_id = $3
     AND q.store_id = $5
     AND q.status = 'active'
    WHERE p.id = $1
      AND pv.id = $2
      AND p.deleted_at IS NULL
      AND p.merchant_id = $3
    LIMIT 1
  `, [productId, variantId, scope.merchant_id, scope.stock_location_id, scope.store_id]);
  if (!row) throw new PlatformError("resource_not_found", "Cart product not found", 404);
  if (row.status !== "published") throw new PlatformError("product_unavailable", "Cart product is not available", 409);
  return row;
}

function normalizeQuantity(value: unknown): number {
  const qty = Number(value || 0);
  if (!Number.isInteger(qty) || qty <= 0 || qty > 99) {
    throw new PlatformError("validation_error", "Cart line quantity must be between 1 and 99", 400);
  }
  return qty;
}

function assertCartLines(lines: ScanGoCartLineInput[] | undefined): ScanGoCartLineInput[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new PlatformError("validation_error", "Scan & Go cart requires at least one line", 400);
  }
  if (lines.length > MAX_SCAN_GO_CART_LINES) {
    throw new PlatformError(
      "cart_line_limit_exceeded",
      `Scan & Go cart cannot exceed ${MAX_SCAN_GO_CART_LINES} lines`,
      413,
    );
  }
  return lines;
}

function assertCartEditSecret(cart: CartRow, editSecret: unknown): void {
  const secret = String(editSecret || "").trim();
  if (!secret || !cart.edit_secret_hash || tokenHash(secret) !== cart.edit_secret_hash) {
    throw new PlatformError("forbidden", "Scan & Go cart edit secret is invalid", 403);
  }
}

async function replaceCartLines(client: PoolClient, cartId: string, lines: ScanGoCartLineInput[], scope: StoreScopeRow): Promise<void> {
  await client.query("DELETE FROM app.scan_go_cart_items WHERE cart_id = $1", [cartId]);
  for (const line of lines) {
    const variant = await variantForCartLine(client, line, scope);
    const quantity = normalizeQuantity(line.quantity);
    const snapshot = snapshotForVariant(variant);
    await client.query(`
      INSERT INTO app.scan_go_cart_items
        (cart_id, product_id, variant_id, qr_slug, sku, barcode, title, quantity, unit_price_vnd, product_snapshot)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (cart_id, variant_id)
      DO UPDATE SET
        quantity = app.scan_go_cart_items.quantity + EXCLUDED.quantity,
        unit_price_vnd = EXCLUDED.unit_price_vnd,
        product_snapshot = EXCLUDED.product_snapshot,
        updated_at = now()
    `, [
      cartId,
      variant.product_id,
      variant.variant_id,
      variant.qr_slug || null,
      variant.sku || "",
      variant.barcode || "",
      variant.title,
      quantity,
      Math.round(Number(variant.price || 0)),
      JSON.stringify(snapshot),
    ]);
  }
}

async function loadCartDto(client: PoolClient, cartId: string, editSecret?: string): Promise<ScanGoCartDto> {
  const cart = await queryOne<CartRow>(client, "SELECT * FROM app.scan_go_carts WHERE id = $1", [cartId]);
  if (!cart) throw new PlatformError("resource_not_found", "Scan & Go cart not found", 404);
  const items = await client.query("SELECT * FROM app.scan_go_cart_items WHERE cart_id = $1 ORDER BY created_at ASC", [cartId]);
  return {
    cartId: cart.id,
    ...(editSecret ? { editSecret } : {}),
    merchantSlug: cart.merchant_slug,
    storeSlug: cart.store_slug,
    customerNickname: cart.customer_nickname || null,
    customerContact: cart.customer_contact || null,
    contactType: cart.contact_type || null,
    ageAcknowledgedAt: iso(cart.age_acknowledged_at),
    lines: items.rows.map((item: CartItemRow) => {
      const snapshot = item.product_snapshot || {};
      return {
        productId: item.product_id,
        variantId: item.variant_id,
        sku: item.sku,
        title: item.title,
        quantity: Number(item.quantity || 0),
        unitPriceVnd: Number(item.unit_price_vnd || 0),
        qrSlug: item.qr_slug || "",
        merchantSlug: cart.merchant_slug,
        storeSlug: cart.store_slug,
        brand: String(snapshot.brand || deriveBrand(item.title)),
        flavor: String(snapshot.flavor || deriveFlavor(item.title, deriveBrand(item.title))),
        strengthLabel: String(snapshot.strengthLabel || deriveStrength(item.title, item.sku)),
        imageUrl: typeof snapshot.imageUrl === "string" ? snapshot.imageUrl : null,
      };
    }),
  };
}

export async function resolvePublicScanGoProduct(input: { merchantSlug?: string; storeSlug?: string; qrSlug?: string }) {
  const merchantSlug = String(input.merchantSlug || "").trim();
  const storeSlug = String(input.storeSlug || "").trim();
  const qrSlug = String(input.qrSlug || "").trim();
  if (!merchantSlug || !storeSlug || !qrSlug) throw new PlatformError("validation_error", "Product QR route is incomplete", 400);
  return withClient(async (client) => {
    const scope = await resolvePublicStoreScope(client, merchantSlug, storeSlug);
    const row = await queryOne<VariantRow>(client, `
      SELECT
        q.id AS qr_code_id,
        p.id AS product_id,
        pv.id AS variant_id,
        pvii.inventory_item_id,
        p.title,
        p.metadata->>'imageUrl' AS image_url,
        p.status,
        COALESCE(pv.sku, '') AS sku,
        COALESCE(pv.barcode, '') AS barcode,
        COALESCE(pr.amount, 0)::numeric AS price,
        COALESCE(il.stocked_quantity, 0)::numeric AS stock,
        q.slug AS qr_slug
      FROM app.product_qr_codes q
      JOIN public.product p ON p.id = q.product_id AND p.deleted_at IS NULL AND p.merchant_id = q.merchant_id
      JOIN public.product_variant pv ON pv.id = q.variant_id AND pv.product_id = p.id AND pv.deleted_at IS NULL
      JOIN public.product_variant_inventory_item pvii ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
      LEFT JOIN public.inventory_level il ON il.inventory_item_id = pvii.inventory_item_id AND il.location_id = $4 AND il.deleted_at IS NULL
      LEFT JOIN public.product_variant_price_set vps ON vps.variant_id = pv.id AND vps.deleted_at IS NULL
      LEFT JOIN public.price pr ON pr.price_set_id = vps.price_set_id AND pr.currency_code = 'vnd' AND pr.deleted_at IS NULL
      WHERE q.slug = $1
        AND q.merchant_id = $2
        AND q.store_id = $3
        AND q.status = 'active'
      LIMIT 1
    `, [qrSlug, scope.merchant_id, scope.store_id, scope.stock_location_id]);
    if (!row) {
      await recordScanGoEvent(client, {
        merchantId: scope.merchant_id,
        storeId: scope.store_id,
        context: "customer_scan_go_product",
        actorType: "customer",
        result: "failure",
        reason: "product_not_found",
        metadata: { qrSlug },
      });
      throw new PlatformError("product_not_found", "Product QR not found", 404);
    }
    const snapshot = snapshotForVariant(row);
    const availability = row.status === "published" && Number(row.stock || 0) > 0 ? "available" : "unavailable";
    await recordScanGoEvent(client, {
      merchantId: scope.merchant_id,
      storeId: scope.store_id,
      qrCodeId: row.qr_code_id || null,
      context: "customer_scan_go_product",
      actorType: "customer",
      result: "success",
      metadata: {
        qrSlug,
        productId: row.product_id,
        variantId: row.variant_id,
        availability,
      },
    });
    return {
      data: {
        merchantSlug,
        storeSlug,
        qrSlug,
        productId: row.product_id,
        variantId: row.variant_id,
        brand: snapshot.brand,
        name: snapshot.flavor,
        flavor: snapshot.flavor,
        formatTags: [],
        strengthLabel: snapshot.strengthLabel,
        priceVnd: Math.round(Number(row.price || 0)),
        imageUrl: typeof snapshot.imageUrl === "string" && /^https?:\/\//i.test(snapshot.imageUrl) ? snapshot.imageUrl : null,
        approvedStory: "",
        availability,
      },
    };
  });
}

export async function createScanGoCart(input: CreateScanGoCartInput) {
  return withTransaction(async (client) => {
    const merchantSlug = String(input.merchantSlug || "").trim();
    const storeSlug = String(input.storeSlug || "").trim();
    const scope = await resolvePublicStoreScope(client, merchantSlug, storeSlug);
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchant_id, storeId: scope.store_id });
    const cartId = id("sgc");
    const lines = assertCartLines(input.lines);
    const editSecret = newEditSecret();
    await client.query(`
      INSERT INTO app.scan_go_carts
        (id, merchant_id, store_id, merchant_slug, store_slug, customer_nickname, customer_contact, contact_type, age_acknowledged_at, edit_secret_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10)
    `, [
      cartId,
      scope.merchant_id,
      scope.store_id,
      merchantSlug,
      storeSlug,
      cleanOptional(input.customerNickname, 80),
      cleanOptional(input.customerContact, 120),
      normalizeContactType(input.contactType),
      assertAgeAcknowledged(input.ageAcknowledgedAt),
      tokenHash(editSecret),
    ]);
    await replaceCartLines(client, cartId, lines, scope);
    return { data: await loadCartDto(client, cartId, editSecret) };
  });
}

async function loadActiveCartForMutation(client: PoolClient, cartId: string, editSecret: unknown) {
  const initial = await queryOne<CartRow>(client, "SELECT * FROM app.scan_go_carts WHERE id=$1", [cartId]);
  if (!initial) throw new PlatformError("resource_not_found", "Scan & Go cart not found", 404);
  assertCartEditSecret(initial, editSecret);
  await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: initial.merchant_id, storeId: initial.store_id });
  const cart = await queryOne<CartRow>(client, "SELECT * FROM app.scan_go_carts WHERE id=$1 FOR UPDATE", [cartId]);
  if (!cart || cart.merchant_id !== initial.merchant_id || cart.store_id !== initial.store_id) {
    throw new PlatformError("forbidden", "Scan & Go cart scope changed", 403);
  }
  assertCartEditSecret(cart, editSecret);
  return cart;
}

export async function updateScanGoCart(cartId: string, input: UpdateScanGoCartInput) {
  return withTransaction(async (client) => {
    const cart = await loadActiveCartForMutation(client, cartId, input.editSecret);
    if (cart.status === "redeemed") throw new PlatformError("cart_already_redeemed", "Scan & Go cart already redeemed", 409);
    const scope = await resolvePublicStoreScope(client, cart.merchant_slug, cart.store_slug);
    if (input.lines) await replaceCartLines(client, cartId, assertCartLines(input.lines), scope);
    await client.query(`
      UPDATE app.scan_go_carts
      SET customer_nickname = $2,
          customer_contact = $3,
          contact_type = $4,
          status = CASE WHEN status = 'redeemed' THEN status ELSE 'draft' END,
          token_hash = NULL,
          token_generated_at = NULL,
          token_expires_at = NULL,
          updated_at = now()
      WHERE id = $1
    `, [
      cartId,
      input.customerNickname === undefined ? cart.customer_nickname : cleanOptional(input.customerNickname, 80),
      input.customerContact === undefined ? cart.customer_contact : cleanOptional(input.customerContact, 120),
      input.contactType === undefined ? cart.contact_type : normalizeContactType(input.contactType),
    ]);
    return { data: await loadCartDto(client, cartId, String(input.editSecret || "").trim()) };
  });
}

export async function createScanGoCheckoutToken(cartId: string, input: { editSecret?: string } = {}): Promise<{ data: ScanGoCheckoutTokenDto }> {
  return withTransaction(async (client) => {
    const cart = await loadActiveCartForMutation(client, cartId, input.editSecret);
    if (cart.status === "redeemed") throw new PlatformError("cart_already_redeemed", "Scan & Go cart already redeemed", 409);
    await requireFeatureCapability("customer_scan_go", { merchantId: cart.merchant_id, client });
    const items = await client.query("SELECT id FROM app.scan_go_cart_items WHERE cart_id = $1 LIMIT 1", [cartId]);
    if (items.rows.length === 0) throw new PlatformError("validation_error", "Scan & Go cart is empty", 400);
    const token = newToken();
    const expiresAt = new Date(Date.now() + SCAN_GO_TOKEN_SECONDS * 1000);
    await client.query(`
      UPDATE app.scan_go_carts
      SET status = 'ready',
          token_hash = $2,
          token_generated_at = now(),
          token_expires_at = $3,
          updated_at = now()
      WHERE id = $1
    `, [cartId, tokenHash(token), expiresAt]);
    await recordScanGoEvent(client, {
      merchantId: cart.merchant_id,
      storeId: cart.store_id,
      context: "scan_go_token_generated",
      actorType: "customer",
      result: "success",
      metadata: {
        cartId,
        expiresAt: expiresAt.toISOString(),
        redeemableSeconds: SCAN_GO_TOKEN_SECONDS,
      },
    });
    return {
      data: {
        cartId,
        token,
        qrPayload: `${publicBaseUrl()}/s/${encodeURIComponent(cart.merchant_slug)}/${encodeURIComponent(cart.store_slug)}/redeem?t=${token}`,
        expiresAt: expiresAt.toISOString(),
        redeemableSeconds: SCAN_GO_TOKEN_SECONDS,
      },
    };
  });
}

async function staffCartFromToken(client: PoolClient, tokenOrPayload: string, scope: OperatingScope, forUpdate: boolean): Promise<{ cart: CartRow; lines: StaffScanGoCartLineDto[]; warnings: string[] }> {
  const token = extractScanGoToken(tokenOrPayload);
  const cart = await queryOne<CartRow>(client, `
    SELECT *
    FROM app.scan_go_carts
    WHERE token_hash = $1
    ${forUpdate ? "FOR UPDATE" : ""}
  `, [tokenHash(token)]);
  if (!cart) throw new PlatformError("resource_not_found", "Scan & Go cart token not found", 404);
  if (cart.merchant_id !== scope.merchantId || cart.store_id !== scope.storeId) {
    throw new PlatformError("forbidden", "Scan & Go cart belongs to another store", 403);
  }
  await requireFeatureCapability("customer_scan_go", { merchantId: cart.merchant_id, client });
  if (cart.status === "redeemed") throw new PlatformError("cart_already_redeemed", "Scan & Go cart already redeemed", 409);
  if (cart.status !== "ready") throw new PlatformError("cart_not_ready", "Scan & Go cart is not ready", 409);
  const expiresAt = cart.token_expires_at ? new Date(String(cart.token_expires_at)) : null;
  if (!expiresAt || expiresAt.getTime() < Date.now()) {
    await client.query("UPDATE app.scan_go_carts SET status = 'expired', updated_at = now() WHERE id = $1 AND status <> 'redeemed'", [cart.id]);
    throw new PlatformError("cart_token_expired", "Scan & Go cart QR expired", 410);
  }
  const rows = await client.query(`
    SELECT
      item.product_id,
      item.variant_id,
      item.quantity,
      item.unit_price_vnd,
      p.title,
      p.status,
      COALESCE(pv.sku, item.sku, '') AS sku,
      pvii.inventory_item_id,
      COALESCE(pr.amount, 0)::numeric AS current_price,
      COALESCE(il.stocked_quantity, 0)::numeric AS stock
    FROM app.scan_go_cart_items item
    JOIN public.product p ON p.id = item.product_id AND p.deleted_at IS NULL
    JOIN public.product_variant pv ON pv.id = item.variant_id AND pv.product_id = p.id AND pv.deleted_at IS NULL
    JOIN public.product_variant_inventory_item pvii ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
    LEFT JOIN public.inventory_level il ON il.inventory_item_id = pvii.inventory_item_id AND il.location_id = $2 AND il.deleted_at IS NULL
    LEFT JOIN public.product_variant_price_set vps ON vps.variant_id = pv.id AND vps.deleted_at IS NULL
    LEFT JOIN public.price pr ON pr.price_set_id = vps.price_set_id AND pr.currency_code = 'vnd' AND pr.deleted_at IS NULL
    WHERE item.cart_id = $1
    ORDER BY item.created_at ASC
  `, [cart.id, scope.stockLocationId]);
  const warnings: string[] = [];
  const lines = rows.rows.map((row: Record<string, unknown>) => {
    const quantity = Number(row.quantity || 0);
    const unitPrice = Number(row.current_price || 0);
    const priceSnapshot = Number(row.unit_price_vnd || 0);
    const stockLevel = Number(row.stock || 0);
    let warning = "";
    if (row.status !== "published") warning = "Sản phẩm hiện không còn published.";
    else if (stockLevel < quantity) warning = `Tồn hiện tại chỉ còn ${stockLevel}.`;
    else if (unitPrice !== priceSnapshot) warning = `Giá hiện tại đã đổi từ ${priceSnapshot.toLocaleString("vi-VN")} ₫.`;
    if (warning) warnings.push(`${row.title}: ${warning}`);
    return {
      productId: String(row.product_id),
      variantId: String(row.variant_id),
      inventoryItemId: String(row.inventory_item_id),
      sku: String(row.sku || ""),
      title: String(row.title || ""),
      quantity,
      unitPrice,
      stockLevel,
      warning: warning || undefined,
    };
  });
  if (lines.length === 0) throw new PlatformError("validation_error", "Scan & Go cart is empty", 400);
  return { cart, lines, warnings };
}

function staffCartDto(cart: CartRow, lines: StaffScanGoCartLineDto[], warnings: string[]): StaffScanGoCartDto {
  return {
    cartId: cart.id,
    status: cart.status,
    sourceFlow: "customer_scan_go",
    salesChannel: "stash_dash",
    salesChannelLocked: true,
    customerNickname: cart.customer_nickname || null,
    customerContact: cart.customer_contact || null,
    contactType: cart.contact_type || null,
    ageVerificationReminder: "Customer acknowledged 18+ in the web flow. Staff must verify age/ID before payment.",
    expiresAt: iso(cart.token_expires_at),
    redeemedAt: cart.redeemed_at ? iso(cart.redeemed_at) : undefined,
    redeemedByOperatorId: cart.redeemed_by_operator_id || null,
    lines,
    warnings,
  };
}

export async function resolveScanGoCartForStaff(input: { tokenOrPayload?: string }, scope: OperatingScope, actor?: Pick<OperatorContext, "operatorId">) {
  return withClient(async (client) => {
    try {
      const { cart, lines, warnings } = await staffCartFromToken(client, String(input.tokenOrPayload || ""), scope, false);
      await recordScanGoEvent(client, {
        merchantId: cart.merchant_id,
        storeId: cart.store_id,
        context: "scan_go_staff_resolve",
        actorType: "staff",
        actorId: actor?.operatorId || null,
        result: "success",
        metadata: {
          cartId: cart.id,
          lineCount: lines.length,
          warningCount: warnings.length,
        },
      });
      return { data: staffCartDto(cart, lines, warnings) };
    } catch (err) {
      await recordScanGoEvent(client, {
        merchantId: scope.merchantId,
        storeId: scope.storeId,
        context: "scan_go_staff_resolve",
        actorType: "staff",
        actorId: actor?.operatorId || null,
        result: "failure",
        reason: platformErrorCode(err),
      });
      throw err;
    }
  });
}

export async function redeemScanGoCartForStaff(input: { tokenOrPayload?: string }, scope: OperatingScope, actor: OperatorContext) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
    try {
      const { cart, lines, warnings } = await staffCartFromToken(client, String(input.tokenOrPayload || ""), scope, true);
      const redeemedAt = new Date();
      await client.query(`
        UPDATE app.scan_go_carts
        SET status = 'redeemed',
            redeemed_at = $2,
            redeemed_by_operator_id = $3,
            updated_at = now()
        WHERE id = $1
      `, [cart.id, redeemedAt, actor.operatorId]);
      await recordScanGoEvent(client, {
        merchantId: cart.merchant_id,
        storeId: cart.store_id,
        context: "scan_go_staff_redeem",
        actorType: "staff",
        actorId: actor.operatorId,
        result: "success",
        metadata: {
          cartId: cart.id,
          lineCount: lines.length,
          warningCount: warnings.length,
        },
      });
      return {
        data: staffCartDto({ ...cart, status: "redeemed", redeemed_at: redeemedAt, redeemed_by_operator_id: actor.operatorId }, lines, warnings),
      };
    } catch (err) {
      await recordScanGoEvent(client, {
        merchantId: scope.merchantId,
        storeId: scope.storeId,
        context: "scan_go_staff_redeem",
        actorType: "staff",
        actorId: actor.operatorId,
        result: "failure",
        reason: platformErrorCode(err),
      });
      throw err;
    }
  });
}
