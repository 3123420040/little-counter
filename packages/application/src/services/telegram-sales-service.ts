import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { headerValue, type HeadersLike } from "../http/headers";
import { withScopedIdempotency } from "../db/idempotency";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import { recordAuditEntry } from "../repositories/audit-repository";
import type { OperatingScope, PermissionId, ReportScope } from "@medusa-snus/contracts";
import type { OperatorContext } from "./auth-service";
import { authenticateChannelServiceOnlyHeaders, type ChannelActor } from "./channel-auth-service";
import { completeSale, createRemoteOrder, quoteSaleForClient, type RemoteOrderInput, type SaleInput } from "./order-service";
import { readPaymentFeeInput } from "./payment-fee-calculation";
import { listProducts, type ProductView } from "./product-service";
import { enqueueTelegramNotificationForClient } from "./telegram-notification-service";
import { routeTelegramNotificationEvent } from "./telegram-notification-router-service";

const TELEGRAM_SALES_OPS = {
  createDraft: "telegram_sales.create_draft",
} as const;

const MAX_LINE_QUANTITY = 99;
const DEFAULT_DRAFT_EXPIRY_HOURS = 24;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type TelegramSalesLanguage = "en" | "ru";
type TelegramSalesAvailability = "available" | "low_stock" | "out_of_stock";
type TelegramSalesStatus = "pending" | "needs_review" | "converted" | "rejected" | "expired" | "cancelled";
type StaffActor = OperatorContext | ChannelActor;

export interface TelegramSalesProfileInput {
  telegramUserId?: string;
  telegramChatId?: string;
  username?: string;
  firstName?: string;
  language?: string;
  customerId?: string;
  phone?: string;
}

export interface TelegramSalesLineInput {
  variantId: string;
  quantity: number;
}

export interface TelegramSalesDeliveryInput {
  address?: string;
  note?: string;
  zone?: string;
  eta?: string;
}

export interface TelegramSalesDraftInput {
  profile?: TelegramSalesProfileInput;
  items: TelegramSalesLineInput[];
  delivery?: TelegramSalesDeliveryInput;
  customerMessage?: string;
  aiMetadata?: Record<string, unknown>;
  shippingFee?: number;
}

export interface TelegramSalesQuoteInput {
  items: TelegramSalesLineInput[];
  shippingFee?: number;
}

export interface TelegramSalesDraftQuery {
  status?: string;
  q?: string;
  limit?: string | number;
  offset?: string | number;
}

export interface TelegramSalesConfirmInput {
  shippingFee?: number;
  operatorNotes?: string;
}

export interface TelegramSalesCheckoutInput extends SaleInput {
  operatorNotes?: string;
}

export interface TelegramSalesRejectInput {
  reason?: string;
}

interface TelegramSalesServiceContext {
  merchantId: string;
  storeId: string;
  stockLocationId: string;
  organizationId: string;
  channelUserId?: string;
  serviceIdentity: string;
  telegramBotConfigId?: string;
  requestId?: string;
}

interface TelegramSalesProfile {
  id: string;
  merchantId: string;
  storeId: string | null;
  telegramUserId: string;
  telegramChatId: string | null;
  telegramUsername: string | null;
  telegramFirstName: string | null;
  language: TelegramSalesLanguage;
  customerId: string | null;
  phone: string | null;
  status: string;
}

type TelegramSalesDraftRow = Record<string, unknown> & {
  id: string;
  merchant_id: string;
  store_id: string;
  profile_id: string;
  telegram_user_id: string;
  telegram_chat_id: string | null;
  telegram_username: string | null;
  language: TelegramSalesLanguage;
  status: TelegramSalesStatus;
  items: unknown;
  quote: unknown;
  delivery: unknown;
  customer_message: string | null;
  operator_notes: string | null;
  ai_metadata: unknown;
  source: string;
  idempotency_key: string;
  converted_order_id: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | string | null;
  expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function toInteger(value: string | number | undefined, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

function normalizeLanguage(value: unknown): TelegramSalesLanguage {
  return value === "ru" ? "ru" : "en";
}

function normalizeMoney(value: unknown, field: string): number {
  const amount = Math.round(Number(value || 0));
  if (!Number.isFinite(amount) || amount < 0) {
    throw new PlatformError("validation_error", `${field} must be a non-negative amount`, 400);
  }
  return amount;
}

function normalizeText(value: unknown, maxLength: number, field: string): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new PlatformError("validation_error", `${field} must be at most ${maxLength} characters`, 400);
  }
  return text;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength - 1).trimEnd() : value;
}

function assertDraftId(value: string): string {
  const draftId = String(value || "").trim();
  if (!UUID_PATTERN.test(draftId)) {
    throw new PlatformError("validation_error", "Telegram sales draft id is invalid", 400);
  }
  return draftId;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isoTimestamp(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function availabilityBand(stock: number): TelegramSalesAvailability {
  if (stock <= 0) return "out_of_stock";
  if (stock <= 2) return "low_stock";
  return "available";
}

const TELEGRAM_CATALOG_SEARCH_STOPWORDS = new Set([
  "i", "me", "my", "want", "need", "please", "maybe", "can", "cans", "pouch", "pouches", "pack", "packs", "snus", "nicotine",
  "a", "an", "the", "for", "to", "of", "and", "or", "with", "about", "like", "buy", "order", "get",
  "toi", "tôi", "muon", "muốn", "can", "cần", "mua", "hop", "hộp", "goi", "gói", "cai", "cái",
  "хочу", "нужно", "купить", "банка", "банки", "пачка", "пачки", "снюс",
]);

function normalizeCatalogSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9а-яё]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function catalogSearchTokens(value: string): string[] {
  const normalized = normalizeCatalogSearchText(value);
  if (!normalized) return [];
  return Array.from(new Set(normalized.split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !TELEGRAM_CATALOG_SEARCH_STOPWORDS.has(token) && !/^\d+$/.test(token))));
}

function scoreCatalogProduct(product: ProductView, queryText: string): number {
  const tokens = catalogSearchTokens(queryText);
  if (tokens.length === 0) return 0;
  const variant = product.variants[0];
  const title = normalizeCatalogSearchText(product.title);
  const sku = normalizeCatalogSearchText(variant?.sku || "");
  const categories = normalizeCatalogSearchText(product.categories.map((category) => category.name).join(" "));
  const haystack = [title, sku, categories].filter(Boolean).join(" ");
  const phrase = normalizeCatalogSearchText(queryText);
  let score = haystack.includes(phrase) ? 30 : 0;
  for (const token of tokens) {
    if (sku.includes(token)) score += 12;
    if (title.includes(token)) score += 8;
    if (categories.includes(token)) score += 4;
  }
  return score;
}

