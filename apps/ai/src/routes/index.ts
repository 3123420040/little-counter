import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ReplyDraftRequestSchema } from "@medusa-snus/contracts";
import * as applicationNamespace from "@medusa-snus/application";
import type { ChannelActor, HeadersLike, OperatorContext } from "@medusa-snus/application";
import { getDb } from "../db/client.js";
import { createAiProvider } from "../services/ai-provider.js";
import { sendAiError } from "../error-response.js";
import {
  rankCatalogByOcrText,
  runGoogleProductSearch,
  runGoogleVisionObjectLocalization,
  runGoogleVisionOcr,
  type ProductSearchCandidate,
  type ProductSearchDetection,
  type ProductSearchResult,
} from "../services/google-product-search-provider.js";

export {
  normalizeGoogleObjectLocalizationResponse,
  normalizeGoogleProductSearchDetections,
  normalizeGoogleProductSearchResponse,
  rankCatalogByOcrText,
} from "../services/google-product-search-provider.js";

const applicationModule = ((applicationNamespace as unknown as { default?: typeof import("@medusa-snus/application") }).default ?? applicationNamespace) as typeof import("@medusa-snus/application");
const {
  acknowledgeAiAlert,
  approveAiAction,
  getAiRecommendations,
  listAiAlerts,
  listAiReviewQueue,
  listCustomers,
  listProducts,
  listVisionReferenceImagesForProvider,
  persistReplyDraft,
  PlatformError,
  requireActorPermission,
  requireFeature,
  requireMutationScope,
  requireReadableReportScope,
  rejectAiAction,
} = applicationModule as typeof import("@medusa-snus/application");
const {
  commitUsage,
  releaseUsage,
  reserveUsage,
} = applicationModule as typeof import("@medusa-snus/application");

const SWAGGER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>medusa-snus AI API Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <style>body{margin:0;background:#fafafa}.topbar{display:none}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.onload = function() {
      SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger-ui", deepLinking: true });
    };
  </script>
