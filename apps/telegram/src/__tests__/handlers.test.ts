import { beforeEach, describe, expect, it } from "vitest";
import type {
  AccountingReportFilters,
  AccountingReportName,
  AiOrderDraftResponse,
  BackendApiError,
  BackendClient,
  PaymentIntentResponse,
  RefundRequest,
  RemoteOrderRequest,
  TelegramSalesDraftRequest,
  TelegramSalesDraftsResponse,
} from "../backend-client";
import { BackendApiError as BackendApiErrorValue } from "../backend-client";
import { handleUpdate } from "../handlers";
import { SessionStore } from "../session-store";
import type { TelegramApi, TelegramMessageOptions, TelegramPhotoOptions, TelegramUpdate } from "../telegram-api";

class FakeBackend {
  sessions = new Map<string, Record<string, unknown>>();
  sessionExpiresAt = new Map<string, string | null>();
  createdOrders: Array<{ userId: string; input: RemoteOrderRequest; idempotencyKey: string }> = [];
  salesDrafts: Array<{ userId: string; input: TelegramSalesDraftRequest; idempotencyKey: string }> = [];
  paymentIntents: Array<{ userId: string; input: RemoteOrderRequest; idempotencyKey: string }> = [];
  refunds: Array<{ userId: string; orderId: string; input: RefundRequest; idempotencyKey: string }> = [];
  cancels: Array<{ userId: string; orderId: string; idempotencyKey: string }> = [];
  approvals: Array<{ userId: string; actionId: string; approvedText?: string; idempotencyKey: string }> = [];
  rejections: Array<{ userId: string; actionId: string; reason?: string; idempotencyKey: string }> = [];
  accountingReports: Array<{ userId: string; name: AccountingReportName; filters: AccountingReportFilters }> = [];
  historyCalls: Array<{ userId: string; limit: number; offset: number }> = [];
  getMeCalls: string[] = [];
  listOrdersCalls: Array<{ userId: string; limit: number }> = [];
  dashboardCalls: string[] = [];
  draftAiOrderCalls = 0;
  draftAiOrderResponse: AiOrderDraftResponse["data"] | null = null;
  searchProductsCalls = 0;
  draftAiOrderError: BackendApiError | null = null;
  operatorLinked = true;

