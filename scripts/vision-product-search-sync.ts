import { createSign } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

export type ManifestItem = {
  merchantId?: string;
  status?: string;
  imageId?: string;
  productId?: string;
  variantId?: string;
  sku?: string;
  title?: string;
  localPath?: string;
  filename?: string;
  contentType?: string;
};

export type DbImageRow = {
  image_id: string;
  merchant_id: string;
  store_id: string | null;
  product_id: string;
  variant_id: string;
  title: string;
  sku: string;
  barcode: string;
  image_url: string;
  image_type: string;
};

export type ProductSearchSyncArgs = {
  execute: boolean;
  strict: boolean;
  limit: number;
  databaseUrl: string;
  manifestPath: string;
  merchantId?: string;
  storeId?: string;
  help: boolean;
};

export type ManifestIndex = Map<string, ManifestItem | null>;

export type ReferenceImageSource =
  | { kind: "gcs"; gcsUri: string }
  | { kind: "upload"; localPath: string; contentType: string }
  | { kind: "missing"; reason: string };

export type ProductSearchSyncResult = {
  rows: number;
  synced: number;
  failed: number;
  missingSource: number;
  reusableGcs: number;
  uploadable: number;
  missingExamples: Array<{ imageId: string; variantId: string; reason: string }>;
};

type Queryable = {
  query<T = unknown>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export function printUsage(): void {
  console.log([
    "Usage:",
    "  npm run vision:product-search-sync -- [options]",
    "",
    "Options:",
    "  --execute                 Call Google APIs and update provider index rows",
    "  --strict                  Exit non-zero when any eligible image fails to sync",
    "  --limit <n>               Limit approved image rows processed",
    "  --database-url <url>      Database URL (default: DATABASE_URL)",
    "  --manifest <path>         Download manifest for HTTPS images that need GCS upload",
    "  --merchant-id <id>        Restrict sync to one merchant",
    "  --store-id <id|null>      Restrict sync to one store or null store scope",
    "  --help, -h                Show usage",
    "",
    "Behavior:",
    "  Dry-run is the default. Execute mode syncs only approved app.product_variant_images rows.",
    "  gs:// image URLs are used directly. HTTPS/local source rows require a downloaded manifest item.",
    "  Failed execute rows are recorded as sync_status=failed in app.vision_catalog_index_items.",
  ].join("\n"));
}

export function parseProductSearchSyncArgs(argv = process.argv.slice(2)): ProductSearchSyncArgs {
  const value = (name: string, fallback = "") => {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${name} requires a value.`);
    return next;
  };

  const limitRaw = value("--limit", "0");
  const limit = Number(limitRaw) || 0;
  if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer.");

  const knownWithValues = new Set(["--limit", "--database-url", "--manifest", "--merchant-id", "--store-id"]);
  const knownFlags = new Set(["--execute", "--strict", "--help", "-h"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (knownFlags.has(token)) continue;
    if (knownWithValues.has(token)) {
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  return {
    execute: argv.includes("--execute"),
    strict: argv.includes("--strict"),
    limit,
    databaseUrl: value("--database-url", process.env.DATABASE_URL),
    manifestPath: value("--manifest", process.env.VISION_PRODUCT_SEARCH_MANIFEST),
    merchantId: value("--merchant-id") || undefined,
    storeId: value("--store-id") || undefined,
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function requiredEnv(name: string, fallback?: string): string {
  const value = (process.env[name] || fallback || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function safeId(prefix: string, value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 110);
  return `${prefix}${normalized}`.slice(0, 128);
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function accessToken(): Promise<string> {
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS_HOST_PATH?.trim()
    || requiredEnv("GOOGLE_APPLICATION_CREDENTIALS");
  const credentials = JSON.parse(await readFile(credentialsPath, "utf8")) as {
    client_email?: string;
    private_key?: string;
    token_uri?: string;
  };
  if (!credentials.client_email || !credentials.private_key) throw new Error("Invalid service account JSON");
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = credentials.token_uri || "https://oauth2.googleapis.com/token";
  const unsigned = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: tokenUri,
    exp: now + 3600,
    iat: now,
  })}`;
  const assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key, "base64url")}`;
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const payload = await response.json().catch(() => ({})) as { access_token?: string; error?: string };
  if (!response.ok || !payload.access_token) throw new Error(`Google token failed: ${response.status} ${payload.error || ""}`);
  return payload.access_token;
}

async function googleJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 409) return payload as T;
  if (!response.ok) throw new Error(`Google API failed ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  return payload as T;
}

