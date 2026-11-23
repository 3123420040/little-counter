import { createHash } from "node:crypto";
import sharp from "sharp";
import type { PoolClient } from "../db/client";
import { queryOne } from "../db/query";
import {
  readVisionStorageObject,
  uploadVisionStorageObject,
  visionLearningEnabled,
} from "./vision-image-storage-service";
import { safeErrorMetadata } from "../utils/safe-error";

export function visionLearningFailureMetadata(error: unknown) {
  return safeErrorMetadata(error);
}

interface SaleCreatedVisionContext {
  scanEventId?: string;
  detectionId?: string;
  correctionId?: string;
  objectId?: string;
  candidateSource?: string;
  provider?: string;
  providerCandidateRank?: number;
  providerConfidence?: number;
  providerProductRef?: string;
  providerImageRef?: string;
}

interface SaleCreatedItem {
  orderLineItemId?: string;
  productId?: string;
  variantId?: string;
  quantity?: number;
  vision?: SaleCreatedVisionContext;
  visionContexts?: SaleCreatedVisionContext[];
}

interface StrongMappingRow extends Record<string, unknown> {
  scan_id: string;
  merchant_id: string;
  store_id: string;
  raw_image_storage_key: string | null;
  scan_metadata: Record<string, unknown>;
  detection_id: string;
  object_id: string;
  bbox: Record<string, unknown> | null;
  detection_metadata: Record<string, unknown>;
  correction_id: string | null;
  selected_variant_id: string | null;
  product_id: string;
  variant_id: string;
}

