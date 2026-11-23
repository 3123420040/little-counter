import { createSign, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";

export type VisionCatalogReadinessStatus = "ready" | "needs_image" | "needs_index" | "index_failed";
export type VisionCatalogReadinessDetailStatus =
  | "not_ready"
  | "missing_front_image"
  | "missing_counter_image"
  | "missing_strength_image"
  | "pending_approval"
  | "pending_provider_sync"
  | "index_failed"
  | "ready_for_single_scan"
  | "ready_for_bulk_scan";

export interface VisionCatalogReadinessQuery {
  merchantId: string;
  storeId?: string;
  provider?: string;
  q?: string;
  limit?: number | string;
  offset?: number | string;
}

export interface VisionCatalogReadinessItem {
  productId: string;
  variantId: string;
  title: string;
  sku: string;
  barcode: string;
  status: string;
  metadataImageUrl: string;
  primaryImageId: string;
  primaryImageUrl: string;
  referenceImageCount: number;
  approvedImageCount: number;
  pendingImageCount: number;
  rejectedImageCount: number;
  approvedFrontImageCount: number;
  approvedCounterCaptureImageCount: number;
  approvedStrengthTextImageCount: number;
  pendingFrontImageCount: number;
  pendingCounterCaptureImageCount: number;
  pendingStrengthTextImageCount: number;
  indexedImageCount: number;
  syncedImageCount: number;
  failedIndexCount: number;
  isHighRiskVariant: boolean;
  readiness: VisionCatalogReadinessStatus;
  readinessStatus: VisionCatalogReadinessDetailStatus;
  readinessReasons: string[];
  missingImageTypes: string[];
}

export interface VisionReferenceImage {
  imageId: string;
  merchantId: string;
  storeId: string | null;
  productId: string;
  variantId: string;
  title: string;
  sku: string;
  barcode: string;
  imageUrl: string;
  imageType: string;
  qualityStatus: string;
  isPrimary: boolean;
  providerProductRef: string;
  providerImageRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface VisionReferenceImageProviderQuery {
  merchantId: string;
  storeId?: string;
  provider?: string;
  includePending?: boolean | string | number;
  limit?: number | string;
  offset?: number | string;
}

export interface VisionReferenceImageSyncResult {
  insertedCount: number;
  totalProductsWithImageUrl: number;
}

export interface VisionReferenceImageCreateInput {
  merchantId: string;
  storeId?: string;
  productId?: string;
  variantId?: string;
  imageUrl?: string;
  imageType?: string;
  source?: string;
  qualityStatus?: string;
  isPrimary?: boolean;
  metadata?: Record<string, unknown>;
}

export interface VisionReferenceImageUploadInput {
  merchantId: string;
  storeId?: string;
  productId?: string;
  variantId?: string;
  imageBase64?: string;
  fileName?: string;
  contentType?: string;
  imageType?: string;
  qualityStatus?: string;
  isPrimary?: boolean;
  metadata?: Record<string, unknown>;
}

export interface VisionReferenceImageUpdateInput {
  merchantId: string;
  imageId?: string;
  imageType?: string;
  qualityStatus?: string;
  isPrimary?: boolean;
  metadata?: Record<string, unknown>;
}

const imageTypes = new Set(["primary", "front", "back", "side", "angle", "counter_capture", "strength_text", "qr_tag"]);
const imageSources = new Set(["manual", "import", "metadata_backfill", "autofill", "staff_correction", "system"]);
const qualityStatuses = new Set(["pending", "approved", "rejected"]);
const uploadContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const googleCloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const defaultReferenceImageMaxBytes = 6 * 1024 * 1024;

interface ServiceAccountJson {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
}

interface GoogleTokenCache {
  accessToken: string;
  expiresAtMs: number;
}

let googleTokenCache: GoogleTokenCache | null = null;

interface ReferenceImageInsertInput {
  merchantId: string;
  storeId: string | null;
  productId: string;
  variantId: string;
  imageUrl: string;
  imageType: string;
  source: string;
  qualityStatus: string;
  isPrimary: boolean;
  metadata: Record<string, unknown>;
}

interface DecodedReferenceImageUpload {
  bytes: Buffer;
  contentType: string;
  extension: string;
}

function normalizeRequiredId(value: unknown, field: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new PlatformError("validation_error", `${field} is required`, 400);
  return normalized;
}

function optionalText(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizedEnum(value: unknown, allowed: Set<string>, fallback: string, field: string): string {
  const normalized = String(value || fallback).trim();
  if (!allowed.has(normalized)) {
    throw new PlatformError("validation_error", `${field} is invalid`, 400, { field, allowed: [...allowed] });
  }
  return normalized;
}

function toLimit(value: string | number | undefined, fallback = 100): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), 500);
}

