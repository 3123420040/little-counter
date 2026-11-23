import { Pool, type PoolClient } from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { PartnerMeQuery, PartnerProductQuery, PartnerInventoryQuery, PartnerCatalogSummaryQuery, PartnerOrderQuery, PartnerOrderDetailQuery,
  isPartnerSchema, type PartnerQuoteRequest, type PartnerOrderRequest } from "@medusa-snus/contracts/partner-api";
import { createPartnerTokenVerifier, type VerifiedPartnerToken } from "./token";
import { createPartnerRedis, enforcePartnerQuota, acquirePartnerMutation } from "./quota";
import { readPartnerIdentity, readPartnerMcpIdentity, selectPartnerStore, partnerMe, type PartnerIdentity, type PartnerContext } from "./registry";
import { readPartnerCatalog, readPartnerCatalogSummary } from "./catalog";
import { createPartnerQuoteForClient } from "./quotes";
import { bookPartnerOrderForClient } from "./booking";
import { readPartnerOrder, listPartnerOrders } from "./orders";
import type { PartnerKeyring } from "./fingerprints";
import { PartnerError, partnerProblem } from "./errors";
import { isPartnerMcpContext } from "@medusa-snus/contracts/partner-api";
import { partnerContactKeyringSchema } from "./contact-crypto";
import { partnerDatabaseTimeouts, withPartnerTransaction } from "./transaction";

const positive = z.number().int().min(1).max(120000);
const configSchema = z.strictObject({
  environment: z.enum(["sandbox", "production"]),
  issuer: z.url().optional(), audience: z.string().min(1).optional(), jwksUrl: z.url().optional(),
  databaseUrl: z.string().min(1), redisUrl: z.string().min(1),
  host: z.string().min(1).max(253).regex(/^[A-Za-z0-9.:[\]-]+$/),
  poolMax: z.number().int().min(1).max(20),
  mcp:z.strictObject({
    allowedOrigins:z.array(z.url().refine(value=>new URL(value).origin===value)).max(32),
    trustedProxyIps:z.array(z.string().min(1).max(64)).max(16),
    preauthIpPerMinute:positive,preauthIpBurst:positive,preauthGlobalPerMinute:positive,preauthGlobalBurst:positive,
    controlPerMinute:positive,controlBurst:positive,
  }).optional(),
  readMerchantPerMinute: positive, readMerchantBurst: positive,
  readGlobalPerMinute: positive, readGlobalBurst: positive,
  mutation: z.strictObject({ quoteMerchantPerMinute: positive, quoteMerchantBurst: positive,
    quoteGlobalPerMinute: positive, quoteGlobalBurst: positive,
    merchantConcurrency: positive, globalConcurrency: positive,
    book: z.strictObject({merchantPerMinute:positive,merchantBurst:positive,globalPerMinute:positive,globalBurst:positive}).optional() }).optional(),
  keyring: z.strictObject({ current: z.string().min(1), keys: z.record(z.string(), z.string()) }),
  contactKeys: partnerContactKeyringSchema.optional(),
  release: z.string().min(1).max(128), source: z.string().regex(/^[a-f0-9]{40}$/),
});
export type PartnerRuntimeConfig = z.infer<typeof configSchema>;
export interface PartnerInvocation {
  query?: Record<string,unknown>; body?: unknown; orderId?: string; idempotencyKey?: unknown;
  correlationId?: unknown;
}
export interface PartnerAttempt { requestId: string; traceId: string; spanId: string }
type PartnerAuthentication = { kind:"oauth_client"; token:VerifiedPartnerToken } | { kind:"mcp_key"; authorization:string };
export function newPartnerAttempt(): PartnerAttempt {
  return {requestId:`req_${randomUUID()}`,traceId:randomBytes(16).toString("hex"),spanId:randomBytes(8).toString("hex")};
}
export interface PartnerHttpRequest {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  originalUrl?: string;
  body?: unknown;
  params?: Record<string,unknown>;
}
export type PartnerReadOperation = "me" | "products" | "inventory" | "catalogSummary" | "orders" | "orderDetail";
export interface PartnerHttpResult { status: number; headers: Record<string, string>; body: unknown }
export interface PartnerAccessLog {
  timestamp: string; service: "medusa-partner-api"; environment: string; release: string; source: string;
  request_id: string; trace_id: string; span_id: string;
  partner_id: string | null; integration_id: string | null; client_id: string | null;
  auth_method?: "oauth_client" | "mcp_key" | null; credential_id?: string | null; key_id?: string | null;
  transport?: "rest" | "mcp_http"; tool_name?: string;
  merchant_id: string | null; store_id: string | null; grant_version: number | null;
  route: string; method: "GET" | "POST"; status: number; duration_ms: number;
  outcome: string; error_code: string | null; idempotency_replayed: boolean;
  client_correlation_id: string | null;
  original_request_id?: string;
}

