import { createHash } from "node:crypto";
import type { OperatingScope } from "@medusa-snus/contracts";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import { queryOne } from "../db/query";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import type { HeadersLike } from "../http/headers";
import { requireFeatureCapability } from "./feature-entitlement-service";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import { resolveProductScan, type ProductQrActor, type ProductScanResolution } from "./product-qr-service";
import { normalizeVisionImageBase64 } from "./vision-image-validation";
import { storeRawVisionScanImages, type VisionStoredObject } from "./vision-image-storage-service";

export type VisionScanMode = "single" | "bulk";
export type VisionDetectionSource = "qr" | "barcode" | "vision_provider" | "manual";
export type VisionDetectionType = "exact_match" | "candidate_match" | "unresolved";

export interface VisionProviderCandidateInput {
  variantId?: string;
  productId?: string;
  sku?: string;
  barcode?: string;
  providerProductRef?: string;
  providerImageRef?: string;
  confidence?: number;
  bbox?: Record<string, unknown>;
  warnings?: string[];
}

export interface VisionProviderDetectionInput {
  objectId?: string;
  bbox?: Record<string, unknown>;
  objectLabel?: string;
  objectConfidence?: number;
  candidates?: VisionProviderCandidateInput[];
  warnings?: string[];
}

export interface VisionScanInput {
  mode?: VisionScanMode;
  clientScanId?: string;
  imageBase64?: string;
  imageBase64List?: string[];
  imageHash?: string;
  qrCodes?: string[];
  providerCandidates?: VisionProviderCandidateInput[];
}

export interface VisionScanProviderOptions {
  providerHeaders?: HeadersLike;
  allowProviderCandidates?: boolean;
}

export interface VisionCandidateView {
  productId: string;
  variantId: string;
  title: string;
  sku: string;
  barcode: string;
  imageUrl: string;
  price: number;
  stock: number;
  confidence: number;
  source: VisionDetectionSource;
  providerProductRef?: string;
  providerImageRef?: string;
  warnings: string[];
}

export interface VisionDetectionView {
  detectionId: string;
  objectId: string;
  bbox?: Record<string, unknown>;
  objectOrder?: number;
  providerObjectLabel?: string;
  providerObjectConfidence?: number;
  source: VisionDetectionSource;
  detectionType: VisionDetectionType;
  resolvedVariantId: string;
  confidence: number | null;
  candidates: VisionCandidateView[];
  requiresConfirmation: boolean;
  decision: "pending" | "accepted" | "corrected" | "rejected" | "unresolved";
  warnings: string[];
}

export interface VisionScanResult {
  data: {
    scanId: string;
    mode: VisionScanMode;
    status: "success" | "partial" | "failed";
    provider: string;
    modelVersion: string;
    requiresStaffConfirmation: true;
    detections: VisionDetectionView[];
  };
}

export interface VisionCorrectionInput {
  detectionId?: string;
  selectedVariantId?: string;
  previousVariantId?: string;
  correctionType?: "staff_accepted" | "staff_selected_correct_variant" | "staff_rejected" | "manual_search_selected";
  metadata?: Record<string, unknown>;
}

export interface VisionCorrectionResult {
  data: {
    correctionId: string;
    scanId: string;
    detectionId: string | null;
    selectedVariantId: string | null;
    previousVariantId: string | null;
    correctionType: string;
  };
}

export interface VisionScanReportQuery {
  merchantId: string;
  storeId?: string;
  dateFrom?: string;
  dateTo?: string;
  provider?: string;
  source?: VisionDetectionSource | string;
  decision?: VisionDetectionView["decision"] | string;
  variantId?: string;
  limit?: number | string;
  offset?: number | string;
}

export interface VisionScanReportItem {
  scanId: string;
  detectionId: string;
  createdAt: string;
  merchantId: string;
  storeId: string;
  operatorId: string;
  mode: VisionScanMode;
  status: string;
  provider: string;
  modelVersion: string;
  latencyMs: number;
  imageHash: string;
  objectId: string;
  source: VisionDetectionSource;
  detectionType: VisionDetectionType;
  confidence: number | null;
  decision: VisionDetectionView["decision"];
  suggestedVariantId: string;
  suggestedTitle: string;
  suggestedSku: string;
  selectedVariantId: string;
  selectedTitle: string;
  selectedSku: string;
  correctionType: string;
  correctedAt: string;
  warnings: string[];
  candidateCount: number;
}

export interface VisionScanReportResult {
  data: VisionScanReportItem[];
  meta: {
    limit: number;
    offset: number;
    count: number;
  };
}

interface VisionRuntimeConfig {
  enabled: boolean;
  killSwitch: boolean;
  provider: "disabled" | "noop" | "google_product_search" | "google_vision_ocr";
  singleCaptureEnabled: boolean;
  bulkCaptureEnabled: boolean;
  dailyScanLimitPerStore: number;
  scanRateLimitWindowSeconds: number;
  scanRateLimitPerOperator: number;
  monthlyBudgetVnd: number;
  estimatedProviderScanCostVnd: number;
  maxImageBytes: number;
}

const MAX_SCAN_IMAGE_COUNT = 4;

interface HydratedVariantRow extends Record<string, unknown> {
  product_id: string;
  variant_id: string;
  title: string;
  image_url: string | null;
  sku: string | null;
  barcode: string | null;
  price: string | number | null;
  stock: string | number | null;
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value === "true";
}

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] || fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function limitFromInput(value: string | number | undefined, fallback = 100): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), 500);
}