function toOffset(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function readinessDetailFromCounts(item: {
  referenceImageCount: number;
  approvedImageCount: number;
  pendingImageCount: number;
  approvedFrontImageCount: number;
  approvedCounterCaptureImageCount: number;
  approvedStrengthTextImageCount: number;
  pendingFrontImageCount: number;
  pendingCounterCaptureImageCount: number;
  pendingStrengthTextImageCount: number;
  syncedImageCount: number;
  failedIndexCount: number;
  isHighRiskVariant: boolean;
}): {
  readinessStatus: VisionCatalogReadinessDetailStatus;
  readinessReasons: string[];
  missingImageTypes: string[];
} {
  const missingImageTypes: string[] = [];
  const pendingRequiredTypes: string[] = [];

  if (item.approvedFrontImageCount <= 0) {
    if (item.pendingFrontImageCount > 0) pendingRequiredTypes.push("front");
    else missingImageTypes.push("front");
  }
  if (item.approvedCounterCaptureImageCount <= 0) {
    if (item.pendingCounterCaptureImageCount > 0) pendingRequiredTypes.push("counter_capture");
    else missingImageTypes.push("counter_capture");
  }
  if (item.isHighRiskVariant && item.approvedStrengthTextImageCount <= 0) {
    if (item.pendingStrengthTextImageCount > 0) pendingRequiredTypes.push("strength_text");
    else missingImageTypes.push("strength_text");
  }

  const readinessReasons = [
    ...missingImageTypes.map((type) => `missing_${type}`),
    ...pendingRequiredTypes.map((type) => `pending_${type}_approval`),
  ];

  let readinessStatus: VisionCatalogReadinessDetailStatus = "ready_for_single_scan";
  if (missingImageTypes.includes("front")) readinessStatus = "missing_front_image";
  else if (missingImageTypes.includes("counter_capture")) readinessStatus = "missing_counter_image";
  else if (missingImageTypes.includes("strength_text")) readinessStatus = "missing_strength_image";
  else if (pendingRequiredTypes.length > 0 || (item.approvedImageCount <= 0 && item.pendingImageCount > 0)) readinessStatus = "pending_approval";
  else if (item.failedIndexCount > 0) readinessStatus = "index_failed";
  else if (item.syncedImageCount <= 0) readinessStatus = "pending_provider_sync";

  if (readinessStatus === "pending_provider_sync") readinessReasons.push("provider_sync_pending");
  if (readinessStatus === "index_failed") readinessReasons.push("provider_sync_failed");

  return { readinessStatus, readinessReasons, missingImageTypes };
}

function readinessSummaryFromDetail(status: VisionCatalogReadinessDetailStatus): VisionCatalogReadinessStatus {
  if (status === "ready_for_single_scan" || status === "ready_for_bulk_scan") return "ready";
  if (status === "pending_provider_sync") return "needs_index";
  if (status === "index_failed") return "index_failed";
  return "needs_image";
}

function mapReadinessRow(row: Record<string, unknown>): VisionCatalogReadinessItem {
  const counts = {
    referenceImageCount: toNumber(row.reference_image_count),
    approvedImageCount: toNumber(row.approved_image_count),
    pendingImageCount: toNumber(row.pending_image_count),
    rejectedImageCount: toNumber(row.rejected_image_count),
    approvedFrontImageCount: toNumber(row.approved_front_image_count),
    approvedCounterCaptureImageCount: toNumber(row.approved_counter_capture_image_count),
    approvedStrengthTextImageCount: toNumber(row.approved_strength_text_image_count),
    pendingFrontImageCount: toNumber(row.pending_front_image_count),
    pendingCounterCaptureImageCount: toNumber(row.pending_counter_capture_image_count),
    pendingStrengthTextImageCount: toNumber(row.pending_strength_text_image_count),
    indexedImageCount: toNumber(row.indexed_image_count),
    syncedImageCount: toNumber(row.synced_image_count),
    failedIndexCount: toNumber(row.failed_index_count),
    isHighRiskVariant: toBoolean(row.is_high_risk_variant),
  };
  const detail = readinessDetailFromCounts(counts);
  return {
    productId: String(row.product_id || ""),
    variantId: String(row.variant_id || ""),
    title: String(row.title || ""),
    sku: String(row.sku || ""),
    barcode: String(row.barcode || ""),
    status: String(row.status || ""),
    metadataImageUrl: String(row.metadata_image_url || ""),
    primaryImageId: String(row.primary_image_id || ""),
    primaryImageUrl: String(row.primary_image_url || ""),
    ...counts,
    readiness: readinessSummaryFromDetail(detail.readinessStatus),
    ...detail,
  };
}

function mapReferenceImageRow(row: Record<string, unknown>): VisionReferenceImage {
  return {
    imageId: String(row.image_id || ""),
    merchantId: String(row.merchant_id || ""),
    storeId: row.store_id ? String(row.store_id) : null,
    productId: String(row.product_id || ""),
    variantId: String(row.variant_id || ""),
    title: String(row.title || ""),
    sku: String(row.sku || ""),
    barcode: String(row.barcode || ""),
    imageUrl: String(row.image_url || ""),
    imageType: String(row.image_type || ""),
    qualityStatus: String(row.quality_status || ""),
    isPrimary: Boolean(row.is_primary),
    providerProductRef: String(row.provider_product_ref || ""),
    providerImageRef: String(row.provider_image_ref || ""),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ""),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || ""),
  };
}