export function readPartnerRuntimeConfig(env: NodeJS.ProcessEnv = process.env): PartnerRuntimeConfig {
  if (env.PARTNER_API_ENABLED !== "true" && env.PARTNER_MCP_ENABLED !== "true") throw new PartnerError("dependency_unavailable");
  // Private process config includes finite budgets and key references; never log
  // config validation details because they may include database credentials.
  try {
    const keyring = JSON.parse(readFileSync(env.PARTNER_FINGERPRINT_KEYS_FILE!, "utf8")) as PartnerKeyring;
    return configSchema.parse({
      environment: env.PARTNER_ENVIRONMENT, issuer: env.PARTNER_OAUTH_ISSUER,
      audience: env.PARTNER_OAUTH_AUDIENCE, jwksUrl: env.PARTNER_OAUTH_JWKS_URL,
      databaseUrl: env.PARTNER_DATABASE_URL, redisUrl: env.PARTNER_REDIS_URL, host: env.PARTNER_PUBLIC_HOST,
      poolMax: Number(env.PARTNER_DB_POOL_MAX),
      mcp:env.PARTNER_MCP_ENABLED==="true"?{
        allowedOrigins:(env.PARTNER_MCP_ALLOWED_ORIGINS??"").split(",").filter(Boolean),
        trustedProxyIps:(env.PARTNER_MCP_TRUSTED_PROXY_IPS??"").split(",").filter(Boolean),
        preauthIpPerMinute:Number(env.PARTNER_MCP_PREAUTH_IP_PER_MINUTE??120),preauthIpBurst:Number(env.PARTNER_MCP_PREAUTH_IP_BURST??20),
        preauthGlobalPerMinute:Number(env.PARTNER_MCP_PREAUTH_GLOBAL_PER_MINUTE??6000),preauthGlobalBurst:Number(env.PARTNER_MCP_PREAUTH_GLOBAL_BURST??100),
        controlPerMinute:Number(env.PARTNER_MCP_CONTROL_PER_MINUTE??60),controlBurst:Number(env.PARTNER_MCP_CONTROL_BURST??10),
      }:undefined,
      readMerchantPerMinute: Number(env.PARTNER_READ_MERCHANT_PER_MINUTE), readMerchantBurst: Number(env.PARTNER_READ_MERCHANT_BURST),
      readGlobalPerMinute: Number(env.PARTNER_READ_GLOBAL_PER_MINUTE), readGlobalBurst: Number(env.PARTNER_READ_GLOBAL_BURST),
      mutation: env.PARTNER_MUTATIONS_ENABLED === "true" ? {
        quoteMerchantPerMinute: Number(env.PARTNER_QUOTE_MERCHANT_PER_MINUTE), quoteMerchantBurst: Number(env.PARTNER_QUOTE_MERCHANT_BURST),
        quoteGlobalPerMinute: Number(env.PARTNER_QUOTE_GLOBAL_PER_MINUTE), quoteGlobalBurst: Number(env.PARTNER_QUOTE_GLOBAL_BURST),
        merchantConcurrency: Number(env.PARTNER_MUTATION_MERCHANT_CONCURRENCY), globalConcurrency: Number(env.PARTNER_MUTATION_GLOBAL_CONCURRENCY),
        book:env.PARTNER_BOOKING_ENABLED === "true" ? {merchantPerMinute:Number(env.PARTNER_BOOK_MERCHANT_PER_MINUTE),
          merchantBurst:Number(env.PARTNER_BOOK_MERCHANT_BURST),globalPerMinute:Number(env.PARTNER_BOOK_GLOBAL_PER_MINUTE),
          globalBurst:Number(env.PARTNER_BOOK_GLOBAL_BURST)}:undefined,
      } : undefined,
      contactKeys: env.PARTNER_DELIVERY_ENABLED === "true"
        ? JSON.parse(readFileSync(env.PARTNER_CONTACT_KEYS_FILE!, "utf8")) : undefined,
      keyring, release: env.BUILD_RELEASE_ID, source: env.BUILD_SOURCE_COMMIT,
    });
  } catch { throw new PartnerError("dependency_unavailable"); }
}

