import {
  type AccountingReportFilters,
  type AccountingReportName,
  type AccountingReportResponse,
  BackendApiError,
  type AiOrderClarification,
  type AiOrderDraftResponse,
  BackendClient,
  type AiReviewQueueResponse,
  type DashboardResponse,
  type MutationResponse,
  type OrdersListResponse,
  type PaymentIntentResponse,
  type ProductListResponse,
  type RefundRequest,
  type RemoteOrderRequest,
  type TelegramSalesCatalogResponse,
  type TelegramSalesDraftRequest,
  type TelegramSalesDraftResponse,
  type TelegramSalesDraftSummary,
  type TelegramSalesDraftsResponse,
} from "./backend-client";
import { userMessageForError } from "./error-messages";
import { SessionStore } from "./session-store";
import type { TelegramApi, TelegramMessageOptions, TelegramUpdate } from "./telegram-api";

export interface HandlerOptions {
  mutationsEnabled?: boolean;
  aiOrderingEnabled?: boolean;
  merchantId?: string;
  storeId?: string;
}

type PendingAction =
  | "create_order"
  | "sales_draft"
  | "checkout_address"
  | "ai_catalog_search"
  | "product_quantity"
  | "refund_order"
  | "ai_approve"
  | "ai_reject"
  | "cancel_order";

type CustomerLanguage = "en" | "ru";

type CatalogSessionItem = {
  index: number;
  productId?: string;
  variantId: string;
  title: string;
  sku?: string;
  imageUrl?: string;
  categories?: Array<{ id: string; name: string; handle: string }>;
  categoryName?: string;
  categoryHandle?: string;
  currencyCode?: string;
  price?: number;
  availability?: string;
  canOrder?: boolean;
  salesQuantity?: number;
  salesRank?: number;
};

type HistorySessionItem = TelegramSalesDraftSummary & {
  index: number;
};

type CatalogCategoryGroup = CatalogCategorySessionItem & {
  items: CatalogSessionItem[];
};

type CatalogCategorySessionItem = {
  index: number;
  name: string;
  handle: string;
  count: number;
  imageUrl?: string;
};

type CartSessionItem = CatalogSessionItem & {
  quantity: number;
};

type CatalogOrderSelection =
  | { kind: "not_selection" }
  | { kind: "error"; message: string }
  | { kind: "selected"; item: CatalogSessionItem; quantity: number };

const CUSTOMER_MAX_LINE_QUANTITY = 99;
const OPERATOR_COMMANDS = new Set([
  "/me",
  "/stock",
  "/orders",
  "/report",
  "/accounting_report",
  "/receipt",
  "/receipt_pdf",
  "/ai_order",
  "/create_order",
  "/refund_order",
  "/ai_queue",
  "/ai_approve",
  "/ai_reject",
  "/cancel_order",
]);
const OPERATOR_CONFIRMATION_PREFIXES = [
  "CONFIRM ORDER ",
  "CONFIRM REFUND ",
  "CONFIRM AI APPROVE ",
  "CONFIRM AI REJECT ",
  "CONFIRM CANCEL ",
];

function isOperatorCommand(command: string): boolean {
  return OPERATOR_COMMANDS.has(command);
}

function isOperatorConfirmationText(upperText: string): boolean {
  return OPERATOR_CONFIRMATION_PREFIXES.some((prefix) => upperText.startsWith(prefix));
}

function operatorAccessMessage(error: unknown): string {
  if (error instanceof BackendApiError && error.code !== "channel_identity_unmapped") {
    return userMessageForError(error);
  }
  return [
    "Operator access is not linked for this Telegram account.",
    "Customers can still use Catalog, Cart, Requests, Language, and Support.",
    "Staff should link this Telegram account from POS Account > Telegram, then send /link <token> here.",
  ].join("\n");
}

async function ensureOperatorAccess(
  telegram: TelegramApi,
  backend: BackendClient,
  chatId: number,
  userId: string,
): Promise<boolean> {
  try {
    await backend.getMe(userId);
    return true;
  } catch (error) {
    await telegram.sendMessage(chatId, operatorAccessMessage(error));
    return false;
  }
}

function telegramUserId(update: TelegramUpdate): string | null {
  if (update.callback_query?.from?.id) return String(update.callback_query.from.id);
  return update.message?.from?.id ? String(update.message.from.id) : null;
}

function commandParts(text: string): { command: string; args: string } {
  const [rawCommand = "", ...rest] = text.trim().split(/\s+/);
  return {
    command: rawCommand.split("@")[0].toLowerCase(),
    args: rest.join(" ").trim(),
  };
}

function normalizedMenuText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/📦|🧾|☎️|❌|📋|💰|💸|🎁|🔄|🛍️|🛒|✨|🌐|💬|☰|🔎|⬅️|🚀|🇬🇧|🇷🇺|🌿|🧊|🧺|✅/gu, "")
    .replace(/[(),.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function customerMenuAlias(text: string): { command: string; args: string } | null {
  const normalized = normalizedMenuText(text);
  if (!normalized) return null;
  if ([
    "products",
    "product",
    "catalog",
    "browse products",
    "shop catalog",
    "shop",
    "xem san pham",
    "san pham",
    "browse snus",
    "каталог",
    "товары",
    "продукты",
  ].includes(normalized)) {
    return { command: "/products", args: "" };
  }
  if ([
    "menu",
    "main menu",
    "other",
    "more",
    "khac",
    "khac rut tien lien he hh",
    "tai khoan",
    "главное меню",
    "меню",
  ].includes(normalized)) {
    return { command: "/menu", args: "" };
  }
  if ([
    "history",
    "my requests",
    "request history",
    "lich su",
    "lich su mua",
    "don cua toi",
    "мои заявки",
    "история",
    "заказы",
    "cart",
    "basket",
    "checkout",
    "корзина",
  ].includes(normalized)) {
    return ["cart", "basket", "checkout", "корзина"].includes(normalized)
      ? { command: "/cart", args: "" }
      : { command: "/history", args: "" };
  }
  if ([
    "support",
    "contact",
    "help",
    "lien he",
    "ho tro",
    "ho tro lien he",
    "поддержка",
    "помощь",
    "контакт",
  ].includes(normalized)) {
    return { command: normalized === "help" ? "/help" : "/support", args: "" };
  }
  if (["language", "lang", "english russian", "язык", "английский русский"].includes(normalized)) {
    return { command: "/language", args: "" };
  }
  if (normalized === "start") {
    return { command: "/help", args: "" };
  }
  if (normalized === "cancel" || normalized === "clear" || normalized === "huy") {
    return { command: "/cancel", args: "" };
  }
  return null;
}

function cancelConfirmation(orderId: string): string {
  return `CONFIRM CANCEL ${orderId}`;
}

function orderConfirmation(code: string): string {
  return `CONFIRM ORDER ${code}`;
}

function salesDraftConfirmation(code: string): string {
  return `CONFIRM REQUEST ${code}`;
}

function refundConfirmation(orderId: string, code: string): string {
  return `CONFIRM REFUND ${orderId} ${code}`;
}

function aiApproveConfirmation(actionId: string): string {
  return `CONFIRM AI APPROVE ${actionId}`;
}

function aiRejectConfirmation(actionId: string): string {
  return `CONFIRM AI REJECT ${actionId}`;
}

function pendingString(state: Record<string, unknown>, key: string): string {
  const value = state[key];
  return typeof value === "string" ? value : "";
}

function pendingObject(state: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = state[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRemoteOrderDraft(value: Record<string, unknown>): RemoteOrderRequest | null {
  const items = Array.isArray(value.items)
    ? value.items.map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const variantId = typeof record.variantId === "string" ? record.variantId : "";
      const quantity = typeof record.quantity === "number" ? record.quantity : Number(record.quantity);
      return variantId && Number.isInteger(quantity) && quantity > 0 ? { variantId, quantity } : null;
    }).filter((item): item is { variantId: string; quantity: number } => Boolean(item))
    : [];

  if (items.length === 0) return null;
  return {
    items,
    customerId: typeof value.customerId === "string" ? value.customerId : undefined,
    paymentMethod: typeof value.paymentMethod === "string" ? value.paymentMethod : undefined,
    amountReceived: typeof value.amountReceived === "number" ? value.amountReceived : undefined,
    note: typeof value.note === "string" ? value.note : undefined,
  };
}

function asRefundDraft(value: Record<string, unknown>): RefundRequest | null {
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (!reason) return null;
  return {
    amount: typeof value.amount === "number" ? value.amount : undefined,
    reason,
    confirmationToken: typeof value.confirmationToken === "string" ? value.confirmationToken : undefined,
  };
}

function confirmationCode(updateId: number, action: string): string {
  return `${action}-${updateId}`;
}

function idempotencyKey(updateId: number, action: string, subject: string): string {
  return `telegram:${updateId}:${action}:${subject}`;
}

function bindingContext(options: HandlerOptions, userId: string): Record<string, unknown> {
  return {
    merchantId: options.merchantId || null,
    storeId: effectiveStoreId(options),
    telegramUserId: userId,
  };
}

function effectiveStoreId(options: HandlerOptions): string | null {
  return options.storeId || (!options.merchantId ? "store_default" : null);
}

function bindingMatches(state: Record<string, unknown>, options: HandlerOptions, userId: string): boolean {
  const binding = pendingObject(state, "binding");
  const expectedMerchantId = options.merchantId || null;
  const expectedStoreId = effectiveStoreId(options);
  const boundMerchantId = typeof binding.merchantId === "string" ? binding.merchantId : null;
  const boundStoreId = typeof binding.storeId === "string" ? binding.storeId : null;
  const boundUserId = typeof binding.telegramUserId === "string" ? binding.telegramUserId : "";
  return boundUserId === userId && boundMerchantId === expectedMerchantId && boundStoreId === expectedStoreId;
}

function requireStoreForAiOrder(options: HandlerOptions): string | null {
  return effectiveStoreId(options);
}

async function checkAiConfirmIfSupported(
  backend: BackendClient,
  userId: string,
  draft: RemoteOrderRequest,
  state: Record<string, unknown>,
  options: HandlerOptions,
): Promise<void> {
  const checker = (backend as BackendClient & { checkAiOrderConfirm?: BackendClient["checkAiOrderConfirm"] }).checkAiOrderConfirm;
  if (!checker || Object.keys(pendingObject(state, "aiOrderDraft")).length === 0) return;
  await checker.call(backend, userId, {
    ...draft,
    usageReservationToken: pendingString(pendingObject(state, "aiOrderDraft"), "usageReservationToken") || undefined,
    storeId: effectiveStoreId(options),
  });
}

function confirmationMessageOptions(action: PendingAction, token: string, language: CustomerLanguage = "en"): TelegramMessageOptions {
  const confirmLabel = action === "sales_draft"
    ? language === "ru" ? "✅ Отправить в магазин" : "✅ Send to shop"
    : "Xac nhan";
  const cancelLabel = action === "sales_draft"
    ? language === "ru" ? "❌ Отмена" : "❌ Cancel"
    : "Huy";
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: confirmLabel, callback_data: `confirm:${action}:${token}` },
        { text: cancelLabel, callback_data: `confirm:abort:${token}` },
      ]],
    },
  };
}

function aiOrderClarificationMessageOptions(clarification: AiOrderClarification, token: string): TelegramMessageOptions | undefined {
  if (clarification.type !== "product") return undefined;
  const options = (clarification.options || []).filter((option) => option.sku || option.variantId).slice(0, 5);
  if (options.length === 0) return undefined;
  return {
    reply_markup: {
      inline_keyboard: [
        ...options.map((option, index) => [{
          text: `${index + 1}. ${option.sku || option.variantId}`,
          callback_data: `ai_order_select:${token}:${index}`,
        }]),
        [{ text: "Huy", callback_data: `confirm:abort:${token}` }],
      ],
    },
  };
}

function shortButtonText(value: string, maxLength = 56): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value;
}

function withHtml(options: TelegramMessageOptions = {}): TelegramMessageOptions {
  return { ...options, parse_mode: "HTML" };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlBold(value: unknown): string {
  return `<b>${escapeHtml(value)}</b>`;
}

function htmlItalic(value: unknown): string {
  return `<i>${escapeHtml(value)}</i>`;
}

function htmlCode(value: unknown): string {
  return `<code>${escapeHtml(value)}</code>`;
}

function productIcon(item: Pick<CatalogSessionItem, "title" | "categoryName">): string {
  const text = `${item.title} ${item.categoryName || ""}`.toLowerCase();
  if (/(mint|ice|cool|frost|wintergreen|spearmint|peppermint)/i.test(text)) return "🧊";
  if (/(berry|citrus|lemon|lime|fruit|mango|grape|melon)/i.test(text)) return "🍃";
  if (/(strong|extra|max|power)/i.test(text)) return "⚡";
  return "🌿";
}

function categoryIcon(category: Pick<CatalogCategorySessionItem, "name">): string {
  const text = category.name.toLowerCase();
  if (/(mint|ice|cool|frost|wintergreen|spearmint|peppermint)/i.test(text)) return "🧊";
  if (/(berry|citrus|fruit|mango|grape|melon)/i.test(text)) return "🍃";
  if (/(strong|extra|max|power)/i.test(text)) return "⚡";
  return "🌿";
}

function displayCategoryName(value?: string): string {
  const raw = String(value || "Other").trim();
  const withoutPrice = raw
    .replace(/\s+[-–—|]\s*(?:[$₽]\s*)?\d+(?:[.,]\d+)?\s*(?:k|K|₫|đ|vnd|VND|usd|USD|rub|RUB|₽)?\s*$/u, "")
    .trim();
  return withoutPrice || raw || "Other";
}

function categoryButtonText(category: CatalogCategorySessionItem, language: CustomerLanguage): string {
  const label = language === "ru" ? "Категория" : "Category";
  return shortButtonText(`${categoryIcon(category)} ${label}: ${displayCategoryName(category.name)} (${category.count})`, 58);
}

function productButtonText(item: CatalogSessionItem, language: CustomerLanguage): string {
  return `${productIcon(item)} #${item.index} ${item.title} · ${formatPriceButton(item.price, language)}`;
}

function rowsOf<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

function catalogCategoryGroups(items: CatalogSessionItem[], maxGroups = 4): CatalogCategoryGroup[] {
  const groups = new Map<string, CatalogCategoryGroup>();
  for (const item of items.filter((candidate) => candidate.canOrder !== false && candidate.availability !== "out_of_stock")) {
    const handle = item.categoryHandle || item.categories?.[0]?.handle || "other";
    const name = item.categoryName || item.categories?.[0]?.name || "Other";
    const existing = groups.get(handle);
    if (existing) {
      existing.count += 1;
      existing.items.push(item);
      if (!existing.imageUrl && item.imageUrl) existing.imageUrl = item.imageUrl;
    } else {
      groups.set(handle, {
        index: 0,
        name,
        handle,
        count: 1,
        imageUrl: item.imageUrl,
        items: [item],
      });
    }
  }
  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, maxGroups)
    .map((group, index) => ({
      ...group,
      index: index + 1,
      items: group.items
        .slice()
        .sort((a, b) => Number(b.salesQuantity || 0) - Number(a.salesQuantity || 0) || Number(a.salesRank || 9999) - Number(b.salesRank || 9999) || a.title.localeCompare(b.title)),
    }));
}

function catalogMessageOptions(
  items: CatalogSessionItem[],
  categories: CatalogCategorySessionItem[],
  token: string,
  language: CustomerLanguage,
  mode: "top" | "category" | "ai" = "top",
): TelegramMessageOptions | undefined {
  const l = labels(language);
  const sellable = items.filter((item) => item.canOrder !== false && item.availability !== "out_of_stock").slice(0, mode === "top" ? 20 : 100);
  if (sellable.length === 0) return undefined;
  const categoryRows = mode === "top"
    ? rowsOf(categories.slice(0, 4).map((category) => ({
      text: categoryButtonText(category, language),
      callback_data: `sales_category:${token}:${category.index}`,
    })), 2)
    : [];
  const groupedProducts = mode === "top"
    ? catalogCategoryGroups(sellable).flatMap((group) => group.items.slice(0, 5))
    : sellable;
  const productButtons = groupedProducts.slice(0, mode === "top" ? 20 : 100).map((item) => ({
    text: productButtonText(item, language),
    callback_data: `sales_detail:${token}:${item.index}`,
  }));
  const productRows = productButtons.map((button) => [button]);
  return {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        ...categoryRows,
        ...productRows,
        [
          { text: l.refresh, callback_data: `sales_catalog_refresh:${token}` },
          { text: l.viewCart, callback_data: "sales_cart:view" },
        ],
        [{ text: shortButtonText(l.aiSearch, 64), callback_data: `sales_ai_search:${token}` }],
        [{ text: l.support, callback_data: "sales_menu:support" }],
      ],
    },
  };
}

function mainMenuInlineOptions(language: CustomerLanguage = "en"): TelegramMessageOptions {
  const l = labels(language);
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: l.browseProducts, callback_data: "sales_menu:products" }],
        [{ text: l.viewCart, callback_data: "sales_cart:view" }],
        [{ text: l.history, callback_data: "sales_menu:history:0" }],
        [{ text: l.chooseLanguage, callback_data: "sales_menu:language" }],
        [{ text: l.supportCta, callback_data: "sales_menu:support" }],
        [{ text: l.cancelCurrent, callback_data: "sales_menu:cancel" }],
      ],
    },
  };
}

