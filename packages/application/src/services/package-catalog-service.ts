import type { PackageKey, PackageFeatureKey, MoneyVnd, PackageCatalogVersionSnapshot } from "@medusa-snus/contracts";
import {
  packageCatalogVersion,
  vndPackagePrices,
  packageFeatureKeys,
} from "@medusa-snus/contracts";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";

export interface CatalogEntry {
  catalogVersionId: string;
  catalogVersion: string;
  packageKey: PackageKey;
  annualPrice: MoneyVnd;
  includedStores: number;
  staffLimit: number;
  researchRunsPerMonth: number;
  telegramAiDraftsPerMonth: number;
  featureKeys: PackageFeatureKey[];
}

const CATALOG_FEATURE_MAP: Record<PackageKey, PackageFeatureKey[]> = {
  basic: ["pos_core", "accounting_core"],
  plus: ["pos_core", "accounting_core", "sepay_qr_payment", "crypto_payment", "smart_cross_sell", "product_research", "customer_scan_go"],
  ai_fan: [
    "pos_core", "accounting_core", "telegram_runtime", "sepay_qr_payment", "crypto_payment",
    "smart_cross_sell", "product_research", "customer_scan_go", "telegram_ai_ordering",
    "telegram_sales_channel", "vision_pos_input", "vision_pos_single_capture", "vision_correction_report",
  ],
};

const RESEARCH_RUNS: Record<PackageKey, number> = { basic: 0, plus: 100, ai_fan: 500 };
const TELEGRAM_AI_DRAFTS: Record<PackageKey, number> = { basic: 0, plus: 0, ai_fan: 2000 };

export function getCatalogEntryInMemory(packageKey: PackageKey): CatalogEntry {
  return {
    catalogVersionId: `pcv_${packageCatalogVersion.replace(/\./g, "_").replace(/-/g, "_")}_${packageKey}`,
    catalogVersion: packageCatalogVersion,
    packageKey,
    annualPrice: { currencyCode: "vnd", amountVnd: vndPackagePrices[packageKey] },
    includedStores: { basic: 1, plus: 3, ai_fan: 5 }[packageKey],
    staffLimit: { basic: 3, plus: 10, ai_fan: 30 }[packageKey],
    researchRunsPerMonth: RESEARCH_RUNS[packageKey],
    telegramAiDraftsPerMonth: TELEGRAM_AI_DRAFTS[packageKey],
    featureKeys: CATALOG_FEATURE_MAP[packageKey],
  };
}

function rowToCatalogEntry(row: Record<string, unknown>): CatalogEntry {
  return {
    catalogVersionId: String(row.id),
    catalogVersion: String(row.catalog_version),
    packageKey: String(row.package_key) as PackageKey,
    annualPrice: { currencyCode: "vnd", amountVnd: String(row.annual_price_vnd) },
    includedStores: Number(row.included_stores),
    staffLimit: Number(row.staff_limit),
    researchRunsPerMonth: Number(row.research_runs_per_month),
    telegramAiDraftsPerMonth: Number(row.telegram_ai_drafts_per_month),
    featureKeys: Array.isArray(row.feature_keys)
      ? (row.feature_keys as string[]).filter((f): f is PackageFeatureKey => packageFeatureKeys.includes(f as PackageFeatureKey))
      : [],
  };
}

export async function getCatalogEntry(packageKey: PackageKey, options?: { client?: PoolClient }): Promise<CatalogEntry> {
  if (options?.client) {
    const row = await queryOne<{ [key: string]: unknown }>(options.client, `
      SELECT * FROM app.package_catalog_versions
      WHERE catalog_version = $1 AND package_key = $2 AND is_published = true
      ORDER BY effective_from DESC
      LIMIT 1
    `, [packageCatalogVersion, packageKey]);
    if (!row) return getCatalogEntryInMemory(packageKey);
    return rowToCatalogEntry(row);
  }

  await ensurePlatformSchema();
  return withConnectedClient(async (client) => getCatalogEntry(packageKey, { client }));
}

export async function getCatalogVersionSnapshot(versionId: string, options?: { client?: PoolClient }): Promise<PackageCatalogVersionSnapshot> {
  const fetch = async (client: PoolClient) => {
    const row = await queryOne<{ [key: string]: unknown }>(client, `
      SELECT * FROM app.package_catalog_versions WHERE id = $1 LIMIT 1
    `, [versionId]);
    if (!row) {
      throw new PlatformError("resource_not_found", `Package catalog version not found: ${versionId}`, 404);
    }
    const entry = rowToCatalogEntry(row);
    return {
      catalogVersionId: entry.catalogVersionId,
      catalogVersion: packageCatalogVersion,
      packageKey: entry.packageKey,
      annualPrice: entry.annualPrice,
      includedStores: entry.includedStores,
      staffLimit: entry.staffLimit,
      researchRunsPerMonth: entry.researchRunsPerMonth,
      telegramAiDraftsPerMonth: entry.telegramAiDraftsPerMonth,
      featureKeys: entry.featureKeys,
      effectiveFrom: new Date(String(row.effective_from)).toISOString(),
    };
  };

  if (options?.client) return fetch(options.client);
  await ensurePlatformSchema();
  return withConnectedClient(fetch);
}

export interface ListCatalogInput {
  packageKey?: PackageKey;
  includeArchived?: boolean;
}

export async function listCatalogEntries(input?: ListCatalogInput, options?: { client?: PoolClient }): Promise<{
  data: {
    catalogVersion: string;
    entries: CatalogEntry[];
  };
}> {
  const fetch = async (client: PoolClient) => {
    const params: unknown[] = [packageCatalogVersion];
    const packageFilter = input?.packageKey ? "AND package_key = $2" : "";
    if (input?.packageKey) params.push(input.packageKey);
    const publishedFilter = !input?.includeArchived ? "AND is_published = true" : "";
    const rows = await client.query(`
      SELECT * FROM app.package_catalog_versions
      WHERE catalog_version = $1 ${packageFilter} ${publishedFilter}
      ORDER BY package_key
    `, params);
    const entries = rows.rows.map(rowToCatalogEntry);
    return { data: { catalogVersion: packageCatalogVersion, entries } };
  };

  if (options?.client) return fetch(options.client);
  await ensurePlatformSchema();
  return withConnectedClient(fetch);
}

export async function findCatalogVersionIdByPackageKey(
  packageKey: PackageKey,
  options?: { client?: PoolClient },
): Promise<string> {
  const entry = await getCatalogEntry(packageKey, options);
  return entry.catalogVersionId;
}
