import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as applicationNamespace from "@medusa-snus/application";

const applicationModule = ((applicationNamespace as unknown as { default?: typeof import("@medusa-snus/application") }).default ?? applicationNamespace) as typeof import("@medusa-snus/application");
const { normalizeVisionImageBase64, PlatformError } = applicationModule as typeof import("@medusa-snus/application");

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

interface ServiceAccountJson {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
  project_id?: string;
}

interface TokenCache {
  accessToken: string;
  expiresAtMs: number;
}

let cachedToken: TokenCache | null = null;

export interface ProductSearchCandidate {
  productId?: string;
  variantId?: string;
  sku?: string;
  barcode?: string;
  providerProductRef?: string;
  providerImageRef?: string;
  confidence: number;
  warnings: string[];
}

export interface ProductSearchDetection {
  objectId: string;
  bbox?: Record<string, unknown>;
  objectLabel?: string;
  objectConfidence?: number;
  candidates: ProductSearchCandidate[];
  warnings: string[];
}

export interface ProductSearchResult {
  provider: "google_product_search" | "google_vision_ocr";
  modelVersion: string;
  location: string;
  productSet: string;
  candidates: ProductSearchCandidate[];
  detections: ProductSearchDetection[];
}

function requiredEnv(name: string, fallback?: string): string {
  const value = (process.env[name] || fallback || "").trim();
  if (!value) throw new PlatformError("provider_config_missing", `${name} is required`, 503);
  return value;
}

function maxVisionImageBytes(): number {
  const parsed = Number(process.env.VISION_MAX_IMAGE_BYTES || 6 * 1024 * 1024);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 6 * 1024 * 1024;
}

function normalizeBase64Image(value: unknown): string {
  return normalizeVisionImageBase64(value, {
    maxBytes: maxVisionImageBytes(),
  }).contentBase64;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function loadServiceAccount(): Promise<ServiceAccountJson> {
  const path = requiredEnv("GOOGLE_APPLICATION_CREDENTIALS");
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as ServiceAccountJson;
  if (!parsed.client_email || !parsed.private_key) {
    throw new PlatformError("provider_config_missing", "Google service account JSON is missing client_email or private_key", 503);
  }
  return parsed;
}

function signJwtAssertion(serviceAccount: ServiceAccountJson, nowSeconds: number): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: serviceAccount.token_uri || "https://oauth2.googleapis.com/token",
    exp: nowSeconds + 3600,
    iat: nowSeconds,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(String(serviceAccount.private_key), "base64url");
  return `${unsigned}.${signature}`;
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs - 60_000 > now) return cachedToken.accessToken;

  const serviceAccount = await loadServiceAccount();
  const assertion = signJwtAssertion(serviceAccount, Math.floor(now / 1000));
  const tokenUri = serviceAccount.token_uri || "https://oauth2.googleapis.com/token";
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
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
  cachedToken = {
    accessToken: payload.access_token,
    expiresAtMs: now + Math.max(60, Number(payload.expires_in || 3600)) * 1000,
  };
  return payload.access_token;
}

function labelValue(product: Record<string, unknown>, keys: string[]): string {
  const labels = Array.isArray(product.productLabels) ? product.productLabels : [];
  for (const label of labels) {
    if (!label || typeof label !== "object") continue;
    const item = label as { key?: unknown; value?: unknown };
    if (keys.includes(String(item.key || "")) && String(item.value || "").trim()) {
      return String(item.value).trim();
    }
  }
  return "";
}

function candidateFromGoogleResult(item: unknown): ProductSearchCandidate | null {
  const result = item && typeof item === "object" ? item as Record<string, unknown> : {};
  const product = result.product && typeof result.product === "object" ? result.product as Record<string, unknown> : {};
  const providerProductRef = String(product.name || "").trim();
  if (!providerProductRef) return null;
  return {
    productId: labelValue(product, ["productId", "product_id"]),
    variantId: labelValue(product, ["variantId", "variant_id", "variant"]),
    sku: labelValue(product, ["sku", "SKU"]),
    barcode: labelValue(product, ["barcode"]),
    providerProductRef,
    providerImageRef: String(result.image || "").trim(),
    confidence: Math.max(0, Math.min(1, Number(result.score || 0))),
    warnings: [],
  };
}

