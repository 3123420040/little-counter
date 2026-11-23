import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import * as applicationNamespace from "@medusa-snus/application";
import type { ChannelActor, HeadersLike, OperatorContext, Role } from "@medusa-snus/application";
import type { PermissionId } from "@medusa-snus/contracts";
import { registerAiRoutes } from "./routes/index.js";
import { sendAiError } from "./error-response.js";
import type { ExactOutboxRuntimeReadiness } from "./worker/exact-outbox-runtime.js";

const applicationModule = ((applicationNamespace as unknown as { default?: typeof import("@medusa-snus/application") }).default ?? applicationNamespace) as typeof import("@medusa-snus/application");
const { authenticateChannelServiceOnlyHeaders, enforceRateLimit, requireActorPermission, requireRole, resolveChannelActor, verifyJwt } = applicationModule as typeof import("@medusa-snus/application");

const PUBLIC_PATHS = new Set([
  "/health",
  "/ai/health",
  "/docs",
  "/openapi.json",
]);

const ROLE_RULES: Array<{ prefixes: string[]; role: Role }> = [
  { prefixes: ["/ai/actions"], role: "manager" },
  { prefixes: ["/ai/product-research"], role: "manager" },
  { prefixes: ["/ai/vision"], role: "staff" },
  { prefixes: ["/ai/order-draft"], role: "staff" },
  { prefixes: ["/ai/review-queue", "/ai/alerts", "/ai/recommendations"], role: "staff" },
  { prefixes: ["/ai/reply-draft"], role: "staff" },
];

type AiRequestActor = OperatorContext | ChannelActor;
type AiChannelService = ReturnType<typeof authenticateChannelServiceOnlyHeaders>;

export function requiredRoleForRequest(method: string, path: string): Role {
  if (path.startsWith("/ai/product-research")) {
    return method.toUpperCase() === "GET" ? "staff" : "manager";
  }
  for (const rule of ROLE_RULES) {
    if (rule.prefixes.some(prefix => path.startsWith(prefix))) return rule.role;
  }
  return "staff";
}

function hasChannelHeaders(headers: HeadersLike): boolean {
  const value = headers["x-channel"] ?? headers["X-Channel"];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

export function requiredChannelPermissionForRequest(method: string, path: string): PermissionId | null {
  if (path.startsWith("/ai/telegram-sales/")) {
    return null;
  }
  if (path.startsWith("/ai/actions") || path.startsWith("/ai/review-queue") || path.startsWith("/ai/alerts")) {
    return "ai:review";
  }
  if (path.startsWith("/ai/product-research")) {
    return method.toUpperCase() === "GET" ? "product_research:read" : "product_research:run";
  }
  if (path.startsWith("/ai/order-draft")) {
    return "telegram_ai_order:create";
  }
  if (path.startsWith("/ai/vision")) {
    return "vision_scan:use";
  }
  return null;
}

type BuildServerOptions = {
  outboxReadiness?: () => ExactOutboxRuntimeReadiness;
};

export async function buildServer(options: BuildServerOptions = {}) {
  const server = Fastify({ logger: true });

  server.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (PUBLIC_PATHS.has(path)) return;
    const requestHeaders = request.headers as HeadersLike;

    try {
      enforceRateLimit(requestHeaders, path.startsWith("/ai") ? "ai" : "default");

      if (hasChannelHeaders(requestHeaders)) {
        if (path.startsWith("/ai/telegram-sales/")) {
          (request as typeof request & { channelService?: AiChannelService }).channelService = authenticateChannelServiceOnlyHeaders(requestHeaders);
          return;
        }
        const permission = requiredChannelPermissionForRequest(request.method, path);
        if (!permission) {
          return reply.status(403).send({ error: { code: "forbidden", message: "Channel access is not enabled for this AI route" } });
        }
        const operator = await resolveChannelActor(requestHeaders);
        await requireActorPermission(operator, permission);
        (request as typeof request & { operator?: AiRequestActor }).operator = operator;
        return;
      }

      const auth = request.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ")) {
        return reply.status(401).send({ error: { code: "unauthorized", message: "Missing token" } });
      }

      const payload = verifyJwt(auth.slice(7));
      if (!payload) {
        return reply.status(401).send({ error: { code: "unauthorized", message: "Invalid token" } });
      }

      const requiredRole = requiredRoleForRequest(request.method, path);
      if (!requireRole(payload, requiredRole)) {
        return reply.status(403).send({ error: { code: "forbidden", message: `Requires ${requiredRole} role` } });
      }
      (request as typeof request & { operator?: AiRequestActor }).operator = {
        operatorId: payload.operatorId,
        role: payload.role as Role,
        displayName: payload.displayName,
        organizationId: payload.organizationId,
      };
    } catch (err) {
      return sendAiError(reply, err);
    }
  });

  server.get("/health", async () => ({ status: "ok", service: "ai-module" }));
  server.get("/ai/health", async (_request, reply) => {
    if (!options.outboxReadiness) {
      return { status: "ok", service: "ai-module" };
    }
    const outbox = options.outboxReadiness();
    return reply.status(outbox.ready ? 200 : 503).send({
      status: outbox.ready ? "ok" : "not_ready",
      service: "ai-module",
      outbox,
    });
  });

  registerAiRoutes(server);

  return server;
}

export async function start() {
  const server = await buildServer();
  const port = Number(process.env.AI_PORT) || 3002;

  await server.listen({ port, host: "0.0.0.0" });
  console.log(`AI Module running on :${port}`);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  start().catch((err) => {
    console.error("AI Module failed to start:", err);
    process.exit(1);
  });
}
