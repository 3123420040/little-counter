import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import { queryOne } from "../db/query";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { id } from "../utils/id";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import type { OperatingScope } from "@medusa-snus/contracts";

export type ProductScanContext = "pos_add_to_cart" | "inventory_check";

export interface ProductQrIdentity {
  qrCodeId: string;
  slug: string;
  publicUrlPath: string;
  payloadVersion: number;
  printVersion: number;
  productId: string;
  variantId: string;
  merchantId: string;
  storeId: string;
  status: string;
}

export interface ProductScanResolution {
  context: ProductScanContext;
  resolutionSource: "qr" | "sku_barcode";
  qrCodeId?: string;
  qrSlug?: string;
  publicUrlPath?: string;
  productId: string;
  variantId: string;
  inventoryItemId: string;
  title: string;
  imageUrl: string;
  status: string;
  sku: string;
  barcode: string;
  price: number;
  stock: number;
}

export interface ProductTagViewModel {
  productId: string;
  variantId: string;
  title: string;
  brand: string;
  flavor: string;
  strengthLabel: string;
  formatLabels: string[];
  priceVnd: number;
  sku: string;
  barcode: string;
  qr: {
    codeId: string;
    slug: string;
    publicUrlPath: string;
    publicUrl: string;
    payloadVersion: number;
    printVersion: number;
  };
  warnings: string[];
}

export interface ProductQrActor {
  operatorId?: string;
  type?: string;
  role?: string;
}

interface ProductScanRow extends Record<string, unknown> {
  qr_code_id?: string | null;
  slug?: string | null;
  public_url_path?: string | null;
  product_id: string;
  variant_id: string;
  inventory_item_id: string | null;
  title: string;
  image_url: string | null;
  status: string;
  sku: string | null;
  barcode: string | null;
  price: string | number | null;
  stock: string | number | null;
}

interface ProductQrSeedRow extends Record<string, unknown> {
  product_id: string;
  variant_id: string;
  title: string;
  image_url: string | null;
  status: string;
  sku: string | null;
  barcode: string | null;
  price: string | number | null;
}

interface ProductTagRow extends ProductQrSeedRow {
  product_metadata: Record<string, unknown> | null;
  category_names: unknown;
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedClient(fn);
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48)
    .replace(/-$/g, "") || "product";
}

function normalizeContext(value: unknown): ProductScanContext {
  const context = String(value || "").trim();
  if (context === "pos_add_to_cart" || context === "inventory_check") return context;
  throw new PlatformError("validation_error", "Unsupported scan context", 400);
}

function normalizeCode(value: unknown): string {
  const code = String(value || "").trim();
  if (!code) throw new PlatformError("validation_error", "Scan code is required", 400);
  if (code.length > 1000) throw new PlatformError("validation_error", "Scan code is too long", 400);
  return code;
}

function readUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function decodePathPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function extractProductQrSlug(code: string): string {
  const normalized = normalizeCode(code);
  const url = readUrl(normalized);
  if (!url) return normalized;

  for (const param of ["qr", "slug", "code"]) {
    const value = url.searchParams.get(param)?.trim();
    if (value) return value;
  }

  const parts = url.pathname.split("/").map((part) => part.trim()).filter(Boolean);
  const productMarker = parts.lastIndexOf("p");
  if (productMarker >= 0 && parts[productMarker + 1]) return decodePathPart(parts[productMarker + 1]);

  for (const marker of ["scan", "qr", "product-qr"]) {
    const index = parts.indexOf(marker);
    if (index >= 0 && parts[index + 1]) return decodePathPart(parts[index + 1]);
  }
  if (parts[0] === "s" && parts.length > 1) return decodePathPart(parts[parts.length - 1]);
  return parts.length > 0 ? decodePathPart(parts[parts.length - 1]) : normalized;
}

function fallbackCodeFromScan(code: string): string {
  const normalized = normalizeCode(code);
  const url = readUrl(normalized);
  return url ? "" : normalized;
}

