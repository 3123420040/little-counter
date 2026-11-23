/// <reference types="vite/client" />

import Medusa from "@medusajs/js-sdk";

const API_BASE = (typeof import.meta !== "undefined")
  ? String((import.meta as unknown as Record<string, Record<string, string>>).env?.["VITE_API_URL"] || "")
  : "";

function safeBrowserStorage(storageName: "localStorage" | "sessionStorage"): Storage | null {
  const storage = (globalThis as unknown as Record<string, unknown>)[storageName];
  if (!storage || typeof (storage as Storage).getItem !== "function") return null;
  return storage as Storage;
}

function getStoredValue(storageName: "localStorage" | "sessionStorage", key: string): string {
  const storage = safeBrowserStorage(storageName);
  if (!storage) return "";
  try {
    return storage.getItem(key)?.trim() || "";
  } catch {
    return "";
  }
}

// Bearer state is intentionally scoped to one browser tab/session. Purge the
// pre-1.9 durable key before reading the session value so an old token can
// never silently re-authenticate a later operator session.
safeBrowserStorage("localStorage")?.removeItem("snus_token");
let _token: string | null = getStoredValue("sessionStorage", "snus_token") || null;
let sessionExpiryNotified = false;
const AUTH_SCOPE_EXCLUDED_PATHS = ["/api/pos/login", "/api/public/", "/api/me", "/api/build-info"];
export const SCOPE_CHANGED_EVENT = "snus:scope-changed";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function getToken() {
  return _token;
}

export function setToken(token: string | null) {
  const storage = safeBrowserStorage("sessionStorage");
  safeBrowserStorage("localStorage")?.removeItem("snus_token");
  _token = token;
  if (token) sessionExpiryNotified = false;
  if (!storage) return;
  if (token) storage.setItem("snus_token", token);
  else storage.removeItem("snus_token");
}

export function createMedusaClient() {
  return new Medusa({
    baseUrl: `${API_BASE}/api`,
    auth: { jwtTokenStorageKey: "snus_token", jwtTokenStorageMethod: "session" },
  });
}

function scopedSessionValue(key: string): string {
  return getStoredValue("sessionStorage", key);
}

function scopedSessionList(key: string): string[] {
  const raw = scopedSessionValue(key);
  if (!raw) return [];
  try {
    const values = JSON.parse(raw);
    if (!Array.isArray(values)) return [];
    return values
      .map((value) => typeof value === "string" ? value.trim() : "")
      .filter(Boolean);
  } catch {
    return raw.split(",").map((value) => value.trim()).filter(Boolean);
  }
}

export interface ClientScopeSnapshot {
  operatingMerchantId: string;
  operatingStoreId: string;
  reportMerchantId: string;
  reportStoreIds: string[];
}

export function getClientScopeSnapshot(): ClientScopeSnapshot {
  return {
    operatingMerchantId: scopedSessionValue("snus_operating_merchant_id"),
    operatingStoreId: scopedSessionValue("snus_operating_store_id"),
    reportMerchantId: scopedSessionValue("snus_report_merchant_id"),
    reportStoreIds: scopedSessionList("snus_report_store_ids"),
  };
}

export function hasClientOperatingScope(snapshot = getClientScopeSnapshot()): boolean {
  return Boolean(snapshot.operatingMerchantId && snapshot.operatingStoreId);
}

function shouldAttachScopeHeaders(path: string): boolean {
  if (!_token) return false;
  return !AUTH_SCOPE_EXCLUDED_PATHS.some((excluded) => (
    excluded.endsWith("/") ? path.startsWith(excluded) : path === excluded
  ));
}

export function buildScopeHeaders(path: string): Record<string, string> {
  if (!shouldAttachScopeHeaders(path)) return {};
  const headers: Record<string, string> = {};
  const {
    operatingMerchantId,
    operatingStoreId,
    reportMerchantId,
    reportStoreIds,
  } = getClientScopeSnapshot();

  if (operatingMerchantId) headers["x-operating-merchant-id"] = operatingMerchantId;
  if (operatingStoreId) headers["x-operating-store-id"] = operatingStoreId;
  if (reportMerchantId) headers["x-report-merchant-id"] = reportMerchantId;
  if (reportStoreIds.length) headers["x-report-store-ids"] = reportStoreIds.join(",");
  return headers;
}