function rankCatalogSearchProducts(products: ProductView[], queryText?: string): ProductView[] {
  const text = String(queryText || "").trim();
  if (!text) return products;
  return products
    .map((product) => ({ product, score: scoreCatalogProduct(product, text) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.product.title.localeCompare(b.product.title))
    .map((entry) => entry.product);
}

function formatVnd(value: unknown): string {
  return `${Math.round(Number(value || 0)).toLocaleString("vi-VN")} VND`;
}

function normalizeLines(items: TelegramSalesLineInput[] | undefined): TelegramSalesLineInput[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new PlatformError("validation_error", "At least one item is required", 400);
  }
  const byVariant = new Map<string, number>();
  for (const item of items) {
    const variantId = String(item?.variantId || "").trim();
    const quantity = Number(item?.quantity);
    if (!variantId) throw new PlatformError("validation_error", "variantId is required", 400);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_LINE_QUANTITY) {
      throw new PlatformError("validation_error", `Quantity must be between 1 and ${MAX_LINE_QUANTITY}`, 400);
    }
    byVariant.set(variantId, (byVariant.get(variantId) || 0) + quantity);
  }
  return Array.from(byVariant.entries()).map(([variantId, quantity]) => {
    if (quantity > MAX_LINE_QUANTITY) {
      throw new PlatformError("validation_error", `Quantity must be between 1 and ${MAX_LINE_QUANTITY}`, 400);
    }
    return { variantId, quantity };
  });
}

function normalizeDelivery(input: TelegramSalesDeliveryInput | undefined): Record<string, unknown> {
  return {
    address: normalizeText(input?.address, 500, "delivery.address"),
    note: normalizeText(input?.note, 500, "delivery.note"),
    zone: normalizeText(input?.zone, 120, "delivery.zone"),
    eta: normalizeText(input?.eta, 120, "delivery.eta"),
  };
}

function draftExpiryHours(): number {
  const parsed = Number(process.env.TELEGRAM_SALES_DRAFT_EXPIRY_HOURS || DEFAULT_DRAFT_EXPIRY_HOURS);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 168 ? parsed : DEFAULT_DRAFT_EXPIRY_HOURS;
}

async function resolveTelegramSalesServiceContext(headers: HeadersLike): Promise<TelegramSalesServiceContext> {
  const service = authenticateChannelServiceOnlyHeaders(headers);
  const requestedStoreId = headerValue(headers, "x-store-id") || headerValue(headers, "x-operating-store-id");
  const channelUserId = headerValue(headers, "x-channel-user-id") || undefined;

  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    let merchantId = service.merchantId || "";
    let configStoreId: string | null = null;
    if (!merchantId && service.telegramBotConfigId) {
      const config = await queryOne<{ merchant_id: string; default_store_id: string | null }>(client, `
        SELECT merchant_id, default_store_id
        FROM app.telegram_bot_configs
        WHERE id = $1 AND status = 'active'
        LIMIT 1
      `, [service.telegramBotConfigId]);
      if (!config) throw new PlatformError("telegram_bot_config_not_found", "Telegram bot config not found", 403);
      merchantId = config.merchant_id;
      configStoreId = config.default_store_id;
    }
    if (!merchantId) throw new PlatformError("scope_required", "Telegram sales channel requires merchant scope", 409);

    const merchant = await queryOne<{ id: string; legacy_organization_id: string }>(client, `
      SELECT id, legacy_organization_id
      FROM app.merchants
      WHERE id = $1 AND status = 'active'
      LIMIT 1
    `, [merchantId]);
    if (!merchant) throw new PlatformError("merchant_not_found", "Merchant not found for Telegram sales channel", 403);

    const targetStoreId = requestedStoreId || configStoreId || null;
    const store = await queryOne<{ id: string; stock_location_id: string }>(client, `
      SELECT id, stock_location_id
      FROM app.stores
      WHERE merchant_id = $1
        AND status = 'active'
        AND ($2::text IS NULL OR id = $2::text)
      ORDER BY CASE WHEN id = $2::text THEN 0 WHEN is_primary THEN 1 ELSE 2 END, display_name ASC
      LIMIT 1
    `, [merchantId, targetStoreId]);
    if (!store) throw new PlatformError("scope_required", "Telegram sales channel requires an active store", 409);

    return {
      merchantId,
      storeId: store.id,
      stockLocationId: store.stock_location_id,
      organizationId: merchant.legacy_organization_id,
      channelUserId,
      serviceIdentity: service.serviceIdentity,
      telegramBotConfigId: service.telegramBotConfigId,
      requestId: service.requestId,
    };
  });
}

function normalizeProfileInput(ctx: TelegramSalesServiceContext, input: TelegramSalesProfileInput | undefined): Required<Pick<TelegramSalesProfileInput, "telegramUserId" | "telegramChatId">> & TelegramSalesProfileInput {
  const requestedUserId = String(input?.telegramUserId || "").trim();
  const telegramUserId = ctx.channelUserId || requestedUserId;
  if (!telegramUserId) throw new PlatformError("validation_error", "Telegram user id is required", 400);
  if (ctx.channelUserId && requestedUserId && requestedUserId !== ctx.channelUserId) {
    throw new PlatformError("forbidden", "Telegram profile does not match channel user", 403);
  }
  return {
    telegramUserId,
    telegramChatId: String(input?.telegramChatId || telegramUserId).trim(),
    username: normalizeText(input?.username, 64, "profile.username") || undefined,
    firstName: normalizeText(input?.firstName, 120, "profile.firstName") || undefined,
    language: normalizeLanguage(input?.language),
    customerId: normalizeText(input?.customerId, 120, "profile.customerId") || undefined,
    phone: normalizeText(input?.phone, 50, "profile.phone") || undefined,
  };
}