function mapQrIdentity(row: Record<string, unknown>): ProductQrIdentity {
  return {
    qrCodeId: String(row.id || row.qr_code_id || ""),
    slug: String(row.slug || ""),
    publicUrlPath: String(row.public_url_path || ""),
    payloadVersion: Number(row.payload_version || 1),
    printVersion: Number(row.print_version || 1),
    productId: String(row.product_id || ""),
    variantId: String(row.variant_id || ""),
    merchantId: String(row.merchant_id || ""),
    storeId: String(row.store_id || ""),
    status: String(row.status || "active"),
  };
}

function mapResolution(row: ProductScanRow, context: ProductScanContext, resolutionSource: ProductScanResolution["resolutionSource"]): ProductScanResolution {
  const inventoryItemId = String(row.inventory_item_id || "");
  if (!inventoryItemId) {
    throw new PlatformError("product_unavailable", "Product has no inventory linkage", 409);
  }
  if (context === "pos_add_to_cart" && row.status !== "published") {
    throw new PlatformError("product_unavailable", "Product is not published", 409);
  }
  return {
    context,
    resolutionSource,
    qrCodeId: row.qr_code_id ? String(row.qr_code_id) : undefined,
    qrSlug: row.slug ? String(row.slug) : undefined,
    publicUrlPath: row.public_url_path ? String(row.public_url_path) : undefined,
    productId: String(row.product_id || ""),
    variantId: String(row.variant_id || ""),
    inventoryItemId,
    title: String(row.title || ""),
    imageUrl: String(row.image_url || ""),
    status: String(row.status || ""),
    sku: String(row.sku || ""),
    barcode: String(row.barcode || ""),
    price: Number(row.price || 0),
    stock: Number(row.stock || 0),
  };
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringMetadata(metadata: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function stringArrayMetadata(metadata: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = metadata[key];
    if (Array.isArray(value)) {
      return value.map((item) => String(item || "").trim()).filter(Boolean);
    }
    if (typeof value === "string" && value.trim()) {
      return value.split(/[|,]/).map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function categoryNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function deriveBrand(title: string, metadata: Record<string, unknown>): string {
  return stringMetadata(metadata, ["brand", "brandName"]) || title.split(/\s+/)[0]?.trim() || title;
}

function deriveFlavor(title: string, brand: string, metadata: Record<string, unknown>): string {
  const explicit = stringMetadata(metadata, ["flavor", "flavour", "flavorName"]);
  if (explicit) return explicit;
  const trimmed = title.trim();
  const withoutStrength = (value: string) => value.replace(/\b\d{1,4}\s*mg(?:\s*\/\s*pouch)?\b/gi, "").replace(/\s+/g, " ").trim();
  if (brand && trimmed.toLowerCase().startsWith(brand.toLowerCase())) {
    return withoutStrength(trimmed.slice(brand.length).trim()) || trimmed;
  }
  return withoutStrength(trimmed) || trimmed;
}

function deriveStrength(title: string, sku: string, metadata: Record<string, unknown>): string {
  const explicit = stringMetadata(metadata, ["strengthLabel", "strength", "nicotineStrength", "mgPerPouch"]);
  if (explicit) return /\bmg\b/i.test(explicit) ? explicit : `${explicit}mg/pouch`;
  const match = `${title} ${sku}`.match(/(\d{1,4})\s*mg(?:\s*\/\s*pouch)?/i);
  return match ? `${match[1]}mg/pouch` : "";
}

function deriveFormatLabels(title: string, sku: string, metadata: Record<string, unknown>, categories: string[]): string[] {
  const labels = [
    ...stringArrayMetadata(metadata, ["formatLabels", "formats", "format"]),
    ...categories,
  ];
  const haystack = `${title} ${sku}`.toLowerCase();
  for (const candidate of ["cooling", "slim", "strong", "ultra strong", "mini", "mint"]) {
    if (haystack.includes(candidate)) labels.push(candidate);
  }
  return Array.from(new Set(labels.map((label) => label.toUpperCase()).filter(Boolean))).slice(0, 4);
}

function publicBaseUrl(): string {
  return (process.env.PUBLIC_APP_URL || process.env.PUBLIC_URL || "http://localhost:8080").replace(/\/+$/, "");
}

function publicMerchantSlug(merchantId: string): string {
  return merchantId === "merchant_default" ? "default" : merchantId;
}

function publicStoreSlug(storeId: string): string {
  return storeId === "store_default" ? "main" : storeId;
}

function productPublicUrlPath(scope: OperatingScope, slug: string): string {
  return `/s/${encodeURIComponent(publicMerchantSlug(scope.merchantId))}/${encodeURIComponent(publicStoreSlug(scope.storeId))}/p/${encodeURIComponent(slug)}`;
}

function tagWarnings(input: {
  brand: string;
  flavor: string;
  strengthLabel: string;
  priceVnd: number;
  sku: string;
  barcode: string;
}): string[] {
  const warnings: string[] = [];
  if (!input.brand) warnings.push("Missing brand");
  if (!input.flavor) warnings.push("Missing flavor");
  if (!input.strengthLabel) warnings.push("Missing strength label");
  if (!input.priceVnd) warnings.push("Missing VND price");
  if (!input.sku) warnings.push("Missing SKU");
  if (!input.barcode) warnings.push("Missing barcode");
  return warnings;
}

async function generateUniqueSlug(client: PoolClient, seed: string): Promise<string> {
  const base = slugify(seed);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = id("q").replace(/^q_/, "").slice(0, 8).toLowerCase();
    const slug = `${base}-${suffix}`;
    const existing = await queryOne<{ id: string }>(client, "SELECT id FROM app.product_qr_codes WHERE slug = $1 LIMIT 1", [slug]);
    if (!existing) return slug;
  }
  throw new PlatformError("internal_error", "Unable to generate product QR slug", 500);
}

async function productSeedRow(client: PoolClient, input: { productId: string; variantId?: string; scope: OperatingScope }): Promise<ProductQrSeedRow> {
  const row = await queryOne<ProductQrSeedRow>(client, `
    SELECT
      p.id AS product_id,
      pv.id AS variant_id,
      p.title,
      p.metadata->>'imageUrl' AS image_url,
      p.status,
      COALESCE(pv.sku, '') AS sku,
      COALESCE(pv.barcode, '') AS barcode,
      COALESCE(pr.amount, 0)::numeric AS price
    FROM public.product p
    JOIN public.product_variant pv
      ON pv.product_id = p.id
     AND pv.deleted_at IS NULL
     AND ($2::text IS NULL OR pv.id = $2)
    LEFT JOIN public.product_variant_price_set vps
      ON vps.variant_id = pv.id AND vps.deleted_at IS NULL
    LEFT JOIN public.price pr
      ON pr.price_set_id = vps.price_set_id
     AND pr.currency_code = 'vnd'
     AND pr.deleted_at IS NULL
    WHERE p.id = $1
      AND p.deleted_at IS NULL
      AND p.merchant_id = $3
    ORDER BY COALESCE(pv.variant_rank, 0) ASC, pv.created_at ASC, pv.id ASC
    LIMIT 1
  `, [input.productId, input.variantId || null, input.scope.merchantId]);
  if (!row) throw new PlatformError("resource_not_found", "Product variant not found", 404);
  return row;
}

export async function ensureProductQrIdentity(input: {
  productId: string;
  variantId?: string;
  scope: OperatingScope;
}): Promise<{ data: ProductQrIdentity }> {
  const productId = String(input.productId || "").trim();
  if (!productId) throw new PlatformError("validation_error", "productId is required", 400);

  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: input.scope.merchantId, storeId: input.scope.storeId });
    const seed = await productSeedRow(client, { productId, variantId: input.variantId, scope: input.scope });
    const existing = await queryOne<Record<string, unknown>>(client, `
      SELECT *
      FROM app.product_qr_codes
      WHERE merchant_id = $1
        AND store_id = $2
        AND variant_id = $3
      LIMIT 1
    `, [input.scope.merchantId, input.scope.storeId, seed.variant_id]);
    if (existing) {
      if (String(existing.status || "") !== "active") {
        throw new PlatformError("validation_error", "Product QR code is disabled", 409);
      }
      const desiredPublicUrlPath = productPublicUrlPath(input.scope, String(existing.slug || ""));
      if (String(existing.public_url_path || "") !== desiredPublicUrlPath) {
        const updated = await queryOne<Record<string, unknown>>(client, `
          UPDATE app.product_qr_codes
          SET public_url_path = $2,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `, [existing.id, desiredPublicUrlPath]);
        return { data: mapQrIdentity(updated || { ...existing, public_url_path: desiredPublicUrlPath }) };
      }
      return { data: mapQrIdentity(existing) };
    }

    const slug = await generateUniqueSlug(client, String(seed.sku || seed.title || seed.variant_id));
    const publicUrlPath = productPublicUrlPath(input.scope, slug);
    const snapshot = {
      productId: seed.product_id,
      variantId: seed.variant_id,
      title: seed.title,
      sku: seed.sku || "",
      barcode: seed.barcode || "",
      price: Number(seed.price || 0),
      status: seed.status,
    };
    const inserted = await queryOne<Record<string, unknown>>(client, `
      INSERT INTO app.product_qr_codes
        (merchant_id, store_id, product_id, variant_id, slug, public_url_path, product_snapshot)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (merchant_id, store_id, variant_id)
      DO UPDATE SET
        product_snapshot = EXCLUDED.product_snapshot,
        updated_at = now()
      RETURNING *
    `, [
      input.scope.merchantId,
      input.scope.storeId,
      seed.product_id,
      seed.variant_id,
      slug,
      publicUrlPath,
      JSON.stringify(snapshot),
    ]);
    if (!inserted) throw new PlatformError("internal_error", "Product QR code was not created", 500);
    return { data: mapQrIdentity(inserted) };
  });
}

