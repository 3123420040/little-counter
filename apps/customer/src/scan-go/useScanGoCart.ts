import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  type ContactType,
  type CreateScanGoCartInput,
  type ProductPublicDto,
  type ScanGoCartLine,
} from "./types";
import { CART_TTL_MS, cartStorageKey } from "./config";
import { getAgeAcknowledgedAt } from "./useAgeGate";

/* ═══════════════════════════════════════════════════════════════════
   Customer cart store ("your stash").

   Persists per store in sessionStorage and stays in sync across components
   within this tab while scanning product QR pages. The cart is a DRAFT only:
   it never creates an order, payment, reservation, or stock movement.
   ═══════════════════════════════════════════════════════════════════ */

export interface CartState {
  cartId: string | null;
  editSecret: string | null;
  merchantSlug: string;
  storeSlug: string;
  lines: ScanGoCartLine[];
  customerNickname: string;
  customerContact: string;
  contactType: ContactType;
  ageAcknowledgedAt: string | null;
  updatedAt: number;
}

interface StoreEntry {
  state: CartState;
  listeners: Set<() => void>;
}

const stores = new Map<string, StoreEntry>();

function emptyState(merchantSlug: string, storeSlug: string): CartState {
  return {
    cartId: null,
    editSecret: null,
    merchantSlug,
    storeSlug,
    lines: [],
    customerNickname: "",
    customerContact: "",
    contactType: "whatsapp",
    ageAcknowledgedAt: null,
    updatedAt: 0,
  };
}

function loadState(merchantSlug: string, storeSlug: string): CartState {
  const fallback = emptyState(merchantSlug, storeSlug);
  try {
    // window.sessionStorage (not bare sessionStorage) so jsdom's storage is
    // used in tests instead of Node's global shim; identical in real browsers.
    const raw = window.sessionStorage.getItem(cartStorageKey(merchantSlug, storeSlug));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<CartState>;
    const updatedAt = Number(parsed.updatedAt || 0);
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > CART_TTL_MS) {
      window.sessionStorage.removeItem(cartStorageKey(merchantSlug, storeSlug));
      return fallback;
    }
    return {
      ...fallback,
      ...parsed,
      merchantSlug,
      storeSlug,
      lines: Array.isArray(parsed.lines) ? (parsed.lines as ScanGoCartLine[]) : [],
    };
  } catch {
    return fallback;
  }
}

function persist(merchantSlug: string, storeSlug: string, state: CartState): void {
  try {
    window.sessionStorage.setItem(cartStorageKey(merchantSlug, storeSlug), JSON.stringify(state));
  } catch {
    /* storage full / unavailable; keep in-memory. */
  }
}

function keyOf(merchantSlug: string, storeSlug: string): string {
  return `${merchantSlug}:${storeSlug}`;
}

function getEntry(merchantSlug: string, storeSlug: string): StoreEntry {
  const key = keyOf(merchantSlug, storeSlug);
  let entry = stores.get(key);
  if (!entry) {
    entry = { state: loadState(merchantSlug, storeSlug), listeners: new Set() };
    stores.set(key, entry);
  }
  return entry;
}

function commit(merchantSlug: string, storeSlug: string, next: CartState): void {
  const entry = getEntry(merchantSlug, storeSlug);
  entry.state = { ...next, updatedAt: Date.now() };
  persist(merchantSlug, storeSlug, entry.state);
  entry.listeners.forEach((listener) => listener());
}

function productToLine(product: ProductPublicDto, quantity: number): ScanGoCartLine {
  return {
    qrSlug: product.qrSlug,
    merchantSlug: product.merchantSlug,
    storeSlug: product.storeSlug,
    productId: product.productId,
    variantId: product.variantId,
    sku: `${product.brand}-${product.name}`.toUpperCase().replace(/\s+/g, "-"),
    title: `${product.brand} ${product.name}`,
    quantity,
    unitPriceVnd: product.priceVnd,
    brand: product.brand,
    flavor: product.flavor,
    strengthLabel: product.strengthLabel,
    imageUrl: product.imageUrl,
  };
}

function upsertLine(lines: ScanGoCartLine[], line: ScanGoCartLine): ScanGoCartLine[] {
  const idx = lines.findIndex((existing) => existing.variantId === line.variantId);
  if (idx === -1) return [...lines, line];
  const merged = { ...lines[idx], quantity: lines[idx].quantity + line.quantity };
  const next = [...lines];
  next[idx] = merged;
  return next;
}

export interface UseScanGoCart extends CartState {
  totalQuantity: number;
  totalVnd: number;
  lineForVariant: (variantId: string) => ScanGoCartLine | undefined;
  addLine: (product: ProductPublicDto, quantity?: number) => void;
  increment: (variantId: string) => void;
  decrement: (variantId: string) => void;
  setQuantity: (variantId: string, quantity: number) => void;
  removeLine: (variantId: string) => void;
  setNickname: (nickname: string) => void;
  setContact: (contact: string) => void;
  setContactType: (type: ContactType) => void;
  setCartId: (cartId: string) => void;
  setCartCredentials: (cartId: string, editSecret?: string | null) => void;
  clearCustomerInfo: () => void;
  clear: () => void;
}