function requiredEnv(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new PlatformError("provider_config_missing", `${name} is required`, 503);
  return value;
}

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] || fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function normalizeReferenceImageUrl(value: unknown): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;

  if (raw.startsWith("gs://")) {
    const withoutScheme = raw.slice("gs://".length);
    const slashIndex = withoutScheme.indexOf("/");
    const bucket = slashIndex >= 0 ? withoutScheme.slice(0, slashIndex) : withoutScheme;
    const objectName = slashIndex >= 0 ? withoutScheme.slice(slashIndex + 1) : "";
    if (!bucket || !objectName || /[\s?#]/.test(withoutScheme) || objectName.split("/").includes("..")) {
      throw new PlatformError("validation_error", "imageUrl must be a valid gs://bucket/object URI", 400);
    }
    return `gs://${bucket}/${objectName}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PlatformError("validation_error", "imageUrl must be a valid URL", 400);
  }
  if (parsed.protocol !== "https:") {
    throw new PlatformError("validation_error", "imageUrl must use HTTPS or gs://", 400);
  }
  if (parsed.username || parsed.password) {
    throw new PlatformError("validation_error", "imageUrl cannot contain credentials", 400);
  }
  return parsed.toString();
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function loadGoogleServiceAccount(): Promise<ServiceAccountJson> {
  const raw = await readFile(requiredEnv("GOOGLE_APPLICATION_CREDENTIALS"), "utf8");
  const parsed = JSON.parse(raw) as ServiceAccountJson;
  if (!parsed.client_email || !parsed.private_key) {
    throw new PlatformError("provider_config_missing", "Google service account JSON is missing client_email or private_key", 503);
  }
  return parsed;
}

function signGoogleJwt(serviceAccount: ServiceAccountJson, nowSeconds: number): string {
  const tokenUri = serviceAccount.token_uri || "https://oauth2.googleapis.com/token";
  const unsigned = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({
    iss: serviceAccount.client_email,
    scope: googleCloudPlatformScope,
    aud: tokenUri,
    exp: nowSeconds + 3600,
    iat: nowSeconds,
  })}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(String(serviceAccount.private_key), "base64url");
  return `${unsigned}.${signature}`;
}

async function googleAccessToken(): Promise<string> {
  const now = Date.now();
  if (googleTokenCache && googleTokenCache.expiresAtMs - 60_000 > now) return googleTokenCache.accessToken;

  const serviceAccount = await loadGoogleServiceAccount();
  const tokenUri = serviceAccount.token_uri || "https://oauth2.googleapis.com/token";
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signGoogleJwt(serviceAccount, Math.floor(now / 1000)),
    }),
  });
  const payload = await response.json().catch(() => ({})) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new PlatformError("provider_auth_failed", "Google OAuth token request failed", 502, {
      status: response.status,
      error: payload.error,
      description: payload.error_description,
    });
  }
  googleTokenCache = {
    accessToken: payload.access_token,
    expiresAtMs: now + Math.max(60, Number(payload.expires_in || 3600)) * 1000,
  };
  return payload.access_token;
}

function sniffImageContentType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function extensionForContentType(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  return "webp";
}

function decodeReferenceImageUpload(input: VisionReferenceImageUploadInput): DecodedReferenceImageUpload {
  let encoded = String(input.imageBase64 || "").trim();
  if (!encoded) throw new PlatformError("validation_error", "imageBase64 is required", 400);

  let contentType = optionalText(input.contentType)?.toLowerCase() || "";
  const dataUrlMatch = encoded.match(/^data:([^;,]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    contentType = dataUrlMatch[1].toLowerCase();
    encoded = dataUrlMatch[2];
  }

  const bytes = Buffer.from(encoded.replace(/\s/g, ""), "base64");
  if (bytes.length <= 0) throw new PlatformError("validation_error", "imageBase64 is not a valid image payload", 400);

  const sniffedContentType = sniffImageContentType(bytes);
  contentType = contentType || sniffedContentType || "";
  if (!uploadContentTypes.has(contentType)) {
    throw new PlatformError("validation_error", "reference image must be JPEG, PNG, or WebP", 400, {
      contentType,
    });
  }

  const maxBytes = positiveIntEnv("VISION_REFERENCE_IMAGE_MAX_BYTES", defaultReferenceImageMaxBytes);
  if (bytes.length > maxBytes) {
    throw new PlatformError("validation_error", "reference image exceeds the configured size limit", 400, {
      byteLength: bytes.length,
      maxBytes,
    });
  }

  return { bytes, contentType, extension: extensionForContentType(contentType) };
}

function safeObjectPart(value: unknown, fallback: string): string {
  const normalized = String(value || fallback)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}

async function uploadReferenceImageObject(input: {
  merchantId: string;
  storeId: string | null;
  variantId: string;
  fileName?: string | null;
  bytes: Buffer;
  contentType: string;
  extension: string;
}): Promise<{ gcsUri: string; bucket: string; objectName: string }> {
  const bucket = requiredEnv("GOOGLE_VISION_REFERENCE_BUCKET").replace(/^gs:\/\//, "").replace(/\/+$/g, "");
  const prefix = String(process.env.GOOGLE_VISION_REFERENCE_PREFIX || "reference-images")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const fileStem = safeObjectPart(String(input.fileName || `capture.${input.extension}`).replace(/\.[^.]+$/, ""), "capture");
  const objectName = [
    prefix,
    safeObjectPart(input.merchantId, "merchant"),
    safeObjectPart(input.storeId || "global", "global"),
    safeObjectPart(input.variantId, "variant"),
    `${Date.now()}-${randomUUID()}-${fileStem}.${input.extension}`,
  ].filter(Boolean).join("/");
  const token = await googleAccessToken();
  const response = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": input.contentType,
    },
    body: input.bytes as unknown as RequestInit["body"],
  });
  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    throw new PlatformError("provider_request_failed", "GCS reference image upload failed", 502, {
      status: response.status,
      payload: payload.slice(0, 500),
    });
  }
  return { bucket, objectName, gcsUri: `gs://${bucket}/${objectName}` };
}

async function resolveReferenceVariant(
  client: PoolClient,
  input: { merchantId: string; productId?: string | null; variantId: string },
): Promise<{ productId: string; variantId: string }> {
  const row = await client.query<{ product_id: string; variant_id: string }>(`
    SELECT p.id AS product_id, v.id AS variant_id
    FROM public.product_variant v
    JOIN public.product p
      ON p.id = v.product_id
     AND p.deleted_at IS NULL
    WHERE p.merchant_id = $1
      AND v.id = $2
      AND v.deleted_at IS NULL
      AND ($3::text IS NULL OR p.id = $3::text)
    LIMIT 1
  `, [input.merchantId, input.variantId, input.productId || null]);
  const variant = row.rows[0];
  if (!variant) {
    throw new PlatformError("resource_not_found", "Variant is not available for this merchant/product", 404);
  }
  return { productId: variant.product_id, variantId: variant.variant_id };
}

async function assertReferenceStore(client: PoolClient, merchantId: string, storeId: string | null): Promise<void> {
  if (!storeId) return;
  const row = await client.query<{ id: string }>(`
    SELECT id
    FROM app.stores
    WHERE id = $1
      AND merchant_id = $2
      AND status = 'active'
    LIMIT 1
  `, [storeId, merchantId]);
  if (!row.rows[0]) {
    throw new PlatformError("resource_not_found", "storeId is not active for this merchant", 404);
  }
}

async function clearPrimaryReferenceImage(
  client: PoolClient,
  input: { merchantId: string; storeId: string | null; variantId: string; excludeImageId?: string | null },
): Promise<void> {
  await client.query(`
    UPDATE app.product_variant_images
    SET is_primary = false,
        updated_at = now()
    WHERE merchant_id = $1
      AND store_id IS NOT DISTINCT FROM $2::text
      AND variant_id = $3
      AND ($4::uuid IS NULL OR id <> $4::uuid)
      AND is_primary = true
  `, [input.merchantId, input.storeId, input.variantId, input.excludeImageId || null]);
}

async function getReferenceImageById(
  client: PoolClient,
  input: { merchantId: string; imageId: string },
): Promise<VisionReferenceImage> {
  const result = await client.query(`
    SELECT
      image.id AS image_id,
      image.merchant_id,
      image.store_id,
      image.product_id,
      image.variant_id,
      p.title,
      COALESCE(v.sku, '') AS sku,
      COALESCE(v.barcode, '') AS barcode,
      image.image_url,
      image.image_type,
      image.quality_status,
      image.is_primary,
      COALESCE(index_item.provider_product_ref, '') AS provider_product_ref,
      COALESCE(index_item.provider_image_ref, '') AS provider_image_ref,
      image.created_at,
      image.updated_at
    FROM app.product_variant_images image
    JOIN public.product p
      ON p.id = image.product_id
     AND p.deleted_at IS NULL
    JOIN public.product_variant v
      ON v.id = image.variant_id
     AND v.deleted_at IS NULL
    LEFT JOIN app.vision_catalog_index_items index_item
      ON index_item.image_id = image.id
     AND index_item.merchant_id = image.merchant_id
    WHERE image.merchant_id = $1
      AND image.id = $2::uuid
    LIMIT 1
  `, [input.merchantId, input.imageId]);
  const row = result.rows[0];
  if (!row) throw new PlatformError("resource_not_found", "Vision reference image not found", 404);
  return mapReferenceImageRow(row as Record<string, unknown>);
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedClient(fn);
}

async function withActiveReferenceTransaction<T>(merchantId: string, storeId: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async client => {
    await lockActiveBusinessScopeForClient(client, storeId ? { scopeType: "store", merchantId, storeId } : { scopeType: "merchant", merchantId });
    return fn(client);
  });
}