async function apiCall<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildScopeHeaders(path),
    ...(options.headers as Record<string, string>),
  };
  if (_token) headers["Authorization"] = `Bearer ${_token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = body?.error?.message || body?.message || res.statusText;
    if (res.status === 401 && path !== "/api/pos/login" && !sessionExpiryNotified) {
      sessionExpiryNotified = true;
      window.dispatchEvent(new CustomEvent("snus:unauthorized"));
    }
    throw new ApiError(msg, res.status, body?.error?.code || body?.code, body?.error?.details || body?.details);
  }
  return res.json();
}

async function apiRawCall(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...buildScopeHeaders(path),
    ...(options.headers as Record<string, string>),
  };
  if (_token) headers["Authorization"] = `Bearer ${_token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.clone().json().catch(() => ({}));
    const msg = body?.error?.message || body?.message || res.statusText;
    if (res.status === 401 && path !== "/api/pos/login" && !sessionExpiryNotified) {
      sessionExpiryNotified = true;
      window.dispatchEvent(new CustomEvent("snus:unauthorized"));
    }
    throw new ApiError(msg, res.status, body?.error?.code || body?.code, body?.error?.details || body?.details);
  }
  return res;
}

export const api = {
  post: <T>(path: string, body: unknown, idempotencyKey?: string, scopeHeaders: Record<string, string> = {}, signal?: AbortSignal) =>
    apiCall<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { ...scopeHeaders, ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      ...(signal ? { signal } : {}),
    }),
  get: <T>(path: string, scopeHeaders?: Record<string, string>, signal?: AbortSignal) =>
    apiCall<T>(path, { ...(scopeHeaders ? { headers: scopeHeaders } : {}), ...(signal ? { signal } : {}) }),
  rawGet: (path: string, scopeHeaders?: Record<string, string>, signal?: AbortSignal) =>
    apiRawCall(path, { ...(scopeHeaders ? { headers: scopeHeaders } : {}), ...(signal ? { signal } : {}) }),
  patch: <T>(path: string, body: unknown, idempotencyKey?: string) =>
    apiCall<T>(path, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
    }),
  delete: <T>(path: string, idempotencyKey?: string) =>
    apiCall<T>(path, {
      method: "DELETE",
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
    }),
};

export interface LoginResponse {
  data: {
    token: string;
    authState?: "authenticated" | "password_change_required";
    security?: {
      requiresPasswordChange: boolean;
      globalStatus: "active" | "suspended";
      sessionVersion: number;
      forceLogoutAfter: string | null;
      passwordChangedAt: string | null;
    };
    operator: { id: string; role: string; displayName: string; organizationId: string };
  };
}

export interface ProductCategoryItem {
  id: string;
  name: string;
  handle: string;
  description?: string;
  rank?: number;
  isActive?: boolean;
  isInternal?: boolean;
  productCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProductItem {
  id: string;
  status: string;
  title: string;
  categories?: ProductCategoryItem[];
  created_at?: string;
  updated_at?: string;
  imageUrl?: string;
  variants: Array<{
    id: string;
    sku: string;
    barcode?: string;
    prices: Array<{ amount: number }>;
    inventory_quantity: number | null;
    cost_price?: number;
    reorder_level?: number;
  }>;
}

export interface InventoryItem {
  id: string;
  product_id?: string;
  sku: string;
  barcode?: string;
  title?: string;
  status?: string;
  reorder_level?: number;
  categories?: ProductCategoryItem[];
  location_levels?: Array<{ stocked_quantity: number }>;
}

export interface StockMovementFilters {
  inventoryItemId?: string;
  productId?: string;
  variantId?: string;
  movementType?: string;
  sourceAction?: string;
  direction?: "in" | "out";
  actorId?: string;
  referenceType?: string;
  referenceId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  cursor?: string;
}

export interface StockMovementItem {
  id: string;
  inventoryItemId: string;
  productId?: string | null;
  variantId?: string | null;
  sku?: string | null;
  productTitle?: string | null;
  movementType: string;
  sourceAction: string;
  direction: "in" | "out";
  quantityBefore: number;
  quantityChange: number;
  quantityAfter: number;
  referenceType?: string | null;
  referenceId?: string | null;
  referenceDisplay?: string | null;
  reason?: string | null;
  reasonCode?: string | null;
  performedBy?: string | null;
  actorDisplayName?: string | null;
  actorRole?: string | null;
  actualOperatorId?: string | null;
  sourceChannel?: string | null;
  merchantId?: string | null;
  storeId?: string | null;
  stockLocationId?: string | null;
  metadata?: Record<string, unknown>;
  historyQuality?: "native" | "backfilled";
  createdAt: string;
}

export interface StockMovementsResponse {
  data: StockMovementItem[];
  summary: {
    totalIn: number;
    totalOut: number;
    netChange: number;
    movementCount: number;
    latestQuantityAfter: number | null;
    currentStock: number | null;
    reconciledToCurrentStock: boolean | null;
  };
  pagination: {
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
}

export interface CustomerItem {
  id: string;
  phone: string;
  first_name: string;
  last_name: string;
  email?: string;
}

export interface OrderItem {
  id: string;
  display_id: string;
  status: string;
  total: number;
  created_at: string;
  notes?: string | null;
  salesChannel?: string;
  salesChannelLabel?: string;
  customer?: { id: string; phone?: string; first_name?: string; last_name?: string };
}