export function useScanGoCart(merchantSlug: string, storeSlug: string): UseScanGoCart {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const entry = getEntry(merchantSlug, storeSlug);
      entry.listeners.add(onStoreChange);
      return () => {
        entry.listeners.delete(onStoreChange);
      };
    },
    [merchantSlug, storeSlug],
  );

  const getSnapshot = useCallback(
    () => getEntry(merchantSlug, storeSlug).state,
    [merchantSlug, storeSlug],
  );

  const state = useSyncExternalStore(subscribe, getSnapshot);

  const ensureAgeAck = useCallback(
    (current: CartState): CartState => {
      if (current.ageAcknowledgedAt) return current;
      const ack = getAgeAcknowledgedAt(merchantSlug, storeSlug);
      return ack ? { ...current, ageAcknowledgedAt: ack } : current;
    },
    [merchantSlug, storeSlug],
  );

  const addLine = useCallback(
    (product: ProductPublicDto, quantity = 1) => {
      const current = getEntry(merchantSlug, storeSlug).state;
      commit(merchantSlug, storeSlug, {
        ...ensureAgeAck(current),
        lines: upsertLine(current.lines, productToLine(product, quantity)),
      });
    },
    [merchantSlug, storeSlug, ensureAgeAck],
  );

  const mutateLine = useCallback(
    (variantId: string, fn: (line: ScanGoCartLine) => ScanGoCartLine) => {
      const current = getEntry(merchantSlug, storeSlug).state;
      const next = current.lines
        .map((line) => (line.variantId === variantId ? fn(line) : line))
        .filter((line) => line.quantity > 0);
      commit(merchantSlug, storeSlug, { ...current, lines: next });
    },
    [merchantSlug, storeSlug],
  );

  const increment = useCallback((variantId: string) => mutateLine(variantId, (l) => ({ ...l, quantity: l.quantity + 1 })), [mutateLine]);
  const decrement = useCallback((variantId: string) => mutateLine(variantId, (l) => ({ ...l, quantity: l.quantity - 1 })), [mutateLine]);
  const setQuantity = useCallback((variantId: string, quantity: number) => mutateLine(variantId, (l) => ({ ...l, quantity: Math.max(0, Math.round(quantity)) })), [mutateLine]);
  const removeLine = useCallback((variantId: string) => {
    const current = getEntry(merchantSlug, storeSlug).state;
    commit(merchantSlug, storeSlug, { ...current, lines: current.lines.filter((l) => l.variantId !== variantId) });
  }, [merchantSlug, storeSlug]);

  const setNickname = useCallback((nickname: string) => {
    const current = getEntry(merchantSlug, storeSlug).state;
    commit(merchantSlug, storeSlug, { ...current, customerNickname: nickname });
  }, [merchantSlug, storeSlug]);
  const setContact = useCallback((contact: string) => {
    const current = getEntry(merchantSlug, storeSlug).state;
    commit(merchantSlug, storeSlug, { ...current, customerContact: contact });
  }, [merchantSlug, storeSlug]);
  const setContactType = useCallback((type: ContactType) => {
    const current = getEntry(merchantSlug, storeSlug).state;
    commit(merchantSlug, storeSlug, { ...current, contactType: type });
  }, [merchantSlug, storeSlug]);

  const setCartId = useCallback((cartId: string) => {
    const current = getEntry(merchantSlug, storeSlug).state;
    commit(merchantSlug, storeSlug, { ...current, cartId });
  }, [merchantSlug, storeSlug]);

  const setCartCredentials = useCallback((cartId: string, editSecret?: string | null) => {
    const current = getEntry(merchantSlug, storeSlug).state;
    commit(merchantSlug, storeSlug, { ...current, cartId, editSecret: editSecret ?? current.editSecret });
  }, [merchantSlug, storeSlug]);

  const clearCustomerInfo = useCallback(() => {
    const current = getEntry(merchantSlug, storeSlug).state;
    commit(merchantSlug, storeSlug, {
      ...current,
      customerNickname: "",
      customerContact: "",
      contactType: "whatsapp",
    });
  }, [merchantSlug, storeSlug]);

  const clear = useCallback(() => {
    commit(merchantSlug, storeSlug, emptyState(merchantSlug, storeSlug));
  }, [merchantSlug, storeSlug]);

  const totalQuantity = useMemo(() => state.lines.reduce((sum, l) => sum + l.quantity, 0), [state.lines]);
  const totalVnd = useMemo(
    () => state.lines.reduce((sum, l) => sum + l.quantity * l.unitPriceVnd, 0),
    [state.lines],
  );

  const lineForVariant = useCallback(
    (variantId: string) => state.lines.find((l) => l.variantId === variantId),
    [state.lines],
  );

  return {
    ...state,
    totalQuantity,
    totalVnd,
    lineForVariant,
    addLine,
    increment,
    decrement,
    setQuantity,
    removeLine,
    setNickname,
    setContact,
    setContactType,
    setCartId,
    setCartCredentials,
    clearCustomerInfo,
    clear,
  };
}

/** Build the backend create-cart input from local state. Display-only fields are mapped down. */
export function buildCreateInput(state: CartState): CreateScanGoCartInput {
  return {
    merchantSlug: state.merchantSlug,
    storeSlug: state.storeSlug,
    lines: state.lines,
    customerNickname: state.customerNickname.trim() || null,
    customerContact: state.customerContact.trim() || null,
    contactType: state.customerContact.trim() ? state.contactType : null,
    ageAcknowledgedAt: state.ageAcknowledgedAt ?? new Date(0).toISOString(),
  };
}

/** Test-only: clear the in-memory cache so the next read reloads from storage (simulates reload). */
export function __resetCartStoresForTests(): void {
  stores.clear();
}
