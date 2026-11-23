import type {
  Actor,
  AiActionStatus,
  AiActionType,
  CompleteSaleInput,
  AdjustStockInput,
  CreateCustomerInput,
  CreatePurchaseOrderInput,
  CreateJournalEntryInput,
  LoyaltyTier,
  LoyaltyTierName,
  PaymentMethod,
  RiskLevel,
  StockMovementType,
} from "@medusa-snus/contracts";
import {
  assessRiskLevel,
  calculateCogs,
  calculateLoyaltyPoints,
  calculateReorderQuantity,
  evaluateTier,
  filterBlockedClaims,
  pointsToNextTier,
  shouldTriggerAlert,
  validateJournalEntry,
  validateSale,
  DEFAULT_BLOCKED_PATTERNS,
} from "@medusa-snus/domain";
import { recordAudit } from "./middleware/audit";
import { calculateOrderTotals, type DiscountType } from "./services/order-total-service";
import { readPaymentFeeInput } from "./services/payment-fee-calculation";

// ── Auth exports (P0-2 fix) ─────────────────────────────
export { signJwt, verifyJwt, requireRole, authMiddleware, hashPassword, verifyPassword, authenticate, authorize, createRouteGuard, UnauthorizedError, ForbiddenError } from "./middleware/auth";
export type { JwtPayload, Role } from "./middleware/auth";
export * from "./platform-db";
export * from "./services/owner-settings-service";
export * from "./services/store-settlement-policy-service";
export * from "./services/merchant-checkout-policy-service";
export * from "./services/platform-merchant-provisioning-service";
export * from "./services/platform-business-lifecycle-service";
export { revokePlatformMcpKey, issuePlatformMcpKey, rotatePlatformMcpKey, createPlatformMcpConnection, changePlatformMcpConnectionStatus } from "./partner/platform-mcp-control";
export { listPlatformMcpConnections, getPlatformMcpConnection } from "./partner/platform-mcp-metadata";
export * from "./services/order-financial-feature-route-service";
export * from "./services/order-operational-detail-service";
export * from "./services/build-info-service";
export * from "./services/runtime-capability-route-manifest";
export * from "./services/coupled-authorization-policy";
export * from "./services/historical-read-scope-service";
export { recoverPaymentFeeReceiptV1 } from "./services/payment-fee-receipt-recovery";
export * from "./services/historical-bank-recognition-contract";
export * from "./services/historical-bank-recognition-repository";

/* ═══════════════════════════════════════════════════════
   @medusa-snus/application — Use cases + store adapter
   ═══════════════════════════════════════════════════════ */

// ── Error ───────────────────────────────────────────────

export class ApplicationError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

// ── Store Types ─────────────────────────────────────────

export interface RequestContext {
  actor: Actor;
  correlationId: string;
  idempotencyKey?: string;
}

export interface StoreProduct {
  id: string;
  title: string;
  status: string;
  variants: StoreVariant[];
}

export interface StoreVariant {
  id: string;
  sku: string;
  barcode?: string;
  price: number;
  costPrice: number;
  inventoryItemId: string;
  stockLevel: number;
  reorderLevel: number;
}

export interface StoreOrder {
  id: string;
  orderNumber: string;
  status: string;
  customerId: string | null;
  commercialAdjustmentVersion?: number;
  discountType?: DiscountType;
  discountValue?: number;
  discountPercent?: number;
  subtotal: number;
  discount: number;
  merchandisePayable?: number;
  shippingFee?: number;
  merchandiseTax?: number;
  shippingTax?: number;
  merchandiseRevenue?: number;
  shippingRevenue?: number;
  loyaltyBase?: number;
  tax: number;
  total: number;
  paymentMethod: string;
  amountReceived: number;
  change: number;
  items: OrderLineItem[];
  createdAt: string;
  createdBy: string;
}

export interface OrderLineItem {
  productId: string;
  variantId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface StoreCustomer {
  id: string;
  phone: string;
  firstName: string;
  lastName: string;
  email?: string;
}

export interface CustomerProfile {
  customerId: string;
  phone: string;
  name: string;
  totalSpent: number;
  orderCount: number;
  loyaltyPoints: number;
  tier: LoyaltyTierName;
  nextTierPoints: number | null;
  firstPurchaseAt: string | null;
  lastPurchaseAt: string | null;
}

export interface StockMovement {
  id: string;
  inventoryItemId: string;
  movementType: StockMovementType;
  quantityChange: number;
  quantityAfter: number;
  referenceType: string;
  referenceId: string;
  reason?: string;
  performedBy: string;
  createdAt: string;
}

export interface PurchaseOrder {
  id: string;
  supplierName: string;
  status: "draft" | "sent" | "partially_received" | "received" | "cancelled" | "closed_short";
  items: PurchaseOrderItem[];
  expectedDate?: string;
  createdAt: string;
}

export interface PurchaseOrderItem {
  id: string;
  variantId: string;
  quantity: number;
  unitCost: number;
  receivedQuantity: number;
}

export interface JournalEntry {
  id: string;
  entryNumber: string;
  entryDate: string;
  referenceType?: string;
  referenceId?: string;
  description: string;
  status: "draft" | "posted" | "voided";
  postedAt?: string;
  createdBy: string;
  lines: JournalLine[];
}

export interface JournalLine {
  accountCode: string;
  debitAmount: number;
  creditAmount: number;
  description?: string;
}

export interface AccountSummary {
  id?: string;
  code: string;
  name: string;
  type: string;
  balance: number;
}

export interface AiAction {
  id: string;
  actionType: AiActionType;
  status: AiActionStatus;
  customerId?: string;
  orderId?: string;
  productId?: string;
  outputPayload: Record<string, unknown>;
  confidence: number | null;
  riskLevel: RiskLevel | null;
  approvedText?: string;
  rejectionReason?: string;
  reviewedBy?: string;
  createdAt: string;
}

export interface OutboxEvent {
  id: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  organizationId: string;
  payload: Record<string, unknown>;
  actor: Actor;
  correlationId: string;
  occurredAt: string;
}

export interface LoyaltyRecord {
  id: string;
  customerId: string;
  sourceEventId: string;
  orderId?: string;
  pointsEarned: number;
  pointsRedeemed: number;
  tierAtTime: LoyaltyTierName;
  description?: string;
}

export interface InventoryAlert {
  id: string;
  sourceEventId: string;
  productId: string;
  currentStock: number;
  reorderLevel: number;
  suggestedQuantity: number;
  status: "new" | "acknowledged" | "resolved";
}

// ── Store Adapter Interface ─────────────────────────────

export interface StoreAdapter {
  transaction<T>(fn: (txn: StoreAdapter) => Promise<T>): Promise<T>;