function bucketName(raw: string): string {
  return raw.replace(/^gs:\/\//, "").replace(/\/+$/g, "");
}

function normalizePrefix(raw: string): string {
  return raw.replace(/^\/+|\/+$/g, "");
}

function contentTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function uploadObject(input: {
  token: string;
  bucket: string;
  objectName: string;
  contentType: string;
  localPath: string;
}): Promise<string> {
  const bytes = await readFile(input.localPath);
  const response = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(input.bucket)}/o?uploadType=media&name=${encodeURIComponent(input.objectName)}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${input.token}`,
      "Content-Type": input.contentType,
    },
    body: bytes,
  });
  if (!response.ok && response.status !== 409) {
    const payload = await response.text().catch(() => "");
    throw new Error(`GCS upload failed ${response.status}: ${payload.slice(0, 500)}`);
  }
  return `gs://${input.bucket}/${input.objectName}`;
}

function addManifestKey(index: ManifestIndex, key: string | undefined, item: ManifestItem): void {
  const normalized = String(key || "").trim();
  if (!normalized) return;
  const previous = index.get(normalized);
  index.set(normalized, previous === undefined || previous === item ? item : null);
}

export async function loadManifest(path: string): Promise<ManifestIndex> {
  const index: ManifestIndex = new Map();
  if (!existsSync(path)) return index;
  const parsed = JSON.parse(await readFile(path, "utf8")) as { items?: ManifestItem[] } | ManifestItem[];
  const items = Array.isArray(parsed) ? parsed : parsed.items || [];
  for (const item of items) {
    if (item.status !== "downloaded" || !item.localPath) continue;
    addManifestKey(index, item.imageId, item);
    addManifestKey(index, item.productId, item);
    addManifestKey(index, item.variantId, item);
    if (item.merchantId && item.sku) addManifestKey(index, `merchant:${item.merchantId}:sku:${item.sku}`, item);
    if (item.merchantId && item.filename) addManifestKey(index, `merchant:${item.merchantId}:filename:${item.filename}`, item);
  }
  return index;
}

function manifestItemFor(row: DbImageRow, manifest: ManifestIndex): ManifestItem | undefined {
  const keys = [row.image_id, row.product_id, row.variant_id,
    `merchant:${row.merchant_id}:sku:${row.sku}`,
    `merchant:${row.merchant_id}:filename:${basename(row.image_url)}`];
  if (manifest.get(row.image_id) === null) throw new Error("Ambiguous image manifest fallback; use a unique image ID");
  for (const key of keys) {
    const item = manifest.get(key);
    if (item) return item;
  }
  if (keys.some((key) => manifest.get(key) === null)) {
    throw new Error("Ambiguous image manifest fallback; use the exact image ID");
  }
  return undefined;
}

export function resolveReferenceImageSource(row: DbImageRow, manifest: ManifestIndex): ReferenceImageSource {
  if (row.image_url.startsWith("gs://")) {
    return { kind: "gcs", gcsUri: row.image_url.replace(/\/+$/g, "") };
  }

  const item = manifestItemFor(row, manifest);
  if (item?.localPath) {
    return {
      kind: "upload",
      localPath: item.localPath,
      contentType: item.contentType || contentTypeForPath(item.localPath),
    };
  }

  return {
    kind: "missing",
    reason: `approved image ${row.image_id} is not a gs:// URI and has no downloaded manifest file`,
  };
}