async function insertReferenceImage(
  client: PoolClient,
  input: ReferenceImageInsertInput,
): Promise<VisionReferenceImage> {
  const inserted = await client.query<{ id: string }>(`
    INSERT INTO app.product_variant_images (
      merchant_id,
      store_id,
      product_id,
      variant_id,
      image_url,
      image_type,
      source,
      quality_status,
      is_primary,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
    ON CONFLICT (merchant_id, (COALESCE(store_id, ''::text)), variant_id, image_url)
    DO UPDATE SET
      image_type = EXCLUDED.image_type,
      source = EXCLUDED.source,
      quality_status = EXCLUDED.quality_status,
      is_primary = EXCLUDED.is_primary,
      metadata = app.product_variant_images.metadata || EXCLUDED.metadata,
      updated_at = now()
    RETURNING id
  `, [
    input.merchantId,
    input.storeId,
    input.productId,
    input.variantId,
    input.imageUrl,
    input.imageType,
    input.source,
    input.qualityStatus,
    input.isPrimary,
    JSON.stringify(input.metadata),
  ]);

  return getReferenceImageById(client, { merchantId: input.merchantId, imageId: inserted.rows[0].id });
}

export async function syncVisionReferenceImagesFromProductMetadata(
  input: { merchantId: string; storeId?: string },
): Promise<VisionReferenceImageSyncResult> {
  const merchantId = normalizeRequiredId(input.merchantId, "merchantId");
  const storeId = optionalText(input.storeId);

  return withActiveReferenceTransaction(merchantId, storeId, async (client) => {
    const targetStoreId = storeId ?? (await client.query<{ id: string }>(`SELECT id FROM app.stores
      WHERE merchant_id=$1 AND status='active' AND is_primary=true ORDER BY id LIMIT 1 FOR SHARE`, [merchantId])).rows[0]?.id ?? null;
    const result = await client.query<{
      inserted_count: string | number;
      total_products_with_image_url: string | number;
    }>(`
      WITH inserted AS (
        INSERT INTO app.product_variant_images (
          merchant_id,
          store_id,
          product_id,
          variant_id,
          image_url,
          image_type,
          source,
          quality_status,
          is_primary,
          metadata
        )
        SELECT
          p.merchant_id,
          s.id AS store_id,
          p.id AS product_id,
          v.id AS variant_id,
          p.metadata->>'imageUrl' AS image_url,
          'primary' AS image_type,
          'metadata_backfill' AS source,
          'pending' AS quality_status,
          true AS is_primary,
          jsonb_build_object('source', 'public.product.metadata.imageUrl')
        FROM public.product p
        JOIN public.product_variant v
          ON v.product_id = p.id
         AND v.deleted_at IS NULL
        LEFT JOIN app.stores s ON s.id=$2::text AND s.merchant_id=p.merchant_id
        WHERE p.deleted_at IS NULL
          AND p.merchant_id = $1
          AND COALESCE(p.metadata->>'imageUrl', '') <> ''
          AND NOT EXISTS (
            SELECT 1
            FROM app.product_variant_images existing
            WHERE existing.merchant_id = p.merchant_id
              AND existing.store_id IS NOT DISTINCT FROM s.id
              AND existing.variant_id = v.id
              AND existing.image_url = p.metadata->>'imageUrl'
          )
        RETURNING id
      ),
      totals AS (
        SELECT count(*)::int AS total_products_with_image_url
        FROM public.product p
        WHERE p.deleted_at IS NULL
          AND p.merchant_id = $1
          AND COALESCE(p.metadata->>'imageUrl', '') <> ''
      )
      SELECT
        (SELECT count(*)::int FROM inserted) AS inserted_count,
        totals.total_products_with_image_url
      FROM totals
    `, [merchantId, targetStoreId]);

    const row = result.rows[0] || { inserted_count: 0, total_products_with_image_url: 0 };
    return {
      insertedCount: toNumber(row.inserted_count),
      totalProductsWithImageUrl: toNumber(row.total_products_with_image_url),
    };
  });
}