async function productTagRow(client: PoolClient, input: { productId: string; variantId: string; scope: OperatingScope }): Promise<ProductTagRow> {
  const row = await queryOne<ProductTagRow>(client, `
    SELECT
      p.id AS product_id,
      pv.id AS variant_id,
      p.title,
      p.metadata AS product_metadata,
      p.metadata->>'imageUrl' AS image_url,
      p.status,
      COALESCE(pv.sku, '') AS sku,
      COALESCE(pv.barcode, '') AS barcode,
      COALESCE(pr.amount, 0)::numeric AS price,
      COALESCE(cat.category_names, '[]'::json) AS category_names
    FROM public.product p
    JOIN public.product_variant pv
      ON pv.product_id = p.id
     AND pv.id = $2
     AND pv.deleted_at IS NULL
    LEFT JOIN public.product_variant_price_set vps
      ON vps.variant_id = pv.id AND vps.deleted_at IS NULL
    LEFT JOIN public.price pr
      ON pr.price_set_id = vps.price_set_id
     AND pr.currency_code = 'vnd'
     AND pr.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT COALESCE(json_agg(pc.name ORDER BY pc.rank ASC, pc.name ASC) FILTER (WHERE pc.id IS NOT NULL), '[]'::json) AS category_names
      FROM public.product_category_product pcp
      JOIN public.product_category pc
        ON pc.id = pcp.product_category_id
       AND pc.deleted_at IS NULL
       AND pc.merchant_id = $3
      WHERE pcp.product_id = p.id
    ) cat ON true
    WHERE p.id = $1
      AND p.deleted_at IS NULL
      AND p.merchant_id = $3
    LIMIT 1
  `, [input.productId, input.variantId, input.scope.merchantId]);
  if (!row) throw new PlatformError("resource_not_found", "Product tag data not found", 404);
  return row;
}