function historyMessageOptions(items: HistorySessionItem[], token: string, result: TelegramSalesDraftsResponse, language: CustomerLanguage = "en"): TelegramMessageOptions {
  const l = labels(language);
  const navButtons = [];
  if (result.offset > 0) {
    navButtons.push({ text: language === "ru" ? "◀ Назад" : "◀ Previous", callback_data: `sales_menu:history:${Math.max(0, result.offset - result.limit)}` });
  }
  if (result.offset + result.limit < result.count) {
    navButtons.push({ text: language === "ru" ? "Дальше ▶" : "Next ▶", callback_data: `sales_menu:history:${result.offset + result.limit}` });
  }
  return {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        ...items.slice(0, 5).map((item) => [{
          text: shortButtonText(`#${item.index} ${historyStatusIcon(item.status)} ${shortRequestId(item.id)} · ${historyStatusLabel(item.status, language)}`, 58),
          callback_data: `sales_history_detail:${token}:${item.index}`,
        }]),
        ...(navButtons.length > 0 ? [navButtons] : []),
        [
          { text: l.catalog, callback_data: "sales_menu:products" },
          { text: l.support, callback_data: "sales_menu:support" },
        ],
      ],
    },
  };
}

function languageMessageOptions(selected: CustomerLanguage): TelegramMessageOptions {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: selected === "en" ? "✅ 🇬🇧 English" : "🇬🇧 English", callback_data: "sales_lang:en" },
          { text: selected === "ru" ? "✅ 🇷🇺 Русский" : "🇷🇺 Русский", callback_data: "sales_lang:ru" },
        ],
        [{ text: labels(selected).browseProducts, callback_data: "sales_menu:products" }],
      ],
    },
  };
}

function callbackConfirmationText(state: Record<string, unknown>, action: string, token: string): string | null {
  if (pendingString(state, "pendingAction") !== action) return null;
  if (!token || pendingString(state, "callbackToken") !== token) return null;

  if (action === "create_order") {
    const code = pendingString(state, "confirmCode");
    return code ? orderConfirmation(code) : null;
  }

  if (action === "sales_draft") {
    const code = pendingString(state, "confirmCode");
    return code ? salesDraftConfirmation(code) : null;
  }

  if (action === "refund_order") {
    const orderId = pendingString(state, "orderId");
    const code = pendingString(state, "confirmCode");
    return orderId && code ? refundConfirmation(orderId, code) : null;
  }

  if (action === "ai_approve") {
    const actionId = pendingString(state, "actionId");
    return actionId ? aiApproveConfirmation(actionId) : null;
  }

  if (action === "ai_reject") {
    const actionId = pendingString(state, "actionId");
    return actionId ? aiRejectConfirmation(actionId) : null;
  }

  if (action === "cancel_order") {
    const orderId = pendingString(state, "orderId");
    return orderId ? cancelConfirmation(orderId) : null;
  }

  return null;
}

function mutationsDisabled(options: HandlerOptions): boolean {
  return options.mutationsEnabled === false;
}

function aiOrderingDisabled(options: HandlerOptions): boolean {
  return options.aiOrderingEnabled === false;
}

async function sendMutationsDisabled(telegram: TelegramApi, chatId: number): Promise<void> {
  await telegram.sendMessage(chatId, "Telegram mutations dang tam tat. Cac lenh doc van hoat dong.");
}

async function sendAiOrderingDisabled(telegram: TelegramApi, chatId: number): Promise<void> {
  await telegram.sendMessage(chatId, "Telegram AI ordering dang tam tat. Cac lenh doc, /products va /create_order van hoat dong.");
}

const LANGUAGE_LABELS: Record<CustomerLanguage, Record<string, string>> = {
  en: {
    catalog: "🌿 Catalog",
    history: "🧾 My requests",
    language: "🌐 Language",
    support: "💬 Support",
    cart: "🧺 Cart",
    menu: "☰ Menu",
    cancel: "❌ Cancel",
    placeholder: "Search product or type: mint x2",
    browseProducts: "🌿 Browse snus",
    chooseLanguage: "🌐 Language / Язык",
    supportCta: "💬 Support",
    cancelCurrent: "❌ Cancel current action",
    backCatalog: "⬅️ Back to catalog",
    orderOne: "🧺 Add 1",
    orderTwo: "🧺 Add 2",
    orderFive: "🧺 Add 5",
    customQuantity: "🔢 Enter quantity",
    details: "✨ Details",
    checkout: "✅ Checkout",
    addMore: "🌿 Add more",
    clearCart: "❌ Clear cart",
    viewCart: "🧺 View cart",
    aiSearch: "🔎 Describe what you want",
    openCategory: "🧊 Open category",
    refresh: "🔄 Refresh",
    menuTitle: "☰ Menu",
    menuSubtitle: "Choose a quick action below.",
  },
  ru: {
    catalog: "🌿 Каталог",
    history: "🧾 Мои заявки",
    language: "🌐 Язык",
    support: "💬 Поддержка",
    cart: "🧺 Корзина",
    menu: "☰ Меню",
    cancel: "❌ Отмена",
    placeholder: "Найдите товар или напишите: mint x2",
    browseProducts: "🌿 Смотреть snus",
    chooseLanguage: "🌐 Language / Язык",
    supportCta: "💬 Поддержка",
    cancelCurrent: "❌ Отменить действие",
    backCatalog: "⬅️ Назад в каталог",
    orderOne: "🧺 Добавить 1",
    orderTwo: "🧺 Добавить 2",
    orderFive: "🧺 Добавить 5",
    customQuantity: "🔢 Ввести количество",
    details: "✨ Подробнее",
    checkout: "✅ Оформить",
    addMore: "🌿 Добавить еще",
    clearCart: "❌ Очистить",
    viewCart: "🧺 Корзина",
    aiSearch: "🔎 Написать, что нужно",
    openCategory: "🧊 Открыть категорию",
    refresh: "🔄 Обновить",
    menuTitle: "☰ Меню",
    menuSubtitle: "Выберите быстрое действие.",
  },
};

function normalizeCustomerLanguage(value: unknown): CustomerLanguage {
  return value === "ru" || value === "en" ? value : "en";
}

function languageFromState(state: Record<string, unknown>): CustomerLanguage {
  return normalizeCustomerLanguage(state.language);
}

function labels(language: CustomerLanguage): Record<string, string> {
  return LANGUAGE_LABELS[language];
}

function customerMenuMessageOptions(language: CustomerLanguage = "en"): TelegramMessageOptions {
  const l = labels(language);
  return {
    reply_markup: {
      keyboard: [
        [{ text: l.catalog }, { text: l.cart }],
        [{ text: l.history }, { text: l.language }],
        [{ text: l.support }, { text: l.menu }],
        [{ text: l.cancel }],
      ],
      resize_keyboard: true,
      is_persistent: true,
      input_field_placeholder: l.placeholder,
    },
  };
}

function formatVnd(value: number): string {
  return `${Math.round(Number(value || 0)).toLocaleString("vi-VN")} VND`;
}

function formatCurrencyMinor(value: number, currencyCode: string, exponent: number): string {
  const amount = Number(value || 0) / (10 ** exponent);
  return `${amount.toLocaleString("vi-VN", {
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  })} ${currencyCode}`;
}

function exchangeRate(envKey: string, fallback: number): number {
  const parsed = Number(process.env[envKey] || fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatVndShort(value: number): string {
  const amount = Math.round(Number(value || 0));
  if (amount >= 1000) return `${Math.round(amount / 1000).toLocaleString("vi-VN")}k VND`;
  return `${amount.toLocaleString("vi-VN")} VND`;
}

function formatUsdEstimate(vnd: number): string {
  const usd = Number(vnd || 0) / exchangeRate("TELEGRAM_PRICE_VND_PER_USD", 26000);
  return `~$${usd >= 10 ? usd.toFixed(0) : usd.toFixed(1)}`;
}

function formatRubEstimate(vnd: number): string {
  const rub = Number(vnd || 0) / exchangeRate("TELEGRAM_PRICE_VND_PER_RUB", 320);
  return `~₽${Math.round(rub).toLocaleString("ru-RU")}`;
}

function formatPriceWithEstimate(value: number | undefined, language: CustomerLanguage): string {
  const price = Number(value || 0);
  if (price <= 0) return language === "ru" ? "Цена уточняется" : "Price on request";
  return language === "ru"
    ? `${formatVnd(price)} (${formatRubEstimate(price)})`
    : `${formatVnd(price)} (${formatUsdEstimate(price)})`;
}

function formatPriceButton(value: number | undefined, language: CustomerLanguage): string {
  const price = Number(value || 0);
  if (price <= 0) return language === "ru" ? "Цена?" : "Price?";
  return language === "ru"
    ? `${formatVndShort(price)} · ${formatRubEstimate(price)}`
    : `${formatVndShort(price)} · ${formatUsdEstimate(price)}`;
}

function availabilityIcon(value?: string): string {
  if (value === "available") return "✅";
  if (value === "low_stock") return "⚠️";
  if (value === "out_of_stock") return "❌";
  return "•";
}

function formatAvailabilityWithIcon(value: string | undefined, language: CustomerLanguage): string {
  return `${availabilityIcon(value)} ${formatAvailability(value || "", language)}`;
}

function shortRequestId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8) || id.slice(0, 8);
}

function ordinalIcon(index: number): string {
  const icons = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
  return icons[index - 1] || `${index}.`;
}

function formatLineCalculation(item: Pick<CartSessionItem, "quantity" | "price">, language: CustomerLanguage): string {
  const quantity = Number(item.quantity || 0);
  const unitPrice = Number(item.price || 0);
  const lineTotal = quantity * unitPrice;
  return `${quantity} x ${formatVndShort(unitPrice)} = ${formatPriceWithEstimate(lineTotal, language)}`;
}

function isPaymentIntentMethod(method?: string): boolean {
  return method === "sepay_va" || method === "nowpayments";
}

function aiOrderPaymentHint(text: string): string {
  if (/\b(crypto|usdt|usdc|nowpayments)\b/i.test(text)) return "usdt";
  if (/\b(qr|sepay|ck)\b/i.test(text) || /(chuyen|chuyển)\s*(khoan|khoản)/i.test(text)) return "qr";
  return "cod";
}

function asAiOrderClarification(value: unknown): AiOrderClarification | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const options = Array.isArray(record.options)
    ? record.options
      .map((item) => item && typeof item === "object" ? item as Record<string, unknown> : null)
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item) => ({
        customerId: typeof item.customerId === "string" ? item.customerId : undefined,
        customerName: typeof item.customerName === "string" ? item.customerName : undefined,
        phone: typeof item.phone === "string" ? item.phone : undefined,
        productId: typeof item.productId === "string" ? item.productId : undefined,
        productName: typeof item.productName === "string" ? item.productName : undefined,
        variantId: typeof item.variantId === "string" ? item.variantId : undefined,
        sku: typeof item.sku === "string" ? item.sku : undefined,
        stock: typeof item.stock === "number" ? item.stock : Number(item.stock || 0),
      }))
    : [];
  return {
    type: typeof record.type === "string" ? record.type : "product",
    queryText: typeof record.queryText === "string" ? record.queryText : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
    options,
  };
}

function clarificationFromError(error: unknown): AiOrderClarification | null {
  if (!(error instanceof BackendApiError) || error.code !== "order_draft_needs_clarification") return null;
  const details = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {};
  return asAiOrderClarification(details.clarification) || {
    type: "product",
    queryText: typeof details.queryText === "string" ? details.queryText : undefined,
    message: "AI order can tim them thong tin san pham.",
    options: [],
  };
}

function formatAiOrderClarification(clarification: AiOrderClarification): string {
  const options = clarification.options || [];
  const lines = [
    clarification.message || "AI order can ban chon dung san pham.",
    clarification.queryText ? `Tu khoa: ${clarification.queryText}` : "",
  ].filter(Boolean);
  if (options.length > 0) {
    if (clarification.type === "customer") {
      lines.push(
        "Khach tim thay:",
        ...options.map((option, index) => `${index + 1}. ${option.customerName || option.customerId || "Khach"}${option.phone ? ` | ${option.phone}` : ""}`),
        "Gui lai /order voi customer=<so-dien-thoai> de chon dung khach.",
      );
    } else {
      lines.push(
        "Chon mot SKU/ma hang roi gui lai /order voi ten hoac SKU ro hon:",
        ...options.map((option, index) => [
          `${index + 1}. ${option.productName || option.variantId || "San pham"}`,
          option.sku ? `SKU ${option.sku}` : "",
          `ton ${Number(option.stock || 0)}`,
        ].filter(Boolean).join(" | ")),
      );
    }
  } else {
    lines.push("Thu /stock <tu khoa> de xem ma hang dang con.");
  }
  return lines.join("\n");
}

function aiOrderClarificationSelectionText(state: Record<string, unknown>, indexText: string): string | null {
  if (pendingString(state, "pendingAction") !== "ai_order_clarification") return null;
  const index = Number(indexText);
  if (!Number.isInteger(index) || index < 0) return null;
  const stored = pendingObject(state, "aiOrderClarification");
  const options = Array.isArray(stored.options) ? stored.options : [];
  const selected = options[index];
  if (!selected || typeof selected !== "object") return null;
  const record = selected as Record<string, unknown>;
  const sku = typeof record.sku === "string" ? record.sku : typeof record.variantId === "string" ? record.variantId : "";
  if (!sku) return null;
  const quantity = Number(stored.quantity || 1);
  const safeQuantity = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  const paymentHint = typeof stored.paymentHint === "string" ? stored.paymentHint : "cod";
  return `/order ${sku} x${safeQuantity} ${paymentHint}`.trim();
}

function formatTimestamp(value?: string): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function truncate(value: string, maxLength = 180): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

export function formatStockResults(result: ProductListResponse): string {
  if (result.data.length === 0) return "Khong tim thay san pham phu hop.";

  return [
    "Ton kho:",
    ...result.data.map((product) => {
      const variants = product.variants.map((variant) => [
        `- ${variant.sku || variant.id}`,
        `ton ${variant.inventory_quantity}`,
        `gia ${formatVnd(variant.prices[0]?.amount || 0)}`,
      ].join(" | "));
      return [product.title, ...variants].join("\n");
    }),
  ].join("\n\n");
}

function formatAvailability(value: string, language: CustomerLanguage = "en"): string {
  if (language === "ru") {
    if (value === "available") return "В наличии";
    if (value === "low_stock") return "Осталось мало";
    if (value === "out_of_stock") return "Нет в наличии";
    return value || "Неизвестно";
  }
  if (value === "available") return "Available";
  if (value === "low_stock") return "Low stock";
  if (value === "out_of_stock") return "Out of stock";
  return value || "Unknown";
}

function catalogSessionItems(result: TelegramSalesCatalogResponse): CatalogSessionItem[] {
  return result.data.slice(0, 100).map((item, index) => ({
    index: index + 1,
    productId: item.productId,
    variantId: item.variantId,
    title: item.title,
    sku: item.sku,
    imageUrl: item.imageUrl,
    categories: item.categories,
    categoryName: item.categoryName || item.categories?.[0]?.name,
    categoryHandle: item.categoryHandle || item.categories?.[0]?.handle,
    currencyCode: item.currencyCode,
    price: item.price,
    availability: item.availability,
    canOrder: item.canOrder,
    salesQuantity: item.salesQuantity,
    salesRank: item.salesRank,
  }));
}

function asCatalogSessionItems(value: unknown): CatalogSessionItem[] {
  if (!Array.isArray(value)) return [];
  const items: CatalogSessionItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const index = Number(record.index);
    const variantId = typeof record.variantId === "string" ? record.variantId : "";
    const title = typeof record.title === "string" ? record.title : "";
    if (!Number.isInteger(index) || index < 1 || !variantId || !title) continue;
    items.push({
      index,
      productId: typeof record.productId === "string" ? record.productId : undefined,
      variantId,
      title,
      sku: typeof record.sku === "string" ? record.sku : undefined,
      imageUrl: typeof record.imageUrl === "string" ? record.imageUrl : undefined,
      categories: Array.isArray(record.categories)
        ? record.categories
          .map((category) => category && typeof category === "object" ? category as Record<string, unknown> : null)
          .filter((category): category is Record<string, unknown> => Boolean(category))
          .map((category) => ({
            id: typeof category.id === "string" ? category.id : "",
            name: typeof category.name === "string" ? category.name : "",
            handle: typeof category.handle === "string" ? category.handle : "",
          }))
          .filter((category) => category.id || category.name || category.handle)
        : undefined,
      categoryName: typeof record.categoryName === "string" ? record.categoryName : undefined,
      categoryHandle: typeof record.categoryHandle === "string" ? record.categoryHandle : undefined,
      currencyCode: typeof record.currencyCode === "string" ? record.currencyCode : undefined,
      price: typeof record.price === "number" ? record.price : Number(record.price || 0),
      availability: typeof record.availability === "string" ? record.availability : undefined,
      canOrder: typeof record.canOrder === "boolean" ? record.canOrder : undefined,
      salesQuantity: typeof record.salesQuantity === "number" ? record.salesQuantity : Number(record.salesQuantity || 0),
      salesRank: typeof record.salesRank === "number" ? record.salesRank : Number(record.salesRank || 0) || undefined,
    });
  }
  return items;
}

function catalogCategorySessionItems(items: CatalogSessionItem[]): CatalogCategorySessionItem[] {
  const groups = new Map<string, CatalogCategorySessionItem>();
  for (const item of items.filter((candidate) => candidate.canOrder !== false && candidate.availability !== "out_of_stock")) {
    const handle = item.categoryHandle || item.categories?.[0]?.handle || "other";
    const name = item.categoryName || item.categories?.[0]?.name || "Other";
    const existing = groups.get(handle);
    if (existing) {
      existing.count += 1;
      if (!existing.imageUrl && item.imageUrl) existing.imageUrl = item.imageUrl;
    } else {
      groups.set(handle, {
        index: 0,
        name,
        handle,
        count: 1,
        imageUrl: item.imageUrl,
      });
    }
  }
  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 4)
    .map((category, index) => ({ ...category, index: index + 1 }));
}

function asCatalogCategorySessionItems(value: unknown): CatalogCategorySessionItem[] {
  if (!Array.isArray(value)) return [];
  const items: CatalogCategorySessionItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const index = Number(record.index);
    const name = typeof record.name === "string" ? record.name : "";
    const handle = typeof record.handle === "string" ? record.handle : "";
    if (!Number.isInteger(index) || index < 1 || !name || !handle) continue;
    items.push({
      index,
      name,
      handle,
      count: typeof record.count === "number" ? record.count : Number(record.count || 0),
      imageUrl: typeof record.imageUrl === "string" ? record.imageUrl : undefined,
    });
  }
  return items;
}