export async function createVisionReferenceImage(input: VisionReferenceImageCreateInput): Promise<VisionReferenceImage> {
  const merchantId = normalizeRequiredId(input.merchantId, "merchantId");
  const variantId = normalizeRequiredId(input.variantId, "variantId");
  const requestedProductId = optionalText(input.productId);
  const storeId = optionalText(input.storeId);
  const imageUrl = normalizeReferenceImageUrl(input.imageUrl);
  if (!imageUrl) throw new PlatformError("validation_error", "imageUrl is required", 400);
  const imageType = normalizedEnum(input.imageType, imageTypes, "front", "imageType");
  const source = normalizedEnum(input.source, imageSources, "manual", "source");
  const qualityStatus = normalizedEnum(input.qualityStatus, qualityStatuses, "pending", "qualityStatus");
  const isPrimary = toBoolean(input.isPrimary);
  if (isPrimary && qualityStatus === "rejected") {
    throw new PlatformError("validation_error", "Rejected reference images cannot be primary", 400);
  }

  return withActiveReferenceTransaction(merchantId, storeId, async (client) => {
    await assertReferenceStore(client, merchantId, storeId);
    const variant = await resolveReferenceVariant(client, { merchantId, productId: requestedProductId, variantId });
    if (isPrimary) await clearPrimaryReferenceImage(client, { merchantId, storeId, variantId: variant.variantId });

    return insertReferenceImage(client, {
      merchantId,
      storeId,
      productId: variant.productId,
      variantId: variant.variantId,
      imageUrl,
      imageType,
      source,
      qualityStatus,
      isPrimary,
      metadata: optionalRecord(input.metadata),
    });
  });
}