export function createPartnerRuntime(input: PartnerRuntimeConfig, accessLog: (entry: PartnerAccessLog) => void) {
  const config = configSchema.parse(input);
  if (!config.keyring.keys[config.keyring.current]
    || Object.values(config.keyring.keys).some((key) => Buffer.from(key, "base64url").length < 32)) {
    throw new PartnerError("dependency_unavailable");
  }
  const verify = config.issuer && config.audience && config.jwksUrl
    ? createPartnerTokenVerifier({issuer:config.issuer,audience:config.audience,jwksUrl:config.jwksUrl,environment:config.environment}) : undefined;
  const pool = new Pool({ connectionString: config.databaseUrl, max: config.poolMax,
    connectionTimeoutMillis: 1000, idleTimeoutMillis: 30000,
    ...partnerDatabaseTimeouts,
    application_name: "snus-partner-api" });
  pool.on("error", () => undefined);
  const redis = createPartnerRedis(config.redisUrl);
  // Reconnect remains owned by ioredis. Each request fails closed while not ready.
  const redisReady = redis.connect();
  void redisReady.catch(() => undefined);
  let inflight = 0;
  let telemetryDropped = 0;
  async function admitMcpControl(identity:PartnerIdentity){
    if(!config.mcp)throw new PartnerError("dependency_unavailable");
    await enforcePartnerQuota(redis,[{key:`partner:${config.environment}:mcp:control:${identity.integrationId}`,
      perMinute:config.mcp.controlPerMinute,burst:config.mcp.controlBurst}]);
  }
  async function withDatabase<T>(work: (db: PoolClient) => Promise<T>, write = false) {
    // Bound waiters as well as connections: partner requests cannot build an
    // unbounded pg Pool queue while auth/primary DB is slow.
    if (inflight >= config.poolMax) throw new PartnerError("mutation_busy");
    inflight++;
    try {
      return await withPartnerTransaction(pool, async db => {
        const role = await db.query(`SELECT NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)
          AND pg_has_role(current_user,'snus_partner_api','MEMBER') AS allowed
          FROM pg_roles WHERE rolname=current_user`);
        if (role.rows[0]?.allowed !== true) throw new PartnerError("dependency_unavailable");
        return work(db);
      }, { begin: write ? "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" });
    } catch (error) {
      if (error instanceof PartnerError) throw error;
      throw new PartnerError("dependency_unavailable");
    } finally { inflight--; }
  }
  async function execute(operation: PartnerReadOperation | "quotes" | "book", input: PartnerInvocation,
    authenticate:()=>Promise<PartnerAuthentication>, transport:"rest"|"mcp_http", attempt=newPartnerAttempt()): Promise<PartnerHttpResult> {
    const booking = operation === "book";
    const write = operation === "quotes" || booking;
    const started = performance.now();
    const {requestId,traceId,spanId}=attempt;
    const route = transport==="mcp_http"?"/mcp":`/partner/v1/${booking?"orders":operation==="orderDetail"?"orders/{order_id}":operation==="catalogSummary"?"catalog-summary":operation}`;
    const orderId = input.orderId ?? "";
    const headers: Record<string, string> = { "X-Request-Id": requestId, "Cache-Control": "no-store" };
    let identity: PartnerIdentity | undefined;
    let context: PartnerContext | undefined;
    let status = 200;
    let errorCode: string | null = null;
    let replayed = false;
    let businessAdmitted = false;
    let originalRequestId: string | undefined;
    let releaseLease: (() => Promise<void>) | undefined;
    let attemptFinished = false;
    try {
      if(operation==="orderDetail" && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(orderId)) throw new PartnerError("invalid_request");
      const auth=await authenticate();
      const readIdentity=(db:PoolClient)=>auth.kind==="mcp_key"
        ? readPartnerMcpIdentity(db,auth.authorization,config.environment,requestId,traceId,spanId)
        : readPartnerIdentity(db,auth.token,config.environment,requestId,traceId,spanId);
      if (write) {
        if (!config.mutation || (booking&&!config.mutation.book)) throw new PartnerError("dependency_unavailable");
        if (Buffer.byteLength(JSON.stringify(input.body) ?? "") > 65536) {
          throw new PartnerError("payload_too_large");
        }
        if (booking && input.body && typeof input.body === "object" && "payment_method" in input.body
          && typeof input.body.payment_method === "string" && input.body.payment_method !== "cod") throw new PartnerError("unsupported_payment_method");
        if (!PartnerMeQuery.safeParse(input.query ?? {}).success || !isPartnerSchema(booking?"OrderRequest":"QuoteRequest", input.body)) throw new PartnerError("invalid_request");
      }
      const pageQuery = operation === "me" || write ? undefined
        : (operation === "products" ? PartnerProductQuery : operation==="catalogSummary"?PartnerCatalogSummaryQuery:operation==="orders"?PartnerOrderQuery
          : operation==="orderDetail"?PartnerOrderDetailQuery:PartnerInventoryQuery).safeParse(input.query ?? {});
      if ((operation === "me" && !PartnerMeQuery.safeParse(input.query ?? {}).success)
        || (pageQuery && !pageQuery.success)) throw new PartnerError("invalid_request");
      const parsed = pageQuery?.success ? pageQuery.data : undefined;
      const body = await withDatabase(async (db) => {
        identity = await readIdentity(db);
        if (write) {
          const bodyInput = input.body as PartnerQuoteRequest | PartnerOrderRequest;
          const scope = booking?"orders:write":"orders:quote";
          context = selectPartnerStore(identity, bodyInput.store_id, scope, true);
          const budget = booking?config.mutation!.book!:{merchantPerMinute:config.mutation!.quoteMerchantPerMinute,
            merchantBurst:config.mutation!.quoteMerchantBurst,globalPerMinute:config.mutation!.quoteGlobalPerMinute,globalBurst:config.mutation!.quoteGlobalBurst};
          const quotaKind=booking?"book":"quote";
          businessAdmitted = true;
          await enforcePartnerQuota(redis, [
            {key:`partner:${config.environment}:${quotaKind}:integration:${identity.integrationId}`,perMinute:booking?identity.policy.bookPerMinute:identity.policy.quotePerMinute,burst:booking?identity.policy.bookBurst:identity.policy.quoteBurst},
            {key:`partner:${config.environment}:${quotaKind}:merchant:${identity.merchantId}`,perMinute:budget.merchantPerMinute,burst:budget.merchantBurst},
            {key:`partner:${config.environment}:${quotaKind}:global`,perMinute:budget.globalPerMinute,burst:budget.globalBurst},
          ]);
          if (attemptFinished) throw new PartnerError("dependency_unavailable");
          const acquiredLease = await acquirePartnerMutation(redis, [
            {key:`partner:${config.environment}:mutation:integration:${identity.integrationId}`,limit:identity.policy.mutationConcurrency},
            {key:`partner:${config.environment}:mutation:merchant:${identity.merchantId}`,limit:config.mutation!.merchantConcurrency},
            {key:`partner:${config.environment}:mutation:global`,limit:config.mutation!.globalConcurrency},
          ], requestId);
          // The DB deadline can finish the attempt while Redis is awaited.
          // Release an acknowledged late lease here: outer finally has already
          // run and cannot see it. A lost Redis ACK is still bounded by its TTL.
          if (attemptFinished) {
            try { await acquiredLease(); } catch { telemetryDropped++; }
            throw new PartnerError("dependency_unavailable");
          }
          releaseLease = acquiredLease;
          await db.query("SELECT integration.lock_authorization($1,$2,$3,$4)",
            [identity.integrationId,identity.registryClientId??identity.keyId,bodyInput.store_id,identity.authMethod]);
          // Re-read in READ COMMITTED after ordered locks, so a concurrent
          // revoke/policy/grant change is visible before any quote mutation.
          identity = await readIdentity(db);
          context = selectPartnerStore(identity, bodyInput.store_id, scope, true);
          if(booking){
            const result=await bookPartnerOrderForClient(db,context,config.keyring,bodyInput as PartnerOrderRequest,input.idempotencyKey ?? (transport==="mcp_http" ? mcpBookingKey(identity.integrationId,bodyInput.store_id,(bodyInput as PartnerOrderRequest).external_order_id) : undefined),config.contactKeys);
            if (!isPartnerSchema("OrderResponse", result.body)) throw new PartnerError("internal_error");
            status=result.status;replayed=result.replayed;
            originalRequestId="original_request_id" in result.body.meta ? result.body.meta.original_request_id : undefined;
            return result.body;
          }
          const result = await createPartnerQuoteForClient(db, context, config.keyring, bodyInput as PartnerQuoteRequest,!!config.contactKeys);
          if (!isPartnerSchema("QuoteResponse", result)) throw new PartnerError("internal_error");
          return result;
        }
        if (parsed) {
          context = selectPartnerStore(identity, parsed.store_id, operation === "products" ? "catalog:read"
            : operation === "catalogSummary" ? ["catalog:read", "inventory:read"]
            : operation==="orders"||operation==="orderDetail"?"orders:read":"inventory:read");
        }
        // Every accepted attempt, including /me, uses distributed fairness.
        businessAdmitted = true;
        await enforcePartnerQuota(redis, [
          { key: `partner:${config.environment}:read:integration:${identity.integrationId}`, perMinute: identity.policy.readPerMinute, burst: identity.policy.readBurst },
          { key: `partner:${config.environment}:read:merchant:${identity.merchantId}`, perMinute: config.readMerchantPerMinute, burst: config.readMerchantBurst },
          { key: `partner:${config.environment}:read:global`, perMinute: config.readGlobalPerMinute, burst: config.readGlobalBurst },
        ]);
        if (operation === "me") {
          const data=partnerMe(identity);
          return {data:transport==="mcp_http"?{...data,auth_method:"mcp_key",key_id:identity.keyId,client_id:null}:data,meta:{request_id:requestId}};
        }
        if(operation==="orderDetail")return readPartnerOrder(db,context!,orderId);
        if(operation==="orders")return listPartnerOrders(db,context!,config.keyring,parsed as z.infer<typeof PartnerOrderQuery>);
        if(operation==="catalogSummary")return readPartnerCatalogSummary(db,context!);
        // Query transforms run once; re-parsing an already transformed numeric
        // limit would reject otherwise-valid requests.
        return readPartnerCatalog(db, context!, config.keyring, parsed as z.infer<typeof PartnerInventoryQuery>, operation === "inventory");
      }, write);
      const schema = booking||operation==="orderDetail"?"OrderResponse":operation==="orders"?"OrdersResponse"
        : write ? "QuoteResponse" : operation === "me" ? "MeResponse" : operation === "products" ? "ProductsResponse"
          : operation === "catalogSummary" ? "CatalogSummaryResponse" : "InventoryResponse";
      if (transport==="mcp_http" && operation==="me") {
        if(!isPartnerMcpContext(body))throw new PartnerError("internal_error");
      } else if (!isPartnerSchema(schema, body)) throw new PartnerError("internal_error");
      if (operation==="quotes") status = 201;
      if (booking) {
        const receipt = body as { data: { order_id: string; store_id: string } };
        headers.Location = `/partner/v1/orders/${encodeURIComponent(receipt.data.order_id)}?store_id=${encodeURIComponent(receipt.data.store_id)}`;
        if (replayed) headers["Idempotency-Replayed"] = "true";
      }
      headers["Content-Type"] = "application/json";
      return { status, headers, body };
    } catch (error) {
      // Scope/capability/store denials occur before business admission. They
      let responseError=error;
      // still consume the integration's finite MCP control budget.
      if(transport==="mcp_http"&&identity&&!businessAdmitted){
        try{await admitMcpControl(identity);}catch(limited){responseError=limited;}
      }
      const problem = partnerProblem(responseError, requestId);
      status = problem.status;
      errorCode = problem.code;
      headers["Content-Type"] = "application/problem+json";
      if (status === 401) headers["WWW-Authenticate"] = "Bearer";
      if (status === 429 || status === 503) headers["Retry-After"] = String(responseError instanceof PartnerError ? responseError.retryAfter : 1);
      return { status, headers, body: problem };
    } finally {
      attemptFinished = true;
      // Cleanup failure after COMMIT is telemetry, never a failed business
      // response. The server-enforced lease TTL also bounds crash recovery.
      if (releaseLease) try { await releaseLease(); } catch { telemetryDropped++; }
      const correlation = input.correlationId;
      const entry: PartnerAccessLog = {
        timestamp: new Date().toISOString(), service: "medusa-partner-api", environment: config.environment,
        release: config.release, source: config.source, request_id: requestId, trace_id: traceId, span_id: spanId,
        partner_id: identity?.partnerId ?? null, integration_id: identity?.integrationId ?? null,
        client_id: identity?.clientId ?? null, merchant_id: identity?.merchantId ?? null,
        auth_method:identity?.authMethod??null,credential_id:identity?.credentialId??null,key_id:identity?.keyId??null,transport,
        tool_name:transport==="mcp_http"?({me:"get_partner_context",products:"list_products",inventory:"get_inventory",catalogSummary:"get_catalog_summary",quotes:"create_quote",book:"book_order",orders:"list_orders",orderDetail:"get_order"}[operation]):undefined,
        store_id: context?.storeId ?? null, grant_version: context?.storeGrantVersion ?? identity?.grantVersion ?? null,
        route, method: write ? "POST" : "GET", status, duration_ms: Math.round(performance.now() - started),
        outcome: errorCode ? "denied" : "success", error_code: errorCode, idempotency_replayed: replayed,
        original_request_id: originalRequestId,
        client_correlation_id: typeof correlation === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(correlation) ? correlation : null,
      };
      try { accessLog(entry); } catch { telemetryDropped++; }
    }
  }
  function handle(operation:PartnerReadOperation|"quotes"|"book",req:PartnerHttpRequest) {
    const booking=operation==="book",write=booking||operation==="quotes";
    const orderId=typeof req.params?.order_id==="string"?req.params.order_id:"";
    const exactRoute=`/partner/v1/${booking?"orders":operation==="orderDetail"?`orders/${orderId}`:operation==="catalogSummary"?"catalog-summary":operation}`;
    return execute(operation,{body:req.body,query:req.query,orderId,idempotencyKey:req.headers["idempotency-key"],
      correlationId:req.headers["x-correlation-id"]},async()=>{
      if(req.headers.host!==config.host||req.headers.cookie!==undefined||req.headers.origin!==undefined
        ||(req.originalUrl!==undefined&&req.originalUrl.split("?",1)[0]!==exactRoute))throw new PartnerError("invalid_request");
      if(!verify)throw new PartnerError("dependency_unavailable");
      const token=await verify(req.headers.authorization);
      if(write){
        if(typeof req.headers["content-type"]!=="string"||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers["content-type"]))throw new PartnerError("unsupported_media_type");
        if(Number(req.headers["content-length"]??0)>65536)throw new PartnerError("payload_too_large");
      }
      return {kind:"oauth_client",token};
    },"rest");
  }
  return { read: (operation: PartnerReadOperation, req: PartnerHttpRequest) => handle(operation, req),
    quote: (req: PartnerHttpRequest) => handle("quotes", req),
    book: (req: PartnerHttpRequest) => handle("book",req),
    mcp: (operation:PartnerReadOperation|"quotes"|"book",input:PartnerInvocation,authorization:string,attempt:PartnerAttempt)=>
      execute(operation,input,async()=>{if(!config.mcp)throw new PartnerError("dependency_unavailable");return {kind:"mcp_key",authorization};},"mcp_http",attempt),
    mcpSettings:()=>({host:config.host,...config.mcp}),
    admitMcpIp:async(ip:string)=>{
      if(!config.mcp)throw new PartnerError("dependency_unavailable");
      await enforcePartnerQuota(redis,[
        {key:`partner:${config.environment}:mcp:preauth:ip:${createHash("sha256").update(ip).digest("hex")}`,perMinute:config.mcp.preauthIpPerMinute,burst:config.mcp.preauthIpBurst},
        {key:`partner:${config.environment}:mcp:preauth:global`,perMinute:config.mcp.preauthGlobalPerMinute,burst:config.mcp.preauthGlobalBurst},
      ]);
    },
    admitMcpControl,
    authenticateMcp: (authorization:string,attempt:PartnerAttempt)=>withDatabase(db=>readPartnerMcpIdentity(db,authorization,
      config.environment,attempt.requestId,attempt.traceId,attempt.spanId)),
    ready: async () => { await redisReady; await withDatabase(async (db) => { await db.query("SELECT 1"); }); },
    health: () => ({ redis: redis.status === "ready", inflight, telemetryDropped }),
    close: async () => { redis.disconnect(); await pool.end(); },
  };
}

export function mcpBookingKey(integrationId:string,storeId:string,externalReference:string) {
  return createHash("sha256").update(JSON.stringify(["snus-mcp-booking-v1",integrationId,storeId,"v1:POST:/partner/v1/orders",externalReference])).digest("hex");
}