function historySessionItems(result: TelegramSalesDraftsResponse): HistorySessionItem[] {
  return result.data.map((item, index) => ({
    ...item,
    index: result.offset + index + 1,
  }));
}

function asHistorySessionItems(value: unknown): HistorySessionItem[] {
  if (!Array.isArray(value)) return [];
  const items: HistorySessionItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const index = Number(record.index);
    const id = typeof record.id === "string" ? record.id : "";
    const status = typeof record.status === "string" ? record.status : "";
    if (!Number.isInteger(index) || index < 1 || !id || !status) continue;
    const quote = pendingObject(record, "quote");
    items.push({
      index,
      id,
      status,
      customerMessage: typeof record.customerMessage === "string" ? record.customerMessage : null,
      convertedOrderId: typeof record.convertedOrderId === "string" ? record.convertedOrderId : null,
      delivery: (() => {
        const delivery = pendingObject(record, "delivery");
        return {
          address: typeof delivery.address === "string" ? delivery.address : null,
          note: typeof delivery.note === "string" ? delivery.note : null,
          zone: typeof delivery.zone === "string" ? delivery.zone : null,
          eta: typeof delivery.eta === "string" ? delivery.eta : null,
        };
      })(),
      quote: {
        total: typeof quote.total === "number" ? quote.total : Number(quote.total || 0),
        shippingFee: typeof quote.shippingFee === "number" ? quote.shippingFee : Number(quote.shippingFee || 0),
        items: Array.isArray(quote.items) ? quote.items.map((quoteItem) => {
          const itemRecord = quoteItem && typeof quoteItem === "object" ? quoteItem as Record<string, unknown> : {};
          return {
            title: typeof itemRecord.title === "string" ? itemRecord.title : undefined,
            sku: typeof itemRecord.sku === "string" ? itemRecord.sku : undefined,
            quantity: typeof itemRecord.quantity === "number" ? itemRecord.quantity : Number(itemRecord.quantity || 0),
            unitPrice: typeof itemRecord.unitPrice === "number" ? itemRecord.unitPrice : Number(itemRecord.unitPrice || 0),
            lineTotal: typeof itemRecord.lineTotal === "number" ? itemRecord.lineTotal : Number(itemRecord.lineTotal || 0),
            availability: typeof itemRecord.availability === "string" ? itemRecord.availability : undefined,
          };
        }) : [],
      },
      createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
      reviewedAt: typeof record.reviewedAt === "string" ? record.reviewedAt : null,
      expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null,
    });
  }
  return items;
}

function historyStatusIcon(status: string): string {
  if (status === "needs_review" || status === "pending") return "🕒";
  if (status === "converted") return "✅";
  if (status === "rejected") return "↩️";
  if (status === "expired") return "⌛";
  if (status === "cancelled") return "❌";
  return "•";
}

function historyStatusLabel(status: string, language: CustomerLanguage = "en"): string {
  if (language === "ru") {
    if (status === "needs_review" || status === "pending") return "На проверке";
    if (status === "converted") return "Подтверждена";
    if (status === "rejected") return "Отклонена";
    if (status === "expired") return "Истекла";
    if (status === "cancelled") return "Отменена";
    return status || "Неизвестно";
  }
  if (status === "needs_review" || status === "pending") return "Staff review";
  if (status === "converted") return "Confirmed";
  if (status === "rejected") return "Rejected";
  if (status === "expired") return "Expired";
  if (status === "cancelled") return "Cancelled";
  return status || "Unknown";
}

function historyItemSummary(item: TelegramSalesDraftSummary, language: CustomerLanguage = "en"): string {
  const quoteItems = item.quote?.items || [];
  const first = quoteItems[0];
  if (!first) return item.id;
  const quantity = Number(first.quantity || 0);
  const title = first.title || first.sku || (language === "ru" ? "Товар" : "Product");
  const suffix = quoteItems.length > 1 ? ` +${quoteItems.length - 1}` : "";
  return `${title}${quantity > 0 ? ` x${quantity}` : ""}${suffix}`;
}

function statusCountsForHistory(result: TelegramSalesDraftsResponse): Record<string, number> {
  if (result.statusCounts && Object.keys(result.statusCounts).length > 0) return result.statusCounts;
  const counts: Record<string, number> = {};
  for (const item of result.data) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

function formatStatusOverview(result: TelegramSalesDraftsResponse, language: CustomerLanguage): string[] {
  const counts = statusCountsForHistory(result);
  const statuses = ["needs_review", "pending", "converted", "rejected", "expired", "cancelled"];
  const lines = statuses
    .filter((status) => Number(counts[status] || 0) > 0)
    .map((status) => `${historyStatusIcon(status)} ${historyStatusLabel(status, language)}: ${Number(counts[status] || 0)}`);
  return lines.length > 0 ? lines : [language === "ru" ? "Пока нет активных заявок." : "No active request status yet."];
}

function formatStatusOverviewInline(result: TelegramSalesDraftsResponse, language: CustomerLanguage): string {
  return formatStatusOverview(result, language).join(" | ");
}

function formatTelegramSalesHistory(result: TelegramSalesDraftsResponse, language: CustomerLanguage = "en"): string {
  if (result.data.length === 0) {
    return language === "ru"
      ? [
        "🧾 <b>МОИ ЗАЯВКИ</b>",
        "У вас пока нет заявок.",
        "Откройте каталог или напишите, что хотите купить, например: mint x2.",
      ].join("\n")
      : [
        "🧾 <b>MY REQUESTS</b>",
        "No order requests yet.",
        "Tap Catalog to browse, or type what you want, for example: mint x2.",
      ].join("\n");
  }
  const page = Math.floor(result.offset / Math.max(1, result.limit)) + 1;
  const totalPages = Math.max(1, Math.ceil(result.count / Math.max(1, result.limit)));
  if (language === "ru") {
    return [
      "🧾 <b>МОИ ЗАЯВКИ</b>",
      `Всего заявок: ${result.count} | Страница ${page}/${totalPages}`,
      `Статусы: ${escapeHtml(formatStatusOverviewInline(result, language))}`,
      "",
      ...result.data.map((item, index) => [
        `${historyStatusIcon(item.status)} Заявка #${result.offset + index + 1} - ${htmlCode(shortRequestId(item.id))}`,
        `🕒 Статус: ${escapeHtml(historyStatusLabel(item.status, language))}`,
        `💰 Сумма: ${formatPriceWithEstimate(Number(item.quote?.total || 0), language)}`,
        `📅 Дата: ${escapeHtml(formatTimestamp(item.createdAt || undefined))}`,
        `📦 ${escapeHtml(historyItemSummary(item, language))}`,
      ].join("\n")),
      "",
      "Нажмите кнопку заявки ниже, чтобы открыть детали.",
    ].join("\n");
  }
  return [
    "🧾 <b>MY REQUESTS</b>",
    `Total requests: ${result.count} | Page ${page}/${totalPages}`,
    `Status: ${escapeHtml(formatStatusOverviewInline(result, language))}`,
    "",
    ...result.data.map((item, index) => [
      `${historyStatusIcon(item.status)} Order #${result.offset + index + 1} - ${htmlCode(shortRequestId(item.id))}`,
      `🕒 Status: ${escapeHtml(historyStatusLabel(item.status, language))}`,
      `💰 Total: ${formatPriceWithEstimate(Number(item.quote?.total || 0), language)}`,
      `📅 Date: ${escapeHtml(formatTimestamp(item.createdAt || undefined))}`,
      `📦 ${escapeHtml(historyItemSummary(item, language))}`,
    ].join("\n")),
    "",
    "Tap a request button below to open full details.",
  ].join("\n");
}

function formatDeliveryLines(item: TelegramSalesDraftSummary, language: CustomerLanguage): string[] {
  const delivery = item.delivery || {};
  const address = delivery.address || "";
  const note = delivery.note || "";
  const zone = delivery.zone || "";
  const eta = delivery.eta || "";
  if (language === "ru") {
    return [
      "📍 <b>Адрес доставки:</b>",
      htmlItalic(address || "Адрес будет уточнен сотрудником"),
      zone ? `Район: ${escapeHtml(zone)}` : "",
      eta ? `ETA: ${escapeHtml(eta)}` : "",
      note ? `Комментарий: ${escapeHtml(note)}` : "",
    ].filter(Boolean);
  }
  return [
    "📍 <b>Delivery Address:</b>",
    htmlItalic(address || "Staff will confirm"),
    zone ? `Zone: ${escapeHtml(zone)}` : "",
    eta ? `ETA: ${escapeHtml(eta)}` : "",
    note ? `Note: ${escapeHtml(note)}` : "",
  ].filter(Boolean);
}

function formatTelegramSalesHistoryDetail(item: HistorySessionItem, language: CustomerLanguage = "en"): string {
  const quoteItems = item.quote?.items || [];
  if (language === "ru") {
    return [
      `🧾 <b>Заявка #${item.index}</b>`,
      `🆔 ID: ${htmlCode(item.id)}`,
      `${historyStatusIcon(item.status)} Статус: ${escapeHtml(historyStatusLabel(item.status, language))}`,
      item.convertedOrderId ? `✅ Заказ в магазине: ${htmlCode(item.convertedOrderId)}` : "",
      "",
      "📦 <b>Товары:</b>",
      ...quoteItems.map((quoteItem, index) => [
        `• ${Number(quoteItem.quantity || 0)} x ${escapeHtml(quoteItem.title || quoteItem.sku || "Товар")}`,
        quoteItem.lineTotal !== undefined ? `  ${formatPriceWithEstimate(Number(quoteItem.lineTotal || 0), language)}` : "",
        quoteItem.availability ? `  ${formatAvailabilityWithIcon(quoteItem.availability, language)}` : "",
      ].filter(Boolean).join("\n")),
      "",
      ...formatDeliveryLines(item, language),
      "",
      "💵 <b>Оплата:</b> COD",
      `🧾 Итого: ${htmlBold(formatPriceWithEstimate(Number(item.quote?.total || 0), language))}`,
      item.quote?.shippingFee ? `Доставка: ${formatPriceWithEstimate(Number(item.quote.shippingFee || 0), language)}` : "",
      "",
      "🕒 <b>Время:</b>",
      `Создана: ${escapeHtml(formatTimestamp(item.createdAt || undefined))}`,
      item.reviewedAt ? `Проверена: ${escapeHtml(formatTimestamp(item.reviewedAt))}` : "",
      item.expiresAt ? `Действует до: ${escapeHtml(formatTimestamp(item.expiresAt))}` : "",
      item.customerMessage ? `\nСообщение: ${escapeHtml(item.customerMessage)}` : "",
    ].filter(Boolean).join("\n");
  }
  return [
    `🧾 <b>Request #${item.index}</b>`,
    `🆔 ID: ${htmlCode(item.id)}`,
    `${historyStatusIcon(item.status)} Status: ${escapeHtml(historyStatusLabel(item.status, language))}`,
    item.convertedOrderId ? `✅ Store order: ${htmlCode(item.convertedOrderId)}` : "",
    "",
    "📦 <b>Items:</b>",
    ...quoteItems.map((quoteItem, index) => [
      `• ${Number(quoteItem.quantity || 0)} x ${escapeHtml(quoteItem.title || quoteItem.sku || "Product")}`,
      quoteItem.lineTotal !== undefined ? `  ${formatPriceWithEstimate(Number(quoteItem.lineTotal || 0), language)}` : "",
      quoteItem.availability ? `  ${formatAvailabilityWithIcon(quoteItem.availability, language)}` : "",
    ].filter(Boolean).join("\n")),
    "",
    ...formatDeliveryLines(item, language),
    "",
    "💵 <b>Payment:</b> Cash on Delivery (COD)",
    `🧾 Total: ${htmlBold(formatPriceWithEstimate(Number(item.quote?.total || 0), language))}`,
    item.quote?.shippingFee ? `Shipping: ${formatPriceWithEstimate(Number(item.quote.shippingFee || 0), language)}` : "",
    "",
    "🕒 <b>Timeline:</b>",
    `Created: ${escapeHtml(formatTimestamp(item.createdAt || undefined))}`,
    item.reviewedAt ? `Reviewed: ${escapeHtml(formatTimestamp(item.reviewedAt))}` : "",
    item.expiresAt ? `Expires: ${escapeHtml(formatTimestamp(item.expiresAt))}` : "",
    item.customerMessage ? `\nOriginal message: ${escapeHtml(item.customerMessage)}` : "",
  ].filter(Boolean).join("\n");
}

function parseCatalogOrderSelection(args: string): { index: number; quantity: number } | null {
  const trimmed = args.trim();
  const compact = trimmed.match(/^#?(\d+)[xX](\d+)$/);
  const spaced = trimmed.match(/^#?(\d+)(?:\s*(?:x|qty|quantity|sl|so luong|số lượng)\s*[:=]?\s*(\d+))?$/i);
  const match = compact || spaced;
  if (!match) return null;

  const index = Number(match[1]);
  const quantity = Number(match[2] || 1);
  if (!Number.isInteger(index) || index < 1 || !Number.isInteger(quantity) || quantity < 1) return null;
  return { index, quantity };
}

function catalogOrderSelectionFromState(state: Record<string, unknown>, args: string): CatalogOrderSelection {
  const parsed = parseCatalogOrderSelection(args);
  if (!parsed) return { kind: "not_selection" };

  const items = asCatalogSessionItems(state.lastCatalogItems);
  if (items.length === 0) {
    return { kind: "error", message: "Use /products first, then order by number, for example /order 1 x2." };
  }

  const item = items.find((candidate) => candidate.index === parsed.index);
  if (!item) {
    return { kind: "error", message: `Product number ${parsed.index} is not in the latest catalog. Use /products again.` };
  }
  if (item.canOrder === false || item.availability === "out_of_stock") {
    return { kind: "error", message: `${item.title} is not available for order right now. Use /products to choose another item.` };
  }

  return { kind: "selected", item, quantity: parsed.quantity };
}

function isTelegramPhotoUrl(value?: string): value is string {
  return Boolean(value && /^https?:\/\//i.test(value));
}

function formatCatalogTree(groups: CatalogCategoryGroup[], language: CustomerLanguage): string[] {
  const codeLabel = language === "ru" ? "модов" : "codes";
  const categoryLabel = language === "ru" ? "Категория" : "Category";
  return groups.flatMap((group) => [
    "",
    htmlBold(`${categoryIcon(group)} ${categoryLabel}: ${displayCategoryName(group.name)}`) + ` (${group.count} ${codeLabel})`,
    ...group.items.slice(0, 5).map((item) => [
      `▫️ ${htmlBold(`#${item.index} ${item.title}`)}`,
      formatPriceWithEstimate(item.price, language),
    ].join(" | ")),
  ]);
}

function storefrontName(): string {
  return process.env.STORE_NAME?.trim() || "Store";
}

export function formatTelegramSalesCatalog(
  result: TelegramSalesCatalogResponse,
  language: CustomerLanguage = "en",
  mode: "top" | "category" | "ai" = "top",
  contextLabel?: string,
): string {
  if (result.data.length === 0) {
    return language === "ru"
      ? "Товары не найдены. Попробуйте другой запрос или напишите, что хотите купить."
      : "No matching products found. Try another search or type what you want to buy.";
  }
  const items = catalogSessionItems(result).filter((item) => item.canOrder !== false && item.availability !== "out_of_stock");
  const displayContextLabel = contextLabel ? displayCategoryName(contextLabel) : undefined;
  const title = language === "ru"
    ? mode === "category"
      ? `🧊 ${displayContextLabel || "Категория"}`
      : mode === "ai"
        ? "🔎 Подборка по вашему описанию"
        : `🌿 Каталог: ${storefrontName()}`
    : mode === "category"
      ? `🧊 ${displayContextLabel || "Category"}`
      : mode === "ai"
        ? "🔎 Matches for your description"
        : `🌿 ${storefrontName()} catalog`;
  if (mode === "top") {
    const groups = catalogCategoryGroups(items);
    return [
      htmlBold(title.toUpperCase()),
      language === "ru"
        ? "Популярные товары в наличии. Нажмите товар, чтобы открыть карточку."
        : "Best sellers in stock, tap a product to view details.",
      language === "ru"
        ? "Категории ниже открывают полный список товаров в наличии."
        : "Category buttons below open the full in-stock list.",
      ...formatCatalogTree(groups, language),
      "",
      language === "ru"
        ? "🔎 Используйте длинную кнопку поиска ниже, чтобы найти вкус или крепость."
        : "🔎 Use the search button below to find specific flavors or strength.",
    ].join("\n");
  }
  const resultTitle = mode === "ai"
    ? language === "ru"
      ? "🔎 <b>Результаты поиска</b>"
      : "🔎 <b>Search Results</b>"
    : htmlBold(title);
  const intro = mode === "ai"
    ? language === "ru"
      ? [
        contextLabel ? `Запрос: ${htmlItalic(contextLabel)}` : "",
        "Нажмите товар, чтобы посмотреть детали и купить.",
      ]
      : [
        contextLabel ? `For: ${htmlItalic(`"${contextLabel}"`)}` : "",
        "Tap a product to view details and buy.",
      ]
    : language === "ru"
      ? [
        "Ниже только товары в наличии.",
        "Нажмите товар, чтобы увидеть фото, детали и добавить в корзину.",
      ]
      : [
        "Only in-stock products are shown.",
        "Tap a product to open photo, details, and cart actions.",
      ];
  return [
    resultTitle,
    ...intro,
    "",
    ...items.slice(0, 100).map((item) => [
      `${productIcon(item)} ${htmlBold(`#${item.index} ${item.title}`)}`,
      `└ ${formatPriceWithEstimate(item.price, language)} | ${formatAvailabilityWithIcon(item.availability, language)}`,
    ].join("\n")),
    "",
    language === "ru" ? "Показаны только товары в наличии." : "Showing in-stock products only.",
  ].join("\n");
}

function productCardCaption(item: CatalogSessionItem, language: CustomerLanguage, mode: "list" | "detail" = "list"): string {
  const availability = formatAvailabilityWithIcon(item.availability, language);
  const rankLine = item.salesRank
    ? language === "ru" ? `📊 Популярность: Top #${item.salesRank}` : `📊 Popularity: Top #${item.salesRank}`
    : "";
  if (language === "ru") {
    return mode === "detail"
      ? [
        `${productIcon(item)} ${htmlBold(item.title)}`,
        "",
        item.categoryName ? `🏷 Категория: ${escapeHtml(item.categoryName)}` : "",
        item.price ? `💰 Цена: ${formatPriceWithEstimate(item.price, language)}` : "",
        rankLine,
        `${availabilityIcon(item.availability)} Статус: ${escapeHtml(formatAvailability(item.availability || "", language))}`,
        "",
        item.sku ? `🆔 SKU: ${htmlCode(item.sku)}` : "",
        "",
        htmlItalic("Выберите быстрое количество ниже или нажмите «Ввести количество» и отправьте число сообщением."),
        htmlItalic("Адрес доставки будет запрошен при оформлении корзины."),
      ].filter(Boolean).join("\n")
      : [
        `${productIcon(item)} ${htmlBold(`#${item.index} ${item.title}`)}`,
        item.price ? `└ ${formatPriceWithEstimate(item.price, language)} | ${availability}` : `└ ${availability}`,
      ].filter(Boolean).join("\n");
  }
  return mode === "detail"
    ? [
      `${productIcon(item)} ${htmlBold(item.title)}`,
      "",
      item.categoryName ? `🏷 Category: ${escapeHtml(item.categoryName)}` : "",
      item.price ? `💰 Price: ${formatPriceWithEstimate(item.price, language)}` : "",
      rankLine,
      `${availabilityIcon(item.availability)} Status: ${escapeHtml(formatAvailability(item.availability || "", language))}`,
      "",
      item.sku ? `🆔 SKU: ${htmlCode(item.sku)}` : "",
      "",
      htmlItalic("Choose a quick quantity below, or tap \"Enter quantity\" and type the number in chat."),
      htmlItalic("Delivery address is collected at checkout."),
    ].filter(Boolean).join("\n")
    : [
      `${productIcon(item)} ${htmlBold(`#${item.index} ${item.title}`)}`,
      item.price ? `└ ${formatPriceWithEstimate(item.price, language)} | ${availability}` : `└ ${availability}`,
    ].filter(Boolean).join("\n");
}

function productCardOptions(item: CatalogSessionItem, token: string, language: CustomerLanguage, mode: "list" | "detail" = "list"): TelegramMessageOptions {
  const l = labels(language);
  const detailButton = { text: l.details, callback_data: `sales_detail:${token}:${item.index}` };
  const orderOne = { text: l.orderOne, callback_data: `sales_select:${token}:${item.index}` };
  const orderTwo = { text: l.orderTwo, callback_data: `sales_select:${token}:${item.index}x2` };
  const orderFive = { text: l.orderFive, callback_data: `sales_select:${token}:${item.index}x5` };
  const customQuantity = { text: l.customQuantity, callback_data: `sales_quantity:${token}:${item.index}` };
  return {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: mode === "detail"
        ? [
          [orderOne, orderTwo],
          [orderFive, customQuantity],
          [{ text: l.viewCart, callback_data: "sales_cart:view" }],
          [
            { text: l.backCatalog, callback_data: `sales_catalog_refresh:${token}` },
            { text: l.support, callback_data: "sales_menu:support" },
          ],
        ]
        : [
          [detailButton, orderOne],
        ],
    },
  };
}

function productQuantityPrompt(item: CatalogSessionItem, language: CustomerLanguage): string {
  if (language === "ru") {
    return [
      "🔢 <b>Количество</b>",
      `${productIcon(item)} ${htmlBold(item.title)}`,
      item.price ? `Цена за 1: ${formatPriceWithEstimate(item.price, language)}` : "",
      "Отправьте нужное количество одним числом.",
      "Например: 3",
    ].filter(Boolean).join("\n");
  }
  return [
    "🔢 <b>Quantity</b>",
    `${productIcon(item)} ${htmlBold(item.title)}`,
    item.price ? `Unit price: ${formatPriceWithEstimate(item.price, language)}` : "",
    "Send the quantity as a number.",
    "Example: 3",
  ].filter(Boolean).join("\n");
}

function cartSessionItemsFromRaw(value: unknown): CartSessionItem[] {
  if (!Array.isArray(value)) return [];
  const items: CartSessionItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const parsed = asCatalogSessionItems([{ ...record, index: Number(record.index || items.length + 1) }])[0];
    const quantity = Number(record.quantity || 0);
    if (!parsed || !Number.isInteger(quantity) || quantity <= 0) continue;
    items.push({ ...parsed, quantity });
  }
  return items.map((item, index) => ({ ...item, index: index + 1 }));
}

function addCartItem(cart: CartSessionItem[], item: CatalogSessionItem, quantity: number): CartSessionItem[] {
  const normalizedQuantity = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  const byVariant = new Map<string, CartSessionItem>();
  for (const existing of cart) {
    byVariant.set(existing.variantId, { ...existing });
  }
  const current = byVariant.get(item.variantId);
  if (current) {
    byVariant.set(item.variantId, { ...current, quantity: current.quantity + normalizedQuantity });
  } else {
    byVariant.set(item.variantId, { ...item, quantity: normalizedQuantity });
  }
  return Array.from(byVariant.values()).map((cartItem, index) => ({ ...cartItem, index: index + 1 }));
}

function cartSubtotal(cart: CartSessionItem[]): number {
  return cart.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
}

function formatCartMessage(cart: CartSessionItem[], language: CustomerLanguage, address?: string): string {
  if (cart.length === 0) {
    return language === "ru"
      ? "🧺 Корзина пустая. Откройте каталог и добавьте товар."
      : "🧺 Your cart is empty. Open the catalog and add a product.";
  }
  const subtotal = cartSubtotal(cart);
  if (language === "ru") {
    return [
      "🛒 <b>ВАША КОРЗИНА</b>",
      "",
      ...cart.flatMap((item, index) => [
        `${ordinalIcon(index + 1)} ${htmlBold(item.title)}`,
        `└ ${formatLineCalculation(item, language)}`,
        "",
      ]),
      "➖➖➖➖➖➖➖➖",
      `🧾 Примерный итог: ${htmlBold(formatPriceWithEstimate(subtotal, language))}`,
      "",
      address ? `📍 Адрес доставки: ${htmlItalic(address)}` : "📍 Адрес доставки будет запрошен при оформлении.",
      "⏱ Магазин свяжется с вами в течение 5 минут после отправки заявки.",
    ].join("\n");
  }
  return [
    "🛒 <b>YOUR CART</b>",
    "",
    ...cart.flatMap((item, index) => [
      `${ordinalIcon(index + 1)} ${htmlBold(item.title)}`,
      `└ ${formatLineCalculation(item, language)}`,
      "",
    ]),
    "➖➖➖➖➖➖➖➖",
    `🧾 Estimated Subtotal: ${htmlBold(formatPriceWithEstimate(subtotal, language))}`,
    "",
    address ? `📍 Delivery Address: ${htmlItalic(address)}` : "📍 Delivery address is collected at checkout.",
    "⏱ The shop will contact you within 5 minutes after request.",
  ].join("\n");
}

function cartMessageOptions(language: CustomerLanguage): TelegramMessageOptions {
  const l = labels(language);
  return {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: l.addMore, callback_data: "sales_menu:products" },
          { text: l.checkout, callback_data: "sales_cart:checkout" },
        ],
        [
          { text: l.clearCart, callback_data: "sales_cart:clear" },
          { text: l.support, callback_data: "sales_menu:support" },
        ],
      ],
    },
  };
}