export async function uploadVisionReferenceImage(input: VisionReferenceImageUploadInput): Promise<VisionReferenceImage> {
  const merchantId = normalizeRequiredId(input.merchantId, "merchantId");
  const variantId = normalizeRequiredId(input.variantId, "variantId");
  const requestedProductId = optionalText(input.productId);
  const storeId = optionalText(input.storeId);
  const imageType = normalizedEnum(input.imageType, imageTypes, "counter_capture", "imageType");
  const qualityStatus = normalizedEnum(input.qualityStatus, qualityStatuses, "pending", "qualityStatus");
  const isPrimary = toBoolean(input.isPrimary);
  if (isPrimary && qualityStatus === "rejected") {
    throw new PlatformError("validation_error", "Rejected reference images cannot be primary", 400);
  }
  const decoded = decodeReferenceImageUpload(input);

  return withActiveReferenceTransaction(merchantId, storeId, async (client) => {
    await assertReferenceStore(client, merchantId, storeId);
    const variant = await resolveReferenceVariant(client, { merchantId, productId: requestedProductId, variantId });
    const upload = await uploadReferenceImageObject({
      merchantId,
      storeId,
      variantId: variant.variantId,
      fileName: optionalText(input.fileName),
      bytes: decoded.bytes,
      contentType: decoded.contentType,
      extension: decoded.extension,
    });
    if (isPrimary) await clearPrimaryReferenceImage(client, { merchantId, storeId, variantId: variant.variantId });

    return insertReferenceImage(client, {
      merchantId,
      storeId,
      productId: variant.productId,
      variantId: variant.variantId,
      imageUrl: upload.gcsUri,
      imageType,
      source: "manual",
      qualityStatus,
      isPrimary,
      metadata: {
        ...optionalRecord(input.metadata),
        source: "vision_reference_upload",
        gcsBucket: upload.bucket,
        gcsObjectName: upload.objectName,
        originalFileName: optionalText(input.fileName),
        contentType: decoded.contentType,
        byteLength: decoded.bytes.length,
      },
    });
  });
}