function uniqueCandidates(candidates: ProductSearchCandidate[]): ProductSearchCandidate[] {
  const seen = new Set<string>();
  const unique: ProductSearchCandidate[] = [];
  for (const candidate of candidates) {
    const key = [
      candidate.variantId || "",
      candidate.sku || "",
      candidate.barcode || "",
      candidate.providerProductRef || "",
    ].join("|");
    if (key === "|||") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique.sort((a, b) => b.confidence - a.confidence);
}

function firstProductSearchResults(payload: unknown): Record<string, unknown> {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const responses = Array.isArray(root.responses) ? root.responses : [];
  const first = responses[0] && typeof responses[0] === "object" ? responses[0] as Record<string, unknown> : {};
  return first.productSearchResults && typeof first.productSearchResults === "object"
    ? first.productSearchResults as Record<string, unknown>
    : {};
}

export function normalizeGoogleProductSearchResponse(payload: unknown): ProductSearchCandidate[] {
  const productSearchResults = firstProductSearchResults(payload);
  const results = Array.isArray(productSearchResults.results) ? productSearchResults.results : [];

  return uniqueCandidates(results
    .map(candidateFromGoogleResult)
    .filter((item): item is ProductSearchCandidate => Boolean(item))
  )
    .slice(0, 10);
}

function bboxTopLeft(bbox: Record<string, unknown> | undefined): { top: number; left: number } {
  const vertices = Array.isArray(bbox?.normalizedVertices)
    ? bbox.normalizedVertices
    : Array.isArray(bbox?.vertices)
      ? bbox.vertices
      : [];
  let top = 1;
  let left = 1;
  for (const vertex of vertices) {
    if (!vertex || typeof vertex !== "object") continue;
    const point = vertex as { x?: unknown; y?: unknown };
    const x = Number(point.x);
    const y = Number(point.y);
    if (Number.isFinite(x)) left = Math.min(left, x);
    if (Number.isFinite(y)) top = Math.min(top, y);
  }
  return { top, left };
}

export function normalizeGoogleProductSearchDetections(payload: unknown): ProductSearchDetection[] {
  const productSearchResults = firstProductSearchResults(payload);
  const groups = Array.isArray(productSearchResults.productGroupedResults)
    ? productSearchResults.productGroupedResults
    : [];

  const detections = groups
    .map((item, index): ProductSearchDetection | null => {
      const group = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const results = Array.isArray(group.results) ? group.results : [];
      const candidates = uniqueCandidates(results
        .map(candidateFromGoogleResult)
        .filter((candidate): candidate is ProductSearchCandidate => Boolean(candidate)))
        .slice(0, 10);
      if (candidates.length === 0) return null;
      const bbox = group.boundingPoly && typeof group.boundingPoly === "object"
        ? group.boundingPoly as Record<string, unknown>
        : undefined;
      return {
        objectId: `obj_${index + 1}`,
        bbox: bbox ? { ...bbox, source: "product_search" } : undefined,
        candidates,
        warnings: [],
      };
    })
    .filter((item): item is ProductSearchDetection => Boolean(item))
    .sort((a, b) => {
      const aPos = bboxTopLeft(a.bbox);
      const bPos = bboxTopLeft(b.bbox);
      return aPos.top - bPos.top || aPos.left - bPos.left;
    })
    .map((item, index) => ({ ...item, objectId: `obj_${index + 1}` }));

  if (detections.length > 0) return detections;

  const candidates = normalizeGoogleProductSearchResponse(payload);
  return candidates.length > 0
    ? [{
        objectId: "obj_1",
        bbox: { source: "full_image" },
        candidates,
        warnings: ["product_search_flat_results"],
      }]
    : [];
}

export async function runGoogleProductSearch(input: { imageBase64?: string }): Promise<ProductSearchResult> {
  const imageContent = normalizeBase64Image(input.imageBase64);
  const projectId = requiredEnv("GOOGLE_CLOUD_PROJECT_ID");
  const location = requiredEnv("GOOGLE_PRODUCT_SEARCH_LOCATION", "asia-east1");
  const productSetId = requiredEnv("GOOGLE_PRODUCT_SEARCH_PRODUCT_SET_ID", "snus_pos_v14_pilot");
  const productCategory = requiredEnv("GOOGLE_PRODUCT_SEARCH_PRODUCT_CATEGORY", "packagedgoods-v1");
  const accessToken = await getAccessToken();
  const productSet = `projects/${projectId}/locations/${location}/productSets/${productSetId}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.VISION_PROVIDER_TIMEOUT_MS || "2200"));

  try {
    const response = await fetch("https://vision.googleapis.com/v1p4beta1/images:annotate", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [{
          image: { content: imageContent },
          features: [{ type: "PRODUCT_SEARCH" }, { type: "OBJECT_LOCALIZATION", maxResults: 10 }],
          imageContext: {
            productSearchParams: {
              productSet,
              productCategories: [productCategory],
            },
          },
        }],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new PlatformError("provider_request_failed", `Google Product Search failed with HTTP ${response.status}`, 502, {
        provider: "google_product_search",
        status: response.status,
        payload,
      });
    }
    return {
      provider: "google_product_search",
      modelVersion: "google_vision_product_search:v1p4beta1",
      location,
      productSet,
      candidates: normalizeGoogleProductSearchResponse(payload),
      detections: normalizeGoogleProductSearchDetections(payload),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runGoogleVisionOcr(input: { imageBase64?: string }): Promise<{ text: string; modelVersion: string }> {
  const imageContent = normalizeBase64Image(input.imageBase64);
  const accessToken = await getAccessToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.VISION_PROVIDER_TIMEOUT_MS || "2200"));

  try {
    const response = await fetch("https://vision.googleapis.com/v1/images:annotate", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [{
          image: { content: imageContent },
          features: [{ type: "TEXT_DETECTION" }],
        }],
      }),
    });
    const payload = await response.json().catch(() => ({})) as {
      responses?: Array<{ fullTextAnnotation?: { text?: string }; textAnnotations?: Array<{ description?: string }> }>;
    };
    if (!response.ok) {
      throw new PlatformError("provider_request_failed", `Google Vision OCR failed with HTTP ${response.status}`, 502, {
        provider: "google_vision_ocr",
        status: response.status,
        payload,
      });
    }
    const first = payload.responses?.[0];
    return {
      text: String(first?.fullTextAnnotation?.text || first?.textAnnotations?.[0]?.description || "").trim(),
      modelVersion: "google_vision_ocr:text_detection:v1",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedTokens(value: string): string[] {
  return Array.from(new Set(
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  ));
}

export interface GoogleObjectLocalizationDetection {
  objectId: string;
  bbox?: Record<string, unknown>;
  objectLabel?: string;
  objectConfidence?: number;
  warnings: string[];
}

export function normalizeGoogleObjectLocalizationResponse(payload: unknown): GoogleObjectLocalizationDetection[] {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const responses = Array.isArray(root.responses) ? root.responses : [];
  const first = responses[0] && typeof responses[0] === "object" ? responses[0] as Record<string, unknown> : {};
  const objects = Array.isArray(first.localizedObjectAnnotations) ? first.localizedObjectAnnotations : [];
  const minConfidence = Math.max(0, Math.min(1, Number(process.env.VISION_OBJECT_LOCALIZATION_MIN_CONFIDENCE || "0.35")));

  return objects
    .map((item, index): GoogleObjectLocalizationDetection | null => {
      const object = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const confidence = Math.max(0, Math.min(1, Number(object.score || 0)));
      if (confidence < minConfidence) return null;
      const boundingPoly = object.boundingPoly && typeof object.boundingPoly === "object"
        ? object.boundingPoly as Record<string, unknown>
        : undefined;
      return {
        objectId: `obj_${index + 1}`,
        bbox: boundingPoly ? { ...boundingPoly, source: "object_localization" } : undefined,
        objectLabel: String(object.name || "").trim() || undefined,
        objectConfidence: confidence,
        warnings: [],
      };
    })
    .filter((item): item is GoogleObjectLocalizationDetection => Boolean(item))
    .sort((a, b) => {
      const aPos = bboxTopLeft(a.bbox);
      const bPos = bboxTopLeft(b.bbox);
      return aPos.top - bPos.top || aPos.left - bPos.left;
    })
    .map((item, index) => ({ ...item, objectId: `obj_${index + 1}` }))
    .slice(0, 8);
}

export async function runGoogleVisionObjectLocalization(input: { imageBase64?: string }): Promise<{ detections: GoogleObjectLocalizationDetection[]; modelVersion: string }> {
  const imageContent = normalizeBase64Image(input.imageBase64);
  const accessToken = await getAccessToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.VISION_PROVIDER_TIMEOUT_MS || "2200"));

  try {
    const response = await fetch("https://vision.googleapis.com/v1/images:annotate", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [{
          image: { content: imageContent },
          features: [{ type: "OBJECT_LOCALIZATION", maxResults: 10 }],
        }],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new PlatformError("provider_request_failed", `Google Vision Object Localization failed with HTTP ${response.status}`, 502, {
        provider: "google_vision_object_localization",
        status: response.status,
        payload,
      });
    }
    return {
      detections: normalizeGoogleObjectLocalizationResponse(payload),
      modelVersion: "google_vision_object_localization:v1",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function rankCatalogByOcrText(
  text: string,
  products: Array<{ id: string; title: string; variants: Array<{ id: string; sku?: string; barcode?: string }> }>,
): ProductSearchCandidate[] {
  const textTokens = normalizedTokens(text);
  if (textTokens.length === 0) return [];
  const textSet = new Set(textTokens);
  return products
    .flatMap((product) => product.variants.map((variant) => {
      const haystack = `${product.title} ${variant.sku || ""} ${variant.barcode || ""}`;
      const candidateTokens = normalizedTokens(haystack);
      const matched = candidateTokens.filter((token) => textSet.has(token)).length;
      const skuBoost = variant.sku && text.toUpperCase().includes(String(variant.sku).toUpperCase().replace(/-/g, " ")) ? 0.25 : 0;
      const brandBoost = candidateTokens[0] && textSet.has(candidateTokens[0]) ? 0.15 : 0;
      const confidence = Math.max(0, Math.min(1, (matched / Math.max(4, candidateTokens.length)) + skuBoost + brandBoost));
      return {
        productId: product.id,
        variantId: variant.id,
        sku: variant.sku || "",
        barcode: variant.barcode || "",
        providerProductRef: `google_vision_ocr:${variant.id}`,
        confidence,
        warnings: ["ocr_fuzzy_match"],
      };
    }))
    .filter((candidate) => candidate.confidence >= Number(process.env.VISION_OCR_MIN_CONFIDENCE || "0.18"))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);
}