export async function resolveReferenceImageSourceReadiness(row: DbImageRow, manifest: ManifestIndex): Promise<ReferenceImageSource> {
  const source = resolveReferenceImageSource(row, manifest);
  if (source.kind === "upload" && !(await fileExists(source.localPath))) {
    return {
      kind: "missing",
      reason: `manifest localPath does not exist: ${source.localPath}`,
    };
  }
  return source;
}

export async function summarizeReferenceImageSources(rows: DbImageRow[], manifest: ManifestIndex): Promise<Pick<ProductSearchSyncResult, "missingSource" | "reusableGcs" | "uploadable" | "missingExamples">> {
  const result = {
    missingSource: 0,
    reusableGcs: 0,
    uploadable: 0,
    missingExamples: [] as ProductSearchSyncResult["missingExamples"],
  };

  for (const row of rows) {
    const source = await resolveReferenceImageSourceReadiness(row, manifest);
    if (source.kind === "gcs") result.reusableGcs += 1;
    else if (source.kind === "upload") result.uploadable += 1;
    else {
      result.missingSource += 1;
      if (result.missingExamples.length < 10) {
        result.missingExamples.push({ imageId: row.image_id, variantId: row.variant_id, reason: source.reason });
      }
    }
  }

  return result;
}

export function buildObjectName(row: DbImageRow, localPath: string, prefix: string): string {
  const filename = basename(localPath).replace(/[^A-Za-z0-9._-]/g, "_") || `${row.image_id}.jpg`;
  return [
    normalizePrefix(prefix) || "reference-images/production",
    "product-search",
    safeId("", row.merchant_id),
    safeId("", row.variant_id),
    `${safeId("", row.image_id)}-${filename}`,
  ].join("/");
}

export function buildApprovedImageQuery(args: Pick<ProductSearchSyncArgs, "merchantId" | "storeId" | "limit">): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const maxPerVariant = Number(process.env.VISION_REFERENCE_MAX_SYNCED_PER_VARIANT || "15");
  const syncCap = Number.isInteger(maxPerVariant) && maxPerVariant > 0 ? maxPerVariant : 15;
  const where = [
    "image.quality_status = 'approved'",
    "COALESCE(image.image_url, '') <> ''",
    "p.status = 'published'",
  ];

  if (args.merchantId) {
    values.push(args.merchantId);
    where.push(`image.merchant_id = $${values.length}`);
  }
  if (args.storeId) {
    if (args.storeId === "null") {
      where.push("image.store_id IS NULL");
    } else {
      values.push(args.storeId);
      where.push(`image.store_id = $${values.length}`);
    }
  }

  let limitClause = "";
  if (args.limit > 0) {
    values.push(args.limit);
    limitClause = `LIMIT $${values.length}`;
  }

  return {
    sql: `
      SELECT
        image.id::text AS image_id,
        image.merchant_id,
        image.store_id,
        image.product_id,
        image.variant_id,
        p.title,
        COALESCE(v.sku, '') AS sku,
        COALESCE(v.barcode, '') AS barcode,
        image.image_url,
        image.image_type
      FROM (
        SELECT
          image.*,
          row_number() OVER (
            PARTITION BY image.merchant_id, COALESCE(image.store_id, ''), image.variant_id
            ORDER BY image.is_primary DESC, image.quality_score DESC NULLS LAST, image.created_at DESC
          ) AS sync_rank
        FROM app.product_variant_images image
        JOIN public.product p ON p.id = image.product_id AND p.deleted_at IS NULL
        WHERE ${where.join("\n          AND ")}
      ) image
      JOIN public.product p ON p.id = image.product_id AND p.deleted_at IS NULL
      JOIN public.product_variant v ON v.id = image.variant_id AND v.deleted_at IS NULL
      WHERE image.sync_rank <= ${syncCap}
      ORDER BY image.merchant_id ASC, p.title ASC, image.sync_rank ASC, image.created_at DESC
      ${limitClause}
    `,
    values,
  };
}

async function listDbImages(pool: Queryable, args: ProductSearchSyncArgs): Promise<DbImageRow[]> {
  const query = buildApprovedImageQuery(args);
  const result = await pool.query<DbImageRow>(query.sql, query.values);
  return result.rows;
}