interface CropResult {
  bytes: Buffer;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  bboxPixels: { left: number; top: number; width: number; height: number };
  qualityScore: number;
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value === "true";
}

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] || fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalText(value: unknown): string | undefined {
  const normalized = String(value || "").trim();
  return normalized || undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function saleItems(payload: Record<string, unknown>): SaleCreatedItem[] {
  return Array.isArray(payload.items) ? payload.items.map((item) => asRecord(item) as SaleCreatedItem) : [];
}

function itemVisionContexts(item: SaleCreatedItem): SaleCreatedVisionContext[] {
  if (Array.isArray(item.visionContexts)) return item.visionContexts.map((context) => asRecord(context) as SaleCreatedVisionContext);
  return item.vision ? [asRecord(item.vision) as SaleCreatedVisionContext] : [];
}

function imageIndexFromMapping(row: StrongMappingRow): number {
  const fromObject = row.object_id.match(/^image_(\d+)_/);
  if (fromObject) return Math.max(0, Number(fromObject[1]) - 1);
  const warnings = Array.isArray(row.detection_metadata?.warnings) ? row.detection_metadata.warnings : [];
  for (const warning of warnings) {
    const match = String(warning || "").match(/^image_(\d+)/);
    if (match) return Math.max(0, Number(match[1]) - 1);
  }
  return 0;
}

function rawStorageKeyForMapping(row: StrongMappingRow): string | null {
  const metadata = asRecord(row.scan_metadata);
  const keys = Array.isArray(metadata.rawImageStorageKeys)
    ? metadata.rawImageStorageKeys.map((item) => optionalText(item)).filter((item): item is string => Boolean(item))
    : [];
  const index = imageIndexFromMapping(row);
  return keys[index] || row.raw_image_storage_key;
}

function normalizedVertices(bbox: Record<string, unknown> | null | undefined): Array<{ x: number; y: number }> {
  if (!bbox) return [];
  const source = Array.isArray(bbox.normalizedVertices)
    ? bbox.normalizedVertices
    : Array.isArray(bbox.vertices)
      ? bbox.vertices
      : [];
  return source
    .map((vertex) => {
      const point = asRecord(vertex);
      return { x: Number(point.x || 0), y: Number(point.y || 0) };
    })
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

async function cropByBBox(rawBytes: Buffer, bbox: Record<string, unknown>): Promise<CropResult | null> {
  if (String(bbox.source || "") === "full_image") return null;
  const image = sharp(rawBytes, { failOn: "none" });
  const metadata = await image.metadata();
  const sourceWidth = Number(metadata.width || 0);
  const sourceHeight = Number(metadata.height || 0);
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;

  const vertices = normalizedVertices(bbox);
  if (vertices.length < 2) return null;
  const normalized = vertices.every((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1);
  const xs = vertices.map((point) => normalized ? point.x * sourceWidth : point.x);
  const ys = vertices.map((point) => normalized ? point.y * sourceHeight : point.y);
  const minX = Math.max(0, Math.min(...xs));
  const maxX = Math.min(sourceWidth, Math.max(...xs));
  const minY = Math.max(0, Math.min(...ys));
  const maxY = Math.min(sourceHeight, Math.max(...ys));
  const rawWidth = maxX - minX;
  const rawHeight = maxY - minY;
  if (rawWidth < 40 || rawHeight < 40) return null;

  const paddingRatio = Math.max(0, Math.min(0.2, Number(process.env.VISION_LEARNING_CROP_PADDING_RATIO || "0.08")));
  const padX = rawWidth * paddingRatio;
  const padY = rawHeight * paddingRatio;
  const left = Math.max(0, Math.floor(minX - padX));
  const top = Math.max(0, Math.floor(minY - padY));
  const right = Math.min(sourceWidth, Math.ceil(maxX + padX));
  const bottom = Math.min(sourceHeight, Math.ceil(maxY + padY));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const areaRatio = (width * height) / (sourceWidth * sourceHeight);
  if (areaRatio < 0.01 || areaRatio > 0.9) return null;

  const maxDimension = positiveIntEnv("VISION_LEARNING_CROP_MAX_DIMENSION", 1280);
  const bytes = await image
    .extract({ left, top, width, height })
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  const cropMetadata = await sharp(bytes).metadata();
  const cropWidth = Number(cropMetadata.width || width);
  const cropHeight = Number(cropMetadata.height || height);
  const confidence = Math.max(0, Math.min(1, Number(bbox.confidence || 0.7)));
  const areaScore = Math.max(0, Math.min(1, areaRatio / 0.25));

  return {
    bytes,
    width: cropWidth,
    height: cropHeight,
    sourceWidth,
    sourceHeight,
    bboxPixels: { left, top, width, height },
    qualityScore: Math.max(0.05, Math.min(1, confidence * 0.6 + areaScore * 0.4)),
  };
}

export function buildVisionLearningReferenceObjectName(input: {
  merchantId: string;
  storeId: string;
  variantId: string;
  learningKey: string;
}): string {
  const prefix = String(process.env.GOOGLE_VISION_REFERENCE_PREFIX || "reference-images")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const safe = (value: string, fallback: string) => (value || fallback)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96) || fallback;
  const learningDigest = createHash("sha256").update(input.learningKey).digest("hex");
  return [
    prefix,
    safe(input.merchantId, "merchant"),
    safe(input.storeId || "global", "global"),
    safe(input.variantId, "variant"),
    "learned",
    `${learningDigest}.jpg`,
  ].filter(Boolean).join("/");
}

async function loadStrongMapping(
  client: PoolClient,
  input: {
    merchantId: string;
    storeId: string;
    variantId: string;
    context: SaleCreatedVisionContext;
  },
): Promise<StrongMappingRow | null> {
  const scanEventId = optionalText(input.context.scanEventId);
  const detectionId = optionalText(input.context.detectionId);
  if (!scanEventId || !detectionId) return null;

  const correctionId = optionalText(input.context.correctionId);
  const row = await queryOne<StrongMappingRow>(client, `
    SELECT
      e.id AS scan_id,
      e.merchant_id,
      e.store_id,
      e.raw_image_storage_key,
      e.metadata AS scan_metadata,
      d.id AS detection_id,
      d.object_id,
      d.bbox,
      jsonb_build_object('warnings', d.warnings) AS detection_metadata,
      c.id AS correction_id,
      c.selected_variant_id,
      p.id AS product_id,
      v.id AS variant_id
    FROM app.vision_scan_events e
    JOIN app.vision_scan_detections d
      ON d.scan_event_id = e.id
    LEFT JOIN LATERAL (
      SELECT id, selected_variant_id
      FROM app.vision_scan_corrections c
      WHERE c.scan_event_id = e.id
        AND c.detection_id = d.id
        AND c.selected_variant_id = $5
        AND ($6::uuid IS NULL OR c.id = $6::uuid)
      ORDER BY c.created_at DESC
      LIMIT 1
    ) c ON true
    JOIN public.product_variant v
      ON v.id = $5
     AND v.deleted_at IS NULL
    JOIN public.product p
      ON p.id = v.product_id
     AND p.deleted_at IS NULL
    WHERE e.id = $1::uuid
      AND e.merchant_id = $2
      AND e.store_id = $3
      AND d.id = $4::uuid
      AND p.merchant_id = $2
    LIMIT 1
  `, [
    scanEventId,
    input.merchantId,
    input.storeId,
    detectionId,
    input.variantId,
    correctionId || null,
  ]);
  if (!row || !row.correction_id || row.selected_variant_id !== input.variantId) return null;
  if (!row.bbox) return null;
  if (!rawStorageKeyForMapping(row)) return null;
  return row;
}

async function referenceCapReached(client: PoolClient, input: { merchantId: string; storeId: string; variantId: string }): Promise<boolean> {
  const max = positiveIntEnv("VISION_REFERENCE_MAX_APPROVED_PER_VARIANT", 25);
  const row = await queryOne<{ count: string | number }>(client, `
    SELECT count(*)::int AS count
    FROM app.product_variant_images
    WHERE merchant_id = $1
      AND store_id IS NOT DISTINCT FROM $2::text
      AND variant_id = $3
      AND image_type = 'counter_capture'
      AND source = 'staff_correction'
      AND quality_status <> 'rejected'
  `, [input.merchantId, input.storeId, input.variantId]);
  return Number(row?.count || 0) >= max;
}

async function learnedReferenceExists(client: PoolClient, learningKey: string): Promise<boolean> {
  const row = await queryOne(client, `
    SELECT id
    FROM app.product_variant_images
    WHERE metadata->>'learningIdempotencyKey' = $1
    LIMIT 1
  `, [learningKey]);
  return Boolean(row);
}

async function insertLearnedReferenceImage(
  client: PoolClient,
  input: {
    row: StrongMappingRow;
    context: SaleCreatedVisionContext;
    orderId: string;
    orderLineItemId: string;
    learningKey: string;
    upload: { gcsUri: string; storageKey: string; contentType: string; byteSize: number };
    crop: CropResult;
  },
): Promise<string | null> {
  const qualityStatus = envFlag("VISION_LEARNING_AUTO_APPROVE", false) ? "approved" : "pending";
  const inserted = await queryOne<{ id: string }>(client, `
    INSERT INTO app.product_variant_images (
      merchant_id,
      store_id,
      product_id,
      variant_id,
      image_url,
      image_type,
      source,
      quality_status,
      quality_score,
      is_primary,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, 'counter_capture', 'staff_correction', $6, $7, false, $8::jsonb)
    ON CONFLICT (merchant_id, (COALESCE(store_id, ''::text)), variant_id, image_url)
    DO UPDATE SET
      metadata = app.product_variant_images.metadata || EXCLUDED.metadata,
      updated_at = now()
    RETURNING id
  `, [
    input.row.merchant_id,
    input.row.store_id,
    input.row.product_id,
    input.row.variant_id,
    input.upload.gcsUri,
    qualityStatus,
    input.crop.qualityScore,
    JSON.stringify({
      source: "vision_learning_loop",
      learningIdempotencyKey: input.learningKey,
      scanEventId: input.row.scan_id,
      detectionId: input.row.detection_id,
      correctionId: input.row.correction_id,
      orderId: input.orderId,
      orderLineItemId: input.orderLineItemId,
      objectId: input.row.object_id,
      candidateSource: input.context.candidateSource,
      provider: input.context.provider,
      providerConfidence: input.context.providerConfidence,
      providerCandidateRank: input.context.providerCandidateRank,
      providerProductRef: input.context.providerProductRef,
      providerImageRef: input.context.providerImageRef,
      bbox: input.row.bbox,
      crop: {
        width: input.crop.width,
        height: input.crop.height,
        sourceWidth: input.crop.sourceWidth,
        sourceHeight: input.crop.sourceHeight,
        bboxPixels: input.crop.bboxPixels,
      },
      gcsObjectName: input.upload.storageKey,
      contentType: input.upload.contentType,
      byteLength: input.upload.byteSize,
    }),
  ]);
  return inserted ? String(inserted.id) : null;
}

async function insertCropArtifact(
  client: PoolClient,
  input: {
    row: StrongMappingRow;
    imageId: string | null;
    upload: { gcsUri: string; storageKey: string; contentType: string; byteSize: number };
    crop: CropResult;
    learningKey: string;
  },
): Promise<void> {
  await client.query(`
    INSERT INTO app.vision_scan_image_artifacts (
      merchant_id,
      store_id,
      scan_event_id,
      detection_id,
      variant_id,
      artifact_type,
      gcs_uri,
      storage_key,
      content_type,
      byte_size,
      width,
      height,
      bbox,
      image_hash,
      quality_status,
      metadata
    )
    VALUES ($1, $2, $3::uuid, $4::uuid, $5, 'object_crop', $6, $7, $8, $9, $10, $11, $12::jsonb, $13, 'pending', $14::jsonb)
    ON CONFLICT (storage_key) DO NOTHING
  `, [
    input.row.merchant_id,
    input.row.store_id,
    input.row.scan_id,
    input.row.detection_id,
    input.row.variant_id,
    input.upload.gcsUri,
    input.upload.storageKey,
    input.upload.contentType,
    input.upload.byteSize,
    input.crop.width,
    input.crop.height,
    JSON.stringify(input.row.bbox || {}),
    createHash("sha256").update(input.crop.bytes).digest("hex"),
    JSON.stringify({
      source: "vision_learning_loop",
      productVariantImageId: input.imageId,
      learningIdempotencyKey: input.learningKey,
      qualityScore: input.crop.qualityScore,
    }),
  ]);
}

export async function handleVisionLearningFromSale(client: PoolClient, payload: Record<string, unknown>): Promise<void> {
  if (!visionLearningEnabled()) return;

  const merchantId = optionalText(payload.merchantId);
  const storeId = optionalText(payload.storeId);
  const orderId = optionalText(payload.orderId);
  if (!merchantId || !storeId || !orderId) return;

  for (const item of saleItems(payload)) {
    const variantId = optionalText(item.variantId);
    if (!variantId) continue;
    const contexts = itemVisionContexts(item);
    for (let index = 0; index < contexts.length; index += 1) {
      const context = contexts[index];
      const orderLineItemId = optionalText(item.orderLineItemId) || `${orderId}:${variantId}:${index + 1}`;
      const detectionId = optionalText(context.detectionId);
      if (!detectionId) continue;
      try {
        const learningKey = `vision-learning:${orderLineItemId}:${context.scanEventId}:${detectionId}:${variantId}:${index + 1}`;
        if (await learnedReferenceExists(client, learningKey)) continue;

        const mapping = await loadStrongMapping(client, {
          merchantId,
          storeId,
          variantId,
          context,
        });
        if (!mapping) continue;
        if (await referenceCapReached(client, { merchantId, storeId, variantId })) continue;

        const rawKey = rawStorageKeyForMapping(mapping);
        if (!rawKey || !mapping.bbox) continue;
        const raw = await readVisionStorageObject(rawKey);
        const crop = await cropByBBox(raw.bytes, mapping.bbox);
        if (!crop) continue;

        const upload = await uploadVisionStorageObject({
          objectName: buildVisionLearningReferenceObjectName({
            merchantId,
            storeId,
            variantId,
            learningKey,
          }),
          bytes: crop.bytes,
          contentType: "image/jpeg",
        });
        const imageId = await insertLearnedReferenceImage(client, {
          row: mapping,
          context,
          orderId,
          orderLineItemId,
          learningKey,
          upload,
          crop,
        });
        await insertCropArtifact(client, {
          row: mapping,
          imageId,
          upload,
          crop,
          learningKey,
        });
      } catch (error) {
        console.warn("[vision-learning] skipped failed learning context", {
          orderId,
          orderLineItemId,
          variantId,
          scanEventId: context.scanEventId,
          detectionId,
          ...visionLearningFailureMetadata(error),
        });
      }
    }
  }
}