function offsetFromInput(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

function loadVisionRuntimeConfig(): VisionRuntimeConfig {
  const provider = String(process.env.VISION_PROVIDER || "noop").trim();
  return {
    enabled: envFlag("VISION_FEATURE_ENABLED", false),
    killSwitch: envFlag("VISION_KILL_SWITCH", false),
    provider: provider === "google_product_search" || provider === "google_vision_ocr" || provider === "disabled" ? provider : "noop",
    singleCaptureEnabled: envFlag("VISION_POS_SINGLE_CAPTURE_ENABLED", true),
    bulkCaptureEnabled: envFlag("VISION_POS_BULK_CAPTURE_ENABLED", false),
    dailyScanLimitPerStore: positiveIntEnv("VISION_DAILY_SCAN_LIMIT_PER_STORE", 300),
    scanRateLimitWindowSeconds: positiveIntEnv("VISION_SCAN_RATE_LIMIT_WINDOW_SECONDS", 60),
    scanRateLimitPerOperator: positiveIntEnv("VISION_SCAN_RATE_LIMIT_PER_OPERATOR", 30),
    monthlyBudgetVnd: Number(process.env.VISION_MONTHLY_BUDGET_VND || 0),
    estimatedProviderScanCostVnd: positiveIntEnv("VISION_ESTIMATED_PROVIDER_SCAN_COST_VND", 200),
    maxImageBytes: positiveIntEnv("VISION_MAX_IMAGE_BYTES", 6 * 1024 * 1024),
  };
}

function normalizeMode(value: unknown): VisionScanMode {
  const mode = String(value || "single").trim();
  if (mode === "single" || mode === "bulk") return mode;
  throw new PlatformError("validation_error", "mode must be single or bulk", 400);
}

function optionalText(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function optionalIsoDate(value: unknown): string | null {
  const normalized = optionalText(value);
  if (!normalized) return null;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? normalized : null;
}

function normalizeQrCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean))).slice(0, 10);
}

function normalizeConfidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function imagePayloadsFromInput(input: VisionScanInput): string[] {
  const list = Array.isArray(input.imageBase64List)
    ? input.imageBase64List.map((item) => optionalText(item)).filter((item): item is string => Boolean(item))
    : [];
  if (list.length > 0) return Array.from(new Set(list));
  const single = optionalText(input.imageBase64);
  return single ? [single] : [];
}

function normalizedImagesFromInput(
  input: VisionScanInput,
  maxImageBytes: number,
): { imageHash: string; imageBase64List: string[]; imageCount: number } {
  const imageBase64List = imagePayloadsFromInput(input);
  if (imageBase64List.length > MAX_SCAN_IMAGE_COUNT) {
    throw new PlatformError("validation_error", `imageBase64List supports up to ${MAX_SCAN_IMAGE_COUNT} images`, 400);
  }

  if (imageBase64List.length > 0) {
    const hash = createHash("sha256");
    for (const imageBase64 of imageBase64List) {
      const image = normalizeVisionImageBase64(imageBase64, { maxBytes: maxImageBytes });
      hash.update(image.buffer);
      hash.update("\n");
    }
    return {
      imageHash: hash.digest("hex"),
      imageBase64List,
      imageCount: imageBase64List.length,
    };
  }

  const explicitHash = optionalText(input.imageHash);
  if (explicitHash) return { imageHash: explicitHash, imageBase64List: [], imageCount: 0 };
  if (normalizeQrCodes(input.qrCodes).length > 0) return { imageHash: "qr-only", imageBase64List: [], imageCount: 0 };
  throw new PlatformError("validation_error", "imageBase64 or imageHash is required", 400);
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedClient(fn);
}

async function withActiveVisionTransaction<T>(scope: OperatingScope, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async client => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
    return fn(client);
  });
}

async function assertVisionEntitled(scope: OperatingScope, mode: VisionScanMode, client: PoolClient): Promise<void> {
  await requireFeatureCapability("vision_pos_input", { merchantId: scope.merchantId, client });
  if (mode === "single") {
    await requireFeatureCapability("vision_pos_single_capture", { merchantId: scope.merchantId, client });
  }
  if (mode === "bulk") {
    await requireFeatureCapability("vision_pos_bulk_capture", { merchantId: scope.merchantId, client });
  }
}

async function enforceDailyLimit(client: PoolClient, scope: OperatingScope, limit: number): Promise<void> {
  const row = await queryOne<{ count: string | number }>(client, `
    SELECT count(*)::int AS count
    FROM app.vision_scan_events
    WHERE merchant_id = $1
      AND store_id = $2
      AND created_at >= date_trunc('day', now())
  `, [scope.merchantId, scope.storeId]);
  if (Number(row?.count || 0) >= limit) {
    throw new PlatformError("vision_scan_limit_exceeded", "Daily vision scan limit exceeded for this store", 429, { limit });
  }
}

async function enforceScanRateLimit(
  client: PoolClient,
  scope: OperatingScope,
  actor: ProductQrActor | undefined,
  windowSeconds: number,
  limit: number,
): Promise<void> {
  const operatorId = optionalText(actor?.operatorId);
  const row = await queryOne<{ count: string | number }>(client, `
    SELECT count(*)::int AS count
    FROM app.vision_scan_events
    WHERE merchant_id = $1
      AND store_id = $2
      AND ($3::text IS NULL OR operator_id = $3)
      AND created_at >= now() - ($4::int * interval '1 second')
  `, [scope.merchantId, scope.storeId, operatorId, windowSeconds]);
  if (Number(row?.count || 0) >= limit) {
    throw new PlatformError("vision_scan_rate_limited", "Too many vision scans in a short window", 429, {
      limit,
      windowSeconds,
      operatorScoped: Boolean(operatorId),
    });
  }
}

function usesExternalVisionProvider(provider: VisionRuntimeConfig["provider"]): boolean {
  return provider === "google_product_search" || provider === "google_vision_ocr";
}