async function markIndexStatus(pool: Queryable, row: DbImageRow, input: {
  providerLocation: string;
  productSetRef: string;
  productRef?: string;
  imageRef?: string;
  status: "synced" | "failed";
  syncError?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const existing = await pool.query<{ id: string }>(`
    SELECT id::text
    FROM app.vision_catalog_index_items
    WHERE merchant_id = $1
      AND store_id IS NOT DISTINCT FROM $2
      AND provider = 'google_product_search'
      AND provider_location = $3
      AND provider_product_set_ref = $4
      AND variant_id = $5
      AND image_id = $6
    LIMIT 1
  `, [row.merchant_id, row.store_id, input.providerLocation, input.productSetRef, row.variant_id, row.image_id]);

  const metadataJson = JSON.stringify(input.metadata || {});
  if (existing.rows[0]) {
    await pool.query(`
      UPDATE app.vision_catalog_index_items
      SET provider_product_ref = COALESCE($2, provider_product_ref),
          provider_image_ref = COALESCE($3, provider_image_ref),
          sync_status = $4,
          sync_error = $5,
          synced_at = CASE WHEN $4 = 'synced' THEN now() ELSE synced_at END,
          metadata = metadata || $6::jsonb,
          updated_at = now()
      WHERE id = $1
    `, [existing.rows[0].id, input.productRef || null, input.imageRef || null, input.status, input.syncError || null, metadataJson]);
    return;
  }

  await pool.query(`
    INSERT INTO app.vision_catalog_index_items (
      merchant_id, store_id, product_id, variant_id, image_id, provider,
      provider_location, provider_product_set_ref, provider_product_ref,
      provider_image_ref, sync_status, sync_error, synced_at, metadata
    )
    VALUES ($1, $2, $3, $4, $5, 'google_product_search', $6, $7, $8, $9, $10, $11, CASE WHEN $10 = 'synced' THEN now() ELSE NULL END, $12::jsonb)
  `, [
    row.merchant_id,
    row.store_id,
    row.product_id,
    row.variant_id,
    row.image_id,
    input.providerLocation,
    input.productSetRef,
    input.productRef || null,
    input.imageRef || null,
    input.status,
    input.syncError || null,
    metadataJson,
  ]);
}

async function syncOneImage(input: {
  pool: Queryable;
  row: DbImageRow;
  token: string;
  projectId: string;
  location: string;
  productCategory: string;
  productSetRef: string;
  bucket: string;
  prefix: string;
  manifest: ManifestIndex;
}): Promise<void> {
  const productId = safeId("v_", input.row.variant_id);
  const referenceImageId = safeId("ri_", input.row.image_id.replace(/-/g, "_"));
  const productRef = `projects/${input.projectId}/locations/${input.location}/products/${productId}`;
  const imageRef = `${productRef}/referenceImages/${referenceImageId}`;
  const source = await resolveReferenceImageSourceReadiness(input.row, input.manifest);

  if (source.kind === "missing") throw new Error(source.reason);

  const gcsUri = source.kind === "gcs"
    ? source.gcsUri
    : await uploadObject({
      token: input.token,
      bucket: input.bucket,
      objectName: buildObjectName(input.row, source.localPath, input.prefix),
      contentType: source.contentType,
      localPath: source.localPath,
    });

  await googleJson(`https://vision.googleapis.com/v1/projects/${input.projectId}/locations/${input.location}/products?productId=${encodeURIComponent(productId)}`, input.token, {
    method: "POST",
    body: JSON.stringify({
      displayName: input.row.title,
      productCategory: input.productCategory,
      productLabels: [
        { key: "productId", value: input.row.product_id },
        { key: "variantId", value: input.row.variant_id },
        { key: "sku", value: input.row.sku },
        { key: "barcode", value: input.row.barcode },
      ].filter((label) => label.value),
    }),
  });
  await googleJson(`https://vision.googleapis.com/v1/${input.productSetRef}:addProduct`, input.token, {
    method: "POST",
    body: JSON.stringify({ product: productRef }),
  });
  await googleJson(`https://vision.googleapis.com/v1/${productRef}/referenceImages?referenceImageId=${encodeURIComponent(referenceImageId)}`, input.token, {
    method: "POST",
    body: JSON.stringify({ uri: gcsUri }),
  });
  await markIndexStatus(input.pool, input.row, {
    providerLocation: input.location,
    productSetRef: input.productSetRef,
    productRef,
    imageRef,
    status: "synced",
    syncError: null,
    metadata: { gcsUri, source: source.kind, imageType: input.row.image_type },
  });
}

export async function runProductSearchSync(args: ProductSearchSyncArgs): Promise<ProductSearchSyncResult> {
  const projectId = requiredEnv("GOOGLE_CLOUD_PROJECT_ID");
  const location = requiredEnv("GOOGLE_PRODUCT_SEARCH_LOCATION", "asia-east1");
  const productSetId = requiredEnv("GOOGLE_PRODUCT_SEARCH_PRODUCT_SET_ID", "snus_pos_v14_pilot");
  const productCategory = requiredEnv("GOOGLE_PRODUCT_SEARCH_PRODUCT_CATEGORY", "packagedgoods-v1");
  const bucket = bucketName(requiredEnv("GOOGLE_VISION_REFERENCE_BUCKET"));
  const prefix = process.env.GOOGLE_VISION_REFERENCE_PREFIX || "reference-images/production";
  const productSetRef = `projects/${projectId}/locations/${location}/productSets/${productSetId}`;
  if (!args.databaseUrl) throw new Error("DATABASE_URL or --database-url is required");
  const manifest = await loadManifest(args.manifestPath);
  const pool = new Pool({ connectionString: args.databaseUrl });
  const result: ProductSearchSyncResult = { rows: 0, synced: 0, failed: 0, missingSource: 0, reusableGcs: 0, uploadable: 0, missingExamples: [] };

  try {
    const rows = await listDbImages(pool, args);
    result.rows = rows.length;
    Object.assign(result, await summarizeReferenceImageSources(rows, manifest));

    console.log(JSON.stringify({
      mode: args.execute ? "execute" : "dry-run",
      rows: result.rows,
      reusableGcs: result.reusableGcs,
      uploadable: result.uploadable,
      missingSource: result.missingSource,
      missingExamples: result.missingExamples,
      productSetRef,
      bucket,
      maxSyncedPerVariant: Number(process.env.VISION_REFERENCE_MAX_SYNCED_PER_VARIANT || "15"),
      merchantId: args.merchantId || "all",
      storeId: args.storeId || "all",
    }, null, 2));
    if (!args.execute) {
      if (args.strict && result.missingSource > 0) {
        throw new Error(`Product Search dry-run has ${result.missingSource} image(s) without a syncable source`);
      }
      return result;
    }

    const token = await accessToken();
    await googleJson(`https://vision.googleapis.com/v1/projects/${projectId}/locations/${location}/productSets?productSetId=${encodeURIComponent(productSetId)}`, token, {
      method: "POST",
      body: JSON.stringify({ displayName: "Snus POS v1.4 Pilot" }),
    });

    for (const row of rows) {
      try {
        await syncOneImage({
          pool,
          row,
          token,
          projectId,
          location,
          productCategory,
          productSetRef,
          bucket,
          prefix,
          manifest,
        });
        result.synced += 1;
      } catch (error) {
        result.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        await markIndexStatus(pool, row, {
          providerLocation: location,
          productSetRef,
          status: "failed",
          syncError: message.slice(0, 1000),
          metadata: { sourceImageUrl: row.image_url, imageType: row.image_type },
        });
        console.error(JSON.stringify({ imageId: row.image_id, variantId: row.variant_id, status: "failed", error: message }));
      }
    }

    console.log(JSON.stringify(result, null, 2));
    if (args.strict && result.failed > 0) {
      throw new Error(`Product Search sync failed for ${result.failed} image(s)`);
    }
    return result;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const args = parseProductSearchSyncArgs();
  if (args.help) {
    printUsage();
    return;
  }
  await runProductSearchSync(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
