import type { TelegramConfig } from "./config";

export interface BackendErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export class BackendApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "BackendApiError";
  }
}

export interface RemoteOrderRequest {
  customerId?: string;
  items: Array<{ variantId: string; quantity: number }>;
  paymentMethod?: string;
  amountReceived?: number;
  note?: string;
}

export interface RefundRequest {
  amount?: number;
  reason: string;
  confirmationToken?: string;
}

export interface CancelOrderRequest {
  reason?: string;
}

export interface BotSessionResponse {
  data: {
    channel: "telegram";
    channelUserId: string;
    actorType?: "telegram_customer" | "operator";
    operatorId?: string | null;
    merchantId?: string | null;
    storeId?: string | null;
    state: Record<string, unknown>;
    expiresAt: string | null;
    updatedAt: string | null;
  };
}

export interface TelegramLinkOperatorResponse {
  data: {
    operatorId: string;
    linked: true;
  };
}

export interface ProductListResponse {
  data: Array<{
    id: string;
    title: string;
    status: string;
    variants: Array<{
      id: string;
      sku: string;
      barcode: string;
      prices: Array<{ amount: number }>;
      inventory_quantity: number;
    }>;
  }>;
}

export interface TelegramSalesCatalogResponse {
  data: Array<{
    productId: string;
    variantId: string;
    title: string;
    status: string;
    imageUrl?: string;
    categories?: Array<{
      id: string;
      name: string;
      handle: string;
    }>;
    categoryName?: string;
    categoryHandle?: string;
    sku: string;
    barcode: string;
    price: number;
    currencyCode: string;
    availability: "available" | "low_stock" | "out_of_stock" | string;
    canOrder: boolean;
    salesQuantity?: number;
    salesRank?: number;
  }>;
}

export interface TelegramSalesDraftRequest {
  profile?: {
    telegramUserId?: string;
    telegramChatId?: string;
    username?: string;
    firstName?: string;
    language?: "en" | "ru" | string;
  };
  items: Array<{ variantId: string; quantity: number }>;
  delivery?: {
    address?: string;
    note?: string;
    zone?: string;
    eta?: string;
  };
  customerMessage?: string;
  aiMetadata?: Record<string, unknown>;
  shippingFee?: number;
}

export interface TelegramSalesDraftResponse {
  data: {
    id: string;
    status: string;
    telegramUserId: string;
    telegramUsername?: string | null;
    quote?: {
      total?: number;
      shippingFee?: number;
      items?: Array<{
        title?: string;
        sku?: string;
        quantity?: number;
        unitPrice?: number;
        lineTotal?: number;
        availability?: string;
      }>;
    };
    createdAt?: string | null;
    expiresAt?: string | null;
  };
}

export interface TelegramSalesDraftSummary {
  id: string;
  status: string;
  customerMessage?: string | null;
  convertedOrderId?: string | null;
  delivery?: {
    address?: string | null;
    note?: string | null;
    zone?: string | null;
    eta?: string | null;
  };
  quote?: {
    total?: number;
    shippingFee?: number;
    items?: Array<{
      title?: string;
      sku?: string;
      quantity?: number;
      unitPrice?: number;
      lineTotal?: number;
      availability?: string;
    }>;
  };
  createdAt?: string | null;
  reviewedAt?: string | null;
  expiresAt?: string | null;
}

export interface TelegramSalesDraftsResponse {
  data: TelegramSalesDraftSummary[];
  count: number;
  statusCounts?: Record<string, number>;
  limit: number;
  offset: number;
}

export interface OrdersListResponse {
  orders: Array<{
    id: string;
    orderNumber?: string;
    display_id?: string;
    status: string;
    total: number;
    paymentMethod?: string;
    payment_method?: string;
    createdAt?: string;
    created_at?: string;
  }>;
  count: number;
  limit: number;
  offset: number;
}

export interface DashboardResponse {
  contract: "dashboard.partial-financial.v1";
  context: {
    normalizedScope: { merchantId: string; storeIds: string[] };
    localDateRange: { from: string; to: string };
    reportAsOf: string;
    generatedAt: string;
  };
  data: {
    aggregateReadSource: "app.payment_events";
    completeness: "partial_dec_01_029_blocked" | "complete_payment_payable_v1";
    currencies: Array<{
      currencyCode: string;
      minorUnitExponent: number;
      currentOrder: {
        validOrderCount: number;
        currentOrderGrossValueMinor: number;
      };
      recordedCollection: {
        recordedGrossCollectionsMinor: number;
      };
      paymentFlow?: {
        negativeCollectionsMinor: number;
        netCollectionsMinor: number;
        customerRefundPayableAsOfMinor: number;
      };
    }>;
  };
}