async function monthlyProviderBudgetExceeded(
  client: PoolClient,
  scope: OperatingScope,
  config: VisionRuntimeConfig,
): Promise<boolean> {
  if (!usesExternalVisionProvider(config.provider)) return false;
  if (!Number.isFinite(config.monthlyBudgetVnd) || config.monthlyBudgetVnd <= 0) return false;
  if (!Number.isFinite(config.estimatedProviderScanCostVnd) || config.estimatedProviderScanCostVnd <= 0) return false;

  const maxProviderScans = Math.floor(config.monthlyBudgetVnd / config.estimatedProviderScanCostVnd);
  if (maxProviderScans <= 0) return true;

  const row = await queryOne<{ count: string | number }>(client, `
    SELECT count(*)::int AS count
    FROM app.vision_scan_events
    WHERE merchant_id = $1
      AND store_id = $2
      AND provider = ANY($3::text[])
      AND created_at >= date_trunc('month', now())
  `, [scope.merchantId, scope.storeId, ["google_product_search", "google_vision_ocr"]]);
  return Number(row?.count || 0) >= maxProviderScans;
}

function actorFromRequest(actor?: ProductQrActor): ProductQrActor {
  return {
    operatorId: actor?.operatorId,
    type: actor?.type,
    role: actor?.role,
  };
}

async function resolveFirstQrCode(
  qrCodes: string[],
  scope: OperatingScope,
  client: PoolClient,
  actor?: ProductQrActor,
): Promise<ProductScanResolution | null> {
  for (const code of qrCodes) {
    try {
      const result = await resolveProductScan({ code, context: "pos_add_to_cart" }, scope, actorFromRequest(actor), { client });
      return result.data;
    } catch (error) {
      if (!(error instanceof PlatformError) || error.statusCode >= 500) throw error;
    }
  }
  return null;
}

function candidateFromResolution(resolution: ProductScanResolution): VisionCandidateView {
  return {
    productId: resolution.productId,
    variantId: resolution.variantId,
    title: resolution.title,
    sku: resolution.sku,
    barcode: resolution.barcode,
    imageUrl: resolution.imageUrl,
    price: resolution.price,
    stock: resolution.stock,
    confidence: 1,
    source: resolution.resolutionSource === "qr" ? "qr" : "barcode",
    warnings: [],
  };
}

function uniqueCandidateInputs(inputs: VisionProviderCandidateInput[] | undefined): VisionProviderCandidateInput[] {
  if (!Array.isArray(inputs)) return [];
  const seen = new Set<string>();
  const normalized: VisionProviderCandidateInput[] = [];
  for (const input of inputs) {
    const key = [
      optionalText(input.variantId) || "",
      optionalText(input.sku) || "",
      optionalText(input.barcode) || "",
      optionalText(input.providerProductRef) || "",
    ].join("|");
    if (key === "|||") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(input);
  }
  return normalized.slice(0, 10);
}

function uniqueProviderDetections(inputs: VisionProviderDetectionInput[] | undefined): VisionProviderDetectionInput[] {
  if (!Array.isArray(inputs)) return [];
  return inputs
    .map((input, index) => ({
      ...input,
      objectId: optionalText(input.objectId) || `obj_${index + 1}`,
      candidates: uniqueCandidateInputs(input.candidates),
      warnings: Array.isArray(input.warnings) ? input.warnings.map((item) => String(item || "")).filter(Boolean) : [],
    }))
    .filter((input) => (input.candidates || []).length > 0 || input.bbox)
    .slice(0, 12);
}

function aiBaseUrl(): string {
  return (process.env.VISION_AI_BASE_URL || process.env.AI_BASE_URL || `http://localhost:${process.env.AI_PORT || "3002"}`).replace(/\/+$/, "");
}

function headerText(headers: HeadersLike | undefined, name: string): string {
  if (!headers) return "";
  const value = headers[name] ?? headers[name.toLowerCase()];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim() : "";
}

function forwardedProviderHeaders(headers: HeadersLike | undefined, scope: OperatingScope): Record<string, string> {
  const outgoing: Record<string, string> = {
    "Content-Type": "application/json",
    "x-operating-merchant-id": scope.merchantId,
    "x-operating-store-id": scope.storeId,
  };
  const authorization = headerText(headers, "authorization");
  if (authorization) outgoing.authorization = authorization;
  return outgoing;
}

