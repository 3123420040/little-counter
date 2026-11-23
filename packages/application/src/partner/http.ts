import { randomBytes, randomUUID } from "node:crypto";
import { createPartnerRuntime, readPartnerRuntimeConfig, type PartnerHttpRequest, type PartnerReadOperation, type PartnerAccessLog } from "./runtime";
import { createPartnerTelemetry } from "./telemetry";
import { PartnerError, partnerProblem } from "./errors";

let telemetry: ReturnType<typeof createPartnerTelemetry> | undefined;
let outputDropped = 0;
export function partnerTelemetryHealth() {return {...telemetry?.health(),output_dropped:outputDropped};}
export function logPartnerAttempt(entry: PartnerAccessLog) {
  try {
    if(process.env.PARTNER_TELEMETRY_DIRECTORY && process.env.PARTNER_TELEMETRY_ENDPOINT) {
      telemetry ??= createPartnerTelemetry(process.env.PARTNER_TELEMETRY_DIRECTORY,process.env.PARTNER_TELEMETRY_ENDPOINT);
      telemetry.emit(entry);
    }
  } catch {outputDropped++;}
  // Backpressure has a hard cap; never queue unbounded strings on stdout.
  try {
    if(process.stdout.writableLength<65536)process.stdout.write(`${JSON.stringify(entry)}\n`);
    else outputDropped++;
  }catch {outputDropped++;}
}
let runtime: ReturnType<typeof createPartnerRuntime> | undefined;
export function getPartnerRuntime() {return runtime??=createPartnerRuntime(readPartnerRuntimeConfig(),logPartnerAttempt);}
async function partnerHttp(operation: PartnerReadOperation | "quotes" | "book", req: PartnerHttpRequest) {
  const started=performance.now();
  try {
    // Checked for every attempt, including after this process initialized.
    if (process.env.PARTNER_API_ENABLED !== "true") throw new PartnerError("dependency_unavailable");
    if ((operation === "quotes"||operation==="book") && process.env.PARTNER_MUTATIONS_ENABLED !== "true") throw new PartnerError("dependency_unavailable");
    if(operation==="book" && process.env.PARTNER_BOOKING_ENABLED!=="true") throw new PartnerError("dependency_unavailable");
    runtime=getPartnerRuntime();
    return await (operation === "quotes" ? runtime.quote(req) : operation==="book"?runtime.book(req):runtime.read(operation, req));
  } catch {
    const requestId = `req_${randomUUID()}`;
    logPartnerAttempt({timestamp:new Date().toISOString(),service:"medusa-partner-api",
      environment:process.env.PARTNER_ENVIRONMENT==="production"?"production":"sandbox",
      release:/^[A-Za-z0-9._-]{1,128}$/.test(process.env.BUILD_RELEASE_ID??"")?process.env.BUILD_RELEASE_ID!:"unconfigured",
      source:/^[a-f0-9]{40}$/.test(process.env.BUILD_SOURCE_COMMIT??"")?process.env.BUILD_SOURCE_COMMIT!:"unknown",
      request_id:requestId,trace_id:randomBytes(16).toString("hex"),span_id:randomBytes(8).toString("hex"),
      partner_id:null,integration_id:null,client_id:null,merchant_id:null,store_id:null,grant_version:null,
      route:`/partner/v1/${operation==="book"?"orders":operation==="orderDetail"?"orders/{order_id}":operation==="catalogSummary"?"catalog-summary":operation}`,
      method:operation==="book"||operation==="quotes"?"POST":"GET",status:503,duration_ms:Math.round(performance.now()-started),
      outcome:"denied",error_code:"dependency_unavailable",idempotency_replayed:false,client_correlation_id:null});
    return { status: 503, headers: { "X-Request-Id": requestId, "Cache-Control": "no-store",
      "Content-Type": "application/problem+json", "Retry-After": "1" },
    body: partnerProblem(new PartnerError("dependency_unavailable"), requestId) };
  }
}
export const partnerHttpRead = (operation: PartnerReadOperation, req: PartnerHttpRequest) => partnerHttp(operation, req);
export const partnerHttpQuote = (req: PartnerHttpRequest) => partnerHttp("quotes", req);
export const partnerHttpBook = (req: PartnerHttpRequest) => partnerHttp("book",req);
