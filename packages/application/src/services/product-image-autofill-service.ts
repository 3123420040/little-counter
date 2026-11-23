import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { recordAuditEntry } from "../repositories/audit-repository";
import { emitExactOutbox } from "../repositories/outbox-repository";
import { buildExactProductImageAutofillRequestedEvent } from "./exact-outbox-event-builders";
import { normalizeProductImageUrl } from "./product-image-url";
import { safeErrorCode } from "../utils/safe-error";

export const PRODUCT_IMAGE_AUTOFILL_EVENT = "product.image_autofill_requested";

type ProductImageAutofillStatus = "applied" | "skipped" | "failed";

export interface ProductImageAutofillRequestInput {
  productId: string;
  merchantId: string;
  storeId?: string | null;
  title?: string;
  sku?: string;
  source?: string;
  requestedBy?: string;
}

interface ProductImageAutofillSnapshot {
  productId: string;
  merchantId: string;
  title: string;
  sku: string;
  metadata: Record<string, unknown>;
}

interface ProductImageCandidate {
  imageUrl: string;
  sourceUrl?: string;
}

interface ProductImageSearchResult {
  provider: string;
  query: string;
  candidate: ProductImageCandidate | null;
  reason?: string;
}

export function productImageAutofillFailureReason(error: unknown): string {
  return `provider_error:${safeErrorCode(error)}`;
}

function env(name: string): string {
  return process.env[name]?.trim() || "";
}

function configuredInteger(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(env(name));
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function isProductImageAutofillEnabled(): boolean {
  return env("PRODUCT_IMAGE_AUTOFILL_ENABLED").toLowerCase() === "true";
}

export function productImageAutofillProvider(): "deterministic" | "tavily" {
  const provider = env("PRODUCT_IMAGE_AUTOFILL_PROVIDER") || env("PRODUCT_RESEARCH_PROVIDER") || "deterministic";
  return provider === "tavily" ? "tavily" : "deterministic";
}

export function buildProductImageSearchQuery(input: { title: string; sku?: string }): string {
  return [
    input.title,
    input.sku ? `SKU ${input.sku}` : "",
    "official product pack image",
  ].filter(Boolean).join(" ");
}

function stableTextImageUrl(title: string): string {
  const text = encodeURIComponent(title.trim().slice(0, 40) || "Product");
  return `https://dummyimage.com/512x512/0f766e/ffffff.png&text=${text}`;
}

export function firstValidProductImageCandidate(
  candidates: Array<{ imageUrl?: unknown; sourceUrl?: unknown }>,
): ProductImageCandidate | null {
  for (const candidate of candidates) {
    try {
      const imageUrl = normalizeProductImageUrl(candidate.imageUrl);
      if (!imageUrl) continue;
      const sourceUrl = typeof candidate.sourceUrl === "string" && candidate.sourceUrl.trim()
        ? candidate.sourceUrl.trim()
        : undefined;
      return { imageUrl, sourceUrl };
    } catch {
      // Ignore malformed/unsafe provider candidates and keep the one-pass
      // search simple: first usable HTTPS image wins.
    }
  }
  return null;
}

function extractTavilyImageCandidates(payload: {
  images?: unknown;
  results?: Array<Record<string, unknown>>;
}): Array<{ imageUrl?: unknown; sourceUrl?: unknown }> {
  const candidates: Array<{ imageUrl?: unknown; sourceUrl?: unknown }> = [];

  if (Array.isArray(payload.images)) {
    for (const item of payload.images) {
      if (typeof item === "string") {
        candidates.push({ imageUrl: item });
      } else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        candidates.push({
          imageUrl: record.url || record.image_url || record.imageUrl,
          sourceUrl: record.source_url || record.sourceUrl,
        });
      }
    }
  }

  for (const result of payload.results || []) {
    const sourceUrl = result.url;
    candidates.push({ imageUrl: result.image_url || result.imageUrl, sourceUrl });
    const nestedImages = result.images;
    if (Array.isArray(nestedImages)) {
      for (const item of nestedImages) {
        if (typeof item === "string") {
          candidates.push({ imageUrl: item, sourceUrl });
        } else if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          candidates.push({
            imageUrl: record.url || record.image_url || record.imageUrl,
            sourceUrl: record.source_url || record.sourceUrl || sourceUrl,
          });
        }
      }
    }
  }

  return candidates;
}

