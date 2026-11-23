import { scanGoEnabled } from "./config";

/* ═══════════════════════════════════════════════════════════════════
   Feature gate seam for `customer_scan_go` (Plus package entitlement).

   The frontend flag controls route visibility. The server authorizes API use.
   ═══════════════════════════════════════════════════════════════════ */

export const SCAN_GO_FEATURE_KEY = "customer_scan_go";

export interface ScanGoFeatureState {
  enabled: boolean;
}

export function useScanGoFeature(): ScanGoFeatureState {
  return { enabled: scanGoEnabled() };
}