function cartCheckoutPrompt(language: CustomerLanguage): string {
  return language === "ru"
    ? [
      "👇 <b>Отправьте адрес доставки ниже.</b>",
      "Можно добавить ориентир, район, время и комментарий для курьера.",
      htmlItalic("Например: 22 Example Street, lobby, after 7pm."),
    ].join("\n")
    : [
      "👇 <b>Send your delivery address below to checkout.</b>",
      "You can include building note, district, preferred time, or delivery instructions.",
      htmlItalic("E.g., 22 Example Street, lobby, after 7pm."),
    ].join("\n");
}

function cartSalesDraft(
  update: TelegramUpdate,
  chatId: number,
  userId: string,
  cart: CartSessionItem[],
  address: string,
  sourceText: string,
  language: CustomerLanguage,
): { salesDraft: TelegramSalesDraftRequest; aiDraft: AiOrderDraftResponse["data"] } {
  const aiDraft: AiOrderDraftResponse["data"] = {
    items: cart.map((item) => ({
      variantId: item.variantId,
      quantity: item.quantity,
      productName: item.title,
      sku: item.sku,
    })),
    paymentMethod: "cod",
    note: `Telegram cart checkout: ${address}`,
    confidence: "high",
    parser: "telegram-cart",
    queryText: cart.map((item) => `${item.title} x${item.quantity}`).join(", "),
    clarification: null,
  };
  return {
    aiDraft,
    salesDraft: {
      profile: profileFromUpdate(update, chatId, userId, language),
      items: cart.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
      delivery: {
        address,
        note: "Shop should contact customer within 5 minutes before confirming fulfillment.",
      },
      customerMessage: sourceText,
      aiMetadata: {
        parser: aiDraft.parser,
        confidence: aiDraft.confidence,
        queryText: aiDraft.queryText,
        requestedPaymentMethod: aiDraft.paymentMethod,
        cartItems: cart.map((item) => ({
          variantId: item.variantId,
          sku: item.sku || null,
          title: item.title,
          quantity: item.quantity,
          price: item.price || 0,
        })),
      },
      shippingFee: 0,
    },
  };
}

export function formatOrders(result: OrdersListResponse): string {
  if (result.orders.length === 0) return "Chua co don hang nao.";

  return [
    "Don hang gan nhat:",
    ...result.orders.map((order) => [
      `${order.orderNumber || order.display_id || order.id}`,
      `id ${order.id}`,
      `trang thai ${order.status}`,
      `tong ${formatVnd(order.total)}`,
      `thanh toan ${order.paymentMethod || order.payment_method || "unknown"}`,
      `luc ${formatTimestamp(order.createdAt || order.created_at)}`,
    ].join(" | ")),
  ].join("\n");
}

export function formatDashboard(result: DashboardResponse): string {
  const scope = result.context.normalizedScope;
  const range = result.context.localDateRange;
  return [
    `Bao cao canonical ${range.from} den ${range.to}:`,
    `Pham vi merchant ${scope.merchantId}; stores ${scope.storeIds.join(", ")}`,
    `Report-as-of ${formatTimestamp(result.context.reportAsOf)}; generated-at ${formatTimestamp(result.context.generatedAt)}`,
    ...result.data.currencies.flatMap((currency) => [
      `${currency.currencyCode}: don hieu luc ${currency.currentOrder.validOrderCount}; gia tri don hien tai ${formatCurrencyMinor(currency.currentOrder.currentOrderGrossValueMinor, currency.currencyCode, currency.minorUnitExponent)}`,
      `${currency.currencyCode}: tong tien da ghi nhan thu (gom VAT, shipping va khoan khac) ${formatCurrencyMinor(currency.recordedCollection.recordedGrossCollectionsMinor, currency.currencyCode, currency.minorUnitExponent)}`,
      currency.paymentFlow
        ? `${currency.currencyCode}: hoan/dao/chargeback ${formatCurrencyMinor(currency.paymentFlow.negativeCollectionsMinor, currency.currencyCode, currency.minorUnitExponent)}; thu rong ${formatCurrencyMinor(currency.paymentFlow.netCollectionsMinor, currency.currencyCode, currency.minorUnitExponent)}; phai tra khach ${formatCurrencyMinor(currency.paymentFlow.customerRefundPayableAsOfMinor, currency.currencyCode, currency.minorUnitExponent)}`
        : `${currency.currencyCode}: dong tien am va phai tra khach chua kha dung; khong fallback du lieu legacy`,
    ]),
    `Nguon tong hop: ${result.data.aggregateReadSource}; muc hoan chinh: ${result.data.completeness}`,
  ].join("\n");
}

const accountingReportAliases: Record<string, AccountingReportName> = {
  income: "income-statement",
  "income-statement": "income-statement",
  p_and_l: "income-statement",
  pnl: "income-statement",
  balance: "balance-sheet",
  "balance-sheet": "balance-sheet",
  cash: "cash-flow",
  "cash-flow": "cash-flow",
  tax: "tax-summary",
  "tax-summary": "tax-summary",
};

const accountingReportLabels: Record<AccountingReportName, string> = {
  "income-statement": "Ket qua kinh doanh",
  "balance-sheet": "Bang can doi",
  "cash-flow": "Luu chuyen tien",
  "tax-summary": "Tong hop thue",
};

const accountingMetricLabels: Record<AccountingReportName, Record<string, string>> = {
  "income-statement": {
    revenue: "Doanh thu",
    cogs: "Gia von",
    operatingExpenses: "Chi phi van hanh",
    grossProfit: "Loi nhuan gop",
    netIncome: "Loi nhuan rong",
  },
  "balance-sheet": {
    totalAssets: "Tai san",
    totalLiabilities: "No phai tra",
    ledgerEquity: "Von theo so cai",
    currentEarnings: "Loi nhuan chua ket chuyen",
    totalEquity: "Tong von chu so huu",
    balanceDelta: "Chenh lech can doi",
  },
  "cash-flow": {
    cashIn: "Tien vao",
    cashOut: "Tien ra",
    netCashFlow: "Luu chuyen tien thuan",
  },
  "tax-summary": {
    outputVat: "VAT dau ra",
    inputVat: "VAT dau vao",
    vatPayable: "VAT phai nop",
  },
};

