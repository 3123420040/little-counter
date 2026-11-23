import type { PackageFeatureKey } from "@medusa-snus/contracts";
import { PlatformError } from "../errors/platform-error";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { getMerchantSubscriptionStatus, getMerchantIdForLegacyOrganization } from "./subscription-service";
import { getOrCreateUsageBucket } from "./subscription-usage-service";

export type PackageKey = "basic" | "plus" | "ai_fan";
const CANONICAL_FEATURE_KEYS = [
  "sepay_qr_payment",
  "crypto_payment",
  "smart_cross_sell",
  "product_research",
  "customer_scan_go",
  "telegram_ai_ordering",
  "telegram_sales_channel",
  "vision_pos_input",
  "vision_pos_single_capture",
  "vision_pos_bulk_capture",
  "vision_debug_image_storage",
  "vision_correction_report",
] as const satisfies readonly PackageFeatureKey[];
export type CanonicalFeatureKey = (typeof CANONICAL_FEATURE_KEYS)[number];
export type FeatureKey = CanonicalFeatureKey | "sepay_payments" | "crypto_payments" | "cross_sell";

const FEATURE_ALIASES: Record<string, CanonicalFeatureKey> = {
  sepay_payments: "sepay_qr_payment",
  crypto_payments: "crypto_payment",
  cross_sell: "smart_cross_sell",
};

const PACKAGE_FEATURES: Record<PackageKey, CanonicalFeatureKey[]> = {
  basic: [],
  plus: ["sepay_qr_payment", "crypto_payment", "smart_cross_sell", "product_research", "customer_scan_go"],
  ai_fan: [
    "sepay_qr_payment",
    "crypto_payment",
    "smart_cross_sell",
    "product_research",
    "customer_scan_go",
    "telegram_ai_ordering",
    "telegram_sales_channel",
    "vision_pos_input",
    "vision_pos_single_capture",
    "vision_correction_report",
  ],
};

function canonicalFeature(feature: string): CanonicalFeatureKey | null {
  const value = feature.trim();
  if (!value) return null;
  if (FEATURE_ALIASES[value]) return FEATURE_ALIASES[value];
  if ((CANONICAL_FEATURE_KEYS as readonly string[]).includes(value)) {
    return value as CanonicalFeatureKey;
  }
  return null;
}

function packageKeyFromEnv(): PackageKey {
  const value = String(process.env.APP_PACKAGE_KEY || "basic").trim().toLowerCase();
  if (value === "basic" || value === "plus" || value === "ai_fan") return value;
  throw new PlatformError("invalid_package_key", "APP_PACKAGE_KEY must be basic, plus, or ai_fan", 500);
}

function forcedFeatures(): Set<CanonicalFeatureKey> {
  return new Set(
    String(process.env.FEATURE_FLAGS || "")
      .split(",")
      .map((value) => value.trim())
      .map(canonicalFeature)
      .filter((value): value is CanonicalFeatureKey => Boolean(value)),
  );
}

/* ── Synchronous env-based compatibility API ────────────────────────────
 * Preserved so the existing paid-feature guards fail fast before any DB
 * work. Upgrade-path code calls the async effective-capability resolver.
 */

export function hasFeature(feature: FeatureKey): boolean {
  const canonical = canonicalFeature(feature);
  if (!canonical) return false;
  const packageKey = packageKeyFromEnv();
  return PACKAGE_FEATURES[packageKey].includes(canonical) || forcedFeatures().has(canonical);
}

export function requireFeature(feature: FeatureKey): void {
  if (!hasFeature(feature)) {
    const canonical = canonicalFeature(feature) || feature;
    throw new PlatformError("feature_not_entitled", `Current package does not include feature: ${canonical}`, 403, {
      feature: canonical,
      packageKey: packageKeyFromEnv(),
    });
  }
}

export function getPackageEntitlements() {
  const packageKey = packageKeyFromEnv();
  const features = Array.from(new Set([...PACKAGE_FEATURES[packageKey], ...forcedFeatures()]));
  return {
    data: {
      packageKey,
      features,
    },
  };
}

/* ── DB-backed effective-capability resolver ────────────────────────────
 * Combines package, integration health, permission/scope and quota gates
 * and returns structured denial reasons. Mirrors the shared contract
 * ("Package entitlement, kill switch, provider readiness, permission,
 * scope and quota are separate gates"). Permission/scope checks are owned
 * by the callers; this resolver handles subscription +
 * integration + quota.
 */

export interface EffectiveCapabilityResult {
  allowed: boolean;
  reasons: CapabilityDenialReason[];
  packageKey: PackageKey;
  featureKey: CanonicalFeatureKey;
}