async function runTavilyProductImageSearch(query: string): Promise<ProductImageSearchResult> {
  const apiKey = env("TAVILY_API_KEY");
  if (!apiKey) {
    return { provider: "tavily", query, candidate: null, reason: "provider_config_missing" };
  }

  const response = await fetch(`${(env("TAVILY_API_BASE") || "https://api.tavily.com").replace(/\/$/, "")}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: env("TAVILY_SEARCH_DEPTH") || "advanced",
      topic: "general",
      max_results: configuredInteger("TAVILY_MAX_RESULTS", 5, 1, 10),
      include_answer: false,
      include_raw_content: false,
      include_images: true,
      include_image_descriptions: false,
      country: env("PRODUCT_RESEARCH_PREFERRED_LANGUAGE") === "vi" ? "vietnam" : undefined,
    }),
  });
  const payload = await response.json().catch(() => ({})) as {
    images?: unknown;
    results?: Array<Record<string, unknown>>;
    request_id?: string;
  };
  if (!response.ok) {
    return {
      provider: "tavily",
      query,
      candidate: null,
      reason: `provider_http_${response.status}`,
    };
  }

  return {
    provider: "tavily",
    query,
    candidate: firstValidProductImageCandidate(extractTavilyImageCandidates(payload)),
    reason: payload.images || payload.results ? undefined : "no_image_field",
  };
}

export async function runProductImageSearchProvider(input: { title: string; sku?: string }): Promise<ProductImageSearchResult> {
  const query = buildProductImageSearchQuery(input);
  const provider = productImageAutofillProvider();
  if (provider === "tavily") return runTavilyProductImageSearch(query);
  return {
    provider: "deterministic",
    query,
    candidate: {
      imageUrl: stableTextImageUrl(input.title),
      sourceUrl: "deterministic-local-product-image",
    },
  };
}

async function getProductSnapshotForClient(
  client: PoolClient,
  productId: string,
  merchantId: string,
): Promise<ProductImageAutofillSnapshot | null> {
  const row = await queryOne<{
    id: string;
    title: string;
    merchant_id: string;
    sku: string | null;
    metadata: Record<string, unknown> | null;
  }>(client, `
    SELECT
      p.id,
      p.title,
      p.merchant_id,
      COALESCE(pv.sku, '') AS sku,
      COALESCE(p.metadata, '{}'::jsonb) AS metadata
    FROM public.product p
    LEFT JOIN LATERAL (
      SELECT sku
      FROM public.product_variant
      WHERE product_id = p.id
        AND deleted_at IS NULL
      ORDER BY COALESCE(variant_rank, 0) ASC, created_at ASC, id ASC
      LIMIT 1
    ) pv ON true
    WHERE p.id = $1
      AND p.merchant_id = $2
      AND p.deleted_at IS NULL
  `, [productId, merchantId]);
  if (!row) return null;
  return {
    productId: row.id,
    merchantId: row.merchant_id,
    title: row.title,
    sku: row.sku || "",
    metadata: row.metadata || {},
  };
}

function hasImageUrl(metadata: Record<string, unknown>): boolean {
  return typeof metadata.imageUrl === "string" && metadata.imageUrl.trim().length > 0;
}

function wasAutofillAttempted(metadata: Record<string, unknown>): boolean {
  const autofill = metadata.imageAutofill;
  return Boolean(
    autofill &&
    typeof autofill === "object" &&
    typeof (autofill as Record<string, unknown>).attemptedAt === "string",
  );
}

export async function emitProductImageAutofillRequestForClient(
  client: PoolClient,
  input: ProductImageAutofillRequestInput,
): Promise<string | null> {
  if (!isProductImageAutofillEnabled()) return null;

  const product = await getProductSnapshotForClient(client, input.productId, input.merchantId);
  if (!product || hasImageUrl(product.metadata) || wasAutofillAttempted(product.metadata)) return null;

  const duplicate = await queryOne<{ id: string }>(client, `
    SELECT id::text AS id
    FROM outbox.events
    WHERE aggregate_type = 'product'
      AND aggregate_id = $1
      AND event_type = $2
      AND status IN ('pending', 'processing')
    ORDER BY created_at DESC
    LIMIT 1
  `, [input.productId, PRODUCT_IMAGE_AUTOFILL_EVENT]);
  if (duplicate?.id) return duplicate.id;

  const requestedBy = input.requestedBy || "system";
  const source = input.source || "product.mutation";
  const requestAudit = await recordAuditEntry(client, {
    operatorId: requestedBy,
    role: "system",
    serviceIdentity: "product-image-autofill",
  }, PRODUCT_IMAGE_AUTOFILL_EVENT, "product", input.productId, {
    after: { source, title: input.title || product.title, sku: input.sku || product.sku },
    merchantId: input.merchantId,
    storeId: input.storeId || undefined,
  });
  return emitExactOutbox(client, buildExactProductImageAutofillRequestedEvent({
    merchantId: input.merchantId,
    storeId: input.storeId || null,
    productId: input.productId,
    auditEventId: requestAudit.id,
    sourceOccurredAt: requestAudit.createdAt,
    payload: {
      correlationId: requestAudit.correlationId,
      title: input.title || product.title,
      sku: input.sku || product.sku,
      source,
      requestedBy,
    },
  }));
}

export async function requestProductImageAutofill(input: ProductImageAutofillRequestInput): Promise<string | null> {
  await ensurePlatformSchema();
  return withConnectedTransaction((client) => emitProductImageAutofillRequestForClient(client, input));
}

async function applyProductImageAutofillResult(input: {
  product: ProductImageAutofillSnapshot;
  storeId?: string | null;
  status: ProductImageAutofillStatus;
  provider: string;
  query: string;
  imageUrl?: string;
  sourceUrl?: string;
  reason?: string;
}): Promise<boolean> {
  const autofillMetadata = {
    status: input.status,
    attemptedAt: new Date().toISOString(),
    provider: input.provider,
    query: input.query,
    sourceUrl: input.sourceUrl,
    reason: input.reason,
  };
  const metadataPatch = input.imageUrl
    ? { imageUrl: input.imageUrl, imageAutofill: autofillMetadata }
    : { imageAutofill: autofillMetadata };

  return withConnectedTransaction(async (client) => {
    const updated = await client.query(`
      UPDATE public.product
      SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
          updated_at = now()
      WHERE id = $1
        AND merchant_id = $2
        AND deleted_at IS NULL
        AND COALESCE(metadata->>'imageUrl', '') = ''
        AND COALESCE(metadata#>>'{imageAutofill,attemptedAt}', '') = ''
      RETURNING id
    `, [input.product.productId, input.product.merchantId, JSON.stringify(metadataPatch)]);

    if (updated.rowCount === 0) return false;

    await recordAuditEntry(client, {
      operatorId: "system",
      role: "system",
      serviceIdentity: "product-image-autofill",
    }, input.status === "applied" ? "product.image_autofilled" : "product.image_autofill_skipped", "product", input.product.productId, {
      after: metadataPatch,
      reason: input.reason,
      merchantId: input.product.merchantId,
      storeId: input.storeId || undefined,
    });
    return true;
  });
}

export async function handleProductImageAutofillRequestedOnReadySchema(
  payload: Record<string, unknown>,
): Promise<void> {
  const productId = String(payload.productId || "");
  const merchantId = String(payload.merchantId || "");
  const storeId = typeof payload.storeId === "string" ? payload.storeId : null;
  if (!productId || !merchantId) return;

  const product = await withConnectedClient((client) => getProductSnapshotForClient(client, productId, merchantId));
  if (!product || hasImageUrl(product.metadata) || wasAutofillAttempted(product.metadata)) return;

  let searchResult: ProductImageSearchResult;
  try {
    searchResult = await runProductImageSearchProvider({
      title: String(payload.title || product.title),
      sku: String(payload.sku || product.sku || ""),
    });
  } catch (err) {
    searchResult = {
      provider: productImageAutofillProvider(),
      query: buildProductImageSearchQuery({ title: product.title, sku: product.sku }),
      candidate: null,
      reason: productImageAutofillFailureReason(err),
    };
  }

  const imageUrl = searchResult.candidate?.imageUrl;
  await applyProductImageAutofillResult({
    product,
    storeId,
    status: imageUrl ? "applied" : searchResult.reason === "provider_config_missing" ? "skipped" : "failed",
    provider: searchResult.provider,
    query: searchResult.query,
    imageUrl,
    sourceUrl: searchResult.candidate?.sourceUrl,
    reason: imageUrl ? undefined : searchResult.reason || "no_valid_https_image",
  });
}

export async function handleProductImageAutofillRequested(payload: Record<string, unknown>): Promise<void> {
  await ensurePlatformSchema();
  return handleProductImageAutofillRequestedOnReadySchema(payload);
}