async function upsertTelegramSalesProfileForClient(
  client: PoolClient,
  ctx: TelegramSalesServiceContext,
  input: TelegramSalesProfileInput | undefined,
): Promise<TelegramSalesProfile> {
  const profile = normalizeProfileInput(ctx, input);
  const row = await queryOne<{
    id: string;
    merchant_id: string;
    store_id: string | null;
    telegram_user_id: string;
    telegram_chat_id: string | null;
    telegram_username: string | null;
    telegram_first_name: string | null;
    language: TelegramSalesLanguage;
    customer_id: string | null;
    phone: string | null;
    status: string;
  }>(client, `
    INSERT INTO app.telegram_sales_profiles (
      merchant_id, store_id, telegram_user_id, telegram_chat_id, telegram_username,
      telegram_first_name, language, customer_id, phone, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
    ON CONFLICT (merchant_id, telegram_user_id) DO UPDATE SET
      store_id = EXCLUDED.store_id,
      telegram_chat_id = COALESCE(EXCLUDED.telegram_chat_id, app.telegram_sales_profiles.telegram_chat_id),
      telegram_username = COALESCE(EXCLUDED.telegram_username, app.telegram_sales_profiles.telegram_username),
      telegram_first_name = COALESCE(EXCLUDED.telegram_first_name, app.telegram_sales_profiles.telegram_first_name),
      language = EXCLUDED.language,
      customer_id = COALESCE(EXCLUDED.customer_id, app.telegram_sales_profiles.customer_id),
      phone = COALESCE(EXCLUDED.phone, app.telegram_sales_profiles.phone),
      metadata = app.telegram_sales_profiles.metadata || EXCLUDED.metadata,
      updated_at = now()
    RETURNING id, merchant_id, store_id, telegram_user_id, telegram_chat_id, telegram_username,
      telegram_first_name, language, customer_id, phone, status
  `, [
    ctx.merchantId,
    ctx.storeId,
    profile.telegramUserId,
    profile.telegramChatId || null,
    profile.username || null,
    profile.firstName || null,
    normalizeLanguage(profile.language),
    profile.customerId || null,
    profile.phone || null,
    JSON.stringify({
      telegramBotConfigId: ctx.telegramBotConfigId || null,
      lastServiceIdentity: ctx.serviceIdentity,
    }),
  ]);
  if (!row) throw new PlatformError("internal_error", "Telegram sales profile could not be saved", 500);
  if (row.status === "blocked") throw new PlatformError("forbidden", "Telegram user is blocked", 403);
  return {
    id: row.id,
    merchantId: row.merchant_id,
    storeId: row.store_id,
    telegramUserId: row.telegram_user_id,
    telegramChatId: row.telegram_chat_id,
    telegramUsername: row.telegram_username,
    telegramFirstName: row.telegram_first_name,
    language: row.language,
    customerId: row.customer_id,
    phone: row.phone,
    status: row.status,
  };
}

async function quoteTelegramSalesCartForClient(
  client: PoolClient,
  ctx: Pick<TelegramSalesServiceContext, "merchantId" | "storeId" | "stockLocationId">,
  input: TelegramSalesQuoteInput,
) {
  const lines = normalizeLines(input.items);
  const shippingFee = normalizeMoney(input.shippingFee, "shippingFee");
  const quoted = await quoteSaleForClient(client, {
    items: lines,
    paymentMethod: "cod",
    amountReceived: 0,
    shippingFee,
    salesChannel: "telegram",
  }, ctx.stockLocationId, ctx.merchantId, ctx.storeId);
  const items = quoted.items.map((item) => {
    const stock = Number(item.stock || 0);
    const quantity = Number(item.quantity || 0);
    return {
      productId: item.productId,
      variantId: item.variantId,
      sku: item.sku,
      title: item.name,
      quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      availability: availabilityBand(stock),
      canFulfill: stock >= quantity,
    };
  });
  const warnings = items
    .filter((item) => !item.canFulfill)
    .map((item) => ({
      code: "insufficient_stock",
      variantId: item.variantId,
      title: item.title,
    }));
  return {
    currencyCode: "vnd",
    subtotal: quoted.totals.subtotal,
    discount: quoted.totals.discount,
    shippingFee: quoted.totals.shippingFee,
    tax: quoted.totals.tax,
    total: quoted.totals.total,
    paymentMethod: "cod",
    salesChannel: "telegram",
    items,
    warnings,
  };
}