export async function getProductTagViewModel(input: {
  productId: string;
  variantId?: string;
  scope: OperatingScope;
}): Promise<{ data: ProductTagViewModel }> {
  const identity = await ensureProductQrIdentity(input);
  return withClient(async (client) => {
    const row = await productTagRow(client, {
      productId: identity.data.productId,
      variantId: identity.data.variantId,
      scope: input.scope,
    });
    const metadata = metadataRecord(row.product_metadata);
    const title = String(row.title || "");
    const sku = String(row.sku || "");
    const barcode = String(row.barcode || "");
    const brand = deriveBrand(title, metadata);
    const flavor = deriveFlavor(title, brand, metadata);
    const strengthLabel = deriveStrength(title, sku, metadata);
    const priceVnd = Number(row.price || 0);
    const formats = deriveFormatLabels(title, sku, metadata, categoryNames(row.category_names));
    const publicUrlPath = identity.data.publicUrlPath;
    return {
      data: {
        productId: identity.data.productId,
        variantId: identity.data.variantId,
        title,
        brand,
        flavor,
        strengthLabel,
        formatLabels: formats,
        priceVnd,
        sku,
        barcode,
        qr: {
          codeId: identity.data.qrCodeId,
          slug: identity.data.slug,
          publicUrlPath,
          publicUrl: `${publicBaseUrl()}${publicUrlPath}`,
          payloadVersion: identity.data.payloadVersion,
          printVersion: identity.data.printVersion,
        },
        warnings: tagWarnings({ brand, flavor, strengthLabel, priceVnd, sku, barcode }),
      },
    };
  });
}