export type AccountingReportName = "income-statement" | "balance-sheet" | "cash-flow" | "tax-summary";

export interface AccountingReportFilters {
  from?: string;
  to?: string;
  asOf?: string;
}

export interface AccountingReportResponse {
  data: Record<string, number>;
}

export interface MutationResponse<TData = Record<string, unknown>> {
  data: TData;
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
    completedOrderId?: string | null;
    manualReviewReason?: string | null;
  };
  order?: Record<string, unknown>;
}

export interface AiOrderClarification {
  type: "product" | "customer" | string;
  queryText?: string;
  message?: string;
  options?: Array<{
    customerId?: string;
    customerName?: string;
    phone?: string;
    productId?: string;
    productName?: string;
    variantId?: string;
    sku?: string;
    stock?: number;
  }>;
}

export interface AiReviewQueueResponse {
  data: Array<{
    id: string;
    actionType?: string;
    action_type?: string;
    status: string;
    outputPayload?: Record<string, unknown>;
    output_payload?: Record<string, unknown>;
    confidence?: number | string | null;
    riskLevel?: string | null;
    risk_level?: string | null;
    createdAt?: string;
    created_at?: string;
  }>;
}

export interface AiOrderDraftResponse {
  data: {
    items: Array<{ variantId: string; quantity: number; productName?: string; sku?: string }>;
    paymentMethod: string;
    customerId?: string;
    note: string;
    confidence: "low" | "medium" | "high";
    parser: string;
    queryText: string;
    usageReservationToken?: string;
    clarification?: string | AiOrderClarification | null;
  };
}

export interface ReceiptPdfResponse {
  data: ArrayBuffer;
  contentType: string;
  filename: string;
}

export interface TelegramNotification {
  id: string;
  telegramUserId: string;
  recipientOperatorId?: string | null;
  recipientId?: string | null;
  ruleId?: string | null;
  template: string;
  text: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface TelegramNotificationsResponse {
  data: TelegramNotification[];
}

export class BackendClient {
  constructor(private config: TelegramConfig) {}

  private backendUrl(path: string): string {
    const apiPrefix = this.config.backendApiPrefix ?? "/api";
    const resolvedPath = path.startsWith("/api/")
      ? `${apiPrefix}${path.slice("/api".length)}`
      : path;
    return `${this.config.backendBaseUrl}${resolvedPath}`;
  }