function formatDraftRow(row: TelegramSalesDraftRow) {
  const quote = asRecord(row.quote);
  return {
    id: row.id,
    merchantId: row.merchant_id,
    storeId: row.store_id,
    profileId: row.profile_id,
    telegramUserId: row.telegram_user_id,
    telegramChatId: row.telegram_chat_id,
    telegramUsername: row.telegram_username,
    language: row.language,
    status: row.status,
    items: asArray(row.items),
    quote,
    delivery: asRecord(row.delivery),
    customerMessage: row.customer_message,
    operatorNotes: row.operator_notes,
    aiMetadata: asRecord(row.ai_metadata),
    source: row.source,
    convertedOrderId: row.converted_order_id,
    reviewedBy: row.reviewed_by,
    reviewedAt: isoTimestamp(row.reviewed_at),
    expiresAt: isoTimestamp(row.expires_at),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function formatCustomerDraftRow(row: TelegramSalesDraftRow) {
  const quote = asRecord(row.quote);
  const delivery = asRecord(row.delivery);
  const quoteItems = asArray(quote.items).map((item) => {
    const record = asRecord(item);
    return {
      title: typeof record.title === "string" ? record.title : undefined,
      sku: typeof record.sku === "string" ? record.sku : undefined,
      quantity: Number(record.quantity || 0),
      unitPrice: Number(record.unitPrice || 0),
      lineTotal: Number(record.lineTotal || 0),
      availability: typeof record.availability === "string" ? record.availability : undefined,
    };
  });
  return {
    id: row.id,
    status: row.status,
    customerMessage: row.customer_message,
    convertedOrderId: row.converted_order_id,
    delivery: {
      address: typeof delivery.address === "string" ? delivery.address : null,
      note: typeof delivery.note === "string" ? delivery.note : null,
      zone: typeof delivery.zone === "string" ? delivery.zone : null,
      eta: typeof delivery.eta === "string" ? delivery.eta : null,
    },
    quote: {
      currencyCode: typeof quote.currencyCode === "string" ? quote.currencyCode : "vnd",
      total: Number(quote.total || 0),
      shippingFee: Number(quote.shippingFee || 0),
      items: quoteItems,
    },
    createdAt: isoTimestamp(row.created_at),
    reviewedAt: isoTimestamp(row.reviewed_at),
    expiresAt: isoTimestamp(row.expires_at),
  };
}

async function resolveTelegramSalesNotificationRecipient(
  client: PoolClient,
  ctx: TelegramSalesServiceContext,
): Promise<string | null> {
  const row = await queryOne<{ operator_id: string }>(client, `
    SELECT oi.operator_id
    FROM app.operator_identities oi
    JOIN medusa.staff_users su
      ON su.operator_id = oi.operator_id
     AND su.is_active = true
    WHERE oi.organization_id = $1
      AND oi.provider = 'telegram'
      AND oi.is_active = true
      AND (oi.merchant_id = $2 OR oi.merchant_id IS NULL)
      AND (oi.default_store_id = $3 OR oi.default_store_id IS NULL)
    ORDER BY
      CASE WHEN oi.merchant_id = $2 THEN 0 ELSE 1 END,
      CASE WHEN oi.default_store_id = $3 THEN 0 ELSE 1 END,
      CASE su.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
      oi.verified_at DESC NULLS LAST,
      oi.updated_at DESC
    LIMIT 1
  `, [ctx.organizationId, ctx.merchantId, ctx.storeId]);
  return row?.operator_id || null;
}

async function notifyTelegramSalesDraftCreated(
  client: PoolClient,
  ctx: TelegramSalesServiceContext,
  row: TelegramSalesDraftRow,
  quote: Awaited<ReturnType<typeof quoteTelegramSalesCartForClient>>,
): Promise<void> {
  try {
    const customer = row.telegram_username ? `@${row.telegram_username}` : row.telegram_user_id;
    const telegramUrl = row.telegram_username
      ? `https://t.me/${String(row.telegram_username).replace(/^@/, "")}`
      : `tg://user?id=${row.telegram_user_id}`;
    const total = Number(quote.total || 0);
    const routed = await routeTelegramNotificationEvent(client, {
      id: `telegram-sales-draft:${row.id}`,
      eventType: "telegram_sales_request_created",
      payload: {
        merchantId: ctx.merchantId,
        storeId: ctx.storeId,
        channel: "telegram",
        draftId: row.id,
        customer,
        telegramUserId: row.telegram_user_id,
        telegramUsername: row.telegram_username,
        telegramUrl,
        total,
        currencyCode: quote.currencyCode,
        itemCount: quote.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        portalPath: "/telegram-sales",
        actionLabel: "Thanh toán",
      },
    });
    if (routed.matched > 0) return;

    const recipientOperatorId = await resolveTelegramSalesNotificationRecipient(client, ctx);
    if (!recipientOperatorId) return;

    await enqueueTelegramNotificationForClient(client, `telegram-sales-draft:${row.id}`, {
      organizationId: ctx.organizationId,
      merchantId: ctx.merchantId,
      storeId: ctx.storeId,
      recipientOperatorId,
      template: "telegram_sales_request_created",
      payload: {
        draftId: row.id,
        customer,
        telegramUserId: row.telegram_user_id,
        telegramUsername: row.telegram_username,
        telegramUrl,
        total,
        currencyCode: quote.currencyCode,
        itemCount: quote.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        portalPath: "/telegram-sales",
        actionLabel: "Thanh toán",
        text: [
          "Telegram sales request moi",
          `Draft: ${row.id}`,
          `Khach: ${customer}`,
          `Tong du kien: ${formatVnd(total)}`,
          `Chat Telegram: ${telegramUrl}`,
          "Xu ly tai POS: /telegram-sales",
        ].join("\n"),
      },
    });
  } catch {
    // Draft creation must remain available even when operator notification routing is not configured.
  }
}

export async function listTelegramSalesCatalog(headers: HeadersLike, query: { q?: string; categoryHandle?: string; limit?: string | number } = {}) {
  const ctx = await resolveTelegramSalesServiceContext(headers);
  const requestedLimit = toInteger(query.limit, 20, 100);
  const searchText = String(query.q || "").trim();
  const fetchLimit = searchText ? 200 : query.categoryHandle ? requestedLimit : Math.max(requestedLimit, 80);
  const products = rankCatalogSearchProducts(await listProducts({
    categoryHandle: query.categoryHandle,
    limit: fetchLimit,
    merchantId: ctx.merchantId,
    stockLocationId: ctx.stockLocationId,
  }), searchText);
  const salesByVariant = await withConnectedClient(async (client) => {
    const variantIds = products.map((product) => product.variants[0]?.id).filter((id): id is string => Boolean(id));
    if (variantIds.length === 0) return new Map<string, number>();
    const metadataRows = await client.query<{ variant_id: string; sales_quantity: string | null }>(`
      SELECT id AS variant_id, NULLIF(metadata->>'telegramSalesQuantity', '') AS sales_quantity
      FROM public.product_variant
      WHERE id = ANY($1::text[])
        AND deleted_at IS NULL
    `, [variantIds]);
    const fallbackSalesByVariant = new Map(
      metadataRows.rows
        .map((row) => [row.variant_id, Number(row.sales_quantity || 0)] as const)
        .filter(([, quantity]) => Number.isFinite(quantity) && quantity > 0),
    );
    try {
      const rows = await client.query<{ variant_id: string; sales_quantity: string }>(`
        SELECT li.variant_id, COALESCE(SUM(oi.quantity), 0)::text AS sales_quantity
        FROM public.order_item oi
        JOIN public.order_line_item li
          ON li.id = oi.item_id
         AND li.deleted_at IS NULL
        JOIN public."order" o
          ON o.id = oi.order_id
         AND o.deleted_at IS NULL
        WHERE oi.deleted_at IS NULL
          AND li.variant_id = ANY($1::text[])
          AND o.merchant_id = $2
          AND o.store_id = $3
        GROUP BY li.variant_id
      `, [variantIds, ctx.merchantId, ctx.storeId]);
      for (const row of rows.rows) {
        const quantity = Number(row.sales_quantity || 0);
        if (quantity > 0) {
          fallbackSalesByVariant.set(row.variant_id, Math.max(Number(fallbackSalesByVariant.get(row.variant_id) || 0), quantity));
        }
      }
      return fallbackSalesByVariant;
    } catch {
      return fallbackSalesByVariant;
    }
  });
  const hasSalesHistory = Array.from(salesByVariant.values()).some((value) => value > 0);
  return {
    data: products.map((product) => {
      const variant = product.variants[0];
      const stock = Number(variant?.inventory_quantity || 0);
      const primaryCategory = product.categories[0];
      return {
        productId: product.id,
        variantId: variant?.id || "",
        title: product.title,
        status: product.status,
        imageUrl: product.imageUrl,
        categories: product.categories,
        categoryName: primaryCategory?.name || "Other",
        categoryHandle: primaryCategory?.handle || "other",
        sku: variant?.sku || "",
        barcode: variant?.barcode || "",
        price: Number(variant?.prices?.[0]?.amount || 0),
        currencyCode: "vnd",
        availability: availabilityBand(stock),
        canOrder: stock > 0 && Boolean(variant?.id),
        salesQuantity: Number(salesByVariant.get(variant?.id || "") || 0),
      };
    })
      .filter((item) => item.variantId && item.canOrder)
      .sort((a, b) => Number(b.salesQuantity || 0) - Number(a.salesQuantity || 0) || a.title.localeCompare(b.title))
      .slice(0, requestedLimit)
      .map((item, index) => ({
        ...item,
        salesRank: hasSalesHistory ? index + 1 : undefined,
      })),
  };
}

export async function quoteTelegramSalesCart(headers: HeadersLike, input: TelegramSalesQuoteInput) {
  const ctx = await resolveTelegramSalesServiceContext(headers);
  if (readPaymentFeeInput(input)) throw new PlatformError("validation_error", "Payment fee is not supported by Telegram sales", 400);
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => ({
    data: await quoteTelegramSalesCartForClient(client, ctx, input),
  }));
}

export async function createTelegramSalesDraft(headers: HeadersLike, input: TelegramSalesDraftInput) {
  const ctx = await resolveTelegramSalesServiceContext(headers);
  if (readPaymentFeeInput(input)) throw new PlatformError("validation_error", "Payment fee is not supported by Telegram sales", 400);
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: ctx.merchantId, storeId: ctx.storeId });
    return withScopedIdempotency(client, headers, input, ctx.merchantId, TELEGRAM_SALES_OPS.createDraft, async () => {
    const profile = await upsertTelegramSalesProfileForClient(client, ctx, input.profile);
    const items = normalizeLines(input.items);
    const quote = await quoteTelegramSalesCartForClient(client, ctx, { items, shippingFee: input.shippingFee });
    const delivery = normalizeDelivery(input.delivery);
    const customerMessage = normalizeText(input.customerMessage, 2000, "customerMessage");
    const row = await queryOne<TelegramSalesDraftRow>(client, `
      INSERT INTO app.telegram_sales_drafts (
        merchant_id, store_id, profile_id, telegram_user_id, telegram_chat_id, telegram_username,
        language, status, items, quote, delivery, customer_message, ai_metadata,
        idempotency_key, expires_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, 'needs_review', $8::jsonb, $9::jsonb, $10::jsonb, $11, $12::jsonb,
        $13, now() + ($14::int * INTERVAL '1 hour')
      )
      RETURNING *
    `, [
      ctx.merchantId,
      ctx.storeId,
      profile.id,
      profile.telegramUserId,
      profile.telegramChatId,
      profile.telegramUsername,
      profile.language,
      JSON.stringify(items),
      JSON.stringify(quote),
      JSON.stringify(delivery),
      customerMessage,
      JSON.stringify(asRecord(input.aiMetadata)),
      headerValue(headers, "idempotency-key"),
      draftExpiryHours(),
    ]);
    if (!row) throw new PlatformError("internal_error", "Telegram sales draft could not be created", 500);
    await recordAuditEntry(client, {
      operatorId: ctx.serviceIdentity || "telegram",
      role: "system",
      organizationId: ctx.organizationId,
      channel: "telegram",
      channelUserId: profile.telegramUserId,
      serviceIdentity: ctx.serviceIdentity,
      requestId: ctx.requestId,
    }, "telegram_sales.draft_created", "telegram_sales_draft", row.id, {
      after: {
        status: row.status,
        total: quote.total,
        items: items.length,
      },
      merchantId: ctx.merchantId,
      storeId: ctx.storeId,
    });
    await notifyTelegramSalesDraftCreated(client, ctx, row, quote);
    return { data: formatDraftRow(row) };
    });
  });
}