</body>
</html>`;

function replyError(reply: FastifyReply, err: unknown) {
  return sendAiError(reply, err);
}

type AiRequestActor = OperatorContext | ChannelActor;

function operatorFromRequest(req: FastifyRequest): AiRequestActor {
  const payload = (req as FastifyRequest & { operator?: AiRequestActor }).operator;
  if (!payload) {
    throw new PlatformError("unauthorized", "Missing authenticated operator context", 401);
  }
  return payload;
}

function requestHeaders(req: FastifyRequest): HeadersLike {
  return req.headers as HeadersLike;
}

interface AiChannelServiceContext {
  channel: "telegram";
  serviceIdentity: string;
  merchantId?: string;
  telegramBotConfigId?: string;
  requestId?: string;
}

function channelServiceFromRequest(req: FastifyRequest): AiChannelServiceContext {
  const service = (req as FastifyRequest & { channelService?: AiChannelServiceContext }).channelService;
  if (!service) throw new PlatformError("unauthorized", "Missing channel service context", 401);
  return service;
}

function requestHeaderValue(req: FastifyRequest, name: string): string {
  const headers = requestHeaders(req);
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (Array.isArray(value)) return String(value[0] || "").trim();
    return String(value || "").trim();
  }
  return "";
}

async function resolveTelegramSalesAiScope(req: FastifyRequest): Promise<{ merchantId: string; storeId: string; stockLocationId: string }> {
  const service = channelServiceFromRequest(req);
  const requestedStoreId = requestHeaderValue(req, "x-store-id") || null;
  const db = getDb();
  let merchantId: string;
  let storeId = requestedStoreId;

  if (service.merchantId) {
    const merchant = await db.query<{ id: string }>(`
      SELECT id
      FROM app.merchants
      WHERE id = $1 AND status = 'active'
      LIMIT 1
    `, [service.merchantId]);
    if (!merchant.rows[0]) throw new PlatformError("merchant_not_found", "Merchant not found for Telegram sales AI", 403);
    merchantId = service.merchantId;
  } else if (service.telegramBotConfigId) {
    const config = await db.query<{ merchant_id: string; default_store_id: string | null }>(`
      SELECT tbc.merchant_id, tbc.default_store_id
      FROM app.telegram_bot_configs tbc
      JOIN app.merchants m ON m.id = tbc.merchant_id AND m.status = 'active'
      WHERE tbc.id = $1 AND tbc.status = 'active'
      LIMIT 1
    `, [service.telegramBotConfigId]);
    const row = config.rows[0];
    if (!row) throw new PlatformError("telegram_bot_config_not_found", "Telegram bot config not found", 403);
    merchantId = row.merchant_id;
    storeId = requestedStoreId || row.default_store_id;
  } else {
    throw new PlatformError("scope_required", "Telegram sales AI requires merchant scope", 409);
  }
  const stores = await db.query<{ id: string; stock_location_id: string }>(`
    SELECT id, stock_location_id FROM app.stores
    WHERE merchant_id=$1 AND status='active'
      AND (id=$2::text OR ($2::text IS NULL AND is_primary))
    LIMIT 2
  `, [merchantId, storeId]);
  if (stores.rows.length !== 1 || !stores.rows[0]!.stock_location_id) {
    throw new PlatformError(storeId ? "forbidden" : "scope_required", "An active merchant store is required for Telegram sales AI", storeId ? 403 : 409);
  }
  return { merchantId, storeId: stores.rows[0]!.id, stockLocationId: stores.rows[0]!.stock_location_id };
}

async function getResearchProduct(productId: string, merchantId: string) {
  const db = getDb();
  const result = await db.query<{
    id: string;
    title: string;
  }>(`
    SELECT p.id, p.title
    FROM public.product p
    WHERE p.id = $1
      AND p.deleted_at IS NULL
      AND p.merchant_id = $2
    LIMIT 1
  `, [productId, merchantId]);
  if (!result.rows[0]) {
    throw new PlatformError("resource_not_found", "Product not found in the active merchant scope", 404);
  }
  return result.rows[0];
}

function sendIdempotent<T>(reply: FastifyReply, result: { response: T; statusCode: number }) {
  return reply.status(result.statusCode).send(result.response);
}

export function buildVisionOcrProductSearchResponse(input: {
  modelVersion: string;
  candidates: ProductSearchCandidate[];
  detections?: ProductSearchDetection[];
  location?: string;
}): ProductSearchResult {
  const candidates = input.candidates;
  const detections = input.detections && input.detections.length > 0
    ? input.detections
    : candidates.length > 0
      ? [{
          objectId: "obj_1",
          bbox: { source: "full_image" },
          candidates,
          warnings: ["ocr_full_image_fallback"],
        }]
      : [];
  return {
    provider: "google_vision_ocr",
    modelVersion: input.modelVersion,
    location: input.location?.trim() || "global",
    productSet: "",
    candidates,
    detections,
  };
}

export function shouldIncludePendingVisionOcrReferenceImages(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.VISION_OCR_INCLUDE_PENDING_REFERENCE_IMAGES || "").trim() === "true";
}

export function registerAiRoutes(server: FastifyInstance) {
  const aiProvider = createAiProvider();

  server.get("/docs", async (_req, reply) => {
    return reply.header("Content-Type", "text/html; charset=utf-8").send(SWAGGER_HTML);
  });

  server.get("/openapi.json", async () => ({
    openapi: "3.0.3",
    info: {
      title: "medusa-snus AI API",
      version: "1.0.0",
      description: "AI reply drafts, review queue, inventory alerts, and loyalty recommendations.",
    },
    paths: {
      "/ai/reply-draft": { post: { summary: "Create reply draft" } },
      "/ai/review-queue": { get: { summary: "List pending AI actions" } },
      "/ai/actions/{id}/approve": { post: { summary: "Approve AI action" } },
      "/ai/actions/{id}/reject": { post: { summary: "Reject AI action" } },
      "/ai/alerts": { get: { summary: "List inventory alerts" } },
      "/ai/alerts/{id}/acknowledge": { post: { summary: "Acknowledge inventory alert" } },
      "/ai/recommendations/{customerId}": { get: { summary: "Get loyalty recommendations" } },
      "/ai/product-research": { post: { summary: "Run product research" } },
      "/ai/product-research/{productId}/latest": { get: { summary: "Get latest product research" } },
      "/ai/product-research/runs/{runId}/review": { patch: { summary: "Update product research operator review" } },
      "/ai/order-draft": { post: { summary: "Draft a Telegram remote order from natural language" } },
      "/ai/vision/product-search": { post: { summary: "Run Google Product Search for POS vision input" } },
      "/ai/telegram-sales/order-draft": { post: { summary: "Draft a customer Telegram sales request from natural language" } },
    },
  }));

  server.post("/ai/reply-draft", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = ReplyDraftRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: "validation_error", message: parsed.error.message } });
      }

      const actor = operatorFromRequest(req);
      await requireActorPermission(actor, "ai:review");
      const operatingScope = await requireMutationScope(actor, requestHeaders(req));
      const merchantId = operatingScope.merchantId;
      const catalog = await listProducts({ merchantId, stockLocationId: operatingScope.stockLocationId });
      const requested = parsed.data.productContext || [];
      const products = catalog
        .filter((product) => requested.length === 0 || requested.includes(product.id) || product.variants.some((variant) => requested.includes(variant.id)))
        .map((product) => ({
          id: product.id,
          name: product.title,
          price: product.variants[0]?.prices[0]?.amount || 0,
          stockLevel: product.variants[0]?.inventory_quantity || 0,
        }));

      const plan = await aiProvider.draftReply({
        customerMessage: parsed.data.customerMessage,
        products,
        operatorInstruction: parsed.data.operatorInstruction,
      });

      const result = await persistReplyDraft(requestHeaders(req), {
        customerMessage: parsed.data.customerMessage,
        productContext: parsed.data.productContext,
        operatorInstruction: parsed.data.operatorInstruction,
        plan,
        merchantId,
      });

      return sendIdempotent(reply, result);
    } catch (err) {
      return replyError(reply, err);
    }
  });

  server.get("/ai/review-queue", async (_req, reply) => {
    try {
      const actor = operatorFromRequest(_req);
      await requireActorPermission(actor, "ai:review");
      const scope = await requireReadableReportScope(actor, requestHeaders(_req));
      return reply.send(await listAiReviewQueue(scope.merchantId));
    } catch (err) {
      return replyError(reply, err);
    }
  });

  server.post("/ai/vision/product-search", async (req, reply) => {
    try {
      const actor = operatorFromRequest(req);
      await requireActorPermission(actor, "vision_scan:use");
      const scope = await requireMutationScope(actor, requestHeaders(req));
      const input = (req.body || {}) as { imageBase64?: string };
      if ((process.env.VISION_PROVIDER || "").trim() === "google_vision_ocr") {
        const [ocr, objectsResult] = await Promise.all([
          runGoogleVisionOcr({ imageBase64: input.imageBase64 }),
          runGoogleVisionObjectLocalization({ imageBase64: input.imageBase64 }).catch((error) => ({
            detections: [],
            modelVersion: "",
            warning: error instanceof Error ? error.message : "object_localization_failed",
          })),
        ]);
        const referenceImages = await listVisionReferenceImagesForProvider({
          merchantId: scope.merchantId,
          storeId: scope.storeId,
          provider: "google_vision_ocr",
          includePending: shouldIncludePendingVisionOcrReferenceImages(),
          limit: Number(process.env.VISION_OCR_CATALOG_LIMIT || "500"),
        });
        const catalogByProduct = new Map<string, {
          id: string;
          title: string;
          variants: Array<{ id: string; sku?: string; barcode?: string }>;
        }>();
        const seenVariants = new Set<string>();
        for (const image of referenceImages) {
          const product = catalogByProduct.get(image.productId) || {
            id: image.productId,
            title: image.title,
            variants: [],
          };
          if (!seenVariants.has(image.variantId)) {
            product.variants.push({ id: image.variantId, sku: image.sku, barcode: image.barcode });
            seenVariants.add(image.variantId);
          }
          catalogByProduct.set(image.productId, product);
        }
        const catalog = Array.from(catalogByProduct.values());
        const candidates = rankCatalogByOcrText(ocr.text, catalog);
        const objectLocalizationWarning = "warning" in objectsResult && Boolean(objectsResult.warning);
        const objectDetections = objectsResult.detections.map((detection): ProductSearchDetection => ({
          ...detection,
          candidates,
          warnings: [
            ...(detection.warnings || []),
            "ocr_candidates_from_full_image",
            ...(objectLocalizationWarning ? ["object_localization_warning"] : []),
          ],
        }));
        return reply.send({
          data: buildVisionOcrProductSearchResponse({
            modelVersion: [ocr.modelVersion, objectsResult.modelVersion].filter(Boolean).join("+") || ocr.modelVersion,
            location: process.env.GOOGLE_PRODUCT_SEARCH_LOCATION || "global",
            candidates,
            detections: objectDetections,
          }),
        });
      }
      const result = await runGoogleProductSearch({ imageBase64: input.imageBase64 });
      return reply.send({ data: result });
    } catch (err) {
      return replyError(reply, err);
    }
  });

  server.post("/ai/actions/:id/approve", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { approvedText } = (req.body || {}) as { approvedText?: string };
      const actor = operatorFromRequest(req);
      await requireActorPermission(actor, "ai:review");
      const scope = await requireMutationScope(actor, requestHeaders(req));
      return sendIdempotent(reply, await approveAiAction(requestHeaders(req), id, approvedText, actor, scope.merchantId));
    } catch (err) {
      return replyError(reply, err);
    }
  });

  server.post("/ai/actions/:id/reject", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { reason } = (req.body || {}) as { reason?: string };
      const actor = operatorFromRequest(req);
      await requireActorPermission(actor, "ai:review");
      const scope = await requireMutationScope(actor, requestHeaders(req));
      return sendIdempotent(reply, await rejectAiAction(requestHeaders(req), id, reason, actor, scope.merchantId));
    } catch (err) {
      return replyError(reply, err);
    }
  });

  server.get("/ai/alerts", async (_req, reply) => {
    try {
      const actor = operatorFromRequest(_req);
      await requireActorPermission(actor, "inventory:read");
      const scope = await requireReadableReportScope(actor, requestHeaders(_req));
      return reply.send(await listAiAlerts(scope.merchantId, scope.storeIds));
    } catch (err) {
      return replyError(reply, err);
    }
  });

  server.post("/ai/alerts/:id/acknowledge", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const actor = operatorFromRequest(req);
      await requireActorPermission(actor, "inventory:write");
      const scope = await requireMutationScope(actor, requestHeaders(req));
      return sendIdempotent(reply, await acknowledgeAiAlert(requestHeaders(req), id, actor, scope.merchantId, scope.storeId));
    } catch (err) {
      return replyError(reply, err);
    }
  });

  server.get("/ai/recommendations/:customerId", async (req, reply) => {
    try {
      const { customerId } = req.params as { customerId: string };
      const actor = operatorFromRequest(req);
      await requireActorPermission(actor, "loyalty:read");
      const scope = await requireReadableReportScope(actor, requestHeaders(req));
      return reply.send(await getAiRecommendations(customerId, scope.merchantId));
    } catch (err) {
      return replyError(reply, err);
    }
  });

  server.post("/ai/order-draft", async (req, reply) => {
    try {
      const actor = operatorFromRequest(req);
      requireFeature("telegram_ai_ordering");
      await requireActorPermission(actor, "telegram_ai_order:create");
      const { text } = (req.body || {}) as { text?: string };
      if (!text?.trim()) {
        return reply.status(400).send({ error: { code: "validation_error", message: "text is required" } });
      }
      const operatingScope = await requireMutationScope(actor, requestHeaders(req));
      const merchantId = operatingScope.merchantId;
      const quotaReservationToken = `telegram-ai-draft:${merchantId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
      const sendAcceptedDraft = async (data: Record<string, unknown>) => {
        await reserveUsage({
          merchantId,
          metricKey: "telegram_ai_drafts",
          quantity: 1,
          reservationToken: quotaReservationToken,
          referenceType: "telegram_ai_order_draft",
          referenceId: quotaReservationToken,
        });
        try {
          await commitUsage(quotaReservationToken);
          return reply.send({ data: { ...data, usageReservationToken: quotaReservationToken } });
        } catch (error) {
          await releaseUsage(quotaReservationToken).catch(() => undefined);
          throw error;
        }
      };

      const customerResolution = await resolveOrderDraftCustomer(text, merchantId);
      if (customerResolution.clarification) {
        return reply.status(409).send({
          error: {
            code: "order_draft_needs_clarification",
            message: customerResolution.clarification.message,
            details: { queryText: customerResolution.clarification.queryText, clarification: customerResolution.clarification },
          },
        });
      }

      const orderText = orderTextWithoutCustomerSelector(text);
      const catalog = await listProducts({ merchantId, stockLocationId: operatingScope.stockLocationId, limit: 25 });
      const modelDraft = await runModelOrderDraft(orderText, catalog).catch((err) => {
        server.log.warn({ err }, "AI order draft model failed; falling back to deterministic parser");
        return null;
      });
      if (modelDraft) {
        return sendAcceptedDraft({
            items: [{
              variantId: modelDraft.variantId,
              quantity: modelDraft.quantity,
              productName: modelDraft.productName,
              sku: modelDraft.sku,
            }],
            paymentMethod: modelDraft.paymentMethod,
            customerId: customerResolution.customerId,
            note: `AI Telegram draft: ${text}`,
            confidence: modelDraft.confidence >= 0.85 ? "high" : "medium",
            parser: modelDraft.parser,
            queryText: modelDraft.queryText,
            clarification: null,
        });
      }

      const quantity = parseOrderDraftQuantity(orderText);
      const queryText = searchQueryForOrderDraft(orderText) || orderText;
      const products = await listProducts({ merchantId, stockLocationId: operatingScope.stockLocationId, q: queryText, limit: 5 });
      const clarification = orderDraftClarification(queryText, products);
      const match = firstSellableVariant(products);
      if (!match) {
        return reply.status(409).send({
          error: {
            code: "order_draft_needs_clarification",
            message: "No in-stock product matched the order text",
            details: { queryText, clarification },
          },
        });
      }
      const exactSkuMentioned = Boolean(match.sku && text.toLowerCase().includes(match.sku.toLowerCase()));
      if (clarification.options.length > 1 && !exactSkuMentioned) {
        return reply.status(409).send({
          error: {
            code: "order_draft_needs_clarification",
            message: "Multiple product candidates matched the order text",
            details: { queryText, clarification },
          },
        });
      }

      return sendAcceptedDraft({
          items: [{ variantId: match.variantId, quantity, productName: match.productName, sku: match.sku }],
          paymentMethod: parseOrderDraftPaymentMethod(text),
          customerId: customerResolution.customerId,
          note: `AI Telegram draft: ${text}`,
          confidence: match.stock > 0 ? "medium" : "low",
          parser: process.env.AI_ORDER_PROVIDER || "deterministic",
          queryText,
          clarification: null,
      });
    } catch (err) {
      return replyError(reply, err);
    }
  });

  server.post("/ai/order-confirm-check", async (req, reply) => {
    try {
      const actor = operatorFromRequest(req);
      requireFeature("telegram_ai_ordering");
      await requireActorPermission(actor, "telegram_ai_order:create");
      const input = (req.body || {}) as {
        items?: Array<{ variantId?: string; quantity?: number }>;
        usageReservationToken?: string;
        storeId?: string | null;
      };
      if (!Array.isArray(input.items) || input.items.length === 0) {
        return reply.status(400).send({ error: { code: "validation_error", message: "items are required" } });
      }
      for (const item of input.items) {
        if (!item.variantId || !Number.isInteger(item.quantity) || Number(item.quantity) <= 0) {
          return reply.status(400).send({ error: { code: "validation_error", message: "items must include variantId and positive quantity" } });
        }
      }
      if (actor.access?.memberships?.some((membership) => membership.storeId) && input.storeId) {
        const hasStore = actor.access.memberships.some((membership) => membership.storeId === input.storeId || membership.scopeType === "merchant");
        if (!hasStore) {
          return reply.status(403).send({ error: { code: "forbidden", message: "Store is not accessible" } });
        }
      }
      return reply.send({ data: { accepted: true, usageReservationToken: input.usageReservationToken || null } });
    } catch (err) {
      return replyError(reply, err);
    }
  });

  server.post("/ai/telegram-sales/order-draft", async (req, reply) => {
    try {
      requireFeature("telegram_sales_channel");
      requireFeature("telegram_ai_ordering");
      const { text } = (req.body || {}) as { text?: string };
      if (!text?.trim()) {
        return reply.status(400).send({ error: { code: "validation_error", message: "text is required" } });
      }
      const { merchantId, stockLocationId } = await resolveTelegramSalesAiScope(req);
      const data = await buildTelegramSalesOrderDraft(text, merchantId, stockLocationId, server);
      const quotaReservationToken = `telegram-sales-ai-draft:${merchantId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
      await reserveUsage({
        merchantId,
        metricKey: "telegram_ai_drafts",
        quantity: 1,
        reservationToken: quotaReservationToken,
        referenceType: "telegram_sales_ai_order_draft",
        referenceId: quotaReservationToken,
      });
      try {
        await commitUsage(quotaReservationToken);
        return reply.send({ data: { ...data, usageReservationToken: quotaReservationToken } });
      } catch (error) {
        await releaseUsage(quotaReservationToken).catch(() => undefined);
        throw error;
      }
    } catch (err) {
      return replyError(reply, err);
    }
  });

  server.post("/ai/product-research", async (req, reply) => {
    try {
      const actor = operatorFromRequest(req);
      requireFeature("product_research");
      await requireActorPermission(actor, "product_research:run");
      const { productId, query } = (req.body || {}) as { productId?: string; query?: string };
      if (!productId) {
        return reply.status(400).send({ error: { code: "validation_error", message: "productId is required" } });
      }

      const operatingScope = await requireMutationScope(actor, requestHeaders(req));
      const merchantId = operatingScope.merchantId;
      const product = await getResearchProduct(productId, merchantId);
      const rawQuery = query || `${product.title} snus nicotine pouch review ingredients origin`;
      const provider = process.env.PRODUCT_RESEARCH_PROVIDER || "deterministic";
      const preferredLanguage = process.env.PRODUCT_RESEARCH_PREFERRED_LANGUAGE || "vi";
      const usesExternalSearch = provider === "tavily";
      const quotaReservationToken = usesExternalSearch
        ? `product-research:${merchantId}:${product.id}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
        : null;
      let providerSucceeded = false;
      if (quotaReservationToken) {
        await reserveUsage({
          merchantId,
          metricKey: "product_research_runs",
          quantity: 1,
          reservationToken: quotaReservationToken,
          referenceType: "product_research",
          referenceId: product.id,
        });
      }

      let research: ProductResearchProviderResult;
      try {
        research = await runProductResearchProvider(product.title, rawQuery, preferredLanguage);
        providerSucceeded = true;
      } catch (err) {
        if (quotaReservationToken) await releaseUsage(quotaReservationToken).catch(() => undefined);
        throw err;
      }

      const sources = research.sources.map((source, index) => ({ ...source, rank: index + 1 }));
      const bestSource = bestResearchSource(sources);
      const riskFlags = [
        "review_only",
        "do_not_auto_publish_claims",
        "verify_nicotine_and_health_claims",
        "web_source_claims_unverified",
      ];
      const contradictions: string[] = [];
      const summary = research.summary || [
        `${product.title}: research draft generated from public-source search intent.`,
        "Use this as an operator review workspace, not as catalog copy.",
        `Preferred language: ${preferredLanguage}.`,
      ].join(" ");
      const confidence = research.confidence || (sources.length >= 3 && research.summary ? "high" : sources.length ? "medium" : "low");

      const db = getDb();
      try {
        const inserted = await db.query(`
          INSERT INTO ai_module.product_research_runs (
            organization_id, merchant_id, product_id, product_title, provider, status, summary,
            confidence, risk_flags, raw_query, preferred_language, quota_reservation_token,
            contradictions, operator_review_status, operator_notes, created_by
          )
          VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, 'pending', '', $13)
          RETURNING id::text, organization_id, merchant_id, product_id, product_title, provider, status, summary,
            confidence, risk_flags, raw_query, preferred_language, quota_reservation_token,
            contradictions, operator_review_status, operator_notes, operator_task_draft, created_at
        `, [
          actor.organizationId,
          merchantId,
          product.id,
          product.title,
          provider,
          summary,
          confidence,
          JSON.stringify(riskFlags),
          research.query,
          preferredLanguage,
          quotaReservationToken,
          JSON.stringify(contradictions),
          actor.operatorId,
        ]);
        const run = inserted.rows[0];
        for (const source of sources) {
          await db.query(`
            INSERT INTO ai_module.product_research_sources (run_id, title, url, snippet, content, language, rank)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [run.id, source.title, source.url, source.snippet, source.content || "", source.language, source.rank]);
        }
        if (quotaReservationToken) await commitUsage(quotaReservationToken);

        return reply.status(201).send({
          data: {
            runId: run.id,
            merchantId: run.merchant_id,
            productId: run.product_id,
            productTitle: run.product_title,
            provider: run.provider,
            status: run.status,
            summary: run.summary,
            confidence: run.confidence,
            riskFlags: run.risk_flags,
            contradictions: run.contradictions,
            rawQuery: run.raw_query,
            preferredLanguage: run.preferred_language,
            quotaReservationToken: run.quota_reservation_token,
            operatorReviewStatus: run.operator_review_status,
            operatorNotes: run.operator_notes,
            operatorTaskDraft: run.operator_task_draft,
            createdAt: new Date(run.created_at).toISOString(),
            bestSource,
            sources,
          },
        });
      } catch (err) {
        if (quotaReservationToken) {
          if (providerSucceeded) await commitUsage(quotaReservationToken).catch(() => undefined);
          else await releaseUsage(quotaReservationToken).catch(() => undefined);
        }
        throw err;
      }
    } catch (err) {
      return replyError(reply, err);
    }
  });

  server.get("/ai/product-research/:productId/latest", async (req, reply) => {
    try {
      const actor = operatorFromRequest(req);
      requireFeature("product_research");
      await requireActorPermission(actor, "product_research:read");
      const { productId } = req.params as { productId: string };
      const reportScope = await requireReadableReportScope(actor, requestHeaders(req));
      const merchantId = reportScope.merchantId;
      const db = getDb();
      const run = await db.query(`
        SELECT id::text, organization_id, merchant_id, product_id, product_title, provider, status, summary,
          confidence, risk_flags, raw_query, preferred_language, quota_reservation_token,
          contradictions, operator_review_status, operator_notes, operator_task_draft, created_at
        FROM ai_module.product_research_runs
        WHERE product_id = $1 AND merchant_id = $2
        ORDER BY created_at DESC
        LIMIT 1
      `, [productId, merchantId]);
      if (!run.rows[0]) {
        return reply.status(404).send({ error: { code: "resource_not_found", message: "No research run found" } });
      }
      const sources = await db.query(`
        SELECT title, url, snippet, content, language, rank
        FROM ai_module.product_research_sources
        WHERE run_id = $1
        ORDER BY rank ASC
      `, [run.rows[0].id]);
      const sourceRows = sources.rows;
      return reply.send({
        data: {
          runId: run.rows[0].id,
          merchantId: run.rows[0].merchant_id,
          productId: run.rows[0].product_id,
          productTitle: run.rows[0].product_title,
          provider: run.rows[0].provider,
          status: run.rows[0].status,
          summary: run.rows[0].summary,
          confidence: run.rows[0].confidence,
          riskFlags: run.rows[0].risk_flags,
          contradictions: run.rows[0].contradictions,
          rawQuery: run.rows[0].raw_query,
          preferredLanguage: run.rows[0].preferred_language,
          quotaReservationToken: run.rows[0].quota_reservation_token,
          operatorReviewStatus: run.rows[0].operator_review_status,
          operatorNotes: run.rows[0].operator_notes,
          operatorTaskDraft: run.rows[0].operator_task_draft,
          createdAt: new Date(run.rows[0].created_at).toISOString(),
          bestSource: bestResearchSource(sourceRows),
          sources: sourceRows,
        },
      });
    } catch (err) {
      return replyError(reply, err);
    }
  });

  server.patch("/ai/product-research/runs/:runId/review", async (req, reply) => {
    try {
      const actor = operatorFromRequest(req);
      requireFeature("product_research");
      await requireActorPermission(actor, "product_research:run");
      const { runId } = req.params as { runId: string };
      const { operatorNotes, operatorReviewStatus, operatorTaskDraft } = (req.body || {}) as {
        operatorNotes?: string;
        operatorReviewStatus?: string;
        operatorTaskDraft?: Record<string, unknown> | null;
      };
      const reviewStatus = ["pending", "reviewed", "needs_follow_up"].includes(String(operatorReviewStatus || ""))
        ? String(operatorReviewStatus)
        : "pending";
      const operatingScope = await requireMutationScope(actor, requestHeaders(req));
      const merchantId = operatingScope.merchantId;
      const db = getDb();
      const result = await db.query(`
        UPDATE ai_module.product_research_runs
        SET operator_notes = $3,
            operator_review_status = $4,
            operator_task_draft = $5::jsonb,
            operator_reviewed_by = $6,
            operator_reviewed_at = now()
        WHERE id = $1::uuid AND merchant_id = $2
        RETURNING id::text, merchant_id, product_id, operator_notes, operator_review_status, operator_task_draft, operator_reviewed_at
      `, [
        runId,
        merchantId,
        String(operatorNotes || "").slice(0, 12000),
        reviewStatus,
        JSON.stringify(operatorTaskDraft || {}),
        actor.operatorId,
      ]);
      if (!result.rows[0]) {
        return reply.status(404).send({ error: { code: "resource_not_found", message: "No research run found" } });
      }
      return reply.send({
        data: {
          runId: result.rows[0].id,
          merchantId: result.rows[0].merchant_id,
          productId: result.rows[0].product_id,
          operatorNotes: result.rows[0].operator_notes,
          operatorReviewStatus: result.rows[0].operator_review_status,
          operatorTaskDraft: result.rows[0].operator_task_draft,
          operatorReviewedAt: new Date(result.rows[0].operator_reviewed_at).toISOString(),
        },
      });
    } catch (err) {
      return replyError(reply, err);
    }
  });
}

function deterministicResearchSources(productTitle: string, rawQuery: string, language: string): ProductResearchSource[] {
  const encoded = encodeURIComponent(rawQuery);
  return [
    {
      title: `Google Search: ${productTitle}`,
      url: `https://www.google.com/search?q=${encoded}`,
      snippet: "Operator should review current public search results before copying claims.",
      content: "Local deterministic mode does not retrieve web content. Enable Tavily to display source excerpts in this workspace.",
      language,
    },
    {
      title: `Tavily-ready query: ${productTitle}`,
      url: `https://tavily.com/search?q=${encoded}`,
      snippet: "Use Tavily provider when PRODUCT_RESEARCH_PROVIDER=tavily and API key is configured.",
      content: "This is a configuration hint, not a product source. It must not be used to advise customers.",
      language: "en",
    },
  ];
}

type ProductCatalog = Awaited<ReturnType<typeof listProducts>>;

interface OrderDraftCatalogItem {
  productId: string;
  productName: string;
  variantId: string;
  sku: string;
  stock: number;
}

interface NormalizedModelOrderDraft {
  variantId: string;
  productName: string;
  sku: string;
  quantity: number;
  paymentMethod: "cod" | "sepay_va" | "nowpayments";
  confidence: number;
  queryText: string;
  parser: string;
}

function orderDraftCatalog(products: ProductCatalog): OrderDraftCatalogItem[] {
  return products.flatMap((product) => (product.variants || []).map((variant) => ({
    productId: product.id,
    productName: product.title,
    variantId: variant.id,
    sku: variant.sku || variant.id,
    stock: Number(variant.inventory_quantity || 0),
  })));
}

export function normalizeModelOrderDraftPayload(
  payload: unknown,
  catalog: OrderDraftCatalogItem[],
  originalText: string,
): NormalizedModelOrderDraft | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.needsClarification === true) return null;

  const variantId = typeof record.variantId === "string" ? record.variantId.trim() : "";
  const sku = typeof record.sku === "string" ? record.sku.trim() : "";
  const selected = catalog.find((item) => item.variantId === variantId)
    || (sku ? catalog.find((item) => item.sku.toLowerCase() === sku.toLowerCase()) : undefined);
  if (!selected || selected.stock <= 0) return null;
  if (isAmbiguousModelSelection(originalText, selected, catalog)) return null;

  const quantityRaw = typeof record.quantity === "number" ? record.quantity : Number(record.quantity);
  const quantity = Number.isInteger(quantityRaw) && quantityRaw > 0 ? Math.min(quantityRaw, 99) : parseOrderDraftQuantity(originalText);
  if (quantity > selected.stock) return null;

  const payment = typeof record.paymentMethod === "string" ? record.paymentMethod : "";
  const paymentMethod = payment === "sepay_va" || payment === "nowpayments" || payment === "cod"
    ? payment
    : parseOrderDraftPaymentMethod(originalText);
  const confidenceRaw = typeof record.confidence === "number" ? record.confidence : Number(record.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(confidenceRaw, 1)) : 0;
  const threshold = Number(process.env.AI_ORDER_CONFIDENCE_MIN || "0.65");
  if (confidence < threshold) return null;

  return {
    variantId: selected.variantId,
    productName: selected.productName,
    sku: selected.sku,
    quantity,
    paymentMethod,
    confidence,
    queryText: typeof record.queryText === "string" && record.queryText.trim()
      ? record.queryText.trim()
      : searchQueryForOrderDraft(originalText) || originalText,
    parser: process.env.AI_ORDER_PROVIDER || process.env.AI_PROVIDER || "openai-compatible",
  };
}

function isAmbiguousModelSelection(originalText: string, selected: OrderDraftCatalogItem, catalog: OrderDraftCatalogItem[]): boolean {
  const normalizedText = originalText.toLowerCase();
  if (selected.sku && normalizedText.includes(selected.sku.toLowerCase())) return false;

  const query = searchQueryForOrderDraft(originalText).toLowerCase();
  if (query.length < 3) return true;
  const matched = catalog.filter((item) => {
    const productName = item.productName.toLowerCase();
    const sku = item.sku.toLowerCase();
    return productName.includes(query) || sku.includes(query) || query.split(/\s+/).every((part) => productName.includes(part) || sku.includes(part));
  });
  const inStockMatched = matched.filter((item) => item.stock > 0);
  return inStockMatched.length > 1;
}

async function runModelOrderDraft(text: string, products: ProductCatalog): Promise<NormalizedModelOrderDraft | null> {
  const provider = (process.env.AI_ORDER_PROVIDER || process.env.AI_PROVIDER || "deterministic").trim();
  if (provider !== "openai-compatible") return null;
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!apiKey) return null;

  const catalog = orderDraftCatalog(products).filter((item) => item.stock > 0);
  if (catalog.length === 0) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Number(process.env.AI_ORDER_TIMEOUT_MS || process.env.AI_REQUEST_TIMEOUT_MS || "12000"));
  try {
    const endpoint = (process.env.AI_API_ENDPOINT || "https://api.deepseek.com").replace(/\/$/, "");
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.AI_ORDER_MODEL || process.env.AI_MODEL || "deepseek-v4-pro",
        messages: [
          { role: "system", content: buildOrderDraftSystemPrompt() },
          { role: "user", content: buildOrderDraftUserMessage(text, catalog) },
        ],
        temperature: Number(process.env.AI_ORDER_TEMPERATURE || "0.1"),
        max_tokens: Number(process.env.AI_ORDER_MAX_TOKENS || "500"),
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new PlatformError("provider_request_failed", `AI order draft failed with HTTP ${response.status}`, 502, {
        provider,
        status: response.status,
      });
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content || "{}";
    const payload = JSON.parse(raw) as unknown;
    return normalizeModelOrderDraftPayload(payload, catalog, text);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function buildTelegramSalesOrderDraft(
  text: string,
  merchantId: string,
  stockLocationId: string,
  server: FastifyInstance,
): Promise<Record<string, unknown>> {
  const orderText = orderTextWithoutCustomerSelector(text);
  const catalog = await listProducts({ merchantId, stockLocationId, limit: 25 });
  const modelDraft = await runModelOrderDraft(orderText, catalog).catch((err) => {
    server.log.warn({ err }, "Telegram sales AI order draft model failed; falling back to deterministic parser");
    return null;
  });
  if (modelDraft) {
    return {
      items: [{
        variantId: modelDraft.variantId,
        quantity: modelDraft.quantity,
        productName: modelDraft.productName,
        sku: modelDraft.sku,
      }],
      paymentMethod: "cod",
      note: `Telegram sales AI draft: ${text}`,
      confidence: modelDraft.confidence >= 0.85 ? "high" : "medium",
      parser: modelDraft.parser,
      queryText: modelDraft.queryText,
      clarification: null,
    };
  }

  const quantity = parseOrderDraftQuantity(orderText);
  const queryText = searchQueryForOrderDraft(orderText) || orderText;
  const products = await listProducts({ merchantId, stockLocationId, q: queryText, limit: 5 });
  const clarification = orderDraftClarification(queryText, products);
  const match = firstSellableVariant(products);
  if (!match) {
    throw new PlatformError("order_draft_needs_clarification", "No in-stock product matched the order text", 409, {
      queryText,
      clarification,
    });
  }

  const exactSkuMentioned = Boolean(match.sku && text.toLowerCase().includes(match.sku.toLowerCase()));
  if (clarification.options.length > 1 && !exactSkuMentioned) {
    throw new PlatformError("order_draft_needs_clarification", "Multiple product candidates matched the order text", 409, {
      queryText,
      clarification,
    });
  }

  return {
    items: [{ variantId: match.variantId, quantity, productName: match.productName, sku: match.sku }],
    paymentMethod: "cod",
    note: `Telegram sales AI draft: ${text}`,
    confidence: match.stock > 0 ? "medium" : "low",
    parser: "deterministic-sales",
    queryText,
    clarification: null,
  };
}

function buildOrderDraftSystemPrompt(): string {
  return [
    "You parse Vietnamese Telegram order messages for a nicotine pouch retail POS.",
    "Return JSON only. Do not create orders. Do not invent product IDs or SKUs.",
    "Select exactly one in-stock catalog variant only when the message clearly identifies it.",
    "If product, quantity, or payment method is ambiguous, set needsClarification=true.",
    "Payment mapping: cod for COD/cash-on-delivery, sepay_va for QR/CK/chuyen khoan, nowpayments for USDT/USDC/crypto.",
    "Schema: {\"variantId\": string|null, \"sku\": string|null, \"quantity\": number, \"paymentMethod\": \"cod\"|\"sepay_va\"|\"nowpayments\", \"confidence\": number, \"queryText\": string, \"needsClarification\": boolean, \"clarificationReason\": string|null}.",
  ].join(" ");
}

function buildOrderDraftUserMessage(text: string, catalog: OrderDraftCatalogItem[]): string {
  const rows = catalog.map((item) => ({
    productName: item.productName,
    sku: item.sku,
    variantId: item.variantId,
    stock: item.stock,
  }));
  return JSON.stringify({
    message: text,
    catalog: rows,
    instruction: "Pick one catalog variant only if confident. Prefer SKU exact match over product-name match.",
  });
}

export function parseOrderDraftQuantity(text: string): number {
  const normalized = text.trim();
  const explicit = normalized.match(/(?:^|\s)(?:x|sl|qty|quantity|so luong|số lượng)\s*[:=]?\s*(\d{1,3})\b/i)
    || normalized.match(/\bx\s*(\d{1,3})\b/i);
  const beforeUnit = normalized.match(/(?:^|\s)(\d{1,3})\s*(?:hop|hộp|cai|cái|goi|gói)\b/i);
  const leading = normalized.match(/^(\d{1,3})(?:\s|$)/);
  const match = explicit || beforeUnit || leading;
  const quantity = match ? Number(match[1]) : 1;
  return Number.isInteger(quantity) && quantity > 0 ? Math.min(quantity, 99) : 1;
}

export function searchQueryForOrderDraft(text: string): string {
  return orderTextWithoutCustomerSelector(text)
    .replace(/(?:^|\s)(?:x|sl|qty|quantity|so luong|số lượng)\s*[:=]?\s*\d{1,3}\b/gi, " ")
    .replace(/\bx\s*\d{1,3}\b/gi, " ")
    .replace(/(?:^|\s)\d{1,3}(?=$|[\s,;])/g, " ")
    .replace(/\b(hop|hộp|cai|cái|goi|gói|cho|khach|khách|quen|order|don|đơn|thanh|toan|toán|chuyen|chuyển|khoan|khoản|qr|sepay|ck|cod|crypto|usdt|usdc|nowpayments|x)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function customerSelectorForOrderDraft(text: string): string | null {
  const explicit = text.match(/(?:^|\s)(?:customer|khach|khách)\s*=\s*([^\s,;]+)/i);
  if (explicit?.[1]) return explicit[1].trim();
  const phone = text.match(/(?:^|\s)(\+?84\d{9}|0\d{9,10})(?=$|[\s,;])/);
  return phone?.[1] || null;
}

export function orderTextWithoutCustomerSelector(text: string): string {
  return text
    .replace(/(?:^|\s)(?:customer|khach|khách)\s*=\s*[^\s,;]+/gi, " ")
    .replace(/(?:^|\s)(?:\+?84\d{9}|0\d{9,10})(?=$|[\s,;])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface OrderDraftCustomer {
  id: string;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

interface OrderDraftCustomerClarification {
  type: "customer";
  queryText: string;
  message: string;
  options: Array<{ customerId: string; customerName: string; phone?: string }>;
}

interface OrderDraftCustomerResolution {
  customerId?: string;
  clarification?: OrderDraftCustomerClarification;
}

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("84") && digits.length >= 11) return `0${digits.slice(2)}`;
  return digits;
}

export function selectOrderDraftCustomer(selector: string | null, customers: OrderDraftCustomer[]): OrderDraftCustomerResolution {
  if (!selector) return {};
  const normalizedSelector = normalizePhone(selector);
  const phoneSelector = /^\d{10,11}$/.test(normalizedSelector);
  const candidates = phoneSelector
    ? customers.filter((customer) => normalizePhone(String(customer.phone || "")) === normalizedSelector)
    : customers;

  if (candidates.length === 1) return { customerId: candidates[0].id };

  const label = (customer: OrderDraftCustomer) => [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim() || customer.id;
  const options = candidates.slice(0, 5).map((customer) => ({
    customerId: customer.id,
    customerName: label(customer),
    phone: customer.phone || undefined,
  }));
  const message = candidates.length === 0
    ? `Khong tim thay khach hang cho ${selector}. Gui lai /order voi customer=<so-dien-thoai> hoac tao khach trong POS.`
    : `Co nhieu khach hang khop ${selector}. Gui lai /order voi customer=<so-dien-thoai> de chon dung khach.`;
  return { clarification: { type: "customer", queryText: selector, message, options } };
}

async function resolveOrderDraftCustomer(text: string, merchantId: string): Promise<OrderDraftCustomerResolution> {
  const selector = customerSelectorForOrderDraft(text);
  if (!selector) return {};
  const result = await listCustomers({ merchantId, q: selector });
  return selectOrderDraftCustomer(selector, result.customers as OrderDraftCustomer[]);
}

export function parseOrderDraftPaymentMethod(text: string): "cod" | "sepay_va" | "nowpayments" {
  const normalized = text.toLowerCase();
  if (/\b(crypto|usdt|usdc|nowpayments)\b/i.test(normalized)) return "nowpayments";
  if (/\b(qr|sepay|ck)\b/i.test(normalized)) return "sepay_va";
  if (/(chuyen|chuyển)\s*(khoan|khoản)/i.test(normalized)) return "sepay_va";
  return "cod";
}

function firstSellableVariant(products: Awaited<ReturnType<typeof listProducts>>) {
  for (const product of products) {
    for (const variant of product.variants || []) {
      const stock = Number(variant.inventory_quantity || 0);
      if (stock > 0) {
        return {
          productName: product.title,
          variantId: variant.id,
          sku: variant.sku,
          stock,
        };
      }
    }
  }
  return null;
}

export interface OrderDraftClarificationOption {
  productId: string;
  productName: string;
  variantId: string;
  sku: string;
  stock: number;
}

export function orderDraftClarification(queryText: string, products: Awaited<ReturnType<typeof listProducts>>) {
  const options: OrderDraftClarificationOption[] = [];
  for (const product of products) {
    for (const variant of product.variants || []) {
      const stock = Number(variant.inventory_quantity || 0);
      options.push({
        productId: product.id,
        productName: product.title,
        variantId: variant.id,
        sku: variant.sku || variant.id,
        stock,
      });
    }
  }
  return {
    type: "product" as const,
    queryText,
    message: options.length
      ? `Multiple product candidates matched "${queryText}". Choose an in-stock SKU.`
      : `No in-stock product matched "${queryText}". Try /stock ${queryText}.`,
    options: options
      .sort((a, b) => Number(b.stock > 0) - Number(a.stock > 0) || b.stock - a.stock || a.productName.localeCompare(b.productName))
      .slice(0, 5),
  };
}

interface ProductResearchSource {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  language: string;
  rank?: number;
}

interface ProductResearchProviderResult {
  summary: string;
  sources: ProductResearchSource[];
  query: string;
  confidence?: string;
}

export function bestResearchSource<T extends { title: string; url: string; snippet?: string; content?: string; language?: string | null; rank?: number | null }>(sources: T[]) {
  const source = sources.find((item) => item.url && item.title) || sources[0];
  if (!source) return null;
  return {
    title: source.title,
    url: source.url,
    snippet: source.snippet || "",
    content: source.content || "",
    language: source.language || undefined,
    rank: source.rank ? Number(source.rank) : undefined,
  };
}

async function runProductResearchProvider(productTitle: string, rawQuery: string, language: string): Promise<ProductResearchProviderResult> {
  const provider = process.env.PRODUCT_RESEARCH_PROVIDER || "deterministic";
  if (provider !== "tavily") {
    return {
      summary: "",
      sources: deterministicResearchSources(productTitle, rawQuery, language),
      query: rawQuery,
    };
  }
  return runTavilyProductResearch(productTitle, rawQuery, language);
}

function configuredInteger(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function normalizeResearchText(value: unknown, maxLength: number) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function sourceLanguage(text: string, fallback: string) {
  return /[ăâđêôơưĂÂĐÊÔƠƯ]/.test(text) ? "vi" : fallback;
}

export function normalizeTavilyProductResearch(payload: {
  answer?: string;
  results?: Array<{ title?: string; url?: string; content?: string; raw_content?: string; score?: number }>;
}, productTitle: string, query: string, language: string): ProductResearchProviderResult {
  const sourceContentLimit = configuredInteger("TAVILY_SOURCE_CONTENT_MAX_CHARS", 4000, 500, 12000);
  const sources = (payload.results || [])
    .filter((item) => item.title && item.url)
    .slice(0, configuredInteger("TAVILY_MAX_RESULTS", 5, 1, 10))
    .map((item, index) => {
      const content = normalizeResearchText(item.raw_content || item.content, sourceContentLimit);
      const snippet = normalizeResearchText(item.content || content, 700);
      return {
        title: String(item.title),
        url: String(item.url),
        snippet,
        content,
        language: sourceLanguage(`${item.title || ""} ${content}`, language),
        rank: index + 1,
      };
    });

  return {
    summary: normalizeResearchText(payload.answer, 5000) || (sources.length
      ? `${productTitle}: Tavily returned ${sources.length} source-backed results for operator review.`
      : `${productTitle}: Tavily did not return a usable source for this query.`),
    sources,
    query,
    // Tavily relevance is not claim verification. A web result remains review-only
    // until the operator checks the primary source, regardless of source count.
    confidence: sources.length ? "medium" : "low",
  };
}

export async function runTavilyProductResearch(productTitle: string, rawQuery: string, language: string): Promise<ProductResearchProviderResult> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    throw new PlatformError("provider_config_missing", "TAVILY_API_KEY is required when PRODUCT_RESEARCH_PROVIDER=tavily", 503);
  }

  const query = language === "vi"
    ? `${rawQuery} thông tin sản phẩm thành phần xuất xứ đánh giá`
    : rawQuery;
  const response = await fetch(`${(process.env.TAVILY_API_BASE || "https://api.tavily.com").replace(/\/$/, "")}/search`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: process.env.TAVILY_SEARCH_DEPTH || "advanced",
      topic: "general",
      max_results: configuredInteger("TAVILY_MAX_RESULTS", 5, 1, 10),
      include_answer: "advanced",
      include_raw_content: "markdown",
      include_images: false,
      include_favicon: true,
      country: language === "vi" ? "vietnam" : undefined,
    }),
  });
  const payload = await response.json().catch(() => ({})) as {
    answer?: string;
    results?: Array<{ title?: string; url?: string; content?: string; raw_content?: string; score?: number }>;
    request_id?: string;
  };
  if (!response.ok) {
    throw new PlatformError("provider_request_failed", `Tavily search failed with HTTP ${response.status}`, 502, {
      provider: "tavily",
      status: response.status,
      requestId: payload.request_id,
    });
  }
  return normalizeTavilyProductResearch(payload, productTitle, query, language);
}
