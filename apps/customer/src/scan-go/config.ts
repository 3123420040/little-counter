/* ═══════════════════════════════════════════════════════════════════
   Scan & Go runtime config + route helpers.

   No hardcoded production domains. All URLs derive from the host the app
   is served from (window.location.origin) so the same build works in dev,
   preview, and production.
   ═══════════════════════════════════════════════════════════════════ */

/** Recommended redeemable window for the final cart QR: 30 minutes. */
export const REDEEMABLE_SECONDS = 30 * 60;

/**
 * Age-gate acknowledgement lives in sessionStorage (per tab) and expires
 * after this TTL. It is an acknowledgement, never proof of age; real
 * verification happens at the staff counter.
 */
export const AGE_ACK_TTL_MS = 8 * 60 * 60 * 1000;

export const AGE_ACK_STORAGE_KEY = "scan_go_age_ack";

/**
 * Draft cart state is session-scoped per store. It intentionally carries only
 * the public cart edit secret, not staff checkout tokens.
 */
export const CART_TTL_MS = 8 * 60 * 60 * 1000;

export function cartStorageKey(merchantSlug: string, storeSlug: string): string {
  return `scan_go_cart:${merchantSlug}:${storeSlug}`;
}

/** When true, adapters call the real backend via /api; otherwise in-memory mock. */
export function scanGoLive(): boolean {
  const flag = import.meta.env.VITE_SCAN_GO_LIVE;
  return flag === undefined ? import.meta.env.PROD : readEnvFlag(flag);
}

/** Feature gate for the customer_scan_go Plus entitlement. Default on in mock. */
export function scanGoEnabled(): boolean {
  // Default to enabled so the mock flow runs out of the box. Flip off via
  // VITE_SCAN_GO_ENABLED=0 to exercise the disabled state.
  const env = import.meta.env.VITE_SCAN_GO_ENABLED;
  return env === undefined ? true : readEnvFlag(env);
}

function readEnvFlag(value: unknown): boolean {
  return String(value ?? "").toLowerCase() === "1";
}

/** The origin this app is served from. Never a hardcoded production domain. */
export function publicOrigin(): string {
  if (typeof window !== "undefined" && window.location && window.location.origin) {
    return window.location.origin;
  }
  return "";
}

// ── Route helpers (client-side, React Router) ───────────────────────

export function productPath(merchantSlug: string, storeSlug: string, qrSlug: string): string {
  return `/s/${encodeURIComponent(merchantSlug)}/${encodeURIComponent(storeSlug)}/p/${encodeURIComponent(qrSlug)}`;
}

export function cartPath(merchantSlug: string, storeSlug: string): string {
  return `/s/${encodeURIComponent(merchantSlug)}/${encodeURIComponent(storeSlug)}/cart`;
}

export function readyPath(merchantSlug: string, storeSlug: string): string {
  return `/s/${encodeURIComponent(merchantSlug)}/${encodeURIComponent(storeSlug)}/ready`;
}

export function scanGoEntryPath(merchantSlug: string, storeSlug: string): string {
  return `/s/${encodeURIComponent(merchantSlug)}/${encodeURIComponent(storeSlug)}`;
}

/** The public product URL a shelf QR encodes (product identity only). */
export function productPublicUrl(merchantSlug: string, storeSlug: string, qrSlug: string): string {
  return `${publicOrigin()}${productPath(merchantSlug, storeSlug, qrSlug)}`;
}

/**
 * Best-effort extraction of a product qrSlug from a scanned code, for the
 * optional in-app "scan another" camera. Accepts a full product URL or a
 * bare slug. The resolver still fail-closes on anything unknown.
 */
export function extractQrSlug(code: string): string | null {
  if (!code) return null;
  const match = code.match(/\/p\/([^/?#]+)/);
  if (match) return decodeURIComponent(match[1]);
  const trimmed = code.trim();
  return trimmed.length === 0 ? null : trimmed;
}