export async function listTelegramSalesCustomerDrafts(headers: HeadersLike, query: Pick<TelegramSalesDraftQuery, "limit" | "offset"> | undefined = {}) {
  const ctx = await resolveTelegramSalesServiceContext(headers);
  if (!ctx.channelUserId) throw new PlatformError("validation_error", "Telegram user id is required", 400);
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const limit = toInteger(query?.limit, 5, 20);
    const offset = toInteger(query?.offset, 0, 10_000);
    const params: unknown[] = [ctx.merchantId, ctx.storeId, ctx.channelUserId];
    const count = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM app.telegram_sales_drafts
      WHERE merchant_id = $1
        AND store_id = $2
        AND telegram_user_id = $3
    `, params);
    const statusCounts = await client.query<{ status: string; count: string }>(`
      SELECT status, COUNT(*)::text AS count
      FROM app.telegram_sales_drafts
      WHERE merchant_id = $1
        AND store_id = $2
        AND telegram_user_id = $3
      GROUP BY status
    `, params);
    params.push(limit, offset);
    const rows = await client.query<TelegramSalesDraftRow>(`
      SELECT *
      FROM app.telegram_sales_drafts
      WHERE merchant_id = $1
        AND store_id = $2
        AND telegram_user_id = $3
      ORDER BY created_at DESC
      LIMIT $4 OFFSET $5
    `, params);
    return {
      data: rows.rows.map(formatCustomerDraftRow),
      count: Number(count.rows[0]?.count || 0),
      statusCounts: Object.fromEntries(statusCounts.rows.map((row) => [row.status, Number(row.count || 0)])),
      limit,
      offset,
    };
  });
}

export async function listTelegramSalesDrafts(query: TelegramSalesDraftQuery | undefined, scope: ReportScope) {
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const limit = toInteger(query?.limit, 50, 100);
    const offset = toInteger(query?.offset, 0, 10_000);
    const params: unknown[] = [scope.merchantId, scope.storeIds];
    const conditions = ["merchant_id = $1", "store_id = ANY($2::text[])"];
    const status = String(query?.status || "").trim();
    if (status === "pending") {
      conditions.push("status IN ('pending', 'needs_review')");
    } else if (status && status !== "all") {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    } else if (!status) {
      conditions.push("status IN ('pending', 'needs_review', 'converted', 'rejected')");
    }
    const term = String(query?.q || "").trim().toLowerCase();
    if (term) {
      params.push(`%${term}%`);
      conditions.push(`(
        lower(COALESCE(telegram_username, '')) LIKE $${params.length}
        OR lower(telegram_user_id) LIKE $${params.length}
        OR lower(COALESCE(customer_message, '')) LIKE $${params.length}
      )`);
    }
    const count = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM app.telegram_sales_drafts
      WHERE ${conditions.join(" AND ")}
    `, params);
    params.push(limit, offset);
    const rows = await client.query<TelegramSalesDraftRow>(`
      SELECT *
      FROM app.telegram_sales_drafts
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    return {
      data: rows.rows.map(formatDraftRow),
      count: Number(count.rows[0]?.count || 0),
      limit,
      offset,
    };
  });
}

export async function getTelegramSalesDraft(draftId: string, scope: ReportScope) {
  const validDraftId = assertDraftId(draftId);
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const row = await queryOne<TelegramSalesDraftRow>(client, `
      SELECT *
      FROM app.telegram_sales_drafts
      WHERE id = $1
        AND merchant_id = $2
        AND store_id = ANY($3::text[])
      LIMIT 1
    `, [validDraftId, scope.merchantId, scope.storeIds]);
    if (!row) throw new PlatformError("resource_not_found", "Telegram sales draft not found", 404);
    return { data: formatDraftRow(row) };
  });
}

async function loadDraftForOperatingScope(draftId: string, scope: OperatingScope): Promise<TelegramSalesDraftRow> {
  const validDraftId = assertDraftId(draftId);
  return withConnectedClient(async (client) => {
    const row = await queryOne<TelegramSalesDraftRow>(client, `
      SELECT *
      FROM app.telegram_sales_drafts
      WHERE id = $1
        AND merchant_id = $2
        AND store_id = $3
      LIMIT 1
    `, [validDraftId, scope.merchantId, scope.storeId]);
    if (!row) throw new PlatformError("resource_not_found", "Telegram sales draft not found", 404);
    return row;
  });
}

async function withDraftConfirmLock<T>(draftId: string, fn: () => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const key = `telegram_sales_confirm:${draftId}`;
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => undefined);
    }
  });
}

function syntheticTelegramActor(actor: StaffActor, draft: TelegramSalesDraftRow, headers: HeadersLike, scope: OperatingScope): ChannelActor {
  return {
    operatorId: actor.operatorId,
    role: actor.role,
    displayName: actor.displayName,
    organizationId: actor.organizationId,
    merchantId: scope.merchantId,
    defaultStoreId: scope.storeId,
    channel: "telegram",
    channelUserId: draft.telegram_user_id,
    serviceIdentity: "telegram_sales_portal_confirm",
    requestId: headerValue(headers, "x-request-id") || undefined,
    permissions: "permissions" in actor && Array.isArray(actor.permissions) ? actor.permissions as PermissionId[] : [],
    access: actor.access,
  };
}

function notesForConfirmedDraft(draft: TelegramSalesDraftRow, operatorNotes: string | null): string {
  const delivery = asRecord(draft.delivery);
  const parts = [
    `Telegram draft: ${draft.id}`,
    draft.telegram_username ? `Telegram: @${draft.telegram_username} (${draft.telegram_user_id})` : `Telegram user: ${draft.telegram_user_id}`,
    delivery.address ? `Delivery address: ${delivery.address}` : "",
    delivery.note ? `Delivery note: ${delivery.note}` : "",
    draft.customer_message ? `Customer message: ${draft.customer_message}` : "",
    operatorNotes ? `Operator notes: ${operatorNotes}` : "",
  ].filter(Boolean);
  return truncateText(parts.join("\n"), 1000);
}

function notesForCheckoutDraft(draft: TelegramSalesDraftRow, operatorNotes: string | null, paymentNotes: string | null): string {
  const base = notesForConfirmedDraft(draft, operatorNotes);
  return truncateText([
    base,
    paymentNotes ? `Payment notes: ${paymentNotes}` : "",
  ].filter(Boolean).join("\n"), 1000);
}

function telegramSalesDraftIdFromSaleInput(input: SaleInput): string | null {
  const draftId = String(input.telegramSalesDraftId || "").trim();
  return draftId ? assertDraftId(draftId) : null;
}

function telegramDraftQuoteFromOrder(input: SaleInput, order: Record<string, unknown>) {
  const orderItems = asArray(order.items).map((item) => {
    const row = asRecord(item);
    const quantity = Number(row.quantity || 0);
    const unitPrice = Number(row.unitPrice || 0);
    const lineTotal = Number(row.lineTotal || unitPrice * quantity);
    return {
      productId: typeof row.productId === "string" ? row.productId : undefined,
      variantId: typeof row.variantId === "string" ? row.variantId : undefined,
      sku: typeof row.sku === "string" ? row.sku : undefined,
      title: String(row.name || row.title || row.productTitle || row.variantId || "Product"),
      quantity,
      unitPrice,
      lineTotal,
      availability: "available",
      canFulfill: true,
    };
  });
  return {
    currencyCode: "vnd",
    paymentMethod: input.paymentMethod,
    salesChannel: input.salesChannel || "telegram",
    subtotal: Number(order.subtotal || 0),
    shippingFee: Number(order.shippingFee || 0),
    discount: Number(order.discount || 0),
    tax: Number(order.tax || 0),
    total: Number(order.total || 0),
    items: orderItems.length > 0 ? orderItems : normalizeLines(input.items as TelegramSalesLineInput[]).map((item) => ({
      variantId: item.variantId,
      quantity: item.quantity,
    })),
    warnings: [],
  };
}

export async function lockTelegramSalesDraftConfirmationForClient(client: PoolClient, input: SaleInput): Promise<string | null> {
  const draftId = telegramSalesDraftIdFromSaleInput(input);
  if (draftId) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`telegram_sales_confirm:${draftId}`]);
  }
  return draftId;
}

export async function assertTelegramSalesDraftCanSettlePaymentIntent(
  client: PoolClient,
  input: SaleInput,
  scope: { merchantId: string | null; storeId: string | null },
): Promise<void> {
  const draftId = await lockTelegramSalesDraftConfirmationForClient(client, input);
  if (!draftId) return;
  if (!scope.merchantId || !scope.storeId) {
    throw new PlatformError("scope_required", "Telegram sales payment intent requires merchant and store scope", 409);
  }
  const draft = await queryOne<TelegramSalesDraftRow>(client, `
    SELECT *
    FROM app.telegram_sales_drafts
    WHERE id = $1
      AND merchant_id = $2
      AND store_id = $3
    FOR UPDATE
  `, [draftId, scope.merchantId, scope.storeId]);
  if (!draft) throw new PlatformError("resource_not_found", "Telegram sales draft not found", 404);
  if (draft.status !== "pending" && draft.status !== "needs_review") {
    throw new PlatformError("invalid_draft_status", `Telegram sales draft is ${draft.status}`, 409, {
      status: draft.status,
      convertedOrderId: draft.converted_order_id,
    });
  }
}

export async function convertTelegramSalesDraftForPaidOrder(
  client: PoolClient,
  input: SaleInput,
  order: Record<string, unknown>,
  actor: OperatorContext,
  scope: { merchantId: string | null; storeId: string | null },
): Promise<void> {
  const draftId = telegramSalesDraftIdFromSaleInput(input);
  if (!draftId) return;
  if (!scope.merchantId || !scope.storeId) {
    throw new PlatformError("scope_required", "Telegram sales checkout requires merchant and store scope", 409);
  }
  const orderId = String(order.id || order.orderId || "");
  if (!orderId) throw new PlatformError("internal_error", "Telegram sales checkout created no order id", 500);
  await assertTelegramSalesDraftCanSettlePaymentIntent(client, input, scope);
  const items = normalizeLines(input.items as TelegramSalesLineInput[]);
  const quote = telegramDraftQuoteFromOrder(input, order);
  const operatorNotes = normalizeText(input.telegramSalesOperatorNotes, 1000, "telegramSalesOperatorNotes");
  const row = await queryOne<TelegramSalesDraftRow>(client, `
    UPDATE app.telegram_sales_drafts
    SET status = 'converted',
        items = $4::jsonb,
        quote = $5::jsonb,
        operator_notes = $6,
        converted_order_id = $7,
        reviewed_by = $8,
        reviewed_at = now(),
        updated_at = now()
    WHERE id = $1
      AND merchant_id = $2
      AND store_id = $3
      AND status IN ('pending', 'needs_review')
    RETURNING *
  `, [
    draftId,
    scope.merchantId,
    scope.storeId,
    JSON.stringify(items),
    JSON.stringify(quote),
    operatorNotes,
    orderId,
    actor.operatorId,
  ]);
  if (!row) throw new PlatformError("invalid_draft_status", "Telegram sales draft was already handled", 409);
  await recordAuditEntry(client, actor, "telegram_sales.draft_checked_out", "telegram_sales_draft", row.id, {
    after: {
      status: row.status,
      orderId,
      total: quote.total,
      paymentMethod: input.paymentMethod,
      salesChannel: input.salesChannel || "telegram",
      source: "payment_intent_settlement",
    },
    merchantId: scope.merchantId,
    storeId: scope.storeId,
  });
}

export async function confirmTelegramSalesDraft(
  headers: HeadersLike,
  draftId: string,
  input: TelegramSalesConfirmInput,
  actor: StaffActor,
  scope: OperatingScope,
) {
  if (readPaymentFeeInput(input)) throw new PlatformError("validation_error", "Payment fee is not supported by Telegram sales", 400);
  return withDraftConfirmLock(draftId, async () => {
    const draft = await loadDraftForOperatingScope(draftId, scope);
    if (draft.status === "converted" && draft.converted_order_id) {
      return {
        statusCode: 200,
        response: {
          data: {
            draft: formatDraftRow(draft),
            alreadyConverted: true,
          },
        },
      };
    }
    if (draft.status !== "pending" && draft.status !== "needs_review") {
      throw new PlatformError("invalid_draft_status", `Telegram sales draft is ${draft.status}`, 409, {
        status: draft.status,
      });
    }

    const items = normalizeLines(asArray(draft.items) as TelegramSalesLineInput[]);
    const quote = await withConnectedClient((client) => quoteTelegramSalesCartForClient(client, {
      merchantId: scope.merchantId,
      storeId: scope.storeId,
      stockLocationId: scope.stockLocationId,
    }, {
      items,
      shippingFee: input.shippingFee ?? Number(asRecord(draft.quote).shippingFee || 0),
    }));
    if (quote.warnings.length > 0) {
      throw new PlatformError("insufficient_stock", "Telegram sales draft cannot be confirmed because stock is no longer available", 409, {
        warnings: quote.warnings,
      });
    }

    const operatorNotes = normalizeText(input.operatorNotes, 1000, "operatorNotes");
    const orderInput: RemoteOrderInput = {
      items,
      paymentMethod: "cod",
      amountReceived: 0,
      shippingFee: quote.shippingFee,
      salesChannel: "telegram",
      status: "confirmed",
      notes: notesForConfirmedDraft(draft, operatorNotes),
    };
    const syntheticActor = syntheticTelegramActor(actor, draft, headers, scope);
    const orderHeaders = {
      ...headers,
      "idempotency-key": `telegram-sales-confirm:${draft.id}`,
    };
    const created = await createRemoteOrder(orderHeaders, orderInput, syntheticActor, scope);
    const order = asRecord(created.response).data as Record<string, unknown> | undefined;
    const orderId = String(order?.id || order?.orderId || "");
    if (!orderId) throw new PlatformError("internal_error", "Telegram sales order was created without an order id", 500);

    const updated = await withConnectedTransaction(async (client) => {
      const row = await queryOne<TelegramSalesDraftRow>(client, `
        UPDATE app.telegram_sales_drafts
        SET status = 'converted',
            quote = $4::jsonb,
            operator_notes = $5,
            converted_order_id = $6,
            reviewed_by = $7,
            reviewed_at = now(),
            updated_at = now()
        WHERE id = $1
          AND merchant_id = $2
          AND store_id = $3
          AND status IN ('pending', 'needs_review')
        RETURNING *
      `, [
        draft.id,
        scope.merchantId,
        scope.storeId,
        JSON.stringify(quote),
        operatorNotes,
        orderId,
        actor.operatorId,
      ]);
      if (!row) throw new PlatformError("invalid_draft_status", "Telegram sales draft was already handled", 409);
      await recordAuditEntry(client, actor, "telegram_sales.draft_converted", "telegram_sales_draft", row.id, {
        after: {
          status: row.status,
          orderId,
          total: quote.total,
        },
        merchantId: scope.merchantId,
        storeId: scope.storeId,
      });
      return row;
    });

    return {
      statusCode: created.statusCode,
      response: {
        data: {
          draft: formatDraftRow(updated),
          order,
        },
      },
    };
  });
}

export async function checkoutTelegramSalesDraft(
  headers: HeadersLike,
  draftId: string,
  input: TelegramSalesCheckoutInput,
  actor: OperatorContext,
  scope: OperatingScope,
) {
  if (readPaymentFeeInput(input)) throw new PlatformError("validation_error", "Payment fee is not supported by Telegram sales", 400);
  return withDraftConfirmLock(draftId, async () => {
    const draft = await loadDraftForOperatingScope(draftId, scope);
    if (draft.status === "converted" && draft.converted_order_id) {
      return {
        statusCode: 200,
        response: {
          data: {
            draft: formatDraftRow(draft),
            alreadyConverted: true,
          },
        },
      };
    }
    if (draft.status !== "pending" && draft.status !== "needs_review") {
      throw new PlatformError("invalid_draft_status", `Telegram sales draft is ${draft.status}`, 409, {
        status: draft.status,
      });
    }

    const items = normalizeLines(asArray(input.items) as TelegramSalesLineInput[]);
    const operatorNotes = normalizeText(input.operatorNotes, 1000, "operatorNotes");
    const paymentNotes = normalizeText(input.notes, 1000, "notes");
    const saleBody: SaleInput = {
      items,
      customerId: input.customerId,
      paymentMethod: input.paymentMethod || "cod",
      amountReceived: Number(input.amountReceived || 0),
      discountPercent: input.discountPercent,
      discountType: input.discountType,
      discountValue: input.discountValue,
      shippingFee: input.shippingFee,
      notes: notesForCheckoutDraft(draft, operatorNotes, paymentNotes),
      salesChannel: input.salesChannel || "telegram",
      sourceFlow: input.sourceFlow || "telegram_sales",
      salesChannelLocked: true,
      customerNickname: draft.telegram_username ? `@${draft.telegram_username}` : draft.telegram_user_id,
      customerContactType: "telegram",
      telegramSalesDraftId: draft.id,
      telegramSalesOperatorNotes: operatorNotes,
      foundStockConfirmation: input.foundStockConfirmation,
      customerMode: input.customerMode,
      bankTransferSettlementAcknowledgment: input.bankTransferSettlementAcknowledgment,
    };
    const quote = await withConnectedClient((client) => quoteSaleForClient(
      client,
      saleBody,
      scope.stockLocationId,
      scope.merchantId,
      scope.storeId,
    ));
    const checkoutHeaders = {
      ...headers,
      "idempotency-key": headerValue(headers, "idempotency-key") || `telegram-sales-checkout:${draft.id}`,
    };
    const created = await completeSale(checkoutHeaders, saleBody, actor, scope);
    const order = asRecord(created.response).data as Record<string, unknown> | undefined;
    const orderId = String(order?.id || order?.orderId || "");
    if (!orderId) throw new PlatformError("internal_error", "Telegram sales checkout created no order id", 500);

    const updated = await withConnectedTransaction(async (client) => {
      const row = await queryOne<TelegramSalesDraftRow>(client, `
        UPDATE app.telegram_sales_drafts
        SET status = 'converted',
            items = $4::jsonb,
            quote = $5::jsonb,
            operator_notes = $6,
            converted_order_id = $7,
            reviewed_by = $8,
            reviewed_at = now(),
            updated_at = now()
        WHERE id = $1
          AND merchant_id = $2
          AND store_id = $3
          AND status IN ('pending', 'needs_review')
        RETURNING *
      `, [
        draft.id,
        scope.merchantId,
        scope.storeId,
        JSON.stringify(items),
        JSON.stringify({
          currencyCode: "vnd",
          paymentMethod: saleBody.paymentMethod,
          salesChannel: saleBody.salesChannel,
          subtotal: quote.totals.subtotal,
          shippingFee: quote.totals.shippingFee,
          discount: quote.totals.discount,
          tax: quote.totals.tax,
          total: quote.totals.total,
          items: quote.items,
          warnings: [],
        }),
        operatorNotes,
        orderId,
        actor.operatorId,
      ]);
      if (!row) throw new PlatformError("invalid_draft_status", "Telegram sales draft was already handled", 409);
      await recordAuditEntry(client, actor, "telegram_sales.draft_checked_out", "telegram_sales_draft", row.id, {
        after: {
          status: row.status,
          orderId,
          total: quote.totals.total,
          paymentMethod: saleBody.paymentMethod,
          salesChannel: saleBody.salesChannel,
        },
        merchantId: scope.merchantId,
        storeId: scope.storeId,
      });
      return row;
    });

    return {
      statusCode: created.statusCode,
      response: {
        data: {
          draft: formatDraftRow(updated),
          order,
        },
      },
    };
  });
}

export async function rejectTelegramSalesDraft(
  draftId: string,
  input: TelegramSalesRejectInput,
  actor: StaffActor,
  scope: OperatingScope,
) {
  const validDraftId = assertDraftId(draftId);
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
    const reason = normalizeText(input.reason, 1000, "reason");
    const row = await queryOne<TelegramSalesDraftRow>(client, `
      UPDATE app.telegram_sales_drafts
      SET status = 'rejected',
          operator_notes = $4,
          reviewed_by = $5,
          reviewed_at = now(),
          updated_at = now()
      WHERE id = $1
        AND merchant_id = $2
        AND store_id = $3
        AND status IN ('pending', 'needs_review')
      RETURNING *
    `, [validDraftId, scope.merchantId, scope.storeId, reason, actor.operatorId]);
    if (!row) throw new PlatformError("invalid_draft_status", "Telegram sales draft cannot be rejected", 409);
    await recordAuditEntry(client, actor, "telegram_sales.draft_rejected", "telegram_sales_draft", row.id, {
      after: { status: row.status },
      reason: reason || undefined,
      merchantId: scope.merchantId,
      storeId: scope.storeId,
    });
    return { data: formatDraftRow(row) };
  });
}