async function requestSidecarProductSearchCandidates(
  input: VisionScanInput,
  imageBase64List: string[],
  scope: OperatingScope,
  options: VisionScanProviderOptions | undefined,
): Promise<{
  candidates: VisionProviderCandidateInput[];
  detections: VisionProviderDetectionInput[];
  warnings: string[];
  modelVersion?: string;
}> {
  if (imageBase64List.length === 0) {
    return { candidates: [], detections: [], warnings: ["provider_image_missing"] };
  }

  const candidates: VisionProviderCandidateInput[] = [];
  const detections: VisionProviderDetectionInput[] = [];
  const warnings: string[] = [];
  const modelVersions = new Set<string>();

  for (let index = 0; index < imageBase64List.length; index += 1) {
    const warningPrefix = imageBase64List.length > 1 ? `image_${index + 1}:` : "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), positiveIntEnv("VISION_SCAN_TIMEOUT_MS", 2500));
    try {
      const response = await fetch(`${aiBaseUrl()}/ai/vision/product-search`, {
        method: "POST",
        signal: controller.signal,
        headers: forwardedProviderHeaders(options?.providerHeaders, scope),
        body: JSON.stringify({ imageBase64: imageBase64List[index] }),
      });
      const payload = await response.json().catch(() => ({})) as {
        data?: {
          candidates?: VisionProviderCandidateInput[];
          detections?: VisionProviderDetectionInput[];
          modelVersion?: string;
        };
        error?: { code?: string; message?: string };
      };
      if (!response.ok) {
        warnings.push(`${warningPrefix}provider_http_${response.status}`, payload.error?.code || "provider_error");
        continue;
      }
      if (Array.isArray(payload.data?.candidates)) {
        candidates.push(...payload.data.candidates.map((candidate) => ({
          ...candidate,
          warnings: Array.from(new Set([
            ...(candidate.warnings || []),
            ...(imageBase64List.length > 1 ? [`image_${index + 1}`] : []),
          ])),
        })));
      }
      if (Array.isArray(payload.data?.detections)) {
        detections.push(...payload.data.detections.map((detection, detectionIndex) => ({
          ...detection,
          objectId: [
            ...(imageBase64List.length > 1 ? [`image_${index + 1}`] : []),
            optionalText(detection.objectId) || `obj_${detectionIndex + 1}`,
          ].join("_") || `obj_${detectionIndex + 1}`,
          candidates: (detection.candidates || []).map((candidate) => ({
            ...candidate,
            warnings: Array.from(new Set([
              ...(candidate.warnings || []),
              ...(imageBase64List.length > 1 ? [`image_${index + 1}`] : []),
            ])),
          })),
          warnings: Array.from(new Set([
            ...(detection.warnings || []),
            ...(imageBase64List.length > 1 ? [`image_${index + 1}`] : []),
          ])),
        })));
      }
      const modelVersion = optionalText(payload.data?.modelVersion);
      if (modelVersion) modelVersions.add(modelVersion);
    } catch (error) {
      warnings.push(error instanceof Error && error.name === "AbortError"
        ? `${warningPrefix}provider_timeout`
        : `${warningPrefix}provider_unavailable`);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    candidates: uniqueCandidateInputs(candidates),
    detections: uniqueProviderDetections(detections),
    warnings: Array.from(new Set(warnings)),
    modelVersion: Array.from(modelVersions).join("+") || undefined,
  };
}

function matchInput(row: HydratedVariantRow, inputs: VisionProviderCandidateInput[]): VisionProviderCandidateInput | undefined {
  const variantId = String(row.variant_id || "");
  const sku = String(row.sku || "").toLowerCase();
  const barcode = String(row.barcode || "").toLowerCase();
  return inputs.find((input) => {
    if (optionalText(input.variantId) === variantId) return true;
    if (optionalText(input.sku)?.toLowerCase() === sku) return true;
    if (optionalText(input.barcode)?.toLowerCase() === barcode) return true;
    return false;
  });
}

async function hydrateProviderCandidates(
  client: PoolClient,
  scope: OperatingScope,
  inputs: VisionProviderCandidateInput[],
): Promise<VisionCandidateView[]> {
  if (inputs.length === 0) return [];
  const variantIds = inputs.map((input) => optionalText(input.variantId)).filter((value): value is string => Boolean(value));
  const skus = inputs.map((input) => optionalText(input.sku)?.toLowerCase()).filter((value): value is string => Boolean(value));
  const barcodes = inputs.map((input) => optionalText(input.barcode)?.toLowerCase()).filter((value): value is string => Boolean(value));
  const providerRefs = inputs.map((input) => optionalText(input.providerProductRef)).filter((value): value is string => Boolean(value));

  const result = await client.query<HydratedVariantRow>(`
    SELECT DISTINCT ON (v.id)
      p.id AS product_id,
      v.id AS variant_id,
      p.title,
      p.metadata->>'imageUrl' AS image_url,
      COALESCE(v.sku, '') AS sku,
      COALESCE(v.barcode, '') AS barcode,
      COALESCE(pr.amount, 0)::numeric AS price,
      COALESCE(il.stocked_quantity, 0)::numeric AS stock
    FROM public.product p
    JOIN public.product_variant v
      ON v.product_id = p.id
     AND v.deleted_at IS NULL
    LEFT JOIN app.vision_catalog_index_items index_item
      ON index_item.merchant_id = p.merchant_id
     AND index_item.variant_id = v.id
    LEFT JOIN public.product_variant_price_set vps
      ON vps.variant_id = v.id AND vps.deleted_at IS NULL
    LEFT JOIN public.price pr
      ON pr.price_set_id = vps.price_set_id
     AND pr.currency_code = 'vnd'
     AND pr.deleted_at IS NULL
    JOIN public.product_variant_inventory_item pvii
      ON pvii.variant_id = v.id AND pvii.deleted_at IS NULL
    LEFT JOIN public.inventory_level il
      ON il.inventory_item_id = pvii.inventory_item_id
     AND il.location_id = $2
     AND il.deleted_at IS NULL
    WHERE p.deleted_at IS NULL
      AND p.status = 'published'
      AND p.merchant_id = $1
      AND (
        v.id = ANY($3::text[])
        OR lower(COALESCE(v.sku, '')) = ANY($4::text[])
        OR lower(COALESCE(v.barcode, '')) = ANY($5::text[])
        OR index_item.provider_product_ref = ANY($6::text[])
      )
    ORDER BY v.id
  `, [scope.merchantId, scope.stockLocationId, variantIds, skus, barcodes, providerRefs]);

  return result.rows.map((row): VisionCandidateView => {
    const input = matchInput(row, inputs) || {};
    return {
      productId: String(row.product_id || ""),
      variantId: String(row.variant_id || ""),
      title: String(row.title || ""),
      sku: String(row.sku || ""),
      barcode: String(row.barcode || ""),
      imageUrl: String(row.image_url || ""),
      price: Number(row.price || 0),
      stock: Number(row.stock || 0),
      confidence: normalizeConfidence(input.confidence),
      source: "vision_provider",
      providerProductRef: optionalText(input.providerProductRef) || undefined,
      providerImageRef: optionalText(input.providerImageRef) || undefined,
      warnings: Array.isArray(input.warnings) ? input.warnings.map((item) => String(item || "")).filter(Boolean) : [],
    };
  }).sort((a, b) => b.confidence - a.confidence);
}

async function insertScanEvent(
  client: PoolClient,
  input: {
    scope: OperatingScope;
    operatorId?: string;
    mode: VisionScanMode;
    status: "success" | "partial" | "failed";
    clientScanId: string | null;
    imageHash: string;
    rawImageStorageKey?: string | null;
    qrDetectedCount: number;
    aiDetectedCount: number;
    unresolvedCount: number;
    provider: string;
    modelVersion: string | null;
    latencyMs: number;
    metadata: Record<string, unknown>;
  },
): Promise<string> {
  const row = await queryOne<{ id: string }>(client, `
    INSERT INTO app.vision_scan_events (
      merchant_id,
      store_id,
      operator_id,
      mode,
      status,
      client_scan_id,
      image_hash,
      raw_image_storage_key,
      qr_detected_count,
      ai_detected_count,
      unresolved_count,
      latency_ms,
      provider,
      model_version,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
    RETURNING id
  `, [
    input.scope.merchantId,
    input.scope.storeId,
    input.operatorId || null,
    input.mode,
    input.status,
    input.clientScanId,
    input.imageHash,
    input.rawImageStorageKey || null,
    input.qrDetectedCount,
    input.aiDetectedCount,
    input.unresolvedCount,
    input.latencyMs,
    input.provider,
    input.modelVersion,
    JSON.stringify(input.metadata),
  ]);
  if (!row) throw new PlatformError("internal_error", "Unable to create vision scan event", 500);
  return String(row.id);
}

async function insertScanImageArtifacts(
  client: PoolClient,
  input: {
    scope: OperatingScope;
    scanId: string;
    imageHash: string;
    objects: VisionStoredObject[];
  },
): Promise<void> {
  if (input.objects.length === 0) return;
  const ttlHours = positiveIntEnv("VISION_RAW_IMAGE_TTL_HOURS", 72);
  for (const object of input.objects) {
    await client.query(`
      INSERT INTO app.vision_scan_image_artifacts (
        merchant_id,
        store_id,
        scan_event_id,
        artifact_type,
        gcs_uri,
        storage_key,
        content_type,
        byte_size,
        image_hash,
        quality_status,
        retention_expires_at,
        metadata
      )
      VALUES ($1, $2, $3::uuid, 'raw_scan', $4, $5, $6, $7, $8, 'pending', now() + ($9::int * interval '1 hour'), $10::jsonb)
      ON CONFLICT (storage_key) DO NOTHING
    `, [
      input.scope.merchantId,
      input.scope.storeId,
      input.scanId,
      object.gcsUri,
      object.storageKey,
      object.contentType,
      object.byteSize,
      input.imageHash,
      ttlHours,
      JSON.stringify({ source: "vision_scan_raw_storage" }),
    ]);
  }
}

async function insertDetection(
  client: PoolClient,
  input: {
    scanId: string;
    objectId: string;
    source: VisionDetectionSource;
    detectionType: VisionDetectionType;
    resolvedVariantId?: string;
    confidence?: number | null;
    bbox?: Record<string, unknown>;
    objectOrder?: number;
    providerObjectLabel?: string;
    providerObjectConfidence?: number;
    candidates: VisionCandidateView[];
    decision: VisionDetectionView["decision"];
    warnings: string[];
  },
): Promise<VisionDetectionView> {
  const row = await queryOne<{ id: string }>(client, `
    INSERT INTO app.vision_scan_detections (
      scan_event_id,
      object_id,
      bbox,
      source,
      detection_type,
      resolved_variant_id,
      confidence,
      candidates,
      requires_confirmation,
      decision,
      warnings
    )
    VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb, true, $9, $10::jsonb)
    RETURNING id
  `, [
    input.scanId,
    input.objectId,
    input.bbox ? JSON.stringify(input.bbox) : null,
    input.source,
    input.detectionType,
    input.resolvedVariantId || null,
    input.confidence ?? null,
    JSON.stringify(input.candidates),
    input.decision,
    JSON.stringify(input.warnings),
  ]);
  if (!row) throw new PlatformError("internal_error", "Unable to create vision detection", 500);
  return {
    detectionId: String(row.id),
    objectId: input.objectId,
    bbox: input.bbox,
    objectOrder: input.objectOrder,
    providerObjectLabel: input.providerObjectLabel,
    providerObjectConfidence: input.providerObjectConfidence,
    source: input.source,
    detectionType: input.detectionType,
    resolvedVariantId: input.resolvedVariantId || "",
    confidence: input.confidence ?? null,
    candidates: input.candidates,
    requiresConfirmation: true,
    decision: input.decision,
    warnings: input.warnings,
  };
}

export async function scanVisionProducts(
  input: VisionScanInput,
  scope: OperatingScope,
  actor?: ProductQrActor,
  options?: VisionScanProviderOptions,
): Promise<VisionScanResult> {
  const startedAt = Date.now();
  const config = loadVisionRuntimeConfig();
  const mode = normalizeMode(input.mode);
  if (config.killSwitch) throw new PlatformError("vision_disabled", "Vision scan is temporarily disabled", 503);
  if (!config.enabled) throw new PlatformError("feature_disabled", "Vision scan feature is disabled", 403);
  if (mode === "single" && !config.singleCaptureEnabled) throw new PlatformError("feature_disabled", "Single-product vision capture is disabled", 403);
  if (mode === "bulk" && !config.bulkCaptureEnabled) throw new PlatformError("feature_disabled", "Bulk vision capture is disabled for v1.4", 403);

  return withActiveVisionTransaction(scope, async (client) => {
    await assertVisionEntitled(scope, mode, client);
    const qrCodes = normalizeQrCodes(input.qrCodes);
    const { imageHash, imageBase64List, imageCount } = normalizedImagesFromInput(input, config.maxImageBytes);
    const clientScanId = optionalText(input.clientScanId);
    const exactResolution = await resolveFirstQrCode(qrCodes, scope, client, actor);
    const provider = exactResolution ? "qr_first" : config.provider;
    await enforceDailyLimit(client, scope, config.dailyScanLimitPerStore);
    await enforceScanRateLimit(
      client,
      scope,
      actor,
      config.scanRateLimitWindowSeconds,
      config.scanRateLimitPerOperator,
    );

    const pendingDetections: Array<{
      objectId: string;
      bbox?: Record<string, unknown>;
      objectOrder?: number;
      providerObjectLabel?: string;
      providerObjectConfidence?: number;
      source: VisionDetectionSource;
      detectionType: VisionDetectionType;
      resolvedVariantId?: string;
      confidence?: number | null;
      candidates: VisionCandidateView[];
      decision: VisionDetectionView["decision"];
      warnings: string[];
    }> = [];
    let warnings: string[] = [];
    let providerForEvent = provider;
    let modelVersion = exactResolution ? "product_qr_resolver" : provider;

    if (exactResolution) {
      const candidates = [candidateFromResolution(exactResolution)];
      pendingDetections.push({
        objectId: "obj_1",
        objectOrder: 1,
        source: candidates[0].source,
        detectionType: "exact_match",
        resolvedVariantId: candidates[0].variantId,
        confidence: 1,
        candidates,
        decision: "pending",
        warnings: [],
      });
    } else if (config.provider === "disabled") {
      modelVersion = "disabled";
      warnings = ["provider_disabled"];
      pendingDetections.push({
        objectId: "obj_1",
        objectOrder: 1,
        source: "vision_provider",
        detectionType: "unresolved",
        candidates: [],
        decision: "unresolved",
        warnings,
      });
    } else if (await monthlyProviderBudgetExceeded(client, scope, config)) {
      providerForEvent = "budget_guard";
      modelVersion = "budget_guard";
      warnings = ["monthly_budget_exceeded"];
      pendingDetections.push({
        objectId: "obj_1",
        objectOrder: 1,
        source: "vision_provider",
        detectionType: "unresolved",
        candidates: [],
        decision: "unresolved",
        warnings,
      });
    } else {
      let candidateInputs = options?.allowProviderCandidates
        ? uniqueCandidateInputs(input.providerCandidates)
        : [];
      let providerDetectionInputs: VisionProviderDetectionInput[] = [];
      if (usesExternalVisionProvider(config.provider)) {
        const providerResult = await requestSidecarProductSearchCandidates(input, imageBase64List, scope, options);
        candidateInputs = uniqueCandidateInputs([...candidateInputs, ...providerResult.candidates]);
        providerDetectionInputs = providerResult.detections;
        warnings = providerResult.warnings;
        modelVersion = providerResult.modelVersion || config.provider;
      }

      if (providerDetectionInputs.length > 0) {
        for (let index = 0; index < providerDetectionInputs.length; index += 1) {
          const providerDetection = providerDetectionInputs[index];
          const detectionCandidateInputs = uniqueCandidateInputs(
            (providerDetection.candidates || []).length > 0 ? providerDetection.candidates : candidateInputs,
          );
          const detectionCandidates = await hydrateProviderCandidates(client, scope, detectionCandidateInputs);
          const first = detectionCandidates[0];
          const detectionWarnings = Array.from(new Set([
            ...warnings,
            ...((providerDetection.warnings || []).map((item) => String(item || "")).filter(Boolean)),
          ]));
          pendingDetections.push({
            objectId: optionalText(providerDetection.objectId) || `obj_${index + 1}`,
            bbox: providerDetection.bbox,
            objectOrder: index + 1,
            providerObjectLabel: optionalText(providerDetection.objectLabel) || undefined,
            providerObjectConfidence: providerDetection.objectConfidence === undefined
              ? undefined
              : normalizeConfidence(providerDetection.objectConfidence),
            source: "vision_provider",
            detectionType: detectionCandidates.length > 0 ? "candidate_match" : "unresolved",
            resolvedVariantId: first?.variantId,
            confidence: first ? first.confidence : normalizeConfidence(providerDetection.objectConfidence),
            candidates: detectionCandidates,
            decision: detectionCandidates.length > 0 ? "pending" : "unresolved",
            warnings: detectionWarnings,
          });
        }
      } else {
        const candidates = await hydrateProviderCandidates(client, scope, candidateInputs);
        if (config.provider === "noop" && candidates.length === 0) warnings = ["provider_noop"];
        const first = candidates[0];
        pendingDetections.push({
          objectId: "obj_1",
          bbox: candidates.length > 0 ? { source: "full_image" } : undefined,
          objectOrder: 1,
          source: "vision_provider",
          detectionType: candidates.length > 0 ? "candidate_match" : "unresolved",
          resolvedVariantId: first?.variantId,
          confidence: first ? first.confidence : null,
          candidates,
          decision: candidates.length > 0 ? "pending" : "unresolved",
          warnings,
        });
      }
    }

    const rawStorageWarnings: string[] = [];
    let rawStorageObjects: VisionStoredObject[] = [];
    let rawImageStorageKey: string | null = null;
    try {
      const rawStorage = await storeRawVisionScanImages({
        merchantId: scope.merchantId,
        storeId: scope.storeId,
        imageBase64List,
        imageHash,
      });
      rawStorageObjects = rawStorage.objects;
      rawImageStorageKey = rawStorage.firstStorageKey;
    } catch {
      rawStorageWarnings.push("raw_image_storage_failed");
    }

    const detectedCount = pendingDetections.filter((detection) => detection.candidates.length > 0).length;
    const unresolvedCount = pendingDetections.filter((detection) => detection.candidates.length === 0).length;
    const status = detectedCount > 0
      ? unresolvedCount > 0 ? "partial" : "success"
      : "failed";
    const scanId = await insertScanEvent(client, {
      scope,
      operatorId: actor?.operatorId,
      mode,
      status,
      clientScanId,
      imageHash,
      rawImageStorageKey,
      qrDetectedCount: exactResolution ? 1 : 0,
      aiDetectedCount: exactResolution ? 0 : detectedCount,
      unresolvedCount,
      provider: providerForEvent,
      modelVersion,
      latencyMs: Date.now() - startedAt,
      metadata: {
        qrCodeCount: qrCodes.length,
        providerCandidates: Array.isArray(input.providerCandidates) ? input.providerCandidates.length : 0,
        providerCandidateCount: pendingDetections.reduce((sum, detection) => sum + detection.candidates.length, 0),
        providerDetectionCount: pendingDetections.length,
        imageCount,
        rawImageStorage: rawImageStorageKey ? "gcs" : rawStorageWarnings.length > 0 ? "failed" : "off",
        rawImageStorageKeys: rawStorageObjects.map((object) => object.storageKey),
        modelVersion,
        warnings: rawStorageWarnings,
      },
    });
    await insertScanImageArtifacts(client, {
      scope,
      scanId,
      imageHash,
      objects: rawStorageObjects,
    });

    const detections: VisionDetectionView[] = [];
    for (let index = 0; index < pendingDetections.length; index += 1) {
      const pendingDetection = pendingDetections[index];
      detections.push(await insertDetection(client, {
        scanId,
        objectId: pendingDetection.objectId || `obj_${index + 1}`,
        bbox: pendingDetection.bbox,
        objectOrder: pendingDetection.objectOrder || index + 1,
        providerObjectLabel: pendingDetection.providerObjectLabel,
        providerObjectConfidence: pendingDetection.providerObjectConfidence,
        source: pendingDetection.source,
        detectionType: pendingDetection.detectionType,
        resolvedVariantId: pendingDetection.resolvedVariantId,
        confidence: pendingDetection.confidence,
        candidates: pendingDetection.candidates,
        decision: pendingDetection.decision,
        warnings: pendingDetection.warnings,
      }));
    }

    return {
      data: {
        scanId,
        mode,
        status,
        provider: providerForEvent,
        modelVersion,
        requiresStaffConfirmation: true,
        detections,
      },
    };
  });
}

async function validateSelectedVariant(client: PoolClient, scope: OperatingScope, variantId: string): Promise<void> {
  const row = await queryOne<{ id: string }>(client, `
    SELECT v.id
    FROM public.product_variant v
    JOIN public.product p
      ON p.id = v.product_id
     AND p.deleted_at IS NULL
     AND p.status = 'published'
    JOIN public.product_variant_inventory_item pvii
      ON pvii.variant_id = v.id
     AND pvii.deleted_at IS NULL
    WHERE v.id = $1
      AND v.deleted_at IS NULL
      AND p.merchant_id = $2
    LIMIT 1
  `, [variantId, scope.merchantId]);
  if (!row) throw new PlatformError("validation_error", "selectedVariantId must be a published inventory-linked variant for this merchant", 400);
}

function normalizeCorrection(input: VisionCorrectionInput): Required<Pick<VisionCorrectionInput, "correctionType">> & {
  selectedVariantId: string | null;
  previousVariantId: string | null;
  detectionId: string | null;
  metadata: Record<string, unknown>;
} {
  const selectedVariantId = optionalText(input.selectedVariantId);
  const correctionType = input.correctionType || (selectedVariantId ? "manual_search_selected" : "staff_rejected");
  if (!["staff_accepted", "staff_selected_correct_variant", "staff_rejected", "manual_search_selected"].includes(correctionType)) {
    throw new PlatformError("validation_error", "Unsupported correctionType", 400);
  }
  if (correctionType !== "staff_rejected" && !selectedVariantId) {
    throw new PlatformError("validation_error", "selectedVariantId is required for this correctionType", 400);
  }
  if (correctionType === "staff_rejected" && selectedVariantId) {
    throw new PlatformError("validation_error", "selectedVariantId must be empty when staff rejects a detection", 400);
  }
  return {
    correctionType,
    selectedVariantId,
    previousVariantId: optionalText(input.previousVariantId),
    detectionId: optionalText(input.detectionId),
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {},
  };
}

export async function recordVisionScanCorrection(
  scanId: string,
  input: VisionCorrectionInput,
  scope: OperatingScope,
  actor?: ProductQrActor,
): Promise<VisionCorrectionResult> {
  const normalizedScanId = optionalText(scanId);
  if (!normalizedScanId) throw new PlatformError("validation_error", "scanId is required", 400);

  return withActiveVisionTransaction(scope, async (client) => {
    await requireFeatureCapability("vision_correction_report", { merchantId: scope.merchantId, client });
    const correction = normalizeCorrection(input);
    const event = await queryOne<{ id: string }>(client, `
      SELECT id
      FROM app.vision_scan_events
      WHERE id = $1
        AND merchant_id = $2
        AND store_id = $3
      LIMIT 1
    `, [normalizedScanId, scope.merchantId, scope.storeId]);
    if (!event) throw new PlatformError("resource_not_found", "Vision scan not found", 404);

    if (correction.detectionId) {
      const detection = await queryOne<{ id: string }>(client, `
        SELECT id
        FROM app.vision_scan_detections
        WHERE id = $1
          AND scan_event_id = $2
        LIMIT 1
      `, [correction.detectionId, normalizedScanId]);
      if (!detection) throw new PlatformError("resource_not_found", "Vision detection not found", 404);
    }

    if (correction.selectedVariantId) {
      await validateSelectedVariant(client, scope, correction.selectedVariantId);
    }

    const inserted = await queryOne<{ id: string }>(client, `
      INSERT INTO app.vision_scan_corrections (
        scan_event_id,
        detection_id,
        selected_variant_id,
        previous_variant_id,
        operator_id,
        correction_type,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING id
    `, [
      normalizedScanId,
      correction.detectionId,
      correction.selectedVariantId,
      correction.previousVariantId,
      actor?.operatorId || null,
      correction.correctionType,
      JSON.stringify(correction.metadata),
    ]);
    if (!inserted) throw new PlatformError("internal_error", "Unable to create vision correction", 500);

    if (correction.detectionId) {
      const decision = correction.correctionType === "staff_rejected"
        ? "rejected"
        : correction.correctionType === "staff_accepted"
          ? "accepted"
          : "corrected";
      await client.query(`
        UPDATE app.vision_scan_detections
        SET decision = $3,
            resolved_variant_id = COALESCE($4::text, resolved_variant_id)
        WHERE id = $1
          AND scan_event_id = $2
      `, [correction.detectionId, normalizedScanId, decision, correction.selectedVariantId]);
    }

    return {
      data: {
        correctionId: String(inserted.id),
        scanId: normalizedScanId,
        detectionId: correction.detectionId,
        selectedVariantId: correction.selectedVariantId,
        previousVariantId: correction.previousVariantId,
        correctionType: correction.correctionType,
      },
    };
  });
}

export async function listVisionScanReport(query: VisionScanReportQuery): Promise<VisionScanReportResult> {
  const merchantId = optionalText(query.merchantId);
  if (!merchantId) throw new PlatformError("validation_error", "merchantId is required", 400);

  const storeId = optionalText(query.storeId);
  const dateFrom = optionalIsoDate(query.dateFrom);
  const dateTo = optionalIsoDate(query.dateTo);
  const provider = optionalText(query.provider);
  const source = optionalText(query.source);
  const decision = optionalText(query.decision);
  const variantId = optionalText(query.variantId);
  const limit = limitFromInput(query.limit);
  const offset = offsetFromInput(query.offset);

  return withClient(async (client) => {
    const result = await client.query<Record<string, unknown>>(`
      SELECT
        e.id AS scan_id,
        e.created_at,
        e.merchant_id,
        e.store_id,
        COALESCE(e.operator_id, '') AS operator_id,
        e.mode,
        e.status,
        e.provider,
        COALESCE(e.model_version, '') AS model_version,
        COALESCE(e.latency_ms, 0)::int AS latency_ms,
        e.image_hash,
        d.id AS detection_id,
        d.object_id,
        d.source,
        d.detection_type,
        d.resolved_variant_id AS suggested_variant_id,
        d.confidence,
        d.decision,
        d.warnings,
        d.candidates,
        COALESCE(correction.selected_variant_id, '') AS selected_variant_id,
        COALESCE(correction.correction_type, '') AS correction_type,
        correction.created_at AS corrected_at,
        COALESCE(suggested_product.title, '') AS suggested_title,
        COALESCE(suggested_variant.sku, '') AS suggested_sku,
        COALESCE(selected_product.title, '') AS selected_title,
        COALESCE(selected_variant.sku, '') AS selected_sku,
        count(*) OVER()::int AS total_count
      FROM app.vision_scan_events e
      JOIN app.vision_scan_detections d
        ON d.scan_event_id = e.id
      LEFT JOIN LATERAL (
        SELECT c.selected_variant_id, c.correction_type, c.created_at
        FROM app.vision_scan_corrections c
        WHERE c.scan_event_id = e.id
          AND (c.detection_id = d.id OR c.detection_id IS NULL)
        ORDER BY c.created_at DESC
        LIMIT 1
      ) correction ON true
      LEFT JOIN public.product_variant suggested_variant
        ON suggested_variant.id = d.resolved_variant_id
       AND suggested_variant.deleted_at IS NULL
      LEFT JOIN public.product suggested_product
        ON suggested_product.id = suggested_variant.product_id
       AND suggested_product.deleted_at IS NULL
      LEFT JOIN public.product_variant selected_variant
        ON selected_variant.id = correction.selected_variant_id
       AND selected_variant.deleted_at IS NULL
      LEFT JOIN public.product selected_product
        ON selected_product.id = selected_variant.product_id
       AND selected_product.deleted_at IS NULL
      WHERE e.merchant_id = $1
        AND ($2::text IS NULL OR e.store_id = $2::text)
        AND ($3::timestamptz IS NULL OR e.created_at >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR e.created_at < ($4::timestamptz + interval '1 day'))
        AND ($5::text IS NULL OR e.provider = $5::text)
        AND ($6::text IS NULL OR d.source = $6::text)
        AND ($7::text IS NULL OR d.decision = $7::text)
        AND (
          $8::text IS NULL
          OR d.resolved_variant_id = $8::text
          OR correction.selected_variant_id = $8::text
        )
      ORDER BY e.created_at DESC, d.created_at DESC
      LIMIT $9 OFFSET $10
    `, [
      merchantId,
      storeId,
      dateFrom,
      dateTo,
      provider,
      source,
      decision,
      variantId,
      limit,
      offset,
    ]);

    const data = result.rows.map((row): VisionScanReportItem => ({
      scanId: String(row.scan_id || ""),
      detectionId: String(row.detection_id || ""),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ""),
      merchantId: String(row.merchant_id || ""),
      storeId: String(row.store_id || ""),
      operatorId: String(row.operator_id || ""),
      mode: String(row.mode || "single") === "bulk" ? "bulk" : "single",
      status: String(row.status || ""),
      provider: String(row.provider || ""),
      modelVersion: String(row.model_version || ""),
      latencyMs: Number(row.latency_ms || 0),
      imageHash: String(row.image_hash || ""),
      objectId: String(row.object_id || ""),
      source: String(row.source || "vision_provider") as VisionDetectionSource,
      detectionType: String(row.detection_type || "unresolved") as VisionDetectionType,
      confidence: row.confidence === null || row.confidence === undefined ? null : normalizeConfidence(row.confidence),
      decision: String(row.decision || "pending") as VisionDetectionView["decision"],
      suggestedVariantId: String(row.suggested_variant_id || ""),
      suggestedTitle: String(row.suggested_title || ""),
      suggestedSku: String(row.suggested_sku || ""),
      selectedVariantId: String(row.selected_variant_id || ""),
      selectedTitle: String(row.selected_title || ""),
      selectedSku: String(row.selected_sku || ""),
      correctionType: String(row.correction_type || ""),
      correctedAt: row.corrected_at instanceof Date ? row.corrected_at.toISOString() : String(row.corrected_at || ""),
      warnings: jsonArray(row.warnings).map((item) => String(item || "")).filter(Boolean),
      candidateCount: jsonArray(row.candidates).length,
    }));

    return {
      data,
      meta: {
        limit,
        offset,
        count: Number(result.rows[0]?.total_count || 0),
      },
    };
  });
}