  async getSession(userId: string) {
    const expiresAt = this.sessionExpiresAt.get(userId) || null;
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      this.sessions.delete(userId);
      this.sessionExpiresAt.delete(userId);
    }
    return {
      data: {
        channel: "telegram" as const,
        channelUserId: userId,
        operatorId: "op_1",
        state: this.sessions.get(userId) || {},
        expiresAt: this.sessionExpiresAt.get(userId) || null,
        updatedAt: null,
      },
    };
  }

  async updateSession(userId: string, state: Record<string, unknown>, _idempotencyKey?: string, expiresAt?: string | null) {
    this.sessions.set(userId, state);
    this.sessionExpiresAt.set(userId, expiresAt || null);
    return {
      data: {
        channel: "telegram" as const,
        channelUserId: userId,
        operatorId: "op_1",
        state,
        expiresAt: expiresAt || null,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  async clearSession(userId: string) {
    this.sessions.delete(userId);
    this.sessionExpiresAt.delete(userId);
  }

  async getMe(userId: string) {
    this.getMeCalls.push(userId);
    if (!this.operatorLinked) {
      throw new BackendApiErrorValue(403, "channel_identity_unmapped", "Channel user is not mapped to an operator");
    }
    return {
      data: {
        operator: {
          id: "op_1",
          role: "owner",
          displayName: "Operator One",
          organizationId: "org_default",
        },
        permissions: ["remote_order:create", "orders:read", "reports:read"],
      },
    };
  }

  async searchProducts() {
    this.searchProductsCalls += 1;
    return {
      data: [
        {
          id: "prod_mint",
          title: "Mint Medium Pouch",
          status: "published",
          variants: [
            {
              id: "var_mint",
              sku: "MINT-MED",
              barcode: "",
              prices: [{ amount: 250000 }],
              inventory_quantity: 8,
            },
          ],
        },
      ],
    };
  }

  async listTelegramSalesCatalog(_userId?: string, q?: string, limit = 20, categoryHandle?: string) {
    const data = [
      {
        productId: "prod_mint",
        variantId: "var_mint",
        title: "Mint Medium Pouch",
        status: "published",
        imageUrl: "https://cdn.example.test/mint.jpg",
        categories: [{ id: "cat_mint", name: "Mint", handle: "mint" }],
        categoryName: "Mint",
        categoryHandle: "mint",
        sku: "MINT-MED",
        barcode: "",
        price: 250000,
        currencyCode: "vnd",
        availability: "available",
        canOrder: true,
        salesQuantity: 25,
        salesRank: 1,
      },
      {
        productId: "prod_berry",
        variantId: "var_berry",
        title: "Berry Strong Pouch",
        status: "published",
        imageUrl: "https://cdn.example.test/berry.jpg",
        categories: [{ id: "cat_fruit", name: "Fruit", handle: "fruit" }],
        categoryName: "Fruit",
        categoryHandle: "fruit",
        sku: "BERRY-STRONG",
        barcode: "",
        price: 280000,
        currencyCode: "vnd",
        availability: "low_stock",
        canOrder: true,
        salesQuantity: 20,
        salesRank: 2,
      },
      {
        productId: "prod_citrus",
        variantId: "var_citrus",
        title: "Citrus Low Pouch",
        status: "published",
        imageUrl: "https://cdn.example.test/citrus.jpg",
        categories: [{ id: "cat_fruit", name: "Fruit", handle: "fruit" }],
        categoryName: "Fruit",
        categoryHandle: "fruit",
        sku: "CITRUS-LOW",
        barcode: "",
        price: 230000,
        currencyCode: "vnd",
        availability: "available",
        canOrder: true,
        salesQuantity: 18,
        salesRank: 3,
      },
      {
        productId: "prod_coffee",
        variantId: "var_coffee",
        title: "Coffee Medium",
        status: "published",
        imageUrl: "https://cdn.example.test/coffee.jpg",
        categories: [{ id: "cat_classic", name: "Classic", handle: "classic" }],
        categoryName: "Classic",
        categoryHandle: "classic",
        sku: "COFFEE-MED",
        barcode: "",
        price: 240000,
        currencyCode: "vnd",
        availability: "available",
        canOrder: true,
        salesQuantity: 14,
        salesRank: 4,
      },
      {
        productId: "prod_winter",
        variantId: "var_winter",
        title: "Wintergreen Strong",
        status: "published",
        imageUrl: "https://cdn.example.test/winter.jpg",
        categories: [{ id: "cat_mint", name: "Mint", handle: "mint" }],
        categoryName: "Mint",
        categoryHandle: "mint",
        sku: "WINTER-STRONG",
        barcode: "",
        price: 260000,
        currencyCode: "vnd",
        availability: "available",
        canOrder: true,
        salesQuantity: 11,
        salesRank: 5,
      },
    ];
    const normalized = String(q || "").toLowerCase();
    const filtered = data.filter((item) => {
      const categoryMatches = !categoryHandle || item.categoryHandle === categoryHandle;
      const queryMatches = !normalized
        || item.title.toLowerCase().includes(normalized)
        || item.sku.toLowerCase().includes(normalized);
      return categoryMatches && queryMatches;
    });
    return {
      data: filtered.slice(0, limit),
    };
  }

  async draftAiOrder(_userId: string, text: string) {
    this.draftAiOrderCalls += 1;
    if (this.draftAiOrderError) throw this.draftAiOrderError;
    if (this.draftAiOrderResponse) return { data: this.draftAiOrderResponse };
    if (/ambiguous|chon|chọn/i.test(text)) {
      return {
        data: {
          items: [],
          paymentMethod: "cod",
          note: `AI Telegram draft: ${text}`,
          confidence: "low" as const,
          parser: "deterministic",
          queryText: "mint",
          clarification: {
            type: "product",
            queryText: "mint",
            message: "Co nhieu san pham khop \"mint\". Hay chon SKU con hang.",
            options: [
              { productId: "prod_mint", productName: "Mint Medium Pouch", variantId: "var_mint", sku: "MINT-MED", stock: 8 },
              { productId: "prod_mint_slim", productName: "Mint Slim Pack", variantId: "var_mint_slim", sku: "MINT-SLIM", stock: 2 },
            ],
          },
        },
      };
    }

    const asksQr = /qr|chuyen khoan|chuyển khoản/i.test(text);
    const explicitQuantity = text.match(/\bx\s*(\d+)\b/i);
    const leadingQuantity = text.match(/^(\d+)\b/);
    const quantity = explicitQuantity ? Number(explicitQuantity[1]) : leadingQuantity ? Number(leadingQuantity[1]) : 1;
    return {
      data: {
        items: [{ variantId: "var_mint", quantity, productName: "Mint Medium Pouch", sku: "MINT-MED" }],
        paymentMethod: asksQr ? "sepay_va" : "cod",
        note: `AI Telegram draft: ${text}`,
        confidence: "medium" as const,
        parser: "deterministic",
        queryText: "mint medium quen",
        clarification: null,
      },
    };
  }

  async draftTelegramSalesOrder(userId: string, text: string) {
    return this.draftAiOrder(userId, text);
  }

  async createPaymentIntent(userId: string, input: RemoteOrderRequest, idempotencyKey: string): Promise<PaymentIntentResponse> {
    this.paymentIntents.push({ userId, input, idempotencyKey });
    return {
      data: {
        id: "pi_1",
        provider: "sepay_va",
        status: "pending",
        amount: 500000,
        currencyCode: "vnd",
        referenceCode: "PITELEGRAM1",
        qrPayload: "QR PITELEGRAM1",
        paymentUrl: null,
        expiresAt: "2026-06-19T04:30:00.000Z",
        completedOrderId: null,
      },
    };
  }

  async createRemoteOrder(userId: string, input: RemoteOrderRequest, idempotencyKey: string) {
    this.createdOrders.push({ userId, input, idempotencyKey });
    return {
      data: {
        id: "order_1",
        orderNumber: "ORD-1",
        status: "confirmed",
        remoteStatus: "confirmed",
        total: 120000,
        paymentMethod: input.paymentMethod || "cod",
      },
    };
  }

  async createTelegramSalesDraft(userId: string, input: TelegramSalesDraftRequest, idempotencyKey: string) {
    this.salesDrafts.push({ userId, input, idempotencyKey });
    return {
      data: {
        id: "tsd_1",
        status: "needs_review",
        telegramUserId: userId,
        telegramUsername: "customer_test",
        quote: {
          total: 500000,
          shippingFee: 0,
          items: input.items.map((item) => ({
            title: item.variantId === "var_mint" ? "Mint Medium Pouch" : item.variantId,
            sku: item.variantId === "var_mint" ? "MINT-MED" : item.variantId,
            quantity: item.quantity,
            unitPrice: 250000,
            lineTotal: 250000 * item.quantity,
            availability: "available",
          })),
        },
        createdAt: "2026-06-27T00:00:00.000Z",
        expiresAt: "2026-06-28T00:00:00.000Z",
      },
    };
  }

  async listTelegramSalesDrafts(userId: string, limit = 5, offset = 0): Promise<TelegramSalesDraftsResponse> {
    this.historyCalls.push({ userId, limit, offset });
    return {
      data: [
        {
          id: "tsd_2",
          status: "converted",
          customerMessage: "mint x2",
          convertedOrderId: "order_telegram_1",
          delivery: {
            address: "22 Example Street",
            note: "Lobby pickup",
          },
          quote: {
            total: 500000,
            shippingFee: 0,
            items: [
              {
                title: "Mint Medium Pouch",
                sku: "MINT-MED",
                quantity: 2,
                unitPrice: 250000,
                lineTotal: 500000,
                availability: "available",
              },
            ],
          },
          createdAt: "2026-06-27T00:00:00.000Z",
          reviewedAt: "2026-06-27T00:10:00.000Z",
          expiresAt: "2026-06-28T00:00:00.000Z",
        },
      ],
      count: offset === 0 ? 6 : 1,
      statusCounts: offset === 0 ? { converted: 3, needs_review: 2, rejected: 1 } : { converted: 1 },
      limit,
      offset,
    };
  }

  async refundOrder(userId: string, orderId: string, input: RefundRequest, idempotencyKey: string) {
    this.refunds.push({ userId, orderId, input, idempotencyKey });
    return {
      data: {
        orderId,
        orderNumber: "ORD-1",
        status: "refunded",
        amount: input.amount || 120000,
        refundableAfter: 0,
      },
    };
  }

  async cancelOrder(userId: string, orderId: string, _input: { reason?: string }, idempotencyKey: string) {
    this.cancels.push({ userId, orderId, idempotencyKey });
    return { data: { orderId, status: "canceled" } };
  }

  async getReceiptPdf(_userId: string, orderId: string) {
    return {
      data: new Uint8Array([1, 2, 3]).buffer,
      contentType: "application/pdf",
      filename: `${orderId}-receipt.pdf`,
    };
  }

  async getAccountingReport(userId: string, name: AccountingReportName, filters: AccountingReportFilters) {
    this.accountingReports.push({ userId, name, filters });
    return {
      data: name === "balance-sheet"
        ? {
          totalAssets: 500000,
          totalLiabilities: 120000,
          ledgerEquity: 250000,
          currentEarnings: 130000,
          reportedEquity: 380000,
          totalEquity: 380000,
          balanceDelta: 0,
        }
        : { revenue: 500000, cogs: 320000, operatingExpenses: 50000, grossProfit: 180000, netIncome: 130000 },
    };
  }

  async listOrders(userId: string, limit = 5) {
    this.listOrdersCalls.push({ userId, limit });
    return {
      orders: [
        {
          id: "order_1",
          orderNumber: "ORD-1",
          status: "completed",
          total: 120000,
          paymentMethod: "cod",
          createdAt: "2026-06-27T00:00:00.000Z",
        },
      ],
    };
  }

  async getDashboard(userId: string) {
    this.dashboardCalls.push(userId);
    return {
      contract: "dashboard.partial-financial.v1" as const,
      context: {
        normalizedScope: { merchantId: "merchant_1", storeIds: ["store_1"] },
        localDateRange: { from: "2026-06-27", to: "2026-06-27" },
        reportAsOf: "2026-06-27T12:00:00.000Z",
        generatedAt: "2026-06-27T12:00:01.000Z",
      },
      data: {
        aggregateReadSource: "app.payment_events" as const,
        completeness: "complete_payment_payable_v1" as const,
        currencies: [{
          currencyCode: "VND",
          minorUnitExponent: 0,
          currentOrder: { validOrderCount: 2, currentOrderGrossValueMinor: 550000 },
          recordedCollection: { recordedGrossCollectionsMinor: 500000 },
          paymentFlow: {
            negativeCollectionsMinor: 10000,
            netCollectionsMinor: 490000,
            customerRefundPayableAsOfMinor: 20000,
          },
        }],
      },
    };
  }

  async getReceiptText(_userId: string, orderId: string) {
    return `Receipt ${orderId}`;
  }

  async listAiReviewQueue() {
    return {
      data: [
        {
          id: "ai_1",
          actionType: "reply_draft",
          status: "review_required",
          outputPayload: { responseText: "Xin chao khach hang" },
          confidence: 0.82,
          riskLevel: "low",
          createdAt: "2026-06-14T00:00:00.000Z",
        },
      ],
    };
  }

  async approveAiAction(userId: string, actionId: string, approvedText: string | undefined, idempotencyKey: string) {
    this.approvals.push({ userId, actionId, approvedText, idempotencyKey });
    return { data: { id: actionId, status: "approved" } };
  }

  async rejectAiAction(userId: string, actionId: string, reason: string | undefined, idempotencyKey: string) {
    this.rejections.push({ userId, actionId, reason, idempotencyKey });
    return { data: { id: actionId, status: "rejected" } };
  }
}

class FakeTelegram {
  messages: Array<{ chatId: number; text: string; options?: TelegramMessageOptions }> = [];
  photos: Array<{ chatId: number; photo: string; options?: TelegramPhotoOptions }> = [];
  documents: Array<{ chatId: number; filename: string; contentType: string; caption?: string }> = [];
  answeredCallbacks: Array<{ id: string; text?: string }> = [];

  async sendMessage(chatId: number, text: string, options?: TelegramMessageOptions) {
    this.messages.push({ chatId, text, options });
  }

  async sendPhoto(chatId: number, photo: string, options?: TelegramPhotoOptions) {
    this.photos.push({ chatId, photo, options });
  }

  async answerCallbackQuery(id: string, text?: string) {
    this.answeredCallbacks.push({ id, text });
  }

  async sendDocument(chatId: number, _document: ArrayBuffer, filename: string, contentType: string, caption?: string) {
    this.documents.push({ chatId, filename, contentType, caption });
  }
}

function update(text: string, updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      text,
      chat: { id: 9001 },
      from: { id: 42, first_name: "Operator" },
    },
  };
}

