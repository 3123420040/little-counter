import type { ProductItem, CustomerItem } from "../api/client";
import type { CompleteSaleInput } from "../api/endpoints";
import { getClientScopeSnapshot } from "../api/client";
import { buildPartitionedQueryKeyV1, type AppAccessSnapshotV1 } from "./appAccessSnapshot";

const DB_NAME = "snus-pos-offline";
const DB_VERSION = 1;
const SALE_STORE = "queued_sales";
const SNAPSHOT_STORE = "snapshots";

export function clearOfflineState(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Offline state purge was blocked by an open database connection"));
  });
}

export type QueuedSaleStatus = "queued" | "syncing" | "needs_review";

export interface ScopeSnapshot {
  operatorId?: string;
  accessEpoch?: string;
  capabilityVersion?: string;
  merchantId: string;
  storeId: string;
  stockLocationId: string;
  shiftId?: string;
  shiftOpenedAt?: string;
}

export interface QueuedSale {
  id: string;
  payload: CompleteSaleInput;
  status: QueuedSaleStatus;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  lastErrorCode?: string;
  lastErrorDetails?: unknown;
  scope?: ScopeSnapshot;
}

export interface BootstrapSnapshot {
  generatedAt: string;
  products: ProductItem[];
  customers: CustomerItem[];
  loyaltyTiers: unknown[];
  permissionVersion?: string | null;
  operatorId?: string | null;
  sessionVersion?: number | null;
  snapshotAuthorizationExpiresAt?: string | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SALE_STORE)) {
        db.createObjectStore(SALE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE, { keyPath: "key" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const request = run(store);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  }));
}

export async function enqueueSale(payload: CompleteSaleInput, scope?: ScopeSnapshot): Promise<QueuedSale> {
  const now = new Date().toISOString();
  const sale: QueuedSale = {
    id: payload.idempotencyKey,
    payload,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    scope,
  };
  await tx(SALE_STORE, "readwrite", (store) => store.put(sale));
  return sale;
}

export interface SyncAccessSummary {
  operatorId: string;
  accessEpoch?: string;
  capabilityVersion?: string;
  merchantIds: string[];
  storeIds: string[];
  selectedMerchantId?: string;
  selectedStoreId?: string;
}

export interface SyncRevalidationResult {
  ok: boolean;
  reason?: string;
}

export function revalidateQueuedSaleAccess(sale: QueuedSale, access: SyncAccessSummary): SyncRevalidationResult {
  if (!sale.scope) {
    return { ok: false, reason: "missing_scope_snapshot" };
  }
  if (!sale.scope.operatorId || sale.scope.operatorId !== access.operatorId) {
    return { ok: false, reason: "operator_changed" };
  }
  if (!sale.scope.accessEpoch || sale.scope.accessEpoch !== access.accessEpoch) {
    return { ok: false, reason: "access_epoch_changed" };
  }
  if (!sale.scope.capabilityVersion || sale.scope.capabilityVersion !== access.capabilityVersion) {
    return { ok: false, reason: "capability_version_changed" };
  }
  const storeAllowed = access.storeIds.includes(sale.scope.storeId);
  const merchantAllowed = access.merchantIds.includes(sale.scope.merchantId);
  if (!storeAllowed || !merchantAllowed) {
    return { ok: false, reason: "scope_no_longer_accessible" };
  }
  if (sale.scope.merchantId !== access.selectedMerchantId || sale.scope.storeId !== access.selectedStoreId) {
    return { ok: false, reason: "selected_scope_changed" };
  }
  return { ok: true };
}

export function listQueuedSales(): Promise<QueuedSale[]> {
  return tx<QueuedSale[]>(SALE_STORE, "readonly", (store) => store.getAll());
}

export function removeQueuedSale(id: string): Promise<void> {
  return tx<undefined>(SALE_STORE, "readwrite", (store) => store.delete(id) as IDBRequest<undefined>);
}

export async function updateQueuedSale(id: string, patch: Partial<QueuedSale>): Promise<void> {
  const existing = await tx<QueuedSale | undefined>(SALE_STORE, "readonly", (store) => store.get(id));
  if (!existing) return;
  await tx(SALE_STORE, "readwrite", (store) => store.put({
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  }));
}

export async function queuedSaleSummary() {
  const sales = await listQueuedSales();
  return {
    queued: sales.filter((sale) => sale.status !== "needs_review").length,
    needsReview: sales.filter((sale) => sale.status === "needs_review").length,
  };
}

function bootstrapKey(access: AppAccessSnapshotV1 | null): string | null {
  if (!access?.operatorId || !access.merchantId || access.storeIds.length !== 1
    || !access.storeIds[0] || !access.accessEpoch || !access.permissionVersion
    || !Number.isSafeInteger(access.sessionVersion)) return null;
  return JSON.stringify(buildPartitionedQueryKeyV1(access, "bootstrap-v2"));
}

export async function saveBootstrapSnapshot(
  snapshot: BootstrapSnapshot,
  access: AppAccessSnapshotV1 | null,
  responseScope: { merchantId: string; storeId: string } | undefined,
): Promise<void> {
  const key = bootstrapKey(access);
  const selected = getClientScopeSnapshot();
  if (!key || !access || responseScope?.merchantId !== access.merchantId
    || responseScope.storeId !== access.storeIds[0]
    || selected.operatingMerchantId !== access.merchantId
    || selected.operatingStoreId !== access.storeIds[0]
    || snapshot.permissionVersion !== access.permissionVersion
    || snapshot.operatorId !== access.operatorId
    || snapshot.sessionVersion !== access.sessionVersion
    || !snapshot.snapshotAuthorizationExpiresAt
    || !(Date.parse(snapshot.snapshotAuthorizationExpiresAt) > Date.now())) return;
  await tx(SNAPSHOT_STORE, "readwrite", (store) => store.put({ key, ...snapshot }));
}

export async function getBootstrapSnapshot(access: AppAccessSnapshotV1 | null): Promise<BootstrapSnapshot | null> {
  const key = bootstrapKey(access);
  if (!key) return null;
  const row = await tx<(BootstrapSnapshot & { key: string }) | undefined>(
    SNAPSHOT_STORE,
    "readonly",
    (store) => store.get(key),
  );
  const selected = getClientScopeSnapshot();
  if (!row || row.permissionVersion !== access?.permissionVersion
    || selected.operatingMerchantId !== access?.merchantId
    || selected.operatingStoreId !== access?.storeIds[0]
    || row.operatorId !== access?.operatorId || row.sessionVersion !== access?.sessionVersion
    || !row.snapshotAuthorizationExpiresAt
    || !(Date.parse(row.snapshotAuthorizationExpiresAt) > Date.now())) return null;
  const { key: _key, ...snapshot } = row;
  return snapshot;
}