  // Products
  findProduct(id: string): Promise<StoreProduct | undefined>;
  findProductByVariant(variantId: string): Promise<StoreProduct | undefined>;
  findProducts(ids: string[]): Promise<StoreProduct[]>;
  listProducts(query?: { search?: string; limit?: number }): Promise<StoreProduct[]>;

  // Variants
  findVariant(variantId: string): Promise<StoreVariant | undefined>;
  updateVariantStock(variantId: string, newLevel: number): Promise<void>;

  // Orders
  insertOrder(order: StoreOrder): Promise<StoreOrder>;
  findOrder(id: string): Promise<StoreOrder | undefined>;
  listOrders(filters?: { dateFrom?: string; dateTo?: string; customerId?: string }): Promise<StoreOrder[]>;
  updateOrderStatus(orderId: string, status: string): Promise<void>;

  // Customers
  findCustomer(id: string): Promise<StoreCustomer | undefined>;
  findCustomerByPhone(phone: string): Promise<StoreCustomer | undefined>;
  insertCustomer(customer: StoreCustomer): Promise<StoreCustomer>;
  listCustomers(query?: { search?: string; limit?: number }): Promise<StoreCustomer[]>;

  // Customer Profiles (extended)
  getCustomerProfile(customerId: string): Promise<CustomerProfile | undefined>;
  upsertCustomerProfile(profile: Partial<CustomerProfile> & { customerId: string }): Promise<CustomerProfile>;

  // Stock Movements
  insertStockMovement(movement: Omit<StockMovement, "id" | "createdAt">): Promise<StockMovement>;
  listStockMovements(inventoryItemId: string): Promise<StockMovement[]>;

  // Purchase Orders
  insertPurchaseOrder(po: Omit<PurchaseOrder, "id" | "createdAt">): Promise<PurchaseOrder>;
  findPurchaseOrder(id: string): Promise<PurchaseOrder | undefined>;
  updatePurchaseOrder(id: string, update: Partial<PurchaseOrder>): Promise<void>;

  // Loyalty
  insertLoyaltyRecord(record: Omit<LoyaltyRecord, "id">): Promise<LoyaltyRecord>;
  findLoyaltyRecordByEventId(sourceEventId: string): Promise<LoyaltyRecord | undefined>;
  getLoyaltyTiers(): Promise<LoyaltyTier[]>;
  getTotalLoyaltyPoints(customerId: string): Promise<number>;

  // Accounting
  getAccountByCode(code: string): Promise<AccountSummary | undefined>;
  insertJournalEntry(entry: Omit<JournalEntry, "id" | "entryNumber">): Promise<JournalEntry>;
  findJournalEntry(id: string): Promise<JournalEntry | undefined>;
  updateJournalEntryStatus(id: string, status: string, postedAt?: string): Promise<void>;

  // AI Actions
  insertAiAction(action: Omit<AiAction, "id" | "createdAt">): Promise<AiAction>;
  findAiAction(id: string): Promise<AiAction | undefined>;
  updateAiAction(id: string, update: Partial<AiAction>): Promise<void>;
  listAiActions(filters?: { status?: AiActionStatus; type?: AiActionType }): Promise<AiAction[]>;

  // Outbox
  emitEvent(event: Omit<OutboxEvent, "id" | "eventVersion" | "occurredAt">): Promise<void>;
  listOutboxEvents(eventType?: string): Promise<OutboxEvent[]>;

  // Inventory Alerts
  insertInventoryAlert(alert: Omit<InventoryAlert, "id">): Promise<InventoryAlert>;
  findInventoryAlertByEventId(sourceEventId: string): Promise<InventoryAlert | undefined>;
  updateInventoryAlert(id: string, update: Partial<InventoryAlert>): Promise<void>;

  // Idempotency (P2-3 fix: expose via interface, not store.state)
  getIdempotencyRecord(key: string): Promise<{ bodyHash: string; response: unknown } | undefined>;
  setIdempotencyRecord(key: string, bodyHash: string, response: unknown): Promise<void>;

