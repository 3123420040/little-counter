import { createSign, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PlatformError } from "../errors/platform-error";
import { normalizeVisionImageBase64 } from "./vision-image-validation";

const googleCloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";

interface ServiceAccountJson {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
}

interface TokenCache {
  accessToken: string;
  expiresAtMs: number;
}

export interface VisionStoredObject {
  bucket: string;
  objectName: string;
  storageKey: string;
  gcsUri: string;
  contentType: string;
  byteSize: number;
}

let googleTokenCache: TokenCache | null = null;

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value === "true";
}

function requiredEnv(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new PlatformError("provider_config_missing", `${name} is required`, 503);
  return value;
}

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] || fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
    signal: AbortSignal.timeout(5000),
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

function storageBucket(): string {
  const bucket = requiredEnv("GOOGLE_VISION_REFERENCE_BUCKET").replace(/^gs:\/\//, "").replace(/\/+$/g, "");
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new PlatformError("provider_config_missing", "GOOGLE_VISION_REFERENCE_BUCKET is invalid", 503);
  }
  return bucket;
}

function requireSafeObjectName(value: unknown): string {
  const objectName = String(value || "").trim();
  if (
    !objectName
    || objectName.startsWith("/")
    || objectName.length > 1_024
    || objectName.split("/").includes("..")
  ) {
    throw new PlatformError("validation_error", "Invalid vision storage object name", 400);
  }
  return objectName;
}

function safeObjectPart(value: unknown, fallback: string): string {
  const normalized = String(value || fallback)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}

function extensionForContentType(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

export function visionRawImageStorageEnabled(): boolean {
  return envFlag("VISION_RAW_IMAGE_STORAGE_ENABLED", false) || envFlag("VISION_DEBUG_IMAGE_STORAGE", false);
}

export function visionLearningEnabled(): boolean {
  return envFlag("VISION_LEARNING_ENABLED", false);
}

export async function uploadVisionStorageObject(input: {
  objectName: string;
  bytes: Buffer;
  contentType: string;
}): Promise<VisionStoredObject> {
  const objectName = requireSafeObjectName(input.objectName);
  const bucket = storageBucket();
  const token = await googleAccessToken();
  const response = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": input.contentType,
    },
    body: input.bytes as unknown as RequestInit["body"],
  });
  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    throw new PlatformError("provider_request_failed", "GCS vision image upload failed", 502, {
      status: response.status,
      payload: payload.slice(0, 500),
    });
  }
  return {
    bucket,
    objectName,
    storageKey: objectName,
    gcsUri: `gs://${bucket}/${objectName}`,
    contentType: input.contentType,
    byteSize: input.bytes.length,
  };
}

export async function readVisionStorageObject(storageKeyOrUri: string): Promise<{ bytes: Buffer; contentType: string; objectName: string; bucket: string }> {
  const normalized = String(storageKeyOrUri || "").trim();
  const bucket = storageBucket();
  let objectName = normalized;
  if (normalized.startsWith("gs://")) {
    const withoutScheme = normalized.slice("gs://".length);
    const separator = withoutScheme.indexOf("/");
    const requestedBucket = separator >= 0 ? withoutScheme.slice(0, separator) : withoutScheme;
    if (requestedBucket !== bucket) {
      throw new PlatformError("validation_error", "Vision storage bucket is not allowed", 400);
    }
    objectName = separator >= 0 ? withoutScheme.slice(separator + 1) : "";
  }
  objectName = requireSafeObjectName(objectName);
  const token = await googleAccessToken();
  const response = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    throw new PlatformError("provider_request_failed", "GCS vision image read failed", 502, {
      status: response.status,
      payload: payload.slice(0, 500),
    });
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    contentType: response.headers.get("content-type") || "application/octet-stream",
    objectName,
    bucket,
  };
}

export async function storeRawVisionScanImages(input: {
  merchantId: string;
  storeId: string;
  imageBase64List: string[];
  imageHash: string;
}): Promise<{ firstStorageKey: string | null; objects: VisionStoredObject[] }> {
  if (!visionRawImageStorageEnabled() && !visionLearningEnabled()) {
    return { firstStorageKey: null, objects: [] };
  }
  if (input.imageBase64List.length === 0) return { firstStorageKey: null, objects: [] };

  const now = new Date();
  const dateParts = [
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ];
  const prefix = String(process.env.GOOGLE_VISION_RAW_SCAN_PREFIX || "raw-scans").trim().replace(/^\/+|\/+$/g, "");
  const maxBytes = positiveIntEnv("VISION_MAX_IMAGE_BYTES", 6 * 1024 * 1024);
  const objects: VisionStoredObject[] = [];

  for (let index = 0; index < input.imageBase64List.length; index += 1) {
    const normalized = normalizeVisionImageBase64(input.imageBase64List[index], { maxBytes });
    const extension = extensionForContentType(normalized.mimeType);
    const objectName = [
      prefix,
      safeObjectPart(input.merchantId, "merchant"),
      safeObjectPart(input.storeId, "store"),
      ...dateParts,
      `${safeObjectPart(input.imageHash.slice(0, 16), "scan")}-${index + 1}-${randomUUID()}.${extension}`,
    ].filter(Boolean).join("/");
    objects.push(await uploadVisionStorageObject({
      objectName,
      bytes: normalized.buffer,
      contentType: normalized.mimeType,
    }));
  }

  return { firstStorageKey: objects[0]?.storageKey || null, objects };
}