export interface CapabilityDenialReason {
  gate: "subscription" | "kill_switch" | "integration" | "permission" | "scope" | "quota";
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ProviderAvailabilityForCapability {
  sepay_va: { enabled: boolean; reason?: string };
  nowpayments: { enabled: boolean; reason?: string };
}

export interface EvaluateCapabilityOptions {
  organizationId?: string;
  merchantId?: string;
  client?: PoolClient;
  now?: Date;
  providerAvailability?: ProviderAvailabilityForCapability;
}

export async function resolvePackageEntitlements(
  options: { organizationId?: string; merchantId?: string; client?: PoolClient } = {},
): Promise<{ packageKey: PackageKey; features: CanonicalFeatureKey[]; subscriptionStatus?: string }> {
  if (options.merchantId || options.organizationId) {
    const run = async (client: PoolClient) => {
      const merchantId = options.merchantId || (await getMerchantIdForLegacyOrganization(options.organizationId, { client }));
      const subscription = await getMerchantSubscriptionStatus(merchantId, { client });
      const dbFeatures = await listFeaturesForSubscription(client, subscription.catalogVersionId);
      return {
        packageKey: subscription.packageKey as PackageKey,
        features: Array.from(new Set<CanonicalFeatureKey>(dbFeatures)),
        subscriptionStatus: subscription.status,
      };
    };
    if (options.client) return run(options.client);
    await ensurePlatformSchema();
    return withConnectedClient(run);
  }
  const packageKey = packageKeyFromEnv();
  return { packageKey, features: Array.from(new Set([...PACKAGE_FEATURES[packageKey], ...forcedFeatures()])) };
}

export async function evaluateCapability(
  feature: FeatureKey,
  options: EvaluateCapabilityOptions = {},
): Promise<EffectiveCapabilityResult> {
  const canonical = canonicalFeature(feature) || (feature as CanonicalFeatureKey);
  const unknown = !canonicalFeature(feature);
  if (unknown) {
    return {
      allowed: false,
      reasons: [{ gate: "subscription", code: "feature_not_entitled", message: `Unknown feature: ${feature}`, details: { feature } }],
      packageKey: "basic",
      featureKey: canonical,
    };
  }

  const entitlements = await resolvePackageEntitlements(options);
  const reasons: CapabilityDenialReason[] = [];

  if (!entitlements.features.includes(canonical)) {
    reasons.push({
      gate: "subscription",
      code: "feature_not_entitled",
      message: `Current package does not include feature: ${canonical}`,
      details: { feature: canonical, packageKey: entitlements.packageKey, subscriptionStatus: entitlements.subscriptionStatus || "unknown" },
    });
  }

  if (entitlements.subscriptionStatus === "expired") {
    reasons.push({
      gate: "subscription",
      code: "subscription_expired",
      message: "Subscription has expired; paid actions are blocked (Basic fallback only)",
      details: { subscriptionStatus: entitlements.subscriptionStatus },
    });
  }

  const provider = providerGate(canonical);
  if (provider && options.providerAvailability) {
    const gate = options.providerAvailability[provider];
    if (!gate.enabled) {
      reasons.push({
        gate: "integration",
        code: gate.reason || "provider_disabled",
        message: `Payment provider is not ready: ${provider}`,
        details: { provider, reason: gate.reason },
      });
    }
  }

  if (canonical === "product_research" || canonical === "telegram_ai_ordering") {
    try {
      const metricKey = canonical === "product_research" ? "product_research_runs" : "telegram_ai_drafts";
      const merchantId = options.merchantId || (await getMerchantIdForLegacyOrganization(options.organizationId, { client: options.client }));
      const bucket = await getOrCreateUsageBucket(merchantId, metricKey, { client: options.client, now: options.now });
      const available = (bucket.includedQuantity ?? Infinity) - bucket.usedQuantity - bucket.reservedQuantity;
      if (available <= 0) {
        reasons.push({
          gate: "quota",
          code: "quota_exceeded",
          message: `Monthly quota exceeded for ${canonical}`,
          details: { metricKey: bucket.metricKey, includedQuantity: bucket.includedQuantity, usedQuantity: bucket.usedQuantity, reservedQuantity: bucket.reservedQuantity },
        });
      }
    } catch (_err) {
      // Env fallback: quota table unavailable; subscription gate already decided.
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    packageKey: entitlements.packageKey,
    featureKey: canonical,
  };
}

export async function requireFeatureCapability(
  feature: FeatureKey,
  options: EvaluateCapabilityOptions = {},
): Promise<EffectiveCapabilityResult> {
  const result = await evaluateCapability(feature, options);
  if (!result.allowed) {
    const first = result.reasons[0];
    const statusCode = first.gate === "kill_switch" || first.gate === "integration" ? 503 : first.gate === "quota" ? 429 : 403;
    throw new PlatformError(first.code, first.message, statusCode, {
      feature: result.featureKey,
      packageKey: result.packageKey,
      reasons: result.reasons,
    });
  }
  return result;
}

function providerGate(feature: CanonicalFeatureKey): "sepay_va" | "nowpayments" | null {
  if (feature === "sepay_qr_payment") return "sepay_va";
  if (feature === "crypto_payment") return "nowpayments";
  return null;
}

async function listFeaturesForSubscription(client: PoolClient, catalogVersionId: string): Promise<CanonicalFeatureKey[]> {
  const row = await queryOne<{ feature_keys: string[] }>(client, `
    SELECT feature_keys FROM app.package_catalog_versions WHERE id = $1 LIMIT 1
  `, [catalogVersionId]);
  const raw = row?.feature_keys || [];
  const canonicalKeys: CanonicalFeatureKey[] = [];
  for (const key of raw) {
    const canonical = canonicalFeature(key);
    if (canonical) canonicalKeys.push(canonical);
  }
  return canonicalKeys;
}

export type { PackageFeatureKey };