async function resolveByQrSlug(client: PoolClient, slug: string, scope: OperatingScope): Promise<ProductScanRow | null> {
  return queryOne<ProductScanRow>(client, `
    SELECT
      q.id::text AS qr_code_id,
      q.slug,
      q.public_url_path,
      p.id AS product_id,
      pv.id AS variant_id,
      pvii.inventory_item_id,
      p.title,
      p.metadata->>'imageUrl' AS image_url,
      p.status,
      COALESCE(pv.sku, '') AS sku,
      COALESCE(pv.barcode, '') AS barcode,
      COALESCE(pr.amount, 0)::numeric AS price,
      COALESCE(il.stocked_quantity, 0)::numeric AS stock
    FROM app.product_qr_codes q
    JOIN public.product p
      ON p.id = q.product_id
     AND p.deleted_at IS NULL
     AND p.merchant_id = q.merchant_id
    JOIN public.product_variant pv
      ON pv.id = q.variant_id
     AND pv.product_id = p.id
     AND pv.deleted_at IS NULL
    JOIN public.product_variant_inventory_item pvii
      ON pvii.variant_id = pv.id
     AND pvii.deleted_at IS NULL
    LEFT JOIN public.inventory_level il
      ON il.inventory_item_id = pvii.inventory_item_id
     AND il.location_id = $4
     AND il.deleted_at IS NULL
    LEFT JOIN public.product_variant_price_set vps
      ON vps.variant_id = pv.id AND vps.deleted_at IS NULL
    LEFT JOIN public.price pr
      ON pr.price_set_id = vps.price_set_id
     AND pr.currency_code = 'vnd'
     AND pr.deleted_at IS NULL
    WHERE q.slug = $1
      AND q.merchant_id = $2
      AND q.store_id = $3
      AND q.status = 'active'
    LIMIT 1
  `, [slug, scope.merchantId, scope.storeId, scope.stockLocationId]);
}

async function resolveBySkuOrBarcode(client: PoolClient, code: string, scope: OperatingScope): Promise<ProductScanRow | null> {
  if (!code) return null;
  const result = await client.query(`
    SELECT
      NULL::text AS qr_code_id,
      NULL::text AS slug,
      NULL::text AS public_url_path,
      p.id AS product_id,
      pv.id AS variant_id,
      pvii.inventory_item_id,
      p.title,
      p.metadata->>'imageUrl' AS image_url,
      p.status,
      COALESCE(pv.sku, '') AS sku,
      COALESCE(pv.barcode, '') AS barcode,
      COALESCE(pr.amount, 0)::numeric AS price,
      COALESCE(il.stocked_quantity, 0)::numeric AS stock
    FROM public.product_variant pv
    JOIN public.product p
      ON p.id = pv.product_id
     AND p.deleted_at IS NULL
     AND p.merchant_id = $2
    JOIN public.product_variant_inventory_item pvii
      ON pvii.variant_id = pv.id
     AND pvii.deleted_at IS NULL
    LEFT JOIN public.inventory_level il
      ON il.inventory_item_id = pvii.inventory_item_id
     AND il.location_id = $3
     AND il.deleted_at IS NULL
    LEFT JOIN public.product_variant_price_set vps
      ON vps.variant_id = pv.id AND vps.deleted_at IS NULL
    LEFT JOIN public.price pr
      ON pr.price_set_id = vps.price_set_id
     AND pr.currency_code = 'vnd'
     AND pr.deleted_at IS NULL
	    WHERE pv.deleted_at IS NULL
	      AND (
	        (pv.sku IS NOT NULL AND LOWER(btrim(pv.sku)) = LOWER(btrim($1)))
	        OR (pv.barcode IS NOT NULL AND LOWER(btrim(pv.barcode)) = LOWER(btrim($1)))
	      )
    ORDER BY p.title ASC, pv.id ASC
    LIMIT 2
  `, [code, scope.merchantId, scope.stockLocationId]);
  if (result.rows.length > 1) {
    throw new PlatformError("ambiguous_scan_code", "Scan code matches more than one product variant", 409);
  }
  return (result.rows[0] as ProductScanRow | undefined) ?? null;
}