interface ParsedAccountingReport {
  name: AccountingReportName;
  filters: AccountingReportFilters;
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function parsePositiveQuantity(raw: string): number | null {
  const quantity = Number(raw);
  return Number.isInteger(quantity) && quantity > 0 ? quantity : null;
}

function parseCustomerQuantityText(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  const direct = parsePositiveQuantity(trimmed);
  if (direct !== null) return Math.min(direct, CUSTOMER_MAX_LINE_QUANTITY);
  const matched = trimmed.match(/(?:x|qty|quantity|sl|so luong|số lượng|количество)\s*[:=]?\s*(\d{1,2})/i);
  if (!matched) return null;
  const quantity = Number(matched[1]);
  return Number.isInteger(quantity) && quantity > 0 ? Math.min(quantity, CUSTOMER_MAX_LINE_QUANTITY) : null;
}

function parseMoney(raw: string): number | null {
  const normalized = raw.replace(/[,_\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime());
}

function parseAccountingReportArgs(args: string): ParseResult<ParsedAccountingReport> {
  const [rawName = "", ...tokens] = args.split(/\s+/).filter(Boolean);
  const name = accountingReportAliases[rawName.toLowerCase()];
  if (!name) {
    return {
      ok: false,
      message: "Nhap: /accounting_report <income|balance|cash|tax> [from=YYYY-MM-DD] [to=YYYY-MM-DD] [asOf=YYYY-MM-DD]",
    };
  }

  const filters: AccountingReportFilters = {};
  for (const token of tokens) {
    const [key = "", value = ""] = token.split("=");
    if (!["from", "to", "asOf"].includes(key) || !value) {
      return { ok: false, message: `Tham so accounting khong hop le: ${token}` };
    }
    if (!isIsoDate(value)) return { ok: false, message: `${key} phai co dang YYYY-MM-DD.` };
    if (key === "from") filters.from = value;
    else if (key === "to") filters.to = value;
    else filters.asOf = value;
  }

  return { ok: true, value: { name, filters } };
}

function parseOrderItems(raw: string): ParseResult<RemoteOrderRequest["items"]> {
  const items = raw.split(",").map(part => part.trim()).filter(Boolean);
  if (items.length === 0) {
    return { ok: false, message: "Nhap san pham dang: /create_order <variantId>:<qty>[,<variantId>:<qty>...]" };
  }

  const parsed = [];
  for (const item of items) {
    const [variantId = "", quantityRaw = ""] = item.split(":").map(part => part.trim());
    const quantity = parsePositiveQuantity(quantityRaw);
    if (!variantId || quantity === null) {
      return { ok: false, message: `Dong san pham khong hop le: ${item}. Dung variantId:so_luong.` };
    }
    parsed.push({ variantId, quantity });
  }
  return { ok: true, value: parsed };
}

function parseCreateOrderArgs(args: string): ParseResult<RemoteOrderRequest> {
  const [itemSpec = "", ...tokens] = args.split(/\s+/).filter(Boolean);
  const items = parseOrderItems(itemSpec);
  if (!items.ok) return { ok: false, message: items.message };

  const draft: RemoteOrderRequest = {
    items: items.value,
    paymentMethod: "cod",
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("payment=")) {
      const method = token.slice("payment=".length);
      if (!["cod", "cash", "bank_transfer"].includes(method)) {
        return { ok: false, message: "payment chi ho tro: cod, cash, bank_transfer." };
      }
      draft.paymentMethod = method;
      continue;
    }
    if (token.startsWith("customer=")) {
      const customerId = token.slice("customer=".length).trim();
      if (!customerId) return { ok: false, message: "customer khong duoc de trong." };
      draft.customerId = customerId;
      continue;
    }
    if (token.startsWith("received=") || token.startsWith("amountReceived=")) {
      const amountRaw = token.includes("amountReceived=")
        ? token.slice("amountReceived=".length)
        : token.slice("received=".length);
      const amount = parseMoney(amountRaw);
      if (amount === null) return { ok: false, message: "received phai la so tien lon hon 0." };
      draft.amountReceived = amount;
      continue;
    }
    if (token.startsWith("note=")) {
      draft.note = [token.slice("note=".length), ...tokens.slice(index + 1)].join(" ").trim() || undefined;
      break;
    }
    return { ok: false, message: `Tham so khong hop le: ${token}` };
  }

  return { ok: true, value: draft };
}

function parseAiOrderQuantity(text: string): number {
  const normalized = text.toLowerCase();
  const explicit = normalized.match(/(?:x|sl|qty|quantity|so luong|số lượng)\s*[:=]?\s*(\d+)/);
  if (explicit) return Math.max(1, Number(explicit[1]));
  const leading = normalized.match(/\b(\d+)\s*(?:hop|hộp|goi|gói|pack|chai|sp)?\b/);
  return leading ? Math.max(1, Number(leading[1])) : 1;
}

function searchQueryForAiOrder(text: string): string {
  return text
    .replace(/(?:x|sl|qty|quantity|so luong|số lượng)\s*[:=]?\s*\d+/gi, " ")
    .replace(/\b\d+\s*(?:hop|hộp|goi|gói|pack|chai|sp)?\b/gi, " ")
    .replace(/\b(dat|đặt|len|lên|don|đơn|mua|cho|toi|tôi|khach|khách)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSellableVariant(result: ProductListResponse): { variantId: string; productName: string; sku: string } | null {
  for (const product of result.data) {
    const variant = product.variants.find((item) => item.inventory_quantity > 0);
    if (variant) {
      return { variantId: variant.id, productName: product.title, sku: variant.sku || variant.id };
    }
  }
  return null;
}

function clarificationFromProductList(queryText: string, result: ProductListResponse): AiOrderClarification {
  const options = result.data
    .flatMap((product) => product.variants.map((variant) => ({
      productId: product.id,
      productName: product.title,
      variantId: variant.id,
      sku: variant.sku || variant.id,
      stock: Number(variant.inventory_quantity || 0),
    })))
    .sort((a, b) => Number(b.stock > 0) - Number(a.stock > 0) || b.stock - a.stock || a.productName.localeCompare(b.productName))
    .slice(0, 5);

  return {
    type: "product",
    queryText,
    message: options.length > 0
      ? `Co nhieu san pham khop "${queryText}". Hay chon SKU con hang.`
      : `Khong tim thay san pham con hang khop "${queryText}".`,
    options,
  };
}

async function draftAiOrder(
  backend: BackendClient,
  userId: string,
  text: string,
  mode: "operator" | "sales" = "operator",
): Promise<AiOrderDraftResponse["data"] | null> {
  try {
    const response = mode === "sales"
      ? await backend.draftTelegramSalesOrder(userId, text)
      : await backend.draftAiOrder(userId, text);
    return response.data;
  } catch (error) {
    if (error instanceof BackendApiError && (error.status === 401 || error.status === 403)) {
      throw error;
    }

    const clarification = clarificationFromError(error);
    if (clarification) {
      return {
        items: [],
        paymentMethod: "cod",
        note: `AI Telegram draft: ${text}`,
        confidence: "low",
        parser: "deterministic",
        queryText: clarification.queryText || text,
        clarification,
      };
    }

    const quantity = parseAiOrderQuantity(text);
    const queryText = searchQueryForAiOrder(text) || text;
    const products = await backend.searchProducts(userId, queryText, 5);
    const match = firstSellableVariant(products);
    if (!match) {
      return {
        items: [],
        paymentMethod: "cod",
        note: `AI Telegram draft: ${text}`,
        confidence: "low",
        parser: "deterministic-fallback",
        queryText,
        clarification: clarificationFromProductList(queryText, products),
      };
    }
    return {
      items: [{ variantId: match.variantId, quantity, productName: match.productName, sku: match.sku }],
      paymentMethod: "cod",
      note: `AI Telegram draft: ${text}`,
      confidence: "medium",
      parser: "deterministic-fallback",
      queryText,
      clarification: null,
    };
  }
}

function parseRefundArgs(args: string): ParseResult<{ orderId: string; request: RefundRequest }> {
  const [orderId = "", amountRaw = "", ...reasonParts] = args.split(/\s+/).filter(Boolean);
  if (!orderId || !amountRaw) {
    return { ok: false, message: "Nhap: /refund_order <orderId> <full|amount> <ly_do>" };
  }

  const reason = reasonParts.join(" ").trim();
  if (!reason) return { ok: false, message: "Refund can ly do. Nhap: /refund_order <orderId> <full|amount> <ly_do>" };

  if (amountRaw.toLowerCase() === "full") {
    return { ok: true, value: { orderId, request: { reason } } };
  }

  const amount = parseMoney(amountRaw);
  if (amount === null) return { ok: false, message: "So tien refund khong hop le. Dung full hoac amount > 0." };
  return { ok: true, value: { orderId, request: { amount, reason } } };
}

function mutationData(result: MutationResponse): Record<string, unknown> {
  return result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
}

function formatCreatedOrder(result: MutationResponse): string {
  const data = mutationData(result);
  const orderId = String(data.orderId || data.id || "unknown");
  return [
    "Da tao don remote.",
    `Don: ${String(data.orderNumber || data.display_id || orderId)}`,
    `ID: ${orderId}`,
    `Trang thai: ${String(data.remoteStatus || data.status || "confirmed")}`,
    `Tong: ${formatVnd(Number(data.total || 0))}`,
    `Thanh toan: ${String(data.paymentMethod || "cod")}`,
  ].join("\n");
}

function formatPaymentIntent(result: PaymentIntentResponse): string {
  const data = result.data;
  return [
    "Da tao payment intent remote.",
    `Provider: ${data.provider}`,
    `Trang thai: ${data.status}`,
    `Reference: ${data.referenceCode}`,
    `So tien: ${formatVnd(data.amount)}`,
    `Het han: ${formatTimestamp(data.expiresAt)}`,
    data.paymentUrl ? `Link: ${data.paymentUrl}` : "",
    data.qrPayload ? `QR/Payload: ${truncate(data.qrPayload, 280)}` : "",
  ].filter(Boolean).join("\n");
}

function formatSubmittedSalesDraft(result: TelegramSalesDraftResponse, language: CustomerLanguage = "en"): string {
  const data = result.data;
  const quote = data.quote || {};
  const items = Array.isArray(quote.items) ? quote.items : [];
  if (language === "ru") {
    return [
      "✅ <b>ЗАЯВКА ОТПРАВЛЕНА</b>",
      `🆔 ID заявки: ${htmlCode(data.id)}`,
      `🕒 Статус: ${escapeHtml(data.status)}`,
      "",
      "📦 <b>Товары:</b>",
      ...items.map((item) => [
        `• ${Number(item.quantity || 0)} x ${escapeHtml(item.title || item.sku || "Товар")}`,
        item.lineTotal !== undefined ? `  ${formatPriceWithEstimate(Number(item.lineTotal || 0), language)}` : "",
      ].filter(Boolean).join("\n")),
      "",
      `🧾 Ориентировочная сумма: ${htmlBold(formatPriceWithEstimate(Number(quote.total || 0), language))}`,
      "⏱ Магазин свяжется с вами в течение 5 минут, затем сотрудник подтвердит заказ в портале.",
    ].join("\n");
  }
  return [
    "✅ <b>REQUEST SENT</b>",
    `🆔 Request ID: ${htmlCode(data.id)}`,
    `🕒 Status: ${escapeHtml(data.status)}`,
    "",
    "📦 <b>Items:</b>",
    ...items.map((item) => [
      `• ${Number(item.quantity || 0)} x ${escapeHtml(item.title || item.sku || "Product")}`,
      item.lineTotal !== undefined ? `  ${formatPriceWithEstimate(Number(item.lineTotal || 0), language)}` : "",
    ].filter(Boolean).join("\n")),
    "",
    `🧾 Estimated total: ${htmlBold(formatPriceWithEstimate(Number(quote.total || 0), language))}`,
    "⏱ The shop will contact you within 5 minutes, then staff will confirm the order in the portal.",
  ].join("\n");
}

function formatSalesDraftPreview(draft: TelegramSalesDraftRequest, aiDraft: AiOrderDraftResponse["data"], language: CustomerLanguage = "en"): string {
  const metadataItems = Array.isArray(draft.aiMetadata?.cartItems)
    ? draft.aiMetadata.cartItems.map((item) => item && typeof item === "object" ? item as Record<string, unknown> : null).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  const total = metadataItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
  if (language === "ru") {
    return [
      "📝 <b>ПРОВЕРЬТЕ ЗАЯВКУ</b>",
      "",
      "📦 <b>Товары:</b>",
      ...aiDraft.items.map((item) => `• ${Number(item.quantity || 0)} x ${escapeHtml(item.productName || item.sku || item.variantId)}`),
      "",
      "📍 <b>Адрес доставки:</b>",
      draft.delivery?.address ? htmlItalic(draft.delivery.address) : htmlItalic("Адрес будет уточнен сотрудником"),
      "",
      "💵 Оплата: COD",
      total > 0 ? `🧾 Итого: ${htmlBold(formatPriceWithEstimate(total, language))}` : "",
      aiDraft.queryText ? `🔎 Поиск: ${htmlItalic(aiDraft.queryText)}` : "",
      draft.delivery?.note ? `Комментарий: ${escapeHtml(draft.delivery.note)}` : "",
      "",
      "👇 Подтвердите ниже. Магазин свяжется с вами в течение 5 минут.",
    ].filter(Boolean).join("\n");
  }
  return [
    "📝 <b>PLEASE REVIEW YOUR ORDER</b>",
    "",
    "📦 <b>Items:</b>",
    ...aiDraft.items.map((item) => `• ${Number(item.quantity || 0)} x ${escapeHtml(item.productName || item.sku || item.variantId)}`),
    "",
    "📍 <b>Delivery Address:</b>",
    draft.delivery?.address ? htmlItalic(draft.delivery.address) : htmlItalic("Staff will confirm"),
    "",
    "💵 Payment: Cash on Delivery (COD)",
    total > 0 ? `🧾 Total: ${htmlBold(formatPriceWithEstimate(total, language))}` : "",
    aiDraft.queryText ? `🔎 Search: ${htmlItalic(aiDraft.queryText)}` : "",
    draft.delivery?.note ? `Note: ${escapeHtml(draft.delivery.note)}` : "",
    "",
    "👇 Please confirm below. Staff will contact you within 5 minutes.",
  ].filter(Boolean).join("\n");
}

function profileFromUpdate(update: TelegramUpdate, chatId: number, userId: string, language: CustomerLanguage = "en"): TelegramSalesDraftRequest["profile"] {
  const from = update.message?.from || update.callback_query?.from;
  return {
    telegramUserId: userId,
    telegramChatId: String(chatId),
    username: from?.username,
    firstName: from?.first_name,
    language,
  };
}

async function sendSalesDraftConfirmation(
  telegram: TelegramApi,
  sessions: SessionStore,
  update: TelegramUpdate,
  chatId: number,
  userId: string,
  options: HandlerOptions,
  selectedStoreId: string,
  salesDraft: TelegramSalesDraftRequest,
  aiDraft: AiOrderDraftResponse["data"],
): Promise<void> {
  const code = confirmationCode(update.update_id, "request");
  await sessions.setPending(userId, {
    pendingAction: "sales_draft",
    salesDraft,
    confirmCode: code,
    callbackToken: code,
    binding: bindingContext(options, userId),
    requestedStoreId: selectedStoreId,
    idempotencyKey: idempotencyKey(update.update_id, "sales_draft", code),
    requestedAt: new Date().toISOString(),
  }, `telegram:${update.update_id}:session`);
  await telegram.sendMessage(
    chatId,
    [
      formatSalesDraftPreview(salesDraft, aiDraft, normalizeCustomerLanguage(salesDraft.profile?.language)),
      salesDraftConfirmation(code),
    ].join("\n"),
    withHtml(confirmationMessageOptions("sales_draft", code, normalizeCustomerLanguage(salesDraft.profile?.language))),
  );
}

function asTelegramSalesDraft(value: Record<string, unknown>): TelegramSalesDraftRequest | null {
  const items = Array.isArray(value.items)
    ? value.items.map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const variantId = typeof record.variantId === "string" ? record.variantId : "";
      const quantity = typeof record.quantity === "number" ? record.quantity : Number(record.quantity);
      return variantId && Number.isInteger(quantity) && quantity > 0 ? { variantId, quantity } : null;
    }).filter((item): item is { variantId: string; quantity: number } => Boolean(item))
    : [];
  if (items.length === 0) return null;
  return {
    profile: pendingObject(value, "profile") as TelegramSalesDraftRequest["profile"],
    items,
    delivery: pendingObject(value, "delivery") as TelegramSalesDraftRequest["delivery"],
    customerMessage: typeof value.customerMessage === "string" ? value.customerMessage : undefined,
    aiMetadata: pendingObject(value, "aiMetadata"),
    shippingFee: typeof value.shippingFee === "number" ? value.shippingFee : undefined,
  };
}

function salesClarificationText(clarification: AiOrderClarification): string {
  const options = clarification.options || [];
  const lines = [
    clarification.message || "Please choose the matching product.",
    clarification.queryText ? `Search: ${clarification.queryText}` : "",
  ].filter(Boolean);
  if (options.length > 0) {
    lines.push(
      "Options:",
      ...options.map((option, index) => [
        `${index + 1}. ${option.productName || option.variantId || "Product"}`,
        option.sku ? `SKU ${option.sku}` : "",
      ].filter(Boolean).join(" | ")),
    );
  } else {
    lines.push("Use /products <keyword> to browse available products.");
  }
  return lines.join("\n");
}

function formatRefund(result: MutationResponse): string {
  const data = mutationData(result);
  return [
    "Da ghi nhan refund.",
    `Don: ${String(data.orderNumber || data.orderId || "unknown")}`,
    `Trang thai: ${String(data.status || "refunded")}`,
    `So tien: ${formatVnd(Number(data.amount || 0))}`,
    `Con lai co the refund: ${formatVnd(Number(data.refundableAfter || 0))}`,
  ].join("\n");
}

export function formatAiQueue(result: AiReviewQueueResponse): string {
  if (result.data.length === 0) return "Khong co AI action nao dang cho review.";

  return [
    "AI review queue:",
    ...result.data.slice(0, 5).map((action) => {
      const payload = action.outputPayload || action.output_payload || {};
      const responseText = typeof payload.responseText === "string" ? ` | ${truncate(payload.responseText)}` : "";
      const confidence = action.confidence === undefined || action.confidence === null ? "n/a" : String(action.confidence);
      return [
        `${action.id}`,
        `type ${action.actionType || action.action_type || "unknown"}`,
        `risk ${action.riskLevel || action.risk_level || "unknown"}`,
        `confidence ${confidence}`,
        `status ${action.status}`,
      ].join(" | ") + responseText;
    }),
  ].join("\n");
}

export function formatAccountingReport(name: AccountingReportName, result: AccountingReportResponse): string {
  const labels = accountingMetricLabels[name];
  return [
    `Bao cao ke toan: ${accountingReportLabels[name]}`,
    ...Object.entries(labels).map(([key, label]) => `${label}: ${formatVnd(Number(result.data[key] || 0))}`),
  ].join("\n");
}

async function sendTextChunks(telegram: TelegramApi, chatId: number, text: string): Promise<void> {
  const maxLength = 3900;
  for (let index = 0; index < text.length; index += maxLength) {
    await telegram.sendMessage(chatId, text.slice(index, index + maxLength));
  }
}

async function sendProductCard(
  telegram: TelegramApi,
  chatId: number,
  item: CatalogSessionItem,
  token: string,
  language: CustomerLanguage,
  mode: "list" | "detail" = "list",
): Promise<void> {
  const caption = productCardCaption(item, language, mode);
  const options = productCardOptions(item, token, language, mode);
  const imageUrl = item.imageUrl;
  if (isTelegramPhotoUrl(imageUrl) && typeof telegram.sendPhoto === "function") {
    try {
      await telegram.sendPhoto(chatId, imageUrl, { ...options, caption });
      return;
    } catch {
      // Broken external product images should not block the sales flow.
    }
  }
  await telegram.sendMessage(chatId, `${mode === "detail" ? "🖼️" : "📦"} ${caption}`, options);
}

async function sendCategoryCover(
  telegram: TelegramApi,
  chatId: number,
  category: CatalogCategorySessionItem,
  language: CustomerLanguage,
): Promise<void> {
  if (!isTelegramPhotoUrl(category.imageUrl) || typeof telegram.sendPhoto !== "function") return;
  const categoryName = displayCategoryName(category.name);
  const caption = language === "ru"
    ? `${categoryIcon(category)} ${categoryName}\nТовары в наличии: ${category.count}`
    : `${categoryIcon(category)} ${categoryName}\nIn-stock products: ${category.count}`;
  try {
    await telegram.sendPhoto(chatId, category.imageUrl, { caption });
  } catch {
    // Category cover images are cosmetic; product browsing must continue.
  }
}

async function sendTelegramSalesCatalog(
  telegram: TelegramApi,
  backend: BackendClient,
  sessions: SessionStore,
  update: TelegramUpdate,
  chatId: number,
  userId: string,
  queryText?: string,
  catalogOptions: {
    limit?: number;
    categoryHandle?: string;
    mode?: "top" | "category" | "ai";
    contextLabel?: string;
  } = {},
): Promise<void> {
  const mode = catalogOptions.mode || (queryText ? "ai" : "top");
  const limit = catalogOptions.limit || (mode === "ai" ? 8 : mode === "category" ? 100 : 20);
  const result = await backend.listTelegramSalesCatalog(userId, queryText || undefined, limit, catalogOptions.categoryHandle);
  const items = catalogSessionItems(result);
  const categories = catalogCategorySessionItems(items);
  const catalogToken = confirmationCode(update.update_id, "catalog");
  const existingSession = await sessions.getRecord(userId);
  const language = languageFromState(existingSession.state);
  await sessions.set(userId, {
    ...existingSession.state,
    lastCommand: "products",
    query: queryText || null,
    lastCatalogItems: items,
    lastCatalogCategories: categories,
    lastCatalogToken: catalogToken,
    lastCatalogMode: mode,
    lastCategoryHandle: catalogOptions.categoryHandle || null,
    lastCategoryLabel: catalogOptions.contextLabel || null,
    pendingAction: undefined,
    language,
    updatedAt: new Date().toISOString(),
  }, `telegram:${update.update_id}:session`, existingSession.expiresAt);
  await telegram.sendMessage(
    chatId,
    formatTelegramSalesCatalog(result, language, mode, catalogOptions.contextLabel),
    catalogMessageOptions(items, categories, catalogToken, language, mode),
  );
}

async function sendTelegramSalesHistory(
  telegram: TelegramApi,
  backend: BackendClient,
  sessions: SessionStore,
  update: TelegramUpdate,
  chatId: number,
  userId: string,
  offset = 0,
): Promise<void> {
  const result = await backend.listTelegramSalesDrafts(userId, 5, offset);
  const items = historySessionItems(result);
  const historyToken = confirmationCode(update.update_id, "history");
  const existingSession = await sessions.getRecord(userId);
  const language = languageFromState(existingSession.state);
  await sessions.set(userId, {
    ...existingSession.state,
    lastCommand: "history",
    lastHistoryItems: items,
    lastHistoryToken: historyToken,
    lastHistoryOffset: result.offset,
    language,
    updatedAt: new Date().toISOString(),
  }, `telegram:${update.update_id}:session`, existingSession.expiresAt);
  await telegram.sendMessage(chatId, formatTelegramSalesHistory(result, language), historyMessageOptions(items, historyToken, result, language));
}

async function sendTelegramSalesMenu(
  telegram: TelegramApi,
  sessions: SessionStore,
  update: TelegramUpdate,
  chatId: number,
  userId: string,
): Promise<void> {
  const existingSession = await sessions.getRecord(userId);
  const language = languageFromState(existingSession.state);
  await sessions.set(userId, {
    ...existingSession.state,
    lastCommand: "menu",
    language,
    updatedAt: new Date().toISOString(),
  }, `telegram:${update.update_id}:session`, existingSession.expiresAt);
  await telegram.sendMessage(
    chatId,
    [
      labels(language).menuTitle,
      labels(language).menuSubtitle,
    ].join("\n"),
    mainMenuInlineOptions(language),
  );
}

async function sendTelegramSalesLanguageSelector(
  telegram: TelegramApi,
  sessions: SessionStore,
  update: TelegramUpdate,
  chatId: number,
  userId: string,
): Promise<void> {
  const existingSession = await sessions.getRecord(userId);
  const language = languageFromState(existingSession.state);
  await sessions.set(userId, {
    ...existingSession.state,
    lastCommand: "language",
    language,
    updatedAt: new Date().toISOString(),
  }, `telegram:${update.update_id}:session`, existingSession.expiresAt);
  await telegram.sendMessage(
    chatId,
    [
      "🌐 Language",
      "Choose your preferred shopping language.",
      "Выберите язык для покупок.",
    ].join("\n"),
    languageMessageOptions(language),
  );
}

async function sendTelegramSalesSupport(telegram: TelegramApi, chatId: number, language: CustomerLanguage = "en"): Promise<void> {
  if (language === "ru") {
    await telegram.sendMessage(
      chatId,
      [
        "💬 Поддержка",
        "Напишите вопрос по товару прямо в чат или добавьте комментарий перед отправкой заявки.",
        "По существующим заявкам откройте Мои заявки и отправьте ID заявки сотруднику.",
      ].join("\n"),
      customerMenuMessageOptions(language),
    );
    return;
  }
  await telegram.sendMessage(
    chatId,
    [
      "💬 Support",
      "For product questions, add a note when sending your request. Staff reviews submitted requests in the portal.",
      "For existing requests, open My requests and share the request ID with staff.",
    ].join("\n"),
    customerMenuMessageOptions(language),
  );
}

export async function handleUpdate(
  update: TelegramUpdate,
  telegram: TelegramApi,
  backend: BackendClient,
  sessions: SessionStore,
  options: HandlerOptions = {},
): Promise<void> {
  const callback = update.callback_query;
  if (callback) {
    const userId = telegramUserId(update);
    const chatId = callback.message?.chat.id;
    if (!userId || chatId === undefined) return;

    const data = callback.data || "";
    if (data === "sales_menu:products") {
      try {
        await telegram.answerCallbackQuery(callback.id, "Loading products").catch(() => undefined);
        await sendTelegramSalesCatalog(telegram, backend, sessions, update, chatId, userId);
      } catch (error) {
        await telegram.sendMessage(chatId, userMessageForError(error));
      }
      return;
    }

    if (data.startsWith("sales_menu:history:")) {
      const [, , offsetText = "0"] = data.split(":");
      const offset = Number(offsetText);
      try {
        await telegram.answerCallbackQuery(callback.id, "Loading requests").catch(() => undefined);
        await sendTelegramSalesHistory(
          telegram,
          backend,
          sessions,
          update,
          chatId,
          userId,
          Number.isInteger(offset) && offset >= 0 ? offset : 0,
        );
      } catch (error) {
        await telegram.sendMessage(chatId, userMessageForError(error));
      }
      return;
    }

    if (data === "sales_menu:support") {
      const state = await sessions.get(userId);
      const language = languageFromState(state);
      await telegram.answerCallbackQuery(callback.id, "Support").catch(() => undefined);
      await sendTelegramSalesSupport(telegram, chatId, language);
      return;
    }

    if (data === "sales_menu:language") {
      await telegram.answerCallbackQuery(callback.id, "Language").catch(() => undefined);
      await sendTelegramSalesLanguageSelector(telegram, sessions, update, chatId, userId);
      return;
    }

    if (data.startsWith("sales_lang:")) {
      const [, rawLanguage = ""] = data.split(":");
      const language = normalizeCustomerLanguage(rawLanguage);
      const existingSession = await sessions.getRecord(userId);
      await sessions.set(userId, {
        ...existingSession.state,
        language,
        lastCommand: "language",
        updatedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`, existingSession.expiresAt);
      await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Русский" : "English").catch(() => undefined);
      await telegram.sendMessage(
        chatId,
        language === "ru"
          ? "Готово. Язык покупок: русский."
          : "Done. Shopping language: English.",
        customerMenuMessageOptions(language),
      );
      await sendTelegramSalesMenu(telegram, sessions, update, chatId, userId);
      return;
    }

    if (data === "sales_menu:cancel") {
      const state = await sessions.get(userId);
      const language = languageFromState(state);
      await telegram.answerCallbackQuery(callback.id, "Cancelled").catch(() => undefined);
      await sessions.clear(userId);
      await telegram.sendMessage(
        chatId,
        language === "ru" ? "Текущее действие очищено." : "Current action cleared.",
        customerMenuMessageOptions(language),
      );
      return;
    }

    if (data.startsWith("sales_catalog_refresh:")) {
      const [, token = ""] = data.split(":");
      try {
        const state = await sessions.get(userId);
        if (!token || pendingString(state, "lastCatalogToken") !== token) {
          await telegram.answerCallbackQuery(callback.id, "Catalog expired").catch(() => undefined);
          await telegram.sendMessage(chatId, "Catalog expired. Loading a fresh catalog...");
          await sendTelegramSalesCatalog(telegram, backend, sessions, update, chatId, userId);
          return;
        }
        const queryText = pendingString(state, "query");
        const mode = pendingString(state, "lastCatalogMode") as "top" | "category" | "ai" || (queryText ? "ai" : "top");
        const categoryHandle = pendingString(state, "lastCategoryHandle") || undefined;
        const contextLabel = pendingString(state, "lastCategoryLabel") || undefined;
        await telegram.answerCallbackQuery(callback.id, "Refreshing").catch(() => undefined);
        await sendTelegramSalesCatalog(telegram, backend, sessions, update, chatId, userId, queryText || undefined, {
          mode,
          categoryHandle,
          contextLabel,
          limit: mode === "ai" ? 8 : mode === "category" ? 100 : 20,
        });
      } catch (error) {
        await telegram.sendMessage(chatId, userMessageForError(error));
      }
      return;
    }

    if (data.startsWith("sales_category:")) {
      const [, token = "", indexText = ""] = data.split(":");
      const state = await sessions.get(userId);
      const language = languageFromState(state);
      if (!token || pendingString(state, "lastCatalogToken") !== token) {
        await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Каталог устарел" : "Catalog expired").catch(() => undefined);
        await telegram.sendMessage(
          chatId,
          language === "ru" ? "Каталог устарел. Загружаю свежий каталог..." : "Catalog expired. Loading a fresh catalog...",
        );
        await sendTelegramSalesCatalog(telegram, backend, sessions, update, chatId, userId);
        return;
      }
      const index = Number(indexText);
      const category = asCatalogCategorySessionItems(state.lastCatalogCategories).find((candidate) => candidate.index === index);
      if (!category) {
        await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Категория не найдена" : "Category not found").catch(() => undefined);
        await telegram.sendMessage(
          chatId,
          language === "ru" ? "Категория не найдена. Откройте каталог снова." : "Category not found. Open the catalog again.",
        );
        return;
      }
      const categoryName = displayCategoryName(category.name);
      await telegram.answerCallbackQuery(callback.id, categoryName).catch(() => undefined);
      await sendCategoryCover(telegram, chatId, category, language);
      await sendTelegramSalesCatalog(telegram, backend, sessions, update, chatId, userId, undefined, {
        mode: "category",
        categoryHandle: category.handle,
        contextLabel: categoryName,
        limit: 100,
      });
      return;
    }

    if (data.startsWith("sales_ai_search:")) {
      const [, token = ""] = data.split(":");
      const existingSession = await sessions.getRecord(userId);
      const language = languageFromState(existingSession.state);
      if (token && pendingString(existingSession.state, "lastCatalogToken") !== token) {
        await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Каталог устарел" : "Catalog expired").catch(() => undefined);
      } else {
        await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Опишите товар" : "Describe product").catch(() => undefined);
      }
      await sessions.setPending(userId, {
        ...existingSession.state,
        pendingAction: "ai_catalog_search",
        language,
        binding: bindingContext(options, userId),
        requestedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(
        chatId,
        language === "ru"
          ? [
            "🔎 Напишите, что хотите найти.",
            "Можно описать вкус, крепость, формат или количество.",
            "Например: strong mint slim или citrus low.",
          ].join("\n")
          : [
            "🔎 Tell me what you want to find.",
            "You can describe flavor, strength, format, or quantity.",
            "Example: strong mint slim or citrus low.",
          ].join("\n"),
        customerMenuMessageOptions(language),
      );
      return;
    }

    if (data.startsWith("sales_detail:")) {
      const [, token = "", indexText = ""] = data.split(":");
      const state = await sessions.get(userId);
      const language = languageFromState(state);
      if (!token || pendingString(state, "lastCatalogToken") !== token) {
        await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Каталог устарел" : "Catalog expired").catch(() => undefined);
        await telegram.sendMessage(
          chatId,
          language === "ru" ? "Каталог устарел. Загружаю свежий каталог..." : "Catalog expired. Loading a fresh catalog...",
        );
        await sendTelegramSalesCatalog(telegram, backend, sessions, update, chatId, userId);
        return;
      }

      const index = Number(indexText);
      const item = asCatalogSessionItems(state.lastCatalogItems).find((candidate) => candidate.index === index);
      if (!item) {
        await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Товар не найден" : "Product not found").catch(() => undefined);
        await telegram.sendMessage(
          chatId,
          language === "ru" ? "Товар не найден в последнем каталоге. Откройте каталог снова." : "Product not found in the latest catalog. Open the catalog again.",
        );
        return;
      }
      await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Карточка товара" : "Product detail").catch(() => undefined);
      await sendProductCard(telegram, chatId, item, token, language, "detail");
      return;
    }

    if (data.startsWith("sales_quantity:")) {
      const [, token = "", indexText = ""] = data.split(":");
      const existingSession = await sessions.getRecord(userId);
      const state = existingSession.state;
      const language = languageFromState(state);
      if (!token || pendingString(state, "lastCatalogToken") !== token) {
        await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Каталог устарел" : "Catalog expired").catch(() => undefined);
        await telegram.sendMessage(
          chatId,
          language === "ru" ? "Каталог устарел. Откройте каталог снова." : "Product list expired. Open Catalog again.",
        );
        return;
      }
      const index = Number(indexText);
      const item = asCatalogSessionItems(state.lastCatalogItems).find((candidate) => candidate.index === index);
      if (!item) {
        await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Товар не найден" : "Product not found").catch(() => undefined);
        await telegram.sendMessage(
          chatId,
          language === "ru" ? "Товар не найден. Откройте каталог снова." : "Product not found. Open Catalog again.",
        );
        return;
      }
      await sessions.setPending(userId, {
        ...state,
        pendingAction: "product_quantity",
        pendingProductItem: item,
        pendingProductToken: token,
        language,
        binding: bindingContext(options, userId),
        requestedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Введите количество" : "Enter quantity").catch(() => undefined);
      await telegram.sendMessage(chatId, productQuantityPrompt(item, language), withHtml(customerMenuMessageOptions(language)));
      return;
    }

    if (data === "sales_cart:view") {
      const state = await sessions.get(userId);
      const language = languageFromState(state);
      const cart = cartSessionItemsFromRaw(state.cartItems);
      await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Корзина" : "Cart").catch(() => undefined);
      await telegram.sendMessage(chatId, formatCartMessage(cart, language), cart.length > 0 ? cartMessageOptions(language) : customerMenuMessageOptions(language));
      return;
    }

    if (data === "sales_cart:clear") {
      const existingSession = await sessions.getRecord(userId);
      const language = languageFromState(existingSession.state);
      await sessions.set(userId, {
        ...existingSession.state,
        cartItems: [],
        pendingAction: undefined,
        language,
        updatedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`, existingSession.expiresAt);
      await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Очищено" : "Cleared").catch(() => undefined);
      await telegram.sendMessage(
        chatId,
        language === "ru" ? "Корзина очищена." : "Cart cleared.",
        customerMenuMessageOptions(language),
      );
      return;
    }

    if (data === "sales_cart:checkout") {
      const existingSession = await sessions.getRecord(userId);
      const language = languageFromState(existingSession.state);
      const cart = cartSessionItemsFromRaw(existingSession.state.cartItems);
      if (cart.length === 0) {
        await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Корзина пустая" : "Cart is empty").catch(() => undefined);
        await telegram.sendMessage(chatId, formatCartMessage(cart, language), customerMenuMessageOptions(language));
        return;
      }
      await sessions.setPending(userId, {
        ...existingSession.state,
        pendingAction: "checkout_address",
        language,
        binding: bindingContext(options, userId),
        requestedStoreId: requireStoreForAiOrder(options) || "",
        requestedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Адрес" : "Address").catch(() => undefined);
      await telegram.sendMessage(
        chatId,
        [
          formatCartMessage(cart, language),
          "",
          cartCheckoutPrompt(language),
        ].join("\n"),
        withHtml(customerMenuMessageOptions(language)),
      );
      return;
    }

    if (data.startsWith("sales_history_detail:")) {
      const [, token = "", indexText = ""] = data.split(":");
      const state = await sessions.get(userId);
      const language = languageFromState(state);
      if (!token || pendingString(state, "lastHistoryToken") !== token) {
        await telegram.answerCallbackQuery(callback.id, "History expired").catch(() => undefined);
        await telegram.sendMessage(chatId, "History expired. Open My requests again.");
        return;
      }
      const index = Number(indexText);
      const item = asHistorySessionItems(state.lastHistoryItems).find((candidate) => candidate.index === index);
      if (!item) {
        await telegram.answerCallbackQuery(callback.id, "Request not found").catch(() => undefined);
        await telegram.sendMessage(chatId, "Request not found in the latest history page.");
        return;
      }
      await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Детали заявки" : "Request detail").catch(() => undefined);
      await telegram.sendMessage(chatId, formatTelegramSalesHistoryDetail(item, language), withHtml(customerMenuMessageOptions(language)));
      return;
    }

    if (data.startsWith("ai_order_select:")) {
      const [, token = "", indexText = ""] = data.split(":");
      const state = await sessions.get(userId);
      if (!token || pendingString(state, "callbackToken") !== token) {
        await telegram.answerCallbackQuery(callback.id, "Lua chon da het hieu luc").catch(() => undefined);
        await telegram.sendMessage(chatId, "Lua chon SKU nay da het hieu luc.");
        return;
      }
      const selectedText = aiOrderClarificationSelectionText(state, indexText);
      if (!selectedText) {
        await telegram.answerCallbackQuery(callback.id, "Khong doc duoc lua chon").catch(() => undefined);
        await telegram.sendMessage(chatId, "Khong doc duoc lua chon SKU. Gui lai /order voi SKU ro hon.");
        return;
      }
      await telegram.answerCallbackQuery(callback.id, "Da chon SKU").catch(() => undefined);
      await handleUpdate({
        update_id: update.update_id,
        message: {
          message_id: callback.message?.message_id || update.update_id,
          text: selectedText,
          chat: { id: chatId },
          from: callback.from,
        },
      }, telegram, backend, sessions, options);
      return;
    }

    if (data.startsWith("sales_select:")) {
      const [, token = "", indexText = ""] = data.split(":");
      const existingSession = await sessions.getRecord(userId);
      const state = existingSession.state;
      const language = languageFromState(state);
      if (!token || pendingString(state, "lastCatalogToken") !== token) {
        await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Каталог устарел" : "Catalog expired").catch(() => undefined);
        await telegram.sendMessage(
          chatId,
          language === "ru" ? "Каталог устарел. Откройте каталог снова." : "Product list expired. Open Catalog again.",
        );
        return;
      }

      const catalogSelection = catalogOrderSelectionFromState(state, indexText || "");
      if (catalogSelection.kind !== "selected") {
        await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Не удалось выбрать товар" : "Could not select product").catch(() => undefined);
        await telegram.sendMessage(
          chatId,
          catalogSelection.kind === "error" ? catalogSelection.message : "Khong chon duoc san pham. Gui /products de tai lai.",
        );
        return;
      }

      const cart = addCartItem(cartSessionItemsFromRaw(state.cartItems), catalogSelection.item, catalogSelection.quantity);
      await sessions.set(userId, {
        ...state,
        cartItems: cart,
        pendingAction: undefined,
        language,
        updatedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`, existingSession.expiresAt);
      await telegram.answerCallbackQuery(callback.id, language === "ru" ? "Добавлено" : "Added").catch(() => undefined);
      await telegram.sendMessage(
        chatId,
        [
          language === "ru"
            ? `Добавлено: ${catalogSelection.item.title} x${catalogSelection.quantity}`
            : `Added: ${catalogSelection.item.title} x${catalogSelection.quantity}`,
          "",
          formatCartMessage(cart, language),
        ].join("\n"),
        cartMessageOptions(language),
      );
      return;
    }

    if (!data.startsWith("confirm:")) {
      await telegram.answerCallbackQuery(callback.id, "Callback khong duoc ho tro").catch(() => undefined);
      return;
    }

    const [, action = "", token = ""] = data.split(":");
    const state = await sessions.get(userId);
    if (action === "abort") {
      if (token && pendingString(state, "callbackToken") === token) {
        await telegram.answerCallbackQuery(callback.id, "Da huy").catch(() => undefined);
        await sessions.clear(userId);
        await telegram.sendMessage(chatId, "Da huy trang thai hoi thoai hien tai.");
        return;
      }
      await telegram.answerCallbackQuery(callback.id, "Nut huy da het hieu luc").catch(() => undefined);
      await telegram.sendMessage(chatId, "Nut huy nay da het hieu luc.");
      return;
    }

    const confirmationText = callbackConfirmationText(state, action, token);
    if (!confirmationText) {
      await telegram.answerCallbackQuery(callback.id, "Khong co lenh dang cho xac nhan").catch(() => undefined);
      await telegram.sendMessage(chatId, "Khong co lenh nao dang cho xac nhan.");
      return;
    }

    await telegram.answerCallbackQuery(callback.id, "Dang xu ly").catch(() => undefined);
    await handleUpdate({
      update_id: update.update_id,
      message: {
        message_id: callback.message?.message_id || update.update_id,
        text: confirmationText,
        chat: { id: chatId },
        from: callback.from,
      },
    }, telegram, backend, sessions, options);
    return;
  }

  const message = update.message;
  if (!message?.text) return;

  const userId = telegramUserId(update);
  if (!userId) return;

  const text = message.text.trim();
  const alias = customerMenuAlias(text);
  const parsed = commandParts(message.text);
  const command = alias?.command || parsed.command;
  const args = alias?.args ?? parsed.args;
  const upperText = text.toUpperCase();

  if (isOperatorCommand(command) || isOperatorConfirmationText(upperText)) {
    const canUseOperatorCommands = await ensureOperatorAccess(telegram, backend, message.chat.id, userId);
    if (!canUseOperatorCommands) return;
  }

  if (!text.startsWith("/") && !alias) {
    const state: Record<string, unknown> = await sessions.get(userId).catch(() => ({}));
    const pendingAction = pendingString(state, "pendingAction");
    const language = languageFromState(state);

    if (pendingAction === "product_quantity") {
      const quantity = parseCustomerQuantityText(text);
      const pendingItem = asCatalogSessionItems([pendingObject(state, "pendingProductItem")])[0];
      if (!pendingItem) {
        await telegram.sendMessage(
          message.chat.id,
          language === "ru" ? "Карточка товара устарела. Откройте каталог снова." : "Product card expired. Open Catalog again.",
          customerMenuMessageOptions(language),
        );
        return;
      }
      if (quantity === null) {
        await telegram.sendMessage(
          message.chat.id,
          language === "ru" ? "Отправьте количество числом, например: 3." : "Send the quantity as a number, for example: 3.",
          customerMenuMessageOptions(language),
        );
        return;
      }
      const existingSession = await sessions.getRecord(userId);
      const cart = addCartItem(cartSessionItemsFromRaw(existingSession.state.cartItems), pendingItem, quantity);
      await sessions.set(userId, {
        ...existingSession.state,
        cartItems: cart,
        pendingAction: undefined,
        pendingProductItem: undefined,
        pendingProductToken: undefined,
        language,
        updatedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`, existingSession.expiresAt);
      await telegram.sendMessage(
        message.chat.id,
        [
          language === "ru"
            ? `Добавлено: ${pendingItem.title} x${quantity}`
            : `Added: ${pendingItem.title} x${quantity}`,
          "",
          formatCartMessage(cart, language),
        ].join("\n"),
        cartMessageOptions(language),
      );
      return;
    }

    if (pendingAction === "checkout_address") {
      if (mutationsDisabled(options)) {
        await sendMutationsDisabled(telegram, message.chat.id);
        return;
      }
      const cart = cartSessionItemsFromRaw(state.cartItems);
      if (cart.length === 0) {
        await telegram.sendMessage(message.chat.id, formatCartMessage(cart, language), customerMenuMessageOptions(language));
        return;
      }
      const selectedStoreId = requireStoreForAiOrder(options);
      if (!selectedStoreId) {
        await telegram.sendMessage(message.chat.id, "A store must be configured before taking Telegram sales requests.");
        return;
      }
      const address = text.trim();
      if (address.length < 5) {
        await telegram.sendMessage(
          message.chat.id,
          language === "ru" ? "Пожалуйста, отправьте полный адрес доставки." : "Please send a fuller delivery address.",
          customerMenuMessageOptions(language),
        );
        return;
      }
      const { salesDraft, aiDraft } = cartSalesDraft(
        update,
        message.chat.id,
        userId,
        cart,
        address,
        `Telegram cart checkout: ${cart.map((item) => `${item.title} x${item.quantity}`).join(", ")} | ${address}`,
        language,
      );
      await sendSalesDraftConfirmation(telegram, sessions, update, message.chat.id, userId, options, selectedStoreId, salesDraft, aiDraft);
      return;
    }

    if (pendingAction === "ai_catalog_search") {
      const rawQuery = text.trim();
      let queryText = searchQueryForAiOrder(rawQuery) || rawQuery;
      if (!aiOrderingDisabled(options)) {
        const aiDraft = await draftAiOrder(backend, userId, rawQuery, "sales").catch(() => null);
        if (aiDraft?.queryText) queryText = aiDraft.queryText;
        const firstSku = aiDraft?.items?.[0]?.sku || "";
        if (firstSku) queryText = firstSku;
      }
      await telegram.sendMessage(
        message.chat.id,
        language === "ru"
          ? `🔎 Ищу подходящие товары: ${rawQuery}`
          : `🔎 Finding matches for: ${rawQuery}`,
        customerMenuMessageOptions(language),
      );
      await sendTelegramSalesCatalog(telegram, backend, sessions, update, message.chat.id, userId, queryText, {
        mode: "ai",
        limit: 8,
        contextLabel: rawQuery,
      });
      return;
    }
  }

  if (upperText.startsWith("CONFIRM ORDER ")) {
    if (mutationsDisabled(options)) {
      await sendMutationsDisabled(telegram, message.chat.id);
      return;
    }
    try {
      const state = await sessions.get(userId);
      const code = text.slice("CONFIRM ORDER ".length).trim();
      const draft = asRemoteOrderDraft(pendingObject(state, "orderDraft"));
      const requiresBinding = pendingObject(state, "aiOrderDraft") && Object.keys(pendingObject(state, "aiOrderDraft")).length > 0;
      if (pendingString(state, "pendingAction") !== "create_order" || pendingString(state, "confirmCode") !== code || !draft) {
        await telegram.sendMessage(message.chat.id, "Khong co don remote nao dang cho xac nhan.");
        return;
      }
      const storedBinding = pendingObject(state, "binding");
      const hasStoredBinding = Object.keys(storedBinding).length > 0 && typeof storedBinding.telegramUserId === "string";
      if (hasStoredBinding && !bindingMatches(state, options, userId)) {
        await telegram.sendMessage(message.chat.id, "Xac nhan don het hieu luc: pham vi merchant/store khong khop. Gui lai /order.");
        return;
      }
      const requestedStoreId = pendingString(state, "requestedStoreId");
      const expectedStoreId = effectiveStoreId(options) || requestedStoreId || "";
      if (hasStoredBinding && expectedStoreId !== (effectiveStoreId(options) || "")) {
        await telegram.sendMessage(message.chat.id, "Xac nhan don het hieu luc: store da thay doi. Chon lai store roi gui /order.");
        return;
      }
      if (hasStoredBinding && !effectiveStoreId(options)) {
        await telegram.sendMessage(message.chat.id, "AI order can chon store truoc khi tao don.");
        return;
      }
      await checkAiConfirmIfSupported(backend, userId, draft, state, options);

      if (isPaymentIntentMethod(draft.paymentMethod)) {
        const baseKey = pendingString(state, "idempotencyKey");
        const result = await backend.createPaymentIntent(
          userId,
          draft,
          baseKey ? `${baseKey}:payment_intent` : idempotencyKey(update.update_id, "payment_intent", code),
        );
        await sessions.set(userId, {
          lastCommand: "create_order",
          confirmedAt: new Date().toISOString(),
          paymentIntentResult: result.data,
        }, `telegram:${update.update_id}:session`);
        await telegram.sendMessage(message.chat.id, formatPaymentIntent(result));
        return;
      }

      const result = await backend.createRemoteOrder(
        userId,
        draft,
        pendingString(state, "idempotencyKey") || idempotencyKey(update.update_id, "create_order", code),
      );
      await sessions.set(userId, {
        lastCommand: "create_order",
        confirmedAt: new Date().toISOString(),
        orderResult: result.data,
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(message.chat.id, formatCreatedOrder(result));
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (upperText.startsWith("CONFIRM REQUEST ")) {
    if (mutationsDisabled(options)) {
      await sendMutationsDisabled(telegram, message.chat.id);
      return;
    }
    try {
      const state = await sessions.get(userId);
      const language = languageFromState(state);
      const code = text.slice("CONFIRM REQUEST ".length).trim();
      const draft = asTelegramSalesDraft(pendingObject(state, "salesDraft"));
      if (pendingString(state, "pendingAction") !== "sales_draft" || pendingString(state, "confirmCode") !== code || !draft) {
        await telegram.sendMessage(message.chat.id, language === "ru" ? "Нет заявки, ожидающей подтверждения." : "No sales request is waiting for confirmation.");
        return;
      }
      const result = await backend.createTelegramSalesDraft(
        userId,
        draft,
        pendingString(state, "idempotencyKey") || idempotencyKey(update.update_id, "sales_draft", code),
      );
      await sessions.set(userId, {
        lastCommand: "sales_draft",
        language,
        confirmedAt: new Date().toISOString(),
        salesDraftResult: result.data,
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(message.chat.id, formatSubmittedSalesDraft(result, language), withHtml(customerMenuMessageOptions(language)));
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (upperText.startsWith("CONFIRM REFUND ")) {
    if (mutationsDisabled(options)) {
      await sendMutationsDisabled(telegram, message.chat.id);
      return;
    }
    try {
      const state = await sessions.get(userId);
      const [orderId = "", code = ""] = text.slice("CONFIRM REFUND ".length).trim().split(/\s+/);
      const draft = asRefundDraft(pendingObject(state, "refundDraft"));
      const pendingOrderId = pendingString(state, "orderId");
      if (pendingString(state, "pendingAction") !== "refund_order" || pendingOrderId !== orderId || pendingString(state, "confirmCode") !== code || !draft) {
        await telegram.sendMessage(message.chat.id, "Khong co refund nao dang cho xac nhan.");
        return;
      }

      const result = await backend.refundOrder(
        userId,
        orderId,
        { ...draft, confirmationToken: code },
        pendingString(state, "idempotencyKey") || idempotencyKey(update.update_id, "refund_order", orderId),
      );
      await sessions.set(userId, {
        lastCommand: "refund_order",
        orderId,
        confirmedAt: new Date().toISOString(),
        refundResult: result.data,
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(message.chat.id, formatRefund(result));
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (upperText.startsWith("CONFIRM AI APPROVE ")) {
    if (mutationsDisabled(options)) {
      await sendMutationsDisabled(telegram, message.chat.id);
      return;
    }
    try {
      const state = await sessions.get(userId);
      const actionId = text.slice("CONFIRM AI APPROVE ".length).trim();
      if (pendingString(state, "pendingAction") !== "ai_approve" || pendingString(state, "actionId") !== actionId) {
        await telegram.sendMessage(message.chat.id, "Khong co AI approve nao dang cho xac nhan.");
        return;
      }

      await backend.approveAiAction(
        userId,
        actionId,
        pendingString(state, "approvedText") || undefined,
        pendingString(state, "idempotencyKey") || idempotencyKey(update.update_id, "ai_approve", actionId),
      );
      await sessions.set(userId, {
        lastCommand: "ai_approve",
        actionId,
        confirmedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(message.chat.id, `Da approve AI action ${actionId}.`);
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (upperText.startsWith("CONFIRM AI REJECT ")) {
    if (mutationsDisabled(options)) {
      await sendMutationsDisabled(telegram, message.chat.id);
      return;
    }
    try {
      const state = await sessions.get(userId);
      const actionId = text.slice("CONFIRM AI REJECT ".length).trim();
      if (pendingString(state, "pendingAction") !== "ai_reject" || pendingString(state, "actionId") !== actionId) {
        await telegram.sendMessage(message.chat.id, "Khong co AI reject nao dang cho xac nhan.");
        return;
      }

      await backend.rejectAiAction(
        userId,
        actionId,
        pendingString(state, "reason") || undefined,
        pendingString(state, "idempotencyKey") || idempotencyKey(update.update_id, "ai_reject", actionId),
      );
      await sessions.set(userId, {
        lastCommand: "ai_reject",
        actionId,
        confirmedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(message.chat.id, `Da reject AI action ${actionId}.`);
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (upperText.startsWith("CONFIRM CANCEL ")) {
    if (mutationsDisabled(options)) {
      await sendMutationsDisabled(telegram, message.chat.id);
      return;
    }
    try {
      const state = await sessions.get(userId);
      const orderId = text.slice("CONFIRM CANCEL ".length).trim();
      const pendingOrderId = pendingString(state, "orderId");
      if (pendingString(state, "pendingAction") !== "cancel_order" || pendingOrderId !== orderId) {
        await telegram.sendMessage(message.chat.id, "Khong co lenh huy don nao dang cho xac nhan.");
        return;
      }

      await backend.cancelOrder(
        userId,
        orderId,
        { reason: pendingString(state, "reason") || undefined },
        pendingString(state, "idempotencyKey") || idempotencyKey(update.update_id, "cancel_order", orderId),
      );
      await sessions.set(userId, {
        lastCommand: "cancel_order",
        orderId,
        confirmedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(message.chat.id, `Da huy don ${orderId}.`);
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/start" || command === "/help") {
    try {
      const existingSession = await sessions.getRecord(userId);
      const language = languageFromState(existingSession.state);
      await sessions.set(userId, {
        ...existingSession.state,
        lastCommand: command === "/help" ? "help" : "start",
        language,
        startedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`, existingSession.expiresAt);
      await telegram.sendMessage(
        message.chat.id,
        language === "ru"
          ? [
            storefrontName(),
            "Каталог, заявки, язык и поддержка всегда доступны в кнопках снизу.",
            "Можно написать запрос прямо в чат, например: mint x2.",
          ].join("\n")
          : [
            storefrontName(),
            "Catalog, requests, language, and support stay available in the buttons below.",
            "You can also type a request directly, for example: mint x2.",
          ].join("\n"),
        customerMenuMessageOptions(language),
      );
      await telegram.sendMessage(
        message.chat.id,
        [
          labels(language).menuTitle,
          labels(language).menuSubtitle,
        ].join("\n"),
        mainMenuInlineOptions(language),
      );
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/menu") {
    try {
      await sendTelegramSalesMenu(telegram, sessions, update, message.chat.id, userId);
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/link" || command === "/link_operator") {
    const token = args.split(/\s+/)[0]?.trim();
    if (!token) {
      await telegram.sendMessage(message.chat.id, "Nhap token lien ket: /link <token>");
      return;
    }
    try {
      const displayName = message.from?.first_name || message.from?.username || userId;
      const result = await backend.linkOperatorTelegram(userId, token, displayName);
      await sessions.clear(userId);
      await telegram.sendMessage(message.chat.id, `Da lien ket Telegram voi operator ${result.data.operatorId}. Gui /me de kiem tra.`);
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/support") {
    const state = await sessions.get(userId);
    await sendTelegramSalesSupport(telegram, message.chat.id, languageFromState(state));
    return;
  }

  if (command === "/language" || command === "/lang") {
    await sendTelegramSalesLanguageSelector(telegram, sessions, update, message.chat.id, userId);
    return;
  }

  if (command === "/cart") {
    const state = await sessions.get(userId);
    const language = languageFromState(state);
    const cart = cartSessionItemsFromRaw(state.cartItems);
    await telegram.sendMessage(
      message.chat.id,
      formatCartMessage(cart, language),
      cart.length > 0 ? cartMessageOptions(language) : customerMenuMessageOptions(language),
    );
    return;
  }

  if (command === "/me") {
    try {
      const result = await backend.getMe(userId) as { data?: { operator?: { displayName?: string; role?: string }; permissions?: string[] } };
      const operator = result.data?.operator;
      const permissions = result.data?.permissions || [];
      await sessions.set(userId, {
        lastCommand: "me",
        authenticatedAt: new Date().toISOString(),
        operator,
        permissions,
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(
        message.chat.id,
        [
          `Da xac thuc: ${operator?.displayName || userId}`,
          `Vai tro: ${operator?.role || "unknown"}`,
          `Quyen: ${permissions.join(", ") || "none"}`,
        ].join("\n"),
      );
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/products" || command === "/product") {
    try {
      await sendTelegramSalesCatalog(telegram, backend, sessions, update, message.chat.id, userId, args || undefined);
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/history") {
    try {
      const offset = Number(args || 0);
      await sendTelegramSalesHistory(
        telegram,
        backend,
        sessions,
        update,
        message.chat.id,
        userId,
        Number.isInteger(offset) && offset >= 0 ? offset : 0,
      );
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/stock") {
    try {
      const result = await backend.searchProducts(userId, args || undefined, 5);
      await sessions.set(userId, {
        lastCommand: "stock",
        query: args || null,
        updatedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(message.chat.id, formatStockResults(result));
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/orders") {
    try {
      const result = await backend.listOrders(userId, 5);
      await sessions.set(userId, {
        lastCommand: "orders",
        limit: 5,
        updatedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(message.chat.id, formatOrders(result));
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/report") {
    try {
      const result = await backend.getDashboard(userId);
      await sessions.set(userId, {
        lastCommand: "report",
        updatedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(message.chat.id, formatDashboard(result));
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/accounting_report") {
    const parsed = parseAccountingReportArgs(args);
    if (!parsed.ok) {
      await telegram.sendMessage(message.chat.id, parsed.message);
      return;
    }

    try {
      const result = await backend.getAccountingReport(userId, parsed.value.name, parsed.value.filters);
      await sessions.set(userId, {
        lastCommand: "accounting_report",
        reportName: parsed.value.name,
        filters: parsed.value.filters,
        updatedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(message.chat.id, formatAccountingReport(parsed.value.name, result));
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/receipt") {
    if (!args) {
      await telegram.sendMessage(message.chat.id, "Nhap ma don hang: /receipt <orderId-hoac-orderNumber>");
      return;
    }
    try {
      const receipt = await backend.getReceiptText(userId, args);
      await sessions.set(userId, {
        lastCommand: "receipt",
        orderRef: args,
        updatedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await sendTextChunks(telegram, message.chat.id, receipt);
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/receipt_pdf") {
    if (!args) {
      await telegram.sendMessage(message.chat.id, "Nhap ma don hang: /receipt_pdf <orderId-hoac-orderNumber>");
      return;
    }
    try {
      const receipt = await backend.getReceiptPdf(userId, args);
      await sessions.set(userId, {
        lastCommand: "receipt_pdf",
        orderRef: args,
        updatedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendDocument(message.chat.id, receipt.data, receipt.filename, receipt.contentType, `Receipt ${args}`);
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/order" || command === "/buy") {
    if (!args) {
      await telegram.sendMessage(message.chat.id, "Use: Catalog then Add, or type /order <product name or SKU> x<quantity>.");
      return;
    }

    try {
      const existingSession = await sessions.getRecord(userId);
      const state = existingSession.state;
      const language = languageFromState(state);
      const catalogSelection = catalogOrderSelectionFromState(state, args);
      if (catalogSelection.kind === "error") {
        await telegram.sendMessage(message.chat.id, catalogSelection.message);
        return;
      }
      if (catalogSelection.kind === "selected") {
        const { item, quantity } = catalogSelection;
        const cart = addCartItem(cartSessionItemsFromRaw(state.cartItems), item, quantity);
        await sessions.set(userId, {
          ...state,
          cartItems: cart,
          pendingAction: undefined,
          language,
          updatedAt: new Date().toISOString(),
        }, `telegram:${update.update_id}:session`, existingSession.expiresAt);
        await telegram.sendMessage(
          message.chat.id,
          [
            language === "ru" ? `Добавлено: ${item.title} x${quantity}` : `Added: ${item.title} x${quantity}`,
            "",
            formatCartMessage(cart, language),
          ].join("\n"),
          cartMessageOptions(language),
        );
        return;
      }

      if (aiOrderingDisabled(options)) {
        await sendTelegramSalesCatalog(telegram, backend, sessions, update, message.chat.id, userId, searchQueryForAiOrder(args) || args, {
          mode: "ai",
          limit: 8,
          contextLabel: args,
        });
        return;
      }

      const aiDraft = await draftAiOrder(backend, userId, args, "sales");
      if (!aiDraft) {
        await sendTelegramSalesCatalog(telegram, backend, sessions, update, message.chat.id, userId, searchQueryForAiOrder(args) || args, {
          mode: "ai",
          limit: 8,
          contextLabel: args,
        });
        return;
      }
      const clarification = typeof aiDraft.clarification === "string"
        ? { type: "product", queryText: aiDraft.queryText, message: aiDraft.clarification, options: [] }
        : asAiOrderClarification(aiDraft.clarification);
      if (clarification) {
        const token = confirmationCode(update.update_id, "sales-clarify");
        await sessions.setPending(userId, {
          pendingAction: "ai_order_clarification",
          callbackToken: token,
          binding: bindingContext(options, userId),
          requestedStoreId: requireStoreForAiOrder(options) || "",
          aiOrderClarification: {
            originalText: args,
            queryText: clarification.queryText,
            quantity: parseAiOrderQuantity(args),
            paymentHint: "cod",
            options: clarification.options || [],
          },
          requestedAt: new Date().toISOString(),
        }, `telegram:${update.update_id}:session`);
        await telegram.sendMessage(
          message.chat.id,
          salesClarificationText(clarification),
          aiOrderClarificationMessageOptions(clarification, token),
        );
        return;
      }
      if (aiDraft.items.length === 0) {
        await sendTelegramSalesCatalog(telegram, backend, sessions, update, message.chat.id, userId, searchQueryForAiOrder(args) || args, {
          mode: "ai",
          limit: 8,
          contextLabel: args,
        });
        return;
      }

      const lookupQuery = aiDraft.items[0]?.sku || aiDraft.queryText || searchQueryForAiOrder(args) || args;
      const catalog = await backend.listTelegramSalesCatalog(userId, lookupQuery, 8);
      const catalogItems = catalogSessionItems(catalog);
      let cart = cartSessionItemsFromRaw(state.cartItems);
      for (const draftItem of aiDraft.items) {
        const matched = catalogItems.find((candidate) => candidate.variantId === draftItem.variantId || candidate.sku === draftItem.sku);
        const item: CatalogSessionItem = matched || {
          index: cart.length + 1,
          variantId: draftItem.variantId,
          title: draftItem.productName || draftItem.sku || draftItem.variantId,
          sku: draftItem.sku,
          availability: "available",
          canOrder: true,
        };
        cart = addCartItem(cart, item, Number(draftItem.quantity || 1));
      }
      await sessions.set(userId, {
        ...state,
        cartItems: cart,
        pendingAction: undefined,
        language,
        updatedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`, existingSession.expiresAt);
      await telegram.sendMessage(
        message.chat.id,
        [
          language === "ru" ? "Добавил подходящий товар в корзину." : "Added the matched product to your cart.",
          "",
          formatCartMessage(cart, language),
        ].join("\n"),
        cartMessageOptions(language),
      );
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/ai_order") {
    if (mutationsDisabled(options)) {
      await sendMutationsDisabled(telegram, message.chat.id);
      return;
    }
    if (aiOrderingDisabled(options)) {
      await sendAiOrderingDisabled(telegram, message.chat.id);
      return;
    }
    if (!args) {
      await telegram.sendMessage(message.chat.id, "Nhap: /order <mo ta don hang>. Vi du: /order 2 mint medium cho khach quen thanh toan QR");
      return;
    }
    const selectedStoreId = requireStoreForAiOrder(options);
    if (!selectedStoreId) {
      await telegram.sendMessage(message.chat.id, "AI order can mot store ro rang. Chon store trong mapping/operator config hoac chay bot voi TELEGRAM_STORE_ID.");
      return;
    }

    try {
      const aiDraft = await draftAiOrder(backend, userId, args);
      if (!aiDraft) {
        await telegram.sendMessage(message.chat.id, "AI order chua tim thay san pham con hang phu hop. Thu /stock <tu khoa> de xem ma hang.");
        return;
      }
      const clarification = typeof aiDraft.clarification === "string"
        ? { type: "product", queryText: aiDraft.queryText, message: aiDraft.clarification, options: [] }
        : asAiOrderClarification(aiDraft.clarification);
      if (clarification) {
        const token = confirmationCode(update.update_id, "ai-clarify");
        await sessions.setPending(userId, {
          pendingAction: "ai_order_clarification",
          callbackToken: token,
          binding: bindingContext(options, userId),
          requestedStoreId: selectedStoreId,
          aiOrderClarification: {
            originalText: args,
            queryText: clarification.queryText,
            quantity: parseAiOrderQuantity(args),
            paymentHint: aiOrderPaymentHint(args),
            options: clarification.options || [],
          },
          requestedAt: new Date().toISOString(),
        }, `telegram:${update.update_id}:session`);
        await telegram.sendMessage(
          message.chat.id,
          formatAiOrderClarification(clarification),
          aiOrderClarificationMessageOptions(clarification, token),
        );
        return;
      }
      if (aiDraft.items.length === 0) {
        await telegram.sendMessage(message.chat.id, "AI order chua tim thay san pham con hang phu hop. Thu /stock <tu khoa> de xem ma hang.");
        return;
      }

      const draft: RemoteOrderRequest = {
        items: aiDraft.items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
        customerId: aiDraft.customerId,
        paymentMethod: aiDraft.paymentMethod,
        note: aiDraft.note,
      };
      const code = confirmationCode(update.update_id, "ai-order");
      await sessions.setPending(userId, {
        pendingAction: "create_order",
        orderDraft: draft,
        confirmCode: code,
        callbackToken: code,
        binding: bindingContext(options, userId),
        requestedStoreId: selectedStoreId,
        idempotencyKey: idempotencyKey(update.update_id, "create_order", code),
        aiOrderDraft: {
          originalText: args,
          queryText: aiDraft.queryText,
          productName: aiDraft.items[0]?.productName,
          sku: aiDraft.items[0]?.sku,
          parser: aiDraft.parser,
          confidence: aiDraft.confidence,
          usageReservationToken: aiDraft.usageReservationToken,
        },
        requestedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(
        message.chat.id,
        [
          "AI da tao ban nhap don remote:",
          ...aiDraft.items.map((item) => `San pham: ${item.productName || item.variantId} (${item.sku || "unknown"}) x ${item.quantity}`),
          `Thanh toan: ${aiDraft.paymentMethod}`,
          `Khach: ${aiDraft.customerId || "none"}`,
          `Tu khoa: ${aiDraft.queryText}`,
          "Nhan Xac nhan hoac gui dung dong sau de thuc hien:",
          orderConfirmation(code),
        ].join("\n"),
        confirmationMessageOptions("create_order", code),
      );
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/create_order") {
    if (mutationsDisabled(options)) {
      await sendMutationsDisabled(telegram, message.chat.id);
      return;
    }
    const parsed = parseCreateOrderArgs(args);
    if (!parsed.ok) {
      await telegram.sendMessage(message.chat.id, parsed.message);
      return;
    }

    const code = confirmationCode(update.update_id, "order");
    const itemSummary = parsed.value.items.map(item => `${item.variantId} x ${item.quantity}`).join(", ");
    try {
      await sessions.setPending(userId, {
        pendingAction: "create_order",
        orderDraft: parsed.value,
        confirmCode: code,
        callbackToken: code,
        binding: bindingContext(options, userId),
        requestedStoreId: effectiveStoreId(options) || "",
        idempotencyKey: idempotencyKey(update.update_id, "create_order", code),
        requestedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(
        message.chat.id,
        [
          "Xac nhan tao don remote:",
          `San pham: ${itemSummary}`,
          `Thanh toan: ${parsed.value.paymentMethod || "cod"}`,
          parsed.value.customerId ? `Khach: ${parsed.value.customerId}` : "Khach: none",
          parsed.value.note ? `Ghi chu: ${parsed.value.note}` : "Ghi chu: none",
          "Nhan Xac nhan hoac gui dung dong sau de thuc hien:",
          orderConfirmation(code),
        ].join("\n"),
        confirmationMessageOptions("create_order", code),
      );
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/refund_order") {
    if (mutationsDisabled(options)) {
      await sendMutationsDisabled(telegram, message.chat.id);
      return;
    }
    const parsed = parseRefundArgs(args);
    if (!parsed.ok) {
      await telegram.sendMessage(message.chat.id, parsed.message);
      return;
    }

    const code = confirmationCode(update.update_id, "refund");
    try {
      await sessions.setPending(userId, {
        pendingAction: "refund_order",
        orderId: parsed.value.orderId,
        refundDraft: parsed.value.request,
        confirmCode: code,
        callbackToken: code,
        idempotencyKey: idempotencyKey(update.update_id, "refund_order", parsed.value.orderId),
        requestedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(
        message.chat.id,
        [
          `Xac nhan refund don ${parsed.value.orderId}.`,
          `So tien: ${parsed.value.request.amount === undefined ? "full" : formatVnd(parsed.value.request.amount)}`,
          `Ly do: ${parsed.value.request.reason}`,
          "Refund khong restock hang.",
          "Nhan Xac nhan hoac gui dung dong sau de thuc hien:",
          refundConfirmation(parsed.value.orderId, code),
        ].join("\n"),
        confirmationMessageOptions("refund_order", code),
      );
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/ai_queue") {
    try {
      const result = await backend.listAiReviewQueue(userId);
      await sessions.set(userId, {
        lastCommand: "ai_queue",
        updatedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(message.chat.id, formatAiQueue(result));
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/ai_approve") {
    if (mutationsDisabled(options)) {
      await sendMutationsDisabled(telegram, message.chat.id);
      return;
    }
    const [actionId = "", ...textParts] = args.split(/\s+/).filter(Boolean);
    if (!actionId) {
      await telegram.sendMessage(message.chat.id, "Nhap: /ai_approve <actionId> [approved_text]");
      return;
    }
    const approvedText = textParts.join(" ").trim();
    const callbackToken = confirmationCode(update.update_id, "ai-approve");
    try {
      await sessions.setPending(userId, {
        pendingAction: "ai_approve",
        actionId,
        approvedText: approvedText || null,
        callbackToken,
        idempotencyKey: idempotencyKey(update.update_id, "ai_approve", actionId),
        requestedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(
        message.chat.id,
        [
          `Xac nhan approve AI action ${actionId}.`,
          "Nhan Xac nhan hoac gui dung dong sau de thuc hien:",
          aiApproveConfirmation(actionId),
        ].join("\n"),
        confirmationMessageOptions("ai_approve", callbackToken),
      );
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/ai_reject") {
    if (mutationsDisabled(options)) {
      await sendMutationsDisabled(telegram, message.chat.id);
      return;
    }
    const [actionId = "", ...reasonParts] = args.split(/\s+/).filter(Boolean);
    if (!actionId) {
      await telegram.sendMessage(message.chat.id, "Nhap: /ai_reject <actionId> [ly_do]");
      return;
    }
    const reason = reasonParts.join(" ").trim() || "operator_rejected";
    const callbackToken = confirmationCode(update.update_id, "ai-reject");
    try {
      await sessions.setPending(userId, {
        pendingAction: "ai_reject",
        actionId,
        reason,
        callbackToken,
        idempotencyKey: idempotencyKey(update.update_id, "ai_reject", actionId),
        requestedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(
        message.chat.id,
        [
          `Xac nhan reject AI action ${actionId}.`,
          `Ly do: ${reason}`,
          "Nhan Xac nhan hoac gui dung dong sau de thuc hien:",
          aiRejectConfirmation(actionId),
        ].join("\n"),
        confirmationMessageOptions("ai_reject", callbackToken),
      );
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/cancel_order") {
    if (mutationsDisabled(options)) {
      await sendMutationsDisabled(telegram, message.chat.id);
      return;
    }
    const [orderId = "", ...reasonParts] = args.split(/\s+/).filter(Boolean);
    if (!orderId) {
      await telegram.sendMessage(message.chat.id, "Nhap ma don hang: /cancel_order <orderId> [ly do]");
      return;
    }

    const reason = reasonParts.join(" ").trim();
    const callbackToken = confirmationCode(update.update_id, "cancel");
    try {
      await sessions.setPending(userId, {
        pendingAction: "cancel_order",
        orderId,
        reason: reason || null,
        callbackToken,
        idempotencyKey: idempotencyKey(update.update_id, "cancel_order", orderId),
        requestedAt: new Date().toISOString(),
      }, `telegram:${update.update_id}:session`);
      await telegram.sendMessage(
        message.chat.id,
        [
          `Xac nhan huy don ${orderId}.`,
          `Nhan Xac nhan hoac gui dung dong sau de thuc hien:`,
          cancelConfirmation(orderId),
        ].join("\n"),
        confirmationMessageOptions("cancel_order", callbackToken),
      );
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (command === "/cancel") {
    try {
      let language: CustomerLanguage = "en";
      try {
        language = languageFromState(await sessions.get(userId));
      } catch {
        language = "en";
      }
      await sessions.clear(userId);
      await telegram.sendMessage(
        message.chat.id,
        language === "ru" ? "Текущее действие очищено." : "Current action cleared.",
        customerMenuMessageOptions(language),
      );
    } catch (error) {
      await telegram.sendMessage(message.chat.id, userMessageForError(error));
    }
    return;
  }

  if (!text.startsWith("/")) {
    await handleUpdate({
      update_id: update.update_id,
      message: {
        ...message,
        text: `/order ${text}`,
      },
    }, telegram, backend, sessions, options);
    return;
  }

  const finalState = await sessions.get(userId);
  const finalLanguage = languageFromState(finalState);
  await telegram.sendMessage(
    message.chat.id,
    finalLanguage === "ru"
      ? "Команда не поддерживается. Используйте Каталог, /order 1 для заявки по номеру или /help."
      : "Command is not supported. Use Catalog, /order 1 to request by number, or /help.",
    customerMenuMessageOptions(finalLanguage),
  );
}