function callback(data: string, updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback_${updateId}`,
      data,
      message: {
        message_id: updateId,
        text: "",
        chat: { id: 9001 },
      },
      from: { id: 42, first_name: "Operator" },
    },
  };
}

describe("Telegram handler mutating MVP flows", () => {
  let backend: FakeBackend;
  let telegram: FakeTelegram;
  let sessions: SessionStore;

  beforeEach(() => {
    backend = new FakeBackend();
    telegram = new FakeTelegram();
    sessions = new SessionStore(backend as unknown as BackendClient);
  });

  async function handle(text: string, updateId: number, options = {}) {
    await handleUpdate(
      update(text, updateId),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
      options,
    );
  }

  it("shows a persistent customer menu on start/help and supports Products menu text", async () => {
    await handle("/start", 91);

    expect(telegram.messages.at(-2)?.text).toContain("Store");
    expect(telegram.messages.at(-2)?.options?.reply_markup?.keyboard).toEqual([
      [{ text: "🌿 Catalog" }, { text: "🧺 Cart" }],
      [{ text: "🧾 My requests" }, { text: "🌐 Language" }],
      [{ text: "💬 Support" }, { text: "☰ Menu" }],
      [{ text: "❌ Cancel" }],
    ]);
    expect(telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard?.[0][0]).toEqual({
      text: "🌿 Browse snus",
      callback_data: "sales_menu:products",
    });

    await handle("🌿 Catalog", 92);

    expect(telegram.messages.at(-1)?.text).toContain("<b>🌿 STORE CATALOG</b>");
    expect(telegram.messages.at(-1)?.text).toContain("Best sellers in stock, tap a product to view details.");
    expect(telegram.messages.at(-1)?.text).not.toContain("Column 1");
    expect(telegram.messages.at(-1)?.text).toContain("<b>🍃 Category: Fruit</b> (2 codes)");
    expect(telegram.messages.at(-1)?.text).toContain("<b>#1 Mint Medium Pouch</b>");
    expect(telegram.messages.at(-1)?.text).not.toContain("SKU");
    expect(telegram.messages.at(-1)?.text).toContain("~$");
    expect(telegram.messages.at(-1)?.options?.parse_mode).toBe("HTML");
    const keyboard = telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard || [];
    expect(keyboard[0]).toHaveLength(2);
    const catalogButtons = keyboard.flat();
    expect(catalogButtons.find((button) => button.text.includes("Category: Mint") && button.callback_data.startsWith("sales_category:"))).toBeTruthy();
    expect(catalogButtons.find((button) => button.callback_data === "sales_detail:catalog-92:1")).toMatchObject({
      text: expect.stringContaining("#1"),
      callback_data: "sales_detail:catalog-92:1",
    });
  });

  it("blocks operator commands for unmapped public customers before privileged backend calls", async () => {
    backend.operatorLinked = false;

    await handle("/orders", 913);

    expect(backend.getMeCalls).toEqual(["42"]);
    expect(backend.listOrdersCalls).toEqual([]);
    expect(backend.sessions.get("42")).toBeUndefined();
    expect(telegram.messages.at(-1)?.text).toContain("Operator access is not linked");
    expect(telegram.messages.at(-1)?.text).toContain("/link");
  });

  it("allows linked operators to run operator commands after the guard succeeds", async () => {
    await handle("/orders", 914);

    expect(backend.getMeCalls).toEqual(["42"]);
    expect(backend.listOrdersCalls).toEqual([{ userId: "42", limit: 5 }]);
    expect(telegram.messages.at(-1)?.text).toContain("Don hang gan nhat:");
    expect(telegram.messages.at(-1)?.text).toContain("ORD-1");
  });

  it("renders top catalog category counts without prices and full-width product CTAs", async () => {
    const categoryFixtures = [
      { name: "CUBA - 220k", handle: "cuba" },
      { name: "CLEW - 220k", handle: "clew" },
      { name: "LOOP - 200k", handle: "loop" },
      { name: "PABLO - 250k", handle: "pablo" },
    ];
    backend.listTelegramSalesCatalog = async (_userId?: string, _q?: string, limit = 20) => ({
      data: Array.from({ length: 20 }, (_, index) => {
        const category = categoryFixtures[Math.floor(index / 5)] || { name: "Other", handle: "other" };
        const categoryDisplayName = category.name.split(" - ")[0];
        return {
          productId: `prod_${index + 1}`,
          variantId: `var_${index + 1}`,
          title: `${categoryDisplayName} Product ${index + 1}`,
          status: "published",
          imageUrl: `https://cdn.example.test/${index + 1}.jpg`,
          categories: [{ id: `cat_${category.handle}`, name: category.name, handle: category.handle }],
          categoryName: category.name,
          categoryHandle: category.handle,
          sku: `${categoryDisplayName}-${index + 1}`,
          barcode: "",
          price: 220000 + index * 1000,
          currencyCode: "vnd",
          availability: "available",
          canOrder: true,
          salesQuantity: 100 - index,
          salesRank: index + 1,
        };
      }).slice(0, limit),
    });

    await handle("/products", 921);

    const keyboard = telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard || [];
    expect(keyboard[0]).toHaveLength(2);
    expect(keyboard[1]).toHaveLength(2);
    expect(keyboard[0][0].text).toBe("🌿 Category: CLEW (5)");
    expect(keyboard[0][1].text).toBe("🌿 Category: CUBA (5)");
    expect(keyboard[1][0].text).toBe("🌿 Category: LOOP (5)");
    expect(keyboard[1][1].text).toBe("🌿 Category: PABLO (5)");
    const productRows = keyboard.slice(2, 22);
    expect(productRows.every((row) => row.length === 1)).toBe(true);
    const cubaProductButton = productRows.flat().find((button) => button.text.includes("CUBA Product 1"));
    expect(cubaProductButton?.text).toBe("🌿 #1 CUBA Product 1 · 220k VND · ~$8.5");
    expect(cubaProductButton?.text).not.toContain("…");
    expect(cubaProductButton?.callback_data).toMatch(/^sales_detail:catalog-921:\d+$/);
    expect(productRows.filter((row) => row[0].callback_data.startsWith("sales_detail:"))).toHaveLength(20);
    expect(telegram.messages.at(-1)?.text).toContain("<b>🌿 Category: CUBA</b>");
    expect(telegram.messages.at(-1)?.text).not.toContain("<b>🌿 Category: CUBA - 220k</b>");
    expect(telegram.messages.at(-1)?.text).not.toContain("├");
    expect(telegram.messages.at(-1)?.text).not.toContain("└ top");
  });

  it("lets customer choose Russian language and keeps Russian CTAs", async () => {
    await handle("/language", 190);

    expect(telegram.messages.at(-1)?.text).toContain("Language");
    expect(telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard?.[0][1]).toEqual({
      text: "🇷🇺 Русский",
      callback_data: "sales_lang:ru",
    });

    await handleUpdate(
      callback("sales_lang:ru", 191),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );

    expect(telegram.messages.at(-2)?.text).toContain("русский");
    expect(telegram.messages.at(-2)?.options?.reply_markup?.keyboard?.[0][0]).toEqual({ text: "🌿 Каталог" });
    expect(telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard?.[0][0]).toEqual({
      text: "🌿 Смотреть snus",
      callback_data: "sales_menu:products",
    });
  });

  it("renders Russian sales templates with RUB estimates and HTML formatting", async () => {
    await handle("/language", 201);
    await handleUpdate(
      callback("sales_lang:ru", 202),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );

    await handle("/products", 203);
    expect(telegram.messages.at(-1)?.text).toContain("<b>🌿 КАТАЛОГ: STORE</b>");
    expect(telegram.messages.at(-1)?.text).toContain("₽");
    expect(telegram.messages.at(-1)?.text).not.toContain("SKU");
    expect(telegram.messages.at(-1)?.options?.parse_mode).toBe("HTML");

    await handleUpdate(
      callback("sales_detail:catalog-203:1", 204),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );
    expect(telegram.photos.at(-1)?.options?.caption).toContain("💰 Цена:");
    expect(telegram.photos.at(-1)?.options?.caption).toContain("🆔 SKU: <code>MINT-MED</code>");
    expect(telegram.photos.at(-1)?.options?.caption).toContain("₽");
    expect(telegram.photos.at(-1)?.options?.parse_mode).toBe("HTML");

    await handleUpdate(
      callback("sales_select:catalog-203:1x2", 205),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );
    expect(telegram.messages.at(-1)?.text).toContain("🛒 <b>ВАША КОРЗИНА</b>");
    expect(telegram.messages.at(-1)?.text).toContain("Примерный итог");
    expect(telegram.messages.at(-1)?.text).toContain("₽");
    expect(telegram.messages.at(-1)?.text).not.toContain("SKU MINT-MED");

    await handle("🧾 Мои заявки", 206);
    expect(telegram.messages.at(-1)?.text).toContain("🧾 <b>МОИ ЗАЯВКИ</b>");
    expect(telegram.messages.at(-1)?.text).toContain("Статусы:");
    expect(telegram.messages.at(-1)?.text).toContain("₽");
  });

  it("opens a category CTA with a representative cover image and in-stock category products", async () => {
    await handle("/products", 501);
    const categoryCallback = telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard?.flat()
      .find((button) => button.callback_data.startsWith("sales_category:") && button.text.includes("Fruit"))?.callback_data || "";

    await handleUpdate(
      callback(categoryCallback, 502),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );

    expect(telegram.answeredCallbacks.at(-1)).toMatchObject({ text: "Fruit" });
    expect(telegram.photos.at(-1)?.photo).toBe("https://cdn.example.test/berry.jpg");
    expect(telegram.photos.at(-1)?.options?.caption).toContain("Fruit");
    expect(telegram.messages.at(-1)?.text).toContain("Fruit");
    expect(telegram.messages.at(-1)?.text).toContain("Berry Strong Pouch");
    expect(telegram.messages.at(-1)?.text).toContain("Citrus Low Pouch");
    expect(telegram.messages.at(-1)?.text).not.toContain("Coffee Medium");
  });

  it("prompts for natural-language AI search and returns up to eight product CTAs", async () => {
    await handle("/products", 510);
    const aiSearchCallback = telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard?.flat()
      .find((button) => button.callback_data.startsWith("sales_ai_search:"))?.callback_data || "";

    await handleUpdate(
      callback(aiSearchCallback, 511),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );

    expect(backend.sessions.get("42")?.pendingAction).toBe("ai_catalog_search");
    expect(telegram.messages.at(-1)?.text).toContain("Tell me what you want to find");

    await handle("strong mint slim", 512);

    expect(backend.draftAiOrderCalls).toBe(1);
    expect(telegram.messages.at(-1)?.text).toContain("🔎 <b>Search Results</b>");
    expect(telegram.messages.at(-1)?.text).toContain('For: <i>"strong mint slim"</i>');
    expect(telegram.messages.at(-1)?.text).toContain("<b>#1 Mint Medium Pouch</b>");
    expect(telegram.messages.at(-1)?.text).toContain("✅ Available");
    expect(telegram.messages.at(-1)?.text).not.toContain("SKU");
    expect(telegram.messages.at(-1)?.options?.parse_mode).toBe("HTML");
    expect(backend.sessions.get("42")?.lastCatalogMode).toBe("ai");
    const productButtons = telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard?.flat()
      .filter((button) => button.callback_data.startsWith("sales_detail:")) || [];
    expect(productButtons.length).toBeGreaterThan(0);
    expect(productButtons.length).toBeLessThanOrEqual(8);
  });

  it("supports Cancel menu text and returns the persistent customer menu", async () => {
    await handle("/products", 93);
    await handle("Cancel", 94);

    expect(backend.sessions.get("42")).toBeUndefined();
    expect(telegram.messages.at(-1)?.text).toContain("Current action cleared");
    expect(telegram.messages.at(-1)?.options?.reply_markup?.keyboard?.[0][0]).toEqual({ text: "🌿 Catalog" });
  });

  it("shows a customer action menu and opens support from an inline button", async () => {
    await handle("📋 Khác(rút tiền, liên hệ, hh...)", 95);

    expect(telegram.messages.at(-1)?.text).toContain("Choose a quick action");
    expect(telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard?.[0][0]).toEqual({
      text: "🌿 Browse snus",
      callback_data: "sales_menu:products",
    });

    await handleUpdate(
      callback("sales_menu:support", 96),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );

    expect(telegram.answeredCallbacks.at(-1)).toMatchObject({ text: "Support" });
    expect(telegram.messages.at(-1)?.text).toContain("💬 Support");
    expect(telegram.messages.at(-1)?.options?.reply_markup?.keyboard?.[0][0]).toEqual({ text: "🌿 Catalog" });
  });

  it("lists customer request history with paging and detail callbacks", async () => {
    await handle("🧾 My requests", 97);

    expect(backend.historyCalls).toEqual([{ userId: "42", limit: 5, offset: 0 }]);
    expect(telegram.messages.at(-1)?.text).toContain("🧾 <b>MY REQUESTS</b>");
    expect(telegram.messages.at(-1)?.text).toContain("Total requests: 6 | Page 1/2");
    expect(telegram.messages.at(-1)?.text).toContain("✅ Confirmed: 3");
    expect(telegram.messages.at(-1)?.text).toContain("Mint Medium Pouch x2");
    expect(telegram.messages.at(-1)?.options?.parse_mode).toBe("HTML");
    const keyboard = telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard || [];
    expect(keyboard[0][0]).toMatchObject({
      text: expect.stringContaining("#1 ✅ tsd_2"),
      callback_data: "sales_history_detail:history-97:1",
    });
    expect(keyboard[1][0]).toMatchObject({ text: "Next ▶", callback_data: "sales_menu:history:5" });

    await handleUpdate(
      callback("sales_history_detail:history-97:1", 98),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );

    expect(telegram.answeredCallbacks.at(-1)).toMatchObject({ text: "Request detail" });
    expect(telegram.messages.at(-1)?.text).toContain("<b>Request #1</b>");
    expect(telegram.messages.at(-1)?.text).toContain("Store order: <code>order_telegram_1</code>");
    expect(telegram.messages.at(-1)?.text).toContain("<b>Delivery Address:</b>");
    expect(telegram.messages.at(-1)?.text).toContain("<i>22 Example Street</i>");
    expect(telegram.messages.at(-1)?.options?.parse_mode).toBe("HTML");

    await handleUpdate(
      callback("sales_menu:history:5", 99),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );

    expect(backend.historyCalls.at(-1)).toEqual({ userId: "42", limit: 5, offset: 5 });
  });

  it("creates a remote order only after exact confirmation and reuses the draft idempotency key", async () => {
    await handle("/create_order var_mint:2,var_citrus:1 payment=cod customer=cus_1 note=Giao chieu", 101);
    expect(telegram.messages.at(-1)?.text).toContain("CONFIRM ORDER order-101");
    expect(backend.sessionExpiresAt.get("42")).toEqual(expect.any(String));
    expect(new Date(String(backend.sessionExpiresAt.get("42"))).getTime()).toBeGreaterThan(Date.now());

    await handle("CONFIRM ORDER order-101", 102);

    expect(backend.createdOrders).toHaveLength(1);
    expect(backend.createdOrders[0]).toMatchObject({
      userId: "42",
      idempotencyKey: "telegram:101:create_order:order-101",
      input: {
        customerId: "cus_1",
        paymentMethod: "cod",
        note: "Giao chieu",
      },
    });
    expect(backend.createdOrders[0].input.items).toEqual([
      { variantId: "var_mint", quantity: 2 },
      { variantId: "var_citrus", quantity: 1 },
    ]);
    expect(telegram.messages.at(-1)?.text).toContain("Da tao don remote.");
  });

  it("rejects expired text confirmations without mutating orders", async () => {
    await handle("/create_order var_mint:1 payment=cod", 105);
    expect(telegram.messages.at(-1)?.text).toContain("CONFIRM ORDER order-105");
    backend.sessionExpiresAt.set("42", new Date(Date.now() - 1000).toISOString());

    await handle("CONFIRM ORDER order-105", 106);

    expect(backend.createdOrders).toHaveLength(0);
    expect(telegram.messages.at(-1)?.text).toContain("Khong co don remote nao dang cho xac nhan.");
  });

  it("creates a remote order through the inline confirmation keyboard", async () => {
    await handle("/create_order var_mint:1 payment=cod", 111);
    expect(telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard[0][0]).toEqual({
      text: "Xac nhan",
      callback_data: "confirm:create_order:order-111",
    });

    await handleUpdate(
      callback("confirm:create_order:order-111", 112),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );

    expect(telegram.answeredCallbacks).toContainEqual({ id: "callback_112", text: "Dang xu ly" });
    expect(backend.createdOrders).toHaveLength(1);
    expect(backend.createdOrders[0]).toMatchObject({
      userId: "42",
      idempotencyKey: "telegram:111:create_order:order-111",
      input: { paymentMethod: "cod" },
    });
    expect(telegram.messages.at(-1)?.text).toContain("Da tao don remote.");

    await handleUpdate(
      callback("confirm:create_order:order-111", 113),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );

    expect(backend.createdOrders).toHaveLength(1);
    expect(telegram.messages.at(-1)?.text).toContain("Khong co lenh nao dang cho xac nhan.");
  });

  it("creates an AI-assisted remote order draft through deterministic product matching", async () => {
    await handle("/ai_order 2 hop mint medium cho khach quen", 131);
    expect(telegram.messages.at(-1)?.text).toContain("AI da tao ban nhap don remote:");
    expect(telegram.messages.at(-1)?.text).toContain("Mint Medium Pouch");

    await handle("CONFIRM ORDER ai-order-131", 132);

    expect(backend.createdOrders).toHaveLength(1);
    expect(backend.createdOrders[0]).toMatchObject({
      userId: "42",
      idempotencyKey: "telegram:131:create_order:ai-order-131",
      input: {
        paymentMethod: "cod",
        note: "AI Telegram draft: 2 hop mint medium cho khach quen",
      },
    });
    expect(backend.createdOrders[0].input.items).toEqual([{ variantId: "var_mint", quantity: 2 }]);
  });

  it("preserves a uniquely resolved AI customer on the pending remote order", async () => {
    backend.draftAiOrderResponse = {
      items: [{ variantId: "var_mint", quantity: 1, productName: "Mint Medium Pouch", sku: "MINT-MED" }],
      customerId: "cus_demo",
      paymentMethod: "cod",
      note: "AI Telegram draft: mint",
      confidence: "medium",
      parser: "deterministic",
      queryText: "mint medium",
      clarification: null,
    };

    await handle("/ai_order MINT-MED customer=0901234567", 137);

    expect(backend.sessions.get("42")?.orderDraft).toMatchObject({ customerId: "cus_demo" });
    expect(telegram.messages.at(-1)?.text).toContain("Khach: cus_demo");
  });

  it("creates a payment intent instead of a posted order when AI order asks for QR payment", async () => {
    await handle("/ai_order 2 hop mint medium chuyen khoan QR", 133);
    expect(telegram.messages.at(-1)?.text).toContain("Thanh toan: sepay_va");

    await handle("CONFIRM ORDER ai-order-133", 134);

    expect(backend.createdOrders).toHaveLength(0);
    expect(backend.paymentIntents).toHaveLength(1);
    expect(backend.paymentIntents[0]).toMatchObject({
      userId: "42",
      idempotencyKey: "telegram:133:create_order:ai-order-133:payment_intent",
      input: {
        paymentMethod: "sepay_va",
        note: "AI Telegram draft: 2 hop mint medium chuyen khoan QR",
      },
    });
    expect(telegram.messages.at(-1)?.text).toContain("Da tao payment intent remote.");
    expect(telegram.messages.at(-1)?.text).toContain("Reference: PITELEGRAM1");
  });

  it("blocks AI order commands when the AI ordering kill switch is disabled", async () => {
    await handle("/order 2 hop mint medium", 139, { aiOrderingEnabled: false });

    expect(backend.draftAiOrderCalls).toBe(0);
    expect(backend.searchProductsCalls).toBe(0);
    expect(backend.createdOrders).toHaveLength(0);
    expect(backend.paymentIntents).toHaveLength(0);
    expect(backend.sessions.get("42")?.lastCatalogMode).toBe("ai");
    expect(telegram.messages.at(-1)?.text).toContain("🔎 <b>Search Results</b>");
  });

  it("does not use deterministic fallback when AI draft route rejects entitlement or permission", async () => {
    backend.draftAiOrderError = new BackendApiErrorValue(
      403,
      "feature_not_entitled",
      "Current package does not include feature: telegram_ai_ordering",
      { feature: "telegram_ai_ordering", packageKey: "basic" },
    );

    await handle("/order 2 hop mint medium", 140, { aiOrderingEnabled: true });

    expect(backend.draftAiOrderCalls).toBe(1);
    expect(backend.searchProductsCalls).toBe(0);
    expect(backend.createdOrders).toHaveLength(0);
    expect(backend.paymentIntents).toHaveLength(0);
    expect(backend.sessions.get("42")).toBeUndefined();
    expect(telegram.messages.at(-1)?.text).toContain("Current package does not include feature");
  });

  it("sends customer cart checkout requests to the staff sales draft inbox without creating an order", async () => {
    await handle("/order 2 hop mint medium", 141);
    expect(telegram.messages.at(-1)?.text).toContain("Added the matched product to your cart.");
    expect(telegram.messages.at(-1)?.text).toContain("1️⃣ <b>Mint Medium Pouch</b>");
    expect(telegram.messages.at(-1)?.text).toContain("└ 2 x 250k VND = 500.000 VND");
    expect(telegram.messages.at(-1)?.text).not.toContain("SKU MINT-MED");

    await handleUpdate(
      callback("sales_cart:checkout", 142),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );
    expect(telegram.messages.at(-1)?.text).toContain("Send your delivery address below to checkout");
    expect(telegram.messages.at(-1)?.options?.parse_mode).toBe("HTML");

    await handle("22 Example Street", 143);
    expect(telegram.messages.at(-1)?.text).toContain("📝 <b>PLEASE REVIEW YOUR ORDER</b>");
    expect(telegram.messages.at(-1)?.text).toContain("<b>Delivery Address:</b>");
    expect(telegram.messages.at(-1)?.text).toContain("<i>22 Example Street</i>");
    expect(telegram.messages.at(-1)?.text).toContain("🧾 Total: <b>500.000 VND");
    expect(telegram.messages.at(-1)?.text).toContain("CONFIRM REQUEST request-143");
    expect(telegram.messages.at(-1)?.options?.parse_mode).toBe("HTML");
    expect(telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard[0][0]).toEqual({
      text: "✅ Send to shop",
      callback_data: "confirm:sales_draft:request-143",
    });

    await handle("CONFIRM REQUEST request-143", 144);

    expect(backend.createdOrders).toHaveLength(0);
    expect(backend.paymentIntents).toHaveLength(0);
    expect(backend.salesDrafts).toHaveLength(1);
    expect(backend.salesDrafts[0]).toMatchObject({
      userId: "42",
      idempotencyKey: "telegram:143:sales_draft:request-143",
      input: {
        delivery: { address: "22 Example Street" },
        items: [{ variantId: "var_mint", quantity: 2 }],
      },
    });
    expect(telegram.messages.at(-1)?.text).toContain("✅ <b>REQUEST SENT</b>");
    expect(telegram.messages.at(-1)?.text).toContain("within 5 minutes");
    expect(telegram.messages.at(-1)?.options?.parse_mode).toBe("HTML");
  });

  it("lets customer order by product number from the latest catalog", async () => {
    await handle("/products", 143);
    expect(telegram.messages.at(-1)?.text).toContain("<b>🌿 STORE CATALOG</b>");
    const buttons = telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard?.flat() || [];
    expect(buttons.find((button) => button.callback_data === "sales_detail:catalog-143:1")).toMatchObject({
      text: expect.stringContaining("#1"),
      callback_data: "sales_detail:catalog-143:1",
    });
    expect(backend.sessions.get("42")?.lastCatalogItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        index: 1,
        variantId: "var_mint",
        title: "Mint Medium Pouch",
        sku: "MINT-MED",
        imageUrl: "https://cdn.example.test/mint.jpg",
      }),
    ]));

    await handle("/order 1 x2", 144, { aiOrderingEnabled: false });
    expect(backend.draftAiOrderCalls).toBe(0);
    expect(telegram.messages.at(-1)?.text).toContain("Added: Mint Medium Pouch x2");
    expect(telegram.messages.at(-1)?.text).toContain("Mint Medium Pouch");

    await handleUpdate(
      callback("sales_cart:checkout", 145),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );
    await handle("District 1, test address", 146);
    expect(telegram.messages.at(-1)?.text).toContain("CONFIRM REQUEST request-146");

    await handle("CONFIRM REQUEST request-146", 147);

    expect(backend.createdOrders).toHaveLength(0);
    expect(backend.salesDrafts).toHaveLength(1);
    expect(backend.salesDrafts[0]).toMatchObject({
      userId: "42",
      idempotencyKey: "telegram:146:sales_draft:request-146",
      input: {
        delivery: { address: "District 1, test address" },
        items: [{ variantId: "var_mint", quantity: 2 }],
      },
    });
  });

  it("lets customer order by plain product number text after browsing products", async () => {
    await handle("/products", 154);

    await handle("1 x2", 155, { aiOrderingEnabled: false });

    expect(backend.draftAiOrderCalls).toBe(0);
    expect(telegram.messages.at(-1)?.text).toContain("Added: Mint Medium Pouch x2");
    expect(telegram.messages.at(-1)?.text).toContain("Mint Medium Pouch");

    await handleUpdate(
      callback("sales_cart:checkout", 156),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );
    await handle("District 1, address", 157);
    await handle("CONFIRM REQUEST request-157", 158);

    expect(backend.createdOrders).toHaveLength(0);
    expect(backend.salesDrafts).toHaveLength(1);
    expect(backend.salesDrafts[0]).toMatchObject({
      userId: "42",
      idempotencyKey: "telegram:157:sales_draft:request-157",
      input: {
        delivery: { address: "District 1, address" },
        items: [{ variantId: "var_mint", quantity: 2 }],
      },
    });
  });

  it("routes plain customer order text to the AI-assisted sales request path", async () => {
    await handle("2 hop mint medium", 157);

    expect(backend.draftAiOrderCalls).toBe(1);
    expect(telegram.messages.at(-1)?.text).toContain("Added the matched product to your cart.");
    expect(telegram.messages.at(-1)?.text).toContain("Mint Medium Pouch");

    await handleUpdate(
      callback("sales_cart:checkout", 158),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );
    await handle("District 1, address", 159);
    await handle("CONFIRM REQUEST request-159", 160);

    expect(backend.createdOrders).toHaveLength(0);
    expect(backend.salesDrafts).toHaveLength(1);
    expect(backend.salesDrafts[0]).toMatchObject({
      userId: "42",
      idempotencyKey: "telegram:159:sales_draft:request-159",
      input: {
        delivery: { address: "District 1, address" },
        items: [{ variantId: "var_mint", quantity: 2 }],
      },
    });
  });

  it("preserves pending checkout TTL when opening request history before entering address", async () => {
    await handle("/order 2 hop mint medium", 159);
    await handleUpdate(
      callback("sales_cart:checkout", 160),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );
    const expiresAt = backend.sessionExpiresAt.get("42");
    expect(expiresAt).toEqual(expect.any(String));
    expect(backend.sessions.get("42")?.pendingAction).toBe("checkout_address");

    await handle("🧾 My requests", 161);

    expect(backend.sessionExpiresAt.get("42")).toBe(expiresAt);
    expect(backend.sessions.get("42")).toMatchObject({
      pendingAction: "checkout_address",
      lastCommand: "history",
    });

    await handle("District 1, address", 162);
    await handle("CONFIRM REQUEST request-162", 163);

    expect(backend.salesDrafts).toHaveLength(1);
    expect(backend.salesDrafts[0]).toMatchObject({
      idempotencyKey: "telegram:162:sales_draft:request-162",
    });
  });

  it("lets customer add a product from detail and submit after checkout address", async () => {
    await handle("/products", 147);
    const productCallback = telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard?.flat()
      .find((button) => button.callback_data === "sales_detail:catalog-147:1")?.callback_data || "";

    await handleUpdate(
      callback(productCallback, 148),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );
    const selectCallback = telegram.photos.at(-1)?.options?.reply_markup?.inline_keyboard?.[0][0].callback_data || "";
    await handleUpdate(
      callback(selectCallback, 149),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );

    expect(telegram.answeredCallbacks.at(-1)).toMatchObject({ text: "Added" });
    expect(telegram.messages.at(-1)?.text).toContain("Added: Mint Medium Pouch x1");
    expect(telegram.messages.at(-1)?.text).toContain("Mint Medium Pouch");

    await handleUpdate(
      callback("sales_cart:checkout", 150),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );
    await handle("District 1, address", 151);
    await handle("CONFIRM REQUEST request-151", 152);

    expect(backend.createdOrders).toHaveLength(0);
    expect(backend.salesDrafts).toHaveLength(1);
    expect(backend.salesDrafts[0]).toMatchObject({
      userId: "42",
      idempotencyKey: "telegram:151:sales_draft:request-151",
      input: {
        delivery: { address: "District 1, address" },
        items: [{ variantId: "var_mint", quantity: 1 }],
      },
    });
  });

  it("opens a product detail page with image and quantity CTAs", async () => {
    await handle("/products", 177);
    const detailCallback = telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard?.flat()
      .find((button) => button.callback_data === "sales_detail:catalog-177:1")?.callback_data || "";

    await handleUpdate(
      callback(detailCallback, 178),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );

    expect(telegram.answeredCallbacks.at(-1)).toMatchObject({ text: "Product detail" });
    expect(telegram.photos.at(-1)?.photo).toBe("https://cdn.example.test/mint.jpg");
    expect(telegram.photos.at(-1)?.options?.caption).toContain("<b>Mint Medium Pouch</b>");
    expect(telegram.photos.at(-1)?.options?.caption).toContain("🆔 SKU: <code>MINT-MED</code>");
    expect(telegram.photos.at(-1)?.options?.caption).toContain("<i>Choose a quick quantity below");
    expect(telegram.photos.at(-1)?.options?.caption).toContain("~$");
    expect(telegram.photos.at(-1)?.options?.parse_mode).toBe("HTML");
    expect(telegram.photos.at(-1)?.options?.reply_markup?.inline_keyboard?.[0]).toEqual([
      { text: "🧺 Add 1", callback_data: "sales_select:catalog-177:1" },
      { text: "🧺 Add 2", callback_data: "sales_select:catalog-177:1x2" },
    ]);
    expect(telegram.photos.at(-1)?.options?.reply_markup?.inline_keyboard?.[1]).toEqual([
      { text: "🧺 Add 5", callback_data: "sales_select:catalog-177:1x5" },
      { text: "🔢 Enter quantity", callback_data: "sales_quantity:catalog-177:1" },
    ]);

    await handleUpdate(
      callback("sales_quantity:catalog-177:1", 179),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );
    expect(telegram.messages.at(-1)?.text).toContain("Send the quantity as a number");
    expect(telegram.messages.at(-1)?.options?.parse_mode).toBe("HTML");

    await handle("3", 180);
    expect(telegram.messages.at(-1)?.text).toContain("Added: Mint Medium Pouch x3");
    expect(telegram.messages.at(-1)?.text).toContain("Estimated Subtotal");
  });

  it("rejects stale catalog product buttons after a newer catalog is loaded", async () => {
    await handle("/products", 150);
    const staleCallback = telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard?.flat()
      .find((button) => button.callback_data === "sales_detail:catalog-150:1")?.callback_data || "";
    await handle("/products mint", 151);

    await handleUpdate(
      callback(staleCallback, 152),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );

    expect(backend.salesDrafts).toHaveLength(0);
    expect(telegram.answeredCallbacks.at(-1)).toMatchObject({ text: "Catalog expired" });
    expect(telegram.messages.some((message) => message.text.includes("Catalog expired"))).toBe(true);
  });

  it("asks customer to browse products before ordering by product number", async () => {
    await handle("/order 1", 146);

    expect(backend.draftAiOrderCalls).toBe(0);
    expect(backend.salesDrafts).toHaveLength(0);
    expect(telegram.messages.at(-1)?.text).toContain("Use /products first");
  });

  it("asks for product clarification instead of creating a pending AI order when the draft is ambiguous", async () => {
    await handle("/order ambiguous mint", 135);

    expect(telegram.messages.at(-1)?.text).toContain("Options:");
    expect(telegram.messages.at(-1)?.text).toContain("MINT-MED");
    expect(telegram.messages.at(-1)?.text).toContain("MINT-SLIM");
    expect(telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard[0][0]).toMatchObject({
      text: "1. MINT-MED",
      callback_data: "ai_order_select:sales-clarify-135:0",
    });
    expect(backend.sessions.get("42")?.pendingAction).toBe("ai_order_clarification");
    expect(backend.createdOrders).toHaveLength(0);
    expect(backend.paymentIntents).toHaveLength(0);
  });

  it("continues an ambiguous AI order after selecting a SKU clarification button", async () => {
    await handle("/order ambiguous mint qr", 136);
    const selectCallback = telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard[0][0].callback_data || "";

    await handleUpdate(
      callback(selectCallback, 137),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );

    expect(telegram.answeredCallbacks.at(-1)).toMatchObject({ text: "Da chon SKU" });
    expect(telegram.messages.at(-1)?.text).toContain("Added the matched product to your cart.");
    expect(telegram.messages.at(-1)?.text).toContain("<b>Mint Medium Pouch</b>");
    expect(telegram.messages.at(-1)?.text).not.toContain("MINT-MED");

    await handleUpdate(
      callback("sales_cart:checkout", 138),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );
    await handle("District 1, address", 139);
    await handle("CONFIRM REQUEST request-139", 140);
    expect(backend.createdOrders).toHaveLength(0);
    expect(backend.paymentIntents).toHaveLength(0);
    expect(backend.salesDrafts).toHaveLength(1);
    expect(backend.salesDrafts[0].input.items).toEqual([{ variantId: "var_mint", quantity: 1 }]);
  });

  it("rejects stale inline confirmation buttons from an older pending draft", async () => {
    await handle("/create_order var_mint:1 payment=cod", 121);
    const staleCallback = telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard[0][0].callback_data || "";

    await handle("/create_order var_citrus:2 payment=cod", 122);
    const currentCallback = telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard[0][0].callback_data || "";

    await handleUpdate(
      callback(staleCallback, 123),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );
    expect(backend.createdOrders).toHaveLength(0);
    expect(telegram.messages.at(-1)?.text).toContain("Khong co lenh nao dang cho xac nhan.");

    await handleUpdate(
      callback(currentCallback, 124),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );
    expect(backend.createdOrders).toHaveLength(1);
    expect(backend.createdOrders[0].input.items).toEqual([{ variantId: "var_citrus", quantity: 2 }]);
  });

  it("records a full refund only after exact confirmation", async () => {
    await handle("/refund_order order_1 full Khach tra hang", 201);
    expect(telegram.messages.at(-1)?.text).toContain("CONFIRM REFUND order_1 refund-201");

    await handle("CONFIRM REFUND order_1 refund-201", 202);

    expect(backend.refunds).toHaveLength(1);
    expect(backend.refunds[0]).toMatchObject({
      userId: "42",
      orderId: "order_1",
      idempotencyKey: "telegram:201:refund_order:order_1",
      input: {
        reason: "Khach tra hang",
        confirmationToken: "refund-201",
      },
    });
    expect(backend.refunds[0].input.amount).toBeUndefined();
    expect(telegram.messages.at(-1)?.text).toContain("Da ghi nhan refund.");
  });

  it("uses the stored idempotency key for cancel confirmation", async () => {
    await handle("/cancel_order order_1 het hang", 301);
    await handle("CONFIRM CANCEL order_1", 302);

    expect(backend.cancels).toEqual([
      { userId: "42", orderId: "order_1", idempotencyKey: "telegram:301:cancel_order:order_1" },
    ]);
  });

  it("lists AI review queue and confirms approve/reject mutations", async () => {
    await handle("/ai_queue", 401);
    expect(telegram.messages.at(-1)?.text).toContain("AI review queue:");
    expect(telegram.messages.at(-1)?.text).toContain("ai_1");

    await handle("/ai_approve ai_1 Text da sua", 402);
    expect(telegram.messages.at(-1)?.text).toContain("CONFIRM AI APPROVE ai_1");
    await handle("CONFIRM AI APPROVE ai_1", 403);
    expect(backend.approvals).toEqual([
      {
        userId: "42",
        actionId: "ai_1",
        approvedText: "Text da sua",
        idempotencyKey: "telegram:402:ai_approve:ai_1",
      },
    ]);

    await handle("/ai_reject ai_2 Sai tone", 404);
    expect(telegram.messages.at(-1)?.text).toContain("CONFIRM AI REJECT ai_2");
    await handle("CONFIRM AI REJECT ai_2", 405);
    expect(backend.rejections).toEqual([
      {
        userId: "42",
        actionId: "ai_2",
        reason: "Sai tone",
        idempotencyKey: "telegram:404:ai_reject:ai_2",
      },
    ]);
  });

  it("sends PDF receipts as Telegram documents", async () => {
    await handle("/receipt_pdf order_1", 501);

    expect(backend.sessions.get("42")?.lastCommand).toBe("receipt_pdf");
    expect(telegram.documents).toEqual([
      {
        chatId: 9001,
        filename: "order_1-receipt.pdf",
        contentType: "application/pdf",
        caption: "Receipt order_1",
      },
    ]);
  });

  it("returns accounting reports through the backend channel permission path", async () => {
    await handle("/accounting_report income from=2026-06-01 to=2026-06-15", 511);

    expect(backend.accountingReports).toEqual([
      {
        userId: "42",
        name: "income-statement",
        filters: { from: "2026-06-01", to: "2026-06-15" },
      },
    ]);
    expect(backend.sessions.get("42")).toMatchObject({
      lastCommand: "accounting_report",
      reportName: "income-statement",
      filters: { from: "2026-06-01", to: "2026-06-15" },
    });
    expect(telegram.messages.at(-1)?.text).toContain("Bao cao ke toan: Ket qua kinh doanh");
    expect(telegram.messages.at(-1)?.text).toContain("Doanh thu: 500.000 VND");
    expect(telegram.messages.at(-1)?.text).toContain("Loi nhuan rong: 130.000 VND");
  });

  it("shows traceable balance sheet equity components", async () => {
    await handle("/accounting_report balance asOf=2026-06-15", 512);

    expect(backend.accountingReports.at(-1)).toEqual({
      userId: "42",
      name: "balance-sheet",
      filters: { asOf: "2026-06-15" },
    });
    const text = telegram.messages.at(-1)?.text || "";
    expect(text).toContain("Von theo so cai: 250.000 VND");
    expect(text).toContain("Loi nhuan chua ket chuyen: 130.000 VND");
    expect(text).toContain("Tong von chu so huu: 380.000 VND");
    expect(text).toContain("Chenh lech can doi: 0 VND");
  });

  it("returns the same canonical payment-event dashboard facts for /report", async () => {
    await handle("/report", 513);

    expect(backend.dashboardCalls).toEqual(["42"]);
    expect(telegram.messages.at(-1)?.text).toContain(
      "tong tien da ghi nhan thu (gom VAT, shipping va khoan khac) 500.000 VND",
    );
    expect(telegram.messages.at(-1)?.text).toContain("Nguon tong hop: app.payment_events");
    expect(telegram.messages.at(-1)?.text).toContain("Report-as-of");
  });

  it("rejects invalid accounting report commands before calling the backend", async () => {
    await handle("/accounting_report unknown", 512);

    expect(backend.accountingReports).toHaveLength(0);
    expect(telegram.messages.at(-1)?.text).toContain("/accounting_report <income|balance|cash|tax>");
  });

  it("blocks mutating commands when the mutation kill switch is disabled", async () => {
    await handle("/create_order var_mint:1 payment=cod", 601, { mutationsEnabled: false });

    expect(backend.createdOrders).toHaveLength(0);
    expect(backend.sessions.get("42")).toBeUndefined();
    expect(telegram.messages.at(-1)?.text).toContain("Telegram mutations dang tam tat");
  });

  it("clears pending Telegram action from the inline cancel button", async () => {
    await handle("/cancel_order order_1 het hang", 701);
    expect(backend.sessions.get("42")?.pendingAction).toBe("cancel_order");
    const cancelCallback = telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard[0][1].callback_data || "";

    await handleUpdate(
      callback(cancelCallback, 702),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );

    expect(backend.sessions.get("42")).toBeUndefined();
    expect(backend.cancels).toHaveLength(0);
    expect(telegram.answeredCallbacks).toContainEqual({ id: "callback_702", text: "Da huy" });
    expect(telegram.messages.at(-1)?.text).toContain("Da huy trang thai");
  });

  it("does not clear a newer pending action from an older inline cancel button", async () => {
    await handle("/cancel_order order_old stale", 711);
    const staleCancelCallback = telegram.messages.at(-1)?.options?.reply_markup?.inline_keyboard[0][1].callback_data || "";

    await handle("/cancel_order order_new active", 712);
    expect(backend.sessions.get("42")?.orderId).toBe("order_new");

    await handleUpdate(
      callback(staleCancelCallback, 713),
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
    );

    expect(backend.sessions.get("42")?.orderId).toBe("order_new");
    expect(backend.cancels).toHaveLength(0);
    expect(telegram.answeredCallbacks).toContainEqual({ id: "callback_713", text: "Nut huy da het hieu luc" });
    expect(telegram.messages.at(-1)?.text).toContain("Nut huy nay da het hieu luc");
  });
});