export async function updateVisionReferenceImage(input: VisionReferenceImageUpdateInput): Promise<VisionReferenceImage> {
  const merchantId = normalizeRequiredId(input.merchantId, "merchantId");
  const imageId = normalizeRequiredId(input.imageId, "imageId");
  const imageType = input.imageType === undefined
    ? null
    : normalizedEnum(input.imageType, imageTypes, "front", "imageType");
  const qualityStatus = input.qualityStatus === undefined
    ? null
    : normalizedEnum(input.qualityStatus, qualityStatuses, "pending", "qualityStatus");
  const requestedPrimary = input.isPrimary === undefined ? null : toBoolean(input.isPrimary);
  if (requestedPrimary === true && qualityStatus === "rejected") {
    throw new PlatformError("validation_error", "Rejected reference images cannot be primary", 400);
  }
  const isPrimary = qualityStatus === "rejected" ? false : requestedPrimary;

  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const existing = await getReferenceImageById(client, { merchantId, imageId });
    await lockActiveBusinessScopeForClient(client, existing.storeId ? { scopeType: "store", merchantId, storeId: existing.storeId } : { scopeType: "merchant", merchantId });
    const locked = await client.query("SELECT id FROM app.product_variant_images WHERE merchant_id=$1 AND id=$2 AND store_id IS NOT DISTINCT FROM $3 FOR UPDATE", [merchantId, imageId, existing.storeId]);
    if (!locked.rows[0]) throw new PlatformError("scope_changed", "Reference image scope changed; reload before editing", 409);
    if (isPrimary === true) {
      await clearPrimaryReferenceImage(client, {
        merchantId,
        storeId: existing.storeId,
        variantId: existing.variantId,
        excludeImageId: imageId,
      });
    }

    await client.query(`
      UPDATE app.product_variant_images
      SET image_type = COALESCE($3::text, image_type),
          quality_status = COALESCE($4::text, quality_status),
          is_primary = COALESCE($5::boolean, is_primary),
          metadata = CASE
            WHEN $6::jsonb IS NULL THEN metadata
            ELSE metadata || $6::jsonb
          END,
          updated_at = now()
      WHERE merchant_id = $1
        AND id = $2::uuid
    `, [
      merchantId,
      imageId,
      imageType,
      qualityStatus,
      isPrimary,
      input.metadata === undefined ? null : JSON.stringify(optionalRecord(input.metadata)),
    ]);

    return getReferenceImageById(client, { merchantId, imageId });
  });
}

export async function listVisionCatalogReadiness(
  query: VisionCatalogReadinessQuery,
): Promise<VisionCatalogReadinessItem[]> {
  const merchantId = normalizeRequiredId(query.merchantId, "merchantId");
  const storeId = optionalText(query.storeId);
  const provider = optionalText(query.provider);
  const term = optionalText(query.q);
  const likeTerm = term ? `%${term.toLowerCase()}%` : null;
  const limit = toLimit(query.limit);
  const offset = toOffset(query.offset);

  return withClient(async (client) => {
    const result = await client.query(`
      SELECT
        p.id AS product_id,
        v.id AS variant_id,
        p.title,
        p.status,
        COALESCE(v.sku, '') AS sku,
        COALESCE(v.barcode, '') AS barcode,
        COALESCE(p.metadata->>'imageUrl', '') AS metadata_image_url,
        COALESCE(images.primary_image_id::text, '') AS primary_image_id,
        COALESCE(images.primary_image_url, '') AS primary_image_url,
        COALESCE(images.reference_image_count, 0)::int AS reference_image_count,
        COALESCE(images.approved_image_count, 0)::int AS approved_image_count,
        COALESCE(images.pending_image_count, 0)::int AS pending_image_count,
        COALESCE(images.rejected_image_count, 0)::int AS rejected_image_count,
        COALESCE(images.approved_front_image_count, 0)::int AS approved_front_image_count,
        COALESCE(images.approved_counter_capture_image_count, 0)::int AS approved_counter_capture_image_count,
        COALESCE(images.approved_strength_text_image_count, 0)::int AS approved_strength_text_image_count,
        COALESCE(images.pending_front_image_count, 0)::int AS pending_front_image_count,
        COALESCE(images.pending_counter_capture_image_count, 0)::int AS pending_counter_capture_image_count,
        COALESCE(images.pending_strength_text_image_count, 0)::int AS pending_strength_text_image_count,
        COALESCE(index_items.indexed_image_count, 0)::int AS indexed_image_count,
        COALESCE(index_items.synced_image_count, 0)::int AS synced_image_count,
        COALESCE(index_items.failed_index_count, 0)::int AS failed_index_count,
        CASE
          WHEN lower(COALESCE(p.metadata->>'visionHighRisk', '')) IN ('false', '0', 'no') THEN false
          ELSE true
        END AS is_high_risk_variant
      FROM public.product p
      JOIN public.product_variant v
        ON v.product_id = p.id
       AND v.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT
          count(*) AS reference_image_count,
          count(*) FILTER (WHERE quality_status = 'approved') AS approved_image_count,
          count(*) FILTER (WHERE quality_status = 'pending') AS pending_image_count,
          count(*) FILTER (WHERE quality_status = 'rejected') AS rejected_image_count,
          count(*) FILTER (WHERE quality_status = 'approved' AND (image_type IN ('front', 'primary') OR is_primary)) AS approved_front_image_count,
          count(*) FILTER (WHERE quality_status = 'approved' AND image_type = 'counter_capture') AS approved_counter_capture_image_count,
          count(*) FILTER (WHERE quality_status = 'approved' AND image_type = 'strength_text') AS approved_strength_text_image_count,
          count(*) FILTER (WHERE quality_status = 'pending' AND (image_type IN ('front', 'primary') OR is_primary)) AS pending_front_image_count,
          count(*) FILTER (WHERE quality_status = 'pending' AND image_type = 'counter_capture') AS pending_counter_capture_image_count,
          count(*) FILTER (WHERE quality_status = 'pending' AND image_type = 'strength_text') AS pending_strength_text_image_count,
          (array_agg(id ORDER BY is_primary DESC, created_at ASC))[1] AS primary_image_id,
          (array_agg(image_url ORDER BY is_primary DESC, created_at ASC))[1] AS primary_image_url
        FROM app.product_variant_images image
        WHERE image.merchant_id = p.merchant_id
          AND image.variant_id = v.id
          AND ($2::text IS NULL OR image.store_id IS NULL OR image.store_id = $2::text)
      ) images ON true
      LEFT JOIN LATERAL (
        SELECT
          count(*) AS indexed_image_count,
          count(*) FILTER (WHERE sync_status = 'synced') AS synced_image_count,
          count(*) FILTER (WHERE sync_status = 'failed') AS failed_index_count
        FROM app.vision_catalog_index_items item
        WHERE item.merchant_id = p.merchant_id
          AND item.variant_id = v.id
          AND ($2::text IS NULL OR item.store_id IS NULL OR item.store_id = $2::text)
          AND ($3::text IS NULL OR item.provider = $3::text)
      ) index_items ON true
      WHERE p.deleted_at IS NULL
        AND p.merchant_id = $1
        AND ($4::text IS NULL OR (
          lower(p.title) LIKE $4::text
          OR lower(COALESCE(v.sku, '')) LIKE $4::text
          OR lower(COALESCE(v.barcode, '')) LIKE $4::text
        ))
      ORDER BY p.title ASC, COALESCE(v.variant_rank, 0) ASC, v.id ASC
      LIMIT $5 OFFSET $6
    `, [merchantId, storeId, provider, likeTerm, limit, offset]);

    return result.rows.map((row) => mapReadinessRow(row as Record<string, unknown>));
  });
}