  // Helpers (ITEM 2: reduce store.state)
  getNextOrderNumber(): Promise<string>;
  listLoyaltyRecords(customerId: string): Promise<LoyaltyRecord[]>;
  listJournalEntries(filters?: { dateFrom?: string; dateTo?: string; status?: string }): Promise<JournalEntry[]>;
  getInventoryAlerts(): Promise<InventoryAlert[]>;
}

// ── In-Memory Store Adapter (for testing) ──────────────

export function createEmptyApplicationState() {
  return {
    products: [] as StoreProduct[],
    orders: [] as StoreOrder[],
    customers: [] as StoreCustomer[],
    customerProfiles: [] as CustomerProfile[],
    stockMovements: [] as StockMovement[],
    purchaseOrders: [] as PurchaseOrder[],
    purchaseOrderCounter: 0,
    loyaltyRecords: [] as LoyaltyRecord[],
    loyaltyTiers: [] as LoyaltyTier[],
    accounts: [] as AccountSummary[],
    journalEntries: [] as JournalEntry[],
    journalEntryCounter: 0,
    aiActions: [] as AiAction[],
    aiActionCounter: 0,
    outboxEvents: [] as OutboxEvent[],
    inventoryAlerts: [] as InventoryAlert[],
    idempotencyRecords: new Map<string, { bodyHash: string; response: unknown }>(),
    orderCounter: 0,
  };
}

export type ApplicationState = ReturnType<typeof createEmptyApplicationState>;

export class InMemoryStoreAdapter implements StoreAdapter {
  constructor(public state: ApplicationState) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async transaction<T>(fn: (txn: StoreAdapter) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async findProduct(id: string) {
    return this.state.products.find(p => p.id === id || p.variants.some(v => v.id === id));
  }

  async findProductByVariant(variantId: string) {
    return this.state.products.find(p => p.variants.some(v => v.id === variantId));
  }

  async findProducts(ids: string[]) {
    return this.state.products.filter(p => ids.includes(p.id));
  }

  async listProducts(_query?: { search?: string; limit?: number }) {
    let result = [...this.state.products];
    if (_query?.search) {
      const q = _query.search.toLowerCase();
      result = result.filter(p => p.title.toLowerCase().includes(q));
    }
    return result.slice(0, _query?.limit ?? 50);
  }

  async findVariant(variantId: string) {
    for (const p of this.state.products) {
      const v = p.variants.find(v => v.id === variantId);
      if (v) return v;
    }
    return undefined;
  }

  async updateVariantStock(variantId: string, newLevel: number) {
    for (const p of this.state.products) {
      const v = p.variants.find(v => v.id === variantId);
      if (v) { v.stockLevel = newLevel; return; }
    }
  }

  async insertOrder(order: StoreOrder) { this.state.orders.push(order); return order; }
  async findOrder(id: string) { return this.state.orders.find(o => o.id === id); }
  async listOrders(filters?: { dateFrom?: string; dateTo?: string; customerId?: string }) {
    let result = [...this.state.orders];
    if (filters?.customerId) result = result.filter(o => o.customerId === filters.customerId);
    return result;
  }
  async updateOrderStatus(orderId: string, status: string) {
    const o = this.state.orders.find(o => o.id === orderId);
    if (o) o.status = status;
  }

  async findCustomer(id: string) { return this.state.customers.find(c => c.id === id); }
  async findCustomerByPhone(phone: string) { return this.state.customers.find(c => c.phone === phone); }
  async insertCustomer(customer: StoreCustomer) { this.state.customers.push(customer); return customer; }
  async listCustomers(_query?: { search?: string }) {
    let result = [...this.state.customers];
    if (_query?.search) {
      const q = _query.search.toLowerCase();
      result = result.filter(c =>
        c.phone.includes(q) || c.firstName.toLowerCase().includes(q) || c.lastName.toLowerCase().includes(q),
      );
    }
    return result;
  }

  async getCustomerProfile(customerId: string) {
    return this.state.customerProfiles.find(p => p.customerId === customerId);
  }

  async upsertCustomerProfile(profile: Partial<CustomerProfile> & { customerId: string }) {
    const existing = this.state.customerProfiles.find(p => p.customerId === profile.customerId);
    if (existing) {
      Object.assign(existing, profile);
      return existing;
    }
    const newProfile: CustomerProfile = {
      customerId: profile.customerId,
      phone: profile.phone ?? "",
      name: profile.name ?? "",
      totalSpent: profile.totalSpent ?? 0,
      orderCount: profile.orderCount ?? 0,
      loyaltyPoints: profile.loyaltyPoints ?? 0,
      tier: profile.tier ?? "bronze",
      nextTierPoints: profile.nextTierPoints ?? null,
      firstPurchaseAt: profile.firstPurchaseAt ?? null,
      lastPurchaseAt: profile.lastPurchaseAt ?? null,
    };
    this.state.customerProfiles.push(newProfile);
    return newProfile;
  }

  async insertStockMovement(m: Omit<StockMovement, "id" | "createdAt">) {
    const sm: StockMovement = { id: `sm_${this.state.stockMovements.length + 1}`, createdAt: new Date().toISOString(), ...m };
    this.state.stockMovements.push(sm);
    return sm;
  }

  async listStockMovements(inventoryItemId: string) {
    return this.state.stockMovements.filter(sm => sm.inventoryItemId === inventoryItemId);
  }

  async insertPurchaseOrder(po: Omit<PurchaseOrder, "id" | "createdAt">) {
    this.state.purchaseOrderCounter++;
    const id = `po_${this.state.purchaseOrderCounter}`;
    const result: PurchaseOrder = { id, createdAt: new Date().toISOString(), ...po };
    this.state.purchaseOrders.push(result);
    return result;
  }
  async findPurchaseOrder(id: string) { return this.state.purchaseOrders.find(p => p.id === id); }
  async updatePurchaseOrder(id: string, update: Partial<PurchaseOrder>) {
    const po = this.state.purchaseOrders.find(p => p.id === id);
    if (po) Object.assign(po, update);
  }

  async insertLoyaltyRecord(record: Omit<LoyaltyRecord, "id">) {
    const lr: LoyaltyRecord = { id: `lr_${this.state.loyaltyRecords.length + 1}`, ...record };
    this.state.loyaltyRecords.push(lr);
    return lr;
  }
  async findLoyaltyRecordByEventId(sourceEventId: string) {
    return this.state.loyaltyRecords.find(r => r.sourceEventId === sourceEventId);
  }
  async getLoyaltyTiers() { return [...this.state.loyaltyTiers]; }
  async getTotalLoyaltyPoints(customerId: string) {
    return this.state.loyaltyRecords
      .filter(r => r.customerId === customerId)
      .reduce((sum, r) => sum + r.pointsEarned - r.pointsRedeemed, 0);
  }

  async getAccountByCode(code: string) { return this.state.accounts.find(a => a.code === code); }
  async insertJournalEntry(entry: Omit<JournalEntry, "id" | "entryNumber">) {
    this.state.journalEntryCounter++;
    const num = String(this.state.journalEntryCounter).padStart(3, "0");
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
    const result: JournalEntry = {
      id: `je_${this.state.journalEntryCounter}`,
      entryNumber: `JE-${dateStr}-${num}`,
      ...entry,
    };
    this.state.journalEntries.push(result);
    return result;
  }
  async findJournalEntry(id: string) { return this.state.journalEntries.find(j => j.id === id); }
  async updateJournalEntryStatus(id: string, status: string, postedAt?: string) {
    const je = this.state.journalEntries.find(j => j.id === id);
    if (je) {
      je.status = status as "draft" | "posted" | "voided";
      if (postedAt) je.postedAt = postedAt;
    }
  }

  async insertAiAction(action: Omit<AiAction, "id" | "createdAt">) {
    this.state.aiActionCounter++;
    const result: AiAction = { id: `ai_${this.state.aiActionCounter}`, createdAt: new Date().toISOString(), ...action };
    this.state.aiActions.push(result);
    return result;
  }
  async findAiAction(id: string) { return this.state.aiActions.find(a => a.id === id); }
  async updateAiAction(id: string, update: Partial<AiAction>) {
    const a = this.state.aiActions.find(a => a.id === id);
    if (a) Object.assign(a, update);
  }
  async listAiActions(_filters?: { status?: AiActionStatus; type?: AiActionType }) {
    let result = [...this.state.aiActions];
    if (_filters?.status) result = result.filter(a => a.status === _filters.status);
    if (_filters?.type) result = result.filter(a => a.actionType === _filters.type);
    return result;
  }

  async emitEvent(event: Omit<OutboxEvent, "id" | "eventVersion" | "occurredAt">) {
    const e: OutboxEvent = {
      id: `evt_${this.state.outboxEvents.length + 1}`,
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      ...event,
    };
    this.state.outboxEvents.push(e);
  }
  async listOutboxEvents(eventType?: string) {
    return eventType ? this.state.outboxEvents.filter(e => e.eventType === eventType) : [...this.state.outboxEvents];
  }

  async insertInventoryAlert(alert: Omit<InventoryAlert, "id">) {
    const a: InventoryAlert = { id: `ia_${this.state.inventoryAlerts.length + 1}`, ...alert };
    this.state.inventoryAlerts.push(a);
    return a;
  }
  async findInventoryAlertByEventId(sourceEventId: string) {
    return this.state.inventoryAlerts.find(a => a.sourceEventId === sourceEventId);
  }
  async updateInventoryAlert(id: string, update: Partial<InventoryAlert>) {
    const a = this.state.inventoryAlerts.find(a => a.id === id);
    if (a) Object.assign(a, update);
  }

  // Idempotency (P2-3: adapter methods, not direct store.state access)
  async getIdempotencyRecord(key: string) {
    return this.state.idempotencyRecords.get(key);
  }
  async setIdempotencyRecord(key: string, bodyHash: string, response: unknown) {
    this.state.idempotencyRecords.set(key, { bodyHash, response });
  }

  // Helpers (ITEM 2)
  async getNextOrderNumber() {
    this.state.orderCounter = (this.state.orderCounter ?? 0) + 1;
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return `ORD-${dateStr}-${String(this.state.orderCounter).padStart(3, "0")}`;
  }
  async listLoyaltyRecords(customerId: string) {
    return this.state.loyaltyRecords.filter(r => r.customerId === customerId);
  }
  async listJournalEntries(filters?: { dateFrom?: string; dateTo?: string; status?: string }) {
    let entries = [...this.state.journalEntries];
    if (filters?.dateFrom) entries = entries.filter(e => e.entryDate >= filters.dateFrom!);
    if (filters?.dateTo) entries = entries.filter(e => e.entryDate <= filters.dateTo!);
    if (filters?.status) entries = entries.filter(e => e.status === filters.status);
    return entries;
  }
  async getInventoryAlerts() {
    return this.state.inventoryAlerts;
  }
}

// ── Application ─────────────────────────────────────────

export interface ApplicationDependencies {
  store: StoreAdapter;
}

export function createApplication(deps: ApplicationDependencies) {
  const { store } = deps;

  return {
    completeSale,
    cancelSale,
    createCustomer,
    getCustomerProfile,
    adjustStock,
    createPurchaseOrder,
    receivePurchaseOrder,
    createManualJournalEntry,
    postJournalEntry,
    requestAiReplyDraft,
    approveAiAction,
    rejectAiAction,
    getDashboard,
    getInventoryAlerts,
    getCustomerLoyalty,
    getIncomeStatement,
  };

  // ── POS: Complete Sale ──────────────────────────────────

  async function completeSale(input: {
    items: Array<{ variantId: string; quantity: number; unitPrice?: number }>;
    customerId?: string;
    paymentMethod: string;
    amountReceived: number;
    discountPercent?: number;
    discountType?: DiscountType;
    discountValue?: number;
    shippingFee?: number;
    idempotencyKey: string;
    context: RequestContext;
  }): Promise<{ order: StoreOrder; change: number }> {
    if (readPaymentFeeInput(input)) throw new ApplicationError("validation_error", "Legacy application writer does not support payment fees", 400);
    // Idempotency check (P2-3 fix: use store methods, not store.state)
    const bodyHash = JSON.stringify(input);
    const prev = await store.getIdempotencyRecord(input.idempotencyKey);
    if (prev) {
      if (prev.bodyHash !== bodyHash) {
        throw new ApplicationError("idempotency_conflict", "Same key, different request body", 409);
      }
      return prev.response as { order: StoreOrder; change: number };
    }

    return store.transaction(async (txn) => {
      // Resolve variants + validate
      const items = await Promise.all(input.items.map(async (i) => {
        const variant = await txn.findVariant(i.variantId);
        if (!variant) throw new ApplicationError("resource_not_found", `Variant ${i.variantId} not found`, 404);
        const unitPrice = i.unitPrice ?? variant.price;
        return { productId: variant.inventoryItemId, variantId: i.variantId, quantity: i.quantity, stockLevel: variant.stockLevel, unitPrice, costPrice: variant.costPrice };
      }));

      // Domain validation
      const errors = validateSale({ items, paymentMethod: input.paymentMethod });
      if (errors.length > 0) {
        const firstError = errors[0];
        if (firstError === "insufficient_stock") {
          const item = items.find(i => i.quantity > i.stockLevel);
          throw new ApplicationError("insufficient_stock", "Product stock is insufficient for this order.", 409, {
            available: item?.stockLevel, requested: item?.quantity,
          });
        }
        throw new ApplicationError("validation_error", `Order validation failed: ${errors.join(", ")}`, 400, { errors });
      }

      // Customer lookup
      let customer: StoreCustomer | undefined;
      if (input.customerId) {
        customer = await txn.findCustomer(input.customerId);
      }

      // Calculate totals
      const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
      const totals = calculateOrderTotals(subtotal, {
        discountPercent: input.discountPercent,
        discountType: input.discountType,
        discountValue: input.discountValue,
        shippingFee: input.shippingFee,
      }, input.shippingFee);
      const {
        discount,
        total,
        merchandisePayable,
        shippingFee,
        merchandiseTax,
        shippingTax,
        merchandiseRevenue,
        shippingRevenue,
        loyaltyBase,
        tax,
        commercialAdjustmentVersion,
        discountType,
        discountValue,
        discountPercent,
      } = totals;
      const change = input.amountReceived - total;

      // Create order
      // Create order with auto-generated order number
      const orderNumber = await txn.getNextOrderNumber();
      const order: StoreOrder = {
        id: `ord_${Math.random().toString(36).slice(2, 10)}`,
        orderNumber,
        status: "completed",
        customerId: input.customerId ?? null,
        commercialAdjustmentVersion,
        discountType,
        discountValue,
        discountPercent,
        subtotal, discount, merchandisePayable, shippingFee, merchandiseTax, shippingTax, merchandiseRevenue, shippingRevenue, loyaltyBase, tax, total,
        paymentMethod: input.paymentMethod,
        amountReceived: input.amountReceived,
        change,
        items: items.map(i => ({
          productId: i.productId, variantId: i.variantId, sku: "", name: "", quantity: i.quantity, unitPrice: i.unitPrice, lineTotal: i.quantity * i.unitPrice,
        })),
        createdAt: new Date().toISOString(),
        createdBy: input.context.actor.id,
      };
      await txn.insertOrder(order);

      // Deduct inventory + stock movements
      for (const item of items) {
        const variant = await txn.findVariant(item.variantId);
        if (!variant) throw new ApplicationError("resource_not_found", `Variant ${item.variantId} not found`, 404);
        const newLevel = variant.stockLevel - item.quantity;
        await txn.updateVariantStock(item.variantId, newLevel);
        await txn.insertStockMovement({
          inventoryItemId: variant.inventoryItemId,
          movementType: "sale",
          quantityChange: -item.quantity,
          quantityAfter: newLevel,
          referenceType: "order",
          referenceId: order.id,
          performedBy: input.context.actor.id,
        });

        // Emit stock.changed event
        await txn.emitEvent({
          eventType: "stock.changed",
          aggregateType: "inventory",
          aggregateId: variant.inventoryItemId,
          organizationId: "org_default",
          correlationId: input.context.correlationId || input.idempotencyKey,
          actor: input.context.actor,
          payload: {
            productId: item.productId, variantId: item.variantId,
            locationId: "loc_default", movementType: "sale",
            quantityChange: -item.quantity,
            quantityBefore: variant.stockLevel,
            quantityAfter: newLevel,
            reorderLevel: variant.reorderLevel,
            referenceType: "order", referenceId: order.id,
          },
        });
      }

      // Emit sale.created event
      await txn.emitEvent({
        eventType: "sale.created",
        aggregateType: "order",
        aggregateId: order.id,
        organizationId: "org_default",
        correlationId: input.context.correlationId || input.idempotencyKey,
        actor: input.context.actor,
        payload: {
          orderId: order.id, orderNumber: order.orderNumber,
          customerId: input.customerId ?? null,
          customerPhone: customer?.phone ?? null,
          items: order.items,
          subtotal, discount, total, shippingFee, loyaltyBase,
          paymentMethod: input.paymentMethod,
          staffId: input.context.actor.id,
        },
      });

      // Loyalty processing
      if (input.customerId) {
        const tiers = await txn.getLoyaltyTiers();
        const points = calculateLoyaltyPoints(loyaltyBase);
        const totalPoints = await txn.getTotalLoyaltyPoints(input.customerId) + points;
        const tier = evaluateTier(totalPoints, tiers);
        const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        await txn.insertLoyaltyRecord({
          customerId: input.customerId,
          sourceEventId: eventId,
          orderId: order.id,
          pointsEarned: points,
          pointsRedeemed: 0,
          tierAtTime: tier,
          description: `Order ${order.orderNumber}`,
        });
        await txn.upsertCustomerProfile({
          customerId: input.customerId,
          totalSpent: (await txn.getCustomerProfile(input.customerId) || { totalSpent: 0 }).totalSpent + total,
          orderCount: (await txn.getCustomerProfile(input.customerId) || { orderCount: 0 }).orderCount + 1,
          lastPurchaseAt: new Date().toISOString(),
        });
      }

      // Accounting entries
      const coaCash = await txn.getAccountByCode("1111");
      const coaRevenue = await txn.getAccountByCode("5111");
      const coaCogs = await txn.getAccountByCode("6321");
      const coaInventory = await txn.getAccountByCode("1561");
      if (coaCash && coaRevenue && coaCogs && coaInventory) {
        const cogs = items.reduce((sum, i) => sum + i.quantity * (i.costPrice ?? i.unitPrice * 0.7), 0);
        await txn.insertJournalEntry({
          entryDate: new Date().toISOString().slice(0, 10),
          referenceType: "order",
          referenceId: order.id,
          description: `Bán hàng - Đơn ${order.orderNumber}`,
          status: "posted",
          postedAt: new Date().toISOString(),
          createdBy: "system",
          lines: [
            { accountCode: "1111", debitAmount: total, creditAmount: 0, description: "Cash" },
            { accountCode: "5111", debitAmount: 0, creditAmount: total, description: "Sales Revenue" },
            { accountCode: "6321", debitAmount: cogs, creditAmount: 0, description: "COGS" },
            { accountCode: "1561", debitAmount: 0, creditAmount: cogs, description: "Inventory" },
          ],
        });
      }

      const response = { order, change };
      await store.setIdempotencyRecord(input.idempotencyKey, bodyHash, response);

      // F-3: Audit log
      recordAudit({
        actorType: input.context.actor.type,
        actorId: input.context.actor.id,
        action: "order.created",
        subjectType: "order",
        subjectId: order.id,
        after: { orderNumber: order.orderNumber, total: order.total, paymentMethod: order.paymentMethod, items: order.items.length },
        correlationId: input.context.correlationId || "",
      });

      return response;
    });
  }

  // ── POS: Cancel Sale ────────────────────────────────────

  async function cancelSale(input: {
    orderId: string; reason: string; context: RequestContext;
  }): Promise<StoreOrder> {
    return store.transaction(async (txn) => {
      const order = await txn.findOrder(input.orderId);
      if (!order) throw new ApplicationError("resource_not_found", "Order not found", 404);
      if (order.status === "cancelled") throw new ApplicationError("invalid_state_transition", "Order is already cancelled", 409);

      await txn.updateOrderStatus(input.orderId, "cancelled");

      for (const item of order.items) {
        const variant = await txn.findVariant(item.variantId);
        if (variant) {
          const newLevel = variant.stockLevel + item.quantity;
          await txn.updateVariantStock(item.variantId, newLevel);
          await txn.insertStockMovement({
            inventoryItemId: variant.inventoryItemId,
            movementType: "return", quantityChange: item.quantity, quantityAfter: newLevel,
            referenceType: "order", referenceId: input.orderId, reason: input.reason,
            performedBy: input.context.actor.id,
          });
        }
      }

      await txn.emitEvent({
        eventType: "sale.cancelled", aggregateType: "order", aggregateId: input.orderId,
        organizationId: "org_default", correlationId: input.context.correlationId || "",
        actor: input.context.actor,
        payload: { orderId: input.orderId, reason: input.reason, cancelledBy: input.context.actor.id },
      });

      // F-3: Audit log
      recordAudit({
        actorType: input.context.actor.type,
        actorId: input.context.actor.id,
        action: "order.cancelled",
        subjectType: "order",
        subjectId: input.orderId,
        reason: input.reason,
        correlationId: input.context.correlationId || "",
      });

      return { ...order, status: "cancelled" };
    });
  }

  // ── CRM: Create Customer ─────────────────────────────────

  async function createCustomer(input: CreateCustomerInput & { context: RequestContext }): Promise<StoreCustomer> {
    const existing = await store.findCustomerByPhone(input.phone);
    if (existing) throw new ApplicationError("validation_error", "Customer with this phone already exists", 400);

    const customer: StoreCustomer = {
      id: `cus_${Math.random().toString(36).slice(2, 8)}`,
      phone: input.phone,
      firstName: input.name.split(" ").slice(-1)[0],
      lastName: input.name.split(" ").slice(0, -1).join(" "),
    };
    await store.insertCustomer(customer);

    await store.upsertCustomerProfile({ customerId: customer.id, phone: input.phone, name: input.name });

    await store.emitEvent({
      eventType: "customer.created", aggregateType: "customer", aggregateId: customer.id,
      organizationId: "org_default", correlationId: input.context.correlationId || "",
      actor: input.context.actor,
      payload: { customerId: customer.id, phone: input.phone, name: input.name },
    });

    return customer;
  }

  // ── CRM: Get Customer Profile ────────────────────────────

  async function getCustomerProfile(customerId: string): Promise<CustomerProfile> {
    const profile = await store.getCustomerProfile(customerId);
    if (!profile) throw new ApplicationError("resource_not_found", "Customer profile not found", 404);
    const tiers = await store.getLoyaltyTiers();
    const totalPoints = await store.getTotalLoyaltyPoints(customerId);
    const tier = evaluateTier(totalPoints, tiers);
    const nextPoints = pointsToNextTier(totalPoints, tiers);
    return { ...profile, loyaltyPoints: totalPoints, tier, nextTierPoints: nextPoints };
  }

  // ── Inventory: Adjust Stock ──────────────────────────────

  async function adjustStock(input: AdjustStockInput & { context: RequestContext }): Promise<{ newLevel: number }> {
    const product = await store.findProduct(input.inventoryItemId);
    if (!product) throw new ApplicationError("resource_not_found", "Product not found", 404);

    const variant = product.variants[0];
    const newLevel = variant.stockLevel + input.adjustment;
    if (newLevel < 0) throw new ApplicationError("validation_error", "Stock cannot go below zero", 400);

    await store.updateVariantStock(variant.id, newLevel);
    await store.insertStockMovement({
      inventoryItemId: input.inventoryItemId,
      movementType: input.movementType,
      quantityChange: input.adjustment, quantityAfter: newLevel,
      referenceType: "adjustment", referenceId: `adj_${Math.random().toString(36).slice(2, 6)}`,
      reason: input.reason, performedBy: input.context.actor.id,
    });

    await store.emitEvent({
      eventType: "stock.changed", aggregateType: "inventory", aggregateId: input.inventoryItemId,
      organizationId: "org_default", correlationId: input.context.correlationId || "",
      actor: input.context.actor,
      payload: {
        productId: product.id, variantId: variant.id,
        locationId: "loc_default", movementType: input.movementType,
        quantityChange: input.adjustment, quantityBefore: variant.stockLevel,
        quantityAfter: newLevel, reorderLevel: variant.reorderLevel,
        referenceType: "adjustment",
      },
    });

    // F-3: Audit log
    recordAudit({
      actorType: input.context.actor.type,
      actorId: input.context.actor.id,
      action: "stock.adjusted",
      subjectType: "product",
      subjectId: input.inventoryItemId,
      reason: input.reason,
      before: { stockLevel: variant.stockLevel },
      after: { stockLevel: newLevel },
      correlationId: input.context.correlationId || "",
    });

    return { newLevel };
  }

  // ── Inventory: Purchase Orders ───────────────────────────

  async function createPurchaseOrder(input: CreatePurchaseOrderInput & { context: RequestContext }): Promise<PurchaseOrder> {
    return store.insertPurchaseOrder({
      supplierName: input.supplierName,
      status: "draft",
      items: input.items.map((item, idx) => ({
        id: `poi_${idx + 1}`, variantId: item.variantId, quantity: item.quantity,
        unitCost: item.unitCost, receivedQuantity: 0,
      })),
      expectedDate: input.expectedDate,
    });
  }

  async function receivePurchaseOrder(input: {
    purchaseOrderId: string;
    items: Array<{ purchaseOrderItemId: string; receivedQuantity: number }>;
    context: RequestContext;
  }): Promise<PurchaseOrder> {
    const po = await store.findPurchaseOrder(input.purchaseOrderId);
    if (!po) throw new ApplicationError("resource_not_found", "Purchase order not found", 404);
    if (po.status === "cancelled" || po.status === "received") {
      throw new ApplicationError("invalid_state_transition", `Cannot receive PO in status: ${po.status}`, 409);
    }

    for (const received of input.items) {
      const poi = po.items.find(i => i.id === received.purchaseOrderItemId);
      if (!poi) throw new ApplicationError("resource_not_found", `PO item ${received.purchaseOrderItemId} not found`, 404);
      if (poi.receivedQuantity + received.receivedQuantity > poi.quantity) {
        throw new ApplicationError("validation_error", "Received quantity exceeds ordered quantity", 400);
      }
      poi.receivedQuantity += received.receivedQuantity;

      const product = await store.findProductByVariant(poi.variantId);
      if (product) {
        const variant = product.variants.find(v => v.id === poi.variantId)!;
        const newLevel = variant.stockLevel + received.receivedQuantity;
        await store.updateVariantStock(poi.variantId, newLevel);
        await store.insertStockMovement({
          inventoryItemId: variant.inventoryItemId,
          movementType: "purchase_receipt", quantityChange: received.receivedQuantity, quantityAfter: newLevel,
          referenceType: "purchase_order", referenceId: po.id,
          performedBy: input.context.actor.id,
        });

        await store.emitEvent({
          eventType: "stock.changed", aggregateType: "inventory", aggregateId: variant.inventoryItemId,
          organizationId: "org_default", correlationId: input.context.correlationId || "",
          actor: input.context.actor,
          payload: {
            productId: product.id, variantId: poi.variantId,
            locationId: "loc_default", movementType: "purchase_receipt",
            quantityChange: received.receivedQuantity, quantityBefore: variant.stockLevel,
            quantityAfter: newLevel, reorderLevel: variant.reorderLevel,
            referenceType: "purchase_order", referenceId: po.id,
          },
        });
      }
    }

    const allReceived = po.items.every(i => i.receivedQuantity >= i.quantity);
    const partial = po.items.some(i => i.receivedQuantity > 0);
    const newStatus = allReceived ? "received" : partial ? "partially_received" : po.status;
    await store.updatePurchaseOrder(po.id, { status: newStatus });

    return { ...po, status: newStatus };
  }

  // ── Accounting: Manual Journal Entry ─────────────────────

  async function createManualJournalEntry(input: CreateJournalEntryInput & { context: RequestContext }): Promise<JournalEntry> {
    const totalDebits = input.lines.reduce((s, l) => s + l.debitAmount, 0);
    const totalCredits = input.lines.reduce((s, l) => s + l.creditAmount, 0);
    const err = validateJournalEntry(totalDebits, totalCredits);
    if (err) throw new ApplicationError("validation_error", err, 400);

    for (const line of input.lines) {
      const acct = await store.getAccountByCode(line.accountCode);
      if (!acct) throw new ApplicationError("resource_not_found", `Account ${line.accountCode} not found`, 404);
    }

    return store.insertJournalEntry({
      entryDate: input.entryDate,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      description: input.description,
      status: "draft",
      createdBy: input.context.actor.id,
      lines: input.lines,
    });
  }

  async function postJournalEntry(input: {
    entryId: string; context: RequestContext;
  }): Promise<JournalEntry> {
    const entry = await store.findJournalEntry(input.entryId);
    if (!entry) throw new ApplicationError("resource_not_found", "Journal entry not found", 404);
    if (entry.status !== "draft") throw new ApplicationError("invalid_state_transition", "Only draft entries can be posted", 409);
    await store.updateJournalEntryStatus(input.entryId, "posted", new Date().toISOString());
    return { ...entry, status: "posted", postedAt: new Date().toISOString() };
  }

  // ── AI: Reply Draft ──────────────────────────────────────

  async function requestAiReplyDraft(input: {
    customerMessage: string;
    productContext?: string[];
    operatorInstruction?: string;
    context: RequestContext;
  }): Promise<AiAction> {
    let products: StoreProduct[] = [];
    if (input.productContext?.length) {
      products = await store.findProducts(input.productContext);
    }

    // Deterministic AI provider
    const responseText = buildDraftResponse(input.customerMessage, products);
    const blocked = filterBlockedClaims(responseText);
    const confidence = 0.85;
    const riskLevel = assessRiskLevel({
      blockedClaimsCount: blocked.matches.length,
      confidence,
      isNewCustomer: false,
    });

    const action = await store.insertAiAction({
      actionType: "reply_draft",
      status: "review_required",
      outputPayload: {
        responseText: blocked.blocked ? "[BLOCKED] Draft contains blocked claims - operator review required" : responseText,
        intent: "product_inquiry",
        confidence,
        riskLevel,
        blockedClaimsFiltered: blocked.matches,
        kbArtifactsUsed: products.map(p => p.id),
      },
      confidence,
      riskLevel,
    });

    return action;
  }

  async function approveAiAction(input: {
    aiActionId: string; approvedText?: string; context: RequestContext;
  }): Promise<AiAction> {
    const action = await store.findAiAction(input.aiActionId);
    if (!action) throw new ApplicationError("resource_not_found", "AI action not found", 404);
    if (action.status !== "review_required" && action.status !== "pending") {
      throw new ApplicationError("invalid_state_transition", `Cannot approve action in status: ${action.status}`, 409);
    }
    await store.updateAiAction(input.aiActionId, {
      status: "approved",
      approvedText: input.approvedText,
      reviewedBy: input.context.actor.id,
    });
    return { ...action, status: "approved", approvedText: input.approvedText, reviewedBy: input.context.actor.id };
  }

  async function rejectAiAction(input: {
    aiActionId: string; reason: string; context: RequestContext;
  }): Promise<AiAction> {
    const action = await store.findAiAction(input.aiActionId);
    if (!action) throw new ApplicationError("resource_not_found", "AI action not found", 404);
    if (action.status !== "review_required" && action.status !== "pending") {
      throw new ApplicationError("invalid_state_transition", `Cannot reject action in status: ${action.status}`, 409);
    }
    await store.updateAiAction(input.aiActionId, {
      status: "rejected",
      rejectionReason: input.reason,
      reviewedBy: input.context.actor.id,
    });
    return { ...action, status: "rejected", rejectionReason: input.reason, reviewedBy: input.context.actor.id };
  }

  // ── Dashboard ────────────────────────────────────────────

  async function getDashboard(_date: string): Promise<{
    orderCount: number; totalRevenue: number; customersToday: number; products: number;
  }> {
    const orders = await store.listOrders();
    const todayOrders = orders.filter(o => o.createdAt.startsWith(_date));
    const totalRevenue = todayOrders.reduce((s, o) => s + o.total, 0);
    const customers = await store.listCustomers();
    const products = await store.listProducts();
    return {
      orderCount: todayOrders.length,
      totalRevenue,
      customersToday: customers.length,
      products: products.length,
    };
  }

  // ── Inventory Alerts ─────────────────────────────────────

  async function getInventoryAlerts(): Promise<InventoryAlert[]> {
    return store.getInventoryAlerts();
  }

  // ── Customer Loyalty ─────────────────────────────────────

  async function getCustomerLoyalty(customerId: string): Promise<{
    points: number; tier: LoyaltyTierName; nextTierPoints: number | null; history: LoyaltyRecord[];
  }> {
    const tiers = await store.getLoyaltyTiers();
    const points = await store.getTotalLoyaltyPoints(customerId);
    const tier = evaluateTier(points, tiers);
    const nextPoints = pointsToNextTier(points, tiers);
    const history = await store.listLoyaltyRecords(customerId);
    return { points, tier, nextTierPoints: nextPoints, history };
  }

  // ── Income Statement ─────────────────────────────────────

  async function getIncomeStatement(_from: string, _to: string): Promise<{
    revenue: number; cogs: number; grossProfit: number;
  }> {
    const entries = await store.listJournalEntries({ dateFrom: _from, dateTo: _to, status: "posted" });
    let revenue = 0, cogs = 0;
    for (const entry of entries) {
      for (const line of entry.lines) {
        if (line.accountCode === "5111") revenue += line.creditAmount;
        if (line.accountCode === "6321") cogs += line.debitAmount;
      }
    }
    return { revenue, cogs, grossProfit: revenue - cogs };
  }
}

// ── Deterministic AI draft helper ────────────────────────

function buildDraftResponse(message: string, products: StoreProduct[]): string {
  const lower = message.toLowerCase();

  if (products.length > 0) {
    const productList = products.map(p => {
      const v = p.variants[0];
      const stock = v ? (v.stockLevel > 0 ? `Còn ${v.stockLevel} hộp` : "Hết hàng") : "";
      const price = v ? `${v.price.toLocaleString("vi-VN")} VND` : "";
      return `${p.title} (${price}, ${stock})`;
    }).join("; ");
    return `Dạ chào anh/chị, bên em hiện có: ${productList}. Anh/chị cần số lượng bao nhiêu ạ?`;
  }

  if (lower.includes("giá") || lower.includes("bao nhiêu")) {
    return "Dạ anh/chị vui lòng cho biết sản phẩm cụ thể để em báo giá chính xác ạ.";
  }

  if (lower.includes("còn") || lower.includes("hàng") || lower.includes("hết")) {
    return "Dạ anh/chị cho em xin tên sản phẩm để em kiểm tra tồn kho ạ.";
  }

  return "Dạ em có thể giúp gì cho anh/chị ạ?";
}
