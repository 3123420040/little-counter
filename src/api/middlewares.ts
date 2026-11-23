import { randomUUID } from "node:crypto";

// Medusa loads this boundary through ts-node with legacy `moduleResolution: Node`.
// A static subpath import is valid at runtime but is rejected by that compiler
// mode because the framework exposes `/http` only through package exports.
// `require` keeps runtime resolution in Node, where the supported export exists.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const frameworkHttp = require("@medusajs/framework/http") as unknown;

// Medusa 2.19.0 exposes this helper at runtime but omits it from the package's
// declaration surface. Keep the compatibility cast local to this boundary.
const defineMiddlewares = (frameworkHttp as unknown as {
  defineMiddlewares: (config: unknown) => unknown;
}).defineMiddlewares;

type TraceHeaderEnvironment = Partial<Pick<NodeJS.ProcessEnv, "BUILD_RELEASE_ID" | "BUILD_SOURCE_COMMIT">>;
type TraceIdentityHeaders = Record<"x-correlation-id", string>
  & Partial<Record<"x-release-id" | "x-source-commit", string>>;

const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;

export function resolveTraceIdentityHeaders(
  incomingCorrelationId: string | string[] | undefined,
  environment: TraceHeaderEnvironment = process.env,
  idFactory: () => string = randomUUID,
): TraceIdentityHeaders {
  const incoming = typeof incomingCorrelationId === "string" ? incomingCorrelationId.trim() : "";
  const correlationId = CORRELATION_ID.test(incoming) ? incoming : idFactory();
  const headers: Record<string, string> = { "x-correlation-id": correlationId };
  const releaseId = environment.BUILD_RELEASE_ID?.trim() || "";
  const sourceCommit = environment.BUILD_SOURCE_COMMIT?.trim() || "";
  if (RELEASE_ID.test(releaseId)) headers["x-release-id"] = releaseId;
  if (SOURCE_COMMIT.test(sourceCommit)) headers["x-source-commit"] = sourceCommit;
  return headers as TraceIdentityHeaders;
}

export function traceIdentityHeaders(
  req: { headers: Record<string, string | string[] | undefined>; originalUrl?: string; method?: string; route?: {path?: unknown} },
  res: { setHeader: (name: string, value: string) => unknown; statusCode?: number; once?: (event: string, listener: () => void) => unknown },
  next: () => void,
): void {
  const headers = resolveTraceIdentityHeaders(req.headers["x-correlation-id"]);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if(process.env.PARTNER_API_ENABLED === "true" && !req.originalUrl?.startsWith("/partner/") && req.originalUrl!=="/mcp") {
    const started=performance.now();
    res.once?.("finish",()=>{
      const route=typeof req.route?.path==="string" && req.route.path.length<=256 ? req.route.path : "internal";
      const entry={timestamp:new Date().toISOString(),service:"medusa-internal-http",request_id:headers["x-correlation-id"],
        route,method:["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"].includes(req.method??"")?req.method:"OTHER",
        status:res.statusCode,duration_ms:Math.round(performance.now()-started)};
      if(process.stdout.writableLength<65536)process.stdout.write(`${JSON.stringify(entry)}\n`);
    });
  }
  next();
}

export default defineMiddlewares({
  routes: [
    { matcher:"/mcp",bodyParser:false },
    {
      matcher: /.*/,
      middlewares: [traceIdentityHeaders],
    },
    {
      matcher: "/webhooks/sepay",
      method: ["POST"],
      bodyParser: {
        preserveRawBody: true,
      },
    },
    {
      matcher: "/api/webhooks/sepay",
      method: ["POST"],
      bodyParser: {
        preserveRawBody: true,
      },
    },
    {
      matcher: "/pos/vision/scan-products",
      method: ["POST"],
      bodyParser: {
        sizeLimit: "8mb",
      },
    },
    {
      matcher: "/api/pos/vision/scan-products",
      method: ["POST"],
      bodyParser: {
        sizeLimit: "8mb",
      },
    },
    {
      matcher: "/platform/admin/vision/catalog/reference-image-uploads",
      method: ["POST"],
      bodyParser: {
        sizeLimit: "8mb",
      },
    },
    {
      matcher: "/api/platform/admin/vision/catalog/reference-image-uploads",
      method: ["POST"],
      bodyParser: {
        sizeLimit: "8mb",
      },
    },
  ],
});
