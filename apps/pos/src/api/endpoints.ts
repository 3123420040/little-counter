import { api, ApiError } from "./client";
import {
  CancellationQuoteV1Schema,
  EffectiveOrderPageV4Schema,
  EffectiveOrderPageV5Schema,
  ReportScopeSchema,
  CreatorSelectionV1Schema,
  EffectiveOrderRecreatePrefillV2Schema,
  EffectiveOrderRecreatePrefillV3Schema,
  EffectiveOrderSurfaceV2Schema,
  EffectiveOrderSurfaceV3Schema,
  OrderOperationalDetailV1Schema,
  type DashboardPartialFinancialRuntimeHttpBodyV1,
  CreatorSalesDashboardV3Schema, type CreatorSalesDashboardV3,
  CreatorSalesDashboardV2Schema,
  type CreatorSalesDashboardV2,
  type CancellationQuoteV1,
  type EffectiveOrderPageV4,
  type EffectiveOrderPageV5,
  type ReportScope,
  type EffectiveOrderSurfaceV2,
  type EffectiveOrderSurfaceV3,
  type PaymentFeeInputV1,
  parseOptionalPaymentFeeInputV1,
  PaymentIntentFinancialResponseV1Schema,
  PaymentIntentCreationReceiptInputV1Schema, PaymentIntentCreationReceiptV1Schema,
  PaymentIntentFinancialListResponseV1Schema,
  PaymentIntentFinancialListFiltersV1Schema,
  type PaymentIntentFinancialListFiltersV1,
  type PaymentIntentFinancialViewV1,
  CartPaymentFeePreviewInputV1Schema,
  CartPaymentFeePreviewV1Schema,
  CompleteSaleFinancialInputV1Schema,
  CreatePaymentIntentFinancialInputV1Schema,
  CheckoutPaymentFeeResponseV1Schema,
  type OrderPaymentFeeFinancialSnapshotV1,
  OrderCorrectionFinancialContextV1Schema, OrderCorrectionFinancialInputV1Schema,
  OrderCorrectionFinancialPreviewV1Schema, OrderCorrectionFinancialResponseV1Schema,
  type OrderCorrectionFinancialInputV1, type OrderCorrectionFinancialPreviewV1,
} from "@medusa-snus/contracts";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1, PAYMENT_FEE_WRITE_HTTP_HEADER_V1 } from "@medusa-snus/contracts/runtime-capabilities";
import { partialFinancialDashboardPathV1 } from "../utils/orderFinancialFeatureUiIntegration";
import { ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1 } from "../config/orderFinancialFeature";
import { validateEffectiveOrderCsvResponseV4, validateEffectiveOrderCsvResponseV5 } from "../utils/effectiveOrderCsvExportTaskV4";
import { createEffectiveOrderCsvDownloadCoordinatorV4, createEffectiveOrderCsvDownloadCoordinatorV5, type EffectiveOrderCsvDownloadCoordinatorDependenciesV4 } from "../utils/effectiveOrderCsvDownloadCoordinatorV4";
import { adaptEffectiveOrderRecreatePrefillV2, adaptEffectiveOrderRecreatePrefillV3 } from "../utils/effectiveOrderRecreateLiveAdapter";
import type {
  CustomerItem,
  InventoryItem,
  ProductCategoryItem,
  ProductItem,
  StockMovementFilters,
  StockMovementsResponse,
} from "./client";

function idempotencyKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createClientIdempotencyKey(prefix: string) {
  return idempotencyKey(prefix);
}

export type CsvDownloadResource = "products" | "categories" | "inventory" | "purchaseOrders";
export type CsvDownloadKind = "export" | "template";

const CSV_DOWNLOADS: Record<CsvDownloadResource, Record<CsvDownloadKind, { path: string; filename: string }>> = {
  products: {
    export: { path: "/api/platform/admin/products/export", filename: "products-export.csv" },
    template: { path: "/api/platform/admin/products/import-template", filename: "products-import-template.csv" },
  },
  categories: {
    export: { path: "/api/platform/admin/product-categories/export", filename: "product-categories-export.csv" },
    template: { path: "/api/platform/admin/product-categories/import-template", filename: "product-categories-import-template.csv" },
  },
  inventory: {
    export: { path: "/api/inventory/export", filename: "inventory-adjustments-export.csv" },
    template: { path: "/api/inventory/import-template", filename: "inventory-adjustments-import-template.csv" },
  },
  purchaseOrders: {
    export: { path: "/api/inventory/purchase-orders/export", filename: "purchase-orders-export.csv" },
    template: { path: "/api/inventory/purchase-orders/import-template", filename: "purchase-orders-import-template.csv" },
  },
};

export function csvDownloadEndpoint(resource: CsvDownloadResource, kind: CsvDownloadKind) {
  return CSV_DOWNLOADS[resource][kind];
}

function responseFilename(response: Response, fallback: string): string {
  const disposition = response.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename=(?:"([^"]+)"|([^;\s]+))/i);
  return match?.[1] || match?.[2] || fallback;
}