export async function listVisionReferenceImagesForProvider(
  query: VisionReferenceImageProviderQuery,
): Promise<VisionReferenceImage[]> {
  const merchantId = normalizeRequiredId(query.merchantId, "merchantId");
  const storeId = optionalText(query.storeId);
  const provider = optionalText(query.provider);
  const includePending = toBoolean(query.includePending);
  const limit = toLimit(query.limit, 500);
  const offset = toOffset(query.offset);

  return withClient(async (client) => {
    const result = await client.query(`
      SELECT
        image.id AS image_id,
        image.merchant_id,
        image.store_id,
        image.product_id,
        image.variant_id,
        p.title,
        COALESCE(v.sku, '') AS sku,
        COALESCE(v.barcode, '') AS barcode,
        image.image_url,
        image.image_type,
        image.quality_status,
        image.is_primary,
        COALESCE(index_item.provider_product_ref, '') AS provider_product_ref,
        COALESCE(index_item.provider_image_ref, '') AS provider_image_ref,
        image.created_at,
        image.updated_at
      FROM app.product_variant_images image
      JOIN public.product p
        ON p.id = image.product_id
       AND p.deleted_at IS NULL
      JOIN public.product_variant v
        ON v.id = image.variant_id
       AND v.deleted_at IS NULL
      LEFT JOIN app.vision_catalog_index_items index_item
        ON index_item.image_id = image.id
       AND index_item.merchant_id = image.merchant_id
       AND ($3::text IS NULL OR index_item.provider = $3::text)
      WHERE image.merchant_id = $1
        AND ($2::text IS NULL OR image.store_id IS NULL OR image.store_id = $2::text)
        AND (
          image.quality_status = 'approved'
          OR ($4::boolean = true AND image.quality_status = 'pending')
        )
      ORDER BY p.title ASC, image.is_primary DESC, image.created_at ASC
      LIMIT $5 OFFSET $6
    `, [merchantId, storeId, provider, includePending, limit, offset]);

    return result.rows.map((row) => mapReferenceImageRow(row as Record<string, unknown>));
  });
}