async function recordScanEvent(
  client: PoolClient,
  input: {
    scope: OperatingScope;
    context: ProductScanContext;
    actor?: ProductQrActor;
    qrCodeId?: string;
    result: "success" | "failure";
    reason?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(`
    INSERT INTO app.product_qr_scan_events
      (qr_code_id, merchant_id, store_id, context, actor_type, actor_id, result, reason, metadata)
    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
  `, [
    input.qrCodeId || null,
    input.scope.merchantId,
    input.scope.storeId,
    input.context,
    input.actor?.type || "staff",
    input.actor?.operatorId || null,
    input.result,
    input.reason || null,
    JSON.stringify(input.metadata || {}),
  ]);
}

async function recordScanEventBestEffort(client: PoolClient, input: Parameters<typeof recordScanEvent>[1], transactional = false): Promise<void> {
  if (transactional) await client.query("SAVEPOINT product_qr_scan_event");
  try {
    await recordScanEvent(client, input);
  } catch {
    // Scan analytics must never block checkout or inventory operations.
    if (transactional) await client.query("ROLLBACK TO SAVEPOINT product_qr_scan_event");
  } finally {
    if (transactional) await client.query("RELEASE SAVEPOINT product_qr_scan_event");
  }
}

export async function resolveProductScan(
  input: { code?: string; context?: string },
  scope: OperatingScope,
  actor?: ProductQrActor,
  options?: { client?: PoolClient },
): Promise<{ data: ProductScanResolution }> {
  const code = normalizeCode(input.code);
  const context = normalizeContext(input.context);

  const run = async (client: PoolClient) => {
    let qrCodeId: string | undefined;
    try {
      const slug = extractProductQrSlug(code);
      const qrRow = await resolveByQrSlug(client, slug, scope);
      if (qrRow) {
        const data = mapResolution(qrRow, context, "qr");
        qrCodeId = data.qrCodeId;
        await recordScanEventBestEffort(client, {
          scope,
          context,
          actor,
          qrCodeId,
          result: "success",
          metadata: { resolutionSource: "qr" },
        }, Boolean(options?.client));
        return { data };
      }

      const fallbackCode = fallbackCodeFromScan(code);
      const fallbackRow = await resolveBySkuOrBarcode(client, fallbackCode, scope);
      if (!fallbackRow) {
        throw new PlatformError("resource_not_found", "Scan code did not resolve to a product", 404);
      }
      const data = mapResolution(fallbackRow, context, "sku_barcode");
      await recordScanEventBestEffort(client, {
        scope,
        context,
        actor,
        result: "success",
        metadata: { resolutionSource: "sku_barcode" },
      }, Boolean(options?.client));
      return { data };
    } catch (error) {
      await recordScanEventBestEffort(client, {
        scope,
        context,
        actor,
        qrCodeId,
        result: "failure",
        reason: error instanceof PlatformError ? error.code : "internal_error",
      }, Boolean(options?.client));
      throw error;
    }
  };
  return options?.client ? run(options.client) : withClient(run);
}