export async function downloadCsvResource(resource: CsvDownloadResource, kind: CsvDownloadKind): Promise<void> {
  const download = csvDownloadEndpoint(resource, kind);
  const response = await api.rawGet(download.path);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = responseFilename(response, download.filename);
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

export interface OrderExportFilters {
  dateFrom?: string;
  dateTo?: string;
  status?: "all" | "completed" | "other" | string;
  search?: string;
  creatorOperatorIds?: readonly string[];
}

const ORDER_EXPORT_DOWNLOAD = {
  path: "/api/platform/admin/orders/export",
  filename: "orders-export.csv",
};

function csvDownloadUrl(path: string, filters: Record<string, string | readonly string[] | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized) params.set(key, normalized);
      continue;
    }
    for (const item of value) {
      const normalized = item.trim();
      if (normalized) params.append(key, normalized);
    }
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export async function downloadOrderExportCsv(filters: OrderExportFilters, options?: { scope: ReportScope; signal: AbortSignal; feeAware: boolean }): Promise<void> {
  const scope = options ? ReportScopeSchema.parse(options.scope) : null;
  const signal = options?.signal;
  const current = () => { if (signal?.aborted) throw new Error("Phạm vi xuất CSV đã thay đổi."); };
  current();
  const feeAware = options?.feeAware === true;
  const rawCreators = filters.creatorOperatorIds ?? [];
  if (options && (rawCreators.some(id => typeof id !== "string" || !id.trim())
    || (filters.status !== undefined && !["all", "completed", "other"].includes(filters.status)))) throw new Error("Bộ lọc CSV không hợp lệ.");
  const selection = CreatorSelectionV1Schema.parse(rawCreators.length
    ? { mode: "selected", creatorOperatorIds: [...new Set(rawCreators.map(id => id.trim()))].sort() }
    : { mode: "all", creatorOperatorIds: [] });
  const transport = (path: string) => scope && signal ? api.rawGet(path, {
    "x-report-merchant-id": scope.merchantId, "x-report-store-ids": scope.storeIds.join(","),
  }, signal) : api.rawGet(path);
  if (ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1.effectiveCsvEnabled) {
    const response = await transport(csvDownloadUrl(
      feeAware ? "/api/platform/admin/orders/export-effective-v5" : "/api/platform/admin/orders/export-effective-v4",
      {
        from: filters.dateFrom,
        to: filters.dateTo,
        status: filters.status,
        search: filters.search,
        creatorOperatorId: selection.creatorOperatorIds,
        grain: "order",
      },
    ));
    current();
    if (feeAware) {
      let responseScope: ReportScope, responseSelection;
      try {
        responseScope = ReportScopeSchema.parse(JSON.parse(response.headers.get("X-Order-Export-Scope") || "null"));
        responseSelection = CreatorSelectionV1Schema.parse(JSON.parse(response.headers.get("X-Order-Export-Creator-Selection") || "null"));
      } catch { throw new Error("Thông tin phạm vi CSV không hợp lệ."); }
      if (!scope || responseScope.merchantId !== scope.merchantId || JSON.stringify([...responseScope.storeIds].sort()) !== JSON.stringify([...scope.storeIds].sort())
        || JSON.stringify(responseSelection) !== JSON.stringify(selection)) throw new Error("CSV không khớp phạm vi hoặc bộ lọc đã yêu cầu.");
    }
    const requestId = `effective-export-${Date.now()}`;
    const result = feeAware
      ? await validateEffectiveOrderCsvResponseV5(response, "order", Math.floor(Date.now() / 1_000), requestId)
      : await validateEffectiveOrderCsvResponseV4(response, "order", Math.floor(Date.now() / 1_000), requestId);
    current();
    const dependencies: EffectiveOrderCsvDownloadCoordinatorDependenciesV4 = {
      config: { enabled: true },
      createObjectUrl: (blob) => { current(); return URL.createObjectURL(blob); },
      triggerDownload: ({ objectUrl, filename }) => {
        current();
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = filename;
        link.style.display = "none";
        document.body.appendChild(link);
        try {
          link.click();
        } finally {
          link.remove();
        }
      },
      revokeObjectUrl: (objectUrl) => URL.revokeObjectURL(objectUrl),
    };
    const coordinator = result.kind === "ready" && result.contractVersion === "orders.effective-order.v5"
      ? createEffectiveOrderCsvDownloadCoordinatorV5(dependencies, result)
      : createEffectiveOrderCsvDownloadCoordinatorV4(dependencies, result);
    if (!coordinator.enabled) throw new Error("Effective-order CSV download is disabled");
    const outcome = await coordinator.execute();
    if (outcome.kind !== "downloaded") {
      throw new Error(outcome.kind === "async_required"
        ? `Selection exceeds ${outcome.maximumOrderCount} orders`
        : outcome.message);
    }
    return;
  }
  const response = await transport(csvDownloadUrl(ORDER_EXPORT_DOWNLOAD.path, {
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    status: filters.status,
    search: filters.search,
  }));
  const blob = await response.blob();
  current();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = responseFilename(response, ORDER_EXPORT_DOWNLOAD.filename);
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

export interface PurchaseOrderRecommendationExportParams {
  coverageDays?: number;
  includeZeroSuggestion?: boolean;
}

export async function downloadPurchaseOrderRecommendationCsv(params: PurchaseOrderRecommendationExportParams = {}): Promise<void> {
  const response = await api.rawGet(csvDownloadUrl("/api/inventory/purchase-orders/recommendation/export", {
    coverageDays: params.coverageDays ? String(params.coverageDays) : undefined,
    includeZeroSuggestion: params.includeZeroSuggestion === undefined ? undefined : String(params.includeZeroSuggestion),
  }));
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = responseFilename(response, "purchase-order-recommendation.csv");
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

export async function downloadPurchaseOrderDetailCsv(poId: string): Promise<void> {
  const response = await api.rawGet(`/api/inventory/purchase-orders/${encodeURIComponent(poId)}/export`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = responseFilename(response, `purchase-order-${poId}-detail.csv`);
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

const STOCK_MOVEMENT_HISTORY_DOWNLOAD = {
  path: "/api/inventory/movements/export",
  filename: "stock-movement-history.csv",
};

export interface ImportPreviewResult {
  importId: string;
  valid: boolean;
  summary: { totalRows: number; validRows: number; errorRows: number; warningRows: number };
  rows: Array<{
    rowNumber: number;
    action: string;
    status: "valid" | "warning" | "error";
    errors: string[];
    warnings: string[];
    normalized: Record<string, unknown>;
  }>;
}

export interface ImportApplyResult {
  importId: string;
  appliedRows: number;
  skippedRows: number;
  errorRows: number;
  rows: Array<{
    rowNumber: number;
    action: string;
    status: "applied" | "skipped" | "error";
    entityId?: string;
    errors: string[];
  }>;
}

const IMPORT_ROUTES: Record<CsvDownloadResource, { preview: string; apply: string }> = {
  products: {
    preview: "/api/platform/admin/products/import/preview",
    apply: "/api/platform/admin/products/import/apply",
  },
  categories: {
    preview: "/api/platform/admin/product-categories/import/preview",
    apply: "/api/platform/admin/product-categories/import/apply",
  },
  inventory: {
    preview: "/api/inventory/import/preview",
    apply: "/api/inventory/import/apply",
  },
  purchaseOrders: {
    preview: "/api/inventory/purchase-orders/import/preview",
    apply: "/api/inventory/purchase-orders/import/apply",
  },
};

export async function previewImport(resource: CsvDownloadResource, csvText: string) {
  return api.post<{ data: ImportPreviewResult }>(IMPORT_ROUTES[resource].preview, { csv: csvText });
}

export function importApplyIdempotencyKey(resource: CsvDownloadResource, previewImportId: string) {
  const normalizedPreviewId = previewImportId.trim();
  if (!normalizedPreviewId) throw new Error("Import preview ID is required");
  return `import:${resource}:${normalizedPreviewId}`;
}

export async function applyImport(resource: CsvDownloadResource, csvText: string, previewImportId: string) {
  return api.post<{ data: ImportApplyResult }>(
    IMPORT_ROUTES[resource].apply,
    { csv: csvText },
    importApplyIdempotencyKey(resource, previewImportId),
  );
}

export interface ProductListResponse {
  products: ProductItem[];
  count: number;
  offset: number;
  limit: number;
}

export interface ProductTagView {
  productId: string;
  variantId: string;
  title: string;
  brand: string;
  flavor: string;
  strengthLabel: string;
  formatLabels: string[];
  priceVnd: number;
  sku: string;
  barcode: string;
  qr: {
    codeId: string;
    slug: string;
    publicUrlPath: string;
    publicUrl: string;
    payloadVersion: number;
    printVersion: number;
  };
  warnings: string[];
}

export type ProductScanContext = "pos_add_to_cart" | "inventory_check";

export interface ProductScanResolution {
  context: ProductScanContext;
  resolutionSource: "qr" | "sku_barcode";
  qrCodeId?: string;
  qrSlug?: string;
  publicUrlPath?: string;
  productId: string;
  variantId: string;
  inventoryItemId: string;
  title: string;
  imageUrl: string;
  status: string;
  sku: string;
  barcode: string;
  price: number;
  stock: number;
}

export interface ProductCategoryListResponse {
  product_categories: ProductCategoryItem[];
  count: number;
  offset: number;
  limit: number;
  meta?: { uncategorizedProductCount?: number };
}

export interface ProductMutationInput {
  title: string;
  status: string;
  sku: string;
  barcode?: string;
  price: number;
  costPrice: number;
  reorderLevel: number;
  categoryIds: string[];
  imageUrl?: string;
}

export interface ProductCategoryMutationInput {
  name?: string;
  handle?: string;
  description?: string;
  rank?: number;
  isActive?: boolean;
}

export interface OrderLineItem {
  productId?: string | null;
  variantId?: string | null;
  name: string;
  quantity: number | string;
  unitPrice: number | string;
  lineTotal: number | string;
}

export interface OrderCreator {
  operatorId?: string | null;
  displayName?: string;
  role?: string;
  channel?: string | null;
  channelUserId?: string | null;
  serviceIdentity?: string | null;
  createdAt?: string;
}

export interface OrderCustomerSnapshot {
  id?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
}

export interface OrderListItem {
  cancellationAccess?: { allowed: boolean; mode: "full" | "own" | null; reasonCode: string | null };
  id: string;
  display_id: string;
  status: string;
  currencyCode?: string;
  minorUnitExponent?: number;
  subtotal?: number;
  discount?: number;
  tax?: number;
  total: number;
  merchandisePayable?: number;
  shippingFee?: number;
  merchandiseTax?: number;
  shippingTax?: number;
  merchandiseRevenue?: number;
  shippingRevenue?: number;
  created_at: string;
  notes?: string | null;
  salesChannel?: string;
  salesChannelLabel?: string;
  salesChannelLocked?: boolean;
  salesChannelLockReason?: string | null;
  sourceFlow?: string | null;
  scanGoCartId?: string | null;
  scanGoRedeemedAt?: string | null;
  customerNickname?: string | null;
  customerContactType?: string | null;
  redeemedByOperatorId?: string | null;
  paymentMethod?: string;
  paymentStatus?: string | null;
  manualBankConfirmationEnabled?: boolean;
  canonicalPaymentSummary?: {
    recordedGrossCollectionsMinor: number;
    refundsMinor: number;
    reversalsMinor: number;
    chargebacksMinor: number;
    negativeCollectionsMinor: number;
    netCollectionsMinor: number;
    customerRefundPayableMinor: number;
  };
  paymentEntries?: Array<{
    id: string;
    direction: string;
    method: string;
    amount: number;
    currencyCode: string;
    status: string;
    effectiveStatus?: "pending" | "partially_collected" | "posted";
    collectedAmountMinor?: number;
    remainingAmountMinor?: number;
    reference?: string | null;
    reason?: string | null;
    paymentIntentId?: string | null;
    paymentProvider?: string | null;
    providerEventId?: string | null;
    providerReference?: string | null;
    referenceCode?: string | null;
    providerTransactionId?: string | null;
    providerTransactionHash?: string | null;
    providerNetwork?: string | null;
    providerPayCurrency?: string | null;
    source?: string | null;
    correctionId?: string | null;
    canonicalPaymentEventId?: string | null;
    customerRefundPayableId?: string | null;
    createdBy?: string;
    createdAt?: string;
  }>;
  customerId?: string | null;
  customerAttribution?: "linked" | "walk_in" | "unknown";
  customer?: OrderCustomerSnapshot;
  items?: OrderLineItem[];
  createdBy?: OrderCreator;
  stockAdjustments?: Array<{
    type?: string;
    reasonCode?: string;
    reason?: string;
    productId?: string;
    variantId?: string;
    productName?: string;
    sku?: string;
    systemStockBefore?: number;
    requestedQuantity?: number;
    adjustedQuantity?: number;
    unitCost?: number;
    inventoryValue?: number;
    performedBy?: string;
    movementId?: string | null;
  }>;
  correctionSummary?: {
    latestRevision: number;
    effectiveTotal: number | null;
    hasPendingSettlement: boolean;
  };
  corrections?: Array<{
    id: string;
    revision: number;
    status: string;
    reason: string;
    totalDelta: number;
    createdAt: string;
  }>;
}

export interface OrderRecreatePrefillItem {
  variantId: string;
  productId?: string;
  productName: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  stockLevel: number;
  unavailable?: boolean;
  priceChanged?: boolean;
  originalPrice?: number;
  warning?: string;
}

export interface OrderRecreatePrefill {
  sourceScope?: { merchantId: string; storeId: string };
  sourceOrderId: string;
  sourceOrderNumber: string;
  customerAttribution?: "linked" | "walk_in" | "unknown";
  customer?: { id: string; phone?: string; name?: string } | null;
  items: OrderRecreatePrefillItem[];
  unavailableCount: number;
  warningCount: number;
}

export async function fetchOrderRecreatePrefill(orderId: string) {
  return api.get<{ prefill: OrderRecreatePrefill }>(`/api/orders/${encodeURIComponent(orderId)}/recreate-prefill`);
}

export async function fetchEffectiveOrderFeatureRecreatePrefill(orderId: string) {
  const response = await api.get<{ prefill: unknown }>(
    `/api/orders/${encodeURIComponent(orderId)}/effective-recreate-prefill-v2`,
  );
  const prefill = EffectiveOrderRecreatePrefillV2Schema.parse(response.prefill);
  return { prefill: adaptEffectiveOrderRecreatePrefillV2(prefill) };
}

export async function fetchEffectiveOrderFeatureRecreatePrefillV3(orderId: string, scope: { merchantId: string; storeId: string }, signal?: AbortSignal) {
  const { merchantId, storeId } = scope;
  if (![orderId, merchantId, storeId].every(value => typeof value === "string" && value.trim().length > 0)) {
    throw new Error("Thiếu đơn hàng hoặc phạm vi cửa hàng để tạo lại đơn.");
  }
  const response = await api.get<{ prefill: unknown }>(`/api/orders/${encodeURIComponent(orderId)}/effective-recreate-prefill-v3`, {
    "x-operating-merchant-id": merchantId, "x-operating-store-id": storeId,
  }, signal);
  const prefill = EffectiveOrderRecreatePrefillV3Schema.parse(response.prefill);
  if (prefill.commercialPrefill.sourceOrder.orderId !== orderId) throw new Error("Nguồn tạo lại không khớp đơn hàng đã chọn.");
  return { prefill: { ...adaptEffectiveOrderRecreatePrefillV3(prefill), sourceScope: { merchantId, storeId } } };
}

export async function fetchOrderCancellationQuote(orderId: string): Promise<CancellationQuoteV1> {
  const response = await api.post<{ quote: unknown }>(
    `/api/orders/${encodeURIComponent(orderId)}/cancel/quote`,
    {},
    idempotencyKey("cancel-quote"),
  );
  return CancellationQuoteV1Schema.parse(response.quote);
}

export async function cancelOrderWithConfirmation(
  orderId: string,
  reason: string,
  quote: Pick<CancellationQuoteV1, "quoteId" | "effectiveRevision" | "generatedAt">,
) {
  return api.post(`/api/orders/${orderId}/cancel`, {
    reason,
    quoteId: quote.quoteId,
    effectiveRevision: quote.effectiveRevision,
    quoteGeneratedAt: quote.generatedAt,
  }, idempotencyKey("cancel"));
}

export interface RefundOrderWithEvidenceInput {
  amount: number;
  method: "cash" | "bank_transfer";
  sourceReference?: string;
  paidAt?: string;
  reason: string;
  confirmationToken: string;
}

export interface RefundOrderWithEvidenceResult {
  data: {
    orderId: string;
    orderNumber: string;
    status: "refunded" | "partially_refunded";
    refundEntryId: string;
    amount: number;
    refundableBefore: number;
    refundableAfter: number;
    canonicalPaymentEventId: string;
    restock: false;
  };
}

export async function refundOrderWithEvidence(
  orderId: string,
  input: RefundOrderWithEvidenceInput,
  intentKey: string,
): Promise<RefundOrderWithEvidenceResult> {
  return api.post<RefundOrderWithEvidenceResult>(
    `/api/orders/${encodeURIComponent(orderId)}/refund`,
    { ...input, restock: false },
    intentKey,
  );
}

export async function fetchProducts(query?: { q?: string; categoryId?: string; categoryHandle?: string; limit?: number }): Promise<ProductItem[]> {
  const params = new URLSearchParams();
  params.set("status[]", "published");
  if (query?.q) params.set("q", query.q);
  if (query?.categoryId) params.set("categoryId", query.categoryId);
  if (query?.categoryHandle) params.set("categoryHandle", query.categoryHandle);
  if (query?.limit) params.set("limit", String(query.limit));
  const res = await api.get<{ data: ProductItem[] }>(`/api/pos/products?${params.toString()}`);
  return res.data || [];
}

export async function fetchProduct(id: string): Promise<ProductItem> {
  const res = await api.get<{ product: ProductItem }>(`/api/platform/admin/products/${id}`);
  return res.product;
}

export async function fetchProductTag(id: string): Promise<ProductTagView> {
  const res = await api.get<{ data: ProductTagView }>(`/api/platform/admin/products/${id}/tag`);
  return res.data;
}

export async function resolveProductScan(input: { code: string; context: ProductScanContext }) {
  return api.post<{ data: ProductScanResolution }>("/api/pos/scan/resolve", input);
}

export type VisionScanMode = "single" | "bulk";
export type VisionDetectionSource = "qr" | "barcode" | "vision_provider" | "manual";
export type VisionDetectionType = "exact_match" | "candidate_match" | "unresolved";
export type VisionCorrectionType = "staff_accepted" | "staff_selected_correct_variant" | "staff_rejected" | "manual_search_selected";

export interface VisionCandidateView {
  productId: string;
  variantId: string;
  title: string;
  sku: string;
  barcode: string;
  imageUrl: string;
  price: number;
  stock: number;
  confidence: number;
  source: VisionDetectionSource;
  providerProductRef?: string;
  providerImageRef?: string;
  warnings: string[];
}

export interface VisionDetectionView {
  detectionId: string;
  objectId: string;
  bbox?: Record<string, unknown>;
  objectOrder?: number;
  providerObjectLabel?: string;
  providerObjectConfidence?: number;
  source: VisionDetectionSource;
  detectionType: VisionDetectionType;
  resolvedVariantId: string;
  confidence: number | null;
  candidates: VisionCandidateView[];
  requiresConfirmation: boolean;
  decision: "pending" | "accepted" | "corrected" | "rejected" | "unresolved";
  warnings: string[];
}

export interface VisionScanResultData {
  scanId: string;
  mode: VisionScanMode;
  status: "success" | "partial" | "failed";
  provider: string;
  modelVersion: string;
  requiresStaffConfirmation: true;
  detections: VisionDetectionView[];
}

export interface VisionScanInput {
  mode?: VisionScanMode;
  clientScanId?: string;
  imageBase64?: string;
  imageBase64List?: string[];
  imageHash?: string;
  qrCodes?: string[];
}

export interface VisionCorrectionInput {
  detectionId?: string;
  selectedVariantId?: string;
  previousVariantId?: string;
  correctionType?: VisionCorrectionType;
  metadata?: Record<string, unknown>;
}

export interface VisionCartContext {
  scanEventId: string;
  detectionId?: string;
  correctionId?: string;
  objectId?: string;
  candidateSource: "ai_candidate" | "manual_search_after_scan";
  provider: string;
  providerCandidateRank?: number;
  providerConfidence?: number;
  providerProductRef?: string;
  providerImageRef?: string;
}

export async function scanVisionProducts(input: VisionScanInput) {
  return api.post<{ data: VisionScanResultData }>(
    "/api/pos/vision/scan-products",
    input,
    idempotencyKey("vision-scan"),
  );
}

export async function recordVisionScanCorrection(scanId: string, input: VisionCorrectionInput) {
  return api.post<{ data: { correctionId: string } }>(
    `/api/pos/vision/scans/${encodeURIComponent(scanId)}/corrections`,
    input,
    idempotencyKey("vision-correction"),
  );
}

export type VisionCatalogReadinessStatus = "ready" | "needs_image" | "needs_index" | "index_failed";
export type VisionCatalogReadinessDetailStatus =
  | "not_ready"
  | "missing_front_image"
  | "missing_counter_image"
  | "missing_strength_image"
  | "pending_approval"
  | "pending_provider_sync"
  | "index_failed"
  | "ready_for_single_scan"
  | "ready_for_bulk_scan";

export interface VisionCatalogReadinessItem {
  productId: string;
  variantId: string;
  title: string;
  sku: string;
  barcode: string;
  status: string;
  metadataImageUrl: string;
  primaryImageId: string;
  primaryImageUrl: string;
  referenceImageCount: number;
  approvedImageCount: number;
  pendingImageCount: number;
  rejectedImageCount: number;
  approvedFrontImageCount: number;
  approvedCounterCaptureImageCount: number;
  approvedStrengthTextImageCount: number;
  pendingFrontImageCount: number;
  pendingCounterCaptureImageCount: number;
  pendingStrengthTextImageCount: number;
  indexedImageCount: number;
  syncedImageCount: number;
  failedIndexCount: number;
  isHighRiskVariant: boolean;
  readiness: VisionCatalogReadinessStatus;
  readinessStatus: VisionCatalogReadinessDetailStatus;
  readinessReasons: string[];
  missingImageTypes: string[];
}

export interface VisionReferenceImageSyncResult {
  insertedCount: number;
  totalProductsWithImageUrl: number;
}

export interface VisionReferenceImageView {
  imageId: string;
  merchantId: string;
  storeId: string | null;
  productId: string;
  variantId: string;
  title: string;
  sku: string;
  barcode: string;
  imageUrl: string;
  imageType: string;
  qualityStatus: string;
  isPrimary: boolean;
  providerProductRef: string;
  providerImageRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface VisionReferenceImageCreateInput {
  storeId?: string;
  productId?: string;
  variantId?: string;
  imageUrl?: string;
  imageType?: string;
  qualityStatus?: string;
  isPrimary?: boolean;
  metadata?: Record<string, unknown>;
}

export interface VisionReferenceImageUploadInput {
  storeId?: string;
  productId?: string;
  variantId?: string;
  imageBase64?: string;
  fileName?: string;
  contentType?: string;
  imageType?: string;
  qualityStatus?: string;
  isPrimary?: boolean;
  metadata?: Record<string, unknown>;
}

export interface VisionReferenceImageUpdateInput {
  imageType?: string;
  qualityStatus?: string;
  isPrimary?: boolean;
  metadata?: Record<string, unknown>;
}

export interface VisionScanReportItem {
  scanId: string;
  detectionId: string;
  createdAt: string;
  merchantId: string;
  storeId: string;
  operatorId: string;
  mode: VisionScanMode;
  status: string;
  provider: string;
  modelVersion: string;
  latencyMs: number;
  imageHash: string;
  objectId: string;
  source: VisionDetectionSource;
  detectionType: VisionDetectionType;
  confidence: number | null;
  decision: VisionDetectionView["decision"];
  suggestedVariantId: string;
  suggestedTitle: string;
  suggestedSku: string;
  selectedVariantId: string;
  selectedTitle: string;
  selectedSku: string;
  correctionType: string;
  correctedAt: string;
  warnings: string[];
  candidateCount: number;
}

export interface VisionScanReportResponse {
  data: VisionScanReportItem[];
  meta: {
    limit: number;
    offset: number;
    count: number;
  };
}

export async function fetchVisionCatalogReadiness(filters?: { q?: string; provider?: string; limit?: number; offset?: number }) {
  const params = new URLSearchParams();
  if (filters?.q) params.set("q", filters.q);
  if (filters?.provider) params.set("provider", filters.provider);
  if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
  return api.get<{ data: VisionCatalogReadinessItem[] }>(`/api/platform/admin/vision/catalog/readiness?${params.toString()}`);
}

export async function syncVisionReferenceImagesFromMetadata() {
  return api.post<{ data: VisionReferenceImageSyncResult }>(
    "/api/platform/admin/vision/catalog/sync-reference-images",
    {},
    idempotencyKey("vision-catalog-sync"),
  );
}

export async function createVisionReferenceImage(input: VisionReferenceImageCreateInput) {
  return api.post<{ data: VisionReferenceImageView }>(
    "/api/platform/admin/vision/catalog/reference-images",
    input,
    idempotencyKey("vision-reference-image-create"),
  );
}

export async function uploadVisionReferenceImage(input: VisionReferenceImageUploadInput) {
  return api.post<{ data: VisionReferenceImageView }>(
    "/api/platform/admin/vision/catalog/reference-image-uploads",
    input,
    idempotencyKey("vision-reference-image-upload"),
  );
}

export async function updateVisionReferenceImage(imageId: string, input: VisionReferenceImageUpdateInput) {
  return api.patch<{ data: VisionReferenceImageView }>(
    `/api/platform/admin/vision/catalog/reference-images/${encodeURIComponent(imageId)}`,
    input,
    idempotencyKey("vision-reference-image-update"),
  );
}

export async function fetchVisionScanReport(filters?: {
  dateFrom?: string;
  dateTo?: string;
  storeId?: string;
  provider?: string;
  source?: string;
  decision?: string;
  variantId?: string;
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (filters?.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters?.dateTo) params.set("dateTo", filters.dateTo);
  if (filters?.storeId) params.set("storeId", filters.storeId);
  if (filters?.provider) params.set("provider", filters.provider);
  if (filters?.source) params.set("source", filters.source);
  if (filters?.decision) params.set("decision", filters.decision);
  if (filters?.variantId) params.set("variantId", filters.variantId);
  if (filters?.limit) params.set("limit", String(filters.limit));
  if (filters?.offset) params.set("offset", String(filters.offset));
  return api.get<VisionScanReportResponse>(`/api/platform/admin/vision/scans?${params.toString()}`);
}

export interface StaffScanGoCartLine {
  productId: string;
  variantId: string;
  inventoryItemId: string;
  sku: string;
  title: string;
  quantity: number;
  unitPrice: number;
  stockLevel: number;
  warning?: string;
}

export interface StaffScanGoCart {
  cartId: string;
  status: string;
  sourceFlow: "customer_scan_go";
  salesChannel: "stash_dash";
  salesChannelLocked: true;
  customerNickname: string | null;
  customerContact: string | null;
  contactType: "whatsapp" | "email" | "phone" | null;
  ageVerificationReminder: string;
  expiresAt: string;
  redeemedAt?: string;
  redeemedByOperatorId?: string | null;
  lines: StaffScanGoCartLine[];
  warnings: string[];
}

export async function resolveScanGoCart(input: { tokenOrPayload: string }) {
  return api.post<{ data: StaffScanGoCart }>("/api/pos/scan-go/resolve-cart", input);
}

export async function redeemScanGoCart(input: { tokenOrPayload: string }) {
  return api.post<{ data: StaffScanGoCart }>("/api/pos/scan-go/redeem-cart", input, idempotencyKey("scan-go-redeem"));
}

export interface AdminProductListResponse {
  products: ProductItem[];
  count: number;
  metrics: {
    total: number;
    published: number;
    draft: number;
    uncategorized: number;
  };
  limit: number;
  offset: number;
}

export async function fetchAdminProducts(filters?: { q?: string; status?: string; categoryId?: string; limit?: number; offset?: number }) {
  const params = new URLSearchParams();
  if (filters?.q) params.set("q", filters.q);
  if (filters?.status) params.set("status", filters.status);
  if (filters?.categoryId) params.set("categoryId", filters.categoryId);
  if (filters?.limit) params.set("limit", String(filters.limit));
  if (filters?.offset) params.set("offset", String(filters.offset));
  return api.get<AdminProductListResponse>(`/api/platform/admin/products?${params.toString()}`);
}

export async function createAdminProduct(input: ProductMutationInput) {
  return api.post<{ product: ProductItem }>("/api/platform/admin/products", input, idempotencyKey("product"));
}

export async function updateAdminProduct(id: string, input: ProductMutationInput) {
  return api.patch<{ product: ProductItem }>(`/api/platform/admin/products/${id}`, input, idempotencyKey("product-update"));
}

export interface ProductResearchSource {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  language?: string;
  rank?: number;
}

export interface ProductResearchData {
  runId: string;
  merchantId?: string;
  productId: string;
  productTitle: string;
  provider: string;
  status: string;
  summary: string;
  confidence: string;
  riskFlags: string[];
  contradictions?: string[];
  rawQuery: string;
  preferredLanguage?: string;
  quotaReservationToken?: string | null;
  operatorReviewStatus?: string;
  operatorNotes?: string;
  operatorTaskDraft?: Record<string, unknown>;
  createdAt: string;
  bestSource?: ProductResearchSource | null;
  sources: ProductResearchSource[];
}

export interface ProductResearchResult {
  data: ProductResearchData;
}

export async function runProductResearch(productId: string, query?: string) {
  return api.post<ProductResearchResult>("/ai/product-research", { productId, query }, idempotencyKey("product-research"));
}

export async function fetchLatestProductResearch(productId: string) {
  return api.get<ProductResearchResult>(`/ai/product-research/${productId}/latest`);
}

export async function updateProductResearchReview(runId: string, input: {
  operatorNotes?: string;
  operatorReviewStatus?: "pending" | "reviewed" | "needs_follow_up";
  operatorTaskDraft?: Record<string, unknown>;
}) {
  return api.patch<{ data: Pick<ProductResearchData, "runId" | "merchantId" | "productId" | "operatorNotes" | "operatorReviewStatus" | "operatorTaskDraft"> & { operatorReviewedAt: string } }>(
    `/ai/product-research/runs/${runId}/review`,
    input,
    idempotencyKey("product-research-review"),
  );
}

export async function fetchProductCategories(query?: {
  q?: string;
  status?: string;
  includeProductCounts?: boolean;
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (query?.q) params.set("q", query.q);
  if (query?.status) params.set("status", query.status);
  if (query?.includeProductCounts !== undefined) {
    params.set("includeProductCounts", String(query.includeProductCounts));
  }
  if (query?.limit !== undefined) params.set("limit", String(query.limit));
  if (query?.offset !== undefined) params.set("offset", String(query.offset));
  return api.get<ProductCategoryListResponse>(`/api/platform/admin/product-categories?${params.toString()}`);
}

export async function fetchProductCategory(id: string) {
  return api.get<{ product_category: ProductCategoryItem }>(`/api/platform/admin/product-categories/${id}`);
}

export async function createProductCategory(input: ProductCategoryMutationInput) {
  return api.post<{ product_category: ProductCategoryItem }>("/api/platform/admin/product-categories", input, idempotencyKey("category"));
}

export async function updateProductCategory(id: string, input: ProductCategoryMutationInput) {
  return api.patch<{ product_category: ProductCategoryItem }>(`/api/platform/admin/product-categories/${id}`, input, idempotencyKey("category-update"));
}

export async function deleteProductCategory(id: string) {
  return api.delete<{ deleted: boolean; id: string }>(`/api/platform/admin/product-categories/${id}`, idempotencyKey("category-delete"));
}

export interface CompleteSaleInput extends Partial<PaymentFeeInputV1> {
  cartConfirmationToken?: string;
  items: Array<{ variantId: string; quantity: number; vision?: VisionCartContext; visionContexts?: VisionCartContext[] }>;
  customerId?: string;
  customerMode?: "linked" | "walk_in";
  paymentMethod: string;
  amountReceived: number;
  discountPercent?: number;
  discountType?: "percent" | "amount";
  discountValue?: number;
  shippingFee?: number;
  notes?: string;
  salesChannel?: string;
  sourceFlow?: string;
  scanGoCartId?: string;
  scanGoCheckoutToken?: string;
  scanGoRedeemedAt?: string;
  salesChannelLocked?: boolean;
  customerNickname?: string | null;
  customerContactType?: string | null;
  redeemedByOperatorId?: string | null;
  telegramSalesDraftId?: string;
  telegramSalesOperatorNotes?: string | null;
  sourceOrderId?: string;
  shiftId?: string;
  shiftOpenedAt?: string;
  shiftAttribution?: "online_open_shift" | "offline_cached_shift" | "legacy_time_window" | "unassigned";
  queuedAt?: string;
  idempotencyKey: string;
  bankTransferSettlementAcknowledgment?: {
    policyVersion: number;
    acknowledgmentVersion: number;
  };
  foundStockConfirmation?: {
    confirmed: true;
    reasonCode: "found_stock";
    reasonLabel: "Tìm thấy";
    acknowledgedShortages: Array<{ variantId: string; shortageQuantity: number }>;
  };
}

export interface CompleteSaleResponse {
    data: {
      orderId: string; orderNumber: string; status: string; customerId?: string | null;
      subtotal: number; tax: number; discount: number; total: number; shippingFee: number; merchandisePayable: number;
      change: number; items: Array<Record<string, unknown>>; paymentMethod: string; createdAt: string;
      shiftId?: string | null; shiftOpenedAt?: string | null; shiftAttribution?: string | null; shiftQueuedAt?: string | null;
      financial?: OrderPaymentFeeFinancialSnapshotV1;
    };
}
export async function completeSale(input: CompleteSaleInput, scope?: { merchantId: string; storeId: string }): Promise<CompleteSaleResponse> {
  let fee: PaymentFeeInputV1 | undefined;
  try { fee = parseOptionalPaymentFeeInputV1(input); }
  catch { throw new ApiError("Đơn có phụ phí chưa hợp lệ. Giữ đơn để kiểm tra lại trước khi đồng bộ.", 400, "validation_error"); }
  if (fee) {
    if (!scope) throw new ApiError("Thiếu phạm vi cửa hàng để xác nhận đơn có phụ phí.", 400, "validation_error");
    const parsedInput = CompleteSaleFinancialInputV1Schema.safeParse(input);
    if (!parsedInput.success) throw new ApiError("Đơn có phụ phí cần được xem lại bản tính trước khi đồng bộ.", 400, "validation_error");
    const captured = parsedInput.data;
    const selected = ReportScopeSchema.parse({ scopeKind: "report", merchantId: scope.merchantId, storeIds: [scope.storeId] });
    const response = await api.post<unknown>("/api/pos/carts/complete", input, input.idempotencyKey, {
      [PAYMENT_FEE_WRITE_HTTP_HEADER_V1]: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
      "x-operating-merchant-id": selected.merchantId, "x-operating-store-id": selected.storeIds[0]!,
    });
    const parsed = CheckoutPaymentFeeResponseV1Schema.safeParse(response);
    if (!parsed.success) throw new Error("Không xác minh được biên nhận có phụ phí. Kiểm tra đơn trước khi thử lại.");
    const data = parsed.data.data, returnedFee = data.financial.paymentFee;
    if (data.merchantId !== selected.merchantId || data.storeId !== selected.storeIds[0] || data.paymentMethod !== captured.paymentMethod
      || returnedFee.paymentFeeType !== captured.paymentFeeType || returnedFee.paymentFeeValue !== captured.paymentFeeValue
      || data.shippingFee !== (captured.shippingFee ?? 0) || data.items.length !== captured.items.length
      || data.items.some(item => !captured.items.some(source => source.variantId === item.variantId && source.quantity === item.quantity))
      || (captured.customerId && data.customerId !== captured.customerId)
      || (captured.customerMode === "walk_in" && data.customerId != null)
      || (captured.paymentMethod === "cash" && data.change !== Math.max(0, captured.amountReceived - data.total))) {
      throw new Error("Biên nhận không khớp đơn hoặc cửa hàng đã xác nhận. Kiểm tra đơn trước khi thử lại.");
    }
    return parsed.data;
  }
  return api.post<CompleteSaleResponse>("/api/pos/carts/complete", input, input.idempotencyKey, scope ? {
    "x-operating-merchant-id": scope.merchantId,
    "x-operating-store-id": scope.storeId,
  } : undefined);
}

export interface MoneyVnd {
  currencyCode: "vnd";
  amountVnd: string;
}

export function vnd(value: number | string): MoneyVnd {
  return { currencyCode: "vnd", amountVnd: String(Math.round(Number(value || 0))) };
}

export interface ShiftPolicyView {
  enabled: boolean;
  enforceShiftOnPos: boolean;
  allowOfflineCachedShift: boolean;
  blindCloseCash: boolean;
  requireHandoverAck: boolean;
  quickStockCountRequired: boolean;
  maxOpenDurationMinutes: number;
  staleAfterMinutes: number;
  cashDiscrepancyAlertThreshold: number;
  stockDiscrepancyAlertThreshold: number;
  checklist: string[];
}

export interface ShiftSummaryView {
  id: string;
  merchantId: string;
  storeId: string;
  stockLocationId: string;
  status: "open" | "closing" | "closed" | "force_closed" | "voided";
  reviewStatus: "not_required" | "pending" | "approved" | "flagged";
  zNumber: number | null;
  openedBy: string;
  openedAt: string;
  closedBy?: string | null;
  closedAt?: string | null;
  openingCashAmount: number;
  expectedCashAmount?: number | null;
  blindCashCountAmount?: number | null;
  cashVarianceAmount?: number | null;
  outgoingHandoverNote?: string | null;
}

export interface CurrentShiftResponse {
  data: ShiftSummaryView | null;
  policy: ShiftPolicyView;
  previousHandover?: {
    shift: ShiftSummaryView;
    acknowledged: boolean;
    acknowledgement?: Record<string, unknown> | null;
  } | null;
}

export interface ShiftReportResponse {
  data: {
    shift: ShiftSummaryView;
    orderIds: string[];
    paymentSummary: Record<string, { charges: number; refunds: number; net: number; count: number }>;
    outstandingObligations?: Array<{
      currencyCode: string;
      minorUnitExponent: number;
      remainingAmountMinor: number;
      obligationCount: number;
    }>;
    outstandingRefundPayables?: Array<{ currencyCode: string; minorUnitExponent: number; remainingAmountMinor: number; payableCount: number }>;
    reportAsOf?: string;
    postCloseFinancialAdjustments?: Array<Record<string, unknown>>;
    cashExpected: number | null;
    stockCounts: Array<Record<string, unknown>>;
    warnings: Array<{ code: string; message: string; severity: "info" | "warning" | "danger" }>;
    cash?: Record<string, unknown>;
    cashMovements?: Array<Record<string, unknown>>;
    productSold?: Array<Record<string, unknown>>;
  };
}

export async function fetchCurrentShift() {
  return api.get<CurrentShiftResponse>("/api/shifts/current");
}

export async function fetchShiftPolicy() {
  return api.get<{ data: ShiftPolicyView }>("/api/shifts/policy");
}

export async function startShift(input: { openingCashAmount: MoneyVnd; openingNote?: string; handoverAcknowledgementId?: string }) {
  return api.post<{ data: ShiftSummaryView }>("/api/shifts/start", input, idempotencyKey("shift-start"));
}

export async function receiveShiftHandover(input: { previousShiftId: string; acknowledgementNote?: string; receivedOpeningCashAmount?: MoneyVnd; acknowledgedItems?: string[] }) {
  return api.post<{ data: Record<string, unknown> }>("/api/shifts/handover-acknowledgements", input, idempotencyKey("shift-handover"));
}

export async function recordShiftCashMovement(input: { type: "pay_in" | "pay_out" | "cash_drop" | "cash_correction"; amount: MoneyVnd; reason: string; reasonCode?: string }) {
  return api.post<{ data: Record<string, unknown> }>("/api/shifts/current/cash-movements", input, idempotencyKey("shift-cash"));
}

export async function recordShiftStockCount(input: { countType?: "quick" | "close"; items: Array<{ inventoryItemId: string; countedQuantity: number; reason?: string }> }) {
  return api.post<{ data: Array<Record<string, unknown>> }>("/api/shifts/current/stock-counts", input, idempotencyKey("shift-stock-count"));
}

export async function previewCloseShift(input: { countedCashAmount?: MoneyVnd }) {
  return api.post<ShiftReportResponse>("/api/shifts/current/close-preview", input);
}

export async function closeShift(input: { countedCashAmount: MoneyVnd; discrepancyReason?: string; outgoingHandoverNote?: string; checklist?: Array<{ label: string; checked: boolean }> }) {
  return api.post<ShiftReportResponse>("/api/shifts/current/close", input, idempotencyKey("shift-close"));
}

export async function fetchShifts(filters: { status?: string; reviewStatus?: string; storeId?: string; limit?: number; offset?: number } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return api.get<{ data: ShiftSummaryView[]; count: number; limit: number; offset: number }>(`/api/shifts?${params.toString()}`);
}

export async function fetchMyShifts(filters: { status?: string; reviewStatus?: string; storeId?: string; limit?: number; offset?: number } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return api.get<{ data: ShiftSummaryView[]; count: number; limit: number; offset: number }>(`/api/shifts/mine?${params.toString()}`);
}

export async function fetchShiftReport(shiftId: string) {
  return api.get<ShiftReportResponse>(`/api/shifts/${encodeURIComponent(shiftId)}/report`);
}

export async function fetchMyShiftReport(shiftId: string) {
  return api.get<ShiftReportResponse>(`/api/shifts/mine/${encodeURIComponent(shiftId)}/report`);
}

export async function reviewShift(shiftId: string, input: { reviewStatus: "approved" | "flagged"; reason?: string }) {
  return api.post<{ data: ShiftSummaryView }>(`/api/shifts/${encodeURIComponent(shiftId)}/review`, input, idempotencyKey("shift-review"));
}

export async function forceCloseShift(shiftId: string, input: { reason: string; countedCashAmount?: MoneyVnd; outgoingHandoverNote?: string }) {
  return api.post<ShiftReportResponse>(`/api/shifts/${encodeURIComponent(shiftId)}/force-close`, input, idempotencyKey("shift-force-close"));
}

export interface PaymentIntentResponse {
  data: {
    id: string;
    provider: "mock" | "sepay_va" | "nowpayments";
    status: string;
    amount: number;
    currencyCode: string;
    referenceCode: string;
    paymentUrl?: string | null;
    qrPayload?: string | null;
    expiresAt: string;
    paidAt?: string | null;
    updatedAt?: string;
    createdAt?: string;
    completedOrderId?: string | null;
    manualReviewReason?: string | null;
    financial?: PaymentIntentFinancialViewV1["financial"];
  };
  order?: Record<string, unknown>;
}

export interface PaymentIntentListResponse {
  data: PaymentIntentResponse["data"][];
  count: number;
  limit: number;
  offset: number;
}

export async function createPaymentIntent(input: {
  provider: "mock" | "sepay_va" | "nowpayments";
  order: Omit<CompleteSaleInput, "idempotencyKey">;
  idempotencyKey: string;
}) {
  return api.post<PaymentIntentResponse>("/api/payment-intents", {
    provider: input.provider,
    order: input.order,
  }, input.idempotencyKey);
}

export async function fetchPaymentIntent(intentId: string) {
  return api.get<PaymentIntentResponse>(`/api/payment-intents/${encodeURIComponent(intentId)}`);
}

export async function fetchPaymentIntents(filters?: {
  status?: string;
  provider?: string;
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.provider) params.set("provider", filters.provider);
  if (filters?.limit) params.set("limit", String(filters.limit));
  if (filters?.offset) params.set("offset", String(filters.offset));
  return api.get<PaymentIntentListResponse>(`/api/payment-intents?${params.toString()}`);
}

export async function mockSettlePaymentIntent(intentId: string) {
  return api.post<PaymentIntentResponse>(`/api/payment-intents/${intentId}/mock-settle`, {}, idempotencyKey("payment-intent-settle"));
}

export async function cancelPaymentIntent(intentId: string) {
  return api.post<PaymentIntentResponse>(`/api/payment-intents/${intentId}/cancel`, {}, idempotencyKey("payment-intent-cancel"));
}

const paymentIntentFinancialHeadersV1 = { [PAYMENT_FEE_WRITE_HTTP_HEADER_V1]: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 };
export async function previewCartPaymentFeeV1(input: unknown, scope: { merchantId: string; storeId: string }, signal?: AbortSignal) {
  const captured = CartPaymentFeePreviewInputV1Schema.parse(input);
  const selected = ReportScopeSchema.parse({ scopeKind: "report", merchantId: scope.merchantId, storeIds: [scope.storeId] });
  const response = await api.post<unknown>("/api/pos/carts/preview", captured, undefined, {
    ...paymentIntentFinancialHeadersV1, "x-operating-merchant-id": selected.merchantId, "x-operating-store-id": selected.storeIds[0]!,
  }, signal);
  if (signal?.aborted) throw new Error("Phạm vi giỏ hàng đã thay đổi.");
  const parsed = CartPaymentFeePreviewV1Schema.safeParse(response);
  if (!parsed.success) throw new Error("Chưa xác minh được giá và phụ phí của giỏ hàng.");
  if (parsed.data.data.merchantId !== selected.merchantId || parsed.data.data.storeId !== selected.storeIds[0]
    || JSON.stringify(parsed.data.data.input) !== JSON.stringify(captured)) {
    throw new Error("Bản tính tiền không khớp giỏ hàng hoặc cửa hàng đã chọn.");
  }
  return parsed.data;
}

function bindPaymentIntentFinancialV1(body: unknown, scope: ReportScope, intentId?: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Phạm vi thanh toán đã thay đổi.");
  const parsed = PaymentIntentFinancialResponseV1Schema.safeParse(body);
  if (!parsed.success) throw new Error("Dữ liệu thanh toán không hợp lệ. Vui lòng tải lại.");
  if ((intentId !== undefined && parsed.data.data.id !== intentId) || parsed.data.data.merchantId !== scope.merchantId
    || !scope.storeIds.includes(parsed.data.data.storeId)) throw new Error("Thanh toán không khớp phạm vi đã chọn.");
  return parsed.data;
}

export async function fetchPaymentIntentFinancialV1(intentId: string, scope: ReportScope, signal?: AbortSignal) {
  const captured = ReportScopeSchema.parse(scope);
  if (!intentId.trim()) throw new Error("Thiếu mã thanh toán.");
  const response = await api.get<unknown>(`/api/payment-intents/${encodeURIComponent(intentId)}`, {
    ...paymentIntentFinancialHeadersV1, "x-report-merchant-id": captured.merchantId, "x-report-store-ids": captured.storeIds.join(","),
  }, signal);
  return bindPaymentIntentFinancialV1(response, captured, intentId, signal);
}

async function paymentIntentCreationReceiptRequestV1(path: "/api/payment-intents/creation-receipt" | "/api/payment-intents/creation-receipt/close", requestHash: string, idempotencyKey: string,
  scope: { merchantId: string; storeId: string }, signal?: AbortSignal) {
  const input = PaymentIntentCreationReceiptInputV1Schema.parse({ requestHash });
  const captured = ReportScopeSchema.parse({ scopeKind: "report", merchantId: scope.merchantId, storeIds: [scope.storeId] });
  if (!idempotencyKey.trim()) throw new Error("Thiếu mã yêu cầu thanh toán ban đầu.");
  const response = await api.post<unknown>(path, input, idempotencyKey, {
    ...paymentIntentFinancialHeadersV1, "x-operating-merchant-id": captured.merchantId, "x-operating-store-id": captured.storeIds[0]!,
  }, signal);
  if (signal?.aborted) throw new Error("Phạm vi thanh toán đã thay đổi.");
  const parsed = PaymentIntentCreationReceiptV1Schema.safeParse(response);
  if (!parsed.success || parsed.data.requestHash !== input.requestHash) throw new Error("Kết quả tra cứu không khớp yêu cầu thanh toán.");
  if (parsed.data.data.status === "resolved") bindPaymentIntentFinancialV1({ schemaVersion: 1,
    contractVersion: parsed.data.contractVersion, data: parsed.data.data.intent }, captured, undefined, signal);
  return parsed.data;
}

export function fetchPaymentIntentCreationReceiptV1(requestHash: string, idempotencyKey: string,
  scope: { merchantId: string; storeId: string }, signal?: AbortSignal) {
  return paymentIntentCreationReceiptRequestV1("/api/payment-intents/creation-receipt", requestHash, idempotencyKey, scope, signal);
}
export function closePaymentIntentCreationReceiptV1(requestHash: string, idempotencyKey: string,
  scope: { merchantId: string; storeId: string }, signal?: AbortSignal) {
  return paymentIntentCreationReceiptRequestV1("/api/payment-intents/creation-receipt/close", requestHash, idempotencyKey, scope, signal);
}

export async function fetchPaymentIntentsFinancialV1(filters: PaymentIntentFinancialListFiltersV1, scope: ReportScope, signal?: AbortSignal) {
  const captured = ReportScopeSchema.parse(scope), selection = PaymentIntentFinancialListFiltersV1Schema.parse(filters);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(selection)) if (value !== undefined) params.set(key, String(value));
  const response = await api.get<unknown>(`/api/payment-intents?${params.toString()}`, {
    ...paymentIntentFinancialHeadersV1, "x-report-merchant-id": captured.merchantId, "x-report-store-ids": captured.storeIds.join(","),
  }, signal);
  if (signal?.aborted) throw new Error("Phạm vi thanh toán đã thay đổi.");
  const parsed = PaymentIntentFinancialListResponseV1Schema.safeParse(response);
  if (!parsed.success) throw new Error("Dữ liệu thanh toán không hợp lệ. Vui lòng tải lại.");
  if (parsed.data.limit !== (selection.limit ?? 25) || parsed.data.offset !== (selection.offset ?? 0)
    || parsed.data.data.some(intent => intent.merchantId !== captured.merchantId || !captured.storeIds.includes(intent.storeId)
      || (selection.status && selection.status !== "all" && intent.status !== selection.status)
      || (selection.provider && selection.provider !== "all" && intent.provider !== selection.provider))) {
    throw new Error("Thanh toán không khớp phạm vi đã chọn.");
  }
  return parsed.data;
}

export async function createPaymentIntentFinancialV1(input: Parameters<typeof createPaymentIntent>[0], scope: { merchantId: string; storeId: string }, signal?: AbortSignal) {
  const captured = ReportScopeSchema.parse({ scopeKind: "report", merchantId: scope.merchantId, storeIds: [scope.storeId] });
  const provider = input.provider;
  const fee = CreatePaymentIntentFinancialInputV1Schema.parse({ provider, order: input.order }).order;
  if (!input.idempotencyKey.trim()) throw new Error("Thiếu dữ liệu phí hoặc mã xác nhận thanh toán.");
  const response = await api.post<unknown>("/api/payment-intents", { provider, order: input.order }, input.idempotencyKey, {
    ...paymentIntentFinancialHeadersV1, "x-operating-merchant-id": captured.merchantId, "x-operating-store-id": captured.storeIds[0]!,
  }, signal);
  const result = bindPaymentIntentFinancialV1(response, captured, undefined, signal);
  if (result.data.financial.status !== "available") throw new Error("Chưa xác minh được số tiền thanh toán. Vui lòng kiểm tra lại.");
  const returnedFee = result.data.financial.snapshot.paymentFee;
  if (result.data.provider !== provider || returnedFee.paymentFeeType !== fee.paymentFeeType || returnedFee.paymentFeeValue !== fee.paymentFeeValue
    || result.data.financial.snapshot.components.shippingMinor !== (fee.shippingFee ?? 0)) {
    throw new Error("Thanh toán không khớp phí hoặc phương thức đã chọn.");
  }
  return result;
}

export async function resolvePaymentIntentFinancialV1(intentId: string, action: "cancel" | "mock-settle", idempotencyKey: string, scope: { merchantId: string; storeId: string }, signal?: AbortSignal) {
  const captured = ReportScopeSchema.parse({ scopeKind: "report", merchantId: scope.merchantId, storeIds: [scope.storeId] });
  if (!intentId.trim() || !idempotencyKey.trim() || !["cancel", "mock-settle"].includes(action)) throw new Error("Thiếu mã xác nhận thanh toán.");
  const response = await api.post<unknown>(`/api/payment-intents/${encodeURIComponent(intentId)}/${action}`, {}, idempotencyKey, {
    ...paymentIntentFinancialHeadersV1, "x-operating-merchant-id": captured.merchantId, "x-operating-store-id": captured.storeIds[0]!,
  }, signal);
  return bindPaymentIntentFinancialV1(response, captured, intentId, signal);
}

export interface CrossSellRecommendation {
  productId: string;
  variantId: string;
  sku: string;
  name: string;
  price: number;
  stock: number;
  score: number;
  reason: string;
}

export async function fetchCrossSellRecommendations(input: {
  items: Array<{ variantId: string; quantity: number }>;
  customerId?: string;
  limit?: number;
}) {
  return api.post<{ data: CrossSellRecommendation[] }>("/api/recommendations/cross-sell", input);
}

export async function recordCrossSellAcceptance(input: {
  acceptedVariantId: string;
  acceptedProductId?: string;
  cartVariantIds?: string[];
  customerId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}) {
  return api.post<{ data: { recorded: boolean; id?: string; createdAt?: string; reason?: string } }>(
    "/api/recommendations/cross-sell/accept",
    input,
    idempotencyKey("cross-sell-accept"),
  );
}

export async function fetchCustomers(query?: string) {
  const params = query ? `?q=${encodeURIComponent(query)}` : "";
  const res = await api.get<{ customers: CustomerItem[] }>(
    `/api/platform/admin/customers${params}`,
  );
  return res.customers || [];
}

export async function fetchCustomer(id: string) {
  return api.get<{ customer: CustomerItem }>(`/api/platform/admin/customers/${encodeURIComponent(id)}`);
}

export async function createCustomer(data: { phone: string; first_name: string; last_name: string; email?: string }) {
  return api.post<{ customer: CustomerItem }>("/api/platform/admin/customers", data, idempotencyKey("customer"));
}

export async function updateCustomer(id: string, data: { phone?: string; first_name?: string; last_name?: string; email?: string }) {
  return api.patch<{ customer: CustomerItem }>(`/api/platform/admin/customers/${encodeURIComponent(id)}`, data, idempotencyKey("customer-update"));
}

export async function deleteCustomer(id: string) {
  return api.delete<{ deleted: boolean; id: string }>(`/api/platform/admin/customers/${encodeURIComponent(id)}`, idempotencyKey("customer-delete"));
}

export interface OrderListResult {
  orders: OrderListItem[];
  /** True order count over the full filtered set (not capped by the page limit). */
  totalCount: number;
  /** Count of completed orders over the full filtered set. */
  completedCount: number;
  /** Sum of order totals over the full filtered set, in VND. */
  totalRevenue: number;
}

export async function fetchOrders(filters?: { dateFrom?: string; dateTo?: string; customerId?: string; limit?: number }): Promise<OrderListResult> {
  const params = new URLSearchParams();
  if (filters?.limit) params.set("limit", String(filters.limit));
  if (filters?.customerId) params.set("customer_id", filters.customerId);
  if (filters?.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters?.dateTo) params.set("dateTo", filters.dateTo);
  const res = await api.get<{
    orders: OrderListItem[];
    totalCount?: number;
    completedCount?: number;
    totalRevenue?: number;
  }>(
    `/api/platform/admin/orders?${params.toString()}`,
  );
  const orders = res.orders || [];
  return {
    orders,
    totalCount: Number(res.totalCount ?? orders.length),
    completedCount: Number(res.completedCount ?? 0),
    totalRevenue: Number(res.totalRevenue ?? 0),
  };
}

export async function fetchEffectiveOrderFeaturePage(input: {
  from: string;
  to: string;
  search?: string;
  status: "all" | "completed" | "other";
  creatorOperatorIds?: readonly string[];
  limit?: number;
  cursor?: string;
}): Promise<EffectiveOrderPageV4> {
  const params = new URLSearchParams({
    from: input.from,
    to: input.to,
    status: input.status,
  });
  if (input.search?.trim()) params.set("search", input.search.trim());
  if (input.limit) params.set("limit", String(input.limit));
  if (input.cursor) params.set("cursor", input.cursor);
  for (const creatorOperatorId of input.creatorOperatorIds || []) {
    if (creatorOperatorId.trim()) params.append("creatorOperatorId", creatorOperatorId.trim());
  }
  const response = await api.get<unknown>(
    `/api/platform/admin/orders/effective-v4?${params.toString()}`,
  );
  return EffectiveOrderPageV4Schema.parse(response);
}

export type OrderCreatorOption = {
  operatorId: string;
  displayName: string;
  status: "active" | "historical";
};

export async function fetchEffectiveOrderFeaturePageV5(input: Parameters<typeof fetchEffectiveOrderFeaturePage>[0], scopeInput: ReportScope,
  signal?: AbortSignal): Promise<EffectiveOrderPageV5> {
  const scope = ReportScopeSchema.parse(scopeInput), rawCreators = input.creatorOperatorIds ?? [];
  if (!["all", "completed", "other"].includes(input.status)
    || rawCreators.some((id) => typeof id !== "string" || !id.trim())) throw new Error("Bộ lọc đơn hàng không hợp lệ.");
  const selection = CreatorSelectionV1Schema.parse(rawCreators.length
    ? { mode: "selected", creatorOperatorIds: [...new Set(rawCreators.map((id) => id.trim()))].sort() }
    : { mode: "all", creatorOperatorIds: [] });
  const params = new URLSearchParams({ from: input.from, to: input.to, status: input.status });
  if (input.search?.trim()) params.set("search", input.search.trim());
  if (input.limit) params.set("limit", String(input.limit));
  if (input.cursor) params.set("cursor", input.cursor);
  for (const id of selection.creatorOperatorIds) params.append("creatorOperatorId", id);
  const page = EffectiveOrderPageV5Schema.parse(await api.get<unknown>(`/api/platform/admin/orders/effective-v5?${params}`, {
    "x-report-merchant-id": scope.merchantId, "x-report-store-ids": scope.storeIds.join(","),
  }, signal));
  if (JSON.stringify(page.creatorSelection) !== JSON.stringify(selection)
    || (input.limit !== undefined && page.pagination.limit !== input.limit)
    || page.data.some((row) => row.sourceOrder.merchantId !== scope.merchantId || !scope.storeIds.includes(row.sourceOrder.storeId))) {
    throw new Error("Kết quả đơn hàng không khớp bộ lọc hoặc phạm vi đã yêu cầu.");
  }
  return page;
}

export async function fetchOrderCreatorOptions(scopeInput?: ReportScope, signal?: AbortSignal): Promise<OrderCreatorOption[]> {
  const scope = scopeInput ? ReportScopeSchema.parse(scopeInput) : null;
  const response = scope ? await api.get<unknown>("/api/platform/admin/orders/creators", {
    "x-report-merchant-id": scope.merchantId, "x-report-store-ids": scope.storeIds.join(","),
  }, signal) : await api.get<unknown>("/api/platform/admin/orders/creators");
  if (!response || typeof response !== "object" || !Array.isArray((response as { creatorOptions?: unknown }).creatorOptions)) {
    throw new Error("Creator options response is invalid");
  }
  return (response as { creatorOptions: unknown[] }).creatorOptions.map((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new Error("Creator option is invalid");
    const option = candidate as Record<string, unknown>;
    if (
      typeof option.operatorId !== "string" || !option.operatorId
      || typeof option.displayName !== "string" || !option.displayName
      || (option.status !== "active" && option.status !== "historical")
    ) throw new Error("Creator option is invalid");
    return {
      operatorId: option.operatorId,
      displayName: option.displayName,
      status: option.status,
    };
  });
}

export async function fetchOrderDetail(id: string) {
  const res = await api.get<{ order: Record<string, unknown> }>(`/api/platform/admin/orders/${id}`);
  return res.order;
}

export async function fetchOrderOperationalDetailV1(id: string, scope: { merchantId: string; storeIds: string[] }, signal?: AbortSignal) {
  if (!id.trim() || !scope.merchantId.trim() || !scope.storeIds.length || scope.storeIds.some(store => !store.trim())) {
    throw new Error("Thiếu đơn hàng hoặc phạm vi cửa hàng.");
  }
  const response = await api.get<{ order: unknown }>(`/api/platform/admin/orders/${encodeURIComponent(id)}/operational-v1`, {
    "x-report-merchant-id": scope.merchantId, "x-report-store-ids": scope.storeIds.join(","),
  }, signal);
  const order = OrderOperationalDetailV1Schema.parse(response.order);
  if (order.id !== id || order.merchantId !== scope.merchantId || !scope.storeIds.includes(order.storeId)) {
    throw new Error("Thông tin vận hành đơn không khớp phạm vi yêu cầu.");
  }
  return order;
}

export interface ManualBankConfirmationInputV1 {
  sourceReference: string;
  confirmedAt: string;
}

export interface ManualBankConfirmationResponseV1 {
  data: {
    orderId: string;
    status: "posted";
    method: "manual_bank";
    outcome: "inserted" | "replayed";
    paymentEventId: string;
    priorPendingPaymentEventId: string;
    amountMinor: number;
    currencyCode: string;
    minorUnitExponent: number;
    sourceReference: string;
    confirmedAt: string;
  };
}

export async function confirmManualBankPayment(
  orderId: string,
  input: ManualBankConfirmationInputV1,
  intentKey: string,
) {
  return api.post<ManualBankConfirmationResponseV1>(
    `/api/platform/admin/orders/${encodeURIComponent(orderId)}/manual-bank-confirmation`,
    input,
    intentKey,
  );
}

export async function fetchEffectiveOrderFeatureDetail(id: string): Promise<EffectiveOrderSurfaceV2> {
  const response = await api.get<{ order: unknown }>(
    `/api/platform/admin/orders/${encodeURIComponent(id)}/effective`,
  );
  return EffectiveOrderSurfaceV2Schema.parse(response.order);
}

export async function fetchEffectiveOrderFeatureDetailV3(id: string): Promise<EffectiveOrderSurfaceV3> {
  const response = await api.get<{ order: unknown }>(`/api/platform/admin/orders/${encodeURIComponent(id)}/effective-v3`);
  const order = EffectiveOrderSurfaceV3Schema.parse(response.order);
  if (order.orderId !== id || order.surfaceKind !== "detail") throw new Error("Chi tiết đơn trả về không khớp yêu cầu.");
  return order;
}

export async function updateOrderCustomer(orderId: string, customerId: string | null) {
  return api.patch<{
    order: OrderListItem | null;
  }>(`/api/platform/admin/orders/${orderId}`, { customerId }, idempotencyKey("order-customer"));
}

export async function updateOrder(orderId: string, input: { customerId?: string | null; notes?: string | null; salesChannel?: string | null }) {
  return api.patch<{
    order: OrderListItem | null;
  }>(`/api/platform/admin/orders/${orderId}`, input, idempotencyKey("order-update"));
}

export interface OrderShippingAdjustmentInput {
  shippingFee: number;
  reason: string;
  paymentMethod?: string;
  amountReceived?: number;
}

export interface OrderShippingPreview {
  data: {
    orderId: string;
    baseRevision: number;
    before: { shippingFee: number; shippingTax: number; shippingRevenue: number; total: number };
    after: { shippingFee: number; shippingTax: number; shippingRevenue: number; total: number };
    shippingFeeDelta: number;
    totalDelta: number;
    settlement: {
      direction: "collect" | "refund" | "none";
      method: string;
      amount: number;
      amountReceived: number;
      change: number;
    };
    effects: {
      orderTotals: "update" | "none";
      paymentEntry: "charge" | "refund" | "none";
      auditEvent: "append" | "none";
      outboxEvent: "append" | "none";
      accountingJournal: "after_outbox_processing" | "none";
      inventory: "none";
    };
    confirmationToken: string;
  };
}

export async function previewOrderShipping(orderId: string, input: OrderShippingAdjustmentInput) {
  return api.post<OrderShippingPreview>(
    `/api/platform/admin/orders/${encodeURIComponent(orderId)}/shipping/preview`,
    input,
  );
}

export async function updateOrderShipping(
  orderId: string,
  input: OrderShippingAdjustmentInput & { confirmationToken: string },
) {
  return api.patch<{
    order: OrderListItem | null;
  }>(
    `/api/platform/admin/orders/${encodeURIComponent(orderId)}/shipping`,
    input,
    `order-shipping:${input.confirmationToken}`,
  );
}

export interface TelegramSalesDraft {
  id: string;
  merchantId: string;
  storeId: string;
  profileId: string;
  telegramUserId: string;
  telegramChatId?: string | null;
  telegramUsername?: string | null;
  language: "en" | "ru" | string;
  status: "pending" | "needs_review" | "converted" | "rejected" | "expired" | "cancelled" | string;
  items: Array<{ variantId?: string; quantity?: number }>;
  quote: {
    total?: number;
    subtotal?: number;
    shippingFee?: number;
    tax?: number;
    paymentMethod?: string;
    items?: Array<{
      productId?: string;
      variantId?: string;
      sku?: string;
      title?: string;
      quantity?: number;
      unitPrice?: number;
      lineTotal?: number;
      availability?: string;
      canFulfill?: boolean;
    }>;
    warnings?: Array<{ code?: string; variantId?: string; title?: string }>;
  };
  delivery: { address?: string | null; note?: string | null; zone?: string | null; eta?: string | null };
  customerMessage?: string | null;
  operatorNotes?: string | null;
  aiMetadata?: Record<string, unknown>;
  convertedOrderId?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  expiresAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface TelegramSalesDraftListResponse {
  data: TelegramSalesDraft[];
  count: number;
  limit: number;
  offset: number;
}

export async function fetchTelegramSalesDrafts(filters?: { status?: string; q?: string; limit?: number; offset?: number }) {
  const params = new URLSearchParams();
  params.set("limit", String(filters?.limit || 50));
  if (filters?.offset) params.set("offset", String(filters.offset));
  if (filters?.status) params.set("status", filters.status);
  if (filters?.q) params.set("q", filters.q);
  return api.get<TelegramSalesDraftListResponse>(`/api/platform/admin/telegram-sales/drafts?${params.toString()}`);
}

export async function confirmTelegramSalesDraft(id: string, input: { shippingFee?: number; operatorNotes?: string }) {
  return api.post<{ data: { draft: TelegramSalesDraft; order?: Record<string, unknown>; alreadyConverted?: boolean } }>(
    `/api/platform/admin/telegram-sales/drafts/${encodeURIComponent(id)}/confirm`,
    input,
    idempotencyKey("telegram-sales-confirm"),
  );
}

export async function checkoutTelegramSalesDraft(id: string, input: CompleteSaleInput & { operatorNotes?: string }) {
  return api.post<{ data: { draft: TelegramSalesDraft; order?: Record<string, unknown>; alreadyConverted?: boolean } }>(
    `/api/platform/admin/telegram-sales/drafts/${encodeURIComponent(id)}/checkout`,
    input,
    input.idempotencyKey,
  );
}

export async function rejectTelegramSalesDraft(id: string, reason: string) {
  return api.post<{ data: TelegramSalesDraft }>(
    `/api/platform/admin/telegram-sales/drafts/${encodeURIComponent(id)}/reject`,
    { reason },
    idempotencyKey("telegram-sales-reject"),
  );
}

export interface OrderCorrectionInput extends Partial<PaymentFeeInputV1> {
  baseRevision: number;
  confirmationToken?: string;
  reason: string;
  items: Array<{ variantId: string; quantity: number }>;
  shippingFee?: number;
  settlement?: { method?: string; amountReceived?: number };
}

export interface OrderCorrectionPreview {
  data: {
    orderId: string;
    baseRevision: number;
    nextRevision: number;
    beforeTotals: { total: number };
    afterTotals: { total: number };
    totalDelta: number;
    cogsDelta: number;
    settlement: { direction: "collect" | "refund" | "none"; method: string; amount: number; status: string };
    items: Array<{
      variantId: string;
      productId: string;
      productTitle: string;
      sku: string;
      quantityBefore: number;
      quantityAfter: number;
      quantityDelta: number;
      unitPrice: number;
      stockDelta: number;
      availableStock: number;
    }>;
  };
}

export async function previewOrderCorrection(orderId: string, input: OrderCorrectionInput) {
  return api.post<OrderCorrectionPreview>(`/api/platform/admin/orders/${orderId}/corrections/preview`, input, idempotencyKey("order-correction-preview"));
}

export async function applyOrderCorrection(orderId: string, input: OrderCorrectionInput) {
  return api.post<{ data: { correction: { id: string; revision: number; totalDelta: number; paymentEntryId?: string | null } } }>(
    `/api/platform/admin/orders/${orderId}/corrections`,
    input,
    idempotencyKey("order-correction"),
  );
}

function correctionFinancialScope(scope: { merchantId: string; storeId: string }) {
  const selected = ReportScopeSchema.parse({ scopeKind: "report", merchantId: scope.merchantId, storeIds: [scope.storeId] });
  return { merchantId: selected.merchantId, storeId: selected.storeIds[0]!, headers: {
    [PAYMENT_FEE_WRITE_HTTP_HEADER_V1]: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
    "x-operating-merchant-id": selected.merchantId, "x-operating-store-id": selected.storeIds[0]!,
  } };
}
function assertCorrectionSource(data: { orderId: string; merchantId: string; storeId: string }, orderId: string,
  scope: { merchantId: string; storeId: string }, signal?: AbortSignal) {
  if (signal?.aborted || data.orderId !== orderId || data.merchantId !== scope.merchantId || data.storeId !== scope.storeId) {
    throw new Error("Điều chỉnh đơn không khớp đơn hoặc cửa hàng đã chọn.");
  }
}
function assertCorrectionPreviewCommand(data: OrderCorrectionFinancialPreviewV1["data"], input: OrderCorrectionFinancialInputV1) {
  const lines = data.items.filter(line => line.quantityAfter > 0), after = data.afterFinancial;
  if (data.baseRevision !== input.baseRevision || lines.length !== input.items.length
    || lines.some(line => !input.items.some(item => item.variantId === line.variantId && item.quantity === line.quantityAfter))
    || (data.totalDelta !== 0 && input.settlement?.method && data.settlement.method !== input.settlement.method)
    || (input.paymentFeeType !== undefined && (after.status !== "available" || after.snapshot.paymentFee.paymentFeeType !== input.paymentFeeType
      || after.snapshot.paymentFee.paymentFeeValue !== input.paymentFeeValue))
    || (input.shippingFee !== undefined && after.status === "available" && after.snapshot.components.shippingMinor !== input.shippingFee)) {
    throw new Error("Bản tính điều chỉnh không khớp nội dung đã nhập.");
  }
}
export async function fetchOrderCorrectionFinancialContextV1(orderId: string, scope: { merchantId: string; storeId: string }, signal?: AbortSignal) {
  if (!orderId.trim()) throw new Error("Thiếu đơn cần điều chỉnh.");
  const captured = correctionFinancialScope(scope);
  const raw = await api.get<unknown>(`/api/platform/admin/orders/${encodeURIComponent(orderId)}/corrections/preview`, captured.headers, signal);
  const result = OrderCorrectionFinancialContextV1Schema.parse(raw);
  assertCorrectionSource(result.data, orderId, captured, signal);
  return result;
}
export async function previewOrderCorrectionFinancialV1(orderId: string, input: OrderCorrectionInput, scope: { merchantId: string; storeId: string }, signal?: AbortSignal) {
  if (!orderId.trim()) throw new Error("Thiếu đơn cần điều chỉnh.");
  const captured = correctionFinancialScope(scope), request = OrderCorrectionFinancialInputV1Schema.parse(input);
  const raw = await api.post<unknown>(`/api/platform/admin/orders/${encodeURIComponent(orderId)}/corrections/preview`, input, undefined, captured.headers, signal);
  const result = OrderCorrectionFinancialPreviewV1Schema.parse(raw);
  assertCorrectionSource(result.data, orderId, captured, signal); assertCorrectionPreviewCommand(result.data, request);
  return result;
}
export async function applyOrderCorrectionFinancialV1(orderId: string, input: OrderCorrectionInput, intentKey: string,
  scope: { merchantId: string; storeId: string }, confirmation: unknown, signal?: AbortSignal) {
  if (!orderId.trim() || !intentKey.trim()) throw new Error("Thiếu mã xác nhận điều chỉnh.");
  const captured = correctionFinancialScope(scope), request = OrderCorrectionFinancialInputV1Schema.parse(input);
  const confirmed = OrderCorrectionFinancialPreviewV1Schema.parse(confirmation).data;
  assertCorrectionSource(confirmed, orderId, captured, signal); assertCorrectionPreviewCommand(confirmed, request);
  if (!request.confirmationToken || request.confirmationToken !== confirmed.confirmationToken
    || (request.settlement?.amountReceived ?? 0) !== Math.abs(confirmed.totalDelta)) throw new Error("Hãy xác nhận lại bản tính điều chỉnh hiện tại.");
  const raw = await api.post<unknown>(`/api/platform/admin/orders/${encodeURIComponent(orderId)}/corrections`, input, intentKey, captured.headers, signal);
  const result = OrderCorrectionFinancialResponseV1Schema.parse(raw);
  assertCorrectionSource(result.data, orderId, captured, signal);
  const value = result.data.correction;
  if (value.revision !== request.baseRevision + 1 || value.reason !== request.reason || value.totalDelta !== confirmed.totalDelta
    || value.beforeTotals.total !== confirmed.beforeTotals.total || value.afterTotals.total !== confirmed.afterTotals.total
    || JSON.stringify(value.beforeFinancial) !== JSON.stringify(confirmed.beforeFinancial) || JSON.stringify(value.afterFinancial) !== JSON.stringify(confirmed.afterFinancial)
    || value.settlementStatus !== confirmed.settlement.status) throw new Error("Kết quả điều chỉnh không khớp bản tính đã xác nhận. Kiểm tra đơn trước khi thử lại.");
  return result;
}

export async function fetchInventory() {
  const res = await api.get<{ inventory_items: InventoryItem[] }>(
    "/api/platform/admin/inventory-items?limit=100",
  );
  return res.inventory_items || [];
}

export async function adjustStock(data: { inventoryItemId: string; locationId?: string; adjustment: number; reason: string; movementType?: string }) {
  return api.post("/api/inventory/adjust", data, idempotencyKey("stock"));
}

function stockMovementParams(filtersOrProductId?: string | StockMovementFilters): string {
  const params = new URLSearchParams();
  const filters: StockMovementFilters = typeof filtersOrProductId === "string"
    ? { productId: filtersOrProductId }
    : filtersOrProductId || {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export async function fetchStockMovements(filtersOrProductId?: string | StockMovementFilters) {
  const query = stockMovementParams(filtersOrProductId);
  return api.get<StockMovementsResponse>(`/api/inventory/movements${query ? `?${query}` : ""}`);
}

export async function downloadStockMovementHistoryCsv(filters: StockMovementFilters = {}): Promise<void> {
  const query = stockMovementParams(filters);
  const response = await api.rawGet(`${STOCK_MOVEMENT_HISTORY_DOWNLOAD.path}${query ? `?${query}` : ""}`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = responseFilename(response, STOCK_MOVEMENT_HISTORY_DOWNLOAD.filename);
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

export async function createPurchaseOrder(
  data: { supplierName: string; items: Array<{ variantId: string; quantity: number; unitCost: number; unitCostQuality: "known" | "free" }>; expectedDate?: string },
  intentKey: string,
) {
  return api.post("/api/inventory/purchase-orders", data, intentKey);
}

export async function fetchPurchaseOrders() {
  return api.get<{ data: PurchaseOrderListItem[] }>("/api/inventory/purchase-orders");
}

export interface PurchaseOrderListItem {
  id: string;
  supplierName: string;
  status: string;
  expectedDate?: string | null;
  createdAt: string;
  updatedAt?: string;
  sentAt?: string | null;
  cancelledAt?: string | null;
  closedAt?: string | null;
  lineCount?: number;
  orderedQuantity?: number;
  receivedQuantity?: number;
  remainingQuantity?: number;
  totalCost?: number | null;
  totalCostAvailable?: boolean;
  items: Array<{
    id: string;
    variantId: string;
    quantity: number;
    unitCost: number;
    unitCostQuality?: "known" | "free" | "unknown";
    receivedQuantity: number;
    sku?: string;
    productName?: string;
    categoryNames?: string[];
  }>;
}

export interface PurchaseOrderCatalogItem {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  sku: string;
  barcode: string;
  categoryNames: string[];
  defaultUnitCost: number | null;
  defaultUnitCostQuality: "known" | "unknown";
  selected: boolean;
}

export async function fetchPurchaseOrderCatalog(filters: {
  q?: string;
  limit?: number;
  offset?: number;
  selectedVariantIds?: string[];
} = {}) {
  const params = new URLSearchParams();
  if (filters.q?.trim()) params.set("q", filters.q.trim());
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.offset) params.set("offset", String(filters.offset));
  if (filters.selectedVariantIds?.length) {
    params.set("selectedVariantIds", filters.selectedVariantIds.join(","));
  }
  return api.get<{
    data: PurchaseOrderCatalogItem[];
    page: { total: number; limit: number; offset: number; hasPrevious: boolean; hasNext: boolean };
  }>(`/api/inventory/purchase-orders/catalog?${params.toString()}`);
}

export interface PurchaseOrderDetail extends PurchaseOrderListItem {
  createdBy?: string;
  sentBy?: string | null;
  cancelledBy?: string | null;
  cancelReason?: string | null;
  closedBy?: string | null;
  closeReason?: string | null;
  source?: string;
  totals: {
    lineCount: number;
    orderedQuantity: number;
    receivedQuantity: number;
    remainingQuantity: number;
    orderedValue: number | null;
    receivedValue: number | null;
    valueAvailable: boolean;
    unknownCostLineCount: number;
  };
  items: Array<{
    id: string;
    variantId: string;
    inventoryItemId: string;
    sku: string;
    productName: string;
    categoryNames: string[];
    quantity: number;
    unitCost: number;
    unitCostQuality: "known" | "free" | "unknown";
    receivedQuantity: number;
    remainingQuantity: number;
    lineStatus: string;
    currentStock: number;
    lastReceivedAt?: string | null;
  }>;
  receipts: Array<{
    id: string;
    receivedAt: string;
    receivedBy: string;
    note?: string | null;
    totalQuantity: number;
    inventoryValue: number | null;
    valueAvailable: boolean;
    unknownCostLineCount: number;
    items: Array<{
      purchaseOrderItemId: string;
      sku: string;
      productName: string;
      quantityReceived: number;
      unitCost: number;
      unitCostQuality: "known" | "free" | "unknown";
      inventoryValue: number;
      quantityAfter: number;
    }>;
  }>;
  receiptPage: {
    total: number;
    limit: number;
    offset: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
}

export interface ReceivePurchaseOrderResponse {
  data: PurchaseOrderDetail & {
    purchaseOrder?: PurchaseOrderDetail;
    receipt?: {
      id: string;
      inventoryValue?: number;
      items?: Array<{ purchaseOrderItemId: string; quantityReceived: number; variantId: string }>;
    };
  };
}

export async function fetchPurchaseOrderDetail(
  poId: string,
  filters: { receiptLimit?: number; receiptOffset?: number } = {},
) {
  const params = new URLSearchParams();
  if (filters.receiptLimit) params.set("receiptLimit", String(filters.receiptLimit));
  if (filters.receiptOffset) params.set("receiptOffset", String(filters.receiptOffset));
  const suffix = params.size ? `?${params.toString()}` : "";
  return api.get<{ data: PurchaseOrderDetail }>(`/api/inventory/purchase-orders/${encodeURIComponent(poId)}${suffix}`);
}

export async function receivePurchaseOrder(
  poId: string,
  data: { note?: string; items: Array<{ purchaseOrderItemId: string; receivedQuantity: number }> },
  intentKey: string,
) {
  return api.post<ReceivePurchaseOrderResponse>(
    `/api/inventory/purchase-orders/${poId}/receive`,
    data,
    intentKey,
  );
}

export async function sendPurchaseOrder(poId: string, data: { note?: string }) {
  return api.post(`/api/inventory/purchase-orders/${encodeURIComponent(poId)}/send`, data, idempotencyKey("po-send"));
}

export async function cancelPurchaseOrder(poId: string, data: { reason: string }) {
  return api.post(`/api/inventory/purchase-orders/${encodeURIComponent(poId)}/cancel`, data, idempotencyKey("po-cancel"));
}

export async function closeShortPurchaseOrder(poId: string, data: { reason: string }) {
  return api.post(`/api/inventory/purchase-orders/${encodeURIComponent(poId)}/close-short`, data, idempotencyKey("po-close-short"));
}

export async function fetchLoyaltyTiers() {
  return api.get<{ data: Array<{ name: string; pointsThreshold: number; discountPercent: number }> }>("/api/loyalty/tiers");
}

export async function fetchCustomerLoyalty(customerId: string) {
  return api.get<{ data: { points: number; tier: string; nextTierPoints: number | null; history: unknown[] } }>(`/api/customers/${customerId}/loyalty`);
}

export async function mergeCustomers(primaryId: string, duplicateId: string) {
  return api.post("/api/customers/merge", { primaryId, duplicateId }, idempotencyKey("merge-customers"));
}

export async function fetchAiReviewQueue() {
  return api.get<{ data: Array<{ id: string; actionType: string; status: string; outputPayload: Record<string, unknown>; confidence: number; riskLevel: string; createdAt: string }> }>("/ai/review-queue");
}

export async function approveAiAction(actionId: string, approvedText?: string) {
  return api.post(`/ai/actions/${actionId}/approve`, { approvedText }, idempotencyKey("ai-approve"));
}

export async function rejectAiAction(actionId: string, reason: string) {
  return api.post(`/ai/actions/${actionId}/reject`, { reason }, idempotencyKey("ai-reject"));
}

export async function fetchAiAlerts() {
  return api.get<{ data: unknown[] }>("/ai/alerts");
}

export async function acknowledgeAiAlert(alertId: string) {
  return api.post(`/ai/alerts/${alertId}/acknowledge`, {}, idempotencyKey("ai-alert"));
}

export async function fetchAiRecommendations(customerId: string) {
  return api.get<{ data: unknown[] }>(`/ai/recommendations/${customerId}`);
}

export interface DashboardSummary {
  from: string;
  to: string;
  orderCount: number;
  totalRevenue: number;
  merchandiseRevenue: number;
  merchandiseRevenueExVat?: number;
  shippingRevenue: number;
  shippingOrderCount: number;
  averageShippingFee: number;
  shippingSharePercent: number;
  discountTotal: number;
  taxTotal: number;
  customersToday: number | null;
  newCustomers: number | null;
  products: number;
  lowStock: number;
  canceledOrders: number;
  itemQuantity: number;
  averageOrderValue: number;
  cogs: number | null;
  grossProfit: number | null;
  grossMarginPercent: number | null;
  daily: Array<{ date: string; orders: number; revenue: number; shippingRevenue?: number }>;
  topProducts: Array<{ productId: string; name: string; quantity: number; revenue: number }>;
  paymentMix: Array<{ method: string; orders: number; revenue: number }>;
}

export async function fetchDashboard(filters: { date?: string; from?: string; to?: string }) {
  const params = new URLSearchParams();
  if (filters.date) params.set("date", filters.date);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return api.get<{ data: DashboardSummary }>(`/api/platform/admin/dashboard?${params.toString()}`);
}

export async function fetchPartialFinancialFeatureDashboard(
  request: Parameters<typeof partialFinancialDashboardPathV1>[0],
): Promise<DashboardPartialFinancialRuntimeHttpBodyV1> {
  return api.get<DashboardPartialFinancialRuntimeHttpBodyV1>(
    partialFinancialDashboardPathV1(request),
  );
}

export async function fetchCreatorSalesDashboardV2(input: {
  from: string;
  to: string;
  creatorOperatorIds?: readonly string[];
}): Promise<CreatorSalesDashboardV2> {
  const params = new URLSearchParams({ from: input.from, to: input.to });
  for (const creatorOperatorId of input.creatorOperatorIds || []) {
    if (creatorOperatorId.trim()) params.append("creatorOperatorId", creatorOperatorId.trim());
  }
  const response = await api.get<unknown>(
    `/api/platform/admin/dashboard/creator-sales-v2?${params.toString()}`,
  );
  return CreatorSalesDashboardV2Schema.parse(response);
}

export async function fetchCreatorSalesDashboardV3(input: Parameters<typeof fetchCreatorSalesDashboardV2>[0], scopeInput: ReportScope,
  operatorId: string, signal?: AbortSignal): Promise<CreatorSalesDashboardV3> {
  const scope = ReportScopeSchema.parse(scopeInput), raw = input.creatorOperatorIds ?? [];
  if (!operatorId.trim() || raw.some(id => typeof id !== "string" || !id.trim())) throw new Error("Bộ lọc Tổng quan không hợp lệ.");
  const selection = CreatorSelectionV1Schema.parse(raw.length ? { mode: "selected", creatorOperatorIds: [...new Set(raw.map(id => id.trim()))].sort() }
    : { mode: "all", creatorOperatorIds: [] });
  const params = new URLSearchParams({ from: input.from, to: input.to });
  for (const id of selection.creatorOperatorIds) params.append("creatorOperatorId", id);
  const value = CreatorSalesDashboardV3Schema.parse(await api.get<unknown>(`/api/platform/admin/dashboard/creator-sales-v3?${params}`, {
    "x-report-merchant-id": scope.merchantId, "x-report-store-ids": scope.storeIds.join(","),
  }, signal));
  const expected = value.audience === "self" ? { mode: "selected", creatorOperatorIds: [operatorId] } : selection;
  if (value.context.normalizedScope.merchantId !== scope.merchantId || JSON.stringify([...value.context.normalizedScope.storeIds].sort()) !== JSON.stringify([...scope.storeIds].sort())
    || value.context.localDateRange.from !== input.from || value.context.localDateRange.to !== input.to
    || JSON.stringify(value.creatorSelection) !== JSON.stringify(expected)
    || (value.audience === "self" && raw.length > 0 && JSON.stringify(selection) !== JSON.stringify(expected))) {
    throw new Error("Kết quả Tổng quan không khớp người tạo hoặc phạm vi đã yêu cầu.");
  }
  return value;
}

export async function emailReceipt(orderId: string, email?: string) {
  return api.post(`/api/receipts/${orderId}/email`, { email }, idempotencyKey("receipt-email"));
}

export async function fetchReceiptText(orderId: string) {
  const suffix = ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1.effectiveReceiptEnabled
    ? "effective-receipt.txt"
    : "receipt.txt";
  const response = await api.rawGet(`/api/orders/${encodeURIComponent(orderId)}/${suffix}`);
  return response.text();
}

export async function fetchReceiptPdf(orderId: string) {
  const suffix = ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1.effectiveReceiptEnabled
    ? "effective-receipt.pdf"
    : "receipt.pdf";
  const response = await api.rawGet(`/api/orders/${encodeURIComponent(orderId)}/${suffix}`);
  return response.blob();
}

export async function fetchCashFlow(from: string, to: string) {
  return api.get<{ data: { cashIn: number; cashOut: number; netCashFlow: number } }>(
    `/api/accounting/reports/cash-flow?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
}

export function reportExportUrl(name: "income-statement" | "balance-sheet" | "tax-summary" | "cash-flow", params: Record<string, string>) {
  const query = new URLSearchParams(params);
  return `/api/accounting/reports/${name}.pdf?${query.toString()}`;
}

export async function fetchSyncBootstrap() {
  return api.get<{
    data: {
      generatedAt: string;
      permissionVersion?: string | null;
      operatorId?: string | null;
      sessionVersion?: number | null;
      snapshotAuthorizationExpiresAt?: string | null;
      products: ProductItem[];
      customers: CustomerItem[];
      loyaltyTiers: unknown[];
      entitlements?: { data?: { packageKey: string; features: string[] }; packageKey?: string; features?: string[] };
      activeOperatingScope?: { merchantId: string; storeId: string; stockLocationId: string };
      accessibleMerchants?: Array<{ id: string; displayName?: string }>;
      accessibleStores?: Array<{ id: string; merchantId?: string; displayName?: string }>;
      paymentProviders?: {
        sepay_va?: { enabled: boolean; mode?: string; reason?: string };
        nowpayments?: { enabled: boolean; mode?: string; reason?: string };
      };
    };
  }>("/api/sync/bootstrap");
}