  private async request<T>(
    telegramUserId: string,
    path: string,
    init: RequestInit = {},
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await fetch(this.backendUrl(path), {
      ...init,
      headers: {
        "authorization": `Bearer ${this.config.serviceToken}`,
        "content-type": "application/json",
        "x-channel": "telegram",
        "x-channel-user-id": telegramUserId,
        "x-channel-service-id": this.config.serviceId,
        ...(this.config.telegramBotConfigId ? { "x-telegram-bot-config-id": this.config.telegramBotConfigId } : {}),
        ...(this.config.merchantId ? { "x-merchant-id": this.config.merchantId } : {}),
        ...(this.config.storeId ? { "x-store-id": this.config.storeId } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        ...(init.headers || {}),
      },
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as BackendErrorBody;
      throw new BackendApiError(
        response.status,
        body.error?.code || "backend_error",
        body.error?.message || `Backend request failed with ${response.status}`,
        body.error?.details,
      );
    }

    return response.json() as Promise<T>;
  }

  private async requestService<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(this.backendUrl(path), {
      ...init,
      headers: {
        "authorization": `Bearer ${this.config.serviceToken}`,
        "content-type": "application/json",
        "x-channel": "telegram",
        "x-channel-service-id": this.config.serviceId,
        ...(this.config.telegramBotConfigId ? { "x-telegram-bot-config-id": this.config.telegramBotConfigId } : {}),
        ...(this.config.merchantId ? { "x-merchant-id": this.config.merchantId } : {}),
        ...(this.config.storeId ? { "x-store-id": this.config.storeId } : {}),
        ...(init.headers || {}),
      },
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as BackendErrorBody;
      throw new BackendApiError(
        response.status,
        body.error?.code || "backend_error",
        body.error?.message || `Backend request failed with ${response.status}`,
        body.error?.details,
      );
    }

    return response.json() as Promise<T>;
  }

  private async requestText(telegramUserId: string, path: string): Promise<string> {
    const response = await fetch(this.backendUrl(path), {
      headers: {
        "authorization": `Bearer ${this.config.serviceToken}`,
        "x-channel": "telegram",
        "x-channel-user-id": telegramUserId,
        "x-channel-service-id": this.config.serviceId,
        ...(this.config.telegramBotConfigId ? { "x-telegram-bot-config-id": this.config.telegramBotConfigId } : {}),
        ...(this.config.merchantId ? { "x-merchant-id": this.config.merchantId } : {}),
        ...(this.config.storeId ? { "x-store-id": this.config.storeId } : {}),
        "accept": "text/plain",
      },
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as BackendErrorBody;
      throw new BackendApiError(
        response.status,
        body.error?.code || "backend_error",
        body.error?.message || `Backend request failed with ${response.status}`,
        body.error?.details,
      );
    }

    return response.text();
  }

  private async requestBinary(telegramUserId: string, path: string, fallbackFilename: string): Promise<ReceiptPdfResponse> {
    const response = await fetch(this.backendUrl(path), {
      headers: {
        "authorization": `Bearer ${this.config.serviceToken}`,
        "x-channel": "telegram",
        "x-channel-user-id": telegramUserId,
        "x-channel-service-id": this.config.serviceId,
        ...(this.config.telegramBotConfigId ? { "x-telegram-bot-config-id": this.config.telegramBotConfigId } : {}),
        ...(this.config.merchantId ? { "x-merchant-id": this.config.merchantId } : {}),
        ...(this.config.storeId ? { "x-store-id": this.config.storeId } : {}),
        "accept": "application/pdf",
      },
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as BackendErrorBody;
      throw new BackendApiError(
        response.status,
        body.error?.code || "backend_error",
        body.error?.message || `Backend request failed with ${response.status}`,
        body.error?.details,
      );
    }

    const disposition = response.headers.get("content-disposition") || "";
    const filenameMatch = disposition.match(/filename="([^"]+)"/i);
    return {
      data: await response.arrayBuffer(),
      contentType: response.headers.get("content-type") || "application/pdf",
      filename: filenameMatch?.[1] || fallbackFilename,
    };
  }

  getMe(telegramUserId: string) {
    return this.request(telegramUserId, "/api/channel/me");
  }

  getSession(telegramUserId: string) {
    return this.request<BotSessionResponse>(telegramUserId, "/api/channel/telegram-sales/session");
  }

  updateSession(telegramUserId: string, state: Record<string, unknown>, idempotencyKey?: string, expiresAt?: string | null) {
    return this.request<BotSessionResponse>(telegramUserId, "/api/channel/telegram-sales/session", {
      method: "PATCH",
      body: JSON.stringify({ state, expiresAt }),
    }, idempotencyKey);
  }

  clearSession(telegramUserId: string) {
    return this.request(telegramUserId, "/api/channel/telegram-sales/session", { method: "DELETE" });
  }

  linkOperatorTelegram(telegramUserId: string, token: string, displayName?: string) {
    return this.request<TelegramLinkOperatorResponse>(telegramUserId, "/api/channel/telegram/link-operator", {
      method: "POST",
      body: JSON.stringify({ token, displayName }),
    });
  }

  searchProducts(telegramUserId: string, q?: string, limit = 5) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (q) params.set("q", q);
    return this.request<ProductListResponse>(telegramUserId, `/api/pos/products?${params.toString()}`);
  }

  listTelegramSalesCatalog(telegramUserId: string, q?: string, limit = 10, categoryHandle?: string) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (q) params.set("q", q);
    if (categoryHandle) params.set("categoryHandle", categoryHandle);
    return this.request<TelegramSalesCatalogResponse>(telegramUserId, `/api/channel/telegram-sales/catalog?${params.toString()}`);
  }

  draftAiOrder(telegramUserId: string, text: string) {
    return this.request<AiOrderDraftResponse>(telegramUserId, "/ai/order-draft", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  draftTelegramSalesOrder(telegramUserId: string, text: string) {
    return this.request<AiOrderDraftResponse>(telegramUserId, "/ai/telegram-sales/order-draft", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  checkAiOrderConfirm(telegramUserId: string, input: RemoteOrderRequest & { usageReservationToken?: string; storeId?: string | null }) {
    return this.request<MutationResponse>(telegramUserId, "/ai/order-confirm-check", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  listOrders(telegramUserId: string, limit = 5) {
    const params = new URLSearchParams({ limit: String(limit) });
    return this.request<OrdersListResponse>(telegramUserId, `/api/orders?${params.toString()}`);
  }

  getDashboard(telegramUserId: string) {
    return this.request<DashboardResponse>(telegramUserId, "/api/admin/dashboard/partial-financial");
  }

  getAccountingReport(telegramUserId: string, name: AccountingReportName, filters: AccountingReportFilters = {}) {
    const params = new URLSearchParams();
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (filters.asOf) params.set("asOf", filters.asOf);
    const query = params.toString();
    return this.request<AccountingReportResponse>(
      telegramUserId,
      `/api/accounting/reports/${name}${query ? `?${query}` : ""}`,
    );
  }

  createRemoteOrder(telegramUserId: string, input: RemoteOrderRequest, idempotencyKey: string) {
    return this.request<MutationResponse>(telegramUserId, "/api/orders", {
      method: "POST",
      body: JSON.stringify({ ...input, status: "confirmed" }),
    }, idempotencyKey);
  }

  createTelegramSalesDraft(telegramUserId: string, input: TelegramSalesDraftRequest, idempotencyKey: string) {
    return this.request<TelegramSalesDraftResponse>(telegramUserId, "/api/channel/telegram-sales/drafts", {
      method: "POST",
      body: JSON.stringify(input),
    }, idempotencyKey);
  }

  listTelegramSalesDrafts(telegramUserId: string, limit = 5, offset = 0) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return this.request<TelegramSalesDraftsResponse>(telegramUserId, `/api/channel/telegram-sales/drafts?${params.toString()}`);
  }

  createPaymentIntent(telegramUserId: string, input: RemoteOrderRequest, idempotencyKey: string) {
    const provider = input.paymentMethod === "nowpayments" ? "nowpayments" : "sepay_va";
    return this.request<PaymentIntentResponse>(telegramUserId, "/api/payment-intents", {
      method: "POST",
      body: JSON.stringify({
        provider,
        order: {
          ...input,
          paymentMethod: provider,
          amountReceived: 0,
        },
      }),
    }, idempotencyKey);
  }

  refundOrder(telegramUserId: string, orderId: string, input: RefundRequest, idempotencyKey: string) {
    return this.request<MutationResponse>(telegramUserId, `/api/orders/${encodeURIComponent(orderId)}/refund`, {
      method: "POST",
      body: JSON.stringify(input),
    }, idempotencyKey);
  }

  cancelOrder(telegramUserId: string, orderId: string, input: CancelOrderRequest, idempotencyKey: string) {
    return this.request<MutationResponse>(telegramUserId, `/api/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: "POST",
      body: JSON.stringify(input),
    }, idempotencyKey);
  }

  getReceiptText(telegramUserId: string, orderId: string) {
    return this.requestText(telegramUserId, `/api/orders/${encodeURIComponent(orderId)}/receipt.txt`);
  }

  getReceiptPdf(telegramUserId: string, orderId: string) {
    return this.requestBinary(
      telegramUserId,
      `/api/orders/${encodeURIComponent(orderId)}/receipt.pdf`,
      `${orderId}-receipt.pdf`,
    );
  }

  listAiReviewQueue(telegramUserId: string) {
    return this.request<AiReviewQueueResponse>(telegramUserId, "/ai/review-queue");
  }

  approveAiAction(telegramUserId: string, actionId: string, approvedText: string | undefined, idempotencyKey: string) {
    return this.request<MutationResponse>(telegramUserId, `/ai/actions/${encodeURIComponent(actionId)}/approve`, {
      method: "POST",
      body: JSON.stringify({ approvedText }),
    }, idempotencyKey);
  }

  rejectAiAction(telegramUserId: string, actionId: string, reason: string | undefined, idempotencyKey: string) {
    return this.request<MutationResponse>(telegramUserId, `/ai/actions/${encodeURIComponent(actionId)}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason: reason || "operator_rejected" }),
    }, idempotencyKey);
  }

  claimNotifications(limit = 10) {
    return this.requestService<TelegramNotificationsResponse>(`/api/channel/notifications?limit=${limit}`);
  }

  markNotificationSent(notificationId: string) {
    return this.requestService(`/api/channel/notifications/${encodeURIComponent(notificationId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "sent" }),
    });
  }

  markNotificationFailed(notificationId: string, error: string) {
    return this.requestService(`/api/channel/notifications/${encodeURIComponent(notificationId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "failed", error }),
    });
  }
}
